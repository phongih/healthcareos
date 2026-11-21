/**
 * HCOS-F19 | Thiết bị & vật tư y khoa.
 *
 *   Thiết bị (equipment:*)
 *     read    mọi nhân viên lâm sàng / quản lý — xem sổ, mở trang thiết bị qua QR.
 *     use     bác sĩ, điều dưỡng / lễ tân, quản lý — nhận bàn giao đầu ca, báo hỏng, ghi chú (thường quét QR trên thân máy).
 *     manage  quản lý phòng khám — đăng ký / sửa, chế độ kiểm định, ghi kết quả kiểm định, bảo trì / sửa xong / chuyển phòng /
 *             thanh lý, gắn dịch vụ với loại máy.
 *   Vật tư (supply:*)
 *     read    quản lý kho, quản lý, thu ngân, ban giám đốc — định mức, vật tư đã trừ + giá vốn theo hồ sơ, dòng thiếu.
 *     manage  quản lý kho, quản lý — sửa định mức, chọn kho trừ, đối soát dòng thiếu.
 *     record  bác sĩ, điều dưỡng — ghi lô thực tế đã dùng cho người bệnh (gắn hồ sơ thanh toán đang mở).
 *     recall  quản lý kho, quản lý — tra người bệnh đã dùng một lô (họ tên + mã BN; bắt buộc lý do, ghi nhật ký).
 *
 * Trạng thái thiết bị chỉ đổi qua nhật ký chỉ-thêm (CSDL áp). Trừ kho vật tư chạy trong FinanceService.closeCase (cùng transaction).
 */
import { isUuid, type AuditSink, type OrganizationId, type Role, type TenantContext } from '../../../../packages/domain/src/s0-contracts';
import { requireTenantContext, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, num } from '../clinical/encounter.service';
import { GovernanceBase, optStr, str, type GovRepo, type Principal } from '../governance/governance-base';
import { depreciation, type DepreciationResult } from './depreciation';

type Permission =
  | 'equipment:read' | 'equipment:use' | 'equipment:manage'
  | 'supply:read' | 'supply:manage' | 'supply:record' | 'supply:recall';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'equipment:read': ['doctor', 'clinic_staff', 'cashier', 'pharmacist', 'pharmacy_admin', 'clinic_admin', 'executive', 'tenant_admin'],
  'equipment:use': ['doctor', 'clinic_staff', 'clinic_admin'],
  'equipment:manage': ['clinic_admin', 'tenant_admin'],
  'supply:read': ['pharmacy_admin', 'clinic_admin', 'cashier', 'executive', 'tenant_admin'],
  'supply:manage': ['pharmacy_admin', 'clinic_admin'],
  'supply:record': ['doctor', 'clinic_staff'],
  'supply:recall': ['pharmacy_admin', 'clinic_admin'],
};

export const REGIMES = {
  atkt: { label: 'Kiểm định an toàn & tính năng kỹ thuật', basis: 'Danh mục TT 05/2022/TT-BYT', mandatory: true },
  do_luong: { label: 'Kiểm định phương tiện đo', basis: 'Pháp luật đo lường', mandatory: true },
  buc_xa: { label: 'Kiểm định an toàn bức xạ', basis: 'Pháp luật năng lượng nguyên tử (X-quang…)', mandatory: true },
  ap_luc: { label: 'Kiểm định thiết bị áp lực', basis: 'Pháp luật an toàn lao động (nồi hấp…)', mandatory: true },
  hieu_chuan: { label: 'Hiệu chuẩn / bảo dưỡng định kỳ', basis: 'Nhà sản xuất / quy trình nội bộ', mandatory: false },
} as const;
export type Regime = keyof typeof REGIMES;
const REGIME_IDS = Object.keys(REGIMES) as Regime[];
export const RISK_CLASSES = ['A', 'B', 'C', 'D'] as const;
export const EVENT_KINDS = ['handover', 'fault', 'maintenance_start', 'repaired', 'moved', 'retired', 'note'] as const;
type EventKind = (typeof EVENT_KINDS)[number];
const USE_KINDS: ReadonlySet<EventKind> = new Set(['handover', 'fault', 'note']);
export const ASSET_CODE_RE = /^TB(\d{2})-(\d{4,})-(\d)$/;

export interface RegimeStatus {
  readonly regime: Regime;
  readonly cycleMonths: number;
  readonly mandatory: boolean;
  readonly state: 'ok' | 'due_soon' | 'overdue' | 'failed' | 'missing' | 'reinspect';
  readonly performedOn: string | null;
  readonly validUntil: string | null;
  readonly result: 'pass' | 'fail' | null;
  readonly provider: string | null;
  readonly certificateNo: string | null;
  readonly version: number;
}
export interface Device {
  readonly deviceId: string;
  readonly organizationId: string;
  readonly assetCode: string;
  readonly typeId: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly name: string;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly serialNo: string | null;
  readonly servicePointId: string | null;
  readonly roomCode: string | null;
  readonly riskClass: (typeof RISK_CLASSES)[number];
  readonly registrationNo: string | null;
  readonly warrantyUntil: string | null;
  readonly acquiredOn: string | null;
  readonly inServiceOn: string | null;
  readonly cost: number | null;
  readonly usefulLifeMonths: number | null;
  readonly status: 'active' | 'broken' | 'maintenance' | 'retired';
  readonly statusSince: string;
  readonly retiredOn: string | null;
  readonly version: number;
  /** Lý do KHÔNG được dùng (rỗng = dùng được): 'status:broken', 'regime:atkt:overdue'… */
  readonly blockers: string[];
  readonly regimes: RegimeStatus[];
  /** Hạn gần nhất trong các chế độ đang áp dụng. */
  readonly nextDue: { regime: Regime; validUntil: string | null; state: RegimeStatus['state'] } | null;
  readonly depreciation: DepreciationResult | null;
}
export interface DeviceEvent {
  readonly eventId: string;
  readonly kind: EventKind | 'registered';
  readonly note: string | null;
  readonly majorRepair: boolean;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly fromRoom: string | null;
  readonly toRoom: string | null;
  readonly via: 'web' | 'qr' | 'system';
  readonly actorName: string | null;
  readonly occurredAt: string;
}
export interface Inspection {
  readonly inspectionId: string;
  readonly regime: Regime;
  readonly performedOn: string;
  readonly result: 'pass' | 'fail';
  readonly validUntil: string;
  readonly provider: string;
  readonly certificateNo: string | null;
  readonly note: string | null;
  readonly recordedByName: string | null;
  readonly recordedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const dateOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
const vnToday = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);

const DEVICE_SQL = `
  SELECT d.device_id, d.organization_id, d.asset_code, d.type_id, t.code AS type_code, t.name AS type_name, d.name, d.manufacturer, d.model, d.serial_no,
         d.service_point_id, sp.code AS room_code, d.risk_class, d.registration_no, d.warranty_until::text AS warranty_until, d.acquired_on::text AS acquired_on,
         d.in_service_on::text AS in_service_on, d.cost, d.useful_life_months, d.status, d.status_since, d.retired_on::text AS retired_on, d.version,
         equipment.device_blockers(d.tenant_id, d.device_id) AS blockers,
         (SELECT COALESCE(json_agg(json_build_object(
                   'regime', s.regime, 'cycleMonths', s.cycle_months, 'mandatory', s.mandatory, 'state', s.state, 'performedOn', s.performed_on::text,
                   'validUntil', s.valid_until::text, 'result', s.result, 'provider', s.provider, 'certificateNo', s.certificate_no,
                   'version', (SELECT r.version FROM equipment.device_regimes r WHERE r.tenant_id = s.tenant_id AND r.device_id = s.device_id AND r.regime = s.regime))
                 ORDER BY s.regime), '[]'::json)
            FROM equipment.regime_status s WHERE s.tenant_id = d.tenant_id AND s.device_id = d.device_id) AS regimes
    FROM equipment.devices d
    JOIN equipment.device_types t ON t.tenant_id = d.tenant_id AND t.type_id = d.type_id
    LEFT JOIN clinical.service_points sp ON sp.tenant_id = d.tenant_id AND sp.service_point_id = d.service_point_id`;

