/**
 * HCOS-F8 | Thu ngân giai đoạn 1 (phòng khám dịch vụ, người bệnh tự trả).
 *
 *  - Bảng giá dịch vụ + cài đặt (tạm ứng mặc định, tài khoản nhận VietQR)            finance:manage
 *  - Ca thu ngân: mở (tiền đầu ca) / đóng (đếm két => DB tự tính phải có + chênh lệch)  finance:collect
 *  - Hồ sơ thanh toán theo lượt đến: chi phí (theo bảng giá, chụp giá), phiếu thu tạm ứng / thanh toán,
 *    phiếu chi hoàn ứng, huỷ phiếu trong ca, đóng hồ sơ khi số dư = 0                     finance:collect
 *  - Xem hồ sơ / báo cáo ca                                                              finance:read
 * Lập phiếu bắt buộc Idempotency-Key (gửi lại sau timeout không thu hai lần).
 * Tiền là số nguyên VND. Quy tắc tiền bạc được ép lại ở DB (migration 012), service chỉ kiểm sớm để báo lỗi rõ.
 */
import { createHash, randomUUID } from 'node:crypto';

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
import { ClinicalError, iso, isoOrNull, num, PgClinicalRepository, translatePgError } from '../clinical/encounter.service';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export type PriceCategory = 'exam' | 'procedure' | 'lab' | 'imaging' | 'drug' | 'other';
export const PRICE_CATEGORIES: readonly PriceCategory[] = ['exam', 'procedure', 'lab', 'imaging', 'drug', 'other'];
export type ReceiptKind = 'deposit' | 'payment' | 'refund';
export type PaymentMethod = 'cash' | 'bank_transfer' | 'card';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'bank_transfer', 'card'];

export interface FinanceSettings {
  readonly organizationId: OrganizationId;
  readonly depositDefault: number;
  readonly bank: { bin: string; account: string; accountName: string } | null;
  readonly version: number;
}
export interface PriceItem {
  readonly itemId: string;
  readonly organizationId: OrganizationId;
  readonly code: string;
  readonly name: string;
  readonly category: PriceCategory;
  readonly unitPrice: number;
  readonly isActive: boolean;
  readonly version: number;
}
export interface Shift {
  readonly shiftId: string;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly userName: string | null;
  readonly status: 'open' | 'closed';
  readonly openingFloat: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly countedCash: number | null;
  readonly expectedCash: number | null;
  readonly cashDifference: number | null;
  readonly closeNote: string | null;
  readonly version: number;
}
export interface ShiftSummary extends Shift {
  /** Tổng phiếu hợp lệ theo hình thức: thu (tạm ứng + thanh toán) và chi (hoàn ứng). */
  readonly totals: Record<PaymentMethod, { in: number; out: number; count: number }>;
  readonly cancelledCount: number;
  /** Tiền mặt phải có hiện tại (ca đang mở) = tiền đầu ca + thu − chi tiền mặt. */
  readonly cashOnHand: number;
}
export interface Charge {
  readonly chargeId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly amount: number;
  readonly status: 'active' | 'voided';
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly voidReason: string | null;
  readonly voidedAt: string | null;
}
export interface Receipt {
  readonly receiptId: string;
  readonly receiptNo: string;
  readonly caseId: string;
  readonly shiftId: string;
  readonly kind: ReceiptKind;
  readonly method: PaymentMethod;
  readonly amount: number;
  readonly reference: string | null;
  readonly payerName: string | null;
  readonly status: 'valid' | 'cancelled';
  readonly createdBy: UserId;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
}
export interface CasePatient {
  readonly patientId: PatientId;
  readonly mrn: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly birthDate: string | null;
}
export interface CaseTotals {
  /** Tổng chi phí còn hiệu lực. */
  readonly charges: number;
  /** Đã thu (tạm ứng + thanh toán, phiếu hợp lệ). */
  readonly received: number;
  /** Đã hoàn ứng (phiếu chi hợp lệ). */
  readonly refunded: number;
  /** Số dư = đã thu − đã hoàn − chi phí. > 0: còn dư (hoàn ứng); < 0: còn phải thu. */
  readonly balance: number;
}
export interface BillingCase {
  readonly caseId: string;
  readonly organizationId: OrganizationId;
  readonly patient: CasePatient;
  readonly status: 'open' | 'closed';
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly version: number;
  readonly totals: CaseTotals;
}
export interface BillingCaseDetail extends BillingCase {
  readonly charges: Charge[];
  readonly receipts: Receipt[];
}
export interface ReceiptInput {
  readonly organizationId: string;
  /** Một trong hai: hồ sơ có sẵn, hoặc bệnh nhân (mở hồ sơ mới nếu chưa có hồ sơ đang mở). */
  readonly caseId?: string | null;
  readonly patientId?: string | null;
  readonly kind: string;
  readonly method: string;
  readonly amount: number;
  readonly reference?: string | null;
  readonly payerName?: string | null;
}
export interface Once<T> {
  readonly value: T;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Quyền
// ---------------------------------------------------------------------------
type Permission = 'finance:read' | 'finance:collect' | 'finance:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  // Lễ tân kiêm thu ngân (clinic_staff) và thu ngân (cashier) đều thu được.
  'finance:collect': ['clinic_staff', 'cashier', 'clinic_admin'],
  'finance:read': ['clinic_staff', 'cashier', 'clinic_admin', 'executive'],
  'finance:manage': ['clinic_admin', 'tenant_admin'],
};
type AllowedDecision = Extract<ReturnType<typeof decideAccess>, { allowed: true }>;
interface Principal { readonly user: User; readonly grants: readonly AccessGrant[] }
interface AuditMeta { action: string; resourceType: string; resourceId?: string | null; patientId?: PatientId | null; organizationId?: OrganizationId | null }

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_AMOUNT = 10_000_000_000;
const money = (v: unknown, field: string, { min = 1, max = MAX_AMOUNT } = {}): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ClinicalError('VALIDATION', `${field} must be an integer VND amount between ${min} and ${max}`, { reason: 'INVALID_AMOUNT' });
  }
  return v;
};
const optText = (v: unknown, field: string, min: number, max: number): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw new ClinicalError('VALIDATION', `${field} must be ${min}-${max} characters`);
  return v.trim().replace(/\s+/g, ' ');
};
const uuidOf = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !isUuid(v)) throw new ClinicalError('VALIDATION', `${field} must be a UUID`);
  return v.toLowerCase();
};
function requestHash(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x !== null && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x as object).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => [k, norm((x as Record<string, unknown>)[k])]))
        : x;
  return createHash('sha256').update(JSON.stringify(norm(v))).digest('hex');
}

