/**
 * HCOS-F17 | Lưu giữ & xoá dữ liệu.
 *
 *   Xem (retention:read)         quản lý PK, ban giám đốc, quản trị: chính sách, biên nhận, yêu cầu xoá.
 *   Quản lý (retention:manage)   quản trị hệ thống: đổi thời hạn (không thấp hơn sàn pháp lý), chạy job ngay.
 *   Lập yêu cầu (erasure:request) lễ tân / quản lý PK tại cơ sở của hồ sơ: ghi nhận đề nghị xoá của người bệnh — CHƯA xoá gì.
 *   Duyệt (erasure:approve)      quản trị hệ thống, KHÁC người lập (service + CHECK của CSDL). Duyệt = thực thi ngay:
 *                                còn hạn giữ (hồ sơ bệnh án / chứng từ) => xoá phần không bị ràng buộc + hạn chế xử lý + hoãn phần còn lại;
 *                                hết ràng buộc => xoá toàn bộ (huỷ khoá chủ thể, xoá trường định danh, xoá ảnh chụp gộp hồ sơ).
 *
 * Mọi thao tác xoá chạy trong hàm SECURITY DEFINER của CSDL (governance.*). Mỗi lần xoá có MỘT biên nhận (governance.deletion_receipts):
 * chính sách + phiên bản, căn cứ, tiêu chí, phạm vi (số đếm), số khoá đã huỷ, thời điểm, kết quả và ngày "không thể khôi phục"
 * = lúc xoá + thời hạn giữ bản sao lưu dài nhất. Biên nhận và audit KHÔNG chứa giá trị đã xoá.
 */
import { randomUUID } from 'node:crypto';

import {
  TenantIsolationError,
  isUuid,
  asTenantId,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
} from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import { RETENTION_RULES, retentionPolicyVersion, ruleById, type RetentionRuleId } from '../../../../packages/security/src/retention';
import { assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, isoOrNull, num, PgClinicalRepository } from '../clinical/encounter.service';

type Permission = 'retention:read' | 'retention:manage' | 'erasure:request' | 'erasure:approve';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'retention:read': ['clinic_admin', 'executive', 'tenant_admin'],
  'retention:manage': ['tenant_admin'],
  'erasure:request': ['clinic_staff', 'clinic_admin'],
  'erasure:approve': ['tenant_admin'],
};

export const ERASURE_CHANNELS = ['counter', 'written', 'email', 'phone'] as const;
/** Kênh nhân viên chọn được + 'portal' (F20: người bệnh tự gửi qua cổng, không có người lập là nhân viên). */
export type ErasureChannel = (typeof ERASURE_CHANNELS)[number] | 'portal';

export interface RuleView {
  readonly id: RetentionRuleId;
  readonly label: string;
  readonly action: string;
  readonly tables: readonly string[];
  readonly from: string;
  readonly floorDays: number;
  readonly defaultDays: number;
  readonly days: number;
  readonly legalBasis: string;
  /** Số bản ghi đến hạn nếu chạy ngay (chỉ với ẩn danh / xoá). */
  readonly due: number | null;
}
export interface Receipt {
  readonly receiptId: string;
  readonly kind: 'retention' | 'erasure';
  readonly ruleId: string | null;
  readonly requestId: string | null;
  readonly policyVersion: string;
  readonly legalBasis: string;
  readonly criteria: Record<string, unknown>;
  readonly scope: Record<string, number>;
  readonly keysShredded: number;
  readonly outcome: 'completed' | 'partial';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly backupHorizonDays: number;
  readonly irreversibleAfter: string;
  readonly executedBy: string | null;
  readonly approvedBy: string | null;
  /** Số sự kiện huỷ khoá của biên nhận đã / chưa được đẩy ra ngoài bản sao lưu (sổ huỷ). */
  readonly ledger: { readonly events: number; readonly exported: number };
}
export interface ErasureRequest {
  readonly requestId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly mrn: string | null;
  readonly personId: string;
  readonly channel: ErasureChannel;
  readonly note: string | null;
  readonly receivedAt: string;
  /** null = người bệnh / người giám hộ tự lập qua cổng (F20). */
  readonly requestedBy: string | null;
  readonly requestedByName: string | null;
  readonly requestedAt: string;
  readonly assessment: Assessment;
  readonly status: 'pending' | 'rejected' | 'completed' | 'deferred';
  readonly decidedBy: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly deferredUntil: string | null;
  readonly receiptId: string | null;
  readonly finalReceiptId: string | null;
}
export interface Assessment {
  readonly medicalRecordUntil: string | null;
  readonly medicalRecordCount: number;
  readonly financialRecordUntil: string | null;
  readonly financialRecordCount: number;
  readonly persons: number;
  readonly identifiers: number;
  readonly bookings: number;
  /** Hạn giữ muộn nhất (null = không bị ràng buộc => có thể xoá toàn bộ). */
  readonly holdUntil: string | null;
}
export interface Overview {
  readonly rules: readonly RuleView[];
  readonly policyVersion: string;
  readonly backupHorizonDays: number;
  readonly lastRun: { readonly startedAt: string; readonly trigger: string; readonly status: string; readonly detail: Record<string, unknown> } | null;
  readonly ledgerPending: number;
  readonly subjectKeys: { readonly active: number; readonly shredded: number };
  readonly receipts: readonly Receipt[];
  readonly requests: readonly ErasureRequest[];
  readonly canManage: boolean;
  readonly canApprove: boolean;
}
export interface RunResult {
  readonly runId: string;
  readonly receipts: number;
  readonly detail: Record<string, number>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapAssessment = (a: any, now: Date): Assessment => {
  const med = a?.medical_record ? new Date(a.medical_record).toISOString() : null;
  const fin = a?.financial_record ? new Date(a.financial_record).toISOString() : null;
  const latest = [med, fin].filter((x): x is string => x !== null && Date.parse(x) > now.getTime()).sort().pop() ?? null;
  return {
    medicalRecordUntil: med, medicalRecordCount: num(a?.medical_record_count ?? 0), financialRecordUntil: fin, financialRecordCount: num(a?.financial_record_count ?? 0),
    persons: num(a?.persons ?? 0), identifiers: num(a?.identifiers ?? 0), bookings: num(a?.bookings ?? 0), holdUntil: latest,
  };
};
const jsonOf = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const mapReceipt = (r: any): Receipt => ({
  receiptId: r.receipt_id, kind: r.kind, ruleId: r.rule_id ?? null, requestId: r.request_id ?? null, policyVersion: r.policy_version, legalBasis: r.legal_basis,
  criteria: jsonOf(r.criteria), scope: jsonOf(r.scope), keysShredded: num(r.keys_shredded), outcome: r.outcome, startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at), backupHorizonDays: num(r.backup_horizon_days), irreversibleAfter: iso(r.irreversible_after),
  executedBy: r.executed_by ?? null, approvedBy: r.approved_by ?? null, ledger: { events: num(r.ledger_events ?? 0), exported: num(r.ledger_exported ?? 0) },
});
const REQ_COLS = `r.request_id, r.organization_id, r.patient_id, pt.mrn, r.person_id, r.channel, r.note, r.received_at, r.requested_by, ru.display_name AS requested_by_name,
  r.requested_at, r.assessment, r.status, r.decided_by, du.display_name AS decided_by_name, r.decided_at, r.decision_note, r.deferred_until, r.receipt_id, r.final_receipt_id`;
