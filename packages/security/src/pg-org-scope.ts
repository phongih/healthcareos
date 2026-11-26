/**
 * Phạm vi cơ sở theo từng user, lấy từ PostgreSQL (thay cho claim org_ids cố định của IdP).
 *  - user: iam.users theo (tenant, external_subject = sub), trạng thái 'active';
 *  - cơ sở: các membership 'active' còn trong hiệu lực (valid_from <= now < valid_to) tại cơ sở 'active';
 *  - tenant_admin: mọi cơ sở 'active' của tenant (quyền cụ thể vẫn do membership / policy ở từng service quyết định).
 * Cache ngắn (mặc định 30 giây) để không truy vấn mỗi request; thu hồi membership có hiệu lực chậm nhất sau TTL.
 */
import { asOrganizationId, asTenantId, asUserId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../domain/src/s0-contracts';
import { withTenantTransaction, type OrgScopeLookup, type PgPoolLike } from './tenant-context';

type Scope = { readonly userId: UserId; readonly organizationIds: readonly OrganizationId[] } | null;

export class PgOrgScopeLookup implements OrgScopeLookup {
  private readonly cache = new Map<string, { at: number; scope: Scope }>();
  constructor(
    private readonly pool: PgPoolLike,
    private readonly opts: { ttlMs?: number; maxEntries?: number; clock?: () => number } = {},
  ) {}

  async tenantsFor(subject: string): Promise<readonly TenantId[]> {
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT t FROM iam.tenants_for_subject($1) AS t', [subject]);
      return (r.rows as Array<{ t: string }>).map((x) => asTenantId(x.t));
    } finally {
      client.release();
    }
  }

  async scopeFor(tenantId: TenantId, subject: string): Promise<Scope> {
    const now = (this.opts.clock ?? Date.now)();
    const key = `${tenantId}|${subject}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.opts.ttlMs ?? 30_000)) return hit.scope;
    const scope = await withTenantTransaction(
      this.pool,
      async (db) => {
        const r = await db.query<{ user_id: string; orgs: string[] | string | null }>(
          `SELECT u.user_id,
                  CASE WHEN bool_or(m.role = 'tenant_admin')
                       THEN (SELECT array_agg(o.organization_id ORDER BY o.code) FROM iam.organizations o WHERE o.tenant_id = u.tenant_id AND o.status = 'active')
                       ELSE array_agg(DISTINCT m.organization_id) FILTER (WHERE o2.status = 'active')
                  END AS orgs
             FROM iam.users u
             JOIN iam.memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.user_id
                                   AND m.status = 'active' AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
             JOIN iam.organizations o2 ON o2.tenant_id = m.tenant_id AND o2.organization_id = m.organization_id
            WHERE u.tenant_id = $1 AND u.external_subject = $2 AND u.status = 'active'
            GROUP BY u.user_id, u.tenant_id`,
          [tenantId, subject],
        );
        const row = r.rows[0];
        if (!row) return null;
        const orgs = Array.isArray(row.orgs) ? row.orgs : typeof row.orgs === 'string' ? row.orgs.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [];
        return { userId: asUserId(row.user_id), organizationIds: Object.freeze(orgs.map((o) => asOrganizationId(o))) };
      },
      { tenantId } as unknown as TenantContext,
    );
    if (this.cache.size >= (this.opts.maxEntries ?? 5000)) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: now, scope });
    return scope;
  }

  /** Xoá cache (vd. ngay sau khi đổi membership trong cùng tiến trình). */
  invalidate(tenantId?: TenantId): void {
    if (!tenantId) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}|`)) this.cache.delete(k);
  }
}
