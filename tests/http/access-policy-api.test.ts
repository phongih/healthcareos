/**
 * HCOS-P0-ENG-001 | IAM | HTTP: route quản trị access policy + nhãn REDACTED trên FHIR (API giả, server node:http thật).
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asPatientId, asPersonId, asTenantId, asUserId,
  type AccessPolicyId, type Identifier, type Membership, type MembershipId, type Patient, type Person,
} from '../../packages/domain/src/s0-contracts';
import { asEncounterId, type Encounter } from '../../packages/domain/src/s1-contracts';
import { validateAccessRules, type AccessPolicy } from '../../packages/security/src/access-policy';
import { ClinicalError } from '../../services/api/src/clinical/encounter.service';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { AccessPolicyApi } from '../../services/api/src/http/iam-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const PAT = asPatientId(uid(501));
const ENC = asEncounterId(uid(601));
const USER = asUserId(uid(101));
const POL = uid(901) as AccessPolicyId;
const MEM = uid(701) as MembershipId;
const T0 = '2026-10-30T03:00:00.000Z';
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

const policy = (over: Partial<AccessPolicy> = {}): AccessPolicy => ({
  tenantId: TA, policyId: POL, name: 'Điều dưỡng', description: null, status: 'active',
  rules: validateAccessRules([{ action: 'patient:read', hiddenFields: ['identifiers'] }]), createdBy: USER, createdAt: T0, updatedAt: T0, version: 3, ...over,
});
const person: Person = { tenantId: TA, personId: asPersonId(uid(301)), givenName: 'Văn An', familyName: 'Nguyễn', birthDate: null, sex: 'male', phone: null, email: null, status: 'active', mergedIntoPersonId: null, createdAt: T0, updatedAt: T0, version: 1 };
const patient: Patient = { tenantId: TA, patientId: PAT, personId: person.personId, organizationId: OA, mrn: 'MRN-1', status: 'active', registeredAt: T0, createdAt: T0, updatedAt: T0, version: 4 };
const encounter: Encounter = {
  tenantId: TA, encounterId: ENC, patientId: PAT, organizationId: OA, practitionerUserId: USER, status: 'in_progress',
  encounterClass: 'ambulatory', reasonText: null, periodStart: T0, periodEnd: null, createdAt: T0, updatedAt: T0, version: 2,
};

let calls: Array<{ fn: string; args: unknown[] }>;
let failWith: unknown;
const hit = async (fn: string, ...args: unknown[]) => {
  calls.push({ fn, args: args.slice(0, -1) });
  if (failWith) throw failWith;
};

const clinical: ClinicalApi = {
  async registerPatient() { throw new Error('unused'); },
  async getPatient() { return { person, patient, identifiers: [] as Identifier[], redacted: ['identifiers'] }; },
  async searchPatients() { return [{ person, patient, identifiers: [], redacted: ['identifiers'] }]; },
  async createEncounter() { throw new Error('unused'); },
  async addCondition() { throw new Error('unused'); },
  async recordObservation() { throw new Error('unused'); },
  async closeEncounter() { throw new Error('unused'); },
  async getEncounterChart() { return { encounter, conditions: [], observations: [], redacted: ['conditions', 'encounter.reasonText'] }; },
  async listEncountersForPatient() { return { encounters: [encounter], filtered: 1, redactedEncounterIds: [ENC] }; },
  async listOpenEncounters() { return { items: [], filtered: 0 }; },
};

const policiesApi: AccessPolicyApi = {
  async listPolicies(ctx) { await hit('listPolicies', ctx); return [policy()]; },
  async getPolicy(id, ctx) { await hit('getPolicy', id, ctx); return { policy: policy(), versions: [], activeAssignments: 2 }; },
  async createPolicy(input, ctx) {
    await hit('createPolicy', input, ctx);
    return policy({ name: input.name, rules: validateAccessRules(input.rules), version: 1 });
  },
  async revisePolicy(id, input, v, ctx) { await hit('revisePolicy', id, input, v, ctx); return policy({ version: v + 1 }); },
  async retirePolicy(id, v, ctx) { await hit('retirePolicy', id, v, ctx); return policy({ status: 'retired', version: v + 1 }); },
  async assignPolicy(id, pid, v, ctx) {
    await hit('assignPolicy', id, pid, v, ctx);
    return { tenantId: TA, membershipId: id, userId: USER, organizationId: OA, role: 'clinic_staff', status: 'active', validFrom: T0, validTo: null, accessPolicyId: pid, createdAt: T0, updatedAt: T0, version: v + 1 } as Membership;
  },
  validateRules(raw) { return validateAccessRules(raw); },
  async whoAmI(ctx) {
    await hit('whoAmI', ctx);
    return { user: { userId: USER, displayName: 'Admin', email: null }, memberships: [{ membershipId: MEM, organization: { organizationId: OA, name: 'PK A', type: 'clinic' }, role: 'tenant_admin', accessPolicyId: null }] };
  },
  async listMemberships(org, ctx) { await hit('listMemberships', org, ctx); return []; },
};

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const tok = await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['tenant_admin'] })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-admin').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  const headers: Record<string, string> = { authorization: `Bearer ${tok}`, ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
  const r = await fetch(`${base}${path}`, { method, headers, body });
  const text = await r.text();
  return { status: r.status, etag: r.headers.get('etag'), location: r.headers.get('location'), json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical, accessPolicies: policiesApi });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; failWith = undefined; });

describe('FHIR: nhãn REDACTED khi policy che trường', () => {
  it('Patient đọc đơn và trong Bundle tìm kiếm có meta.security REDACTED', async () => {
    const one = await call('GET', `/fhir/Patient/${PAT}`);
    expect(one.status).toBe(200);
    expect(one.json.meta.security).toEqual([{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'REDACTED', display: 'redacted' }]);
    const many = await call('GET', `/fhir/Patient?organization=${OA}&mrn=MRN-1`);
    expect(many.json.entry[0].resource.meta.security[0].code).toBe('REDACTED');
  });

  it('$everything và Condition search đánh dấu Bundle; Observation không bị che thì không gắn nhãn', async () => {
    const ev = await call('GET', `/fhir/Encounter/${ENC}/$everything`);
    expect(ev.json.meta.security[0].code).toBe('REDACTED');
    expect(ev.json.entry[0].resource.meta.security[0].code).toBe('REDACTED');
    const cond = await call('GET', `/fhir/Condition?encounter=${ENC}`);
    expect(cond.json.meta.security[0].code).toBe('REDACTED');
    const obs = await call('GET', `/fhir/Observation?encounter=${ENC}`);
    expect(obs.json.meta).toBeUndefined();
  });
});

describe('route quản trị /api/access-policies', () => {
  it('liệt kê, xem (ETag), danh mục', async () => {
    expect((await call('GET', '/api/access-policies')).json.policies).toHaveLength(1);
    const one = await call('GET', `/api/access-policies/${POL}`);
    expect(one.etag).toBe('W/"3"');
    expect(one.json.activeAssignments).toBe(2);
    const cat = await call('GET', '/api/access-policies/catalog');
    expect(Object.keys(cat.json.actions)).toContain('observation:write');
  });

  it('tạo: 201 + Location; luật sai: 422 kèm path', async () => {
    const ok = await call('POST', '/api/access-policies', { body: { name: 'Thu ngân', rules: [{ action: 'patient:read', hiddenFields: ['identifiers'] }] } });
    expect(ok.status).toBe(201);
    expect(ok.location).toBe(`/api/access-policies/${POL}`);
    failWith = new ClinicalError('VALIDATION', 'rules[0].action: bad', { path: 'rules[0].action' });
    const bad = await call('POST', '/api/access-policies', { body: { name: 'x', rules: [{ action: 'nope' }] } });
    expect(bad.status).toBe(422);
    expect(bad.json).toMatchObject({ error: 'INVALID_RULES', path: 'rules[0].action' });
  });

  it('validate (không ghi): 200 với luật đã chuẩn hoá hoặc 422 kèm path', async () => {
    const ok = await call('POST', '/api/access-policies/validate', { body: { rules: [{ action: 'encounter:read', criteria: { practitioner: 'self' } }] } });
    expect(ok.json).toMatchObject({ valid: true, rules: [{ action: 'encounter:read' }] });
    const bad = await call('POST', '/api/access-policies/validate', { body: { rules: [{ action: 'encounter:read', criteria: { practitioner: 'all' } }] } });
    expect(bad.status).toBe(422);
    expect(bad.json.path).toBe('rules[0].criteria.practitioner');
    expect(calls.map((c) => c.fn)).not.toContain('createPolicy');
  });

  it('revise / retire / assign bắt buộc If-Match', async () => {
    expect((await call('POST', `/api/access-policies/${POL}/revise`, { body: { description: 'x' } })).status).toBe(428);
    const rev = await call('POST', `/api/access-policies/${POL}/revise`, { body: { description: 'x' }, headers: { 'if-match': 'W/"3"' } });
    expect(rev.etag).toBe('W/"4"');
    expect(calls.at(-1)).toMatchObject({ fn: 'revisePolicy', args: [POL, { description: 'x' }, 3] });
    const ret = await call('POST', `/api/access-policies/${POL}/retire`, { headers: { 'if-match': '"4"' } });
    expect(ret.json.status).toBe('retired');
    const asg = await call('POST', `/api/memberships/${MEM}/access-policy`, { body: { policyId: POL }, headers: { 'if-match': 'W/"1"' } });
    expect(asg.json.accessPolicyId).toBe(POL);
    const unasg = await call('POST', `/api/memberships/${MEM}/access-policy`, { body: { policyId: null }, headers: { 'if-match': 'W/"2"' } });
    expect(unasg.json.accessPolicyId).toBeNull();
    expect((await call('POST', `/api/memberships/${MEM}/access-policy`, { body: { policyId: 'abc' }, headers: { 'if-match': 'W/"2"' } })).status).toBe(422);
  });

  it('retire khi còn dùng => 409 POLICY_IN_USE; không có quyền => 403 không lộ chi tiết', async () => {
    failWith = new ClinicalError('INVALID_STATE', 'in use', { reason: 'POLICY_IN_USE', activeAssignments: 2 });
    const r = await call('POST', `/api/access-policies/${POL}/retire`, { headers: { 'if-match': 'W/"3"' } });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'POLICY_IN_USE', activeAssignments: 2 });
    failWith = new ClinicalError('FORBIDDEN', 'Missing permission iam:access_policy:manage');
    const f = await call('GET', '/api/access-policies/catalog');
    expect(f.status).toBe(403);
    expect(JSON.stringify(f.json)).not.toContain('iam:access_policy');
  });

  it('/api/me và /api/memberships?organization=', async () => {
    expect((await call('GET', '/api/me')).json.memberships[0].role).toBe('tenant_admin');
    expect((await call('GET', '/api/memberships')).status).toBe(400);
    expect((await call('GET', `/api/memberships?organization=${OA}`)).json).toEqual({ memberships: [] });
    expect(calls.at(-1)).toMatchObject({ fn: 'listMemberships', args: [OA] });
  });

  it('GET /fhir/Encounter?patient=: Bundle searchset, gắn REDACTED cho đợt bị che; thiếu patient => 400', async () => {
    const r = await call('GET', `/fhir/Encounter?patient=${PAT}`);
    expect(r.json).toMatchObject({ resourceType: 'Bundle', type: 'searchset', total: 1, meta: { security: [{ code: 'REDACTED' }] } });
    expect(r.json.entry[0].resource.meta.security[0].code).toBe('REDACTED');
    expect((await call('GET', '/fhir/Encounter')).status).toBe(400);
    expect((await call('GET', `/fhir/Encounter?patient=${PAT}&status=x`)).status).toBe(400);
  });
});

