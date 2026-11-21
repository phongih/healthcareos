/**
 * HCOS-F14 | Quầy trả: dược sĩ soạn thuốc, các quầy 1, 2, 3… gọi số để giao thuốc, trả giấy tờ và quyết toán tiền.
 *
 *   BS kết thúc khám      => DB tự tạo phiếu trả, giữ số thứ tự cũ (migration 017, trigger trên clinical.encounters).
 *   Dược sĩ (handover:prepare)   cấp thuốc ở tab Dược như cũ, rồi bấm "Soạn xong" => phiếu sang 'ready'.
 *                                Còn thuốc chưa cấp (hết hàng…) thì phải ghi chú lý do mới cho chuyển.
 *   Quầy (handover:serve)        "Gọi tiếp" tại một quầy (ưu tiên trước, rồi theo giờ soạn xong); gọi lại; vắng mặt;
 *                                đưa về hàng chờ; hoàn tất khi đã giao thuốc, trả giấy tờ và số dư thanh toán = 0
 *                                (hồ sơ thanh toán đang mở được đóng trong CÙNG transaction).
 *   Quản lý (handover:manage)    thêm / tạm ngưng quầy.
 *
 * Màn hình TV dùng khoá hiển thị của F6 (PgQueueBoard đọc thêm clinical.handover_board): chỉ số + quầy.
 */
import { randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type PatientId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import { assertOrganizationAllowed, assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, isoOrNull, num, PgClinicalRepository, translatePgError } from './encounter.service';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export type HandoverStatus = 'preparing' | 'ready' | 'called' | 'skipped' | 'done' | 'cancelled';

export interface HandoverDesk {
  readonly deskId: string;
  readonly organizationId: OrganizationId;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly version: number;
}

export interface MedicationLine {
  readonly itemId: string;
  readonly brandName: string;
  readonly strength: string;
  readonly form: string;
  readonly unit: string;
  readonly usage: string;
  readonly prescribed: number;
  readonly dispensed: number;
}

export interface Checklist {
  /** Đã giao thuốc (null khi đợt khám không có đơn). */
  readonly medication: boolean | null;
  /** 'returned' = đã trả CCCD / thẻ BHYT / sổ khám / kết quả; 'none' = không giữ giấy tờ nào. */
  readonly documents: 'returned' | 'none';
}

export interface HandoverView {
  readonly handoverId: string;
  readonly organizationId: OrganizationId;
  readonly patientId: PatientId;
  readonly encounterId: string;
  readonly queueDate: string;
  readonly displayNo: string;
  readonly priorityRank: number;
  readonly needsMedication: boolean;
  readonly status: HandoverStatus;
  readonly readyAt: string | null;
  readonly preparedByName: string | null;
  readonly prepNote: string | null;
  readonly desk: { readonly deskId: string; readonly code: string; readonly name: string } | null;
  readonly calledCount: number;
  readonly calledAt: string | null;
  readonly calledBy: UserId | null;
  readonly calledByName: string | null;
  readonly completedAt: string | null;
  readonly completedByName: string | null;
  readonly checklist: Checklist | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly version: number;
  readonly patient: { readonly mrn: string; readonly familyName: string; readonly givenName: string; readonly birthDate: string | null };
  readonly practitionerName: string | null;
  readonly medications: readonly MedicationLine[];
  /** Hồ sơ thanh toán đang mở của bệnh nhân (nếu có). balance > 0: còn dư phải hoàn; < 0: còn phải thu. */
  readonly finance: { readonly caseId: string; readonly balance: number; readonly charges: number; readonly received: number } | null;
}

export interface HandoverBoardRow {
  readonly kind: 'called' | 'ready' | 'preparing';
  readonly displayNo: string;
  readonly deskCode: string | null;
  readonly deskName: string | null;
  readonly priority: 'emergency' | 'priority' | null;
  readonly calledCount: number;
  readonly calledAt: string | null;
}

type Permission = 'handover:read' | 'handover:prepare' | 'handover:serve' | 'handover:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'handover:read': ['pharmacist', 'pharmacy_admin', 'clinic_staff', 'cashier', 'clinic_admin', 'tenant_admin'],
  'handover:prepare': ['pharmacist', 'pharmacy_admin'],
  // Một người đứng quầy làm cả ba việc; phần thu/chi tiền vẫn cần finance:collect + ca thu ngân đang mở.
  'handover:serve': ['pharmacist', 'clinic_staff', 'cashier', 'clinic_admin'],
  'handover:manage': ['clinic_admin', 'tenant_admin'],
};

