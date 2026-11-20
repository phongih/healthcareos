/**
 * HCOS-F10 | Dự báo kinh doanh — xác định / thống kê, giải thích được, không dùng mô hình học máy.
 *
 *  1. Tải phòng khám 7–30 ngày tới, theo ngày × buổi × phòng:
 *       khách vãng lai (trung bình theo thứ trong tuần × buổi, 8 tuần gần nhất, đã loại khách đặt lịch và khách tái khám)
 *     + khách đặt lịch (max(lịch đã đặt × tỷ lệ đến, trung bình lịch sử cùng thứ × buổi))
 *     + tái khám dự kiến (đơn thuốc kết thúc trong khoảng [-1, +7] ngày × tỷ lệ quay lại thực tế, rải đều 9 ngày).
 *     So với sức khám tối đa mỗi buổi của phòng => cảnh báo "sắp đầy" (≥ 85%) / "quá tải" (> 100%).
 *  2. Điểm đặt hàng lại thuốc (ROP): tiêu thụ trung bình ngày (sổ cái cấp phát, ≤ 30 ngày) × hệ số xu hướng chẩn đoán ICD-10
 *     (7 ngày gần nhất so với 21 ngày trước, của các mã bệnh mà thuốc đó được kê) => ROP = d×L + z×σ×√L;
 *     lượng đặt gợi ý đưa tồn về d×(L+14) + tồn an toàn; cảnh báo hàng có thể hết hạn trước khi dùng hết (FEFO).
 *  3. Cơ sở cho dòng tiền 30 ngày + mô phỏng What-If (tính ở client): số lượt dự báo, doanh thu trung bình / lượt,
 *     tỷ trọng phí khám, chi phí cố định / tháng, % chi phí biến đổi.
 * Mọi tham số tự ước từ dữ liệu đều trả kèm "nguồn" (dữ liệu / mặc định) và cờ đủ dữ liệu.
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
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
} from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import { assertOrganizationAllowed, assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, PgClinicalRepository } from '../clinical/encounter.service';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export type Period = 'morning' | 'afternoon';
const PERIODS: readonly Period[] = ['morning', 'afternoon'];
export type Source = 'data' | 'default';

export interface ForecastSettings {
  readonly fixedCostsMonthly: number;
  readonly variableCostPct: number;
  readonly leadTimeDays: number;
  readonly serviceLevelPct: 90 | 95 | 97.5 | 99;
  readonly version: number;
  readonly updatedAt: string | null;
}
export interface ForecastSettingsHistory extends Omit<ForecastSettings, 'updatedAt'> {
  readonly changedByName: string | null;
  readonly changedAt: string;
}
export interface LoadCell {
  readonly servicePointId: string | null;
  readonly walkIn: number;
  /** Lịch đã đặt (chưa nhân tỷ lệ đến). */
  readonly bookedRaw: number;
  readonly booked: number;
  readonly followUp: number;
  readonly total: number;
  readonly capacity: number | null;
  /** total / capacity; null nếu phòng chưa khai báo sức khám. */
  readonly utilization: number | null;
  readonly status: 'ok' | 'busy' | 'overload' | 'unknown';
}
export interface LoadDay {
  readonly date: string;
  readonly weekday: number;
  readonly periods: Record<Period, LoadCell[]>;
  readonly total: number;
  readonly worst: LoadCell['status'];
}
export interface LoadForecast {
  readonly from: string;
  readonly to: string;
  readonly rooms: Array<{ servicePointId: string; code: string; name: string; visitCapacity: number | null; version: number }>;
  readonly days: LoadDay[];
  readonly alerts: Array<{ date: string; period: Period; servicePointId: string | null; code: string; total: number; capacity: number; utilization: number; status: 'busy' | 'overload' }>;
  /** Hệ số theo thứ (0 = Chủ nhật): trung bình lượt / ngày của thứ đó ÷ trung bình chung. */
  readonly weekdayIndex: number[];
  readonly params: {
    readonly historyDays: number;
    readonly sufficient: boolean;
    readonly showRate: number; readonly showRateSource: Source; readonly showRateSample: number;
    readonly returnRate: number; readonly returnRateSource: Source; readonly returnRateSample: number;
    readonly morningShare: number;
    readonly avgDailyVisits: number;
  };
  readonly totals: { readonly walkIn: number; readonly booked: number; readonly followUp: number; readonly total: number };
}
export interface InventoryLine {
  readonly medicationId: string;
  readonly name: string;
  readonly unit: string;
  readonly available: number;
  readonly avgDaily: number;
  readonly trendFactor: number;
  readonly trendCodes: Array<{ code: string; ratio: number }>;
  readonly adjustedDaily: number;
  readonly sigmaDaily: number;
  readonly safetyStock: number;
  readonly reorderPoint: number;
  readonly targetLevel: number;
  readonly suggestedOrder: number;
  readonly estimatedOrderValue: number | null;
  readonly daysOfCover: number | null;
  readonly earliestExpiry: string | null;
  readonly expiryRiskQty: number;
  readonly status: 'stockout' | 'urgent' | 'reorder' | 'ok' | 'no_demand';
}
export interface InventoryForecast {
  readonly asOf: string;
  readonly params: { readonly windowDays: number; readonly sufficient: boolean; readonly leadTimeDays: number; readonly serviceLevelPct: number; readonly z: number; readonly reviewDays: number };
  readonly lines: InventoryLine[];
  readonly risingCodes: Array<{ code: string; display: string | null; last7: number; prior21: number; ratio: number }>;
}
export interface CashflowBase {
  readonly horizonDays: number;
  readonly visits: number;
  readonly walkIn: number;
  readonly followUp: number;
  readonly booked: number;
  readonly showRate: number;
  /** Doanh thu dịch vụ trung bình / hồ sơ có chi phí (30 ngày gần nhất); null nếu chưa có dữ liệu. */
  readonly revenuePerVisit: number | null;
  readonly revenueSample: number;
  /** Tỷ lệ hồ sơ có phí khám và giá khám trung bình (để mô phỏng đổi phí khám). */
  readonly examShare: number;
  readonly avgExamPrice: number | null;
  readonly actualVisitsLast30: number;
  readonly actualRevenueLast30: number;
  readonly fixedCostsMonthly: number;
  readonly variableCostPct: number;
}