const REQ_FROM = `governance.erasure_requests r
  LEFT JOIN patient.patients pt ON pt.tenant_id = r.tenant_id AND pt.patient_id = r.patient_id
  LEFT JOIN iam.users ru ON ru.tenant_id = r.tenant_id AND ru.user_id = r.requested_by
  LEFT JOIN iam.users du ON du.tenant_id = r.tenant_id AND du.user_id = r.decided_by`;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
class Repo extends PgClinicalRepository {
  constructor(readonly tdb: TenantScopedDb) {
    super(tdb);
  }
  private get tid(): string {
    return this.tdb.tenantId;
  }
  async effectiveDays(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of RETENTION_RULES) {
      const x = await this.tdb.query<{ d: string | number }>('SELECT governance.retention_days($1) AS d', [r.id]);
      out[r.id] = num(x.rows[0]!.d);
    }
    return out;
  }
  async due(days: Record<string, number>): Promise<Record<string, number>> {
    const q = async (sql: string, p: unknown[]) => num((await this.tdb.query<{ n: string | number }>(sql, p)).rows[0]!.n);
    return {
      booking_contact: await q(
        `SELECT count(*) AS n FROM clinical.bookings WHERE tenant_id = $1 AND erased_at IS NULL
            AND visit_date < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - $2::int`, [this.tid, days['booking_contact']]),
      idempotency: await q(`SELECT count(*) AS n FROM platform.idempotency_keys WHERE tenant_id = $1 AND created_at < now() - make_interval(days => $2::int)`, [this.tid, days['idempotency']]),
      outbox: await q(`SELECT count(*) AS n FROM platform.outbox_events WHERE tenant_id = $1 AND created_at < now() - make_interval(days => $2::int)`, [this.tid, days['outbox']]),
    };
  }
  async setDays(rule: string, days: number, user: string): Promise<void> {
    await this.tdb.query(
      `INSERT INTO governance.retention_settings (tenant_id, rule_id, days, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, rule_id) DO UPDATE SET days = EXCLUDED.days, updated_by = EXCLUDED.updated_by, updated_at = now(),
         version = governance.retention_settings.version + 1`,
      [this.tid, rule, days, user],
    );
  }
  async receipts(limit: number, where = 'TRUE', params: unknown[] = []): Promise<Receipt[]> {
    const r = await this.tdb.query(
      `SELECT d.*, (SELECT count(*) FROM keyvault.shred_events e WHERE e.tenant_id = d.tenant_id AND e.receipt_id = d.receipt_id) AS ledger_events,
              (SELECT count(*) FROM keyvault.shred_events e WHERE e.tenant_id = d.tenant_id AND e.receipt_id = d.receipt_id AND e.exported_at IS NOT NULL) AS ledger_exported
         FROM governance.deletion_receipts d WHERE d.tenant_id = $1 AND ${where} ORDER BY d.finished_at DESC LIMIT ${limit}`,
      [this.tid, ...params],
    );
    return r.rows.map(mapReceipt);
  }
  async insertReceipt(x: {
    id: string; kind: 'retention' | 'erasure'; rule: string | null; request: string | null; policy: string; basis: string; criteria: unknown; scope: unknown;
    keys: number; outcome: 'completed' | 'partial'; started: Date; horizon: number; by: string | null; approvedBy: string | null;
  }): Promise<void> {
    await this.tdb.query(
      `INSERT INTO governance.deletion_receipts (receipt_id, tenant_id, kind, rule_id, request_id, policy_version, legal_basis, criteria, scope, keys_shredded,
         outcome, started_at, finished_at, backup_horizon_days, irreversible_after, executed_by, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, now(), $13, now() + make_interval(days => $13::int), $14, $15)`,
      [x.id, this.tid, x.kind, x.rule, x.request, x.policy, x.basis, JSON.stringify(x.criteria), JSON.stringify(x.scope), x.keys, x.outcome,
       x.started.toISOString(), x.horizon, x.by, x.approvedBy],
    );
  }
  async lastRun(): Promise<Overview['lastRun']> {
    const r = await this.tdb.query<any>(`SELECT started_at, trigger, status, detail FROM governance.retention_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`, [this.tid]);
    const x = r.rows[0];
    return x ? { startedAt: iso(x.started_at), trigger: x.trigger, status: x.status, detail: jsonOf(x.detail) } : null;
  }
  async insertRun(x: { id: string; trigger: 'schedule' | 'manual'; by: string | null; started: Date; status: 'succeeded' | 'failed'; detail: unknown; error?: string }): Promise<void> {
    await this.tdb.query(
      `INSERT INTO governance.retention_runs (run_id, tenant_id, trigger, triggered_by, started_at, finished_at, status, detail, error_code)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, $8)`,
      [x.id, this.tid, x.trigger, x.by, x.started.toISOString(), x.status, JSON.stringify(x.detail), x.error ?? null],
    );
  }
  async ledgerAndKeys(): Promise<{ pending: number; active: number; shredded: number }> {
    const r = await this.tdb.query<any>(
      `SELECT (SELECT count(*) FROM keyvault.shred_events WHERE tenant_id = $1 AND exported_at IS NULL) AS pending,
              (SELECT count(*) FROM keyvault.subject_keys WHERE tenant_id = $1 AND status = 'active') AS active,
              (SELECT count(*) FROM keyvault.subject_keys WHERE tenant_id = $1 AND status = 'shredded') AS shredded`,
      [this.tid],
    );
    return { pending: num(r.rows[0].pending), active: num(r.rows[0].active), shredded: num(r.rows[0].shredded) };
  }
  async requests(where: string, params: unknown[], limit = 50): Promise<ErasureRequest[]> {
    const r = await this.tdb.query<any>(`SELECT ${REQ_COLS} FROM ${REQ_FROM} WHERE r.tenant_id = $1 AND ${where} ORDER BY r.requested_at DESC LIMIT ${limit}`, [this.tid, ...params]);
    const now = new Date();
    return r.rows.map((x: any) => ({
      requestId: x.request_id, organizationId: x.organization_id, patientId: x.patient_id, mrn: x.mrn ?? null, personId: x.person_id, channel: x.channel,
      note: x.note ?? null, receivedAt: iso(x.received_at), requestedBy: x.requested_by, requestedByName: x.requested_by_name ?? null, requestedAt: iso(x.requested_at),
      assessment: mapAssessment(jsonOf(x.assessment), now), status: x.status, decidedBy: x.decided_by ?? null, decidedByName: x.decided_by_name ?? null,
      decidedAt: isoOrNull(x.decided_at), decisionNote: x.decision_note ?? null, deferredUntil: isoOrNull(x.deferred_until), receiptId: x.receipt_id ?? null,
      finalReceiptId: x.final_receipt_id ?? null,
    }));
  }
  async patientOrg(patientId: string): Promise<{ org: OrganizationId; personId: string; erased: boolean } | null> {
    const r = await this.tdb.query<any>(
      `SELECT pt.organization_id, pt.person_id, (p.status = 'erased') AS erased FROM patient.patients pt
         JOIN patient.persons p ON p.tenant_id = pt.tenant_id AND p.person_id = pt.person_id
        WHERE pt.tenant_id = $1 AND pt.patient_id = $2`,
      [this.tid, patientId],
    );
    const x = r.rows[0];
    return x ? { org: x.organization_id, personId: x.person_id, erased: x.erased === true || x.erased === 't' } : null;
  }
  async rawAssessment(personId: string): Promise<unknown> {
    const r = await this.tdb.query<{ a: unknown }>('SELECT governance.erasure_assessment($1) AS a', [personId]);
    return jsonOf(r.rows[0]!.a);
  }
  async fn<T = unknown>(sql: string, params: unknown[]): Promise<T> {
    const r = await this.tdb.query<{ v: unknown }>(sql, params);
    return jsonOf(r.rows[0]!.v) as T;
  }
}

