/**
 * HCOS-F21 | Quản trị nhân sự & cơ sở.
 *
 * Quyền:
 *   staff:manage  quản lý cơ sở (clinic_admin) tại cơ sở mình + quản trị chủ quản (tenant_admin) mọi nơi.
 *   org:manage    chỉ tenant_admin — tạo cơ sở (tuỳ chọn sao chép cấu hình), ngừng / mở lại cơ sở.
 * Trần vai trò:
 *   - clinic_admin chỉ cấp / thu hồi vai trò nghiệp vụ (bác sĩ, lễ tân / điều dưỡng, thu ngân, dược sĩ, thủ kho) tại cơ sở mình làm quản lý;
 *     không đụng tới tài khoản đang giữ vai trò quản trị (clinic_admin / tenant_admin / executive) và không khoá / đặt lại ai có quyền ở cơ sở khác;
 *   - tenant_admin cấp được mọi vai trò trừ 'system' / 'patient';
 *   - không ai tự sửa quyền / khoá / đặt lại chính mình; luôn còn ít nhất một tenant_admin đang hoạt động.
 * Tài khoản đăng nhập tạo trên Keycloak qua IdentityProviderAdmin (mật khẩu tạm + bắt cài OTP lần đầu); mật khẩu tạm chỉ trả về MỘT lần,
 * không lưu, không ghi audit. Khoá => tắt trên Keycloak + đăng xuất mọi phiên + chặn ở API (iam.users.status).
 */
import { randomBytes } from 'node:crypto';

import type { OrganizationId, Role, TenantContext, User } from '../../../../packages/domain/src/s0-contracts';
import { requireTenantContext } from '../../../../packages/security/src/tenant-context';
import { ClinicalError } from '../clinical/encounter.service';
import { GovernanceBase, optStr, str, type GovRepo } from '../governance/governance-base';
import { IdpError, temporaryPassword, type IdentityProviderAdmin } from './keycloak-admin';

type Permission = 'staff:manage' | 'org:manage';
const PERMS: Readonly<Record<Permission, readonly Role[]>> = {
  'staff:manage': ['clinic_admin', 'tenant_admin'],
  'org:manage': ['tenant_admin'],
};
export const STAFF_ROLES = ['doctor', 'clinic_staff', 'cashier', 'pharmacist', 'pharmacy_admin', 'clinic_admin', 'executive', 'tenant_admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
/** Vai trò quản lý cơ sở được cấp. */
const CLINIC_ADMIN_GRANTS: ReadonlySet<string> = new Set(['doctor', 'clinic_staff', 'cashier', 'pharmacist', 'pharmacy_admin']);
const ADMIN_ROLES: ReadonlySet<string> = new Set(['clinic_admin', 'tenant_admin', 'executive']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ORG_CODE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MRN_PREFIX = /^[A-Z]{1,4}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

const bad = (reason: string, msg = reason): never => { throw new ClinicalError('VALIDATION', msg, { reason }); };
const conflict = (reason: string, msg = reason): never => { throw new ClinicalError('CONFLICT', msg, { reason }); };
const forbid = (reason: string, msg = reason): never => { throw new ClinicalError('FORBIDDEN', msg, { reason }); };
const uuid = (v: unknown, field: string): string => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad('VALIDATION', `${field} must be a uuid`));
const dateOrNull = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return bad('VALIDATION', `${field} must be YYYY-MM-DD`);
  return v;
};

export interface CopyOptions {
  readonly servicePoints?: boolean; readonly priceList?: boolean; readonly financeSettings?: boolean; readonly forecastSettings?: boolean;
  readonly supplyNorms?: boolean; readonly deviceRequirements?: boolean; readonly decisionRules?: boolean; readonly handoverDesks?: boolean; readonly mrnSettings?: boolean;
}

interface Scope { readonly user: User; readonly tenantAdmin: boolean; readonly adminOrgs: ReadonlySet<string> }

export class StaffAdminService extends GovernanceBase<Permission> {
  constructor(private readonly d: ConstructorParameters<typeof GovernanceBase>[0] & { idp: IdentityProviderAdmin; onAccessChanged?: (tenantId: string) => void; rand?: (n: number) => Uint8Array }) {
    super(d, PERMS, 'Staff');
  }