// ---------------------------------------------------------------------------
// Hàm thuần (test được, không cần DB)
// ---------------------------------------------------------------------------
const TZ = 'Asia/Ho_Chi_Minh';
export const vnDate = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
export const addDays = (date: string, n: number): string => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
export const Z: Record<number, number> = { 90: 1.2816, 95: 1.6449, 97.5: 1.96, 99: 2.3263 };

/** Số lần mỗi thứ (0..6) xuất hiện trong [from, to]. */
export function weekdayCounts(from: string, to: string): number[] {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (let d = from; d <= to; d = addDays(d, 1)) c[weekdayOf(d)]!++;
  return c;
}

export function loadStatus(total: number, capacity: number | null): LoadCell['status'] {
  if (!capacity) return 'unknown';
  const u = total / capacity;
  return u > 1 ? 'overload' : u >= 0.85 ? 'busy' : 'ok';
}

/** Hệ số xu hướng một mã bệnh: (7 ngày gần nhất + 1) / (trung bình tuần của 21 ngày trước + 1), kẹp [0.5, 2]. */
export const trendRatio = (last7: number, prior21: number): number => Math.min(2, Math.max(0.5, (last7 + 1) / (prior21 / 3 + 1)));

/** Lượng có thể hết hạn trước khi dùng hết, giả định dùng đều `daily`/ngày theo FEFO. */
export function expiryRisk(batches: ReadonlyArray<{ expiry: string; qty: number }>, daily: number, today: string): number {
  let used = 0;
  let waste = 0;
  for (const b of [...batches].sort((a, c) => a.expiry.localeCompare(c.expiry))) {
    const days = Math.max(0, (Date.parse(`${b.expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const canUse = Math.max(0, daily * days - used);
    const u = Math.min(b.qty, canUse);
    waste += b.qty - u;
    used += u;
  }
  return Math.round(waste);
}

export function reorderLine(x: {
  available: number; daily: number[]; trendFactor: number; leadTimeDays: number; z: number; reviewDays: number;
}): Pick<InventoryLine, 'avgDaily' | 'adjustedDaily' | 'sigmaDaily' | 'safetyStock' | 'reorderPoint' | 'targetLevel' | 'suggestedOrder' | 'daysOfCover' | 'status'> {
  const n = x.daily.length || 1;
  const mean = x.daily.reduce((a, b) => a + b, 0) / n;
  const sigma = Math.sqrt(x.daily.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const d = mean * x.trendFactor;
  const ss = x.z * sigma * x.trendFactor * Math.sqrt(x.leadTimeDays);
  const rop = d * x.leadTimeDays + ss;
  const target = d * (x.leadTimeDays + x.reviewDays) + ss;
  const cover = d > 0 ? x.available / d : null;
  const status: InventoryLine['status'] =
    d <= 0 ? 'no_demand' : x.available <= 0 ? 'stockout' : cover !== null && cover < x.leadTimeDays ? 'urgent' : x.available <= rop ? 'reorder' : 'ok';
  const suggested = status === 'reorder' || status === 'urgent' || status === 'stockout' ? Math.ceil(Math.max(0, target - x.available)) : 0;
  return {
    avgDaily: r2(mean), adjustedDaily: r2(d), sigmaDaily: r2(sigma), safetyStock: Math.ceil(ss), reorderPoint: Math.ceil(rop),
    targetLevel: Math.ceil(target), suggestedOrder: suggested, daysOfCover: cover === null ? null : r1(cover), status,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
const n = (v: unknown): number => Number(v);
export class PgForecastRepository extends PgClinicalRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }
  async getSettings(org: OrganizationId): Promise<ForecastSettings> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT fixed_costs_monthly, variable_cost_pct, lead_time_days, service_level_pct, version, updated_at
         FROM finance.forecast_settings WHERE tenant_id = $1 AND organization_id = $2`,
      [this.t, org],
    );
    const x = r.rows[0];
    if (!x) return { fixedCostsMonthly: 0, variableCostPct: 0, leadTimeDays: 3, serviceLevelPct: 95, version: 0, updatedAt: null };
    return {
      fixedCostsMonthly: n(x['fixed_costs_monthly']), variableCostPct: n(x['variable_cost_pct']), leadTimeDays: n(x['lead_time_days']),
      serviceLevelPct: n(x['service_level_pct']) as ForecastSettings['serviceLevelPct'], version: n(x['version']),
      updatedAt: x['updated_at'] instanceof Date ? (x['updated_at'] as Date).toISOString() : String(x['updated_at']),
    };
  }
  async saveSettings(org: OrganizationId, s: Omit<ForecastSettings, 'version' | 'updatedAt'>, by: string, expectedVersion: number): Promise<boolean> {
    const p = [this.t, org, s.fixedCostsMonthly, s.variableCostPct, s.leadTimeDays, s.serviceLevelPct, by];
    const r =
      expectedVersion === 0
        ? await this.db.query(
            `INSERT INTO finance.forecast_settings (tenant_id, organization_id, fixed_costs_monthly, variable_cost_pct, lead_time_days, service_level_pct, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, organization_id) DO NOTHING RETURNING 1`,
            p,
          )
        : await this.db.query(
            `UPDATE finance.forecast_settings SET fixed_costs_monthly = $3, variable_cost_pct = $4, lead_time_days = $5, service_level_pct = $6, updated_by = $7
              WHERE tenant_id = $1 AND organization_id = $2 AND version = $8 RETURNING 1`,
            [...p, expectedVersion],
          );
    return r.rows.length > 0;
  }
  async settingsHistory(org: OrganizationId): Promise<ForecastSettingsHistory[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT h.version, h.fixed_costs_monthly, h.variable_cost_pct, h.lead_time_days, h.service_level_pct, u.display_name, h.changed_at
         FROM finance.forecast_settings_history h LEFT JOIN iam.users u ON u.tenant_id = h.tenant_id AND u.user_id = h.changed_by
        WHERE h.tenant_id = $1 AND h.organization_id = $2 ORDER BY h.version DESC LIMIT 50`,
      [this.t, org],
    );
    return r.rows.map((x) => ({
      version: n(x['version']), fixedCostsMonthly: n(x['fixed_costs_monthly']), variableCostPct: n(x['variable_cost_pct']), leadTimeDays: n(x['lead_time_days']),
      serviceLevelPct: n(x['service_level_pct']) as ForecastSettings['serviceLevelPct'], changedByName: (x['display_name'] as string | null) ?? null,
      changedAt: x['changed_at'] instanceof Date ? (x['changed_at'] as Date).toISOString() : String(x['changed_at']),
    }));
  }
  async rooms(org: OrganizationId): Promise<LoadForecast['rooms']> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT service_point_id, code, name, visit_capacity, version FROM clinical.service_points
        WHERE tenant_id = $1 AND organization_id = $2 AND is_active ORDER BY code`,
      [this.t, org],
    );
    return r.rows.map((x) => ({
      servicePointId: x['service_point_id'] as string, code: x['code'] as string, name: x['name'] as string,
      visitCapacity: x['visit_capacity'] === null ? null : n(x['visit_capacity']), version: n(x['version']),
    }));
  }
  async findRoom(id: string): Promise<{ organizationId: OrganizationId; version: number } | null> {
    const r = await this.db.query<Record<string, unknown>>(`SELECT organization_id, version FROM clinical.service_points WHERE tenant_id = $1 AND service_point_id = $2`, [this.t, id]);
    const x = r.rows[0];
    return x ? { organizationId: x['organization_id'] as OrganizationId, version: n(x['version']) } : null;
  }
  async setVisitCapacity(id: string, capacity: number | null, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE clinical.service_points SET visit_capacity = $3 WHERE tenant_id = $1 AND service_point_id = $2 AND version = $4 RETURNING 1`,
      [this.t, id, capacity, expectedVersion],
    );
    return r.rows.length > 0;
  }

  /** Lượt khám lịch sử (đợt khám ngoại trú / cấp cứu) gộp theo ngày × buổi × phòng × (đặt lịch?) × (tái khám?). */
  async visitHistory(org: OrganizationId, from: string, to: string): Promise<Array<{ date: string; period: Period; sp: string | null; booked: boolean; followUp: boolean; count: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `WITH v AS (
         SELECT e.encounter_id, e.patient_id, (e.period_start AT TIME ZONE '${TZ}') AS lt,
                (SELECT t.service_point_id FROM clinical.queue_tickets t WHERE t.tenant_id = e.tenant_id AND t.encounter_id = e.encounter_id LIMIT 1) AS sp,
                EXISTS (SELECT 1 FROM clinical.queue_tickets t JOIN clinical.bookings b ON b.tenant_id = t.tenant_id AND b.ticket_id = t.ticket_id
                         WHERE t.tenant_id = e.tenant_id AND t.encounter_id = e.encounter_id) AS booked
           FROM clinical.encounters e
          WHERE e.tenant_id = $1 AND e.organization_id = $2 AND e.encounter_class IN ('ambulatory', 'emergency')
            AND e.status NOT IN ('cancelled', 'entered_in_error')
            AND (e.period_start AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date)
       SELECT v.lt::date::text AS d, CASE WHEN extract(hour FROM v.lt) < 12 THEN 'morning' ELSE 'afternoon' END AS period, v.sp, v.booked,
              EXISTS (
                SELECT 1 FROM clinical.prescriptions p JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
                 WHERE p.tenant_id = $1 AND p.patient_id = v.patient_id AND p.status NOT IN ('cancelled', 'entered_in_error')
                   AND p.encounter_id <> v.encounter_id AND p.prescribed_at < v.lt AT TIME ZONE '${TZ}'
                 GROUP BY p.prescription_id, p.prescribed_at
                HAVING v.lt::date - ((p.prescribed_at AT TIME ZONE '${TZ}')::date + max(i.duration_days)) BETWEEN -1 AND 7
              ) AS follow_up,
              count(*) AS cnt
         FROM v GROUP BY 1, 2, 3, 4, 5`,
      [this.t, org, from, to],
    );
    return r.rows.map((x) => ({
      date: x['d'] as string, period: x['period'] as Period, sp: (x['sp'] as string | null) ?? null,
      booked: x['booked'] === true || x['booked'] === 't', followUp: x['follow_up'] === true || x['follow_up'] === 't', count: n(x['cnt']),
    }));
  }
  /** Tỷ lệ đến của lịch hẹn đã qua (đã check-in / (check-in + vắng + còn "booked" sau ngày hẹn)), bỏ lịch huỷ. */
  async bookingShow(org: OrganizationId, from: string, to: string): Promise<{ shown: number; total: number }> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT count(*) FILTER (WHERE status = 'checked_in') AS shown, count(*) FILTER (WHERE status <> 'cancelled') AS total
         FROM clinical.bookings WHERE tenant_id = $1 AND organization_id = $2 AND visit_date BETWEEN $3::date AND $4::date`,
      [this.t, org, from, to],
    );
    return { shown: n(r.rows[0]!['shown']), total: n(r.rows[0]!['total']) };
  }
  async futureBookings(org: OrganizationId, from: string, to: string): Promise<Array<{ date: string; period: Period; sp: string; count: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT visit_date::text AS d, period, service_point_id, count(*) AS cnt FROM clinical.bookings
        WHERE tenant_id = $1 AND organization_id = $2 AND status = 'booked' AND visit_date BETWEEN $3::date AND $4::date GROUP BY 1, 2, 3`,
      [this.t, org, from, to],
    );
    return r.rows.map((x) => ({ date: x['d'] as string, period: x['period'] as Period, sp: x['service_point_id'] as string, count: n(x['cnt']) }));
  }
  /** Đơn thuốc với ngày kết thúc (ngày kê + số ngày dài nhất), phòng của lượt khám kê đơn, và đã quay lại chưa. */
  async prescriptionEnds(org: OrganizationId, from: string, to: string): Promise<Array<{ end: string; sp: string | null; returned: boolean }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `WITH p AS (
         SELECT p.prescription_id, p.patient_id, p.encounter_id,
                ((p.prescribed_at AT TIME ZONE '${TZ}')::date + max(i.duration_days)) AS end_date
           FROM clinical.prescriptions p JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
          WHERE p.tenant_id = $1 AND p.organization_id = $2 AND p.status NOT IN ('cancelled', 'entered_in_error')
          GROUP BY p.prescription_id, p.patient_id, p.encounter_id, p.prescribed_at)
       SELECT p.end_date::text AS end_date,
              (SELECT t.service_point_id FROM clinical.queue_tickets t WHERE t.tenant_id = $1 AND t.encounter_id = p.encounter_id LIMIT 1) AS sp,
              EXISTS (SELECT 1 FROM clinical.encounters e WHERE e.tenant_id = $1 AND e.patient_id = p.patient_id AND e.encounter_id <> p.encounter_id
                        AND e.status NOT IN ('cancelled', 'entered_in_error')
                        AND (e.period_start AT TIME ZONE '${TZ}')::date BETWEEN p.end_date - 1 AND p.end_date + 7) AS returned
         FROM p WHERE p.end_date BETWEEN $3::date AND $4::date`,
      [this.t, org, from, to],
    );
    return r.rows.map((x) => ({ end: x['end_date'] as string, sp: (x['sp'] as string | null) ?? null, returned: x['returned'] === true || x['returned'] === 't' }));
  }

  // ---- tồn kho ----
  async stockBatches(org: OrganizationId, today: string): Promise<Array<{ medicationId: string; expiry: string; qty: number; unitCost: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT b.medication_id, b.expiry_date::text AS expiry, sum(ib.quantity_on_hand - ib.quantity_reserved) AS qty, max(b.unit_cost) AS unit_cost
         FROM pharmacy.inventory_balances ib
         JOIN pharmacy.stock_locations l ON l.location_id = ib.location_id AND l.tenant_id = ib.tenant_id
         JOIN pharmacy.batches b ON b.batch_id = ib.batch_id AND b.tenant_id = ib.tenant_id
        WHERE ib.tenant_id = $1 AND l.organization_id = $2 AND l.is_active AND l.type <> 'quarantine' AND b.expiry_date > $3::date
        GROUP BY b.medication_id, b.expiry_date HAVING sum(ib.quantity_on_hand - ib.quantity_reserved) > 0`,
      [this.t, org, today],
    );
    return r.rows.map((x) => ({ medicationId: x['medication_id'] as string, expiry: x['expiry'] as string, qty: n(x['qty']), unitCost: n(x['unit_cost']) }));
  }
  async dispensedDaily(org: OrganizationId, from: string, to: string): Promise<Array<{ medicationId: string; date: string; qty: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT b.medication_id, (m.occurred_at AT TIME ZONE '${TZ}')::date::text AS d, sum(m.quantity) AS qty
         FROM pharmacy.stock_movements m
         JOIN pharmacy.stock_locations l ON l.location_id = m.source_location_id AND l.tenant_id = m.tenant_id
         JOIN pharmacy.batches b ON b.batch_id = m.batch_id AND b.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND l.organization_id = $2 AND m.movement_type = 'dispense'
          AND (m.occurred_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date
        GROUP BY 1, 2`,
      [this.t, org, from, to],
    );
    return r.rows.map((x) => ({ medicationId: x['medication_id'] as string, date: x['d'] as string, qty: n(x['qty']) }));
  }
  async firstMovementDate(org: OrganizationId): Promise<string | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT min((m.occurred_at AT TIME ZONE '${TZ}')::date)::text AS d FROM pharmacy.stock_movements m
         JOIN pharmacy.stock_locations l ON l.tenant_id = m.tenant_id AND l.location_id IN (m.source_location_id, m.destination_location_id)
        WHERE m.tenant_id = $1 AND l.organization_id = $2`,
      [this.t, org],
    );
    return (r.rows[0]?.['d'] as string | null) ?? null;
  }
  async medications(): Promise<Map<string, { name: string; unit: string }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT medication_id, brand_name, strength, unit_of_measure FROM pharmacy.medications WHERE tenant_id = $1 AND is_active`,
      [this.t],
    );
    return new Map(r.rows.map((x) => [x['medication_id'] as string, { name: `${x['brand_name']}`, unit: x['unit_of_measure'] as string }]));
  }
  /** Số chẩn đoán ICD-10 theo mã (theo ngày khám): 7 ngày gần nhất và 21 ngày trước đó. */
  async icdCounts(org: OrganizationId, today: string): Promise<Array<{ code: string; display: string | null; last7: number; prior21: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT c.code, max(c.display) AS display,
              count(*) FILTER (WHERE (e.period_start AT TIME ZONE '${TZ}')::date BETWEEN $3::date - 6 AND $3::date) AS last7,
              count(*) FILTER (WHERE (e.period_start AT TIME ZONE '${TZ}')::date BETWEEN $3::date - 27 AND $3::date - 7) AS prior21
         FROM clinical.conditions c JOIN clinical.encounters e ON e.tenant_id = c.tenant_id AND e.encounter_id = c.encounter_id
        WHERE c.tenant_id = $1 AND e.organization_id = $2 AND c.code_system = 'http://hl7.org/fhir/sid/icd-10'
          AND c.verification_status NOT IN ('refuted', 'entered_in_error')
          AND (e.period_start AT TIME ZONE '${TZ}')::date BETWEEN $3::date - 27 AND $3::date
        GROUP BY c.code`,
      [this.t, org, today],
    );
    return r.rows.map((x) => ({ code: x['code'] as string, display: (x['display'] as string | null) ?? null, last7: n(x['last7']), prior21: n(x['prior21']) }));
  }
  /** Thuốc ↔ mã bệnh được kê cùng đợt khám (90 ngày), trọng số = số lượng kê. */
  async drugIcd(org: OrganizationId, today: string): Promise<Array<{ medicationId: string; code: string; qty: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT i.medication_id, c.code, sum(i.quantity_prescribed) AS qty
         FROM clinical.prescriptions p
         JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
         JOIN clinical.conditions c ON c.tenant_id = p.tenant_id AND c.encounter_id = p.encounter_id AND c.code_system = 'http://hl7.org/fhir/sid/icd-10'
        WHERE p.tenant_id = $1 AND p.organization_id = $2 AND p.status NOT IN ('cancelled', 'entered_in_error')
          AND (p.prescribed_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date - 89 AND $3::date
        GROUP BY 1, 2`,
      [this.t, org, today],
    );
    return r.rows.map((x) => ({ medicationId: x['medication_id'] as string, code: x['code'] as string, qty: n(x['qty']) }));
  }

  // ---- tài chính ----
  async revenueStats(org: OrganizationId, from: string, to: string): Promise<{ cases: number; revenue: number; examCases: number; examRevenue: number; examQty: number }> {
    const r = await this.db.query<Record<string, unknown>>(
      `WITH c AS (
         SELECT ch.case_id, sum(ch.amount) AS amount,
                sum(ch.amount) FILTER (WHERE i.category = 'exam') AS exam_amount, sum(ch.quantity) FILTER (WHERE i.category = 'exam') AS exam_qty
           FROM finance.charges ch JOIN finance.price_items i ON i.tenant_id = ch.tenant_id AND i.item_id = ch.item_id
          WHERE ch.tenant_id = $1 AND ch.organization_id = $2 AND ch.status = 'active'
            AND (ch.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date
          GROUP BY ch.case_id)
       SELECT count(*) AS cases, COALESCE(sum(amount), 0) AS revenue, count(*) FILTER (WHERE exam_amount > 0) AS exam_cases,
              COALESCE(sum(exam_amount), 0) AS exam_revenue, COALESCE(sum(exam_qty), 0) AS exam_qty FROM c`,
      [this.t, org, from, to],
    );
    const x = r.rows[0]!;
    return { cases: n(x['cases']), revenue: n(x['revenue']), examCases: n(x['exam_cases']), examRevenue: n(x['exam_revenue']), examQty: n(x['exam_qty']) };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Tải phòng khám `days` ngày tới (dùng chung cho màn Dự báo và Decision Engine). */
export async function computeLoad(repo: PgForecastRepository, org: OrganizationId, days: number, now: Date): Promise<LoadForecast> {
  const today = vnDate(now);
  const hFrom = addDays(today, -HISTORY_DAYS);
  const hTo = addDays(today, -1);
  const fFrom = addDays(today, 1);
  const fTo = addDays(today, days);
  const rooms = await repo.rooms(org);
  const hist = await repo.visitHistory(org, hFrom, hTo);

  // Lịch sử thực có từ ngày khám đầu tiên trong cửa sổ.
  const firstDate = hist.length ? hist.map((h) => h.date).sort()[0]! : null;
  const historyDays = firstDate ? Math.round((Date.parse(`${hTo}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const wdCount = firstDate ? weekdayCounts(firstDate, hTo) : [0, 0, 0, 0, 0, 0, 0];
  const total = hist.reduce((a, h) => a + h.count, 0);
  const morning = hist.filter((h) => h.period === 'morning').reduce((a, h) => a + h.count, 0);
  const morningShare = total > 0 ? morning / total : 0.6;

  // Phân bổ lượt không rõ phòng theo tỷ trọng các phòng (không có dữ liệu => chia đều).
  const roomKeys = rooms.length ? rooms.map((r) => r.servicePointId) : ['—'];
  const assigned = new Map<string, number>(roomKeys.map((k) => [k, 0]));
  for (const h of hist) if (h.sp && assigned.has(h.sp)) assigned.set(h.sp, assigned.get(h.sp)! + h.count);
  const assignedTotal = [...assigned.values()].reduce((a, b) => a + b, 0);
  const share = new Map(roomKeys.map((k) => [k, assignedTotal > 0 ? assigned.get(k)! / assignedTotal : 1 / roomKeys.length]));
  const spread = (sp: string | null, f: (room: string, w: number) => void) => {
    if (sp && share.has(sp)) f(sp, 1);
    else for (const [k, w] of share) if (w > 0) f(k, w);
  };

  // Trung bình theo (phòng, thứ, buổi): vãng lai (không đặt lịch, không tái khám) và khách đặt lịch.
  const key = (room: string, wd: number, p: Period) => `${room}|${wd}|${p}`;
  const walk = new Map<string, number>();
  const bookedHist = new Map<string, number>();
  const wdTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const h of hist) {
    const wd = weekdayOf(h.date);
    wdTotals[wd]! += h.count;
    if (h.followUp) continue;
    const target = h.booked ? bookedHist : walk;
    spread(h.sp, (room, w) => target.set(key(room, wd, h.period), (target.get(key(room, wd, h.period)) ?? 0) + h.count * w));
  }
  const avg = (m: Map<string, number>, room: string, wd: number, p: Period) => (wdCount[wd] ? (m.get(key(room, wd, p)) ?? 0) / wdCount[wd]! : 0);
  const dailyMean = historyDays > 0 ? total / historyDays : 0;
  const weekdayIndex = wdTotals.map((t, wd) => (dailyMean > 0 && wdCount[wd] ? r2(t / wdCount[wd]! / dailyMean) : 0));

  // Tỷ lệ đến của lịch hẹn và tỷ lệ quay lại tái khám.
  const show = await repo.bookingShow(org, hFrom, hTo);
  const showRate = show.total >= MIN_SAMPLE ? show.shown / show.total : DEFAULT_SHOW;
  const ended = await repo.prescriptionEnds(org, hFrom, addDays(today, -8));
  const returnRate = ended.length >= MIN_SAMPLE ? ended.filter((e) => e.returned).length / ended.length : DEFAULT_RETURN;

  // Tái khám dự kiến: đơn kết thúc trong [fFrom - 7, fTo + 1], rải đều [end - 1, end + 7].
  const follow = new Map<string, number>();
  for (const e of await repo.prescriptionEnds(org, addDays(fFrom, -7), addDays(fTo, 1))) {
    for (let k = -1; k <= 7; k++) {
      const d = addDays(e.end, k);
      if (d < fFrom || d > fTo) continue;
      spread(e.sp, (room, w) => {
        for (const p of PERIODS) {
          const ps = p === 'morning' ? morningShare : 1 - morningShare;
          follow.set(`${room}|${d}|${p}`, (follow.get(`${room}|${d}|${p}`) ?? 0) + (returnRate / 9) * w * ps);
        }
      });
    }
  }
  const fb = new Map<string, number>();
  for (const b of await repo.futureBookings(org, fFrom, fTo)) fb.set(`${b.sp}|${b.date}|${b.period}`, (fb.get(`${b.sp}|${b.date}|${b.period}`) ?? 0) + b.count);

  const out: LoadDay[] = [];
  const alerts: LoadForecast['alerts'] = [];
  const totals = { walkIn: 0, booked: 0, followUp: 0, total: 0 };
  const roomInfo = new Map(rooms.map((r) => [r.servicePointId, r]));
  for (let d = fFrom; d <= fTo; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    const periods = { morning: [] as LoadCell[], afternoon: [] as LoadCell[] };
    let dayTotal = 0;
    let worst: LoadCell['status'] = 'unknown';
    const sev: Record<LoadCell['status'], number> = { unknown: 0, ok: 1, busy: 2, overload: 3 };
    for (const p of PERIODS) {
      for (const room of roomKeys) {
        const walkIn = avg(walk, room, wd, p);
        const bookedRaw = fb.get(`${room}|${d}|${p}`) ?? 0;
        const booked = Math.max(bookedRaw * showRate, avg(bookedHist, room, wd, p));
        const followUp = follow.get(`${room}|${d}|${p}`) ?? 0;
        const t = walkIn + booked + followUp;
        const capacity = roomInfo.get(room)?.visitCapacity ?? null;
        const status = loadStatus(t, capacity);
        const cell: LoadCell = {
          servicePointId: roomInfo.has(room) ? room : null, walkIn: r1(walkIn), bookedRaw, booked: r1(booked), followUp: r1(followUp), total: r1(t),
          capacity, utilization: capacity ? r2(t / capacity) : null, status,
        };
        periods[p].push(cell);
        dayTotal += t;
        totals.walkIn += walkIn;
        totals.booked += booked;
        totals.followUp += followUp;
        if (sev[status] > sev[worst]) worst = status;
        if ((status === 'busy' || status === 'overload') && capacity) {
          alerts.push({ date: d, period: p, servicePointId: cell.servicePointId, code: roomInfo.get(room)?.code ?? '—', total: r1(t), capacity, utilization: r2(t / capacity), status });
        }
      }
    }
    totals.total += dayTotal;
    out.push({ date: d, weekday: wd, periods, total: r1(dayTotal), worst });
  }
  return {
    from: fFrom, to: fTo, rooms, days: out, alerts, weekdayIndex,
    params: {
      historyDays, sufficient: historyDays >= 14,
      showRate: r2(showRate), showRateSource: show.total >= MIN_SAMPLE ? 'data' : 'default', showRateSample: show.total,
      returnRate: r2(returnRate), returnRateSource: ended.length >= MIN_SAMPLE ? 'data' : 'default', returnRateSample: ended.length,
      morningShare: r2(morningShare), avgDailyVisits: r1(dailyMean),
    },
    totals: { walkIn: r1(totals.walkIn), booked: r1(totals.booked), followUp: r1(totals.followUp), total: r1(totals.total) },
  };
}

/** Điểm đặt hàng lại thuốc (dùng chung cho màn Dự báo và Decision Engine). */
export async function computeInventory(repo: PgForecastRepository, org: OrganizationId, now: Date): Promise<InventoryForecast> {
  const today = vnDate(now);
  const settings = await repo.getSettings(org);
  const z = Z[settings.serviceLevelPct] ?? 1.6449;
  const first = await repo.firstMovementDate(org);
  const span = first ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const windowDays = Math.min(30, Math.max(7, span));
  const from = addDays(today, -(windowDays - 1));
  const dispensed = await repo.dispensedDaily(org, from, today);
  const batches = await repo.stockBatches(org, today);
  const meds = await repo.medications();
  const icd = await repo.icdCounts(org, today);
  const ratio = new Map(icd.map((c) => [c.code, trendRatio(c.last7, c.prior21)]));
  const links = await repo.drugIcd(org, today);

  const ids = new Set([...dispensed.map((d) => d.medicationId), ...batches.map((b) => b.medicationId)]);
  const lines: InventoryLine[] = [];
  for (const id of ids) {
    const m = meds.get(id);
    if (!m) continue;
    const series: number[] = [];
    const byDate = new Map(dispensed.filter((d) => d.medicationId === id).map((d) => [d.date, d.qty]));
    for (let d = from; d <= today; d = addDays(d, 1)) series.push(byDate.get(d) ?? 0);
    const myLinks = links.filter((l) => l.medicationId === id);
    const w = myLinks.reduce((a, l) => a + l.qty, 0);
    const trendFactor = w > 0 ? myLinks.reduce((a, l) => a + l.qty * (ratio.get(l.code) ?? 1), 0) / w : 1;
    const myBatches = batches.filter((b) => b.medicationId === id);
    const available = myBatches.reduce((a, b) => a + b.qty, 0);
    const calc = reorderLine({ available, daily: series, trendFactor, leadTimeDays: settings.leadTimeDays, z, reviewDays: REVIEW_DAYS });
    const unitCost = myBatches.length ? Math.max(...myBatches.map((b) => b.unitCost)) : null;
    lines.push({
      medicationId: id, name: m.name, unit: m.unit, available, trendFactor: r2(trendFactor),
      trendCodes: myLinks.map((l) => ({ code: l.code, ratio: r2(ratio.get(l.code) ?? 1) })).filter((c) => c.ratio !== 1).sort((a, b) => b.ratio - a.ratio).slice(0, 3),
      ...calc,
      estimatedOrderValue: calc.suggestedOrder && unitCost ? Math.round(calc.suggestedOrder * unitCost) : null,
      earliestExpiry: myBatches.length ? myBatches.map((b) => b.expiry).sort()[0]! : null,
      // Chưa có tiêu thụ => không đủ căn cứ để nói hàng sẽ hết hạn (tránh báo động giả).
      expiryRiskQty: calc.adjustedDaily > 0 ? expiryRisk(myBatches, calc.adjustedDaily, today) : 0,
    });
  }
  const rank: Record<InventoryLine['status'], number> = { stockout: 0, urgent: 1, reorder: 2, ok: 3, no_demand: 4 };
  lines.sort((a, b) => rank[a.status] - rank[b.status] || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9) || a.name.localeCompare(b.name));
  return {
    asOf: today,
    params: { windowDays, sufficient: span >= 14, leadTimeDays: settings.leadTimeDays, serviceLevelPct: settings.serviceLevelPct, z, reviewDays: REVIEW_DAYS },
    lines,
    risingCodes: icd
      .map((c) => ({ ...c, ratio: r2(trendRatio(c.last7, c.prior21)) }))
      .filter((c) => c.ratio >= 1.3 && c.last7 >= 2)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 10),
  };
}