const STATE_RANK: Record<RegimeStatus['state'], number> = { failed: 0, missing: 1, reinspect: 2, overdue: 3, due_soon: 4, ok: 5 };
function mapDevice(x: any, today: string): Device {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);
  const regimes: RegimeStatus[] = (typeof x.regimes === 'string' ? JSON.parse(x.regimes) : x.regimes ?? []).map((r: any) => ({
    regime: r.regime, cycleMonths: num(r.cycleMonths), mandatory: r.mandatory === true, state: r.state, performedOn: r.performedOn ?? null,
    validUntil: r.validUntil ?? null, result: r.result ?? null, provider: r.provider ?? null, certificateNo: r.certificateNo ?? null, version: num(r.version),
  }));
  const sorted = [...regimes].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.validUntil ?? '').localeCompare(b.validUntil ?? ''));
  const cost = intOrNull(x.cost);
  const life = intOrNull(x.useful_life_months);
  const inService = dateOrNull(x.in_service_on);
  return {
    deviceId: x.device_id, organizationId: x.organization_id, assetCode: x.asset_code, typeId: x.type_id, typeCode: x.type_code, typeName: x.type_name, name: x.name,
    manufacturer: x.manufacturer ?? null, model: x.model ?? null, serialNo: x.serial_no ?? null, servicePointId: x.service_point_id ?? null, roomCode: x.room_code ?? null,
    riskClass: x.risk_class, registrationNo: x.registration_no ?? null, warrantyUntil: dateOrNull(x.warranty_until), acquiredOn: dateOrNull(x.acquired_on),
    inServiceOn: inService, cost, usefulLifeMonths: life, status: x.status, statusSince: iso(x.status_since), retiredOn: dateOrNull(x.retired_on),
    version: num(x.version), blockers: arr(x.blockers), regimes,
    nextDue: sorted[0] ? { regime: sorted[0].regime, validUntil: sorted[0].validUntil, state: sorted[0].state } : null,
    depreciation: cost !== null && life !== null && inService ? depreciation({ cost, usefulLifeMonths: life, inServiceOn: inService, retiredOn: dateOrNull(x.retired_on) }, today) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const dateIn = (v: unknown, field: string, optional = true): string | null => {
  if (optional && (v === undefined || v === null || v === '')) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new ClinicalError('VALIDATION', `${field} must be YYYY-MM-DD`);
  return v;
};
const intIn = (v: unknown, field: string, min: number, max: number, optional = false): number | null => {
  if (optional && (v === undefined || v === null || v === '')) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ClinicalError('VALIDATION', `${field} must be an integer ${min}..${max}`);
  return v;
};
const uuidIn = (v: unknown, field: string, optional = false): string | null => {
  if (optional && (v === undefined || v === null || v === '')) return null;
  if (typeof v !== 'string' || !isUuid(v)) throw new ClinicalError('VALIDATION', `${field} must be a UUID`);
  return v.toLowerCase();
};
const addMonths = (date: string, months: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};

/** Mã tài sản hợp lệ (đúng định dạng + số kiểm tra Luhn). */
export function validAssetCode(code: string): boolean {
  const m = ASSET_CODE_RE.exec(code.trim().toUpperCase());
  if (!m) return false;
  const digits = m[1]! + m[2]!;
  let s = 0;
  let dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    s += d;
    dbl = !dbl;
  }
  return (10 - (s % 10)) % 10 === Number(m[3]);
}

export class EquipmentService extends GovernanceBase<Permission> {
  constructor(deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    super(deps, PERMISSIONS, 'Equipment');
  }

