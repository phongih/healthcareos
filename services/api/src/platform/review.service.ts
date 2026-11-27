/**
 * HCOS | Màn duyệt tổ chức (thiết kế 27/11/2026, mục 4).
 * Người vận hành (platform.operators) xem tổ chức chờ duyệt, rồi duyệt hoặc từ chối kèm lý do.
 * Quyền được kiểm tra trong hàm SECURITY DEFINER của DB (platform.review_list / review_decide), không chỉ ở đây.
 */
import type { PgPoolLike } from '../../../../packages/security/src/tenant-context';

export type ReviewErrorCode = 'NOT_OPERATOR' | 'NOT_PENDING' | 'INVALID_DECISION' | 'NOTE_REQUIRED' | 'INVALID_INPUT';

export class ReviewError extends Error {
  constructor(readonly code: ReviewErrorCode) {
    super(code);
    this.name = 'ReviewError';
  }
}

export interface PendingTenant {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly businessLicenseNo: string | null;
  readonly contactPhone: string | null;
  readonly adminName: string | null;
  readonly adminEmail: string | null;
  readonly createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODES: readonly ReviewErrorCode[] = ['NOT_OPERATOR', 'INVALID_DECISION', 'NOTE_REQUIRED'];

function mapPg(e: unknown): unknown {
  const msg = (e as { message?: string })?.message ?? '';
  for (const c of CODES) if (msg.includes(c)) return new ReviewError(c);
  return e;
}

export interface PlatformReviewDeps {
  readonly pool: PgPoolLike;
}

export class PlatformReviewService {
  constructor(private readonly deps: PlatformReviewDeps) {}

  async listPending(operatorSub: string): Promise<PendingTenant[]> {
    const client = await this.deps.pool.connect();
    try {
      const r = await client.query(
        'SELECT tenant_id, name, slug, business_license_no, contact_phone, admin_name, admin_email, created_at FROM platform.review_list($1)',
        [operatorSub],
      );
      return (r.rows as Array<Record<string, unknown>>).map((row) => ({
        tenantId: String(row['tenant_id']),
        name: String(row['name']),
        slug: String(row['slug']),
        businessLicenseNo: (row['business_license_no'] as string | null) ?? null,
        contactPhone: (row['contact_phone'] as string | null) ?? null,
        adminName: (row['admin_name'] as string | null) ?? null,
        adminEmail: (row['admin_email'] as string | null) ?? null,
        createdAt: new Date(row['created_at'] as string | Date).toISOString(),
      }));
    } catch (e) {
      throw mapPg(e);
    } finally {
      client.release();
    }
  }

  /** Trả 'OK' khi đã duyệt / từ chối; 'NOT_PENDING' khi tổ chức không còn chờ duyệt. */
  async decide(operatorSub: string, tenantId: string, decision: string, note: string | null): Promise<'OK' | 'NOT_PENDING'> {
    if (!UUID_RE.test(tenantId)) throw new ReviewError('INVALID_INPUT');
    if (decision !== 'approve' && decision !== 'reject') throw new ReviewError('INVALID_DECISION');
    const client = await this.deps.pool.connect();
    try {
      const r = await client.query('SELECT platform.review_decide($1, $2, $3, $4) AS result', [operatorSub, tenantId, decision, note]);
      const result = (r.rows[0] as { result: string } | undefined)?.result;
      return result === 'OK' ? 'OK' : 'NOT_PENDING';
    } catch (e) {
      throw mapPg(e);
    } finally {
      client.release();
    }
  }
}
