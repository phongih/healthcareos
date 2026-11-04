/**
 * HCOS-P0-ENG-001 | Tra trạng thái tenant từ PostgreSQL.
 * RLS cũng áp dụng cho iam.tenants nên phải đặt app.tenant_id trước khi SELECT (withTenantTransaction làm việc đó).
 * Tenant không tồn tại => không thấy dòng nào => null (fail-closed ở buildTenantContext).
 */
import type { TenantContext, TenantId } from '../../domain/src/s0-contracts';
import { withTenantTransaction, type PgPoolLike, type TenantStatusLookup } from './tenant-context';

type Status = 'provisioning' | 'active' | 'suspended' | 'closed';
const STATUSES: ReadonlySet<string> = new Set<Status>(['provisioning', 'active', 'suspended', 'closed']);

export class PgTenantStatusLookup implements TenantStatusLookup {
  constructor(private readonly pool: PgPoolLike) {}

  async getStatus(tenantId: TenantId): Promise<Status | null> {
    const ctx = { tenantId } as unknown as TenantContext;
    return withTenantTransaction(
      this.pool,
      async (db) => {
        const r = await db.query<{ status: string }>('SELECT status FROM iam.tenants WHERE tenant_id = $1', [tenantId]);
        const s = r.rows[0]?.status;
        return s !== undefined && STATUSES.has(s) ? (s as Status) : null;
      },
      ctx,
    );
  }
}
