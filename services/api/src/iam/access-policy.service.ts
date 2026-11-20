/**
 * HCOS-P0-ENG-001 | IAM | Quản trị access policy (tạo / sửa / retire / gắn vào membership).
 *
 * Kiểm soát:
 *  - Chỉ người có membership `tenant_admin` CÒN HIỆU LỰC (đọc từ DB, không tin claim JWT) mới quản trị policy.
 *  - Chống tự nới quyền: không đổi policy của CHÍNH MÌNH (gắn / gỡ trên membership của mình, hoặc sửa / retire
 *    một policy đang giới hạn membership active của mình). Việc đó phải do một tenant_admin khác làm.
 *  - Luật luôn đi qua validateAccessRules (danh mục đóng); DB giữ snapshot mọi phiên bản (iam.access_policy_versions).
 *  - Optimistic concurrency: sửa / retire / gắn đều cần version mong đợi (If-Match).
 *  - Mọi thay đổi: audit trong cùng transaction (kèm sha256 của bộ luật, không chép nguyên văn) + outbox
 *    `iam.access_policy.changed` để các bản sao / cache phía sau làm mới.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  VersionConflictError,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type MembershipId,
  type NewAuditEvent,
  type TenantContext,
  type TenantScopedDb,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import {
  AccessPolicyValidationError,
  canonicalRulesJson,
  validateAccessRules,
  type AccessPolicy,
  type AccessPolicyVersion,
  type AccessRule,
} from '../../../../packages/security/src/access-policy';
import {
  assertSameTenant,
  requireTenantContext,
  withTenantTransaction,
  type PgPoolLike,
} from '../../../../packages/security/src/tenant-context';
import {
  ACCESS_POLICY_COLS,
  ClinicalError,
  iso,
  mapAccessPolicy,
  mapMembership,
  mapUser,
  MEMBERSHIP_COLS,
  type OutboxDraft,
  USER_COLS,
} from '../clinical/encounter.service';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
export interface AccessPolicyRepository {
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  findMembership(id: MembershipId): Promise<Membership | null>;
  listPolicies(): Promise<AccessPolicy[]>;
  findPolicy(id: AccessPolicyId): Promise<AccessPolicy | null>;
  listPolicyVersions(id: AccessPolicyId): Promise<AccessPolicyVersion[]>;
  /** Ném ClinicalError('CONFLICT', ..., { reason: 'NAME_TAKEN' }) khi trùng tên. */
  insertPolicy(p: AccessPolicy): Promise<AccessPolicy>;
  /** Cập nhật có điều kiện version; null nếu version lệch / không có. */
  updatePolicy(
    id: AccessPolicyId,
    patch: { readonly description?: string | null; readonly rules?: readonly AccessRule[]; readonly status?: 'retired' },
    expectedVersion: number,
  ): Promise<AccessPolicy | null>;
  countActiveAssignments(id: AccessPolicyId): Promise<number>;
  setMembershipPolicy(id: MembershipId, policyId: AccessPolicyId | null, expectedVersion: number): Promise<Membership | null>;
  enqueueOutbox(tenantId: TenantContext['tenantId'], ev: OutboxDraft): Promise<void>;
  appendAudit(ev: NewAuditEvent): Promise<void>;
}

export interface AccessPolicyUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: AccessPolicyRepository) => Promise<T>): Promise<T>;
}

