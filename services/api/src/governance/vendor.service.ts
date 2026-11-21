/**
 * HCOS-F18 | Sổ nhà cung cấp (bên thứ ba nhận / xử lý dữ liệu) và đánh giá.
 *
 *   Xem (vendor:read)      quản lý PK, ban giám đốc, quản trị — kể cả để chọn nhà cung cấp khi tạo kết nối ngoài.
 *   Quản lý (vendor:manage) quản trị hệ thống: thêm nhà cung cấp, ghi đánh giá (duyệt / từ chối / thu hồi), tạm ngừng / chấm dứt.
 * Đánh giá chỉ-thêm: muốn thu hồi thì ghi đánh giá 'rejected' mới. Kết nối ngoài chỉ gửi khi đánh giá MỚI NHẤT là 'approved',
 * còn hiệu lực và cho phép loại dữ liệu 'operational' (kiểm tra trong CSDL lúc xếp hàng và lúc gửi).
 * Nhà chủ quản dữ liệu vẫn chịu trách nhiệm: sổ này là bằng chứng đã đánh giá, không chuyển giao trách nhiệm.
 */
import { isUuid, type AuditSink, type Role, type TenantContext } from '../../../../packages/domain/src/s0-contracts';
import { requireTenantContext, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, num } from '../clinical/encounter.service';
import { GovernanceBase, optStr, str, type GovRepo } from './governance-base';

type Permission = 'vendor:read' | 'vendor:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'vendor:read': ['clinic_admin', 'executive', 'tenant_admin'],
  'vendor:manage': ['tenant_admin'],
};

