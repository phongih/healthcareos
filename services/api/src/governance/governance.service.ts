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
import { ACTION_LABEL, RETENTION_RULES } from '../../../../packages/security/src/retention';
import { AI_REGISTRY, VALIDATION_LABEL, type AiComponent } from '../../../../packages/security/src/ai-registry';

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
  /** HCOS-F18: sổ nguồn dữ liệu AI + bên thứ ba + xuất dữ liệu (số liệu, không có dữ liệu cá nhân). */
  readonly ai: readonly AiComponent[];
  readonly thirdParty: {
    readonly vendors: ReadonlyArray<{ name: string; kind: string; role: string; status: string; cleared: boolean; validUntil: string | null; categories: string[]; crossBorder: boolean | null; endpoints: number }>;
    readonly endpointsWithoutClearedVendor: number;
    readonly exports30d: number;
    readonly personalExports30d: number;
  };
  /** HCOS-F17: chính sách lưu giữ có hiệu lực + số liệu xoá (không có dữ liệu cá nhân). */
  readonly retention: {
    readonly rules: ReadonlyArray<{ id: string; label: string; action: string; days: number; floorDays: number; from: string; legalBasis: string }>;
    readonly receipts: number;
    readonly keysShredded: number;
    readonly openRequests: number;
    readonly ledgerPending: number;
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
      const rs: Array<CatalogView['retention']['rules'][number]> = [];
      for (const r of RETENTION_RULES) {
        const d = await repo.tdb.query<{ d: string | number }>('SELECT governance.retention_days($1) AS d', [r.id]);
        rs.push({ id: r.id, label: r.label, action: ACTION_LABEL[r.action], days: num(d.rows[0]!.d), floorDays: r.floorDays, from: r.from, legalBasis: r.legalBasis });
      }
      const st = await repo.tdb.query<Record<string, string | number>>(
        `SELECT (SELECT count(*) FROM governance.deletion_receipts WHERE tenant_id = $1) AS receipts,
                (SELECT count(*) FROM keyvault.subject_keys WHERE tenant_id = $1 AND status = 'shredded') AS shredded,
                (SELECT count(*) FROM governance.erasure_requests WHERE tenant_id = $1 AND status IN ('pending', 'deferred')) AS open,
                (SELECT count(*) FROM keyvault.shred_events WHERE tenant_id = $1 AND exported_at IS NULL) AS pending`,
        [repo.tdb.tenantId],
      );
      const x = st.rows[0]!;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const vr = await repo.tdb.query<any>(
        `SELECT v.name, v.kind, v.role, v.status, governance.vendor_cleared(v.vendor_id, 'operational') AS cleared, a.valid_until::text AS valid_until,
                to_jsonb(a.data_categories) AS categories, a.cross_border,
                (SELECT count(*) FROM integration.endpoints e WHERE e.tenant_id = v.tenant_id AND e.vendor_id = v.vendor_id AND e.status <> 'retired') AS endpoints
           FROM governance.vendors v
           LEFT JOIN LATERAL (SELECT * FROM governance.vendor_assessments x WHERE x.tenant_id = v.tenant_id AND x.vendor_id = v.vendor_id ORDER BY x.assessed_at DESC LIMIT 1) a ON true
          WHERE v.tenant_id = $1 ORDER BY lower(v.name)`,
        [repo.tdb.tenantId],
      );
      const tp = await repo.tdb.query<any>(
        `SELECT (SELECT count(*) FROM integration.endpoints e WHERE e.tenant_id = $1 AND e.status <> 'retired'
                   AND NOT (e.vendor_id IS NOT NULL AND governance.vendor_cleared(e.vendor_id, 'operational'))) AS bad,
                (SELECT count(*) FROM governance.data_exports WHERE tenant_id = $1 AND exported_at > now() - interval '30 days') AS ex,
                (SELECT count(*) FROM governance.data_exports WHERE tenant_id = $1 AND exported_at > now() - interval '30 days' AND contains_personal) AS pex`,
        [repo.tdb.tenantId],
      );
      const thirdParty = {
        vendors: vr.rows.map((x: any) => ({
          name: x.name, kind: x.kind, role: x.role, status: x.status, cleared: x.cleared === true || x.cleared === 't', validUntil: x.valid_until ?? null,
          categories: (typeof x.categories === 'string' ? JSON.parse(x.categories) : x.categories) ?? [], crossBorder: x.cross_border === null || x.cross_border === undefined ? null : x.cross_border === true || x.cross_border === 't',
          endpoints: num(x.endpoints),
        })),
        endpointsWithoutClearedVendor: num(tp.rows[0].bad), exports30d: num(tp.rows[0].ex), personalExports30d: num(tp.rows[0].pex),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return {
        ai: AI_REGISTRY,
        thirdParty,
        retention: { rules: rs, receipts: num(x['receipts']), keysShredded: num(x['shredded']), openRequests: num(x['open']), ledgerPending: num(x['pending']) },
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
  L.push('', '## 6. Lưu giữ & xoá dữ liệu', '');
  L.push('| Dữ liệu | Hành động | Thời hạn | Sàn pháp lý | Tính từ | Căn cứ |', '|---|---|---|---|---|---|');
  for (const r of v.retention.rules) L.push(`| ${cell(r.label)} | ${r.action} | ${r.days} ngày | ${r.floorDays} ngày | ${cell(r.from)} | ${cell(r.legalBasis)} |`);
  L.push('', `- Biên nhận xoá đã lập: **${v.retention.receipts}**; khoá theo người đã huỷ: **${v.retention.keysShredded}**; yêu cầu xoá đang mở: **${v.retention.openRequests}**.`);
  L.push(`- Sự kiện huỷ khoá chưa đẩy ra sổ huỷ ngoài bản sao lưu: **${v.retention.ledgerPending}**${v.retention.ledgerPending === 0 ? '.' : ' — kiểm tra cron shred-ledger.'}`);
  L.push('- Xoá theo yêu cầu: người lập khác người duyệt (CSDL chặn); còn nghĩa vụ lưu giữ thì xoá phần không bị ràng buộc + hạn chế xử lý, tự xoá nốt khi hết hạn.');
  L.push('- Bản sao lưu: dữ liệu đã xoá không mở được ngay trên hệ thống (khoá huỷ); bản sao lưu cũ hết hạn theo vòng đời bucket; khôi phục bắt buộc phát lại sổ huỷ.');
  L.push('', '## 7. Bên thứ ba (nhà cung cấp nhận / xử lý dữ liệu)', '');
  if (v.thirdParty.vendors.length === 0) L.push('Chưa đăng ký nhà cung cấp nào.');
  else {
    L.push('| Nhà cung cấp | Loại | Vai trò | Trạng thái | Được gửi dữ liệu vận hành | Loại dữ liệu được nhận | Ra nước ngoài | Hiệu lực đến | Kết nối |', '|---|---|---|---|---|---|---|---|---|');
    for (const x of v.thirdParty.vendors) {
      L.push(`| ${cell(x.name)} | ${x.kind} | ${x.role} | ${x.status} | ${x.cleared ? 'có' : '**không**'} | ${x.categories.join(', ') || '—'} | ${x.crossBorder === null ? '—' : x.crossBorder ? 'có' : 'không'} | ${x.validUntil ?? '—'} | ${x.endpoints} |`);
    }
  }
  L.push('', `- Kết nối ngoài chưa có nhà cung cấp được duyệt (đang bị chặn gửi): **${v.thirdParty.endpointsWithoutClearedVendor}**.`);
  L.push('- Kết nối ngoài chỉ gửi khi nhà cung cấp đang hoạt động và có đánh giá còn hiệu lực (tối đa 3 năm) cho loại dữ liệu; kiểm tra lúc xếp hàng và lúc gửi. Dịch vụ AI không bao giờ được nhận dữ liệu cá nhân / sức khoẻ.');
  L.push(`- Xuất dữ liệu 30 ngày qua: **${v.thirdParty.exports30d}** file (có dữ liệu cá nhân: ${v.thirdParty.personalExports30d}); mọi file do máy chủ tạo, có mục đích, dấu người xuất và SHA-256 trong nhật ký.`);
  L.push('', '## 8. Nguồn dữ liệu AI', '');
  L.push('| Thành phần | Loại | Phiên bản | SHA-256 | Kiểm định | Chạy tại | Mục đích được phép |', '|---|---|---|---|---|---|---|');
  for (const c of v.ai) L.push(`| ${cell(c.name)} | ${c.kind} | ${c.version} | \`${c.sha256.slice(0, 12)}…\` | ${VALIDATION_LABEL[c.validation]} | ${c.runsAt === 'browser' ? 'trình duyệt' : 'máy chủ'} | ${cell(c.permittedUse)} |`);
  L.push('', '- Mọi thành phần chạy cục bộ, không gửi dữ liệu người bệnh ra ngoài (trình duyệt chỉ kết nối tới máy chủ — CSP `connect-src \'self\'`; CI kiểm tra không có đường ra ngoài khác).');
  L.push('- Khoá phiên bản: CI so SHA-256 của từng thành phần với sổ; thay đổi dữ liệu / luật AI phải cập nhật sổ trong cùng PR.');
  L.push('', '## 9. Biện pháp đang áp dụng', '');
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