export interface AccessPolicyServiceDeps {
  readonly uow: AccessPolicyUnitOfWork;
  readonly audit: AuditSink;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

export interface CreateAccessPolicyInput {
  readonly name: string;
  readonly description?: string | null;
  readonly rules: unknown;
}

export interface ReviseAccessPolicyInput {
  readonly description?: string | null;
  readonly rules?: unknown;
}

interface AuditMeta {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()\-/]{2,99}$/u;

const rulesHash = (rules: readonly AccessRule[]): string =>
  createHash('sha256').update(canonicalRulesJson(rules)).digest('hex');

function parseRules(raw: unknown): AccessRule[] {
  try {
    return validateAccessRules(raw);
  } catch (e) {
    if (e instanceof AccessPolicyValidationError) throw new ClinicalError('VALIDATION', e.message, { path: e.path });
    throw e;
  }
}

function parseDescription(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || v.length > 1000) throw new ClinicalError('VALIDATION', 'description must be a string (max 1000)');
  return v.trim() === '' ? null : v;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class AccessPolicyService {
  private readonly uow: AccessPolicyUnitOfWork;
  private readonly audit: AuditSink;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(deps: AccessPolicyServiceDeps) {
    this.uow = deps.uow;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Kiểm định thử (không ghi). Trả luật đã chuẩn hoá. */
  validateRules(raw: unknown): AccessRule[] {
    return parseRules(raw);
  }

  async listPolicies(ctx: TenantContext = requireTenantContext()): Promise<AccessPolicy[]> {
    return this.tx(ctx, { action: 'iam.access_policy.list', resourceType: 'AccessPolicy' }, async (repo) => {
      await this.requireAdmin(repo, ctx);
      const all = await repo.listPolicies();
      for (const p of all) assertSameTenant(p, ctx);
      return all;
    });
  }

  async getPolicy(
    id: AccessPolicyId,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ policy: AccessPolicy; versions: AccessPolicyVersion[]; activeAssignments: number }> {
    return this.tx(ctx, { action: 'iam.access_policy.read', resourceType: 'AccessPolicy', resourceId: id }, async (repo) => {
      await this.requireAdmin(repo, ctx);
      const policy = await this.loadPolicy(repo, ctx, id);
      const [versions, activeAssignments] = await Promise.all([repo.listPolicyVersions(id), repo.countActiveAssignments(id)]);
      return { policy, versions, activeAssignments };
    });
  }

  async createPolicy(input: CreateAccessPolicyInput, ctx: TenantContext = requireTenantContext()): Promise<AccessPolicy> {
    const meta: AuditMeta = { action: 'iam.access_policy.create', resourceType: 'AccessPolicy' };
    return this.tx(ctx, meta, async (repo) => {
      const admin = await this.requireAdmin(repo, ctx);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!NAME_RE.test(name)) throw new ClinicalError('VALIDATION', 'name must be 3-100 letters, digits, spaces or ._()-/');
      const description = parseDescription(input.description) ?? null;
      const rules = parseRules(input.rules);
      const now = this.clock().toISOString();
      const saved = await repo.insertPolicy({
        tenantId: ctx.tenantId,
        policyId: this.newId() as AccessPolicyId,
        name,
        description,
        status: 'active',
        rules,
        createdBy: admin.userId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await this.changed(repo, ctx, admin, { ...meta, resourceId: saved.policyId }, saved, { rulesSha256: rulesHash(saved.rules) });
      return saved;
    });
  }

  async revisePolicy(
    id: AccessPolicyId,
    input: ReviseAccessPolicyInput,
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<AccessPolicy> {
    const meta: AuditMeta = { action: 'iam.access_policy.revise', resourceType: 'AccessPolicy', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      assertVersion(expectedVersion);
      const admin = await this.requireAdmin(repo, ctx);
      const current = await this.loadPolicy(repo, ctx, id);
      if (current.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Retired policies cannot be revised');
      await this.forbidSelfService(repo, admin, id);
      const description = parseDescription(input.description);
      const rules = input.rules !== undefined ? parseRules(input.rules) : undefined;
      if (description === undefined && rules === undefined) throw new ClinicalError('VALIDATION', 'Nothing to change');
      const saved = await repo.updatePolicy(
        id,
        { ...(description !== undefined ? { description } : {}), ...(rules ? { rules } : {}) },
        expectedVersion,
      );
      if (!saved) throw new VersionConflictError('AccessPolicy', id, expectedVersion);
      await this.changed(repo, ctx, admin, meta, saved, {
        fromVersion: expectedVersion,
        rulesSha256: rulesHash(saved.rules),
        previousRulesSha256: rulesHash(current.rules),
      });
      return saved;
    });
  }

  async retirePolicy(id: AccessPolicyId, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<AccessPolicy> {
    const meta: AuditMeta = { action: 'iam.access_policy.retire', resourceType: 'AccessPolicy', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      assertVersion(expectedVersion);
      const admin = await this.requireAdmin(repo, ctx);
      const current = await this.loadPolicy(repo, ctx, id);
      if (current.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Policy is already retired');
      const inUse = await repo.countActiveAssignments(id);
      if (inUse > 0) {
        throw new ClinicalError('INVALID_STATE', 'Policy is still assigned to active memberships', {
          reason: 'POLICY_IN_USE',
          activeAssignments: inUse,
        });
      }
      const saved = await repo.updatePolicy(id, { status: 'retired' }, expectedVersion);
      if (!saved) throw new VersionConflictError('AccessPolicy', id, expectedVersion);
      await this.changed(repo, ctx, admin, meta, saved, { fromVersion: expectedVersion });
      return saved;
    });
  }

  /** Gắn (policyId) hoặc gỡ (null) policy trên một membership. */
  async assignPolicy(
    membershipId: MembershipId,
    policyId: AccessPolicyId | null,
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<Membership> {
    const meta: AuditMeta = { action: 'iam.membership.access_policy.assign', resourceType: 'Membership', resourceId: membershipId };
    return this.tx(ctx, meta, async (repo) => {
      assertVersion(expectedVersion);
      const admin = await this.requireAdmin(repo, ctx);
      const membership = await repo.findMembership(membershipId);
      if (!membership) throw new ClinicalError('NOT_FOUND', 'Membership not found');
      assertSameTenant(membership, ctx);
      if (membership.userId === admin.userId) {
        throw new ClinicalError('FORBIDDEN', 'Administrators cannot change the access policy of their own memberships', {
          reason: 'SELF_SERVICE',
        });
      }
      if (policyId !== null) {
        const policy = await this.loadPolicy(repo, ctx, policyId);
        if (policy.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Policy is retired');
      }
      const from = membership.accessPolicyId ?? null;
      const saved = await repo.setMembershipPolicy(membershipId, policyId, expectedVersion);
      if (!saved) throw new VersionConflictError('Membership', membershipId, expectedVersion);
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'membership',
        aggregateId: membershipId,
        eventType: 'iam.membership.access_policy.changed',
        payload: { membershipId, userId: membership.userId, organizationId: membership.organizationId, fromPolicyId: from, toPolicyId: policyId },
      });
      await repo.appendAudit(
        this.event(ctx, meta, 'success', admin, {
          userId: membership.userId,
          role: membership.role,
          fromPolicyId: from,
          toPolicyId: policyId,
          fromVersion: expectedVersion,
          toVersion: saved.version,
        }, membership.organizationId),
      );
      return saved;
    });
  }

  // ---- Internals ---------------------------------------------------------
  private async requireAdmin(repo: AccessPolicyRepository, ctx: TenantContext): Promise<User> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const ok = (await repo.listMemberships(user.userId)).some(
      (m) =>
        m.role === 'tenant_admin' &&
        m.status === 'active' &&
        Date.parse(m.validFrom) <= now &&
        (m.validTo === null || Date.parse(m.validTo) > now),
    );
    if (!ok) throw new ClinicalError('FORBIDDEN', 'Missing permission iam:access_policy:manage');
    return user;
  }

  /** Không sửa / retire policy đang giới hạn chính người gọi (tránh tự nới quyền). */
  private async forbidSelfService(repo: AccessPolicyRepository, admin: User, id: AccessPolicyId): Promise<void> {
    const mine = await repo.listMemberships(admin.userId);
    if (mine.some((m) => m.status === 'active' && m.accessPolicyId === id)) {
      throw new ClinicalError('FORBIDDEN', 'Administrators cannot change a policy that restricts their own memberships', {
        reason: 'SELF_SERVICE',
      });
    }
  }

  private async loadPolicy(repo: AccessPolicyRepository, ctx: TenantContext, id: AccessPolicyId): Promise<AccessPolicy> {
    const p = await repo.findPolicy(id);
    if (!p) throw new ClinicalError('NOT_FOUND', 'Access policy not found');
    assertSameTenant(p, ctx);
    return p;
  }

  private async changed(
    repo: AccessPolicyRepository,
    ctx: TenantContext,
    admin: User,
    meta: AuditMeta,
    p: AccessPolicy,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await repo.enqueueOutbox(ctx.tenantId, {
      aggregateType: 'access_policy',
      aggregateId: p.policyId,
      eventType: 'iam.access_policy.changed',
      payload: { policyId: p.policyId, version: p.version, status: p.status },
    });
    await repo.appendAudit(
      this.event(ctx, { ...meta, resourceId: p.policyId }, 'success', admin, {
        name: p.name,
        version: p.version,
        status: p.status,
        ruleCount: p.rules.length,
        ...payload,
      }),
    );
  }

  private event(
    ctx: TenantContext,
    meta: AuditMeta,
    outcome: NewAuditEvent['outcome'],
    user: User | null,
    payload: Record<string, unknown>,
    organizationId: string | null = null,
  ): NewAuditEvent {
    return {
      eventId: this.newId() as AuditEventId,
      tenantId: ctx.tenantId,
      actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: organizationId as NewAuditEvent['organizationId'],
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      personId: null,
      patientId: null,
      outcome,
      correlationId: ctx.correlationId as CorrelationId,
      sourceIp: null,
      userAgent: null,
      payload,
    };
  }

  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: AccessPolicyRepository) => Promise<T>): Promise<T> {
    try {
      return await this.uow.run(ctx, fn);
    } catch (e) {
      let code = 'INTERNAL';
      let outcome: NewAuditEvent['outcome'] = 'failure';
      if (e instanceof ClinicalError) {
        code = e.code;
        if (e.code === 'FORBIDDEN') outcome = 'denied';
      } else if (e instanceof TenantIsolationError) {
        code = e.code;
        outcome = 'denied';
      } else if (e instanceof VersionConflictError) {
        code = 'VERSION_CONFLICT';
      }
      const reason = e instanceof ClinicalError && typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
      try {
        await this.audit.record(this.event(ctx, meta, outcome, null, { code, ...(reason ? { reason } : {}) }));
      } catch {
        /* audit lỗi không đổi kết quả */
      }
      throw e;
    }
  }
}

function assertVersion(v: number): void {
  if (!Number.isInteger(v) || v < 1) throw new ClinicalError('VALIDATION', 'expected version must be a positive integer');
}

// ===========================================================================
// PostgreSQL adapter
// ===========================================================================
function translatePgError(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err && typeof err === 'object') {
    if (err.code === '23505' && err.constraint === 'access_policies_tenant_name_uk') {
      throw new ClinicalError('CONFLICT', 'An access policy with this name already exists', { reason: 'NAME_TAKEN' });
    }
    if (err.code === '23505') throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'UNIQUE_VIOLATION' });
    if (err.code === '55000') throw new ClinicalError('INVALID_STATE', 'Operation not allowed in current state');
    if (err.code === '42501') throw new ClinicalError('FORBIDDEN', 'Operation rejected by data-layer policy');
  }
  throw e;
}