  // ---------------------------------------------------------------- phạm vi người gọi
  private async scope(repo: GovRepo, ctx: TenantContext): Promise<Scope> {
    const p = await this.principal(repo, ctx);
    this.need(p.grants, p.user, 'staff:manage');
    const r = await repo.tdb.query<{ organization_id: string; role: string }>(
      `SELECT organization_id, role FROM iam.memberships
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          AND role IN ('clinic_admin', 'tenant_admin')`,
      [ctx.tenantId, p.user.userId],
    );
    const tenantAdmin = r.rows.some((x) => x.role === 'tenant_admin');
    const adminOrgs = new Set(r.rows.filter((x) => x.role === 'clinic_admin' && ctx.allowedOrganizationIds.includes(x.organization_id as OrganizationId)).map((x) => x.organization_id));
    return { user: p.user, tenantAdmin, adminOrgs };
  }
  private canAtOrg(s: Scope, org: string): boolean {
    return s.tenantAdmin || s.adminOrgs.has(org);
  }
  private assertGrantable(s: Scope, org: string, role: string): void {
    if (!(STAFF_ROLES as readonly string[]).includes(role)) bad('ROLE_INVALID', 'Unknown or non-assignable role');
    if (!this.canAtOrg(s, org)) forbid('ORG_SCOPE', 'You do not manage this organization');
    if (!s.tenantAdmin && !CLINIC_ADMIN_GRANTS.has(role)) forbid('ROLE_CEILING', 'Only a tenant administrator can grant administrative roles');
  }
  /** Mọi membership đang hiệu lực của người đích nằm trong phạm vi người gọi, và người đích không giữ vai trò quản trị (trừ khi gọi là tenant_admin). */
  private async assertManagesUser(repo: GovRepo, s: Scope, userId: string): Promise<void> {
    if (userId === s.user.userId) forbid('SELF_CHANGE', 'You cannot change your own account here');
    if (s.tenantAdmin) return;
    const r = await repo.tdb.query<{ organization_id: string; role: string }>(
      `SELECT organization_id, role FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND (valid_to IS NULL OR valid_to > now())`,
      [repo.tenantId, userId],
    );
    if (r.rows.some((m) => ADMIN_ROLES.has(m.role))) forbid('ROLE_CEILING', 'Only a tenant administrator can change an administrator account');
    if (r.rows.some((m) => !s.adminOrgs.has(m.organization_id))) forbid('ORG_SCOPE', 'This account also works at an organization you do not manage');
    if (r.rows.length === 0) {
      const any = await repo.tdb.query<{ organization_id: string }>('SELECT DISTINCT organization_id FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2', [repo.tenantId, userId]);
      if (!any.rows.some((m) => s.adminOrgs.has(m.organization_id))) forbid('ORG_SCOPE', 'This account is outside your organizations');
    }
  }
  private async loadUser(repo: GovRepo, userId: string): Promise<{ user_id: string; external_subject: string; status: string; display_name: string; username: string | null; version: string }> {
    const r = await repo.tdb.query<{ user_id: string; external_subject: string; status: string; display_name: string; username: string | null; version: string }>(
      `SELECT user_id, external_subject, status, display_name, username, version FROM iam.users WHERE tenant_id = $1 AND user_id = $2 AND person_id IS NULL`,
      [repo.tenantId, userId],
    );
    return r.rows[0] ?? (() => { throw new ClinicalError('NOT_FOUND', 'User not found'); })();
  }
  private changed(tenantId: string): void {
    try {
      this.d.onAccessChanged?.(tenantId);
    } catch {
      /* chỉ là xoá cache */
    }
  }
  private tempPassword(): string {
    return temporaryPassword(this.d.rand ?? ((n) => randomBytes(n)));
  }
  private idp<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: unknown) => {
      if (e instanceof IdpError) {
        throw new ClinicalError(e.reason === 'IDP_CONFLICT' ? 'CONFLICT' : 'INVALID_STATE', e.message, { reason: e.reason });
      }
      throw e;
    });
  }

  // ---------------------------------------------------------------- đọc
  async listStaff(q: { organizationId?: unknown; includeRevoked?: unknown }, ctx: TenantContext = requireTenantContext()) {
    return this.run(ctx, 'staff.list', async (repo) => {
      const s = await this.scope(repo, ctx);
      const org = q.organizationId === undefined || q.organizationId === null || q.organizationId === '' ? null : uuid(q.organizationId, 'organizationId');
      if (org && !this.canAtOrg(s, org)) forbid('ORG_SCOPE', 'You do not manage this organization');
      const visibleOrgs = s.tenantAdmin ? null : [...s.adminOrgs];
      if (visibleOrgs && visibleOrgs.length === 0) forbid('ORG_SCOPE', 'You do not manage any organization in this session');
      const r = await repo.tdb.query<Record<string, unknown>>(
        `SELECT u.user_id, u.display_name, u.username, u.email, u.status, u.last_login_at, u.created_at,
                COALESCE(json_agg(json_build_object(
                  'membershipId', m.membership_id, 'organizationId', m.organization_id, 'organizationName', o.name, 'role', m.role, 'status', m.status,
                  'validFrom', m.valid_from, 'validTo', m.valid_to, 'grantedByName', g.display_name, 'revokedAt', m.revoked_at,
                  'revokedByName', rv.display_name, 'revokeReason', m.revoke_reason, 'accessPolicyId', m.access_policy_id
                ) ORDER BY o.code, m.role, m.valid_from DESC) FILTER (WHERE m.membership_id IS NOT NULL), '[]') AS memberships
           FROM iam.users u
           JOIN iam.memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.user_id
                                 AND ($3::boolean OR m.status <> 'revoked')
                                 AND ($2::uuid[] IS NULL OR m.organization_id = ANY($2::uuid[]))
           JOIN iam.organizations o ON o.tenant_id = m.tenant_id AND o.organization_id = m.organization_id
           LEFT JOIN iam.users g ON g.tenant_id = m.tenant_id AND g.user_id = m.granted_by
           LEFT JOIN iam.users rv ON rv.tenant_id = m.tenant_id AND rv.user_id = m.revoked_by
          WHERE u.tenant_id = $1 AND u.person_id IS NULL AND ($4::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM iam.memberships x WHERE x.tenant_id = u.tenant_id AND x.user_id = u.user_id AND x.organization_id = $4::uuid AND x.status <> 'revoked'))
          GROUP BY u.user_id
          ORDER BY u.status <> 'active', lower(u.display_name)`,
        [ctx.tenantId, visibleOrgs, q.includeRevoked === true || q.includeRevoked === 'true', org],
      );
      const adminRoles = s.tenantAdmin ? STAFF_ROLES : STAFF_ROLES.filter((x) => CLINIC_ADMIN_GRANTS.has(x));
      return {
        staff: r.rows.map((u) => {
          const raw = u['memberships'];
          const ms = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ role: string; status: string; organizationId: string }>;
          const active = ms.filter((m) => m.status === 'active');
          const manageable = u['user_id'] !== s.user.userId && (s.tenantAdmin || (!active.some((m) => ADMIN_ROLES.has(m.role)) && active.every((m) => s.adminOrgs.has(m.organizationId))));
          return {
            userId: u['user_id'], displayName: u['display_name'], username: u['username'], email: u['email'], status: u['status'],
            lastLoginAt: u['last_login_at'], createdAt: u['created_at'], memberships: ms as unknown[], manageable, self: u['user_id'] === s.user.userId,
          };
        }),
        grantableRoles: adminRoles,
        tenantAdmin: s.tenantAdmin,
        managedOrganizationIds: s.tenantAdmin ? null : [...s.adminOrgs],
      };
    });
  }

  // ---------------------------------------------------------------- tài khoản
  async createStaff(input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const displayName = str(input['displayName'], 2, 120, 'displayName');
    const username = typeof input['username'] === 'string' ? input['username'].trim().toLowerCase() : '';
    if (!USERNAME.test(username)) bad('USERNAME_INVALID', 'username: 3–64 lowercase letters, digits, dot, dash, underscore');
    const email = optStr(input['email'], 254, 'email')?.toLowerCase() ?? null;
    if (email && !EMAIL.test(email)) bad('EMAIL_INVALID', 'email is invalid');
    const org = uuid(input['organizationId'], 'organizationId');
    const roles = Array.isArray(input['roles']) ? [...new Set(input['roles'].filter((x): x is string => typeof x === 'string'))] : [];
    if (roles.length === 0 || roles.length > 4) bad('ROLES_REQUIRED', 'Choose 1–4 roles');
    const validTo = dateOrNull(input['validTo'], 'validTo');
    const linkExisting = input['linkExisting'] === true;

    // 1) kiểm quyền + trùng trong DB trước khi đụng tới Keycloak
    await this.run(ctx, 'staff.create', async (repo) => {
      const s = await this.scope(repo, ctx);
      for (const r of roles) this.assertGrantable(s, org, r);
      const dup = await repo.tdb.query('SELECT 1 FROM iam.users WHERE tenant_id = $1 AND (username = $2 OR ($3::text IS NOT NULL AND lower(email) = $3))', [ctx.tenantId, username, email]);
      if (dup.rows.length) conflict('USER_EXISTS', 'An account with this username or email already exists');
      await this.assertOrgActive(repo, org);
    });
    // 2) Keycloak: tạo mới (mật khẩu tạm) hoặc liên kết tài khoản có sẵn
    let subject: string;
    let password: string | null = null;
    const existing = await this.idp(this.d.idp.findByUsername(username));
    if (existing) {
      if (!linkExisting) conflict('IDP_USER_EXISTS', 'This username already exists in Keycloak — tick "link existing account" to use it');
      subject = existing!.id;
    } else {
      password = this.tempPassword();
      const parts = displayName.split(/\s+/);
      subject = await this.idp(this.d.idp.createUser({ username, firstName: parts.slice(-1)[0]!, lastName: parts.slice(0, -1).join(' ') || '-', email, temporaryPassword: password }));
    }
    // 3) DB: user + membership (lỗi => tắt tài khoản Keycloak vừa tạo để không bỏ lại tài khoản mồ côi đang bật)
    try {
      const out = await this.run(ctx, 'staff.create', async (repo) => {
        const s = await this.scope(repo, ctx);
        const taken = await repo.tdb.query('SELECT 1 FROM iam.users WHERE tenant_id = $1 AND external_subject = $2', [ctx.tenantId, subject]);
        if (taken.rows.length) conflict('IDP_USER_LINKED', 'This Keycloak account is already linked to a user');
        const u = await repo.tdb.query<{ user_id: string }>(
          `INSERT INTO iam.users (tenant_id, external_subject, email, display_name, username, status) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING user_id`,
          [ctx.tenantId, subject, email, displayName, username],
        );
        const userId = u.rows[0]!.user_id;
        for (const r of roles) {
          await repo.tdb.query(
            `INSERT INTO iam.memberships (tenant_id, user_id, organization_id, role, valid_to, granted_by) VALUES ($1, $2, $3, $4, $5::date, $6)`,
            [ctx.tenantId, userId, org, r, validTo, s.user.userId],
          );
        }
        await repo.appendAudit(this.event(ctx, 'staff.create', 'success', s.user, { roles, linked: !!existing, validTo }, userId, org as OrganizationId));
        return { userId, username, temporaryPassword: password, linkedExisting: !!existing };
      });
      this.changed(ctx.tenantId);
      return out;
    } catch (e) {
      if (!existing) await this.d.idp.setEnabled(subject, false).catch(() => undefined);
      throw e;
    }
  }

  async grantRole(userId: string, input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const org = uuid(input['organizationId'], 'organizationId');
    const role = typeof input['role'] === 'string' ? input['role'] : '';
    const validTo = dateOrNull(input['validTo'], 'validTo');
    const out = await this.run(ctx, 'staff.role.grant', async (repo) => {
      const s = await this.scope(repo, ctx);
      if (userId === s.user.userId) forbid('SELF_CHANGE', 'You cannot change your own roles');
      this.assertGrantable(s, org, role);
      const u = await this.loadUser(repo, userId);
      if (u.status !== 'active') conflict('USER_NOT_ACTIVE', 'Unlock the account before granting roles');
      if (!s.tenantAdmin) await this.assertManagesUserForGrant(repo, s, userId, org);
      await this.assertOrgActive(repo, org);
      const r = await repo.tdb.query<{ membership_id: string }>(
        `INSERT INTO iam.memberships (tenant_id, user_id, organization_id, role, valid_to, granted_by)
         VALUES ($1, $2, $3, $4, $5::date, $6) ON CONFLICT DO NOTHING RETURNING membership_id`,
        [ctx.tenantId, userId, org, role, validTo, s.user.userId],
      );
      if (!r.rows.length) conflict('ROLE_EXISTS', 'The account already has this role at this organization');
      await repo.appendAudit(this.event(ctx, 'staff.role.grant', 'success', s.user, { role, validTo }, userId, org as OrganizationId));
      return { membershipId: r.rows[0]!.membership_id };
    });
    this.changed(ctx.tenantId);
    return out;
  }
  /** clinic_admin thêm vai trò cho người đã có: người đó không giữ vai trò quản trị; được làm ở cơ sở khác vẫn OK (chỉ thêm quyền ở cơ sở mình). */
  private async assertManagesUserForGrant(repo: GovRepo, s: Scope, userId: string, org: string): Promise<void> {
    const r = await repo.tdb.query<{ role: string }>(`SELECT role FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [repo.tenantId, userId]);
    if (r.rows.some((m) => ADMIN_ROLES.has(m.role))) forbid('ROLE_CEILING', 'Only a tenant administrator can change an administrator account');
    if (!s.adminOrgs.has(org)) forbid('ORG_SCOPE', 'You do not manage this organization');
  }

  async revokeMembership(membershipId: string, input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const reason = str(input['reason'], 3, 300, 'reason');
    const out = await this.run(ctx, 'staff.role.revoke', async (repo) => {
      const s = await this.scope(repo, ctx);
      const m = (await repo.tdb.query<{ user_id: string; organization_id: string; role: string; status: string }>(
        `SELECT user_id, organization_id, role, status FROM iam.memberships WHERE tenant_id = $1 AND membership_id = $2 FOR UPDATE`, [ctx.tenantId, uuid(membershipId, 'membershipId')],
      )).rows[0] ?? (() => { throw new ClinicalError('NOT_FOUND', 'Membership not found'); })();
      if (m.status === 'revoked') conflict('ALREADY_REVOKED', 'Membership already revoked');
      if (m.user_id === s.user.userId) forbid('SELF_CHANGE', 'You cannot revoke your own roles');
      if (!this.canAtOrg(s, m.organization_id)) forbid('ORG_SCOPE', 'You do not manage this organization');
      if (!s.tenantAdmin && !CLINIC_ADMIN_GRANTS.has(m.role)) forbid('ROLE_CEILING', 'Only a tenant administrator can revoke administrative roles');
      if (m.role === 'tenant_admin') await this.assertAnotherTenantAdmin(repo, m.user_id);
      await repo.tdb.query(
        `UPDATE iam.memberships SET status = 'revoked', revoked_by = $3, revoke_reason = $4, updated_at = now() WHERE tenant_id = $1 AND membership_id = $2`,
        [ctx.tenantId, membershipId, s.user.userId, reason],
      );
      await repo.appendAudit(this.event(ctx, 'staff.role.revoke', 'success', s.user, { role: m.role }, m.user_id, m.organization_id as OrganizationId));
      return { revoked: true };
    });
    this.changed(ctx.tenantId);
    return out;
  }
  private async assertAnotherTenantAdmin(repo: GovRepo, exceptUserId: string): Promise<void> {
    const r = await repo.tdb.query(
      `SELECT 1 FROM iam.memberships m JOIN iam.users u ON u.tenant_id = m.tenant_id AND u.user_id = m.user_id
        WHERE m.tenant_id = $1 AND m.role = 'tenant_admin' AND m.status = 'active' AND (m.valid_to IS NULL OR m.valid_to > now())
          AND u.status = 'active' AND m.user_id <> $2 LIMIT 1`,
      [repo.tenantId, exceptUserId],
    );
    if (!r.rows.length) conflict('LAST_TENANT_ADMIN', 'At least one other active tenant administrator must remain');
  }

  async setStatus(userId: string, input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const status = input['status'];
    if (status !== 'locked' && status !== 'active') bad('STATUS_INVALID', 'status must be locked or active');
    const reason = str(input['reason'], 3, 300, 'reason');
    const u = await this.run(ctx, 'staff.status', async (repo) => {
      const s = await this.scope(repo, ctx);
      await this.assertManagesUser(repo, s, userId);
      const u = await this.loadUser(repo, userId);
      if (u.status === status) conflict('NO_CHANGE', `Account is already ${status}`);
      if (status === 'locked') {
        const adm = await repo.tdb.query(`SELECT 1 FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2 AND role = 'tenant_admin' AND status = 'active'`, [ctx.tenantId, userId]);
        if (adm.rows.length) await this.assertAnotherTenantAdmin(repo, userId);
      }
      return { ...u, actor: s.user };
    });
    // Keycloak trước (khoá phải có hiệu lực cả ở IdP); lỗi thì không đổi DB.
    await this.idp(this.d.idp.setEnabled(u.external_subject, status === 'active'));
    if (status === 'locked') await this.idp(this.d.idp.logout(u.external_subject));
    await this.run(ctx, 'staff.status', async (repo) => {
      await repo.tdb.query(`UPDATE iam.users SET status = $3, updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, [ctx.tenantId, userId, status]);
      await repo.appendAudit(this.event(ctx, status === 'locked' ? 'staff.lock' : 'staff.unlock', 'success', u.actor, { reason }, userId));
    });
    this.changed(ctx.tenantId);
    return { userId, status };
  }

  async resetCredentials(userId: string, input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const reason = str(input['reason'], 3, 300, 'reason');
    const u = await this.run(ctx, 'staff.reset', async (repo) => {
      const s = await this.scope(repo, ctx);
      await this.assertManagesUser(repo, s, userId);
      const u = await this.loadUser(repo, userId);
      if (u.status !== 'active') conflict('USER_NOT_ACTIVE', 'Unlock the account first');
      return { ...u, actor: s.user };
    });
    const password = this.tempPassword();
    await this.idp(this.d.idp.resetCredentials(u.external_subject, password));
    await this.run(ctx, 'staff.reset', async (repo) => {
      await repo.appendAudit(this.event(ctx, 'staff.reset_credentials', 'success', u.actor, { reason }, userId));
    });
    return { userId, temporaryPassword: password };
  }

  // ---------------------------------------------------------------- cơ sở
  private async assertOrgActive(repo: GovRepo, org: string): Promise<void> {
    const r = await repo.tdb.query<{ status: string }>('SELECT status FROM iam.organizations WHERE tenant_id = $1 AND organization_id = $2', [repo.tenantId, org]);
    if (!r.rows[0]) throw new ClinicalError('NOT_FOUND', 'Organization not found');
    if (r.rows[0].status !== 'active') conflict('ORG_INACTIVE', 'Organization is inactive');
  }

  async listOrganizations(ctx: TenantContext = requireTenantContext()) {
    return this.run(ctx, 'org.list', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'staff:manage');
      const r = await repo.tdb.query<Record<string, unknown>>(
        `SELECT o.organization_id, o.code, o.name, o.type, o.status, o.created_at,
                (SELECT count(DISTINCT m.user_id) FROM iam.memberships m WHERE m.tenant_id = o.tenant_id AND m.organization_id = o.organization_id AND m.status = 'active') AS staff,
                (SELECT count(*) FROM clinical.service_points sp WHERE sp.tenant_id = o.tenant_id AND sp.organization_id = o.organization_id AND sp.is_active) AS rooms,
                (SELECT count(*) FROM finance.price_items pi WHERE pi.tenant_id = o.tenant_id AND pi.organization_id = o.organization_id AND pi.is_active) AS prices
           FROM iam.organizations o WHERE o.tenant_id = $1 ORDER BY o.status, o.code`,
        [ctx.tenantId],
      );
      return {
        organizations: r.rows.map((o) => ({
          organizationId: o['organization_id'], code: o['code'], name: o['name'], type: o['type'], status: o['status'], createdAt: o['created_at'],
          staff: Number(o['staff']), rooms: Number(o['rooms']), prices: Number(o['prices']),
        })),
        canManage: this.allowed(p.grants, p.user, 'org:manage'),
      };
    });
  }

  async createOrganization(input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const code = typeof input['code'] === 'string' ? input['code'].trim().toLowerCase() : '';
    if (!ORG_CODE.test(code)) bad('ORG_CODE_INVALID', 'code: 2–40 lowercase letters, digits, dash');
    const name = str(input['name'], 3, 160, 'name');
    const from = input['copyFrom'] ? uuid(input['copyFrom'], 'copyFrom') : null;
    const copy = (input['copy'] ?? {}) as CopyOptions;
    const mrnPrefix = typeof input['mrnPrefix'] === 'string' && input['mrnPrefix'] ? input['mrnPrefix'].trim().toUpperCase() : null;
    if (mrnPrefix !== null && !MRN_PREFIX.test(mrnPrefix)) bad('MRN_PREFIX_INVALID', 'MRN prefix: 1–4 uppercase letters');
    const out = await this.run(ctx, 'org.create', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'org:manage');
      const dup = await repo.tdb.query('SELECT 1 FROM iam.organizations WHERE tenant_id = $1 AND code = $2', [ctx.tenantId, code]);
      if (dup.rows.length) conflict('ORG_CODE_EXISTS', 'Organization code already exists');
      if (from) await this.assertOrgActive(repo, from);
      const o = await repo.tdb.query<{ organization_id: string }>(
        `INSERT INTO iam.organizations (tenant_id, type, code, name) VALUES ($1, 'clinic', $2, $3) RETURNING organization_id`, [ctx.tenantId, code, name],
      );
      const org = o.rows[0]!.organization_id;
      const copied = from ? await this.copyConfig(repo, from, org, copy, p.user.userId) : {};
      if (mrnPrefix) {
        await repo.tdb.query(
          `INSERT INTO patient.mrn_settings (tenant_id, organization_id, prefix, updated_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, organization_id) DO UPDATE SET prefix = EXCLUDED.prefix, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [ctx.tenantId, org, mrnPrefix, p.user.userId],
        );
      }
      // Người tạo (tenant_admin) đã thấy mọi cơ sở; không tự cấp membership.
      await repo.appendAudit(this.event(ctx, 'org.create', 'success', p.user, { code, copyFrom: from, copied, mrnPrefix }, org, org as OrganizationId));
      return { organizationId: org, code, name, copied };
    });
    this.changed(ctx.tenantId);
    return out;
  }

  /** Sao chép cấu hình (không sao chép dữ liệu người bệnh, ca, phiếu, thiết bị, kho, tài khoản ngân hàng, cổng đặt lịch, kết nối ngoài). */
  private async copyConfig(repo: GovRepo, from: string, to: string, c: CopyOptions, by: string): Promise<Record<string, number>> {
    const t = repo.tenantId;
    const n: Record<string, number> = {};
    const exec = async (key: string, sql: string, params: unknown[]) => { n[key] = (await repo.tdb.query(`${sql} RETURNING 1`, params)).rows.length; };
    if (c.servicePoints) {
      await exec('servicePoints', `INSERT INTO clinical.service_points (tenant_id, organization_id, code, name, is_active, booking_capacity, visit_capacity)
        SELECT tenant_id, $3, code, name, is_active, booking_capacity, visit_capacity FROM clinical.service_points WHERE tenant_id = $1 AND organization_id = $2 AND is_active`, [t, from, to]);
    }
    if (c.handoverDesks) {
      await exec('handoverDesks', `INSERT INTO clinical.handover_desks (tenant_id, organization_id, code, name, is_active)
        SELECT tenant_id, $3, code, name, is_active FROM clinical.handover_desks WHERE tenant_id = $1 AND organization_id = $2 AND is_active`, [t, from, to]);
    }
    if (c.priceList || c.supplyNorms || c.deviceRequirements) {
      await exec('priceList', `INSERT INTO finance.price_items (tenant_id, organization_id, code, name, category, unit_price, is_active)
        SELECT tenant_id, $3, code, name, category, unit_price, is_active FROM finance.price_items WHERE tenant_id = $1 AND organization_id = $2 AND is_active`, [t, from, to]);
    }
    // Định mức / máy cần cho dịch vụ: nối theo MÃ dịch vụ sang bảng giá vừa chép.
    if (c.supplyNorms) {
      await exec('supplyNorms', `INSERT INTO equipment.supply_norms (tenant_id, organization_id, item_id, medication_id, quantity, updated_by)
        SELECT n.tenant_id, $3, b.item_id, n.medication_id, n.quantity, $4 FROM equipment.supply_norms n JOIN finance.price_items a ON a.tenant_id = n.tenant_id AND a.item_id = n.item_id
          JOIN finance.price_items b ON b.tenant_id = a.tenant_id AND b.organization_id = $3 AND b.code = a.code
         WHERE n.tenant_id = $1 AND n.organization_id = $2`, [t, from, to, by]);
    }
    if (c.deviceRequirements) {
      await exec('deviceRequirements', `INSERT INTO equipment.service_requirements (tenant_id, organization_id, item_id, type_id, active, updated_by)
        SELECT r.tenant_id, $3, b.item_id, r.type_id, r.active, $4 FROM equipment.service_requirements r JOIN finance.price_items a ON a.tenant_id = r.tenant_id AND a.item_id = r.item_id
          JOIN finance.price_items b ON b.tenant_id = a.tenant_id AND b.organization_id = $3 AND b.code = a.code
         WHERE r.tenant_id = $1 AND r.organization_id = $2`, [t, from, to, by]);
    }
    if (c.financeSettings) {
      // Không chép tài khoản ngân hàng: mỗi cơ sở tự khai báo tài khoản thật của mình.
      await exec('financeSettings', `INSERT INTO finance.settings (tenant_id, organization_id, deposit_default)
        SELECT tenant_id, $3, deposit_default FROM finance.settings WHERE tenant_id = $1 AND organization_id = $2`, [t, from, to]);
    }
    if (c.forecastSettings) {
      await exec('forecastSettings', `INSERT INTO finance.forecast_settings (tenant_id, organization_id, fixed_costs_monthly, variable_cost_pct, lead_time_days, service_level_pct, updated_by)
        SELECT tenant_id, $3, fixed_costs_monthly, variable_cost_pct, lead_time_days, service_level_pct, $4 FROM finance.forecast_settings WHERE tenant_id = $1 AND organization_id = $2`, [t, from, to, by]);
    }
    if (c.mrnSettings) {
      await exec('mrnSettings', `INSERT INTO patient.mrn_settings (tenant_id, organization_id, prefix, allow_legacy, updated_by)
        SELECT tenant_id, $3, prefix, false, $4 FROM patient.mrn_settings WHERE tenant_id = $1 AND organization_id = $2`, [t, from, to, by]);
    }
    if (c.decisionRules) {
      await exec('decisionRules', `INSERT INTO decision.rules (tenant_id, organization_id, name, detector, conditions, priority, cooldown_minutes, actions, status, created_by, updated_by)
        SELECT tenant_id, $3, name, detector, conditions, priority, cooldown_minutes, actions, status, $4, $4 FROM decision.rules
         WHERE tenant_id = $1 AND organization_id = $2 AND status <> 'retired'`, [t, from, to, by]);
    }
    return n;
  }

  async setOrganizationStatus(orgId: string, input: Record<string, unknown>, ctx: TenantContext = requireTenantContext()) {
    const status = input['status'];
    if (status !== 'active' && status !== 'inactive') bad('STATUS_INVALID', 'status must be active or inactive');
    const reason = str(input['reason'], 3, 300, 'reason');
    const out = await this.run(ctx, 'org.status', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'org:manage');
      const id = uuid(orgId, 'organizationId');
      const r = await repo.tdb.query<{ status: string }>('SELECT status FROM iam.organizations WHERE tenant_id = $1 AND organization_id = $2 FOR UPDATE', [ctx.tenantId, id]);
      if (!r.rows[0]) throw new ClinicalError('NOT_FOUND', 'Organization not found');
      if (r.rows[0].status === status) conflict('NO_CHANGE', `Organization is already ${status}`);
      if (status === 'inactive') {
        const others = await repo.tdb.query(`SELECT 1 FROM iam.organizations WHERE tenant_id = $1 AND status = 'active' AND organization_id <> $2 LIMIT 1`, [ctx.tenantId, id]);
        if (!others.rows.length) conflict('LAST_ORGANIZATION', 'At least one active organization must remain');
      }
      await repo.tdb.query(`UPDATE iam.organizations SET status = $3, updated_at = now() WHERE tenant_id = $1 AND organization_id = $2`, [ctx.tenantId, id, status]);
      await repo.appendAudit(this.event(ctx, status === 'inactive' ? 'org.deactivate' : 'org.reactivate', 'success', p.user, { reason }, id, id as OrganizationId));
      return { organizationId: id, status };
    });
    this.changed(ctx.tenantId);
    return out;
  }
}
