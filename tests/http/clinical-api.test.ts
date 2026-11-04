/**
 * HCOS-P0-ENG-001 | S2 | HTTP/FHIR layer tests (Vitest)
 *
 * Chạy server node:http thật trên cổng ngẫu nhiên, gọi bằng fetch, với ClinicalApi giả (ghi lại lời gọi).
 * Phạm vi: xác thực & tenant từ JWT, ánh xạ lỗi, FHIR in/out, ETag/If-Match, giới hạn body, an toàn header.
 * Logic phân quyền nghiệp vụ đã được kiểm ở encounter-lifecycle.test.ts và integration test.
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asPatientId, asPersonId, asTenantId, asUserId, VersionConflictError,
  type Identifier, type Patient, type Person, type TenantContext,
} from '../../packages/domain/src/s0-contracts';
import {
  asConditionId, asEncounterId, asObservationId,
  type Condition, type Encounter, type Observation,
} from '../../packages/domain/src/s1-contracts';
import { ClinicalError, type EncounterChart } from '../../services/api/src/clinical/encounter.service';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const PAT = asPatientId(uid(501));
const ENC = asEncounterId(uid(601));
const USER = asUserId(uid(101));
const T0 = '2026-10-30T03:00:00.000Z';
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

const encounter = (over: Partial<Encounter> = {}): Encounter => ({
  tenantId: TA, encounterId: ENC, patientId: PAT, organizationId: OA, practitionerUserId: USER, status: 'in_progress',
  encounterClass: 'ambulatory', reasonText: 'Ho', periodStart: T0, periodEnd: null, createdAt: T0, updatedAt: T0, version: 2, ...over,
});
const condition: Condition = {
  tenantId: TA, conditionId: asConditionId(uid(701)), patientId: PAT, encounterId: ENC, category: 'encounter_diagnosis',
  code: { system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9', display: 'URTI' }, clinicalStatus: 'active',
  verificationStatus: 'confirmed', onsetAt: null, abatedAt: null, recordedByUserId: USER, recordedAt: T0, createdAt: T0, updatedAt: T0, version: 1,
};
const observation: Observation = {
  tenantId: TA, observationId: asObservationId(uid(801)), patientId: PAT, encounterId: ENC, status: 'final',
  code: { system: 'http://loinc.org', code: '8310-5', display: 'Temp' }, value: { kind: 'quantity', value: 38.5, unit: 'Cel', ucumCode: 'Cel' },
  effectiveAt: T0, supersedesObservationId: null, recordedByUserId: USER, recordedAt: T0, createdAt: T0, updatedAt: T0, version: 1,
};

// ---------------------------------------------------------------------------
// Fake ClinicalApi
// ---------------------------------------------------------------------------
interface Call { fn: string; arg: unknown; tenantId: string; sub: string }
let calls: Call[];
let behaviour: { error?: unknown; delayMs?: number };

const rec = (fn: string, arg: unknown, ctx: TenantContext | undefined) => {
  calls.push({ fn, arg, tenantId: ctx!.tenantId, sub: ctx!.userSubject });
};
const maybeFail = async () => {
  if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
  if (behaviour.error) throw behaviour.error;
};

const fake: ClinicalApi = {
  async registerPatient(input, ctx) {
    rec('registerPatient', input, ctx); await maybeFail();
    return { tenantId: TA, patientId: PAT, personId: input.personId, organizationId: input.organizationId, mrn: input.mrn, status: 'active', registeredAt: T0, createdAt: T0, updatedAt: T0, version: 1 } as Patient;
  },
  async getPatient(id, ctx) {
    rec('getPatient', id, ctx); await maybeFail();
    const person: Person = { tenantId: TA, personId: asPersonId(uid(301)), givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', sex: 'male', phone: null, email: null, status: 'active', mergedIntoPersonId: null, createdAt: T0, updatedAt: T0, version: 1 };
    const patient: Patient = { tenantId: TA, patientId: PAT, personId: person.personId, organizationId: OA, mrn: 'MRN-1', status: 'active', registeredAt: T0, createdAt: T0, updatedAt: T0, version: 4 };
    return { person, patient, identifiers: [] as Identifier[] };
  },
  async createEncounter(input, ctx) { rec('createEncounter', input, ctx); await maybeFail(); return encounter({ version: 1 }); },
  async addCondition(input, ctx) { rec('addCondition', input, ctx); await maybeFail(); return condition; },
  async recordObservation(input, ctx) { rec('recordObservation', input, ctx); await maybeFail(); return observation; },
  async closeEncounter(id, version, ctx) {
    rec('closeEncounter', { id, version }, ctx); await maybeFail();
    return encounter({ status: 'finished', periodEnd: T0, version: version + 1 });
  },
  async getEncounterChart(id, ctx): Promise<EncounterChart> {
    rec('getEncounterChart', id, ctx); await maybeFail();
    return { encounter: encounter(), conditions: [condition], observations: [observation] };
  },
};

// ---------------------------------------------------------------------------
// Server & tokens
// ---------------------------------------------------------------------------
let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;
let logged: Array<{ message: string; meta: Record<string, unknown> }>;

async function token(over: { tenant?: string; sub?: string; roles?: string[]; org?: string } = {}) {
  return new SignJWT({ tenant_id: over.tenant ?? TA, org_id: over.org ?? OA, roles: over.roles ?? ['doctor'] })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(over.sub ?? 'sub-doc')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

interface Res { status: number; headers: Map<string, string>; json: any; text: string }
async function call(method: string, path: string, opts: { tok?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const tok = opts.tok === undefined ? await token() : opts.tok;
  if (tok) headers['authorization'] = `Bearer ${tok}`;
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/fhir+json';
  const r = await fetch(`${base}${path}`, { method, headers, body });
  const text: string = await r.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  const h = new Map<string, string>();
  r.headers.forEach((v: string, k: string) => h.set(k.toLowerCase(), v));
  return { status: r.status, headers: h, json, text };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  logged = [];
  server = createApiServer({
    tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey as any },
    clinical: fake,
    logger: { error: (message, meta) => { logged.push({ message, meta }); } },
    maxBodyBytes: 4096,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; behaviour = {}; logged.length = 0; });

const fhirEncounterBody = {
  resourceType: 'Encounter', class: { code: 'AMB' }, subject: { reference: `Patient/${PAT}` },
  serviceProvider: { reference: `Organization/${OA}` }, reasonCode: [{ text: 'Ho sốt' }],
};

// ===========================================================================
describe('S2 / authentication & tenant binding', () => {
  it('serves /healthz without auth and touches no data', async () => {
    const r = await call('GET', '/healthz', { tok: null });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'ok' });
    expect(calls).toHaveLength(0);
  });

  it('rejects missing/garbage tokens with 401 + WWW-Authenticate, for existing and unknown routes alike (no route probing)', async () => {
    for (const path of [`/fhir/Encounter/${ENC}`, '/fhir/DoesNotExist', '/api/patients']) {
      const r = await call('GET', path, { tok: null });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
      expect(r.json.resourceType).toBe('OperationOutcome');
    }
    expect((await call('GET', `/fhir/Encounter/${ENC}`, { tok: 'not.a.jwt' })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects x-tenant-id that differs from the token tenant (403) before reaching the service', async () => {
    const r = await call('GET', `/fhir/Encounter/${ENC}`, { headers: { 'x-tenant-id': TB } });
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('passes the token tenant/subject (never client data) into the service, per request, under concurrency', async () => {
    behaviour = { delayMs: 15 };
    const [a, b] = await Promise.all([
      call('GET', `/fhir/Encounter/${ENC}`, { tok: await token({ tenant: TA, sub: 'sub-a' }) }),
      call('GET', `/fhir/Encounter/${ENC}`, { tok: await token({ tenant: TB, sub: 'sub-b' }) }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(calls.map((c) => `${c.sub}@${c.tenantId}`).sort()).toEqual([`sub-a@${TA}`, `sub-b@${TB}`].sort());
  });

  it('sanitizes correlation-id: echoes a safe one, replaces an unsafe one', async () => {
    const ok = await call('GET', '/healthz', { tok: null, headers: { 'x-correlation-id': 'req-123.abc' } });
    expect(ok.headers.get('x-correlation-id')).toBe('req-123.abc');
    const bad = await call('GET', '/healthz', { tok: null, headers: { 'x-correlation-id': 'a b<script>' } });
    expect(bad.headers.get('x-correlation-id')).not.toBe('a b<script>');
    expect(/^[A-Za-z0-9._-]{1,64}$/.test(bad.headers.get('x-correlation-id') ?? '')).toBe(true);
  });
});

// ===========================================================================
describe('S2 / routing & response hygiene', () => {
  it('returns FHIR JSON with ETag, no-store and nosniff', async () => {
    const r = await call('GET', `/fhir/Encounter/${ENC}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/fhir+json; charset=utf-8');
    expect(r.headers.get('etag')).toBe('W/"2"');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.json).toMatchObject({ resourceType: 'Encounter', id: ENC, status: 'in-progress', subject: { reference: `Patient/${PAT}` } });
  });

  it('404 for unknown routes and malformed ids (service never called); 405 with Allow for wrong method', async () => {
    expect((await call('GET', '/fhir/Nope')).status).toBe(404);
    expect((await call('GET', '/fhir/Encounter/not-a-uuid')).status).toBe(404);
    expect((await call('GET', `/fhir/Encounter/${ENC}'%20OR%201=1`)).status).toBe(404);
    expect(calls).toHaveLength(0);
    const m = await call('DELETE', `/fhir/Encounter/${ENC}`);
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('GET');
  });

  it('maps service errors to FHIR OperationOutcome with the right status', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new ClinicalError('NOT_FOUND', 'Encounter not found'), 404, 'not-found'],
      [new ClinicalError('FORBIDDEN', 'Missing permission chart:read'), 403, 'forbidden'],
      [new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'MRN_TAKEN' }), 409, 'conflict'],
      [new ClinicalError('INVALID_STATE', 'Encounter is not in progress'), 409, 'conflict'],
      [new ClinicalError('VALIDATION', 'Invalid MRN format'), 422, 'invalid'],
    ];
    for (const [error, status, code] of cases) {
      behaviour = { error };
      const r = await call('GET', `/fhir/Encounter/${ENC}`);
      expect(r.status).toBe(status);
      expect(r.json).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code }] });
    }
  });

  it('does not leak a FORBIDDEN permission name, and hides internals on unexpected errors (500, logged)', async () => {
    behaviour = { error: new ClinicalError('FORBIDDEN', 'Missing permission chart:read') };
    expect((await call('GET', `/fhir/Encounter/${ENC}`)).text).not.toContain('chart:read');

    behaviour = { error: new Error('connection to db-prod-7.internal refused; password=hunter2') };
    const r = await call('GET', `/fhir/Encounter/${ENC}`);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('hunter2');
    expect(r.text).not.toContain('db-prod-7');
    expect(r.json.issue[0].diagnostics).toBe('Internal server error');
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).not.toContain('hunter2');
    expect(logged[0]!.meta['correlationId']).toBe(r.headers.get('x-correlation-id'));
  });

  it('GET Patient maps person+patient to FHIR (id = patient_id, person_id in extension)', async () => {
    const r = await call('GET', `/fhir/Patient/${PAT}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('W/"4"');
    expect(r.json).toMatchObject({ resourceType: 'Patient', id: PAT, name: [{ family: 'Nguyễn', given: ['Văn', 'An'] }] });
    expect(r.json.extension[0].valueString).toBe(uid(301));
  });

  it('$everything returns a collection Bundle; Condition/Observation search require ?encounter', async () => {
    const all = await call('GET', `/fhir/Encounter/${ENC}/$everything`);
    expect(all.status).toBe(200);
    expect(all.json).toMatchObject({ resourceType: 'Bundle', type: 'collection', total: 3 });
    expect(all.json.entry.map((e: any) => e.resource.resourceType)).toEqual(['Encounter', 'Condition', 'Observation']);

    expect((await call('GET', '/fhir/Condition')).status).toBe(400);
    expect((await call('GET', '/fhir/Observation?encounter=nope')).status).toBe(400);
    const c = await call('GET', `/fhir/Condition?encounter=${ENC}`);
    expect(c.json).toMatchObject({ type: 'searchset', total: 1 });
    const o = await call('GET', `/fhir/Observation?encounter=${ENC}`);
    expect(o.json.entry[0].resource.valueQuantity).toMatchObject({ value: 38.5, unit: 'Cel' });
  });
});

// ===========================================================================
describe('S2 / writes: parsing, limits, FHIR mapping', () => {
  it('POST Encounter => 201 + Location + ETag; server-owned fields come from the service, not the body', async () => {
    const r = await call('POST', '/fhir/Encounter', { body: { ...fhirEncounterBody, id: 'client-chosen', status: 'finished', tenantId: TB, tenant_id: TB } });
    expect(r.status).toBe(201);
    expect(r.headers.get('location')).toBe(`/fhir/Encounter/${ENC}`);
    expect(r.headers.get('etag')).toBe('W/"1"');
    expect(r.json.status).toBe('in-progress');
    expect(calls[0]).toMatchObject({ fn: 'createEncounter', tenantId: TA });
    expect(calls[0]!.arg).toEqual({ patientId: PAT, organizationId: OA, encounterClass: 'ambulatory', reasonText: 'Ho sốt' });
  });

  it('rejects bad bodies: malformed JSON 400, array 400, wrong media type 415, empty body 400, wrong resourceType 422', async () => {
    expect((await call('POST', '/fhir/Encounter', { raw: '{oops' })).status).toBe(400);
    expect((await call('POST', '/fhir/Encounter', { raw: '[]' })).status).toBe(400);
    expect((await call('POST', '/fhir/Encounter', { body: fhirEncounterBody, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call('POST', '/fhir/Encounter', {})).status).toBe(400);
    expect((await call('POST', '/fhir/Encounter', { body: { ...fhirEncounterBody, resourceType: 'Patient' } })).status).toBe(422);
    expect((await call('POST', '/fhir/Encounter', { body: { ...fhirEncounterBody, subject: { reference: 'Patient/123' } } })).status).toBe(422);
    expect((await call('POST', '/fhir/Observation', { body: { resourceType: 'Observation', valueQuantity: 'x' } })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('enforces the body size limit (413) without calling the service', async () => {
    const r = await call('POST', '/fhir/Encounter', { raw: JSON.stringify({ ...fhirEncounterBody, pad: 'x'.repeat(10_000) }) });
    expect(r.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('POST Condition forwards subject as expectedPatientId; POST Observation rejects server-owned statuses', async () => {
    const c = await call('POST', '/fhir/Condition', {
      body: { resourceType: 'Condition', subject: { reference: `Patient/${PAT}` }, encounter: { reference: `Encounter/${ENC}` }, code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9' }] } },
    });
    expect(c.status).toBe(201);
    expect(calls[0]!.arg).toMatchObject({ encounterId: ENC, expectedPatientId: PAT, code: { code: 'J06.9' } });

    const obsBody = (status: string) => ({
      resourceType: 'Observation', status, subject: { reference: `Patient/${PAT}` }, encounter: { reference: `Encounter/${ENC}` },
      code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] }, valueQuantity: { value: 37.2, unit: 'Cel' },
    });
    expect((await call('POST', '/fhir/Observation', { body: obsBody('amended') })).status).toBe(422);
    const ok = await call('POST', '/fhir/Observation', { body: obsBody('final') });
    expect(ok.status).toBe(201);
    expect(calls.at(-1)!.arg).toMatchObject({ expectedPatientId: PAT, status: 'final' });
  });

  it('POST /api/patients validates shape and returns 201 + Location', async () => {
    expect((await call('POST', '/api/patients', { body: { personId: 'x', organizationId: OA, mrn: 'M' }, headers: { 'content-type': 'application/json' } })).status).toBe(422);
    expect((await call('POST', '/api/patients', { body: { personId: uid(301), organizationId: OA, mrn: 5 }, headers: { 'content-type': 'application/json' } })).status).toBe(422);
    const r = await call('POST', '/api/patients', { body: { personId: uid(301), organizationId: OA, mrn: 'MRN-1' }, headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(201);
    expect(r.headers.get('location')).toBe(`/fhir/Patient/${PAT}`);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

// ===========================================================================
describe('S2 / optimistic concurrency via If-Match', () => {
  it('$close requires If-Match (428), validates its format (400), and passes the version to the service', async () => {
    expect((await call('POST', `/fhir/Encounter/${ENC}/$close`)).status).toBe(428);
    expect((await call('POST', `/fhir/Encounter/${ENC}/$close`, { headers: { 'if-match': 'abc' } })).status).toBe(400);
    expect((await call('POST', `/fhir/Encounter/${ENC}/$close`, { headers: { 'if-match': '*' } })).status).toBe(400);
    expect(calls).toHaveLength(0);

    const ok = await call('POST', `/fhir/Encounter/${ENC}/$close`, { headers: { 'if-match': 'W/"3"' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toBe('W/"4"');
    expect(ok.json.status).toBe('finished');
    expect(calls[0]!.arg).toEqual({ id: ENC, version: 3 });
  });

  it('a stale version surfaces as 412 Precondition Failed without leaking ids', async () => {
    behaviour = { error: new VersionConflictError('Encounter', ENC, 3) };
    const r = await call('POST', `/fhir/Encounter/${ENC}/$close`, { headers: { 'if-match': '"3"' } });
    expect(r.status).toBe(412);
    expect(r.text).not.toContain(ENC);
  });
});