/** Lỗi ràng buộc DB (kể cả lỗi ở COMMIT của ràng buộc hoãn) => lỗi nghiệp vụ dễ hiểu; còn lại giữ nguyên. */
function dbError(e: unknown): unknown {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (!err || typeof err !== 'object' || typeof err.code !== 'string') return e;
  if (err.code === '23514' && /refunds .* exceed/.test(err.message ?? '')) return new ClinicalError('CONFLICT', 'Refund exceeds money received', { reason: 'REFUND_EXCEEDS_RECEIVED' });
  if (err.code === '23514' && /non-zero balance/.test(err.message ?? '')) return new ClinicalError('CONFLICT', 'Case balance is not zero', { reason: 'BALANCE_NOT_ZERO' });
  if (err.code === '55000' && /shift .* not open/.test(err.message ?? '')) return new ClinicalError('INVALID_STATE', 'Cashier shift is not open', { reason: 'SHIFT_NOT_OPEN' });
  if (err.code === '55000' && /case .* not open/.test(err.message ?? '')) return new ClinicalError('INVALID_STATE', 'Billing case is not open', { reason: 'CASE_NOT_OPEN' });
  try {
    translatePgError(e);
  } catch (t) {
    return t;
  }
  return e;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
const bool = (v: unknown) => v === true || v === 't';
const n = (v: unknown): number => Number(v);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ITEM_COLS = 'item_id, organization_id, code, name, category, unit_price, is_active, version';
const mapItem = (r: any): PriceItem => ({
  itemId: r.item_id, organizationId: r.organization_id, code: r.code, name: r.name, category: r.category, unitPrice: n(r.unit_price),
  isActive: bool(r.is_active), version: num(r.version),
});
const SHIFT_COLS =
  's.shift_id, s.organization_id, s.user_id, u.display_name AS user_name, s.status, s.opening_float, s.opened_at, s.closed_at, s.counted_cash, ' +
  's.expected_cash, s.cash_difference, s.close_note, s.version';
const mapShift = (r: any): Shift => ({
  shiftId: r.shift_id, organizationId: r.organization_id, userId: r.user_id, userName: r.user_name ?? null, status: r.status,
  openingFloat: n(r.opening_float), openedAt: iso(r.opened_at), closedAt: isoOrNull(r.closed_at), countedCash: nOrNull(r.counted_cash),
  expectedCash: nOrNull(r.expected_cash), cashDifference: nOrNull(r.cash_difference), closeNote: r.close_note ?? null, version: num(r.version),
});
const CHARGE_COLS = 'charge_id, item_id, item_code, description, quantity, unit_price, amount, status, created_by, created_at, void_reason, voided_at';
const mapCharge = (r: any): Charge => ({
  chargeId: r.charge_id, itemId: r.item_id, itemCode: r.item_code, description: r.description, quantity: n(r.quantity), unitPrice: n(r.unit_price),
  amount: n(r.amount), status: r.status, createdBy: r.created_by, createdAt: iso(r.created_at), voidReason: r.void_reason ?? null, voidedAt: isoOrNull(r.voided_at),
});
const RECEIPT_COLS =
  'r.receipt_id, r.receipt_no, r.case_id, r.shift_id, r.kind, r.method, r.amount, r.reference, r.payer_name, r.status, r.created_by, ' +
  'u.display_name AS created_by_name, r.created_at, r.cancel_reason, r.cancelled_at';
const mapReceipt = (r: any): Receipt => ({
  receiptId: r.receipt_id, receiptNo: r.receipt_no, caseId: r.case_id, shiftId: r.shift_id, kind: r.kind, method: r.method, amount: n(r.amount),
  reference: r.reference ?? null, payerName: r.payer_name ?? null, status: r.status, createdBy: r.created_by, createdByName: r.created_by_name ?? null,
  createdAt: iso(r.created_at), cancelReason: r.cancel_reason ?? null, cancelledAt: isoOrNull(r.cancelled_at),
});
const CASE_SELECT = `
  SELECT c.case_id, c.organization_id, c.status, c.opened_at, c.closed_at, c.version,
         pt.patient_id, pt.mrn, ps.family_name, ps.given_name, ps.birth_date::text AS birth_date,
         COALESCE((SELECT sum(ch.amount) FROM finance.charges ch WHERE ch.tenant_id = c.tenant_id AND ch.case_id = c.case_id AND ch.status = 'active'), 0) AS t_charges,
         COALESCE((SELECT sum(r.amount) FROM finance.receipts r WHERE r.tenant_id = c.tenant_id AND r.case_id = c.case_id AND r.status = 'valid' AND r.kind <> 'refund'), 0) AS t_in,
         COALESCE((SELECT sum(r.amount) FROM finance.receipts r WHERE r.tenant_id = c.tenant_id AND r.case_id = c.case_id AND r.status = 'valid' AND r.kind = 'refund'), 0) AS t_out
    FROM finance.billing_cases c
    JOIN patient.patients pt ON pt.tenant_id = c.tenant_id AND pt.patient_id = c.patient_id
    JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id`;
const mapCase = (r: any): BillingCase => {
  const charges = n(r.t_charges);
  const received = n(r.t_in);
  const refunded = n(r.t_out);
  return {
    caseId: r.case_id, organizationId: r.organization_id, status: r.status, openedAt: iso(r.opened_at), closedAt: isoOrNull(r.closed_at), version: num(r.version),
    patient: { patientId: r.patient_id, mrn: r.mrn, familyName: r.family_name, givenName: r.given_name, birthDate: r.birth_date ?? null },
    totals: { charges, received, refunded, balance: received - refunded - charges },
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgFinanceRepository extends PgClinicalRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }

  // ---- cài đặt / bảng giá ----
  async getSettings(org: OrganizationId): Promise<FinanceSettings> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT deposit_default, bank_bin, bank_account, bank_account_name, version FROM finance.settings WHERE tenant_id = $1 AND organization_id = $2`,
      [this.t, org],
    );
    const x = r.rows[0];
    if (!x) return { organizationId: org, depositDefault: 500_000, bank: null, version: 0 };
    return {
      organizationId: org, depositDefault: n(x['deposit_default']), version: num(x['version']),
      bank: x['bank_bin'] ? { bin: x['bank_bin'] as string, account: x['bank_account'] as string, accountName: x['bank_account_name'] as string } : null,
    };
  }
  /** expectedVersion 0 = chưa có bản ghi (tạo mới). */
  async saveSettings(org: OrganizationId, s: { depositDefault: number; bank: FinanceSettings['bank'] }, expectedVersion: number): Promise<boolean> {
    const p = [this.t, org, s.depositDefault, s.bank?.bin ?? null, s.bank?.account ?? null, s.bank?.accountName ?? null];
    if (expectedVersion === 0) {
      const r = await this.db.query(
        `INSERT INTO finance.settings (tenant_id, organization_id, deposit_default, bank_bin, bank_account, bank_account_name)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, organization_id) DO NOTHING RETURNING 1`,
        p,
      );
      return r.rows.length > 0;
    }
    const r = await this.db.query(
      `UPDATE finance.settings SET deposit_default = $3, bank_bin = $4, bank_account = $5, bank_account_name = $6
        WHERE tenant_id = $1 AND organization_id = $2 AND version = $7 RETURNING 1`,
      [...p, expectedVersion],
    );
    return r.rows.length > 0;
  }
  async listPriceItems(org: OrganizationId): Promise<PriceItem[]> {
    const r = await this.db.query(`SELECT ${ITEM_COLS} FROM finance.price_items WHERE tenant_id = $1 AND organization_id = $2 ORDER BY category, code`, [this.t, org]);
    return r.rows.map(mapItem);
  }
  async findPriceItem(id: string): Promise<PriceItem | null> {
    const r = await this.db.query(`SELECT ${ITEM_COLS} FROM finance.price_items WHERE tenant_id = $1 AND item_id = $2`, [this.t, id]);
    return r.rows[0] ? mapItem(r.rows[0]) : null;
  }
  async insertPriceItem(i: PriceItem): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO finance.price_items (item_id, tenant_id, organization_id, code, name, category, unit_price) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [i.itemId, this.t, i.organizationId, i.code, i.name, i.category, i.unitPrice],
      );
    } catch (e) {
      translatePgError(e);
    }
  }
  async updatePriceItem(id: string, f: { name: string; category: PriceCategory; unitPrice: number; isActive: boolean }, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE finance.price_items SET name = $3, category = $4, unit_price = $5, is_active = $6 WHERE tenant_id = $1 AND item_id = $2 AND version = $7 RETURNING 1`,
      [this.t, id, f.name, f.category, f.unitPrice, f.isActive, expectedVersion],
    );
    return r.rows.length > 0;
  }

  // ---- ca ----
  async findOpenShift(org: OrganizationId, userId: UserId): Promise<Shift | null> {
    const r = await this.db.query(
      `SELECT ${SHIFT_COLS} FROM finance.cashier_shifts s JOIN iam.users u ON u.tenant_id = s.tenant_id AND u.user_id = s.user_id
        WHERE s.tenant_id = $1 AND s.organization_id = $2 AND s.user_id = $3 AND s.status = 'open'`,
      [this.t, org, userId],
    );
    return r.rows[0] ? mapShift(r.rows[0]) : null;
  }
  async findShift(id: string): Promise<Shift | null> {
    const r = await this.db.query(
      `SELECT ${SHIFT_COLS} FROM finance.cashier_shifts s JOIN iam.users u ON u.tenant_id = s.tenant_id AND u.user_id = s.user_id
        WHERE s.tenant_id = $1 AND s.shift_id = $2`,
      [this.t, id],
    );
    return r.rows[0] ? mapShift(r.rows[0]) : null;
  }
  async listShifts(org: OrganizationId, from: string, to: string): Promise<Shift[]> {
    const r = await this.db.query(
      `SELECT ${SHIFT_COLS} FROM finance.cashier_shifts s JOIN iam.users u ON u.tenant_id = s.tenant_id AND u.user_id = s.user_id
        WHERE s.tenant_id = $1 AND s.organization_id = $2
          AND (s.opened_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $3::date AND $4::date
        ORDER BY s.opened_at DESC LIMIT 200`,
      [this.t, org, from, to],
    );
    return r.rows.map(mapShift);
  }
  async insertShift(id: string, org: OrganizationId, userId: UserId, openingFloat: number): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO finance.cashier_shifts (shift_id, tenant_id, organization_id, user_id, opening_float) VALUES ($1, $2, $3, $4, $5)`,
        [id, this.t, org, userId, openingFloat],
      );
    } catch (e) {
      translatePgError(e);
    }
  }
  async closeShift(id: string, countedCash: number, note: string | null, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE finance.cashier_shifts SET status = 'closed', counted_cash = $3, close_note = $4
        WHERE tenant_id = $1 AND shift_id = $2 AND status = 'open' AND version = $5 RETURNING 1`,
      [this.t, id, countedCash, note, expectedVersion],
    );
    return r.rows.length > 0;
  }
  async shiftTotals(shiftId: string): Promise<{ totals: ShiftSummary['totals']; cancelledCount: number }> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT method,
              COALESCE(sum(amount) FILTER (WHERE status = 'valid' AND kind <> 'refund'), 0) AS t_in,
              COALESCE(sum(amount) FILTER (WHERE status = 'valid' AND kind = 'refund'), 0) AS t_out,
              count(*) FILTER (WHERE status = 'valid') AS cnt,
              count(*) FILTER (WHERE status = 'cancelled') AS cancelled
         FROM finance.receipts WHERE tenant_id = $1 AND shift_id = $2 GROUP BY method`,
      [this.t, shiftId],
    );
    const totals = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, { in: 0, out: 0, count: 0 }])) as ShiftSummary['totals'];
    let cancelledCount = 0;
    for (const x of r.rows) {
      totals[x['method'] as PaymentMethod] = { in: n(x['t_in']), out: n(x['t_out']), count: n(x['cnt']) };
      cancelledCount += n(x['cancelled']);
    }
    return { totals, cancelledCount };
  }
  async listShiftReceipts(shiftId: string): Promise<Array<Receipt & { patientName: string; mrn: string }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${RECEIPT_COLS}, pt.mrn, ps.family_name || ' ' || ps.given_name AS patient_name
         FROM finance.receipts r
         JOIN iam.users u ON u.tenant_id = r.tenant_id AND u.user_id = r.created_by
         JOIN finance.billing_cases c ON c.tenant_id = r.tenant_id AND c.case_id = r.case_id
         JOIN patient.patients pt ON pt.tenant_id = c.tenant_id AND pt.patient_id = c.patient_id
         JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
        WHERE r.tenant_id = $1 AND r.shift_id = $2 ORDER BY r.created_at`,
      [this.t, shiftId],
    );
    return r.rows.map((x) => ({ ...mapReceipt(x), mrn: x['mrn'] as string, patientName: x['patient_name'] as string }));
  }

  // ---- hồ sơ ----
  async findCase(id: string): Promise<BillingCase | null> {
    const r = await this.db.query(`${CASE_SELECT} WHERE c.tenant_id = $1 AND c.case_id = $2`, [this.t, id]);
    return r.rows[0] ? mapCase(r.rows[0]) : null;
  }
  async findOpenCaseForPatient(org: OrganizationId, patientId: string): Promise<BillingCase | null> {
    const r = await this.db.query(`${CASE_SELECT} WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.patient_id = $3 AND c.status = 'open'`, [this.t, org, patientId]);
    return r.rows[0] ? mapCase(r.rows[0]) : null;
  }
  async listCases(org: OrganizationId, q: { status: 'open' | 'closed'; patientId?: string }): Promise<BillingCase[]> {
    const r = await this.db.query(
      `${CASE_SELECT} WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.status = $3 AND ($4::uuid IS NULL OR c.patient_id = $4::uuid)
        ORDER BY ${q.status === 'open' ? 'c.opened_at' : 'c.closed_at DESC'} LIMIT 200`,
      [this.t, org, q.status, q.patientId ?? null],
    );
    return r.rows.map(mapCase);
  }
  /** Mở hồ sơ mới; trùng (đã có hồ sơ đang mở) => trả null để gọi lại findOpenCaseForPatient. */
  async insertCase(id: string, org: OrganizationId, patientId: string, by: UserId): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO finance.billing_cases (case_id, tenant_id, organization_id, patient_id, opened_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, organization_id, patient_id) WHERE status = 'open' DO NOTHING RETURNING 1`,
      [id, this.t, org, patientId, by],
    );
    return r.rows.length > 0;
  }
  async closeCase(id: string, by: UserId, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE finance.billing_cases SET status = 'closed', closed_by = $3, closed_at = now()
        WHERE tenant_id = $1 AND case_id = $2 AND status = 'open' AND version = $4 RETURNING 1`,
      [this.t, id, by, expectedVersion],
    );
    return r.rows.length > 0;
  }
  async listCharges(caseId: string): Promise<Charge[]> {
    const r = await this.db.query(`SELECT ${CHARGE_COLS} FROM finance.charges WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at`, [this.t, caseId]);
    return r.rows.map(mapCharge);
  }
  async listReceipts(caseId: string): Promise<Receipt[]> {
    const r = await this.db.query(
      `SELECT ${RECEIPT_COLS} FROM finance.receipts r JOIN iam.users u ON u.tenant_id = r.tenant_id AND u.user_id = r.created_by
        WHERE r.tenant_id = $1 AND r.case_id = $2 ORDER BY r.created_at`,
      [this.t, caseId],
    );
    return r.rows.map(mapReceipt);
  }
  async insertCharge(c: { chargeId: string; org: OrganizationId; caseId: string; item: PriceItem; quantity: number; by: UserId }): Promise<void> {
    await this.db.query(
      `INSERT INTO finance.charges (charge_id, tenant_id, organization_id, case_id, item_id, item_code, description, quantity, unit_price, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [c.chargeId, this.t, c.org, c.caseId, c.item.itemId, c.item.code, c.item.name, c.quantity, c.item.unitPrice, c.by],
    );
  }
  async findCharge(id: string): Promise<(Charge & { caseId: string; organizationId: OrganizationId }) | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${CHARGE_COLS}, case_id, organization_id FROM finance.charges WHERE tenant_id = $1 AND charge_id = $2`,
      [this.t, id],
    );
    const x = r.rows[0];
    return x ? { ...mapCharge(x), caseId: x['case_id'] as string, organizationId: x['organization_id'] as OrganizationId } : null;
  }
  async voidCharge(id: string, by: UserId, reason: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE finance.charges SET status = 'voided', voided_by = $3, voided_at = now(), void_reason = $4
        WHERE tenant_id = $1 AND charge_id = $2 AND status = 'active' RETURNING 1`,
      [this.t, id, by, reason],
    );
    return r.rows.length > 0;
  }

  // ---- phiếu ----
  async nextReceiptNo(org: OrganizationId, series: 'PT' | 'PC'): Promise<{ year: number; seq: number }> {
    const r = await this.db.query<Record<string, unknown>>(
      `INSERT INTO finance.receipt_counters (tenant_id, organization_id, series, year, last_no) VALUES ($1, $2, $3, finance.vn_year(), 1)
       ON CONFLICT (tenant_id, organization_id, series, year) DO UPDATE SET last_no = finance.receipt_counters.last_no + 1
       RETURNING year, last_no`,
      [this.t, org, series],
    );
    return { year: n(r.rows[0]!['year']), seq: n(r.rows[0]!['last_no']) };
  }
  async insertReceipt(x: {
    receiptId: string; org: OrganizationId; caseId: string; shiftId: string; kind: ReceiptKind; series: 'PT' | 'PC'; year: number; seq: number;
    method: PaymentMethod; amount: number; reference: string | null; payerName: string | null; by: UserId;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO finance.receipts (receipt_id, tenant_id, organization_id, case_id, shift_id, kind, series, year, seq, method, amount, reference, payer_name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [x.receiptId, this.t, x.org, x.caseId, x.shiftId, x.kind, x.series, x.year, x.seq, x.method, x.amount, x.reference, x.payerName, x.by],
    );
  }
  async findReceipt(id: string): Promise<(Receipt & { organizationId: OrganizationId }) | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${RECEIPT_COLS}, r.organization_id FROM finance.receipts r JOIN iam.users u ON u.tenant_id = r.tenant_id AND u.user_id = r.created_by
        WHERE r.tenant_id = $1 AND r.receipt_id = $2`,
      [this.t, id],
    );
    const x = r.rows[0];
    return x ? { ...mapReceipt(x), organizationId: x['organization_id'] as OrganizationId } : null;
  }
  async cancelReceipt(id: string, by: UserId, reason: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE finance.receipts SET status = 'cancelled', cancelled_by = $3, cancelled_at = now(), cancel_reason = $4
        WHERE tenant_id = $1 AND receipt_id = $2 AND status = 'valid' RETURNING 1`,
      [this.t, id, by, reason],
    );
    return r.rows.length > 0;
  }

  // ---- idempotency (migration 008) ----
  async claimIdempotencyKey(actor: UserId, scope: string, key: string, hash: string): Promise<{ kind: 'claimed' } | { kind: 'existing'; requestHash: string; response: unknown }> {
    const ins = await this.db.query(
      `INSERT INTO platform.idempotency_keys (tenant_id, actor_user_id, scope, idem_key, request_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, actor_user_id, scope, idem_key) DO NOTHING RETURNING 1`,
      [this.t, actor, scope, key, hash],
    );
    if (ins.rows.length > 0) return { kind: 'claimed' };
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT request_hash, response FROM platform.idempotency_keys WHERE tenant_id = $1 AND actor_user_id = $2 AND scope = $3 AND idem_key = $4`,
      [this.t, actor, scope, key],
    );
    const row = r.rows[0];
    if (!row) throw new ClinicalError('CONFLICT', 'Idempotency key could not be claimed', { reason: 'IDEMPOTENCY_IN_PROGRESS' });
    const response = typeof row['response'] === 'string' ? JSON.parse(row['response'] as string) : (row['response'] ?? null);
    return { kind: 'existing', requestHash: row['request_hash'] as string, response };
  }
  async completeIdempotencyKey(actor: UserId, scope: string, key: string, response: unknown): Promise<void> {
    await this.db.query(
      `UPDATE platform.idempotency_keys SET response = $5::jsonb, completed_at = now() WHERE tenant_id = $1 AND actor_user_id = $2 AND scope = $3 AND idem_key = $4`,
      [this.t, actor, scope, key, JSON.stringify(response)],
    );
  }
}

