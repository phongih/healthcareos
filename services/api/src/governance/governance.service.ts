/**
 * HCOS-F15 | Quản trị dữ liệu: danh mục + cấp độ hệ thống + hồ sơ tự đánh giá (bằng chứng).
 *
 *   Xem (governance:read)      quản lý PK, quản lý kho dược, ban giám đốc, quản trị.
 *   Đánh giá (governance:assess) quản trị hệ thống (đại diện chủ quản dữ liệu): ghi cấp độ xác định + căn cứ.
 *                              Cấp xác định không được thấp hơn cấp tính từ danh mục (cả service lẫn CHECK của CSDL).
 * Danh mục là của hệ thống (mã nguồn); hồ sơ đánh giá là của từng chủ quản (tenant).
 */
import { randomUUID } from 'node:crypto';

import {
  TenantIsolationError,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type NewAuditEvent,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
} from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import {
  CATEGORY_LABEL, DATA_CATALOG, LEVEL_LABEL, RETENTION_LABEL, STEWARD_LABEL, summarize,
  type CatalogSummary, type RiskLevel, type TableLabel,
} from '../../../../packages/security/src/data-catalog';
import { assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, num, PgClinicalRepository } from '../clinical/encounter.service';
import { loadTenantKeys } from '../../../../packages/security/src/pii';
import { plaintextStats } from '../security/pii.service';

type Permission = 'governance:read' | 'governance:assess';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'governance:read': ['clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin'],
  'governance:assess': ['tenant_admin'],
};

/** Quy mô dữ liệu của chủ quản tại thời điểm xem / đánh giá (đếm dưới RLS — chỉ dữ liệu của tenant này). */
const SCALE_TABLES: ReadonlyArray<[string, string]> = [
  ['patient.persons', 'Người bệnh (danh tính)'],
  ['patient.patients', 'Hồ sơ bệnh nhân'],
  ['clinical.encounters', 'Đợt khám'],
  ['clinical.observations', 'Sinh hiệu / kết quả'],
  ['clinical.prescriptions', 'Đơn thuốc'],
  ['clinical.bookings', 'Lịch hẹn online'],
  ['finance.receipts', 'Phiếu thu / chi'],
  ['platform.audit_events', 'Bản ghi kiểm toán'],
];
export interface ScaleRow { readonly table: string; readonly label: string; readonly rows: number }

export interface Assessment {
  readonly assessmentId: string;
  readonly catalogVersion: string;
  readonly computedLevel: RiskLevel;
  readonly declaredLevel: RiskLevel;
  readonly summary: { byLevel: Record<string, number>; tables: number; scale: ScaleRow[]; plaintextSensitive: number };
  readonly rationale: string;
  readonly assessedBy: string;
  readonly assessedByName: string | null;
  readonly assessedAt: string;
}

export interface CatalogView {
  readonly summary: CatalogSummary;
  readonly tables: ReadonlyArray<TableLabel & { readonly name: string }>;
  readonly scale: readonly ScaleRow[];
  readonly latest: Assessment | null;
  /** Danh mục đã đổi kể từ lần đánh giá gần nhất (hoặc chưa đánh giá lần nào) => cần đánh giá lại. */
  readonly needsAssessment: boolean;
  readonly canAssess: boolean;
  /** HCOS-F16: bằng chứng mã hoá — khoá (chỉ siêu dữ liệu) và số giá trị còn bản rõ (phải bằng 0 sau backfill). */
  readonly encryption: {
    readonly keys: ReadonlyArray<{ purpose: string; version: number; kekId: string; status: string; createdAt: string }>;
    readonly plaintextRemaining: ReadonlyArray<{ column: string; rows: number }>;
    readonly snapshotsPlaintext: number;
  };
}