const CODE_RE = /^[A-Z0-9]{1,6}$/;
const LIST_LIMIT = 300;
const fmtQty = (n: number): string => n.toLocaleString('vi-VN', { maximumFractionDigits: 3 });

// ===========================================================================
// PostgreSQL
// ===========================================================================
const H_COLS =
  'h.handover_id, h.organization_id, h.patient_id, h.encounter_id, h.queue_date::text AS queue_date, h.display_no, h.priority_rank, h.needs_medication, ' +
  'h.status, h.ready_at, h.prep_note, h.desk_id, h.called_count, h.called_at, h.called_by, h.completed_at, h.checklist, h.note, h.created_at, h.version, ' +
  'k.code AS desk_code, k.name AS desk_name, pt.mrn, ps.family_name, ps.given_name, ps.birth_date::text AS birth_date, ' +
  'up.display_name AS prepared_by_name, uc.display_name AS called_by_name, ud.display_name AS completed_by_name, ue.display_name AS practitioner_name';
const H_FROM = `
  FROM clinical.handover_tickets h
  JOIN patient.patients pt ON pt.tenant_id = h.tenant_id AND pt.patient_id = h.patient_id
  JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
  JOIN clinical.encounters e ON e.tenant_id = h.tenant_id AND e.encounter_id = h.encounter_id
  LEFT JOIN clinical.handover_desks k ON k.tenant_id = h.tenant_id AND k.desk_id = h.desk_id
  LEFT JOIN iam.users up ON up.tenant_id = h.tenant_id AND up.user_id = h.prepared_by
  LEFT JOIN iam.users uc ON uc.tenant_id = h.tenant_id AND uc.user_id = h.called_by
  LEFT JOIN iam.users ud ON ud.tenant_id = h.tenant_id AND ud.user_id = h.completed_by
  LEFT JOIN iam.users ue ON ue.tenant_id = e.tenant_id AND ue.user_id = e.practitioner_user_id`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const bool = (v: unknown): boolean => v === true || v === 't';