function mustMap(row: unknown): AccessPolicy {
  const p = mapAccessPolicy(row);
  if (!p) throw new ClinicalError('INVALID_STATE', 'Stored access policy is malformed');
  return p;
}

export class PgAccessPolicyRepository implements AccessPolicyRepository {
  constructor(private readonly db: TenantScopedDb) {}

  private get t(): string {
    return this.db.tenantId;
  }

  async findUserBySubject(subject: string): Promise<User | null> {
    const r = await this.db.query(`SELECT ${USER_COLS} FROM iam.users WHERE tenant_id = $1 AND external_subject = $2`, [this.t, subject]);
    return r.rows[0] ? mapUser(r.rows[0]) : null;
  }

  async listMemberships(userId: UserId): Promise<Membership[]> {
    const r = await this.db.query(`SELECT ${MEMBERSHIP_COLS} FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2`, [this.t, userId]);
    return r.rows.map(mapMembership);
  }

  async findMembership(id: MembershipId): Promise<Membership | null> {
    const r = await this.db.query(`SELECT ${MEMBERSHIP_COLS} FROM iam.memberships WHERE tenant_id = $1 AND membership_id = $2`, [this.t, id]);
    return r.rows[0] ? mapMembership(r.rows[0]) : null;
  }

  async listPolicies(): Promise<AccessPolicy[]> {
    const r = await this.db.query(`SELECT ${ACCESS_POLICY_COLS} FROM iam.access_policies WHERE tenant_id = $1 ORDER BY name`, [this.t]);
    return r.rows.map(mustMap);
  }