export interface ForecastUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PgForecastRepository) => Promise<T>): Promise<T>;
}
export class PgForecastUnitOfWork implements ForecastUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}
  run<T>(ctx: TenantContext, fn: (repo: PgForecastRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgForecastRepository(db));
      },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
type Permission = 'forecast:read' | 'forecast:inventory' | 'forecast:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'forecast:read': ['clinic_admin', 'executive', 'tenant_admin'],
  // Dự báo tồn kho còn mở cho quản lý kho dược.
  'forecast:inventory': ['clinic_admin', 'executive', 'tenant_admin', 'pharmacy_admin'],
  'forecast:manage': ['clinic_admin', 'tenant_admin'],
};
interface Principal { readonly user: User; readonly grants: readonly AccessGrant[] }
const HISTORY_DAYS = 56;
const DEFAULT_SHOW = 0.85;
const DEFAULT_RETURN = 0.3;
const MIN_SAMPLE = 10;
const REVIEW_DAYS = 14;

export class ForecastService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { uow: ForecastUnitOfWork; audit: AuditSink; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async getSettings(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<ForecastSettings & { history: ForecastSettingsHistory[] }> {
    return this.tx(ctx, 'forecast.settings.read', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decide(await this.principal(repo, ctx, org), ['forecast:read', 'forecast:manage']);
      return { ...(await repo.getSettings(org)), history: await repo.settingsHistory(org) };
    });
  }

