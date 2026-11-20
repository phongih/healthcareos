/**
 * HCOS-P0-ENG-001 | IAM | AccessPolicyService (repository in-memory). Ràng buộc DB thật: integration suite.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  asOrganizationId,
  asTenantId,
  asUserId,
  VersionConflictError,
  type AccessPolicyId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type MembershipId,
  type NewAuditEvent,
  type OrganizationId,
  type Role,
  type TenantContext,
  type User,
  type UserId,
} from '../../packages/domain/src/s0-contracts';
import type { AccessPolicy, AccessPolicyVersion, AccessRule } from '../../packages/security/src/access-policy';
import { ClinicalError, type OutboxDraft } from '../../services/api/src/clinical/encounter.service';
import {
  AccessPolicyService,
  type AccessPolicyRepository,
  type AccessPolicyUnitOfWork,
} from '../../services/api/src/iam/access-policy.service';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const TA = asTenantId(uid(1));
const ORG = asOrganizationId(uid(11));
const U = { admin: asUserId(uid(101)), admin2: asUserId(uid(102)), nurse: asUserId(uid(103)), exAdmin: asUserId(uid(104)) };
const RULES = [{ action: 'patient:read', hiddenFields: ['identifiers'] }];

interface State {
  users: User[];
  memberships: Membership[];
  policies: AccessPolicy[];
  versions: AccessPolicyVersion[];
  outbox: OutboxDraft[];
  audit: NewAuditEvent[];
}

class Repo implements AccessPolicyRepository {
  constructor(private readonly s: State, private readonly actor: string) {}
  private snapshot(p: AccessPolicy) {
    this.s.versions.push({ policyId: p.policyId, version: p.version, name: p.name, description: p.description, status: p.status, rules: p.rules, changedBy: this.actor, changedAt: T0 });
  }
  async findUserBySubject(sub: string) { return this.s.users.find((u) => u.externalSubject === sub) ?? null; }
  async listMemberships(userId: UserId) { return this.s.memberships.filter((m) => m.userId === userId); }
  async findMembership(id: MembershipId) { return this.s.memberships.find((m) => m.membershipId === id) ?? null; }
  async listOrganizations(ids: readonly OrganizationId[]) { return ids.map((organizationId) => ({ organizationId, name: 'Phòng khám A', type: 'clinic' })); }
  async listMembershipsByOrganization(org: OrganizationId) {
    return this.s.memberships.filter((m) => m.organizationId === org).map((membership) => {
      const u = this.s.users.find((x) => x.userId === membership.userId)!;
      return { membership, user: { userId: u.userId, displayName: u.displayName, email: u.email, status: u.status } };
    });
  }
  async listPolicies() { return [...this.s.policies]; }
  async findPolicy(id: AccessPolicyId) { return this.s.policies.find((p) => p.policyId === id) ?? null; }
  async listPolicyVersions(id: AccessPolicyId) { return this.s.versions.filter((v) => v.policyId === id); }
  async insertPolicy(p: AccessPolicy) {
    if (this.s.policies.some((x) => x.name === p.name)) throw new ClinicalError('CONFLICT', 'name', { reason: 'NAME_TAKEN' });
    this.s.policies.push(p);
    this.snapshot(p);
    return p;
  }
  async updatePolicy(id: AccessPolicyId, patch: { description?: string | null; rules?: readonly AccessRule[]; status?: 'retired' }, v: number) {
    const i = this.s.policies.findIndex((p) => p.policyId === id && p.version === v);
    if (i < 0) return null;
    const next = { ...this.s.policies[i]!, ...patch, version: v + 1 } as AccessPolicy;
    this.s.policies[i] = next;
    this.snapshot(next);
    return next;
  }
  async countActiveAssignments(id: AccessPolicyId) {
    return this.s.memberships.filter((m) => m.accessPolicyId === id && m.status === 'active').length;
  }
  async setMembershipPolicy(id: MembershipId, policyId: AccessPolicyId | null, v: number) {
    const i = this.s.memberships.findIndex((m) => m.membershipId === id && m.version === v);
    if (i < 0) return null;
    const next = { ...this.s.memberships[i]!, accessPolicyId: policyId, version: v + 1 };
    this.s.memberships[i] = next;
    return next;
  }
  async enqueueOutbox(_t: unknown, ev: OutboxDraft) { this.s.outbox.push(ev); }
  async appendAudit(ev: NewAuditEvent) { this.s.audit.push(ev); }
}

class Uow implements AccessPolicyUnitOfWork {
  constructor(public s: State) {}
  async run<T>(ctx: TenantContext, fn: (r: AccessPolicyRepository) => Promise<T>): Promise<T> {
    const snap = structuredClone(this.s);
    try {
      return await fn(new Repo(this.s, ctx.userSubject));
    } catch (e) {
      Object.assign(this.s, snap);
      throw e;
    }
  }
}
class Sink implements AuditSink {
  events: NewAuditEvent[] = [];
  async record(e: NewAuditEvent) { this.events.push(e); }
}

const mkUser = (userId: UserId): User => ({
  tenantId: TA, userId, externalSubject: `sub-${userId}`, email: null, displayName: 'u', personId: null, status: 'active',
  lastLoginAt: null, createdAt: T0, updatedAt: T0, version: 1,
});
let mseq = 700;
const mkMember = (userId: UserId, role: Role, over: Partial<Membership> = {}): Membership => ({
  tenantId: TA, membershipId: uid(mseq++) as MembershipId, userId, organizationId: ORG, role, status: 'active',
  validFrom: T0, validTo: null, accessPolicyId: null, createdAt: T0, updatedAt: T0, version: 1, ...over,
});
const ctxFor = (u: UserId): TenantContext =>
  Object.freeze({
    tenantId: TA, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: ORG,
    allowedOrganizationIds: Object.freeze([ORG]), roles: Object.freeze(['tenant_admin'] as Role[]), tokenId: null, correlationId: 'c' as CorrelationId,
  });

let s: State;
let sink: Sink;
let svc: AccessPolicyService;
let nurseM: Membership;
let adminDoctorM: Membership;

beforeEach(() => {
  mseq = 700;
  nurseM = mkMember(U.nurse, 'clinic_staff');
  adminDoctorM = mkMember(U.admin, 'doctor');
  s = {
    users: [mkUser(U.admin), mkUser(U.admin2), mkUser(U.nurse), mkUser(U.exAdmin)],
    memberships: [
      mkMember(U.admin, 'tenant_admin'), adminDoctorM, mkMember(U.admin2, 'tenant_admin'), nurseM,
      mkMember(U.exAdmin, 'tenant_admin', { validTo: '2026-06-01T00:00:00.000Z' }),
    ],
    policies: [], versions: [], outbox: [], audit: [],
  };
  sink = new Sink();
  let n = 9000;
  svc = new AccessPolicyService({ uow: new Uow(s), audit: sink, clock: () => new Date('2026-10-30T03:00:00.000Z'), newId: () => uid(n++) });
});

const create = (name = 'Điều dưỡng khoa Nội', who = U.admin) => svc.createPolicy({ name, rules: RULES }, ctxFor(who));

describe('quyền quản trị', () => {
  it('chỉ tenant_admin còn hiệu lực (theo DB) mới quản trị được', async () => {
    await expect(create('x-nurse', U.nurse)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(create('x-expired', U.exAdmin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sink.events.at(-1)).toMatchObject({ outcome: 'denied', action: 'iam.access_policy.create' });
    expect(s.policies).toHaveLength(0);
  });
});

describe('tạo / sửa / retire', () => {
  it('tạo: chuẩn hoá luật, audit có sha256 (không chép luật), outbox, snapshot phiên bản', async () => {
    const p = await create();
    expect(p).toMatchObject({ status: 'active', version: 1, createdBy: U.admin, rules: RULES });
    const ev = s.audit.at(-1)!;
    expect(ev.action).toBe('iam.access_policy.create');
    expect(String(ev.payload['rulesSha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev.payload)).not.toContain('identifiers');
    expect(s.outbox.at(-1)).toMatchObject({ eventType: 'iam.access_policy.changed', aggregateId: p.policyId });
    expect(s.versions).toHaveLength(1);
  });

  it('luật sai => VALIDATION kèm path; tên trùng => CONFLICT', async () => {
    await expect(svc.createPolicy({ name: 'bad rules', rules: [{ action: 'patient:read', hiddenFields: ['ssn'] }] }, ctxFor(U.admin)))
      .rejects.toMatchObject({ code: 'VALIDATION', details: { path: 'rules[0].hiddenFields[0]' } });
    await expect(svc.createPolicy({ name: '!!', rules: RULES }, ctxFor(U.admin))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.createPolicy({ name: 'Điều dưỡng — che CCCD, khoa Nội & Ngoại', rules: RULES }, ctxFor(U.admin))).resolves.toMatchObject({ status: 'active' });
    await expect(svc.createPolicy({ name: 'bad<script>', rules: RULES }, ctxFor(U.admin))).rejects.toMatchObject({ code: 'VALIDATION' });
    await create();
    await expect(create()).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'NAME_TAKEN' } });
  });

  it('sửa cần đúng version; ghi hash cũ và mới', async () => {
    const p = await create();
    await expect(svc.revisePolicy(p.policyId, { rules: [{ action: 'patient:read' }] }, 7, ctxFor(U.admin))).rejects.toBeInstanceOf(VersionConflictError);
    const r = await svc.revisePolicy(p.policyId, { rules: [{ action: 'patient:read' }] }, 1, ctxFor(U.admin));
    expect(r.version).toBe(2);
    expect(s.audit.at(-1)!.payload).toMatchObject({ fromVersion: 1 });
    expect(s.audit.at(-1)!.payload['rulesSha256']).not.toBe(s.audit.at(-1)!.payload['previousRulesSha256']);
    await expect(svc.revisePolicy(p.policyId, {}, 2, ctxFor(U.admin))).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('không retire được khi còn membership dùng; gỡ xong thì retire được; policy retired bất biến', async () => {
    const p = await create();
    await svc.assignPolicy(nurseM.membershipId, p.policyId, 1, ctxFor(U.admin));
    await expect(svc.retirePolicy(p.policyId, 1, ctxFor(U.admin))).rejects.toMatchObject({ details: { reason: 'POLICY_IN_USE', activeAssignments: 1 } });
    await svc.assignPolicy(nurseM.membershipId, null, 2, ctxFor(U.admin));
    const retired = await svc.retirePolicy(p.policyId, 1, ctxFor(U.admin));
    expect(retired.status).toBe('retired');
    await expect(svc.revisePolicy(p.policyId, { description: 'x' }, 2, ctxFor(U.admin))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(svc.assignPolicy(nurseM.membershipId, p.policyId, 3, ctxFor(U.admin))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const detail = await svc.getPolicy(p.policyId, ctxFor(U.admin));
    expect(detail.versions.map((v) => v.status)).toEqual(['active', 'retired']);
    expect(detail.activeAssignments).toBe(0);
  });
});

describe('gắn policy & chống tự nới quyền', () => {
  it('gắn / gỡ policy trên membership người khác: version tăng, audit from/to, outbox', async () => {
    const p = await create();
    const m = await svc.assignPolicy(nurseM.membershipId, p.policyId, 1, ctxFor(U.admin));
    expect(m).toMatchObject({ accessPolicyId: p.policyId, version: 2 });
    expect(s.audit.at(-1)).toMatchObject({ action: 'iam.membership.access_policy.assign', organizationId: ORG, payload: { fromPolicyId: null, toPolicyId: p.policyId } });
    expect(s.outbox.at(-1)).toMatchObject({ eventType: 'iam.membership.access_policy.changed' });
    await expect(svc.assignPolicy(nurseM.membershipId, null, 1, ctxFor(U.admin))).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('không được đổi policy trên membership của chính mình', async () => {
    const p = await create();
    await expect(svc.assignPolicy(adminDoctorM.membershipId, p.policyId, 1, ctxFor(U.admin))).rejects.toMatchObject({ details: { reason: 'SELF_SERVICE' } });
    await svc.assignPolicy(adminDoctorM.membershipId, p.policyId, 1, ctxFor(U.admin2));
    // admin bị giới hạn bởi p: không được tự gỡ, tự sửa hay tự retire p.
    await expect(svc.assignPolicy(adminDoctorM.membershipId, null, 2, ctxFor(U.admin))).rejects.toMatchObject({ details: { reason: 'SELF_SERVICE' } });
    await expect(svc.revisePolicy(p.policyId, { rules: [{ action: 'encounter:read' }] }, 1, ctxFor(U.admin))).rejects.toMatchObject({ details: { reason: 'SELF_SERVICE' } });
    // Một admin khác thì được.
    await expect(svc.revisePolicy(p.policyId, { rules: [{ action: 'encounter:read' }] }, 1, ctxFor(U.admin2))).resolves.toMatchObject({ version: 2 });
  });

  it('membership / policy không tồn tại => NOT_FOUND', async () => {
    await expect(svc.assignPolicy(uid(999) as MembershipId, null, 1, ctxFor(U.admin))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.assignPolicy(nurseM.membershipId, uid(998) as AccessPolicyId, 1, ctxFor(U.admin))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('whoAmI / danh sách membership', () => {
  it('whoAmI: chỉ membership còn hiệu lực, kèm tên organization; không cần quyền quản trị', async () => {
    const me = await svc.whoAmI(ctxFor(U.nurse));
    expect(me.user.userId).toBe(U.nurse);
    expect(me.memberships).toMatchObject([{ role: 'clinic_staff', organization: { organizationId: ORG, name: 'Phòng khám A' } }]);
    const ex = await svc.whoAmI(ctxFor(U.exAdmin));
    expect(ex.memberships).toHaveLength(0);
  });

  it('listMemberships: chỉ tenant_admin; trả user kèm membership', async () => {
    await expect(svc.listMemberships(ORG, ctxFor(U.nurse))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const items = await svc.listMemberships(ORG, ctxFor(U.admin));
    expect(items.length).toBe(s.memberships.length);
    expect(items.find((i) => i.membership.membershipId === nurseM.membershipId)?.user.userId).toBe(U.nurse);
    expect(s.audit.at(-1)).toMatchObject({ action: 'iam.membership.list', organizationId: ORG, actor: { id: U.admin } });
  });
});
