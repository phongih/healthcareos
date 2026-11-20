/**
 * HCOS-F13 | Cài đặt mã bệnh nhân theo cơ sở: tiền tố mã tự sinh, cho / không cho nhập mã cũ.
 *   Đọc: ai đăng ký được bệnh nhân (patient:register) — để form biết có hiện ô "Dùng mã cũ" không.
 *   Sửa: quản lý phòng khám / quản trị (patient:configure).
 */
import { randomUUID } from 'node:crypto';

import {
  isUuid,
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
import { formatAutoMrn, readMrnSettings } from './mrn';

export interface MrnSettingsView {
  readonly prefix: string;
  readonly allowLegacy: boolean;
  readonly version: number;
  /** Mã sẽ cấp tiếp theo nếu không ai đăng ký trước (chỉ để hiển thị, không giữ chỗ). */
  readonly nextPreview: string;
  readonly example: string;
}

type Permission = 'patient:register' | 'patient:configure';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'patient:register': ['clinic_staff', 'clinic_admin', 'doctor', 'tenant_admin'],
  'patient:configure': ['clinic_admin', 'tenant_admin'],
};

class Repo extends PgClinicalRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }
  settings(org: OrganizationId) {
    return readMrnSettings(this.db, this.t, org);
  }
  async nextValue(org: OrganizationId, yy: number): Promise<number> {
    const r = await this.db.query<{ v: string | number }>(
      'SELECT COALESCE((SELECT last_value FROM patient.mrn_counters WHERE tenant_id = $1 AND organization_id = $2 AND year = $3), 0) + 1 AS v',
      [this.t, org, yy],
    );
    return Number(r.rows[0]!.v);
  }
  async upsert(org: OrganizationId, prefix: string, allowLegacy: boolean, by: string, expectedVersion: number): Promise<boolean> {
    if (expectedVersion === 0) {
      const r = await this.db.query(
        `INSERT INTO patient.mrn_settings (tenant_id, organization_id, prefix, allow_legacy, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, organization_id) DO NOTHING RETURNING 1`,
        [this.t, org, prefix, allowLegacy, by],
      );
      return r.rows.length > 0;
    }
    const r = await this.db.query(
      `UPDATE patient.mrn_settings SET prefix = $3, allow_legacy = $4, updated_by = $5, updated_at = now()
        WHERE tenant_id = $1 AND organization_id = $2 AND version = $6 RETURNING 1`,
      [this.t, org, prefix, allowLegacy, by, expectedVersion],
    );
    return r.rows.length > 0;
  }
}

export class MrnSettingsService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async get(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<MrnSettingsView> {
    return this.run(ctx, 'patient.mrn_settings.read', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      await this.check(repo, ctx, org, 'patient:register');
      return this.view(repo, org);
    });
  }

  async update(organizationId: string, input: { prefix: unknown; allowLegacy: unknown }, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<MrnSettingsView> {
    return this.run(ctx, 'patient.mrn_settings.update', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      const user = await this.check(repo, ctx, org, 'patient:configure');
      if (typeof input.prefix !== 'string' || !/^[A-Z]{1,4}$/.test(input.prefix)) throw new ClinicalError('VALIDATION', 'prefix must be 1–4 uppercase letters A–Z', { reason: 'INVALID_PREFIX' });
      if (typeof input.allowLegacy !== 'boolean') throw new ClinicalError('VALIDATION', 'allowLegacy must be a boolean');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new ClinicalError('VALIDATION', 'Invalid version');
      if (!(await repo.upsert(org, input.prefix, input.allowLegacy, user.userId, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Settings version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, 'patient.mrn_settings.update', org, 'success', user, { prefix: input.prefix, allowLegacy: input.allowLegacy }));
      return this.view(repo, org);
    });
  }

  private async view(repo: Repo, org: OrganizationId): Promise<MrnSettingsView> {
    const s = await repo.settings(org);
    const yy = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Ho_Chi_Minh', year: '2-digit' }).format(this.clock()));
    return { ...s, nextPreview: formatAutoMrn(s.prefix, yy, await repo.nextValue(org, yy)), example: formatAutoMrn(s.prefix, yy, 123) };
  }
  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  private async check(repo: Repo, ctx: TenantContext, org: OrganizationId, perm: Permission): Promise<User> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) => (m.organizationId === org || m.role === 'tenant_admin') && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    const grants: readonly AccessGrant[] = await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>);
    const action = perm as PolicyAction;
    const d = decideAccess(grants, action, PERMISSIONS[ACCESS_POLICY_CATALOG[action].basePermission as Permission], { callerUserId: user.userId });
    if (!d.allowed) throw d.reason === 'ROLE' ? new ClinicalError('FORBIDDEN', `Missing permission ${perm}`) : new ClinicalError('FORBIDDEN', `Access policy does not permit ${perm}`, { reason: 'ACCESS_POLICY' });
    return user;
  }
  private event(ctx: TenantContext, action: string, org: OrganizationId | null, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject }, organizationId: org, action,
      resourceType: 'Organization', resourceId: org, personId: null, patientId: null, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async run<T>(ctx: TenantContext, action: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(this.deps.pool, async (db) => fn(new Repo(db)), ctx);
    } catch (e) {
      try {
        await this.deps.audit.record(this.event(ctx, action, null, e instanceof ClinicalError && e.code === 'FORBIDDEN' ? 'denied' : 'failure', null, { code: (e as { code?: string }).code ?? 'INTERNAL' }));
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }
}