class Repo extends PgClinicalRepository {
  constructor(readonly tdb: TenantScopedDb) {
    super(tdb);
  }
  async scale(): Promise<ScaleRow[]> {
    const out: ScaleRow[] = [];
    for (const [table, label] of SCALE_TABLES) {
      // Tên bảng lấy từ hằng trong mã (không từ người dùng).
      const r = await this.db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [this.t]);
      out.push({ table, label, rows: Number(r.rows[0]!.n) });
    }
    return out;
  }
  async assessments(limit: number): Promise<Assessment[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT a.assessment_id, a.catalog_version, a.computed_level, a.declared_level, a.summary, a.rationale, a.assessed_by, a.assessed_at, u.display_name
         FROM governance.risk_assessments a LEFT JOIN iam.users u ON u.tenant_id = a.tenant_id AND u.user_id = a.assessed_by
        WHERE a.tenant_id = $1 ORDER BY a.assessed_at DESC LIMIT ${limit}`,
      [this.t],
    );
    return r.rows.map((x) => ({
      assessmentId: x['assessment_id'] as string, catalogVersion: x['catalog_version'] as string,
      computedLevel: num(x['computed_level']) as RiskLevel, declaredLevel: num(x['declared_level']) as RiskLevel,
      summary: typeof x['summary'] === 'string' ? JSON.parse(x['summary']) : (x['summary'] as Assessment['summary']),
      rationale: x['rationale'] as string, assessedBy: x['assessed_by'] as string, assessedByName: (x['display_name'] as string | null) ?? null,
      assessedAt: iso(x['assessed_at']),
    }));
  }
  async insert(a: { id: string; version: string; computed: RiskLevel; declared: RiskLevel; summary: unknown; rationale: string; by: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO governance.risk_assessments (assessment_id, tenant_id, catalog_version, computed_level, declared_level, summary, rationale, assessed_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [a.id, this.t, a.version, a.computed, a.declared, JSON.stringify(a.summary), a.rationale, a.by],
    );
  }
}

export class GovernanceService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async catalog(ctx: TenantContext = requireTenantContext()): Promise<CatalogView> {
    return this.run(ctx, 'governance.catalog.read', async (repo) => {
      const { user, grants } = await this.principal(repo, ctx);
      this.decide(grants, user, 'governance:read');
      const summary = summarize();
      const latest = (await repo.assessments(1))[0] ?? null;
      const canAssess = this.allowed(grants, user, 'governance:assess');
      await repo.appendAudit(this.event(ctx, 'governance.catalog.read', 'success', user, { catalogVersion: summary.version }));
      const pt = await plaintextStats(repo.tdb);
      const keys = (await loadTenantKeys(repo.tdb)).map((k) => ({ purpose: k.purpose, version: k.version, kekId: k.kekId, status: k.status, createdAt: k.createdAt }));
      return {
        encryption: { keys, plaintextRemaining: pt.columns, snapshotsPlaintext: pt.snapshots },
        summary,
        tables: Object.entries(DATA_CATALOG).map(([name, t]) => ({ name, ...t })),
        scale: await repo.scale(),
        latest,
        needsAssessment: !latest || latest.catalogVersion !== summary.version,
        canAssess,
      };
    });
  }

  async listAssessments(ctx: TenantContext = requireTenantContext()): Promise<Assessment[]> {
    return this.run(ctx, 'governance.assessment.list', async (repo) => {
      const { user, grants } = await this.principal(repo, ctx);
      this.decide(grants, user, 'governance:read');
      return repo.assessments(100);
    });
  }

  async assess(input: { declaredLevel: unknown; rationale: unknown }, ctx: TenantContext = requireTenantContext()): Promise<Assessment> {
    return this.run(ctx, 'governance.assessment.create', async (repo) => {
      const { user, grants } = await this.principal(repo, ctx);
      this.decide(grants, user, 'governance:assess');
      const summary = summarize();
      const declared = input.declaredLevel;
      if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1 || declared > 5) {
        throw new ClinicalError('VALIDATION', 'declaredLevel must be an integer 1-5');
      }
      if (declared < summary.systemLevel) {
        throw new ClinicalError('VALIDATION', `Cấp độ xác định (${declared}) thấp hơn cấp tính từ danh mục (${summary.systemLevel})`, { reason: 'DECLARED_BELOW_COMPUTED' });
      }
      const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
      if (rationale.length < 20 || rationale.length > 4000) {
        throw new ClinicalError('VALIDATION', 'rationale must be 20-4000 characters', { reason: 'RATIONALE_REQUIRED' });
      }
      const scale = await repo.scale();
      const id = randomUUID();
      await repo.insert({
        id, version: summary.version, computed: summary.systemLevel, declared: declared as RiskLevel, rationale, by: user.userId,
        summary: { byLevel: summary.byLevel, tables: summary.tables, scale, plaintextSensitive: summary.plaintextSensitive.length },
      });
      await repo.appendAudit(this.event(ctx, 'governance.assessment.create', 'success', user, {
        assessmentId: id, catalogVersion: summary.version, computedLevel: summary.systemLevel, declaredLevel: declared,
      }));
      return (await repo.assessments(1))[0]!;
    });
  }

  /** Hồ sơ tự đánh giá dạng Markdown (đính kèm hồ sơ pháp chế / nộp khi được yêu cầu). */
  async dossier(ctx: TenantContext = requireTenantContext()): Promise<string> {
    const v = await this.catalog(ctx);
    return renderDossier(v, this.clock());
  }

  // ---- Nội bộ -------------------------------------------------------------------
  private async principal(repo: Repo, ctx: TenantContext): Promise<{ user: User; grants: readonly AccessGrant[] }> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    // Quản trị dữ liệu ở cấp chủ quản (tenant): mọi membership còn hiệu lực đều tính.
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) => m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return { user, grants: await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>) };
  }
  private allowed(grants: readonly AccessGrant[], user: User, perm: Permission): boolean {
    return decideAccess(grants, perm as PolicyAction, PERMISSIONS[ACCESS_POLICY_CATALOG[perm as PolicyAction].basePermission as Permission], { callerUserId: user.userId }).allowed;
  }
  private decide(grants: readonly AccessGrant[], user: User, perm: Permission): void {
    const d = decideAccess(grants, perm as PolicyAction, PERMISSIONS[ACCESS_POLICY_CATALOG[perm as PolicyAction].basePermission as Permission], { callerUserId: user.userId });
    if (!d.allowed) {
      throw d.reason === 'ROLE' ? new ClinicalError('FORBIDDEN', `Missing permission ${perm}`) : new ClinicalError('FORBIDDEN', `Access policy does not permit ${perm}`, { reason: 'ACCESS_POLICY' });
    }
  }
  private event(ctx: TenantContext, action: string, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject }, organizationId: null, action,
      resourceType: 'DataGovernance', resourceId: null, personId: null, patientId: null, outcome, correlationId: ctx.correlationId as CorrelationId,
      sourceIp: null, userAgent: null, payload,
    };
  }
  private async run<T>(ctx: TenantContext, action: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(this.deps.pool, async (db) => fn(new Repo(db)), ctx);
    } catch (e) {
      const code = e instanceof ClinicalError || e instanceof TenantIsolationError ? e.code : 'INTERNAL';
      const outcome: NewAuditEvent['outcome'] = (e instanceof ClinicalError && e.code === 'FORBIDDEN') || e instanceof TenantIsolationError ? 'denied' : 'failure';
      try {
        await this.deps.audit.record(this.event(ctx, action, outcome, null, { code }));
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Hồ sơ Markdown
// ---------------------------------------------------------------------------
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const vnTime = (d: Date) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' }).format(d);
export function renderDossier(v: CatalogView, at: Date): string {
  const s = v.summary;
  const L: string[] = [];
  L.push('# Hồ sơ tự đánh giá cấp độ rủi ro an ninh dữ liệu — HealthcareOS', '');
  L.push(`- Thời điểm lập: ${vnTime(at)} (giờ Việt Nam)`);
  L.push(`- Phiên bản danh mục dữ liệu: \`${s.version}\``);
  L.push(`- Căn cứ: Luật An ninh dữ liệu (Quốc hội thông qua 20/11/2026, hiệu lực 01/7/2027); Luật Bảo vệ dữ liệu cá nhân (hiệu lực 01/01/2026).`);
  L.push('- Chủ quản dữ liệu: cơ sở khám chữa bệnh sử dụng hệ thống. Nhà cung cấp phần mềm / hạ tầng là bên xử lý, không nhận chuyển giao trách nhiệm.', '');
  L.push('## 1. Cấp độ của hệ thống', '');
  L.push(`**Cấp tính từ danh mục: ${s.systemLevel}** — ${LEVEL_LABEL[s.systemLevel]}.`, '');
  L.push('Nguyên tắc: hệ thống xử lý nhiều cấp độ phải đáp ứng yêu cầu bảo vệ theo cấp độ CAO NHẤT phát sinh. Cấp độ rủi ro không thay thế phân loại dữ liệu cốt lõi / quan trọng theo pháp luật về dữ liệu.', '');
  if (v.latest) {
    L.push(`Lần xác định gần nhất: **cấp ${v.latest.declaredLevel}** (tính được ${v.latest.computedLevel}) — ${v.latest.assessedByName ?? v.latest.assessedBy}, ${vnTime(new Date(v.latest.assessedAt))}.`);
    L.push(`Căn cứ: ${v.latest.rationale}`);
    if (v.needsAssessment) L.push('', '> ⚠ Danh mục đã thay đổi sau lần xác định này — cần đánh giá lại.');
  } else {
    L.push('> ⚠ Chưa có lần xác định cấp độ nào được ghi nhận.');
  }
  L.push('', '## 2. Số bảng theo cấp độ', '', '| Cấp | Số bảng |', '|---|---|');
  for (const lv of [1, 2, 3, 4, 5] as RiskLevel[]) L.push(`| ${lv} | ${s.byLevel[lv]} |`);
  L.push('', '## 3. Quy mô dữ liệu (của chủ quản này)', '', '| Dữ liệu | Số bản ghi |', '|---|---|');
  for (const r of v.scale) L.push(`| ${r.label} (\`${r.table}\`) | ${r.rows.toLocaleString('vi-VN')} |`);
  L.push('', '## 4. Danh mục', '', '| Bảng | Cấp | Nhóm | Người chịu trách nhiệm | Thời hạn lưu | Mục đích |', '|---|---|---|---|---|---|');
  for (const t of [...v.tables].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))) {
    L.push(`| \`${t.name}\` | ${t.level} | ${CATEGORY_LABEL[t.category]} | ${STEWARD_LABEL[t.steward]} | ${cell(RETENTION_LABEL[t.retention])} | ${cell(t.purpose)} |`);
  }
  L.push('', '## 5. Mã hoá theo trường', '');
  L.push('### 5.1 Đã mã hoá (AES-256-GCM, DEK theo chủ quản, bọc bằng KEK nằm ngoài CSDL; tìm kiếm bằng blind index HMAC khoá riêng)', '');
  for (const c of s.encrypted) L.push(`- \`${c}\``);
  const left = v.encryption.plaintextRemaining.reduce((a, c) => a + c.rows, 0) + v.encryption.snapshotsPlaintext;
  L.push('', `Bản rõ cũ còn lại trong CSDL của chủ quản: **${left}** giá trị${left === 0 ? ' (đã mã hoá xong dữ liệu cũ).' : ' — cần chạy scripts/pii-backfill.ts.'}`);
  if (v.encryption.keys.length) {
    L.push('', '| Khoá | Phiên bản | KEK | Trạng thái | Tạo lúc |', '|---|---|---|---|---|');
    for (const k of v.encryption.keys) L.push(`| ${k.purpose === 'data' ? 'Dữ liệu (DEK)' : 'Blind index'} | ${k.version} | ${k.kekId} | ${k.status === 'active' ? 'đang dùng' : 'đã thay'} | ${vnTime(new Date(k.createdAt))} |`);
  }
  L.push('', '### 5.2 Giữ dạng rõ có chủ đích', '');
  for (const c of s.plainByDesign) L.push(`- \`${c.column}\` — ${c.reason}`);
  L.push('', '### 5.3 Chưa mã hoá — kế hoạch F16b (họ tên, ngày sinh, ghi chú / kết quả lâm sàng)', '');
  for (const c of s.plaintextSensitive) L.push(`- \`${c}\``);
  L.push('', '## 6. Biện pháp đang áp dụng', '');
  L.push('- Cách ly dữ liệu theo chủ quản bằng Row-Level Security bắt buộc (FORCE) ở CSDL; ứng dụng không chạy bằng superuser.');
  L.push('- Phân quyền theo vai trò + cơ sở; access policy chỉ thu hẹp quyền, che trường nhạy cảm.');
  L.push('- Nhật ký kiểm toán chỉ-thêm, nối chuỗi băm; ghi cả thao tác bị từ chối.');
  L.push('- Dữ liệu lâm sàng không sửa / xoá trực tiếp; mọi thay đổi lưu lịch sử.');
  L.push('- SĐT, email, số giấy tờ mã hoá theo trường; người đọc được CSDL / bản sao lưu không giải mã được (KEK ngoài CSDL). Xem bản rõ cần quyền riêng `pii:reveal` + lý do, mỗi lần đều ghi kiểm toán.');
  L.push('- Không gửi dữ liệu bệnh nhân tới dịch vụ AI đám mây; kết nối ngoài (Teams, webhook) không mang dữ liệu bệnh nhân; URL / khoá kết nối mã hoá AES-256-GCM.');
  L.push('- Sao lưu hằng đêm có kiểm tra khôi phục (gồm chuỗi băm kiểm toán).');
  L.push('', '---', 'Hồ sơ sinh tự động từ danh mục trong mã nguồn; CI chặn mọi thay đổi CSDL chưa được gắn nhãn.');
  return L.join('\n') + '\n';
}
