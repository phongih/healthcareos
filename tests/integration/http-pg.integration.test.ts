/**
 * HCOS-P0-ENG-001 | S2 | End-to-end: HTTP (JWT) -> ClinicalEncounterService -> PostgreSQL thật (RLS + trigger).
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGPORT=… PGUSER=… vitest run tests/integration
 * Tự tạo database `hcos_http_<pid>`, áp migration, seed bằng superuser; server chạy bằng role `hcos_app`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asTenantId, type AuditSink, type NewAuditEvent,
} from '../../packages/domain/src/s0-contracts';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../../services/api/src/clinical/encounter.service';
import { createApiServer } from '../../services/api/src/http/server';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_http_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = uid(11);
const OB = uid(13);
const U = { doc: uid(101), nurse: uid(103), pharm: uid(104), admin: uid(105), docB: uid(201) };
const PERSON_A = uid(301);
const PERSON_A2 = uid(302);
const PERSON_B = uid(401);
const PAT_B = uid(501);
const ENC_B = uid(601);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const scalar = (sql: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1'),('${OB}','${TB}','clinic','c1','C1');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES
  ('${PERSON_A}','${TA}','An','Nguyen'),('${PERSON_A2}','${TA}','Binh','Tran'),('${PERSON_B}','${TB}','Zed','Le');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.doc}','${TA}','sub-doc','Doc'),('${U.nurse}','${TA}','sub-nurse','Nurse'),('${U.pharm}','${TA}','sub-pharm','Pharm'),
  ('${U.admin}','${TA}','sub-admin','Admin'),('${U.docB}','${TB}','sub-docB','DocB');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.nurse}','${OA}','clinic_staff'),('${TA}','${U.pharm}','${OA}','pharmacist'),
  ('${TA}','${U.admin}','${OA}','tenant_admin'),('${TB}','${U.docB}','${OB}','doctor');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT_B}','${TB}','${PERSON_B}','${OB}','MRN-B');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class)
  VALUES ('${ENC_B}','${TB}','${PAT_B}','${OB}','${U.docB}','ambulatory');
`;

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('S2 / HTTP -> service -> PostgreSQL end-to-end', () => {
  let base: string;
  let server: ReturnType<typeof createApiServer>;
  let privateKey: any;
  const denied: NewAuditEvent[] = [];

  const tok = (sub: string, tenant: string, org: string, roles: string[]) =>
    new SignJWT({ tenant_id: tenant, org_id: org, roles })
      .setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuer(ISSUER).setAudience(AUDIENCE)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);

  const T = {
    doc: () => tok('sub-doc', TA, OA, ['doctor']),
    nurse: () => tok('sub-nurse', TA, OA, ['clinic_staff']),
    pharm: () => tok('sub-pharm', TA, OA, ['pharmacist']),
    admin: () => tok('sub-admin', TA, OA, ['tenant_admin']),
    docB: () => tok('sub-docB', TB, OB, ['doctor']),
  };

  async function http(method: string, path: string, token: Promise<string>, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token}`, ...(body !== undefined ? { 'content-type': 'application/fhir+json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text: string = await r.text();
    return { status: r.status as number, etag: r.headers.get('etag') as string | null, location: r.headers.get('location') as string | null, json: text ? JSON.parse(text) : undefined, text };
  }

  let patientId = '';
  let encounterId = '';

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    suFile(`${MIG}/001_s0_init.sql`);
    suFile(`${MIG}/002_s1_clinical_init.sql`);
    su(SEED);

    const kp = await generateKeyPair('RS256');
    privateKey = kp.privateKey;
    const sink: AuditSink = { record: async (e) => { if (e.outcome === 'denied') denied.push(e); } };
    const clinical = new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(psqlPool({ database: DB })), audit: sink });
    server = createApiServer({
      tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey as any, tenantStatus: { getStatus: async () => 'active' } },
      clinical,
      logger: { error: () => undefined },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('runs the whole clinical flow over HTTP with role-correct actors', async () => {
    const reg = await http('POST', '/api/patients', T.nurse(), { personId: PERSON_A, organizationId: OA, mrn: 'MRN-001' }, { 'content-type': 'application/json' });
    expect(reg.status).toBe(201);
    patientId = reg.json.patientId;
    expect(reg.location).toBe(`/fhir/Patient/${patientId}`);

    const enc = await http('POST', '/fhir/Encounter', T.doc(), {
      resourceType: 'Encounter', class: { code: 'AMB' }, subject: { reference: `Patient/${patientId}` },
      serviceProvider: { reference: `Organization/${OA}` }, reasonCode: [{ text: 'Ho sốt' }],
    });
    expect(enc.status).toBe(201);
    expect(enc.etag).toBe('W/"1"');
    encounterId = enc.json.id;
    expect(enc.json.participant[0].individual.reference).toBe(`Practitioner/${U.doc}`);

    const cond = await http('POST', '/fhir/Condition', T.doc(), {
      resourceType: 'Condition', subject: { reference: `Patient/${patientId}` }, encounter: { reference: `Encounter/${encounterId}` },
      code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9', display: 'URTI' }] },
    });
    expect(cond.status).toBe(201);

    const obs = await http('POST', '/fhir/Observation', T.nurse(), {
      resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${patientId}` }, encounter: { reference: `Encounter/${encounterId}` },
      code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] }, valueQuantity: { value: 38.5, unit: 'Cel', system: 'http://unitsofmeasure.org', code: 'Cel' },
    });
    expect(obs.status).toBe(201);

    const all = await http('GET', `/fhir/Encounter/${encounterId}/$everything`, T.pharm());
    expect(all.status).toBe(200);
    expect(all.json.total).toBe(3);

    const pat = await http('GET', `/fhir/Patient/${patientId}`, T.pharm());
    expect(pat.status).toBe(200);
    expect(pat.json.id).toBe(patientId);
    expect(pat.json.extension[0].valueString).toBe(PERSON_A);
  });

  it('enforces If-Match on close, then freezes the encounter (409 on later writes)', async () => {
    expect((await http('POST', `/fhir/Encounter/${encounterId}/$close`, T.doc())).status).toBe(428);
    expect((await http('POST', `/fhir/Encounter/${encounterId}/$close`, T.doc(), undefined, { 'if-match': 'W/"9"' })).status).toBe(412);
    expect((await http('POST', `/fhir/Encounter/${encounterId}/$close`, T.nurse(), undefined, { 'if-match': 'W/"1"' })).status).toBe(403);

    const closed = await http('POST', `/fhir/Encounter/${encounterId}/$close`, T.doc(), undefined, { 'if-match': 'W/"1"' });
    expect(closed.status).toBe(200);
    expect(closed.etag).toBe('W/"2"');
    expect(closed.json.status).toBe('finished');

    const late = await http('POST', '/fhir/Observation', T.nurse(), {
      resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${patientId}` }, encounter: { reference: `Encounter/${encounterId}` },
      code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] }, valueQuantity: { value: 37, unit: 'Cel' },
    });
    expect(late.status).toBe(409);
  });

  it('cross-tenant over HTTP: 404 both ways, never a 200/403 that would confirm existence; tenant header spoof => 403', async () => {
    expect((await http('GET', `/fhir/Encounter/${encounterId}`, T.docB())).status).toBe(404);
    expect((await http('GET', `/fhir/Patient/${patientId}`, T.docB())).status).toBe(404);
    expect((await http('GET', `/fhir/Encounter/${ENC_B}`, T.doc())).status).toBe(404);
    expect((await http('GET', `/fhir/Condition?encounter=${ENC_B}`, T.doc())).status).toBe(404);
    expect((await http('GET', `/fhir/Patient/${PAT_B}`, T.doc())).status).toBe(404);
    expect((await http('GET', `/fhir/Encounter/${encounterId}`, T.doc(), undefined, { 'x-tenant-id': TB })).status).toBe(403);
    expect(scalar(`SELECT status||'|'||version FROM clinical.encounters WHERE encounter_id='${ENC_B}'`)).toBe('in_progress|1');
  });

  it('role separation over HTTP: tenant_admin gets 403 on clinical reads; denial is audited', async () => {
    const before = denied.length;
    expect((await http('GET', `/fhir/Encounter/${encounterId}`, T.admin())).status).toBe(403);
    expect((await http('GET', `/fhir/Patient/${patientId}`, T.admin())).status).toBe(403);
    expect(denied.length - before).toBe(2);
  });

  it('subject integrity and duplicate registry over HTTP', async () => {
    // Đợt khám mới để thử subject lệch (đợt đầu đã đóng).
    const p2 = await http('POST', '/api/patients', T.nurse(), { personId: PERSON_A2, organizationId: OA, mrn: 'MRN-002' }, { 'content-type': 'application/json' });
    expect(p2.status).toBe(201);
    const e2 = await http('POST', '/fhir/Encounter', T.doc(), {
      resourceType: 'Encounter', class: { code: 'AMB' }, subject: { reference: `Patient/${p2.json.patientId}` }, serviceProvider: { reference: `Organization/${OA}` },
    });
    const wrongSubject = await http('POST', '/fhir/Condition', T.doc(), {
      resourceType: 'Condition', subject: { reference: `Patient/${patientId}` }, encounter: { reference: `Encounter/${e2.json.id}` },
      code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9' }] },
    });
    expect(wrongSubject.status).toBe(422);
    expect(scalar(`SELECT count(*) FROM clinical.conditions WHERE encounter_id='${e2.json.id}'`)).toBe('0');

    const dup = await http('POST', '/api/patients', T.nurse(), { personId: PERSON_A, organizationId: OA, mrn: 'MRN-XYZ' }, { 'content-type': 'application/json' });
    expect(dup.status).toBe(409);
    const mrn = await http('POST', '/api/patients', T.nurse(), { personId: PERSON_A2, organizationId: OA, mrn: 'MRN-001' }, { 'content-type': 'application/json' });
    expect(mrn.status).toBe(409);
  });

  it('leaves a verifiable audit trail: successful clinical actions logged, hash-chain intact, no PHI in payloads', () => {
    expect(Number(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND outcome='success'`)) >= 8).toBe(true);
    expect(scalar(`
      WITH o AS (SELECT prev_hash, lag(event_hash) OVER (ORDER BY occurred_at, event_id) AS expected FROM platform.audit_events WHERE tenant_id='${TA}')
      SELECT count(*) FROM o WHERE expected IS NOT NULL AND prev_hash <> expected`)).toBe('0');
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND payload::text ILIKE '%Ho sốt%'`)).toBe('0');
  });
});