const jsonOf = (v: unknown): any => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
const mapDesk = (r: any): HandoverDesk => ({
  deskId: r.desk_id, organizationId: r.organization_id, code: r.code, name: r.name, isActive: bool(r.is_active), version: num(r.version),
});
type Row = Omit<HandoverView, 'medications' | 'finance'>;
const mapRow = (r: any): Row => ({
  handoverId: r.handover_id, organizationId: r.organization_id, patientId: r.patient_id, encounterId: r.encounter_id, queueDate: String(r.queue_date),
  displayNo: r.display_no, priorityRank: num(r.priority_rank), needsMedication: bool(r.needs_medication), status: r.status, readyAt: isoOrNull(r.ready_at),
  preparedByName: r.prepared_by_name ?? null, prepNote: r.prep_note ?? null,
  desk: r.desk_id ? { deskId: r.desk_id, code: r.desk_code, name: r.desk_name } : null,
  calledCount: num(r.called_count), calledAt: isoOrNull(r.called_at), calledBy: r.called_by ?? null, calledByName: r.called_by_name ?? null,
  completedAt: isoOrNull(r.completed_at), completedByName: r.completed_by_name ?? null, checklist: jsonOf(r.checklist), note: r.note ?? null,
  createdAt: iso(r.created_at), version: num(r.version),
  patient: { mrn: r.mrn, familyName: r.family_name, givenName: r.given_name, birthDate: r.birth_date ?? null },
  practitionerName: r.practitioner_name ?? null,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgHandoverRepository extends PgClinicalRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }

  async listDesks(org: OrganizationId): Promise<HandoverDesk[]> {
    const r = await this.db.query(
      'SELECT desk_id, organization_id, code, name, is_active, version FROM clinical.handover_desks WHERE tenant_id = $1 AND organization_id = $2 ORDER BY code',
      [this.t, org],
    );
    return r.rows.map(mapDesk);
  }
  async findDesk(id: string): Promise<HandoverDesk | null> {
    const r = await this.db.query('SELECT desk_id, organization_id, code, name, is_active, version FROM clinical.handover_desks WHERE tenant_id = $1 AND desk_id = $2', [this.t, id]);
    return r.rows[0] ? mapDesk(r.rows[0]) : null;
  }
  async insertDesk(id: string, org: OrganizationId, code: string, name: string): Promise<void> {
    try {
      await this.db.query('INSERT INTO clinical.handover_desks (desk_id, tenant_id, organization_id, code, name) VALUES ($1, $2, $3, $4, $5)', [id, this.t, org, code, name]);
    } catch (e) {
      translatePgError(e);
    }
  }
  async setDeskActive(id: string, isActive: boolean, expectedVersion: number): Promise<HandoverDesk | null> {
    const r = await this.db.query(
      `UPDATE clinical.handover_desks SET is_active = $3, updated_at = now() WHERE tenant_id = $1 AND desk_id = $2 AND version = $4
       RETURNING desk_id, organization_id, code, name, is_active, version`,
      [this.t, id, isActive, expectedVersion],
    );
    return r.rows[0] ? mapDesk(r.rows[0]) : null;
  }

  async listRows(org: OrganizationId, opts: { id?: string; includeDone: boolean }): Promise<Row[]> {
    const r = await this.db.query(
      `SELECT ${H_COLS} ${H_FROM}
        WHERE h.tenant_id = $1 AND h.organization_id = $2
          AND ($3::uuid IS NULL AND h.queue_date = clinical.queue_today() AND h.status <> 'cancelled' AND ($4 OR h.status <> 'done')
               OR h.handover_id = $3::uuid)
        ORDER BY CASE h.status WHEN 'called' THEN 0 WHEN 'ready' THEN 1 WHEN 'preparing' THEN 2 WHEN 'skipped' THEN 3 ELSE 4 END,
                 h.priority_rank DESC, COALESCE(h.ready_at, h.created_at), h.display_no
        LIMIT ${LIST_LIMIT}`,
      [this.t, org, opts.id ?? null, opts.includeDone],
    );
    return r.rows.map(mapRow);
  }
  async findTicket(id: string): Promise<{ handoverId: string; organizationId: OrganizationId; patientId: PatientId; encounterId: string; status: HandoverStatus; deskId: string | null; calledBy: UserId | null; needsMedication: boolean; displayNo: string } | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT handover_id, organization_id, patient_id, encounter_id, status, desk_id, called_by, needs_medication, display_no
         FROM clinical.handover_tickets WHERE tenant_id = $1 AND handover_id = $2 FOR UPDATE`,
      [this.t, id],
    );
    const x = r.rows[0];
    return x
      ? {
          handoverId: x['handover_id'] as string, organizationId: x['organization_id'] as OrganizationId, patientId: x['patient_id'] as PatientId,
          encounterId: x['encounter_id'] as string, status: x['status'] as HandoverStatus, deskId: (x['desk_id'] as string | null) ?? null,
          calledBy: (x['called_by'] as UserId | null) ?? null, needsMedication: bool(x['needs_medication']), displayNo: x['display_no'] as string,
        }
      : null;
  }

  async medications(encounterIds: readonly string[]): Promise<Map<string, MedicationLine[]>> {
    const out = new Map<string, MedicationLine[]>();
    if (encounterIds.length === 0) return out;
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT p.encounter_id, i.item_id, m.brand_name, m.strength, m.form, m.unit_of_measure, i.dose_quantity, i.dose_unit, i.frequency_per_day,
              i.duration_days, i.instructions, i.quantity_prescribed, i.quantity_dispensed
         FROM clinical.prescriptions p
         JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
         JOIN pharmacy.medications m ON m.tenant_id = i.tenant_id AND m.medication_id = i.medication_id
        WHERE p.tenant_id = $1 AND p.status IN ('active', 'completed')
          AND p.encounter_id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)
        ORDER BY p.prescribed_at, i.line_no`,
      [this.t, JSON.stringify(encounterIds)],
    );
    for (const x of r.rows) {
      const list = out.get(x['encounter_id'] as string) ?? [];
      list.push({
        itemId: x['item_id'] as string, brandName: x['brand_name'] as string, strength: x['strength'] as string, form: x['form'] as string,
        unit: x['unit_of_measure'] as string,
        usage: `${fmtQty(Number(x['dose_quantity']))} ${x['dose_unit'] as string} × ${num(x['frequency_per_day'])} lần/ngày × ${num(x['duration_days'])} ngày` +
          (x['instructions'] ? ` — ${x['instructions'] as string}` : ''),
        prescribed: num(x['quantity_prescribed']), dispensed: num(x['quantity_dispensed']),
      });
      out.set(x['encounter_id'] as string, list);
    }
    return out;
  }

  /** Hồ sơ thanh toán đang mở + số dư. lock => FOR UPDATE (chặn lập phiếu đồng thời khi hoàn tất). */
  async openCases(org: OrganizationId, patientIds: readonly string[], lock = false): Promise<Map<string, { caseId: string; balance: number; charges: number; received: number }>> {
    const out = new Map<string, { caseId: string; balance: number; charges: number; received: number }>();
    if (patientIds.length === 0) return out;
    if (lock) {
      await this.db.query(
        `SELECT 1 FROM finance.billing_cases WHERE tenant_id = $1 AND organization_id = $2 AND status = 'open'
            AND patient_id IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid) FOR UPDATE`,
        [this.t, org, JSON.stringify(patientIds)],
      );
    }
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT c.case_id, c.patient_id,
              COALESCE((SELECT sum(amount) FROM finance.charges ch WHERE ch.tenant_id = c.tenant_id AND ch.case_id = c.case_id AND ch.status = 'active'), 0) AS charges,
              COALESCE((SELECT sum(CASE WHEN r.kind = 'refund' THEN -r.amount ELSE r.amount END) FROM finance.receipts r
                         WHERE r.tenant_id = c.tenant_id AND r.case_id = c.case_id AND r.status = 'valid'), 0) AS received
         FROM finance.billing_cases c
        WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.status = 'open'
          AND c.patient_id IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid)`,
      [this.t, org, JSON.stringify(patientIds)],
    );
    for (const x of r.rows) {
      const charges = num(x['charges']);
      const received = num(x['received']);
      out.set(x['patient_id'] as string, { caseId: x['case_id'] as string, charges, received, balance: received - charges });
    }
    return out;
  }
  async closeCase(caseId: string, by: UserId): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE finance.billing_cases SET status = 'closed', closed_by = $3, closed_at = now() WHERE tenant_id = $1 AND case_id = $2 AND status = 'open' RETURNING 1`,
      [this.t, caseId, by],
    );
    return r.rows.length > 0;
  }

  async remainingToDispense(encounterId: string): Promise<number> {
    const r = await this.db.query<{ n: string | number }>(
      `SELECT COALESCE(sum(i.quantity_prescribed - i.quantity_dispensed), 0) AS n
         FROM clinical.prescriptions p JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
        WHERE p.tenant_id = $1 AND p.encounter_id = $2 AND p.status = 'active'`,
      [this.t, encounterId],
    );
    return Number(r.rows[0]!.n);
  }

  async callNext(deskId: string, org: OrganizationId, by: UserId): Promise<string | null> {
    try {
      const r = await this.db.query<{ handover_id: string }>(
        `UPDATE clinical.handover_tickets h
            SET status = 'called', desk_id = $3, called_by = $4, called_at = now(), called_count = h.called_count + 1, updated_at = now()
          WHERE h.tenant_id = $1 AND h.handover_id = (
                SELECT handover_id FROM clinical.handover_tickets
                 WHERE tenant_id = $1 AND organization_id = $2 AND queue_date = clinical.queue_today() AND status = 'ready'
                 ORDER BY priority_rank DESC, ready_at, display_no
                 LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING h.handover_id`,
        [this.t, org, deskId, by],
      );
      return r.rows[0]?.handover_id ?? null;
    } catch (e) {
      return translatePgError(e);
    }
  }
  async deskCurrent(deskId: string): Promise<string | null> {
    const r = await this.db.query<{ handover_id: string }>(
      `SELECT handover_id FROM clinical.handover_tickets WHERE tenant_id = $1 AND desk_id = $2 AND status = 'called'`,
      [this.t, deskId],
    );
    return r.rows[0]?.handover_id ?? null;
  }

  async update(id: string, from: readonly HandoverStatus[], set: Record<string, unknown>, opts: { requireCaller?: UserId; bumpCall?: boolean } = {}): Promise<boolean> {
    const params: unknown[] = [this.t, id, JSON.stringify(from)];
    const sets = ['updated_at = now()'];
    for (const [col, v] of Object.entries(set)) {
      if (v instanceof SqlNow) {
        sets.push(`${col} = now()`);
        continue;
      }
      params.push(col === 'checklist' && v !== null ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}${col === 'checklist' ? '::jsonb' : ''}`);
    }
    if (opts.bumpCall) sets.push('called_count = called_count + 1', 'called_at = now()');
    let cond = '';
    if (opts.requireCaller) {
      params.push(opts.requireCaller);
      cond = ` AND called_by = $${params.length}`;
    }
    try {
      const r = await this.db.query(
        `UPDATE clinical.handover_tickets SET ${sets.join(', ')}
          WHERE tenant_id = $1 AND handover_id = $2 AND status IN (SELECT jsonb_array_elements_text($3::jsonb))${cond} RETURNING 1`,
        params,
      );
      return r.rows.length > 0;
    } catch (e) {
      return translatePgError(e);
    }
  }
}
class SqlNow {}
const NOW = new SqlNow();

/** Màn hình TV: không có tenant context; chỉ gọi clinical.handover_board(key). */
export async function readHandoverBoard(client: { query(sql: string, params: unknown[]): Promise<unknown> }, key: string): Promise<HandoverBoardRow[]> {
  const r = (await client.query('SELECT * FROM clinical.handover_board($1)', [key])) as { rows: Array<Record<string, unknown>> };
  return r.rows.map((x) => {
    const rank = num(x['priority_rank']);
    return {
      kind: x['kind'] as HandoverBoardRow['kind'],
      displayNo: x['display_no'] as string,
      deskCode: (x['desk_code'] as string | null) ?? null,
      deskName: (x['desk_name'] as string | null) ?? null,
      priority: rank === 2 ? 'emergency' : rank === 1 ? 'priority' : null,
      calledCount: num(x['called_count'] ?? 0),
      calledAt: isoOrNull(x['called_at']),
    };
  });
}

// ===========================================================================
// Service
// ===========================================================================
interface Ctx { readonly repo: PgHandoverRepository; readonly user: User }

export class HandoverService {
  private readonly clock: () => Date;
  private readonly newId: () => string;
  constructor(private readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date; newId?: () => string }) {
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ---- Quầy -----------------------------------------------------------------
  async listDesks(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverDesk[]> {
    return this.run(ctx, 'handover.desk.list', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      await this.check(repo, ctx, org, ['handover:read', 'handover:manage']);
      return repo.listDesks(org);
    });
  }

  async createDesk(input: { organizationId: string; code: string; name: string }, ctx: TenantContext = requireTenantContext()): Promise<HandoverDesk> {
    return this.run(ctx, 'handover.desk.create', async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
      const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
      if (!CODE_RE.test(code)) throw new ClinicalError('VALIDATION', 'code must be 1-6 characters A-Z / 0-9');
      if (name.length < 2 || name.length > 100) throw new ClinicalError('VALIDATION', 'name must be 2-100 characters');
      const user = await this.check(repo, ctx, org, ['handover:manage']);
      const id = this.newId();
      await repo.insertDesk(id, org, code, name); // CONFLICT: DESK_CODE_TAKEN
      await repo.appendAudit(this.event(ctx, 'handover.desk.create', 'HandoverDesk', id, org, null, 'success', user, { code }));
      return (await repo.findDesk(id))!;
    });
  }

  async setDeskActive(id: string, isActive: boolean, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<HandoverDesk> {
    return this.run(ctx, 'handover.desk.update', async (repo) => {
      const desk = await this.loadDesk(repo, ctx, id);
      if (typeof isActive !== 'boolean') throw new ClinicalError('VALIDATION', 'isActive must be boolean');
      const user = await this.check(repo, ctx, desk.organizationId, ['handover:manage']);
      if (!isActive && (await repo.deskCurrent(desk.deskId))) {
        throw new ClinicalError('INVALID_STATE', 'Desk is serving a patient', { reason: 'DESK_BUSY' });
      }
      const saved = await repo.setDeskActive(desk.deskId, isActive, expectedVersion);
      if (!saved) throw new ClinicalError('CONFLICT', 'Desk version does not match', { reason: 'VERSION_CONFLICT' });
      await repo.appendAudit(this.event(ctx, 'handover.desk.update', 'HandoverDesk', desk.deskId, desk.organizationId, null, 'success', user, { isActive }));
      return saved;
    });
  }

  // ---- Xem --------------------------------------------------------------------
  async listToday(q: { organizationId: string; includeDone?: boolean }, ctx: TenantContext = requireTenantContext()): Promise<HandoverView[]> {
    return this.run(ctx, 'handover.list', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      const user = await this.check(repo, ctx, org, ['handover:read']);
      const rows = await repo.listRows(org, { includeDone: q.includeDone === true });
      const list = await this.enrich(repo, org, rows);
      await repo.appendAudit(this.event(ctx, 'handover.list', 'HandoverTicket', null, org, null, 'success', user, { count: list.length }));
      return list;
    });
  }

  async get(id: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.run(ctx, 'handover.read', async (repo) => {
      const t = await this.loadTicket(repo, ctx, id);
      const user = await this.check(repo, ctx, t.organizationId, ['handover:read']);
      const v = await this.view(repo, t.organizationId, t.handoverId);
      await repo.appendAudit(this.event(ctx, 'handover.read', 'HandoverTicket', t.handoverId, t.organizationId, t.patientId, 'success', user, {}));
      return v;
    });
  }

  // ---- Dược sĩ ----------------------------------------------------------------
  async markPrepared(id: string, input: { note?: string | null }, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.prepare', ['handover:prepare'], async ({ repo, user }, t) => {
      if (t.status !== 'preparing') throw new ClinicalError('INVALID_STATE', `Handover is ${t.status}`, { reason: 'HANDOVER_STATE' });
      const note = this.text(input.note, 'note');
      const remaining = await repo.remainingToDispense(t.encounterId);
      if (remaining > 0 && !note) {
        throw new ClinicalError('INVALID_STATE', `${remaining} units are not dispensed yet; add a note (e.g. out of stock) to continue`, { reason: 'MEDICATION_NOT_DISPENSED' });
      }
      if (!(await repo.update(t.handoverId, ['preparing'], { status: 'ready', ready_at: NOW, prepared_by: user.userId, prep_note: note }))) this.changed();
      return { remaining, partial: remaining > 0 };
    });
  }

  // ---- Quầy -------------------------------------------------------------------
  async callNext(deskId: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverView | null> {
    return this.run(ctx, 'handover.call', async (repo) => {
      const desk = await this.loadDesk(repo, ctx, deskId);
      if (!desk.isActive) throw new ClinicalError('INVALID_STATE', 'Desk is inactive', { reason: 'DESK_INACTIVE' });
      const user = await this.check(repo, ctx, desk.organizationId, ['handover:serve']);
      if (await repo.deskCurrent(desk.deskId)) {
        throw new ClinicalError('INVALID_STATE', 'Finish or release the current number first', { reason: 'DESK_BUSY' });
      }
      const id = await repo.callNext(desk.deskId, desk.organizationId, user.userId);
      if (!id) return null;
      const v = await this.view(repo, desk.organizationId, id);
      await repo.appendAudit(this.event(ctx, 'handover.call', 'HandoverTicket', id, desk.organizationId, v.patientId, 'success', user, { deskId: desk.deskId, displayNo: v.displayNo }));
      return v;
    });
  }

  async recall(id: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.recall', ['handover:serve'], async ({ repo, user }, t) => {
      this.requireCalledByMe(t, user);
      if (!(await repo.update(t.handoverId, ['called'], { status: 'called' }, { requireCaller: user.userId, bumpCall: true }))) this.changed();
      return {};
    });
  }

  async skip(id: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.skip', ['handover:serve'], async ({ repo, user }, t) => {
      this.requireCalledByMe(t, user);
      if (!(await repo.update(t.handoverId, ['called'], { status: 'skipped' }, { requireCaller: user.userId }))) this.changed();
      return {};
    });
  }

  /** Trả số đang gọi về hàng chờ (vd. đổi quầy): quầy rảnh để gọi người khác. */
  async release(id: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.release', ['handover:serve'], async ({ repo, user }, t) => {
      this.requireCalledByMe(t, user);
      if (!(await repo.update(t.handoverId, ['called'], { status: 'ready', desk_id: null }, { requireCaller: user.userId }))) this.changed();
      return {};
    });
  }

  async requeue(id: string, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.requeue', ['handover:serve'], async ({ repo }, t) => {
      if (t.status !== 'skipped') throw new ClinicalError('INVALID_STATE', `Handover is ${t.status}`, { reason: 'HANDOVER_STATE' });
      if (!(await repo.update(t.handoverId, ['skipped'], { status: 'ready', desk_id: null }))) this.changed();
      return {};
    });
  }

  async cancel(id: string, input: { note?: string | null }, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.cancel', ['handover:serve'], async ({ repo }, t) => {
      const note = this.text(input.note, 'note');
      if (!note || note.length < 5) throw new ClinicalError('VALIDATION', 'A reason of at least 5 characters is required', { reason: 'REASON_REQUIRED' });
      if (!['preparing', 'ready', 'skipped'].includes(t.status)) throw new ClinicalError('INVALID_STATE', `Handover is ${t.status}`, { reason: 'HANDOVER_STATE' });
      if (!(await repo.update(t.handoverId, ['preparing', 'ready', 'skipped'], { status: 'cancelled', note }))) this.changed();
      return {};
    });
  }

  /** Hoàn tất tại quầy: đã giao thuốc + trả giấy tờ; số dư thanh toán phải bằng 0 (hồ sơ đang mở được đóng luôn). */
  async complete(id: string, input: { checklist?: unknown; note?: string | null }, ctx: TenantContext = requireTenantContext()): Promise<HandoverView> {
    return this.mutate(ctx, id, 'handover.complete', ['handover:serve'], async ({ repo, user }, t) => {
      this.requireCalledByMe(t, user);
      const c = (input.checklist ?? null) as Record<string, unknown> | null;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ClinicalError('VALIDATION', 'checklist is required');
      for (const k of Object.keys(c)) if (k !== 'medication' && k !== 'documents') throw new ClinicalError('VALIDATION', `Unknown checklist field ${k}`);
      if (c['documents'] !== 'returned' && c['documents'] !== 'none') throw new ClinicalError('VALIDATION', "checklist.documents must be 'returned' or 'none'");
      if (t.needsMedication && c['medication'] !== true) {
        throw new ClinicalError('INVALID_STATE', 'Confirm the medication was handed over', { reason: 'MEDICATION_NOT_HANDED' });
      }
      const checklist: Checklist = { medication: t.needsMedication ? true : null, documents: c['documents'] };
      const note = this.text(input.note, 'note');

      const fin = (await repo.openCases(t.organizationId, [t.patientId], true)).get(t.patientId) ?? null;
      if (fin && fin.balance !== 0) {
        throw new ClinicalError(
          'INVALID_STATE',
          fin.balance < 0 ? `Còn phải thu ${(-fin.balance).toLocaleString('vi-VN')} đ` : `Còn dư ${fin.balance.toLocaleString('vi-VN')} đ phải hoàn`,
          { reason: 'BALANCE_NOT_SETTLED' },
        );
      }
      if (fin && !(await repo.closeCase(fin.caseId, user.userId))) this.changed();
      if (!(await repo.update(t.handoverId, ['called'], { status: 'done', completed_by: user.userId, completed_at: NOW, checklist, note }, { requireCaller: user.userId }))) {
        this.changed();
      }
      return { caseClosed: fin?.caseId ?? null, documents: checklist.documents };
    });
  }

  // ---- Nội bộ -------------------------------------------------------------------
  private async mutate(
    ctx: TenantContext, id: string, action: string, perms: Permission[],
    fn: (c: Ctx, t: NonNullable<Awaited<ReturnType<PgHandoverRepository['findTicket']>>>) => Promise<Record<string, unknown>>,
  ): Promise<HandoverView> {
    return this.run(ctx, action, async (repo) => {
      const t = await this.loadTicket(repo, ctx, id);
      const user = await this.check(repo, ctx, t.organizationId, perms);
      const payload = await fn({ repo, user }, t);
      const v = await this.view(repo, t.organizationId, t.handoverId);
      await repo.appendAudit(this.event(ctx, action, 'HandoverTicket', t.handoverId, t.organizationId, t.patientId, 'success', user, {
        from: t.status, to: v.status, displayNo: t.displayNo, ...payload,
      }));
      return v;
    });
  }

  private requireCalledByMe(t: { status: HandoverStatus; calledBy: UserId | null }, user: User): void {
    if (t.status !== 'called') throw new ClinicalError('INVALID_STATE', `Handover is ${t.status}`, { reason: 'HANDOVER_STATE' });
    if (t.calledBy !== user.userId) throw new ClinicalError('INVALID_STATE', 'Number was called by another desk staff', { reason: 'CALLED_BY_OTHER' });
  }
  private changed(): never {
    throw new ClinicalError('CONFLICT', 'Handover changed concurrently', { reason: 'HANDOVER_CHANGED' });
  }
  private text(v: unknown, field: string): string | null {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
    if (typeof v !== 'string' || v.trim().length > 500) throw new ClinicalError('VALIDATION', `${field} must be at most 500 characters`);
    return v.trim().replace(/\s+/g, ' ');
  }

  private async view(repo: PgHandoverRepository, org: OrganizationId, id: string): Promise<HandoverView> {
    const rows = await repo.listRows(org, { id, includeDone: true });
    if (!rows[0]) throw new ClinicalError('NOT_FOUND', 'Handover not found');
    return (await this.enrich(repo, org, rows))[0]!;
  }
  private async enrich(repo: PgHandoverRepository, org: OrganizationId, rows: readonly Row[]): Promise<HandoverView[]> {
    const meds = await repo.medications(rows.map((r) => r.encounterId));
    const open = rows.filter((r) => r.status !== 'done' && r.status !== 'cancelled');
    const fin = await repo.openCases(org, [...new Set(open.map((r) => r.patientId))]);
    return rows.map((r) => ({
      ...r,
      medications: meds.get(r.encounterId) ?? [],
      finance: r.status === 'done' || r.status === 'cancelled' ? null : (fin.get(r.patientId) ?? null),
    }));
  }

  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  private async loadDesk(repo: PgHandoverRepository, ctx: TenantContext, id: string): Promise<HandoverDesk> {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'desk id must be a UUID');
    const d = await repo.findDesk(id.toLowerCase());
    if (!d) throw new ClinicalError('NOT_FOUND', 'Desk not found');
    assertOrganizationAllowed(d.organizationId, ctx);
    return d;
  }
  private async loadTicket(repo: PgHandoverRepository, ctx: TenantContext, id: string) {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'handover id must be a UUID');
    const t = await repo.findTicket(id.toLowerCase());
    if (!t) throw new ClinicalError('NOT_FOUND', 'Handover not found');
    assertOrganizationAllowed(t.organizationId, ctx);
    return t;
  }
  private async check(repo: PgHandoverRepository, ctx: TenantContext, org: OrganizationId, perms: Permission[]): Promise<User> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) => (m.organizationId === org || m.role === 'tenant_admin') && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    const grants: readonly AccessGrant[] = await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>);
    let policyDenied = false;
    for (const perm of perms) {
      const action = perm as PolicyAction;
      const d = decideAccess(grants, action, PERMISSIONS[ACCESS_POLICY_CATALOG[action].basePermission as Permission], { callerUserId: user.userId });
      if (d.allowed) return user;
      if (d.reason !== 'ROLE') policyDenied = true;
    }
    throw policyDenied
      ? new ClinicalError('FORBIDDEN', `Access policy does not permit ${perms.join('|')}`, { reason: 'ACCESS_POLICY' })
      : new ClinicalError('FORBIDDEN', `Missing permission ${perms.join('|')}`);
  }
  private event(
    ctx: TenantContext, action: string, resourceType: string, resourceId: string | null, org: OrganizationId | null, patientId: PatientId | null,
    outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>,
  ): NewAuditEvent {
    return {
      eventId: this.newId() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject }, organizationId: org, action,
      resourceType, resourceId, personId: null, patientId, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async run<T>(ctx: TenantContext, action: string, fn: (repo: PgHandoverRepository) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(
        this.deps.pool,
        async (db) => {
          await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
          return fn(new PgHandoverRepository(db));
        },
        ctx,
      );
    } catch (e) {
      let code = 'INTERNAL';
      let outcome: NewAuditEvent['outcome'] = 'failure';
      if (e instanceof ClinicalError) {
        code = e.code;
        if (e.code === 'FORBIDDEN') outcome = 'denied';
      } else if (e instanceof TenantIsolationError) {
        code = e.code;
        outcome = 'denied';
      }
      const reason = e instanceof ClinicalError && typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
      try {
        await this.deps.audit.record(this.event(ctx, action, 'HandoverTicket', null, null, null, outcome, null, { code, ...(reason ? { reason } : {}) }));
      } catch {
        /* audit lỗi không được thay đổi kết quả */
      }
      throw e;
    }
  }
}
