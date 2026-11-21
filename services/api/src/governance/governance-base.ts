/**
 * Khung dùng chung cho các service quản trị dữ liệu cấp chủ quản (F18): người gọi, quyền, audit, transaction.
 */
import { randomUUID } from 'node:crypto';

import {
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
import { assertSameTenant, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, PgClinicalRepository } from '../clinical/encounter.service';

export class GovRepo extends PgClinicalRepository {
  constructor(readonly tdb: TenantScopedDb) {
    super(tdb);
  }
  get tenantId(): string {
    return this.tdb.tenantId;
  }
}

export interface Principal {
  readonly user: User;
  /** Quyền gộp mọi cơ sở (quản trị cấp chủ quản). */
  readonly grants: readonly AccessGrant[];
  /** Quyền tại một cơ sở cụ thể (chỉ cơ sở có trong token). */
  readonly at: (org: OrganizationId) => Promise<readonly AccessGrant[]>;
}

export class GovernanceBase<P extends string> {
  protected readonly clock: () => Date;
  constructor(
    protected readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date },
    private readonly perms: Readonly<Record<P, readonly Role[]>>,
    private readonly resourceType: string,
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  protected async principal(repo: GovRepo, ctx: TenantContext): Promise<Principal> {
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
      at: (org) => buildGrants(valid.filter((m) => m.organizationId === org && ctx.allowedOrganizationIds.includes(org)), user.tenantId, load),
    };
  }
  protected allowed(grants: readonly AccessGrant[], user: User, perm: P): boolean {
    return decideAccess(grants, perm as unknown as PolicyAction, this.base(perm), { callerUserId: user.userId }).allowed;
  }
  protected need(grants: readonly AccessGrant[], user: User, perm: P): void {
    const d = decideAccess(grants, perm as unknown as PolicyAction, this.base(perm), { callerUserId: user.userId });
    if (!d.allowed) {
      throw d.reason === 'ROLE' ? new ClinicalError('FORBIDDEN', `Missing permission ${perm}`) : new ClinicalError('FORBIDDEN', `Access policy does not permit ${perm}`, { reason: 'ACCESS_POLICY' });
    }
  }
  private base(perm: P): readonly Role[] {
    return this.perms[ACCESS_POLICY_CATALOG[perm as unknown as PolicyAction].basePermission as unknown as P];
  }
  protected event(
    ctx: TenantContext, action: string, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>,
    resourceId: string | null = null, org: OrganizationId | null = null,
  ): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject }, organizationId: org, action,
      resourceType: this.resourceType, resourceId, personId: null, patientId: null, outcome, correlationId: ctx.correlationId as CorrelationId,
      sourceIp: null, userAgent: null, payload,
    };
  }
  protected async run<T>(ctx: TenantContext, action: string, fn: (repo: GovRepo) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(this.deps.pool, async (db) => fn(new GovRepo(db)), ctx);
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

export const str = (v: unknown, min: number, max: number, field: string): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw new ClinicalError('VALIDATION', `${field} must be ${min}–${max} characters`);
  return v.trim();
};
export const optStr = (v: unknown, max: number, field: string): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string' || v.trim().length > max) throw new ClinicalError('VALIDATION', `${field} must be at most ${max} characters`);
  return v.trim();
};