  async updateSettings(
    input: { organizationId: string; fixedCostsMonthly: number; variableCostPct: number; leadTimeDays: number; serviceLevelPct: number },
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<ForecastSettings & { history: ForecastSettingsHistory[] }> {
    return this.tx(ctx, 'forecast.settings.update', async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, ['forecast:manage']);
      const bad = (m: string): never => {
        throw new ClinicalError('VALIDATION', m, { reason: 'INVALID_SETTINGS' });
      };
      if (!Number.isSafeInteger(input.fixedCostsMonthly) || input.fixedCostsMonthly < 0 || input.fixedCostsMonthly > 100_000_000_000) bad('fixedCostsMonthly must be 0..1e11 VND');
      if (typeof input.variableCostPct !== 'number' || !(input.variableCostPct >= 0 && input.variableCostPct < 100)) bad('variableCostPct must be 0..<100');
      if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 1 || input.leadTimeDays > 90) bad('leadTimeDays must be 1..90');
      if (![90, 95, 97.5, 99].includes(input.serviceLevelPct)) bad('serviceLevelPct must be 90, 95, 97.5 or 99');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) bad('Invalid version');
      const s = {
        fixedCostsMonthly: input.fixedCostsMonthly, variableCostPct: Math.round(input.variableCostPct * 100) / 100, leadTimeDays: input.leadTimeDays,
        serviceLevelPct: input.serviceLevelPct as ForecastSettings['serviceLevelPct'],
      };
      if (!(await repo.saveSettings(org, s, p.user.userId, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Settings version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, 'forecast.settings.update', org, 'success', p.user, s));
      return { ...(await repo.getSettings(org)), history: await repo.settingsHistory(org) };
    });
  }

  async setVisitCapacity(servicePointId: string, capacity: number | null, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<{ servicePointId: string; visitCapacity: number | null; version: number }> {
    return this.tx(ctx, 'forecast.capacity.update', async (repo) => {
      if (typeof servicePointId !== 'string' || !isUuid(servicePointId)) throw new ClinicalError('VALIDATION', 'servicePointId must be a UUID');
      const room = await repo.findRoom(servicePointId.toLowerCase());
      if (!room) throw new ClinicalError('NOT_FOUND', 'Service point not found');
      assertOrganizationAllowed(room.organizationId, ctx);
      const p = await this.principal(repo, ctx, room.organizationId);
      this.decide(p, ['forecast:manage']);
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 500)) throw new ClinicalError('VALIDATION', 'visitCapacity must be 1..500 or null');
      if (!(await repo.setVisitCapacity(servicePointId.toLowerCase(), capacity, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Service point version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, 'forecast.capacity.update', room.organizationId, 'success', p.user, { servicePointId, visitCapacity: capacity }));
      const after = (await repo.findRoom(servicePointId.toLowerCase()))!;
      return { servicePointId: servicePointId.toLowerCase(), visitCapacity: capacity, version: after.version };
    });
  }

  async load(q: { organizationId: string; days?: number }, ctx: TenantContext = requireTenantContext()): Promise<LoadForecast> {
    return this.tx(ctx, 'forecast.load', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, ['forecast:read']);
      const days = q.days ?? 14;
      if (!Number.isInteger(days) || days < 7 || days > 30) throw new ClinicalError('VALIDATION', 'days must be 7..30', { reason: 'INVALID_RANGE' });
      const out = await this.computeLoad(repo, org, days);
      await repo.appendAudit(this.event(ctx, 'forecast.load', org, 'success', p.user, { days }));
      return out;
    });
  }

  async inventory(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<InventoryForecast> {
    return this.tx(ctx, 'forecast.inventory', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, ['forecast:inventory']);
      const out = await computeInventory(repo, org, this.clock());
      await repo.appendAudit(this.event(ctx, 'forecast.inventory', org, 'success', p.user, {}));
      return out;
    });
  }

  async cashflowBase(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<CashflowBase> {
    return this.tx(ctx, 'forecast.cashflow', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, ['forecast:read']);
      const load = await this.computeLoad(repo, org, 30);
      const today = vnDate(this.clock());
      const from = addDays(today, -30);
      const to = addDays(today, -1);
      const st = await repo.revenueStats(org, from, to);
      const settings = await repo.getSettings(org);
      const hist = await repo.visitHistory(org, from, to);
      await repo.appendAudit(this.event(ctx, 'forecast.cashflow', org, 'success', p.user, {}));
      return {
        horizonDays: 30,
        visits: load.totals.total, walkIn: load.totals.walkIn, followUp: load.totals.followUp, booked: load.totals.booked, showRate: load.params.showRate,
        revenuePerVisit: st.cases > 0 ? Math.round(st.revenue / st.cases) : null, revenueSample: st.cases,
        examShare: st.cases > 0 ? r2(st.examCases / st.cases) : 0, avgExamPrice: st.examQty > 0 ? Math.round(st.examRevenue / st.examQty) : null,
        actualVisitsLast30: hist.reduce((a, h) => a + h.count, 0), actualRevenueLast30: st.revenue,
        fixedCostsMonthly: settings.fixedCostsMonthly, variableCostPct: settings.variableCostPct,
      };
    });
  }

  private computeLoad(repo: PgForecastRepository, org: OrganizationId, days: number): Promise<LoadForecast> {
    return computeLoad(repo, org, days, this.clock());
  }

  // ---- nội bộ ----
  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  private async principal(repo: PgForecastRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
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
  /** Cho phép nếu MỘT trong các hành động được phép. */
  private decide(p: Principal, actions: PolicyAction[]): void {
    let denied: ClinicalError | null = null;
    for (const action of actions) {
      const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
      const d = decideAccess(p.grants, action, PERMISSIONS[perm], { callerUserId: p.user.userId });
      if (d.allowed) return;
      denied = d.reason === 'ROLE' ? new ClinicalError('FORBIDDEN', `Missing permission ${perm}`) : new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
    }
    throw denied ?? new ClinicalError('FORBIDDEN', 'Access denied');
  }
  private event(ctx: TenantContext, action: string, org: OrganizationId | null, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: org, action, resourceType: 'Forecast', resourceId: null, personId: null, patientId: null, outcome,
      correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async tx<T>(ctx: TenantContext, action: string, fn: (repo: PgForecastRepository) => Promise<T>): Promise<T> {
    try {
      return await this.deps.uow.run(ctx, fn);
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
      try {
        await this.deps.audit.record(this.event(ctx, action, null, outcome, null, { code }));
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }
}