  async findPolicy(id: AccessPolicyId): Promise<AccessPolicy | null> {
    const r = await this.db.query(`SELECT ${ACCESS_POLICY_COLS} FROM iam.access_policies WHERE tenant_id = $1 AND policy_id = $2`, [this.t, id]);
    return r.rows[0] ? mustMap(r.rows[0]) : null;
  }

  async listPolicyVersions(id: AccessPolicyId): Promise<AccessPolicyVersion[]> {
    const r = await this.db.query(
      `SELECT policy_id, version, name, description, status, rules, changed_by, changed_at
         FROM iam.access_policy_versions WHERE tenant_id = $1 AND policy_id = $2 ORDER BY version`,
      [this.t, id],
    );
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return r.rows.map((x: any) => ({
      policyId: x.policy_id, version: Number(x.version), name: x.name, description: x.description ?? null, status: x.status,
      rules: typeof x.rules === 'string' ? JSON.parse(x.rules) : x.rules, changedBy: x.changed_by, changedAt: iso(x.changed_at),
    }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  async insertPolicy(p: AccessPolicy): Promise<AccessPolicy> {
    try {
      const r = await this.db.query(
        `INSERT INTO iam.access_policies (policy_id, tenant_id, name, description, status, rules, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING ${ACCESS_POLICY_COLS}`,
        [p.policyId, p.tenantId, p.name, p.description, p.status, JSON.stringify(p.rules), p.createdBy],
      );
      return mustMap(r.rows[0]);
    } catch (e) {
      return translatePgError(e);
    }
  }

  async updatePolicy(
    id: AccessPolicyId,
    patch: { readonly description?: string | null; readonly rules?: readonly AccessRule[]; readonly status?: 'retired' },
    expectedVersion: number,
  ): Promise<AccessPolicy | null> {
    try {
      const r = await this.db.query(
        `UPDATE iam.access_policies
            SET description = CASE WHEN $1::boolean THEN $2::text ELSE description END,
                rules       = COALESCE($3::jsonb, rules),
                status      = COALESCE($4::text, status)
          WHERE tenant_id = $5 AND policy_id = $6 AND version = $7
          RETURNING ${ACCESS_POLICY_COLS}`,
        [
          patch.description !== undefined, patch.description ?? null,
          patch.rules ? JSON.stringify(patch.rules) : null, patch.status ?? null,
          this.t, id, expectedVersion,
        ],
      );
      return r.rows[0] ? mustMap(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async countActiveAssignments(id: AccessPolicyId): Promise<number> {
    const r = await this.db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM iam.memberships WHERE tenant_id = $1 AND access_policy_id = $2 AND status = 'active'`,
      [this.t, id],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async setMembershipPolicy(id: MembershipId, policyId: AccessPolicyId | null, expectedVersion: number): Promise<Membership | null> {
    try {
      const r = await this.db.query(
        `UPDATE iam.memberships SET access_policy_id = $1
          WHERE tenant_id = $2 AND membership_id = $3 AND version = $4
          RETURNING ${MEMBERSHIP_COLS}`,
        [policyId, this.t, id, expectedVersion],
      );
      return r.rows[0] ? mapMembership(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async enqueueOutbox(tenantId: TenantContext['tenantId'], ev: OutboxDraft): Promise<void> {
    await this.db.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [tenantId, ev.aggregateType, ev.aggregateId, ev.eventType, JSON.stringify(ev.payload)],
    );
  }

  async appendAudit(ev: NewAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO platform.audit_events
         (tenant_id, actor_type, actor_id, organization_id, action, resource_type, resource_id,
          person_id, patient_id, outcome, correlation_id, source_ip, user_agent, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [ev.tenantId, ev.actor.type, ev.actor.id, ev.organizationId, ev.action, ev.resourceType, ev.resourceId,
       ev.personId, ev.patientId, ev.outcome, ev.correlationId, ev.sourceIp, ev.userAgent, JSON.stringify(ev.payload)],
    );
  }
}

export class PgAccessPolicyUnitOfWork implements AccessPolicyUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  run<T>(ctx: TenantContext, fn: (repo: AccessPolicyRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        // Provenance: trigger snapshot_access_policy đọc app.user_id.
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgAccessPolicyRepository(db));
      },
      ctx,
    );
  }
}

export { isUuid };