// ---------------------------------------------------------------------------
export class RetentionService {
  private readonly clock: () => Date;
  private readonly horizon: number;
  constructor(private readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date; backupHorizonDays?: number }) {
    this.clock = deps.clock ?? (() => new Date());
    this.horizon = deps.backupHorizonDays ?? 90;
  }

  async overview(ctx: TenantContext = requireTenantContext()): Promise<Overview> {
    return this.run(ctx, 'retention.read', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'retention:read');
      const days = await repo.effectiveDays();
      const due = await repo.due(days);
      const lk = await repo.ledgerAndKeys();
      return {
        rules: RETENTION_RULES.map((r) => ({
          id: r.id, label: r.label, action: r.action, tables: r.tables, from: r.from, floorDays: r.floorDays, defaultDays: r.defaultDays,
          days: days[r.id]!, legalBasis: r.legalBasis, due: due[r.id] ?? null,
        })),
        policyVersion: retentionPolicyVersion(days),
        backupHorizonDays: this.horizon,
        lastRun: await repo.lastRun(),
        ledgerPending: lk.pending,
        subjectKeys: { active: lk.active, shredded: lk.shredded },
        receipts: await repo.receipts(30),
        requests: await repo.requests('TRUE', [], 50),
        canManage: this.allowed(p.grants, p.user, 'retention:manage'),
        canApprove: this.allowed(p.grants, p.user, 'erasure:approve'),
      };
    });
  }

  async setDays(input: { ruleId: unknown; days: unknown }, ctx: TenantContext = requireTenantContext()): Promise<RuleView> {
    const rule = typeof input.ruleId === 'string' ? ruleById(input.ruleId) : undefined;
    if (!rule) throw new ClinicalError('VALIDATION', 'Unknown retention rule');
    const days = input.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days > 36500) throw new ClinicalError('VALIDATION', 'days must be an integer ≤ 36500');
    if (days < rule.floorDays) throw new ClinicalError('VALIDATION', `days must be at least ${rule.floorDays}`, { reason: 'RETENTION_BELOW_FLOOR' });
    return this.run(ctx, 'retention.settings.update', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'retention:manage');
      const before = (await repo.effectiveDays())[rule.id];
      await repo.setDays(rule.id, days, p.user.userId);
      await repo.appendAudit(this.event(ctx, 'retention.settings.update', 'success', p.user, { ruleId: rule.id, from: before, to: days }));
      const eff = await repo.effectiveDays();
      return { id: rule.id, label: rule.label, action: rule.action, tables: rule.tables, from: rule.from, floorDays: rule.floorDays, defaultDays: rule.defaultDays,
        days: eff[rule.id]!, legalBasis: rule.legalBasis, due: (await repo.due(eff))[rule.id] ?? null };
    });
  }

  /** Chạy ngay (quản trị) — cùng logic với job định kỳ. */
  async runNow(ctx: TenantContext = requireTenantContext()): Promise<RunResult> {
    return this.run(ctx, 'retention.run', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'retention:manage');
      const r = await this.execute(repo, 'manual', p.user.userId);
      await repo.appendAudit(this.event(ctx, 'retention.run', 'success', p.user, { runId: r.runId, receipts: r.receipts, ...r.detail }));
      return r;
    });
  }

  /** Job định kỳ cho một tenant (không có người dùng). */
  async runScheduled(tenantId: string): Promise<RunResult> {
    const ctx: TenantContext = Object.freeze({
      tenantId: asTenantId(tenantId), userSubject: 'service:retention', userId: null, personId: null, activeOrganizationId: null,
      allowedOrganizationIds: Object.freeze([]), roles: Object.freeze([]), tokenId: null, correlationId: randomUUID() as CorrelationId,
    });
    return this.run(ctx, 'retention.run', async (repo) => {
      const r = await this.execute(repo, 'schedule', null);
      if (r.receipts > 0) {
        await repo.appendAudit({ ...this.event(ctx, 'retention.run', 'success', null, { runId: r.runId, receipts: r.receipts, ...r.detail }), actor: { type: 'service', id: 'retention' } });
      }
      return r;
    });
  }

  // ---- Yêu cầu xoá -------------------------------------------------------------
  async assess(patientId: unknown, ctx: TenantContext = requireTenantContext()): Promise<Assessment & { erased: boolean }> {
    const id = this.uuid(patientId, 'patientId');
    return this.run(ctx, 'erasure.assess', async (repo) => {
      const p = await this.principal(repo, ctx);
      const pt = await repo.patientOrg(id);
      if (!pt) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      await this.decideAt(p, pt.org, 'erasure:request', ['retention:read']);
      return { ...mapAssessment(await repo.rawAssessment(pt.personId), this.clock()), erased: pt.erased };
    });
  }

  async listForPatient(patientId: unknown, ctx: TenantContext = requireTenantContext()): Promise<ErasureRequest[]> {
    const id = this.uuid(patientId, 'patientId');
    return this.run(ctx, 'erasure.list', async (repo) => {
      const p = await this.principal(repo, ctx);
      const pt = await repo.patientOrg(id);
      if (!pt) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      await this.decideAt(p, pt.org, 'erasure:request', ['retention:read']);
      return repo.requests('r.person_id = $2', [pt.personId], 20);
    });
  }

  async createRequest(
    input: { patientId: unknown; channel: unknown; note?: unknown; receivedAt?: unknown },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<ErasureRequest> {
    const patientId = this.uuid(input.patientId, 'patientId');
    if (typeof input.channel !== 'string' || !(ERASURE_CHANNELS as readonly string[]).includes(input.channel)) {
      throw new ClinicalError('VALIDATION', `channel must be one of ${ERASURE_CHANNELS.join(', ')}`);
    }
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
    if (note !== null && note.length > 500) throw new ClinicalError('VALIDATION', 'note must be at most 500 characters');
    let received = this.clock();
    if (input.receivedAt !== undefined && input.receivedAt !== null) {
      if (typeof input.receivedAt !== 'string' || Number.isNaN(Date.parse(input.receivedAt))) throw new ClinicalError('VALIDATION', 'receivedAt must be an ISO date');
      received = new Date(input.receivedAt);
      if (received.getTime() > this.clock().getTime() + 60_000) throw new ClinicalError('VALIDATION', 'receivedAt cannot be in the future');
    }
    return this.run(ctx, 'erasure.request', async (repo) => {
      const p = await this.principal(repo, ctx);
      const pt = await repo.patientOrg(patientId);
      if (!pt) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      await this.decideAt(p, pt.org, 'erasure:request');
      if (pt.erased) throw new ClinicalError('CONFLICT', 'Patient data has already been erased', { reason: 'ALREADY_ERASED' });
      const assessment = await repo.rawAssessment(pt.personId);
      const id = randomUUID();
      try {
        await repo.tdb.query(
          `INSERT INTO governance.erasure_requests (request_id, tenant_id, organization_id, patient_id, person_id, channel, note, received_at, requested_by, assessment)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [id, ctx.tenantId, pt.org, patientId, pt.personId, input.channel, note, received.toISOString(), p.user.userId, JSON.stringify(assessment)],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ClinicalError('CONFLICT', 'An erasure request is already open for this person', { reason: 'ERASURE_ALREADY_OPEN' });
        throw e;
      }
      await repo.appendAudit({ ...this.event(ctx, 'erasure.request', 'success', p.user, { requestId: id, channel: input.channel }, 'ErasureRequest', id), organizationId: pt.org, patientId: patientId as never });
      return (await repo.requests('r.request_id = $2', [id], 1))[0]!;
    });
  }

  /**
   * HCOS-F20: người bệnh (hoặc người giám hộ) tự lập yêu cầu xoá qua cổng. Không có nhân viên lập => một quản trị viên bất kỳ duyệt.
   * Quyền do PortalService kiểm (person thuộc phiên); ctx là ngữ cảnh dịch vụ của cổng.
   */
  async requestFromPortal(input: { patientId: string; submittedByPersonId: string; note: string | null }, ctx: TenantContext): Promise<{ requestId: string }> {
    return this.run(ctx, 'erasure.request.portal', async (repo) => {
      const pt = await repo.patientOrg(input.patientId);
      if (!pt) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      if (pt.erased) throw new ClinicalError('CONFLICT', 'Patient data has already been erased', { reason: 'ALREADY_ERASED' });
      const assessment = await repo.rawAssessment(pt.personId);
      const id = randomUUID();
      try {
        await repo.tdb.query(
          `INSERT INTO governance.erasure_requests (request_id, tenant_id, organization_id, patient_id, person_id, channel, note, received_at, requested_by, portal_person_id, assessment)
           VALUES ($1, $2, $3, $4, $5, 'portal', $6, now(), NULL, $7, $8::jsonb)`,
          [id, ctx.tenantId, pt.org, input.patientId, pt.personId, input.note, input.submittedByPersonId, JSON.stringify(assessment)],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ClinicalError('CONFLICT', 'An erasure request is already open for this person', { reason: 'ERASURE_ALREADY_OPEN' });
        throw e;
      }
      await repo.appendAudit({
        ...this.event(ctx, 'erasure.request', 'success', null, { requestId: id, channel: 'portal', submittedByPersonId: input.submittedByPersonId }, 'ErasureRequest', id),
        actor: { type: 'service', id: 'patient-portal' }, organizationId: pt.org, patientId: input.patientId as never, personId: input.submittedByPersonId as never,
      });
      return { requestId: id };
    });
  }

  async decide(requestId: unknown, input: { decision: unknown; note?: unknown }, ctx: TenantContext = requireTenantContext()): Promise<{ request: ErasureRequest; receipt: Receipt | null }> {
    const id = this.uuid(requestId, 'requestId');
    if (input.decision !== 'approve' && input.decision !== 'reject') throw new ClinicalError('VALIDATION', "decision must be 'approve' or 'reject'");
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
    if (input.decision === 'reject' && (note === null || note.length < 5)) throw new ClinicalError('VALIDATION', 'A rejection needs a reason (5–500 characters)', { reason: 'REASON_REQUIRED' });
    if (note !== null && note.length > 500) throw new ClinicalError('VALIDATION', 'note must be at most 500 characters');
    return this.run(ctx, `erasure.${input.decision}`, async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'erasure:approve');
      const req = (await repo.requests('r.request_id = $2', [id], 1))[0];
      if (!req) throw new ClinicalError('NOT_FOUND', 'Erasure request not found');
      if (req.status !== 'pending') throw new ClinicalError('INVALID_STATE', `Request is ${req.status}`, { reason: 'ERASURE_NOT_PENDING' });
      if (req.requestedBy === p.user.userId) throw new ClinicalError('FORBIDDEN', 'The requester cannot decide their own request', { reason: 'FOUR_EYES' });
      if (input.decision === 'reject') {
        await repo.tdb.query(
          `UPDATE governance.erasure_requests SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4 WHERE tenant_id = $1 AND request_id = $2`,
          [ctx.tenantId, id, p.user.userId, note],
        );
        await repo.appendAudit({ ...this.event(ctx, 'erasure.reject', 'success', p.user, { requestId: id }, 'ErasureRequest', id), organizationId: req.organizationId as OrganizationId });
        return { request: (await repo.requests('r.request_id = $2', [id], 1))[0]!, receipt: null };
      }
      await repo.tdb.query(
        `UPDATE governance.erasure_requests SET decided_by = $3, decided_at = now(), decision_note = $4 WHERE tenant_id = $1 AND request_id = $2`,
        [ctx.tenantId, id, p.user.userId, note],
      );
      const receipt = await this.executeRequest(repo, id, p.user.userId, req.requestedBy, 'receipt_id');
      await repo.appendAudit({
        ...this.event(ctx, 'erasure.approve', 'success', p.user, { requestId: id, receiptId: receipt.receiptId, outcome: receipt.outcome, keysShredded: receipt.keysShredded }, 'ErasureRequest', id),
        organizationId: req.organizationId as OrganizationId,
      });
      return { request: (await repo.requests('r.request_id = $2', [id], 1))[0]!, receipt };
    });
  }

  /** Văn bản trả lời người yêu cầu (Markdown) — không chứa họ tên / liên hệ; nhân viên điền tên khi in. */
  async letter(requestId: unknown, ctx: TenantContext = requireTenantContext()): Promise<string> {
    const id = this.uuid(requestId, 'requestId');
    return this.run(ctx, 'erasure.letter', async (repo) => {
      const p = await this.principal(repo, ctx);
      const req = (await repo.requests('r.request_id = $2', [id], 1))[0];
      if (!req) throw new ClinicalError('NOT_FOUND', 'Erasure request not found');
      await this.decideAt(p, req.organizationId as OrganizationId, 'erasure:request', ['retention:read']);
      const receipts = await repo.receipts(5, 'd.request_id = $2', [id]);
      return renderLetter(req, receipts);
    });
  }

  // ---- nội bộ -------------------------------------------------------------------
  private async execute(repo: Repo, trigger: 'schedule' | 'manual', by: string | null): Promise<RunResult> {
    const started = this.clock();
    const runId = randomUUID();
    const days = await repo.effectiveDays();
    const policy = retentionPolicyVersion(days);
    const detail: Record<string, number> = { booking_contact: 0, idempotency: 0, outbox: 0, deferredErasures: 0 };
    let receipts = 0;
    // 1. Lịch hẹn quá hạn -> ẩn danh (lặp theo lô, một biên nhận cho cả lần chạy).
    {
      const rid = randomUUID();
      let n = 0;
      let keys = 0;
      let cutoff: string | null = null;
      for (let i = 0; i < 50; i++) {
        const r = await repo.fn<{ bookings: number; keysShredded: number; cutoff: string }>('SELECT governance.anonymize_due_bookings($1, 1000) AS v', [rid]);
        n += num(r.bookings);
        keys += num(r.keysShredded);
        cutoff = r.cutoff;
        if (num(r.bookings) < 1000) break;
      }
      detail['booking_contact'] = n;
      if (n > 0) {
        const rule = ruleById('booking_contact')!;
        await repo.insertReceipt({
          id: rid, kind: 'retention', rule: rule.id, request: null, policy, basis: rule.legalBasis, criteria: { visitDateBefore: cutoff, days: days[rule.id] },
          scope: { 'clinical.bookings': n }, keys, outcome: 'completed', started, horizon: this.horizon, by, approvedBy: null,
        });
        receipts++;
      }
    }
    // 2. Dữ liệu kỹ thuật hết mục đích -> xoá.
    for (const [rule, fn, table] of [['idempotency', 'purge_idempotency', 'platform.idempotency_keys'], ['outbox', 'purge_outbox', 'platform.outbox_events']] as const) {
      const n = num((await repo.tdb.query<{ n: string | number }>(`SELECT governance.${fn}(50000) AS n`)).rows[0]!.n);
      detail[rule] = n;
      if (n > 0) {
        const r = ruleById(rule)!;
        await repo.insertReceipt({
          id: randomUUID(), kind: 'retention', rule, request: null, policy, basis: r.legalBasis, criteria: { olderThanDays: days[rule] },
          scope: { [table]: n }, keys: 0, outcome: 'completed', started, horizon: this.horizon, by, approvedBy: null,
        });
        receipts++;
      }
    }
    // 3. Yêu cầu xoá đã hoãn, nay hết hạn giữ.
    const due = await repo.requests(`r.status = 'deferred' AND r.deferred_until <= now()`, [], 100);
    for (const req of due) {
      await this.executeRequest(repo, req.requestId, req.decidedBy, req.requestedBy, 'final_receipt_id', policy);
      detail['deferredErasures'] = (detail['deferredErasures'] ?? 0) + 1;
      receipts++;
    }
    await repo.insertRun({ id: runId, trigger, by, started, status: 'succeeded', detail });
    return { runId, receipts, detail };
  }

  /** Thực thi một yêu cầu đã duyệt (ngay khi duyệt, hoặc khi hết hạn giữ). Ghi biên nhận + cập nhật trạng thái. */
  private async executeRequest(repo: Repo, id: string, approvedBy: string | null, _requestedBy: string | null, column: 'receipt_id' | 'final_receipt_id', policyIn?: string): Promise<Receipt> {
    const started = this.clock();
    const policy = policyIn ?? retentionPolicyVersion(await repo.effectiveDays());
    const rid = randomUUID();
    let res: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      res = await repo.fn('SELECT governance.execute_erasure($1, $2) AS v', [id, rid]);
    } catch (e) {
      if ((e as { code?: string }).code === '42501') throw new ClinicalError('FORBIDDEN', 'Erasure must be approved by a second person', { reason: 'FOUR_EYES' });
      throw e;
    }
    const partial = res['mode'] === 'partial';
    const scope: Record<string, number> = partial
      ? { 'clinical.bookings': num(res['bookings'] ?? 0), 'patient.persons (hạn chế xử lý)': num(res['restrictedPersons'] ?? 0) }
      : {
          'patient.persons': num(res['persons'] ?? 0), 'patient.identifiers': num(res['identifiers'] ?? 0), 'clinical.bookings': num(res['bookings'] ?? 0),
          'patient.person_merges (ảnh chụp)': num(res['mergeSnapshots'] ?? 0), 'platform.idempotency_keys': num(res['idempotencyResponses'] ?? 0),
        };
    const holds = res['holds'] ?? {};
    const basis = partial
      ? `Luật Bảo vệ dữ liệu cá nhân 2025 (Điều 14) — yêu cầu của chủ thể; phần còn nghĩa vụ lưu giữ được giữ lại: ${[
          holds['medical_record'] ? ruleById('medical_record')!.legalBasis : null,
          holds['financial_record'] ? ruleById('financial_record')!.legalBasis : null,
        ].filter(Boolean).join(' ')}`
      : 'Luật Bảo vệ dữ liệu cá nhân 2025 (Điều 14) — yêu cầu xoá của chủ thể dữ liệu, không còn nghĩa vụ lưu giữ.';
    await repo.insertReceipt({
      id: rid, kind: 'erasure', rule: null, request: id, policy, basis: basis.slice(0, 1000),
      criteria: { mode: res['mode'], holdUntil: res['holdUntil'] ?? null, medicalRecordUntil: holds['medical_record'] ?? null, financialRecordUntil: holds['financial_record'] ?? null },
      scope, keys: num(res['keysShredded'] ?? 0), outcome: partial ? 'partial' : 'completed', started, horizon: this.horizon, by: approvedBy, approvedBy,
    });
    await repo.tdb.query(
      `UPDATE governance.erasure_requests SET status = $3, deferred_until = $4, ${column} = $5 WHERE tenant_id = $1 AND request_id = $2`,
      [repo.tdb.tenantId, id, partial ? 'deferred' : 'completed', partial ? res['holdUntil'] : null, rid],
    );
    return (await repo.receipts(1, 'd.receipt_id = $2', [rid]))[0]!;
  }

  private uuid(v: unknown, name: string): string {
    if (typeof v !== 'string' || !isUuid(v)) throw new ClinicalError('VALIDATION', `${name} must be a UUID`);
    return v.toLowerCase();
  }
  private async principal(repo: Repo, ctx: TenantContext): Promise<{ user: User; grants: readonly AccessGrant[]; byOrg: (org: OrganizationId) => Promise<readonly AccessGrant[]> }> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) => m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    const load = (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>;
    return {
      user,
      grants: await buildGrants(valid, user.tenantId, load),
      byOrg: (org) => buildGrants(valid.filter((m) => m.organizationId === org && ctx.allowedOrganizationIds.includes(org)), user.tenantId, load),
    };
  }
  /** Quyền tại cơ sở của hồ sơ (lập yêu cầu); `orTenantWide` = quyền cấp chủ quản thay thế (xem). */
  private async decideAt(
    p: { user: User; grants: readonly AccessGrant[]; byOrg: (org: OrganizationId) => Promise<readonly AccessGrant[]> }, org: OrganizationId, perm: Permission,
    orTenantWide: readonly Permission[] = [],
  ): Promise<void> {
    if (orTenantWide.some((x) => this.allowed(p.grants, p.user, x))) return;
    this.need(await p.byOrg(org), p.user, perm);
  }
  private allowed(grants: readonly AccessGrant[], user: User, perm: Permission): boolean {
    return decideAccess(grants, perm as PolicyAction, PERMISSIONS[ACCESS_POLICY_CATALOG[perm as PolicyAction].basePermission as Permission], { callerUserId: user.userId }).allowed;
  }
  private need(grants: readonly AccessGrant[], user: User, perm: Permission): void {
    const d = decideAccess(grants, perm as PolicyAction, PERMISSIONS[ACCESS_POLICY_CATALOG[perm as PolicyAction].basePermission as Permission], { callerUserId: user.userId });
    if (!d.allowed) {
      throw d.reason === 'ROLE' ? new ClinicalError('FORBIDDEN', `Missing permission ${perm}`) : new ClinicalError('FORBIDDEN', `Access policy does not permit ${perm}`, { reason: 'ACCESS_POLICY' });
    }
  }
  private event(
    ctx: TenantContext, action: string, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>, resourceType = 'Retention',
    resourceId: string | null = null,
  ): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject }, organizationId: null, action,
      resourceType, resourceId, personId: null, patientId: null, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
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
// Bộ lập lịch: mỗi tenant đang hoạt động, mỗi chu kỳ một lần.
// ---------------------------------------------------------------------------
type SchedulerLog = (o: { level: 'info' | 'warn'; msg: string; [k: string]: unknown }) => void;
export class RetentionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly deps: { pool: PgPoolLike; service: Pick<RetentionService, 'runScheduled'>; intervalMs: number; log?: SchedulerLog }) {}
  start(): void {
    if (this.timer || this.deps.intervalMs <= 0) return;
    const first = setTimeout(() => void this.tick(), Math.min(120_000, this.deps.intervalMs));
    first.unref();
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const client = await this.deps.pool.connect();
        let tenants: string[];
        try {
          tenants = ((await client.query('SELECT governance.active_tenants() AS t')).rows as Array<{ t: string }>).map((x) => x.t);
        } finally {
          client.release();
        }
        for (const t of tenants) {
          try {
            const r = await this.deps.service.runScheduled(t);
            if (r.receipts > 0) this.deps.log?.({ level: 'info', msg: 'retention run', receipts: r.receipts, ...r.detail });
          } catch (e) {
            this.deps.log?.({ level: 'warn', msg: 'retention run failed', error: e instanceof ClinicalError ? e.code : 'INTERNAL' });
          }
        }
      } catch {
        this.deps.log?.({ level: 'warn', msg: 'retention scheduler tick failed' });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

// ---------------------------------------------------------------------------
const vnDate = (s: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(s));
const CHANNEL_LABEL: Readonly<Record<ErasureChannel, string>> = { counter: 'trực tiếp tại quầy', written: 'văn bản', email: 'email', phone: 'điện thoại', portal: 'cổng bệnh nhân trực tuyến (xác thực OTP)' };
export function renderLetter(req: ErasureRequest, receipts: readonly Receipt[]): string {
  const L: string[] = [];
  L.push('# Thông báo kết quả xử lý yêu cầu xoá dữ liệu cá nhân', '');
  L.push(`Kính gửi: ………………………… (người yêu cầu; mã bệnh nhân ${req.mrn ?? '—'})`, '');
  L.push(`Cơ sở đã nhận yêu cầu xoá dữ liệu cá nhân của Quý vị ngày ${vnDate(req.receivedAt)} (hình thức: ${CHANNEL_LABEL[req.channel]}; mã yêu cầu \`${req.requestId}\`).`, '');
  if (req.status === 'pending') L.push('Yêu cầu đang được xem xét.');
  else if (req.status === 'rejected') L.push(`Yêu cầu **không được chấp nhận**. Lý do: ${req.decisionNote ?? '—'}`);
  else {
    const full = receipts.find((r) => r.criteria['mode'] === 'full');
    const part = receipts.find((r) => r.criteria['mode'] === 'partial');
    if (part) {
      L.push(`Ngày ${vnDate(part.finishedAt)}, cơ sở đã **xoá** dữ liệu đặt lịch khám online của Quý vị và **hạn chế xử lý** hồ sơ (chỉ dùng cho nghĩa vụ lưu trữ / khám chữa bệnh theo luật).`, '');
      L.push('Phần dữ liệu thuộc hồ sơ bệnh án / chứng từ kế toán **phải được lưu giữ** theo quy định:', '');
      if (part.criteria['medicalRecordUntil']) L.push(`- Hồ sơ bệnh án: giữ đến ${vnDate(String(part.criteria['medicalRecordUntil']))}.`);
      if (part.criteria['financialRecordUntil']) L.push(`- Chứng từ thu / chi: giữ đến ${vnDate(String(part.criteria['financialRecordUntil']))}.`);
      L.push('', `Hết thời hạn trên, hệ thống tự động xoá phần còn lại (dự kiến sau ${req.deferredUntil ? vnDate(req.deferredUntil) : '—'}) mà Quý vị không cần yêu cầu lại.`);
    }
    if (full) {
      L.push('', `Ngày ${vnDate(full.finishedAt)}, cơ sở đã **xoá toàn bộ** dữ liệu định danh và liên hệ của Quý vị (họ tên, ngày sinh, giới tính, số điện thoại, email, giấy tờ tuỳ thân, lịch hẹn).`);
    }
    const r = full ?? part;
    if (r) {
      L.push('', `Dữ liệu đã xoá được mã hoá bằng khoá riêng của Quý vị và khoá này đã bị huỷ, nên không thể khôi phục từ hệ thống. Các bản sao lưu cũ được hệ thống tự xoá theo vòng đời; sau ngày ${vnDate(r.irreversibleAfter)} không còn bản sao nào chứa dữ liệu này.`);
    }
  }
  L.push('', '……………, ngày …… tháng …… năm ……', '', '**Đại diện cơ sở khám chữa bệnh** (ký, ghi rõ họ tên)');
  return L.join('\n') + '\n';
}