export interface FinanceUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PgFinanceRepository) => Promise<T>): Promise<T>;
}
export class PgFinanceUnitOfWork implements FinanceUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}
  run<T>(ctx: TenantContext, fn: (repo: PgFinanceRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgFinanceRepository(db));
      },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class FinanceService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { uow: FinanceUnitOfWork; audit: AuditSink; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  // ---- cài đặt / bảng giá ----
  async getSettings(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<FinanceSettings> {
    return this.tx(ctx, { action: 'finance.settings.read', resourceType: 'FinanceSettings' }, async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAny(await this.principal(repo, ctx, org), ['finance:collect', 'finance:read', 'finance:manage']);
      return repo.getSettings(org);
    });
  }

  async updateSettings(
    input: { organizationId: string; depositDefault: number; bank: { bin: string; account: string; accountName: string } | null },
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<FinanceSettings> {
    return this.tx(ctx, { action: 'finance.settings.update', resourceType: 'FinanceSettings' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'finance:manage');
      const depositDefault = money(input.depositDefault, 'depositDefault', { min: 0, max: 100_000_000 });
      let bank: FinanceSettings['bank'] = null;
      if (input.bank) {
        const bin = String(input.bank.bin ?? '').trim();
        const account = String(input.bank.account ?? '').trim();
        const accountName = String(input.bank.accountName ?? '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/Đ/g, 'D').replace(/\s+/g, ' ');
        if (!/^\d{6}$/.test(bin)) throw new ClinicalError('VALIDATION', 'Bank BIN must be 6 digits', { reason: 'INVALID_BANK' });
        if (!/^[0-9A-Za-z]{4,19}$/.test(account)) throw new ClinicalError('VALIDATION', 'Bank account must be 4-19 letters/digits', { reason: 'INVALID_BANK' });
        if (!/^[A-Z0-9 ]{2,50}$/.test(accountName)) throw new ClinicalError('VALIDATION', 'Account name must be 2-50 letters', { reason: 'INVALID_BANK' });
        bank = { bin, account, accountName };
      }
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new ClinicalError('VALIDATION', 'Invalid version');
      if (!(await repo.saveSettings(org, { depositDefault, bank }, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Settings version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, { action: 'finance.settings.update', resourceType: 'FinanceSettings', organizationId: org }, 'success', p.user, {
        depositDefault, bankConfigured: bank !== null,
      }));
      return repo.getSettings(org);
    });
  }

  async listPriceItems(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<PriceItem[]> {
    return this.tx(ctx, { action: 'finance.price.list', resourceType: 'PriceItem' }, async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAny(await this.principal(repo, ctx, org), ['finance:collect', 'finance:read', 'finance:manage']);
      return repo.listPriceItems(org);
    });
  }

  async createPriceItem(
    input: { organizationId: string; code: string; name: string; category: string; unitPrice: number },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<PriceItem> {
    return this.tx(ctx, { action: 'finance.price.create', resourceType: 'PriceItem' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'finance:manage');
      const code = String(input.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_.-]{1,19}$/.test(code)) throw new ClinicalError('VALIDATION', 'code must be 2-20 chars A-Z, 0-9, _ . -');
      const v = this.itemFields(input);
      const item: PriceItem = { itemId: randomUUID(), organizationId: org, code, ...v, isActive: true, version: 1 };
      await repo.insertPriceItem(item); // CONFLICT: PRICE_CODE_TAKEN
      await repo.appendAudit(this.event(ctx, { action: 'finance.price.create', resourceType: 'PriceItem', resourceId: item.itemId, organizationId: org }, 'success', p.user, {
        code, unitPrice: v.unitPrice,
      }));
      return item;
    });
  }

  async updatePriceItem(
    itemId: string,
    input: { name: string; category: string; unitPrice: number; isActive: boolean },
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<PriceItem> {
    return this.tx(ctx, { action: 'finance.price.update', resourceType: 'PriceItem', resourceId: itemId }, async (repo) => {
      const cur = await repo.findPriceItem(uuidOf(itemId, 'itemId'));
      if (!cur) throw new ClinicalError('NOT_FOUND', 'Price item not found');
      assertOrganizationAllowed(cur.organizationId, ctx);
      const p = await this.principal(repo, ctx, cur.organizationId);
      this.decide(p, 'finance:manage');
      const v = this.itemFields(input);
      if (typeof input.isActive !== 'boolean') throw new ClinicalError('VALIDATION', 'isActive must be boolean');
      if (!(await repo.updatePriceItem(cur.itemId, { ...v, isActive: input.isActive }, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Price item version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, { action: 'finance.price.update', resourceType: 'PriceItem', resourceId: cur.itemId, organizationId: cur.organizationId }, 'success', p.user, {
        code: cur.code, from: cur.unitPrice, to: v.unitPrice, isActive: input.isActive,
      }));
      return (await repo.findPriceItem(cur.itemId))!;
    });
  }

  // ---- ca ----
  async myShift(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<ShiftSummary | null> {
    return this.tx(ctx, { action: 'finance.shift.read', resourceType: 'CashierShift' }, async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'finance:collect');
      const s = await repo.findOpenShift(org, p.user.userId);
      return s ? this.summary(repo, s) : null;
    });
  }

  async openShift(input: { organizationId: string; openingFloat: number }, ctx: TenantContext = requireTenantContext()): Promise<ShiftSummary> {
    return this.tx(ctx, { action: 'finance.shift.open', resourceType: 'CashierShift' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'finance:collect');
      const openingFloat = money(input.openingFloat, 'openingFloat', { min: 0, max: 1_000_000_000 });
      if (await repo.findOpenShift(org, p.user.userId)) throw new ClinicalError('CONFLICT', 'You already have an open shift', { reason: 'SHIFT_ALREADY_OPEN' });
      const id = randomUUID();
      await repo.insertShift(id, org, p.user.userId, openingFloat); // CONFLICT: SHIFT_ALREADY_OPEN (đồng thời)
      await repo.appendAudit(this.event(ctx, { action: 'finance.shift.open', resourceType: 'CashierShift', resourceId: id, organizationId: org }, 'success', p.user, { openingFloat }));
      return this.summary(repo, (await repo.findShift(id))!);
    });
  }

  async closeShift(shiftId: string, input: { countedCash: number; note?: string | null }, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<ShiftSummary> {
    return this.tx(ctx, { action: 'finance.shift.close', resourceType: 'CashierShift', resourceId: shiftId }, async (repo) => {
      const s = await repo.findShift(uuidOf(shiftId, 'shiftId'));
      if (!s) throw new ClinicalError('NOT_FOUND', 'Shift not found');
      assertOrganizationAllowed(s.organizationId, ctx);
      const p = await this.principal(repo, ctx, s.organizationId);
      this.decide(p, 'finance:collect');
      if (s.userId !== p.user.userId) throw new ClinicalError('FORBIDDEN', 'Only the cashier can close their own shift', { reason: 'NOT_SHIFT_OWNER' });
      if (s.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Shift is already closed', { reason: 'SHIFT_NOT_OPEN' });
      const countedCash = money(input.countedCash, 'countedCash', { min: 0, max: 100_000_000_000 });
      const note = optText(input.note, 'note', 1, 500);
      if (!(await repo.closeShift(s.shiftId, countedCash, note, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Shift version does not match', { reason: 'VERSION_CONFLICT' });
      }
      const closed = (await repo.findShift(s.shiftId))!;
      await repo.appendAudit(this.event(ctx, { action: 'finance.shift.close', resourceType: 'CashierShift', resourceId: s.shiftId, organizationId: s.organizationId }, 'success', p.user, {
        countedCash, expectedCash: closed.expectedCash, difference: closed.cashDifference,
      }));
      return this.summary(repo, closed);
    });
  }

  async getShift(shiftId: string, ctx: TenantContext = requireTenantContext()): Promise<ShiftSummary & { receipts: Array<Receipt & { patientName: string; mrn: string }> }> {
    return this.tx(ctx, { action: 'finance.shift.read', resourceType: 'CashierShift', resourceId: shiftId }, async (repo) => {
      const s = await repo.findShift(uuidOf(shiftId, 'shiftId'));
      if (!s) throw new ClinicalError('NOT_FOUND', 'Shift not found');
      assertOrganizationAllowed(s.organizationId, ctx);
      const p = await this.principal(repo, ctx, s.organizationId);
      // Thu ngân xem ca của mình; xem ca người khác cần quyền báo cáo (quản lý / ban giám đốc).
      if (s.userId === p.user.userId) {
        this.decide(p, 'finance:collect');
      } else {
        this.decideAny(p, ['finance:manage', 'finance:read']);
        this.requireReportRole(p);
      }
      return { ...(await this.summary(repo, s)), receipts: await repo.listShiftReceipts(s.shiftId) };
    });
  }

  async listShifts(q: { organizationId: string; from?: string; to?: string }, ctx: TenantContext = requireTenantContext()): Promise<Shift[]> {
    return this.tx(ctx, { action: 'finance.shift.list', resourceType: 'CashierShift' }, async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decideAny(p, ['finance:manage', 'finance:read']);
      this.requireReportRole(p);
      const today = vnDate(this.clock());
      const from = q.from ?? today;
      const to = q.to ?? from;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ClinicalError('VALIDATION', 'from/to must be YYYY-MM-DD');
      return repo.listShifts(org, from, to);
    });
  }

  // ---- hồ sơ thanh toán ----
  async listCases(q: { organizationId: string; status?: string; patientId?: string }, ctx: TenantContext = requireTenantContext()): Promise<BillingCase[]> {
    return this.tx(ctx, { action: 'finance.case.list', resourceType: 'BillingCase' }, async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      this.decideAny(await this.principal(repo, ctx, org), ['finance:collect', 'finance:read']);
      const status = q.status ?? 'open';
      if (status !== 'open' && status !== 'closed') throw new ClinicalError('VALIDATION', 'status must be open or closed');
      return repo.listCases(org, { status, ...(q.patientId ? { patientId: uuidOf(q.patientId, 'patientId') } : {}) });
    });
  }

  /** Hồ sơ đang mở của bệnh nhân; chưa có thì mở mới. */
  async openCase(input: { organizationId: string; patientId: string }, ctx: TenantContext = requireTenantContext()): Promise<BillingCaseDetail> {
    return this.tx(ctx, { action: 'finance.case.open', resourceType: 'BillingCase' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'finance:collect');
      const c = await this.ensureCase(repo, ctx, p, org, uuidOf(input.patientId, 'patientId'));
      return this.detail(repo, c.caseId);
    });
  }

  async getCase(caseId: string, ctx: TenantContext = requireTenantContext()): Promise<BillingCaseDetail> {
    return this.tx(ctx, { action: 'finance.case.read', resourceType: 'BillingCase', resourceId: caseId }, async (repo) => {
      const c = await this.loadCase(repo, ctx, caseId);
      this.decideAny(await this.principal(repo, ctx, c.organizationId), ['finance:collect', 'finance:read']);
      return this.detail(repo, c.caseId);
    });
  }

  async addCharge(caseId: string, input: { itemId: string; quantity: number }, ctx: TenantContext = requireTenantContext()): Promise<BillingCaseDetail> {
    return this.tx(ctx, { action: 'finance.charge.add', resourceType: 'BillingCase', resourceId: caseId }, async (repo) => {
      const c = await this.loadCase(repo, ctx, caseId);
      const p = await this.principal(repo, ctx, c.organizationId);
      this.decide(p, 'finance:collect');
      if (c.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Billing case is closed', { reason: 'CASE_NOT_OPEN' });
      const item = await repo.findPriceItem(uuidOf(input.itemId, 'itemId'));
      if (!item || item.organizationId !== c.organizationId) throw new ClinicalError('NOT_FOUND', 'Price item not found');
      if (!item.isActive) throw new ClinicalError('VALIDATION', 'Price item is inactive', { reason: 'PRICE_ITEM_INACTIVE' });
      const quantity = input.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new ClinicalError('VALIDATION', 'quantity must be 1-1000');
      const chargeId = randomUUID();
      await repo.insertCharge({ chargeId, org: c.organizationId, caseId: c.caseId, item, quantity, by: p.user.userId });
      await repo.appendAudit(this.event(ctx, { action: 'finance.charge.add', resourceType: 'Charge', resourceId: chargeId, patientId: c.patient.patientId, organizationId: c.organizationId }, 'success', p.user, {
        caseId: c.caseId, itemCode: item.code, quantity, unitPrice: item.unitPrice,
      }));
      return this.detail(repo, c.caseId);
    });
  }

  async voidCharge(chargeId: string, input: { reason: string }, ctx: TenantContext = requireTenantContext()): Promise<BillingCaseDetail> {
    return this.tx(ctx, { action: 'finance.charge.void', resourceType: 'Charge', resourceId: chargeId }, async (repo) => {
      const ch = await repo.findCharge(uuidOf(chargeId, 'chargeId'));
      if (!ch) throw new ClinicalError('NOT_FOUND', 'Charge not found');
      const c = await this.loadCase(repo, ctx, ch.caseId);
      const p = await this.principal(repo, ctx, c.organizationId);
      this.decide(p, 'finance:collect');
      const reason = optText(input.reason, 'reason', 3, 300);
      if (!reason) throw new ClinicalError('VALIDATION', 'reason is required', { reason: 'REASON_REQUIRED' });
      if (c.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Billing case is closed', { reason: 'CASE_NOT_OPEN' });
      if (ch.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Charge already voided', { reason: 'ALREADY_VOIDED' });
      if (!(await repo.voidCharge(ch.chargeId, p.user.userId, reason))) throw new ClinicalError('CONFLICT', 'Charge changed concurrently', { reason: 'ALREADY_VOIDED' });
      await repo.appendAudit(this.event(ctx, { action: 'finance.charge.void', resourceType: 'Charge', resourceId: ch.chargeId, patientId: c.patient.patientId, organizationId: c.organizationId }, 'success', p.user, {
        caseId: c.caseId, amount: ch.amount, reason,
      }));
      return this.detail(repo, c.caseId);
    });
  }

  async closeCase(caseId: string, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<BillingCaseDetail> {
    return this.tx(ctx, { action: 'finance.case.close', resourceType: 'BillingCase', resourceId: caseId }, async (repo) => {
      const c = await this.loadCase(repo, ctx, caseId);
      const p = await this.principal(repo, ctx, c.organizationId);
      this.decide(p, 'finance:collect');
      if (c.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Billing case is already closed', { reason: 'CASE_NOT_OPEN' });
      if (c.totals.balance !== 0) {
        throw new ClinicalError('INVALID_STATE', `Balance must be zero (is ${c.totals.balance})`, { reason: 'BALANCE_NOT_ZERO', balance: c.totals.balance });
      }
      if (!(await repo.closeCase(c.caseId, p.user.userId, expectedVersion))) throw new ClinicalError('CONFLICT', 'Case version does not match', { reason: 'VERSION_CONFLICT' });
      await repo.appendAudit(this.event(ctx, { action: 'finance.case.close', resourceType: 'BillingCase', resourceId: c.caseId, patientId: c.patient.patientId, organizationId: c.organizationId }, 'success', p.user, {
        charges: c.totals.charges, received: c.totals.received, refunded: c.totals.refunded,
      }));
      return this.detail(repo, c.caseId);
    });
  }

  /**
   * Lập phiếu thu (tạm ứng / thanh toán) hoặc phiếu chi (hoàn ứng) trong ca đang mở của người gọi.
   * Gửi lại cùng Idempotency-Key + cùng nội dung => trả đúng phiếu cũ, không thu lần hai.
   */
  async createReceipt(input: ReceiptInput, idempotencyKey: string, ctx: TenantContext = requireTenantContext()): Promise<Once<{ receipt: Receipt; case: BillingCaseDetail }>> {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new ClinicalError('VALIDATION', 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]', { reason: 'INVALID_IDEMPOTENCY_KEY' });
    }
    return this.tx(ctx, { action: 'finance.receipt.create', resourceType: 'Receipt' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'finance:collect');

      const scope = 'finance.receipt.create';
      const hash = requestHash(input);
      const claim = await repo.claimIdempotencyKey(p.user.userId, scope, idempotencyKey, hash);
      if (claim.kind === 'existing') {
        if (claim.requestHash !== hash) throw new ClinicalError('VALIDATION', 'Idempotency-Key was already used with a different request', { reason: 'IDEMPOTENCY_KEY_REUSED' });
        if (claim.response === null) throw new ClinicalError('CONFLICT', 'A request with this Idempotency-Key is still in progress', { reason: 'IDEMPOTENCY_IN_PROGRESS' });
        await repo.appendAudit(this.event(ctx, { action: scope, resourceType: 'Receipt', organizationId: org }, 'success', p.user, { idempotentReplay: true }));
        return { value: claim.response as { receipt: Receipt; case: BillingCaseDetail }, replayed: true };
      }

      const kind = input.kind as ReceiptKind;
      if (!['deposit', 'payment', 'refund'].includes(kind)) throw new ClinicalError('VALIDATION', 'kind must be deposit, payment or refund');
      const method = input.method as PaymentMethod;
      if (!PAYMENT_METHODS.includes(method)) throw new ClinicalError('VALIDATION', 'method must be cash, bank_transfer or card');
      const amount = money(input.amount, 'amount');
      const reference = optText(input.reference, 'reference', 4, 100);
      if (method !== 'cash' && !reference) {
        throw new ClinicalError('VALIDATION', 'Bank transfer / card requires a reference (transfer note or POS approval code)', { reason: 'REFERENCE_REQUIRED' });
      }
      const payerName = optText(input.payerName, 'payerName', 2, 200);
      const shift = await repo.findOpenShift(org, p.user.userId);
      if (!shift) throw new ClinicalError('INVALID_STATE', 'Open a cashier shift first', { reason: 'NO_OPEN_SHIFT' });

      let c: BillingCase;
      if (input.caseId) {
        c = await this.loadCase(repo, ctx, input.caseId);
        if (c.organizationId !== org) throw new ClinicalError('VALIDATION', 'Case belongs to another organization');
      } else if (input.patientId) {
        if (kind === 'refund') throw new ClinicalError('VALIDATION', 'Refund needs an existing case');
        c = await this.ensureCase(repo, ctx, p, org, uuidOf(input.patientId, 'patientId'));
      } else {
        throw new ClinicalError('VALIDATION', 'caseId or patientId is required');
      }
      if (c.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Billing case is closed', { reason: 'CASE_NOT_OPEN' });
      // Kiểm sớm cho thông báo rõ; DB ép lại "hoàn không vượt đã thu" ở cuối transaction.
      if (kind === 'payment' && amount > -c.totals.balance) {
        throw new ClinicalError('VALIDATION', `Payment exceeds amount due (${Math.max(0, -c.totals.balance)})`, { reason: 'PAYMENT_EXCEEDS_DUE', due: Math.max(0, -c.totals.balance) });
      }
      if (kind === 'refund' && amount > c.totals.balance) {
        throw new ClinicalError('VALIDATION', `Refund exceeds credit (${Math.max(0, c.totals.balance)})`, { reason: 'REFUND_EXCEEDS_CREDIT', credit: Math.max(0, c.totals.balance) });
      }

      const series = kind === 'refund' ? 'PC' : 'PT';
      const { year, seq } = await repo.nextReceiptNo(org, series);
      const receiptId = randomUUID();
      await repo.insertReceipt({ receiptId, org, caseId: c.caseId, shiftId: shift.shiftId, kind, series, year, seq, method, amount, reference, payerName, by: p.user.userId });
      const receipt = (await repo.findReceipt(receiptId))!;
      const { organizationId: _o, ...plain } = receipt;
      const value = { receipt: plain as Receipt, case: await this.detail(repo, c.caseId) };
      await repo.completeIdempotencyKey(p.user.userId, scope, idempotencyKey, JSON.parse(JSON.stringify(value)));
      await repo.appendAudit(this.event(ctx, { action: scope, resourceType: 'Receipt', resourceId: receiptId, patientId: c.patient.patientId, organizationId: org }, 'success', p.user, {
        receiptNo: receipt.receiptNo, kind, method, amount, caseId: c.caseId, shiftId: shift.shiftId,
      }));
      return { value, replayed: false };
    });
  }

  async cancelReceipt(receiptId: string, input: { reason: string }, ctx: TenantContext = requireTenantContext()): Promise<BillingCaseDetail> {
    return this.tx(ctx, { action: 'finance.receipt.cancel', resourceType: 'Receipt', resourceId: receiptId }, async (repo) => {
      const r = await repo.findReceipt(uuidOf(receiptId, 'receiptId'));
      if (!r) throw new ClinicalError('NOT_FOUND', 'Receipt not found');
      const c = await this.loadCase(repo, ctx, r.caseId);
      const p = await this.principal(repo, ctx, c.organizationId);
      this.decide(p, 'finance:collect');
      const reason = optText(input.reason, 'reason', 5, 300);
      if (!reason) throw new ClinicalError('VALIDATION', 'reason is required', { reason: 'REASON_REQUIRED' });
      if (r.status !== 'valid') throw new ClinicalError('INVALID_STATE', 'Receipt already cancelled', { reason: 'ALREADY_CANCELLED' });
      if (r.createdBy !== p.user.userId) throw new ClinicalError('FORBIDDEN', 'Only the cashier who made the receipt can cancel it', { reason: 'NOT_SHIFT_OWNER' });
      const shift = await repo.findShift(r.shiftId);
      if (shift?.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Receipt shift is closed', { reason: 'SHIFT_NOT_OPEN' });
      if (c.status !== 'open') throw new ClinicalError('INVALID_STATE', 'Billing case is closed', { reason: 'CASE_NOT_OPEN' });
      if (!(await repo.cancelReceipt(r.receiptId, p.user.userId, reason))) throw new ClinicalError('CONFLICT', 'Receipt changed concurrently', { reason: 'ALREADY_CANCELLED' });
      await repo.appendAudit(this.event(ctx, { action: 'finance.receipt.cancel', resourceType: 'Receipt', resourceId: r.receiptId, patientId: c.patient.patientId, organizationId: c.organizationId }, 'success', p.user, {
        receiptNo: r.receiptNo, amount: r.amount, reason,
      }));
      return this.detail(repo, c.caseId);
    });
  }

  // ---- nội bộ ----
  private itemFields(input: { name: string; category: string; unitPrice: number }): { name: string; category: PriceCategory; unitPrice: number } {
    const name = optText(input.name, 'name', 2, 200);
    if (!name) throw new ClinicalError('VALIDATION', 'name is required');
    if (!PRICE_CATEGORIES.includes(input.category as PriceCategory)) throw new ClinicalError('VALIDATION', 'Unknown category');
    return { name, category: input.category as PriceCategory, unitPrice: money(input.unitPrice, 'unitPrice', { min: 0, max: 1_000_000_000 }) };
  }
  private async ensureCase(repo: PgFinanceRepository, ctx: TenantContext, p: Principal, org: OrganizationId, patientId: string): Promise<BillingCase> {
    const patient = await repo.findPatient(patientId as PatientId);
    if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
    assertSameTenant(patient, ctx);
    if (patient.organizationId !== org) throw new ClinicalError('VALIDATION', 'Patient is not registered at this organization', { reason: 'PATIENT_ORG_MISMATCH' });
    const existing = await repo.findOpenCaseForPatient(org, patientId);
    if (existing) return existing;
    const id = randomUUID();
    if (await repo.insertCase(id, org, patientId, p.user.userId)) {
      await repo.appendAudit(this.event(ctx, { action: 'finance.case.open', resourceType: 'BillingCase', resourceId: id, patientId: patientId as PatientId, organizationId: org }, 'success', p.user, {}));
    }
    // Trùng (người khác vừa mở cùng lúc) => dùng hồ sơ đang mở đó.
    const c = await repo.findOpenCaseForPatient(org, patientId);
    if (!c) throw new ClinicalError('CONFLICT', 'Could not open billing case', { reason: 'CASE_CONFLICT' });
    return c;
  }
  private async detail(repo: PgFinanceRepository, caseId: string): Promise<BillingCaseDetail> {
    const c = (await repo.findCase(caseId))!;
    return { ...c, charges: await repo.listCharges(caseId), receipts: await repo.listReceipts(caseId) };
  }
  private async summary(repo: PgFinanceRepository, s: Shift): Promise<ShiftSummary> {
    const { totals, cancelledCount } = await repo.shiftTotals(s.shiftId);
    return { ...s, totals, cancelledCount, cashOnHand: s.openingFloat + totals.cash.in - totals.cash.out };
  }
  private async loadCase(repo: PgFinanceRepository, ctx: TenantContext, id: string): Promise<BillingCase> {
    const c = await repo.findCase(uuidOf(id, 'caseId'));
    if (!c) throw new ClinicalError('NOT_FOUND', 'Billing case not found');
    assertOrganizationAllowed(c.organizationId, ctx);
    return c;
  }
  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    const org = uuidOf(raw, 'organization') as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  /** Xem ca của người khác: quản lý / ban giám đốc (lễ tân, thu ngân chỉ xem ca của mình). */
  private requireReportRole(p: Principal): void {
    // grants đã lọc theo cơ sở đang xét (principal()).
    const ok = p.grants.some((g) => ['clinic_admin', 'executive', 'tenant_admin'].includes(g.role));
    if (!ok) throw new ClinicalError('FORBIDDEN', 'Viewing other cashiers\' shifts requires a manager role', { reason: 'REPORT_ROLE' });
  }
  private async principal(repo: PgFinanceRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) =>
        (m.organizationId === organizationId || m.role === 'tenant_admin') && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return { user, grants: await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>) };
  }
  private decide(p: Principal, action: PolicyAction): AllowedDecision {
    const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
    const d = decideAccess(p.grants, action, PERMISSIONS[perm], { callerUserId: p.user.userId });
    if (!d.allowed) {
      if (d.reason === 'ROLE') throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
      throw new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
    }
    return d;
  }
  private decideAny(p: Principal, actions: PolicyAction[]): AllowedDecision {
    let last: unknown;
    for (const a of actions) {
      try {
        return this.decide(p, a);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
  private event(ctx: TenantContext, meta: AuditMeta, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: meta.organizationId ?? null, action: meta.action, resourceType: meta.resourceType, resourceId: meta.resourceId ?? null,
      personId: null, patientId: meta.patientId ?? null, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: PgFinanceRepository) => Promise<T>): Promise<T> {
    try {
      return await this.deps.uow.run(ctx, fn);
    } catch (raw) {
      const e = dbError(raw);
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
        await this.deps.audit.record(this.event(ctx, meta, outcome, null, { code, ...(reason ? { reason } : {}) }));
      } catch {
        /* audit lỗi không đổi kết quả */
      }
      throw e;
    }
  }
}

const vnDate = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