  // =========================================================================
  // Thiết bị
  // =========================================================================
  async listDevices(q: { organizationId: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(q.organizationId, ctx);
    return this.run(ctx, 'equipment.list', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'equipment:read');
      const today = vnToday(this.clock());
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const devices = (await repo.tdb.query<any>(`${DEVICE_SQL} WHERE d.tenant_id = $1 AND d.organization_id = $2 ORDER BY (d.status = 'retired'), d.asset_code`, [repo.tenantId, org]))
        .rows.map((x: any) => mapDevice(x, today));
      const types = (await repo.tdb.query<any>(`SELECT type_id, code, name FROM equipment.device_types WHERE tenant_id = $1 ORDER BY code`, [repo.tenantId]))
        .rows.map((x: any) => ({ typeId: x.type_id, code: x.code, name: x.name }));
      const rooms = (await repo.tdb.query<any>(`SELECT service_point_id, code, name FROM clinical.service_points WHERE tenant_id = $1 AND organization_id = $2 ORDER BY code`, [repo.tenantId, org]))
        .rows.map((x: any) => ({ servicePointId: x.service_point_id, code: x.code, name: x.name }));
      const requirements = (await repo.tdb.query<any>(
        `SELECT r.item_id, i.code AS item_code, i.name AS item_name, r.type_id, r.active, r.version,
                EXISTS (SELECT 1 FROM equipment.unavailable_types(r.tenant_id, r.organization_id, r.item_id) u WHERE u.type_id = r.type_id) AS blocked
           FROM equipment.service_requirements r JOIN finance.price_items i ON i.tenant_id = r.tenant_id AND i.item_id = r.item_id
          WHERE r.tenant_id = $1 AND r.organization_id = $2 ORDER BY i.code`, [repo.tenantId, org]))
        .rows.map((x: any) => ({ itemId: x.item_id, itemCode: x.item_code, itemName: x.item_name, typeId: x.type_id, active: x.active === true || x.active === 't', version: num(x.version), blocked: x.blocked === true || x.blocked === 't' }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const live = devices.filter((d) => d.status !== 'retired');
      return {
        devices, types, rooms, requirements, regimes: REGIMES,
        totals: {
          devices: live.length, usable: live.filter((d) => d.blockers.length === 0).length,
          outOfService: live.filter((d) => d.status === 'broken' || d.status === 'maintenance').length,
          dueSoon: live.filter((d) => d.regimes.some((r) => r.state === 'due_soon')).length,
          depreciationThisMonth: live.reduce((a, d) => a + (d.depreciation?.thisMonth ?? 0), 0),
        },
        canUse: this.allowed(g, p.user, 'equipment:use'), canManage: this.allowed(g, p.user, 'equipment:manage'),
      };
    });
  }

  /** Trang thiết bị theo mã tài sản (QR) hoặc id. */
  async getDevice(ref: unknown, ctx: TenantContext = requireTenantContext()) {
    return this.run(ctx, 'equipment.read', async (repo) => {
      const d = await this.load(repo, ref);
      const { p, g } = await this.at(repo, ctx, d.organizationId as OrganizationId);
      this.need(g, p.user, 'equipment:read');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const events: DeviceEvent[] = (await repo.tdb.query<any>(
        `SELECT e.*, u.display_name AS actor_name, f.code AS from_room, t.code AS to_room FROM equipment.device_events e
           LEFT JOIN iam.users u ON u.tenant_id = e.tenant_id AND u.user_id = e.actor
           LEFT JOIN clinical.service_points f ON f.tenant_id = e.tenant_id AND f.service_point_id = e.from_service_point
           LEFT JOIN clinical.service_points t ON t.tenant_id = e.tenant_id AND t.service_point_id = e.to_service_point
          WHERE e.tenant_id = $1 AND e.device_id = $2 ORDER BY e.occurred_at DESC LIMIT 100`, [repo.tenantId, d.deviceId]))
        .rows.map((x: any) => ({
          eventId: x.event_id, kind: x.kind, note: x.note ?? null, majorRepair: x.major_repair === true || x.major_repair === 't', fromStatus: x.from_status ?? null,
          toStatus: x.to_status ?? null, fromRoom: x.from_room ?? null, toRoom: x.to_room ?? null, via: x.via, actorName: x.actor_name ?? null, occurredAt: iso(x.occurred_at),
        }));
      const inspections: Inspection[] = (await repo.tdb.query<any>(
        `SELECT i.inspection_id, i.regime, i.performed_on::text AS performed_on, i.result, i.valid_until::text AS valid_until, i.provider, i.certificate_no, i.note,
                u.display_name AS recorded_by_name, i.recorded_at
           FROM equipment.device_inspections i LEFT JOIN iam.users u ON u.tenant_id = i.tenant_id AND u.user_id = i.recorded_by
          WHERE i.tenant_id = $1 AND i.device_id = $2 ORDER BY i.performed_on DESC, i.recorded_at DESC`, [repo.tenantId, d.deviceId]))
        .rows.map((x: any) => ({
          inspectionId: x.inspection_id, regime: x.regime, performedOn: dateOrNull(x.performed_on)!, result: x.result, validUntil: dateOrNull(x.valid_until)!,
          provider: x.provider, certificateNo: x.certificate_no ?? null, note: x.note ?? null, recordedByName: x.recorded_by_name ?? null, recordedAt: iso(x.recorded_at),
        }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
      await repo.appendAudit(this.event(ctx, 'equipment.read', 'success', p.user, { assetCode: d.assetCode }, d.deviceId, d.organizationId as OrganizationId));
      return { device: d, events, inspections, regimes: REGIMES, canUse: this.allowed(g, p.user, 'equipment:use'), canManage: this.allowed(g, p.user, 'equipment:manage') };
    });
  }

  async createType(input: { code: unknown; name: unknown }, ctx: TenantContext = requireTenantContext()) {
    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw new ClinicalError('VALIDATION', 'code must be 2–20 of A-Z 0-9 _');
    const name = str(input.name, 2, 120, 'name');
    return this.run(ctx, 'equipment.type.create', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'equipment:manage');
      try {
        const r = await repo.tdb.query<{ type_id: string }>(`INSERT INTO equipment.device_types (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING type_id`, [repo.tenantId, code, name]);
        await repo.appendAudit(this.event(ctx, 'equipment.type.create', 'success', p.user, { code }, r.rows[0]!.type_id));
        return { typeId: r.rows[0]!.type_id, code, name };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ClinicalError('CONFLICT', 'Device type code already exists', { reason: 'TYPE_CODE_TAKEN' });
        throw e;
      }
    });
  }

  async registerDevice(input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(input['organizationId'], ctx);
    const f = this.deviceFields(input);
    const regimes = input['regimes'] === undefined ? [] : this.regimesIn(input['regimes']);
    return this.run(ctx, 'equipment.register', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'equipment:manage');
      const code = (await repo.tdb.query<{ c: string }>(`SELECT equipment.next_asset_code($1, $2, now()) AS c`, [repo.tenantId, org])).rows[0]!.c;
      let id: string;
      try {
        const r = await repo.tdb.query<{ device_id: string }>(
          `INSERT INTO equipment.devices (tenant_id, organization_id, asset_code, type_id, name, manufacturer, model, serial_no, service_point_id, risk_class, registration_no,
                                          warranty_until, acquired_on, in_service_on, cost, useful_life_months, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17) RETURNING device_id`,
          [repo.tenantId, org, code, f.typeId, f.name, f.manufacturer, f.model, f.serialNo, f.servicePointId, f.riskClass, f.registrationNo,
            f.warrantyUntil, f.acquiredOn, f.inServiceOn, f.cost, f.usefulLifeMonths, p.user.userId],
        );
        id = r.rows[0]!.device_id;
      } catch (e) {
        this.pgDeviceError(e);
        throw e;
      }
      await repo.tdb.query(`INSERT INTO equipment.device_events (tenant_id, device_id, kind, actor, via) VALUES ($1, $2, 'registered', $3, 'web')`, [repo.tenantId, id, p.user.userId]);
      for (const r of regimes) {
        await repo.tdb.query(
          `INSERT INTO equipment.device_regimes (tenant_id, device_id, regime, cycle_months, mandatory, active, updated_by) VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [repo.tenantId, id, r.regime, r.cycleMonths, r.mandatory, p.user.userId],
        );
      }
      await repo.appendAudit(this.event(ctx, 'equipment.register', 'success', p.user, { assetCode: code, riskClass: f.riskClass, regimes: regimes.map((r) => r.regime) }, id, org));
      return this.load(repo, id);
    });
  }

  async updateDevice(ref: unknown, input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const f = this.deviceFields(input, true);
    const version = intIn(input['version'], 'version', 1, Number.MAX_SAFE_INTEGER)!;
    return this.run(ctx, 'equipment.update', async (repo) => {
      const d = await this.load(repo, ref);
      const { p, g } = await this.at(repo, ctx, d.organizationId as OrganizationId);
      this.need(g, p.user, 'equipment:manage');
      if (d.status === 'retired') throw new ClinicalError('CONFLICT', 'Device is retired', { reason: 'DEVICE_RETIRED' });
      let ok = false;
      try {
        const r = await repo.tdb.query(
          `UPDATE equipment.devices SET type_id = $3, name = $4, manufacturer = $5, model = $6, serial_no = $7, risk_class = $8, registration_no = $9, warranty_until = $10,
                  acquired_on = $11, in_service_on = $12, cost = $13, useful_life_months = $14, updated_by = $15
            WHERE tenant_id = $1 AND device_id = $2 AND version = $16 RETURNING 1`,
          [repo.tenantId, d.deviceId, f.typeId, f.name, f.manufacturer, f.model, f.serialNo, f.riskClass, f.registrationNo, f.warrantyUntil, f.acquiredOn, f.inServiceOn,
            f.cost, f.usefulLifeMonths, p.user.userId, version],
        );
        ok = r.rows.length > 0;
      } catch (e) {
        this.pgDeviceError(e);
        throw e;
      }
      if (!ok) throw new ClinicalError('CONFLICT', 'Device version does not match', { reason: 'VERSION_CONFLICT' });
      await repo.appendAudit(this.event(ctx, 'equipment.update', 'success', p.user, { assetCode: d.assetCode }, d.deviceId, d.organizationId as OrganizationId));
      return this.load(repo, d.deviceId);
    });
  }

  /** Bàn giao / báo hỏng / ghi chú (equipment:use); bảo trì / sửa xong / chuyển phòng / thanh lý (equipment:manage). */
  async addEvent(ref: unknown, input: { kind: unknown; note?: unknown; majorRepair?: unknown; toServicePointId?: unknown; via?: unknown }, ctx: TenantContext = requireTenantContext()) {
    if (!(EVENT_KINDS as readonly unknown[]).includes(input.kind)) throw new ClinicalError('VALIDATION', `kind must be one of ${EVENT_KINDS.join(', ')}`);
    const kind = input.kind as EventKind;
    const note = optStr(input.note, 1000, 'note');
    if (['fault', 'maintenance_start', 'repaired', 'retired', 'note'].includes(kind) && (note === null || note.length < 3)) {
      throw new ClinicalError('VALIDATION', 'A note is required', { reason: 'NOTE_REQUIRED' });
    }
    const major = input.majorRepair === true;
    if (major && kind !== 'repaired') throw new ClinicalError('VALIDATION', 'majorRepair only applies to repaired');
    const to = kind === 'moved' ? uuidIn(input.toServicePointId, 'toServicePointId', true) : null;
    const via = input.via === 'qr' ? 'qr' : 'web';
    return this.run(ctx, `equipment.event.${kind}`, async (repo) => {
      const d = await this.load(repo, ref);
      const { p, g } = await this.at(repo, ctx, d.organizationId as OrganizationId);
      this.need(g, p.user, USE_KINDS.has(kind) ? 'equipment:use' : 'equipment:manage');
      try {
        await repo.tdb.query(
          `INSERT INTO equipment.device_events (tenant_id, device_id, kind, note, major_repair, to_service_point, actor, via) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [repo.tenantId, d.deviceId, kind, note, major, to, p.user.userId, via],
        );
      } catch (e) {
        const c = (e as { code?: string }).code;
        if (c === '55000') throw new ClinicalError('CONFLICT', (e as Error).message, { reason: d.status === 'retired' ? 'DEVICE_RETIRED' : 'DEVICE_STATE' });
        if (c === '23503') throw new ClinicalError('VALIDATION', 'Room is not in this clinic', { reason: 'ROOM_INVALID' });
        throw e;
      }
      await repo.appendAudit(this.event(ctx, `equipment.event.${kind}`, 'success', p.user, { assetCode: d.assetCode, via, majorRepair: major }, d.deviceId, d.organizationId as OrganizationId));
      return this.load(repo, d.deviceId);
    });
  }

  async setRegime(ref: unknown, input: { regime: unknown; cycleMonths: unknown; mandatory: unknown; active?: unknown; version?: unknown }, ctx: TenantContext = requireTenantContext()) {
    const [r] = this.regimesIn([input]);
    const active = input.active !== false;
    const version = input.version === undefined || input.version === null ? null : intIn(input.version, 'version', 1, Number.MAX_SAFE_INTEGER);
    return this.run(ctx, 'equipment.regime', async (repo) => {
      const d = await this.load(repo, ref);
      const { p, g } = await this.at(repo, ctx, d.organizationId as OrganizationId);
      this.need(g, p.user, 'equipment:manage');
      if (d.status === 'retired') throw new ClinicalError('CONFLICT', 'Device is retired', { reason: 'DEVICE_RETIRED' });
      const exists = (await repo.tdb.query(`SELECT 1 FROM equipment.device_regimes WHERE tenant_id = $1 AND device_id = $2 AND regime = $3`, [repo.tenantId, d.deviceId, r!.regime])).rows.length > 0;
      if (!exists) {
        await repo.tdb.query(
          `INSERT INTO equipment.device_regimes (tenant_id, device_id, regime, cycle_months, mandatory, active, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [repo.tenantId, d.deviceId, r!.regime, r!.cycleMonths, r!.mandatory, active, p.user.userId],
        );
      } else {
        if (version === null) throw new ClinicalError('VALIDATION', 'version is required to change an existing regime');
        const u = await repo.tdb.query(
          `UPDATE equipment.device_regimes SET cycle_months = $4, mandatory = $5, active = $6, updated_by = $7 WHERE tenant_id = $1 AND device_id = $2 AND regime = $3 AND version = $8 RETURNING 1`,
          [repo.tenantId, d.deviceId, r!.regime, r!.cycleMonths, r!.mandatory, active, p.user.userId, version],
        );
        if (u.rows.length === 0) throw new ClinicalError('CONFLICT', 'Regime version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, 'equipment.regime', 'success', p.user, { assetCode: d.assetCode, ...r, active }, d.deviceId, d.organizationId as OrganizationId));
      return this.load(repo, d.deviceId);
    });
  }

  async recordInspection(
    ref: unknown,
    input: { regime: unknown; performedOn: unknown; result: unknown; validUntil?: unknown; provider: unknown; certificateNo?: unknown; note?: unknown },
    ctx: TenantContext = requireTenantContext(),
  ) {
    if (!(REGIME_IDS as readonly unknown[]).includes(input.regime)) throw new ClinicalError('VALIDATION', `regime must be one of ${REGIME_IDS.join(', ')}`);
    const performed = dateIn(input.performedOn, 'performedOn', false)!;
    if (input.result !== 'pass' && input.result !== 'fail') throw new ClinicalError('VALIDATION', "result must be 'pass' or 'fail'");
    const provider = str(input.provider, 2, 200, 'provider');
    const cert = optStr(input.certificateNo, 80, 'certificateNo');
    if (input.result === 'pass' && (cert === null || cert.length < 2)) throw new ClinicalError('VALIDATION', 'A passed inspection needs the certificate / stamp number', { reason: 'CERTIFICATE_REQUIRED' });
    const note = optStr(input.note, 500, 'note');
    const explicit = dateIn(input.validUntil, 'validUntil');
    return this.run(ctx, 'equipment.inspection', async (repo) => {
      const d = await this.load(repo, ref);
      const { p, g } = await this.at(repo, ctx, d.organizationId as OrganizationId);
      this.need(g, p.user, 'equipment:manage');
      const reg = d.regimes.find((r) => r.regime === input.regime);
      if (!reg) throw new ClinicalError('VALIDATION', 'This regime is not configured for the device', { reason: 'REGIME_NOT_CONFIGURED' });
      if (performed > vnToday(this.clock())) throw new ClinicalError('VALIDATION', 'performedOn is in the future', { reason: 'DATE_IN_FUTURE' });
      // Không đạt: hiệu lực tới chính ngày kiểm định + 1 (máy bị chặn ngay vì kết quả 'fail').
      const until = input.result === 'fail' ? new Date(Date.parse(`${performed}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : (explicit ?? addMonths(performed, reg.cycleMonths));
      if (until <= performed) throw new ClinicalError('VALIDATION', 'validUntil must be after performedOn');
      try {
        await repo.tdb.query(
          `INSERT INTO equipment.device_inspections (tenant_id, device_id, regime, performed_on, result, valid_until, provider, certificate_no, note, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [repo.tenantId, d.deviceId, input.regime, performed, input.result, until, provider, cert, note, p.user.userId],
        );
      } catch (e) {
        const c = (e as { code?: string }).code;
        if (c === '23514') throw new ClinicalError('VALIDATION', (e as Error).message, { reason: 'INSPECTION_INVALID' });
        if (c === '55000') throw new ClinicalError('CONFLICT', 'Device is retired', { reason: 'DEVICE_RETIRED' });
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'equipment.inspection', 'success', p.user, { assetCode: d.assetCode, regime: input.regime, result: input.result, validUntil: until }, d.deviceId, d.organizationId as OrganizationId));
      return this.load(repo, d.deviceId);
    });
  }

  async setServiceRequirement(input: { organizationId: unknown; itemId: unknown; typeId: unknown; active?: unknown; version?: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(input.organizationId, ctx);
    const item = uuidIn(input.itemId, 'itemId')!;
    const type = uuidIn(input.typeId, 'typeId')!;
    const active = input.active !== false;
    return this.run(ctx, 'equipment.requirement', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'equipment:manage');
      try {
        const r = await repo.tdb.query(
          `INSERT INTO equipment.service_requirements (tenant_id, organization_id, item_id, type_id, active, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, item_id, type_id) DO UPDATE SET active = EXCLUDED.active, updated_by = EXCLUDED.updated_by
             WHERE equipment.service_requirements.organization_id = EXCLUDED.organization_id RETURNING 1`,
          [repo.tenantId, org, item, type, active, p.user.userId],
        );
        if (r.rows.length === 0) throw new ClinicalError('NOT_FOUND', 'Price item not found');
      } catch (e) {
        if ((e as { code?: string }).code === '23503') throw new ClinicalError('NOT_FOUND', 'Price item or device type not found');
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'equipment.requirement', 'success', p.user, { itemId: item, typeId: type, active }, item, org));
      return { itemId: item, typeId: type, active };
    });
  }

  /** Sổ thiết bị để xuất Excel (F18 /api/exports) — không có dữ liệu cá nhân. */
  async register(organizationId: unknown, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(organizationId, ctx);
    return this.run(ctx, 'equipment.register.read', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'equipment:read');
      const today = vnToday(this.clock());
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const devices = (await repo.tdb.query<any>(`${DEVICE_SQL} WHERE d.tenant_id = $1 AND d.organization_id = $2 ORDER BY d.asset_code`, [repo.tenantId, org])).rows.map((x: any) => mapDevice(x, today));
      const inspections = (await repo.tdb.query<any>(
        `SELECT d.asset_code, i.regime, i.performed_on::text AS performed_on, i.result, i.valid_until::text AS valid_until, i.provider, i.certificate_no
           FROM equipment.device_inspections i JOIN equipment.devices d ON d.tenant_id = i.tenant_id AND d.device_id = i.device_id
          WHERE i.tenant_id = $1 AND d.organization_id = $2 ORDER BY d.asset_code, i.performed_on DESC`, [repo.tenantId, org])).rows;
      const org_ = (await repo.tdb.query<any>(`SELECT name FROM iam.organizations WHERE tenant_id = $1 AND organization_id = $2`, [repo.tenantId, org])).rows[0]?.name ?? '';
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return { organizationName: String(org_), asOf: today, devices, inspections: inspections.map((x) => ({
        assetCode: String(x.asset_code), regime: x.regime as Regime, performedOn: dateOrNull(x.performed_on)!, result: x.result as string, validUntil: dateOrNull(x.valid_until)!,
        provider: String(x.provider), certificateNo: (x.certificate_no as string | null) ?? null,
      })) };
    });
  }

  // =========================================================================
  // Vật tư
  // =========================================================================
  async supplyOverview(q: { organizationId: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(q.organizationId, ctx);
    return this.run(ctx, 'supply.overview', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'supply:read');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const st = (await repo.tdb.query<any>(`SELECT location_id, version FROM equipment.supply_settings WHERE tenant_id = $1 AND organization_id = $2`, [repo.tenantId, org])).rows[0];
      const locations = (await repo.tdb.query<any>(
        `SELECT location_id, name, type FROM pharmacy.stock_locations WHERE tenant_id = $1 AND organization_id = $2 AND is_active ORDER BY name`, [repo.tenantId, org])).rows
        .map((x: any) => ({ locationId: x.location_id, name: x.name, type: x.type }));
      const supplies = (await repo.tdb.query<any>(
        `SELECT m.medication_id, m.brand_name, m.strength, m.unit_of_measure,
                COALESCE((SELECT sum(ib.quantity_on_hand - ib.quantity_reserved) FROM pharmacy.inventory_balances ib
                           JOIN pharmacy.batches b ON b.tenant_id = ib.tenant_id AND b.batch_id = ib.batch_id
                          WHERE ib.tenant_id = m.tenant_id AND b.medication_id = m.medication_id AND ib.location_id = $2), 0) AS on_hand,
                equipment.last_unit_cost(m.tenant_id, m.medication_id) AS unit_cost
           FROM pharmacy.medications m WHERE m.tenant_id = $1 AND m.item_kind = 'supply' AND m.is_active ORDER BY m.brand_name`,
        [repo.tenantId, st?.location_id ?? null])).rows
        .map((x: any) => ({ medicationId: x.medication_id, name: x.brand_name, strength: x.strength, unit: x.unit_of_measure, onHand: num(x.on_hand), unitCost: Number(x.unit_cost) }));
      const items = (await repo.tdb.query<any>(
        `SELECT item_id, code, name, category, unit_price, is_active FROM finance.price_items WHERE tenant_id = $1 AND organization_id = $2 ORDER BY code`, [repo.tenantId, org])).rows;
      const norms = (await repo.tdb.query<any>(
        `SELECT item_id, medication_id, quantity, version FROM equipment.supply_norms WHERE tenant_id = $1 AND organization_id = $2`, [repo.tenantId, org])).rows;
      const cost = new Map(supplies.map((s) => [s.medicationId, s.unitCost]));
      const services = items.map((i: any) => {
        const lines = norms.filter((n: any) => n.item_id === i.item_id).map((n: any) => ({ medicationId: n.medication_id, quantity: num(n.quantity), version: num(n.version) }));
        const stdCost = lines.reduce((a: number, l: { medicationId: string; quantity: number }) => a + l.quantity * (cost.get(l.medicationId) ?? 0), 0);
        return { itemId: i.item_id, code: i.code, name: i.name, category: i.category, unitPrice: num(i.unit_price), isActive: i.is_active === true || i.is_active === 't', norms: lines, standardCost: Math.round(stdCost) };
      });
      const shortfalls = (await repo.tdb.query<any>(
        `SELECT c.consumption_id, c.medication_id, m.brand_name, m.unit_of_measure, c.quantity, c.cost, c.created_at, b.batch_number, c.charge_id IS NULL AS extra
           FROM equipment.supply_consumptions c JOIN pharmacy.medications m ON m.tenant_id = c.tenant_id AND m.medication_id = c.medication_id
           LEFT JOIN pharmacy.batches b ON b.tenant_id = c.tenant_id AND b.batch_id = c.batch_id
          WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.source = 'shortfall'
            AND NOT EXISTS (SELECT 1 FROM equipment.supply_shortfall_resolutions r WHERE r.tenant_id = c.tenant_id AND r.consumption_id = c.consumption_id)
          ORDER BY c.created_at DESC LIMIT 200`, [repo.tenantId, org])).rows
        .map((x: any) => ({ consumptionId: x.consumption_id, medicationId: x.medication_id, name: x.brand_name, unit: x.unit_of_measure, quantity: num(x.quantity),
          cost: Number(x.cost), batchNumber: x.batch_number ?? null, at: iso(x.created_at) }));
      const cogs = (await repo.tdb.query<any>(
        `SELECT i.code, i.name, count(DISTINCT c.case_id) AS cases, sum(c.cost) AS cost
           FROM equipment.supply_consumptions c LEFT JOIN finance.charges ch ON ch.tenant_id = c.tenant_id AND ch.charge_id = c.charge_id
           LEFT JOIN finance.price_items i ON i.tenant_id = ch.tenant_id AND i.item_id = ch.item_id
          WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.created_at > now() - interval '30 days'
          GROUP BY i.code, i.name ORDER BY sum(c.cost) DESC`, [repo.tenantId, org])).rows
        .map((x: any) => ({ code: x.code ?? null, name: x.name ?? 'Ghi thực tế ngoài định mức', cases: num(x.cases), cost: Math.round(Number(x.cost)) }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return {
        settings: { locationId: st?.location_id ?? null, version: st ? num(st.version) : 0 }, locations, supplies, services, shortfalls, cogsLast30: cogs,
        canManage: this.allowed(g, p.user, 'supply:manage'), canRecall: this.allowed(g, p.user, 'supply:recall'),
      };
    });
  }

  async setSupplyLocation(input: { organizationId: unknown; locationId: unknown; version: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(input.organizationId, ctx);
    const loc = uuidIn(input.locationId, 'locationId', true);
    const version = intIn(input.version, 'version', 0, Number.MAX_SAFE_INTEGER)!;
    return this.run(ctx, 'supply.settings', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'supply:manage');
      try {
        const r = version === 0
          ? await repo.tdb.query(`INSERT INTO equipment.supply_settings (tenant_id, organization_id, location_id, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1`, [repo.tenantId, org, loc, p.user.userId])
          : await repo.tdb.query(`UPDATE equipment.supply_settings SET location_id = $3, updated_by = $4 WHERE tenant_id = $1 AND organization_id = $2 AND version = $5 RETURNING 1`, [repo.tenantId, org, loc, p.user.userId, version]);
        if (r.rows.length === 0) throw new ClinicalError('CONFLICT', 'Settings version does not match', { reason: 'VERSION_CONFLICT' });
      } catch (e) {
        if (['23514', '23503'].includes((e as { code?: string }).code ?? '')) throw new ClinicalError('VALIDATION', 'Location is not in this clinic', { reason: 'LOCATION_INVALID' });
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'supply.settings', 'success', p.user, { locationId: loc }, null, org));
      return { locationId: loc };
    });
  }

  async setNorm(input: { organizationId: unknown; itemId: unknown; medicationId: unknown; quantity: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(input.organizationId, ctx);
    const item = uuidIn(input.itemId, 'itemId')!;
    const med = uuidIn(input.medicationId, 'medicationId')!;
    const qty = intIn(input.quantity, 'quantity', 0, 1000)!;
    return this.run(ctx, 'supply.norm', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'supply:manage');
      try {
        const r = await repo.tdb.query(
          `INSERT INTO equipment.supply_norms (tenant_id, organization_id, item_id, medication_id, quantity, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, item_id, medication_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_by = EXCLUDED.updated_by
             WHERE equipment.supply_norms.organization_id = EXCLUDED.organization_id RETURNING 1`,
          [repo.tenantId, org, item, med, qty, p.user.userId],
        );
        if (r.rows.length === 0) throw new ClinicalError('NOT_FOUND', 'Price item not found');
      } catch (e) {
        const c = (e as { code?: string }).code;
        if (c === '23514') throw new ClinicalError('VALIDATION', 'Only consumable supplies can be in a norm', { reason: 'NOT_A_SUPPLY' });
        if (c === '23503') throw new ClinicalError('NOT_FOUND', 'Price item or supply not found');
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'supply.norm', 'success', p.user, { itemId: item, medicationId: med, quantity: qty }, item, org));
      return { itemId: item, medicationId: med, quantity: qty };
    });
  }

  /** Lô đã ghi cho hồ sơ đang mở của người bệnh + danh sách vật tư để chọn. */
  async patientLots(q: { organizationId: unknown; patientId: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(q.organizationId, ctx);
    const patient = uuidIn(q.patientId, 'patientId')!;
    return this.run(ctx, 'supply.lots.read', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      if (!this.allowed(g, p.user, 'supply:record')) this.need(g, p.user, 'supply:read');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const c = (await repo.tdb.query<any>(`SELECT case_id FROM finance.billing_cases WHERE tenant_id = $1 AND organization_id = $2 AND patient_id = $3 AND status = 'open'`, [repo.tenantId, org, patient])).rows[0];
      const lots = c ? (await repo.tdb.query<any>(
        `SELECT u.usage_id, m.brand_name, m.unit_of_measure, b.batch_number, b.expiry_date::text AS expiry, u.quantity, u.status, u.recorded_at, us.display_name AS recorded_by_name
           FROM equipment.supply_lot_usages u JOIN pharmacy.medications m ON m.tenant_id = u.tenant_id AND m.medication_id = u.medication_id
           JOIN pharmacy.batches b ON b.tenant_id = u.tenant_id AND b.batch_id = u.batch_id
           LEFT JOIN iam.users us ON us.tenant_id = u.tenant_id AND us.user_id = u.recorded_by
          WHERE u.tenant_id = $1 AND u.case_id = $2 ORDER BY u.recorded_at DESC`, [repo.tenantId, c.case_id])).rows.map((x: any) => ({
        usageId: x.usage_id, name: x.brand_name, unit: x.unit_of_measure, batchNumber: x.batch_number, expiry: dateOrNull(x.expiry), quantity: num(x.quantity), status: x.status,
        recordedAt: iso(x.recorded_at), recordedByName: x.recorded_by_name ?? null,
      })) : [];
      const supplies = (await repo.tdb.query<any>(`SELECT medication_id, brand_name, unit_of_measure FROM pharmacy.medications WHERE tenant_id = $1 AND item_kind = 'supply' AND is_active ORDER BY brand_name`, [repo.tenantId]))
        .rows.map((x: any) => ({ medicationId: x.medication_id, name: x.brand_name, unit: x.unit_of_measure }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return { caseOpen: Boolean(c), lots, supplies, canRecord: this.allowed(g, p.user, 'supply:record') };
    });
  }

  async recordLot(input: { organizationId: unknown; patientId: unknown; batchNumber: unknown; medicationId?: unknown; quantity: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(input.organizationId, ctx);
    const patient = uuidIn(input.patientId, 'patientId')!;
    const med = uuidIn(input.medicationId, 'medicationId', true);
    const lot = str(input.batchNumber, 1, 80, 'batchNumber');
    const qty = intIn(input.quantity, 'quantity', 1, 1000)!;
    return this.run(ctx, 'supply.lot.record', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'supply:record');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const c = (await repo.tdb.query<any>(`SELECT case_id FROM finance.billing_cases WHERE tenant_id = $1 AND organization_id = $2 AND patient_id = $3 AND status = 'open'`, [repo.tenantId, org, patient])).rows[0];
      if (!c) throw new ClinicalError('INVALID_STATE', 'Patient has no open billing case', { reason: 'NO_OPEN_CASE' });
      const batches = (await repo.tdb.query<any>(
        `SELECT b.batch_id, b.medication_id FROM pharmacy.batches b JOIN pharmacy.medications m ON m.tenant_id = b.tenant_id AND m.medication_id = b.medication_id
          WHERE b.tenant_id = $1 AND m.item_kind = 'supply' AND upper(b.batch_number) = upper($2) ${med ? 'AND b.medication_id = $3' : ''}`,
        med ? [repo.tenantId, lot, med] : [repo.tenantId, lot])).rows;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (batches.length === 0) throw new ClinicalError('NOT_FOUND', 'No supply batch with this number', { reason: 'BATCH_NOT_FOUND' });
      if (batches.length > 1) throw new ClinicalError('VALIDATION', 'Several supplies share this batch number: choose the supply', { reason: 'BATCH_AMBIGUOUS' });
      const r = await repo.tdb.query<{ usage_id: string }>(
        `INSERT INTO equipment.supply_lot_usages (tenant_id, organization_id, case_id, patient_id, medication_id, batch_id, quantity, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING usage_id`,
        [repo.tenantId, org, c.case_id, patient, batches[0].medication_id, batches[0].batch_id, qty, p.user.userId],
      );
      await repo.appendAudit({ ...this.event(ctx, 'supply.lot.record', 'success', p.user, { caseId: c.case_id, batchId: batches[0].batch_id, quantity: qty }, r.rows[0]!.usage_id, org), patientId: patient as never });
      return { usageId: r.rows[0]!.usage_id };
    });
  }

  async cancelLot(usageId: unknown, input: { reason: unknown }, ctx: TenantContext = requireTenantContext()) {
    const id = uuidIn(usageId, 'usageId')!;
    const reason = str(input.reason, 3, 300, 'reason');
    return this.run(ctx, 'supply.lot.cancel', async (repo) => {
      const u = (await repo.tdb.query<{ organization_id: string; patient_id: string; status: string }>(
        `SELECT organization_id, patient_id, status FROM equipment.supply_lot_usages WHERE tenant_id = $1 AND usage_id = $2`, [repo.tenantId, id])).rows[0];
      if (!u) throw new ClinicalError('NOT_FOUND', 'Lot record not found');
      const { p, g } = await this.at(repo, ctx, u.organization_id as OrganizationId);
      this.need(g, p.user, 'supply:record');
      if (u.status !== 'active') throw new ClinicalError('CONFLICT', 'Already cancelled', { reason: 'ALREADY_CANCELLED' });
      try {
        await repo.tdb.query(`UPDATE equipment.supply_lot_usages SET status = 'cancelled', cancelled_by = $3, cancelled_at = now(), cancel_reason = $4 WHERE tenant_id = $1 AND usage_id = $2`,
          [repo.tenantId, id, p.user.userId, reason]);
      } catch (e) {
        if ((e as { code?: string }).code === '55000') throw new ClinicalError('INVALID_STATE', 'Billing case is closed', { reason: 'CASE_NOT_OPEN' });
        throw e;
      }
      await repo.appendAudit({ ...this.event(ctx, 'supply.lot.cancel', 'success', p.user, { reason }, id, u.organization_id as OrganizationId), patientId: u.patient_id as never });
      return { usageId: id, status: 'cancelled' };
    });
  }

  async resolveShortfall(consumptionId: unknown, input: { note: unknown }, ctx: TenantContext = requireTenantContext()) {
    const id = uuidIn(consumptionId, 'consumptionId')!;
    const note = str(input.note, 5, 500, 'note');
    return this.run(ctx, 'supply.shortfall.resolve', async (repo) => {
      const c = (await repo.tdb.query<{ organization_id: string; source: string }>(`SELECT organization_id, source FROM equipment.supply_consumptions WHERE tenant_id = $1 AND consumption_id = $2`, [repo.tenantId, id])).rows[0];
      if (!c || c.source !== 'shortfall') throw new ClinicalError('NOT_FOUND', 'Shortfall not found');
      const { p, g } = await this.at(repo, ctx, c.organization_id as OrganizationId);
      this.need(g, p.user, 'supply:manage');
      try {
        await repo.tdb.query(`INSERT INTO equipment.supply_shortfall_resolutions (tenant_id, consumption_id, note, resolved_by) VALUES ($1, $2, $3, $4)`, [repo.tenantId, id, note, p.user.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ClinicalError('CONFLICT', 'Already resolved', { reason: 'ALREADY_RESOLVED' });
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'supply.shortfall.resolve', 'success', p.user, {}, id, c.organization_id as OrganizationId));
      return { consumptionId: id, resolved: true };
    });
  }

  /** Vật tư đã trừ + giá vốn của một hồ sơ thanh toán (màn hồ sơ thu ngân). */
  async caseSupplies(caseId: unknown, ctx: TenantContext = requireTenantContext()) {
    const id = uuidIn(caseId, 'caseId')!;
    return this.run(ctx, 'supply.case.read', async (repo) => {
      const c = (await repo.tdb.query<{ organization_id: string }>(`SELECT organization_id FROM finance.billing_cases WHERE tenant_id = $1 AND case_id = $2`, [repo.tenantId, id])).rows[0];
      if (!c) throw new ClinicalError('NOT_FOUND', 'Billing case not found');
      const { p, g } = await this.at(repo, ctx, c.organization_id as OrganizationId);
      this.need(g, p.user, 'supply:read');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const lines = (await repo.tdb.query<any>(
        `SELECT m.brand_name, m.unit_of_measure, b.batch_number, b.expiry_date::text AS expiry, c.quantity, c.unit_cost, c.cost, c.source, i.code AS item_code
           FROM equipment.supply_consumptions c JOIN pharmacy.medications m ON m.tenant_id = c.tenant_id AND m.medication_id = c.medication_id
           LEFT JOIN pharmacy.batches b ON b.tenant_id = c.tenant_id AND b.batch_id = c.batch_id
           LEFT JOIN finance.charges ch ON ch.tenant_id = c.tenant_id AND ch.charge_id = c.charge_id
           LEFT JOIN finance.price_items i ON i.tenant_id = ch.tenant_id AND i.item_id = ch.item_id
          WHERE c.tenant_id = $1 AND c.case_id = $2 ORDER BY i.code NULLS LAST, m.brand_name`, [repo.tenantId, id])).rows
        .map((x: any) => ({ name: x.brand_name, unit: x.unit_of_measure, batchNumber: x.batch_number ?? null, expiry: dateOrNull(x.expiry), quantity: num(x.quantity),
          unitCost: Number(x.unit_cost), cost: Math.round(Number(x.cost)), source: x.source, itemCode: x.item_code ?? null }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return { lines, cogs: lines.reduce((a, l) => a + l.cost, 0), shortfallQty: lines.filter((l) => l.source === 'shortfall').reduce((a, l) => a + l.quantity, 0) };
    });
  }

  /** Thu hồi lô: người bệnh đã dùng (đã tất toán) hoặc đã được ghi lô (hồ sơ còn mở). Có họ tên => bắt buộc lý do, ghi nhật ký. */
  async recall(input: { organizationId: unknown; batchNumber: unknown; medicationId?: unknown; reason: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = this.org(input.organizationId, ctx);
    const lot = str(input.batchNumber, 1, 80, 'batchNumber');
    const med = uuidIn(input.medicationId, 'medicationId', true);
    const reason = optStr(input.reason, 300, 'reason');
    if (reason === null || reason.length < 5) throw new ClinicalError('VALIDATION', 'State the reason (e.g. the recall notice number)', { reason: 'REASON_REQUIRED' });
    return this.run(ctx, 'supply.recall', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'supply:recall');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const rows = (await repo.tdb.query<any>(
        `WITH lots AS (
           SELECT b.batch_id, b.batch_number, b.expiry_date, m.brand_name FROM pharmacy.batches b JOIN pharmacy.medications m ON m.tenant_id = b.tenant_id AND m.medication_id = b.medication_id
            WHERE b.tenant_id = $1 AND m.item_kind = 'supply' AND upper(b.batch_number) = upper($3) ${med ? 'AND b.medication_id = $4' : ''})
         SELECT x.*, l.batch_number, l.expiry_date::text AS expiry, l.brand_name, pa.mrn, pe.family_name, pe.given_name, pe.erased_at, pe.processing_restricted_at
           FROM (
             SELECT c.batch_id, c.patient_id, c.case_id, sum(c.quantity) AS quantity, min(c.created_at) AS at,
                    CASE WHEN bool_or(c.source = 'recorded' OR c.usage_id IS NOT NULL) THEN 'recorded' ELSE 'fefo' END AS certainty, 'closed' AS case_status
               FROM equipment.supply_consumptions c WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.batch_id IN (SELECT batch_id FROM lots)
              GROUP BY c.batch_id, c.patient_id, c.case_id
             UNION ALL
             SELECT u.batch_id, u.patient_id, u.case_id, sum(u.quantity), min(u.recorded_at), 'recorded', 'open'
               FROM equipment.supply_lot_usages u JOIN finance.billing_cases bc ON bc.tenant_id = u.tenant_id AND bc.case_id = u.case_id AND bc.status = 'open'
              WHERE u.tenant_id = $1 AND u.organization_id = $2 AND u.status = 'active' AND u.batch_id IN (SELECT batch_id FROM lots)
              GROUP BY u.batch_id, u.patient_id, u.case_id) x
           JOIN lots l ON l.batch_id = x.batch_id
           JOIN patient.patients pa ON pa.tenant_id = $1 AND pa.patient_id = x.patient_id
           JOIN patient.persons pe ON pe.tenant_id = pa.tenant_id AND pe.person_id = pa.person_id
          ORDER BY x.at`,
        med ? [repo.tenantId, org, lot, med] : [repo.tenantId, org, lot])).rows;
      const out = rows.map((x: any) => ({
        patientId: x.patient_id, mrn: x.mrn, name: x.erased_at ? null : `${x.family_name ?? ''} ${x.given_name ?? ''}`.trim(), erased: Boolean(x.erased_at), restricted: Boolean(x.processing_restricted_at),
        supply: x.brand_name, batchNumber: x.batch_number, expiry: dateOrNull(x.expiry), quantity: num(x.quantity), at: iso(x.at),
        certainty: x.certainty as 'recorded' | 'fefo', caseStatus: x.case_status as 'open' | 'closed',
      }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
      await repo.appendAudit(this.event(ctx, 'supply.recall', 'success', p.user, { batchNumber: lot, medicationId: med, reason, patients: new Set(out.map((o) => o.patientId)).size }, null, org));
      return { batchNumber: lot, patients: out };
    });
  }

  // ---- nội bộ -------------------------------------------------------------------
  private org(v: unknown, ctx: TenantContext): OrganizationId {
    const o = uuidIn(v, 'organizationId')!;
    if (!ctx.allowedOrganizationIds.includes(o as OrganizationId)) throw new ClinicalError('FORBIDDEN', 'Organization not in token');
    return o as OrganizationId;
  }
  private async at(repo: GovRepo, ctx: TenantContext, org: OrganizationId): Promise<{ p: Principal; g: Awaited<ReturnType<Principal['at']>> }> {
    const p = await this.principal(repo, ctx);
    if (!ctx.allowedOrganizationIds.includes(org)) throw new ClinicalError('NOT_FOUND', 'Not found');
    return { p, g: await p.at(org) };
  }
  private async load(repo: GovRepo, ref: unknown): Promise<Device> {
    if (typeof ref !== 'string') throw new ClinicalError('VALIDATION', 'device must be an asset code or UUID');
    const byCode = !isUuid(ref);
    if (byCode && !validAssetCode(ref)) throw new ClinicalError('VALIDATION', 'Invalid asset code (format TByy-nnnn-c, check digit)', { reason: 'ASSET_CODE_INVALID' });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const r = await repo.tdb.query<any>(`${DEVICE_SQL} WHERE d.tenant_id = $1 AND ${byCode ? 'd.asset_code = upper($2)' : 'd.device_id = $2'}`, [repo.tenantId, byCode ? String(ref).trim() : String(ref).toLowerCase()]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (!r.rows[0]) throw new ClinicalError('NOT_FOUND', 'Device not found');
    return mapDevice(r.rows[0], vnToday(this.clock()));
  }
  private deviceFields(input: Record<string, unknown>, update = false) {
    const riskClass = input['riskClass'];
    if (!(RISK_CLASSES as readonly unknown[]).includes(riskClass)) throw new ClinicalError('VALIDATION', 'riskClass must be A, B, C or D');
    const cost = intIn(input['cost'], 'cost', 0, 100_000_000_000, true);
    const life = intIn(input['usefulLifeMonths'], 'usefulLifeMonths', 12, 600, true);
    const inService = dateIn(input['inServiceOn'], 'inServiceOn');
    if ((cost === null) !== (life === null) || (cost !== null && !inService)) {
      throw new ClinicalError('VALIDATION', 'Depreciation needs cost, usefulLifeMonths and inServiceOn together', { reason: 'DEPRECIATION_INCOMPLETE' });
    }
    const serial = optStr(input['serialNo'], 64, 'serialNo');
    if (serial !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{1,63}$/.test(serial)) throw new ClinicalError('VALIDATION', 'serialNo has invalid characters');
    return {
      typeId: uuidIn(input['typeId'], 'typeId')!,
      name: str(input['name'], 2, 200, 'name'),
      manufacturer: optStr(input['manufacturer'], 120, 'manufacturer'),
      model: optStr(input['model'], 120, 'model'),
      serialNo: serial,
      servicePointId: update ? undefined : uuidIn(input['servicePointId'], 'servicePointId', true),
      riskClass: riskClass as string,
      registrationNo: optStr(input['registrationNo'], 80, 'registrationNo'),
      warrantyUntil: dateIn(input['warrantyUntil'], 'warrantyUntil'),
      acquiredOn: dateIn(input['acquiredOn'], 'acquiredOn'),
      inServiceOn: inService,
      cost,
      usefulLifeMonths: life,
    };
  }
  private regimesIn(v: unknown): Array<{ regime: Regime; cycleMonths: number; mandatory: boolean }> {
    if (!Array.isArray(v) || v.length > REGIME_IDS.length) throw new ClinicalError('VALIDATION', 'regimes must be an array');
    const out = v.map((x: unknown) => {
      const o = (x ?? {}) as Record<string, unknown>;
      if (!(REGIME_IDS as readonly unknown[]).includes(o['regime'])) throw new ClinicalError('VALIDATION', `regime must be one of ${REGIME_IDS.join(', ')}`);
      if (typeof o['mandatory'] !== 'boolean') throw new ClinicalError('VALIDATION', 'mandatory must be a boolean');
      return { regime: o['regime'] as Regime, cycleMonths: intIn(o['cycleMonths'], 'cycleMonths', 1, 120)!, mandatory: o['mandatory'] };
    });
    if (new Set(out.map((r) => r.regime)).size !== out.length) throw new ClinicalError('VALIDATION', 'regimes must be distinct');
    return out;
  }
  private pgDeviceError(e: unknown): void {
    const c = (e as { code?: string }).code;
    if (c === '23505') throw new ClinicalError('CONFLICT', 'A device with this serial number already exists', { reason: 'SERIAL_TAKEN' });
    if (c === '23503') throw new ClinicalError('VALIDATION', 'Device type or room not found', { reason: 'REFERENCE_INVALID' });
    if (c === '23514') throw new ClinicalError('VALIDATION', (e as Error).message, { reason: 'DEVICE_INVALID' });
  }
}