export const VENDOR_KINDS = ['cloud_hosting', 'messaging', 'webhook_partner', 'ai_service', 'software', 'other'] as const;
export const VENDOR_ROLES = ['processor', 'sub_processor', 'third_party'] as const;
export const DATA_CATEGORIES = ['operational', 'backup_encrypted', 'personal', 'health'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export interface VendorAssessment {
  readonly assessmentId: string;
  readonly decision: 'approved' | 'rejected';
  readonly dpaReference: string | null;
  readonly dataCategories: DataCategory[];
  readonly dataLocation: string;
  readonly crossBorder: boolean;
  readonly measures: string;
  readonly rationale: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly assessedByName: string | null;
  readonly assessedAt: string;
}
export interface Vendor {
  readonly vendorId: string;
  readonly name: string;
  readonly kind: VendorKind;
  readonly role: (typeof VENDOR_ROLES)[number];
  readonly services: string;
  readonly contact: string | null;
  readonly status: 'active' | 'suspended' | 'terminated';
  readonly statusNote: string | null;
  readonly version: number;
  readonly latest: VendorAssessment | null;
  /** Trạng thái hiệu lực: được gửi dữ liệu vận hành ngay bây giờ? */
  readonly clearedOperational: boolean;
  /** 'approved' | 'expiring' (≤ 30 ngày) | 'expired' | 'rejected' | 'not_assessed' | 'inactive' */
  readonly standing: 'approved' | 'expiring' | 'expired' | 'rejected' | 'not_assessed' | 'inactive';
  readonly endpoints: number;
  readonly createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);
const bool = (v: unknown) => v === true || v === 't';
const mapAssessment = (x: any): VendorAssessment => ({
  assessmentId: x.assessment_id, decision: x.decision, dpaReference: x.dpa_reference ?? null, dataCategories: arr(x.data_categories) as DataCategory[],
  dataLocation: x.data_location, crossBorder: bool(x.cross_border), measures: x.measures, rationale: x.rationale, validFrom: String(x.valid_from).slice(0, 10),
  validUntil: String(x.valid_until).slice(0, 10), assessedByName: x.assessed_by_name ?? null, assessedAt: iso(x.assessed_at),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class VendorService extends GovernanceBase<Permission> {
  constructor(deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    super(deps, PERMISSIONS, 'Vendor');
  }

  async list(ctx: TenantContext = requireTenantContext()): Promise<{ vendors: Vendor[]; canManage: boolean }> {
    return this.run(ctx, 'vendor.read', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'vendor:read');
      return { vendors: await this.load(repo), canManage: this.allowed(p.grants, p.user, 'vendor:manage') };
    });
  }

  async assessments(vendorId: unknown, ctx: TenantContext = requireTenantContext()): Promise<VendorAssessment[]> {
    const id = this.uuid(vendorId);
    return this.run(ctx, 'vendor.assessments.read', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'vendor:read');
      const r = await repo.tdb.query(
        `SELECT a.*, a.valid_from::text AS valid_from, a.valid_until::text AS valid_until, u.display_name AS assessed_by_name FROM governance.vendor_assessments a LEFT JOIN iam.users u ON u.tenant_id = a.tenant_id AND u.user_id = a.assessed_by
          WHERE a.tenant_id = $1 AND a.vendor_id = $2 ORDER BY a.assessed_at DESC`,
        [repo.tenantId, id],
      );
      return r.rows.map(mapAssessment);
    });
  }

  async create(input: { name: unknown; kind: unknown; role: unknown; services: unknown; contact?: unknown }, ctx: TenantContext = requireTenantContext()): Promise<Vendor> {
    const name = str(input.name, 2, 200, 'name');
    const services = str(input.services, 3, 500, 'services');
    const contact = optStr(input.contact, 300, 'contact');
    if (!(VENDOR_KINDS as readonly unknown[]).includes(input.kind)) throw new ClinicalError('VALIDATION', `kind must be one of ${VENDOR_KINDS.join(', ')}`);
    if (!(VENDOR_ROLES as readonly unknown[]).includes(input.role)) throw new ClinicalError('VALIDATION', `role must be one of ${VENDOR_ROLES.join(', ')}`);
    return this.run(ctx, 'vendor.create', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'vendor:manage');
      let id: string;
      try {
        const r = await repo.tdb.query<{ vendor_id: string }>(
          `INSERT INTO governance.vendors (tenant_id, name, kind, role, services, contact, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING vendor_id`,
          [repo.tenantId, name, input.kind, input.role, services, contact, p.user.userId],
        );
        id = r.rows[0]!.vendor_id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ClinicalError('CONFLICT', 'A vendor with this name already exists', { reason: 'VENDOR_NAME_TAKEN' });
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'vendor.create', 'success', p.user, { name, kind: input.kind, role: input.role }, id));
      return (await this.load(repo, id))[0]!;
    });
  }

  async assess(
    vendorId: unknown,
    input: { decision: unknown; dpaReference?: unknown; dataCategories: unknown; dataLocation: unknown; crossBorder: unknown; measures: unknown; rationale: unknown; validFrom: unknown; validUntil: unknown },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<Vendor> {
    const id = this.uuid(vendorId);
    if (input.decision !== 'approved' && input.decision !== 'rejected') throw new ClinicalError('VALIDATION', "decision must be 'approved' or 'rejected'");
    const cats = input.dataCategories;
    if (!Array.isArray(cats) || cats.length < 1 || cats.some((c) => !(DATA_CATEGORIES as readonly unknown[]).includes(c)) || new Set(cats).size !== cats.length) {
      throw new ClinicalError('VALIDATION', `dataCategories must be distinct values of ${DATA_CATEGORIES.join(', ')}`);
    }
    const dpa = optStr(input.dpaReference, 200, 'dpaReference');
    if (input.decision === 'approved' && (dpa === null || dpa.length < 3)) throw new ClinicalError('VALIDATION', 'Approval needs a data processing agreement reference', { reason: 'DPA_REQUIRED' });
    const location = str(input.dataLocation, 2, 200, 'dataLocation');
    if (typeof input.crossBorder !== 'boolean') throw new ClinicalError('VALIDATION', 'crossBorder must be a boolean');
    const measures = str(input.measures, 20, 4000, 'measures');
    const rationale = str(input.rationale, 10, 4000, 'rationale');
    const date = (v: unknown, f: string) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new ClinicalError('VALIDATION', `${f} must be YYYY-MM-DD`);
      return v;
    };
    const from = date(input.validFrom, 'validFrom');
    const until = date(input.validUntil, 'validUntil');
    const days = (Date.parse(until) - Date.parse(from)) / 86_400_000;
    if (days <= 0 || days > 1096) throw new ClinicalError('VALIDATION', 'Validity must be at most 3 years', { reason: 'ASSESSMENT_VALIDITY' });
    return this.run(ctx, 'vendor.assess', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'vendor:manage');
      const v = (await this.load(repo, id))[0];
      if (!v) throw new ClinicalError('NOT_FOUND', 'Vendor not found');
      if (v.status === 'terminated') throw new ClinicalError('CONFLICT', 'Vendor is terminated', { reason: 'VENDOR_TERMINATED' });
      if (v.kind === 'ai_service' && input.decision === 'approved' && (cats as string[]).some((c) => c === 'personal' || c === 'health')) {
        throw new ClinicalError('VALIDATION', 'AI services may not receive personal or health data', { reason: 'AI_NO_PATIENT_DATA' });
      }
      await repo.tdb.query(
        `INSERT INTO governance.vendor_assessments (tenant_id, vendor_id, decision, dpa_reference, data_categories, data_location, cross_border, measures, rationale, valid_from, valid_until, assessed_by)
         VALUES ($1, $2, $3, $4, ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6, $7, $8, $9, $10, $11, $12)`,
        [repo.tenantId, id, input.decision, dpa, JSON.stringify(cats), location, input.crossBorder, measures, rationale, from, until, p.user.userId],
      );
      await repo.appendAudit(this.event(ctx, 'vendor.assess', 'success', p.user, { decision: input.decision, dataCategories: cats, validUntil: until, crossBorder: input.crossBorder }, id));
      return (await this.load(repo, id))[0]!;
    });
  }

  async setStatus(vendorId: unknown, input: { status: unknown; note?: unknown; version: unknown }, ctx: TenantContext = requireTenantContext()): Promise<Vendor> {
    const id = this.uuid(vendorId);
    if (!['active', 'suspended', 'terminated'].includes(input.status as string)) throw new ClinicalError('VALIDATION', 'status must be active, suspended or terminated');
    const note = optStr(input.note, 500, 'note');
    if (input.status !== 'active' && (note === null || note.length < 5)) throw new ClinicalError('VALIDATION', 'A reason is required', { reason: 'REASON_REQUIRED' });
    if (!Number.isInteger(input.version)) throw new ClinicalError('VALIDATION', 'version is required');
    return this.run(ctx, 'vendor.status', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'vendor:manage');
      let ok: boolean;
      try {
        const r = await repo.tdb.query(
          `UPDATE governance.vendors SET status = $3, status_note = $4, updated_by = $5 WHERE tenant_id = $1 AND vendor_id = $2 AND version = $6 RETURNING 1`,
          [repo.tenantId, id, input.status, note, p.user.userId, input.version],
        );
        ok = r.rows.length > 0;
      } catch (e) {
        if ((e as { code?: string }).code === '55000') throw new ClinicalError('CONFLICT', 'Terminated vendor cannot be reactivated', { reason: 'VENDOR_TERMINATED' });
        throw e;
      }
      if (!ok) throw new ClinicalError('CONFLICT', 'Vendor version does not match', { reason: 'VERSION_CONFLICT' });
      await repo.appendAudit(this.event(ctx, 'vendor.status', 'success', p.user, { status: input.status }, id));
      return (await this.load(repo, id))[0]!;
    });
  }

  // ---- nội bộ -------------------------------------------------------------------
  private uuid(v: unknown): string {
    if (typeof v !== 'string' || !isUuid(v)) throw new ClinicalError('VALIDATION', 'vendorId must be a UUID');
    return v.toLowerCase();
  }
  private async load(repo: GovRepo, id?: string): Promise<Vendor[]> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const r = await repo.tdb.query<any>(
      `SELECT v.*, governance.vendor_cleared(v.vendor_id, 'operational') AS cleared,
              (SELECT count(*) FROM integration.endpoints e WHERE e.tenant_id = v.tenant_id AND e.vendor_id = v.vendor_id AND e.status <> 'retired') AS endpoints,
              (SELECT row_to_json(x) FROM (SELECT a.*, u.display_name AS assessed_by_name FROM governance.vendor_assessments a
                                            LEFT JOIN iam.users u ON u.tenant_id = a.tenant_id AND u.user_id = a.assessed_by
                                           WHERE a.tenant_id = v.tenant_id AND a.vendor_id = v.vendor_id ORDER BY a.assessed_at DESC LIMIT 1) x) AS latest,
              (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS today
         FROM governance.vendors v WHERE v.tenant_id = $1 ${id ? 'AND v.vendor_id = $2' : ''} ORDER BY (v.status = 'terminated'), lower(v.name)`,
      id ? [repo.tenantId, id] : [repo.tenantId],
    );
    return r.rows.map((x: any) => {
      const latestRaw = typeof x.latest === 'string' ? JSON.parse(x.latest) : x.latest;
      const latest = latestRaw ? mapAssessment(latestRaw) : null;
      const today = String(x.today instanceof Date ? x.today.toISOString() : x.today).slice(0, 10);
      const standing: Vendor['standing'] =
        x.status !== 'active' ? 'inactive'
          : !latest ? 'not_assessed'
            : latest.decision === 'rejected' ? 'rejected'
              : latest.validUntil <= today || latest.validFrom > today ? 'expired'
                : (Date.parse(latest.validUntil) - Date.parse(today)) / 86_400_000 <= 30 ? 'expiring' : 'approved';
      return {
        vendorId: x.vendor_id, name: x.name, kind: x.kind, role: x.role, services: x.services, contact: x.contact ?? null, status: x.status, statusNote: x.status_note ?? null,
        version: num(x.version), latest, clearedOperational: bool(x.cleared), standing, endpoints: num(x.endpoints), createdAt: iso(x.created_at),
      };
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}
