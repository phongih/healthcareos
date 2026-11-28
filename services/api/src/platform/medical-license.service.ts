/**
 * HCOS | Giấy phép khám chữa bệnh (migration 031; thiết kế 27/11/2026, mục 1 và 4).
 *  - tenant_admin nộp hoặc nộp lại số giấy phép (sau khi tổ chức đã được duyệt đăng ký).
 *  - Người vận hành xem danh sách chờ và duyệt / từ chối kèm lý do.
 * Quyền được kiểm tra trong hàm SECURITY DEFINER của DB, không chỉ ở đây.
 */
import type { PgPoolLike } from '../../../../packages/security/src/tenant-context';

export type LicenseErrorCode =
  | 'NOT_TENANT_ADMIN'
  | 'TENANT_NOT_ACTIVE'
  | 'ALREADY_APPROVED'
  | 'INVALID_LICENSE_NO'
  | 'NOT_OPERATOR'
  | 'INVALID_DECISION'
  | 'NOTE_REQUIRED'
  | 'INVALID_INPUT';

export class LicenseError extends Error {
  constructor(readonly code: LicenseErrorCode) {
    super(code);
    this.name = 'LicenseError';
  }
}

export type LicenseStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface LicenseState {
  readonly status: LicenseStatus;
  readonly licenseNo: string | null;
  readonly note: string | null;
  readonly submittedAt: string | null;
}

export interface PendingLicense {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly medicalLicenseNo: string;
  readonly contactPhone: string | null;
  readonly submittedAt: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODES: readonly LicenseErrorCode[] = [
  'NOT_TENANT_ADMIN', 'TENANT_NOT_ACTIVE', 'ALREADY_APPROVED', 'INVALID_LICENSE_NO', 'NOT_OPERATOR', 'INVALID_DECISION', 'NOTE_REQUIRED',
];

function mapPg(e: unknown): unknown {
  const msg = (e as { message?: string })?.message ?? '';
  for (const c of CODES) if (msg.includes(c)) return new LicenseError(c);
  return e;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

export interface MedicalLicenseDeps {
  readonly pool: PgPoolLike;
}

export class MedicalLicenseService {
  constructor(private readonly deps: MedicalLicenseDeps) {}

  async getState(subject: string, tenantId: string): Promise<LicenseState> {
    if (!UUID_RE.test(tenantId)) throw new LicenseError('INVALID_INPUT');
    const client = await this.deps.pool.connect();
    try {
      const r = await client.query('SELECT status, license_no, note, submitted_at FROM iam.medical_license_state($1, $2)', [subject, tenantId]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new LicenseError('NOT_TENANT_ADMIN');
      return {
        status: String(row['status']) as LicenseStatus,
        licenseNo: (row['license_no'] as string | null) ?? null,
        note: (row['note'] as string | null) ?? null,
        submittedAt: iso(row['submitted_at']),
      };
    } catch (e) {
      throw mapPg(e);
    } finally {
      client.release();
    }
  }

  /** Nộp hoặc nộp lại số giấy phép. Trả 'OK'. */
  async submit(subject: string, tenantId: string, licenseNo: string): Promise<'OK'> {
    if (!UUID_RE.test(tenantId)) throw new LicenseError('INVALID_INPUT');
    const client = await this.deps.pool.connect();
    try {
      await client.query('SELECT iam.submit_medical_license($1, $2, $3) AS result', [subject, tenantId, licenseNo.trim()]);
      return 'OK';
    } catch (e) {
      throw mapPg(e);
    } finally {
      client.release();
    }
  }

  async listPending(operatorSub: string): Promise<PendingLicense[]> {
    const client = await this.deps.pool.connect();
    try {
      const r = await client.query(
        'SELECT tenant_id, name, slug, medical_license_no, contact_phone, submitted_at FROM platform.license_list($1)',
        [operatorSub],
      );
      return (r.rows as Array<Record<string, unknown>>).map((row) => ({
        tenantId: String(row['tenant_id']),
        name: String(row['name']),
        slug: String(row['slug']),
        medicalLicenseNo: String(row['medical_license_no']),
        contactPhone: (row['contact_phone'] as string | null) ?? null,
        submittedAt: iso(row['submitted_at']),
      }));
    } catch (e) {
      throw mapPg(e);
    } finally {
      client.release();
    }
  }

  /** Trả 'OK' khi đã duyệt / từ chối; 'NOT_PENDING' khi không còn chờ duyệt. */
  async decide(operatorSub: string, tenantId: string, decision: string, note: string | null): Promise<'OK' | 'NOT_PENDING'> {
    if (!UUID_RE.test(tenantId)) throw new LicenseError('INVALID_INPUT');
    if (decision !== 'approve' && decision !== 'reject') throw new LicenseError('INVALID_DECISION');
    const client = await this.deps.pool.connect();
    try {
      const r = await client.query('SELECT platform.license_decide($1, $2, $3, $4) AS result', [operatorSub, tenantId, decision, note]);
      const result = (r.rows[0] as { result: string } | undefined)?.result;
      return result === 'OK' ? 'OK' : 'NOT_PENDING';
    } catch (e) {
      throw mapPg(e);
    } finally {
      client.release();
    }
  }
}
