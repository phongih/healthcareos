/**
 * HCOS-P0-ENG-001 | Person Registry | Integration: HTTP -> PersonRegistryService -> PostgreSQL thật (migration 001-003)
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGPORT=… PGUSER=… vitest run tests/integration
 * Tự tạo DB `hcos_reg_<pid>`; ứng dụng chạy bằng role `hcos_app` (RLS hiệu lực). Không đặt HCOS_IT=1 => bỏ qua.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenantId, type AuditSink } from '../../packages/domain/src/s0-contracts';
import { PgAuditSink } from '../../packages/security/src/pg-audit-sink';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../../services/api/src/clinical/encounter.service';
import { createApiServer } from '../../services/api/src/http/server';
import { PersonRegistryService, PgRegistryUnitOfWork } from '../../services/api/src/registry/person-registry.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_reg_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = uid(11);
const OB = uid(13);
const U = { nurse: uid(101), pharm: uid(103), clinicAdmin: uid(104), tenantAdmin: uid(105), patientUser: uid(106), nurseB: uid(201) };
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const scalar = (sql: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1'),('${OB}','${TB}','clinic','c1','C1');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.nurse}','${TA}','sub-nurse','N'),('${U.pharm}','${TA}','sub-pharm','P'),('${U.clinicAdmin}','${TA}','sub-clinicAdmin','CA'),
  ('${U.tenantAdmin}','${TA}','sub-tenantAdmin','TA'),('${U.patientUser}','${TA}','sub-patientUser','PU'),('${U.nurseB}','${TB}','sub-nurseB','NB');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.nurse}','${OA}','clinic_staff'),('${TA}','${U.pharm}','${OA}','pharmacist'),('${TA}','${U.clinicAdmin}','${OA}','clinic_admin'),
  ('${TA}','${U.tenantAdmin}','${OA}','tenant_admin'),('${TA}','${U.patientUser}','${OA}','patient'),('${TB}','${U.nurseB}','${OB}','clinic_staff');
`;

const CCCD = { type: 'national_id', system: 'https://moh.gov.vn/cccd', value: '079090000001' };
const BHYT = { type: 'health_insurance', system: 'https://bhxh.gov.vn/bhyt', value: 'DN4797912345678' };
const BOOM = { type: 'external', system: 'urn:test:boom', value: 'BOOM1' };

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Person Registry / HTTP -> service -> PostgreSQL', () => {
  let base: string;
  let server: ReturnType<typeof createApiServer>;
  let privateKey: any;

  const tok = (sub: string, tenant: string, org: string, roles: string[]) =>
    new SignJWT({ tenant_id: tenant, org_id: org, roles })
      .setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuer(ISSUER).setAudience(AUDIENCE)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const T = {
    nurse: () => tok('sub-nurse', TA, OA, ['clinic_staff']),
    pharm: () => tok('sub-pharm', TA, OA, ['pharmacist']),
    clinicAdmin: () => tok('sub-clinicAdmin', TA, OA, ['clinic_admin']),
    tenantAdmin: () => tok('sub-tenantAdmin', TA, OA, ['tenant_admin']),
    patientUser: () => tok('sub-patientUser', TA, OA, ['patient']),
    nurseB: () => tok('sub-nurseB', TB, OB, ['clinic_staff']),
  };

  async function http(method: string, path: string, token: Promise<string>, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text: string = await r.text();
    return { status: r.status as number, etag: r.headers.get('etag') as string | null, contentLocation: r.headers.get('content-location') as string | null, json: text ? JSON.parse(text) : undefined, text };
  }

  async function asApp<R>(tenant: string | null, fn: (c: PsqlClient) => Promise<R>): Promise<R> {
    const c = new PsqlClient({ database: DB });
    try {
      if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
      return await fn(c);
    } finally {
      c.close();
    }
  }

  let S: any; // source
  let Tg: any; // target
  let D: any; // third person
  let patientId = '';
  let mergeBody: any;

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    suFile(`${MIG}/001_s0_init.sql`);
    suFile(`${MIG}/002_s1_clinical_init.sql`);
    suFile(`${MIG}/003_person_registry.sql`);
    su(SEED);

    const kp = await generateKeyPair('RS256');
    privateKey = kp.privateKey;
    const pool = psqlPool({ database: DB });
    const sink: AuditSink = new PgAuditSink(pool);
    server = createApiServer({
      tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey as any, tenantStatus: { getStatus: async () => 'active' } },
      clinical: new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit: sink }),
      registry: new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit: sink }),
      logger: { error: () => undefined },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('creates persons with identifiers; blocks duplicates with ranked candidates; override needs a reason', async () => {
    const a = await http('POST', '/api/persons', T.nurse(), {
      givenName: 'Nguyen', familyName: 'Van An', birthDate: '1990-05-17', sex: 'male', phone: '+84 987 654 321', email: 'an@example.vn', identifiers: [CCCD, BOOM],
    });
    expect(a.status).toBe(201);
    expect(a.etag).toBe('W/"1"');
    S = a.json.person;
    expect(S.phone).toBe('0987654321');
    expect(a.json.identifiers.map((i: any) => i.value).sort()).toEqual(['079090000001', 'BOOM1']);

    const dup = await http('POST', '/api/persons', T.nurse(), { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', identifiers: [BHYT] });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ error: 'DUPLICATE_CANDIDATES', candidates: [{ personId: S.personId, level: 'probable', reasons: ['NAME_DOB_MATCH'] }] });
    expect(scalar(`SELECT count(*) FROM patient.persons WHERE tenant_id='${TA}'`)).toBe('1');

    const noReason = await http('POST', '/api/persons', T.nurse(), { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', duplicateOverride: { reason: 'x' } });
    expect(noReason.status).toBe(422);
    const ok = await http('POST', '/api/persons', T.nurse(), {
      givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', identifiers: [BHYT], duplicateOverride: { reason: 'Khai báo lại do mất giấy tờ' },
    });
    expect(ok.status).toBe(201);
    Tg = ok.json.person;
    expect(scalar(`SELECT name_key||'|'||coalesce(phone_key,'-') FROM patient.persons WHERE person_id='${S.personId}'`)).toBe('an nguyen van|0987654321');
  });

  it('enforces identifier uniqueness in the database (409), and exposes search to pharmacists', async () => {
    expect((await http('POST', `/api/persons/${Tg.personId}/identifiers`, T.nurse(), CCCD)).status).toBe(409);
    expect((await http('POST', '/api/persons', T.nurse(), { givenName: 'Ai Đó', familyName: 'Khác', identifiers: [CCCD], duplicateOverride: { reason: 'cố tình tạo trùng' } })).status).toBe(409);

    const s = await http('POST', '/api/persons/search-duplicates', T.pharm(), { identifiers: [CCCD] });
    expect(s.status).toBe(200);
    expect(s.json.candidates).toEqual([{ personId: S.personId, score: 100, level: 'definite', reasons: ['IDENTIFIER_MATCH'] }]);
    expect((await http('POST', '/api/persons/search-duplicates', T.pharm(), {})).status).toBe(422);
    expect((await http('POST', '/api/persons', T.pharm(), { givenName: 'X', familyName: 'Y' })).status).toBe(403);

    const d = await http('POST', '/api/persons', T.nurse(), { givenName: 'Thị Hoa', familyName: 'Lê', birthDate: '1975-01-01' });
    expect(d.status).toBe(201);
    D = d.json.person;
  });

  it('sets up a patient record and a patient-app account on the source person', async () => {
    const reg = await http('POST', '/api/patients', T.nurse(), { personId: S.personId, organizationId: OA, mrn: 'MRN-S1' });
    expect(reg.status).toBe(201);
    patientId = reg.json.patientId;
    su(`UPDATE iam.users SET person_id='${S.personId}' WHERE user_id='${U.patientUser}'`);
    const me = await http('GET', `/api/persons/${S.personId}`, T.patientUser());
    expect(me.status).toBe(200);
  });

  it('merge authorization: only clinic_admin/tenant_admin; cross-tenant merge is impossible', async () => {
    mergeBody = { targetPersonId: Tg.personId, reason: 'Cùng một người, đối chiếu CCCD', expectedSourceVersion: S.version, expectedTargetVersion: Tg.version };
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.nurse(), mergeBody)).status).toBe(403);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.pharm(), mergeBody)).status).toBe(403);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.patientUser(), mergeBody)).status).toBe(403);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.nurseB(), mergeBody)).status).toBe(403);
    expect((await http('GET', `/api/persons/${S.personId}`, T.nurseB())).status).toBe(404);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, targetPersonId: uid(9999) })).status).toBe(404);
    expect(scalar(`SELECT count(*) FROM patient.person_merges`)).toBe('0');
  });

  it('a failure in the middle of a merge rolls back EVERYTHING (real transaction)', async () => {
    su(`CREATE FUNCTION public.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.value = 'BOOM1' AND NEW.person_id <> OLD.person_id THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER zz_boom BEFORE UPDATE ON patient.identifiers FOR EACH ROW EXECUTE FUNCTION public.boom();`);
    const snapshot = () => scalar(`SELECT
      (SELECT string_agg(status||':'||version, ',' ORDER BY person_id) FROM patient.persons) || '#' ||
      (SELECT string_agg(person_id::text, ',' ORDER BY patient_id) FROM patient.patients) || '#' ||
      (SELECT string_agg(person_id::text||':'||status, ',' ORDER BY identifier_id) FROM patient.identifiers) || '#' ||
      (SELECT person_id::text FROM iam.users WHERE user_id='${U.patientUser}') || '#' ||
      (SELECT count(*) FROM patient.person_merges)`);
    const before = snapshot();
    const r = await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), mergeBody);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('boom');
    expect(snapshot()).toBe(before);
    su('DROP TRIGGER zz_boom ON patient.identifiers; DROP FUNCTION public.boom()');
  });

  it('stale versions give 412-class conflicts and change nothing; bad input is rejected', async () => {
    const before = scalar(`SELECT string_agg(status||':'||version, ',' ORDER BY person_id) FROM patient.persons`);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, expectedSourceVersion: 99 })).status).toBe(412);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, expectedTargetVersion: 99 })).status).toBe(412);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, reason: 'ngắn' })).status).toBe(422);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, targetPersonId: S.personId })).status).toBe(422);
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, targetPersonId: 'nope' })).status).toBe(422);
    expect(scalar(`SELECT string_agg(status||':'||version, ',' ORDER BY person_id) FROM patient.persons`)).toBe(before);
  });

  it('merges for real: patients/identifiers/users move, history + outbox written, old id redirects to the survivor', async () => {
    const r = await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), mergeBody);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ sourcePersonId: S.personId, targetPersonId: Tg.personId, movedPatientIds: [patientId], repointedUserIds: [U.patientUser] });
    expect(r.json.movedIdentifierIds).toHaveLength(2);
    expect(r.json.target).toMatchObject({ version: Tg.version + 1, sex: 'male', phone: '0987654321', email: 'an@example.vn', givenName: 'Văn An' });

    expect(scalar(`SELECT status||'|'||merged_into_person_id FROM patient.persons WHERE person_id='${S.personId}'`)).toBe(`merged|${Tg.personId}`);
    expect(scalar(`SELECT person_id FROM patient.patients WHERE patient_id='${patientId}'`)).toBe(Tg.personId);
    expect(scalar(`SELECT count(*) FROM patient.identifiers WHERE person_id='${Tg.personId}' AND status='active'`)).toBe('3');
    expect(scalar(`SELECT person_id FROM iam.users WHERE user_id='${U.patientUser}'`)).toBe(Tg.personId);
    expect(scalar(`SELECT phone_key FROM patient.persons WHERE person_id='${Tg.personId}'`)).toBe('0987654321');
    expect(scalar(`SELECT reason||'|'||merged_by_user_id||'|'||(source_snapshot->>'givenName')||'|'||cardinality(moved_patient_ids) FROM patient.person_merges`))
      .toBe(`Cùng một người, đối chiếu CCCD|${U.clinicAdmin}|Nguyen|1`);
    expect(scalar(`SELECT count(*) FROM platform.outbox_events WHERE event_type='patient.person.merged'`)).toBe('1');

    const via = await http('GET', `/api/persons/${S.personId}`, T.pharm());
    expect(via.status).toBe(200);
    expect(via.json.person.personId).toBe(Tg.personId);
    expect(via.json.redirectedFrom).toBe(S.personId);
    expect(via.contentLocation).toBe(`/api/persons/${Tg.personId}`);

    // Hồ sơ bệnh nhân (patient_id không đổi) giờ thuộc person đích; người dùng bệnh nhân vẫn đọc được chính mình qua ID cũ.
    const fhir = await http('GET', `/fhir/Patient/${patientId}`, T.pharm());
    expect(fhir.status).toBe(200);
    expect(fhir.json.extension[0].valueString).toBe(Tg.personId);
    expect((await http('GET', `/api/persons/${S.personId}`, T.patientUser())).status).toBe(200);

    // Không thể merge lần hai, không thể đăng ký bệnh nhân trên person đã merge.
    expect((await http('POST', `/api/persons/${S.personId}/merge`, T.clinicAdmin(), { ...mergeBody, expectedSourceVersion: 3, expectedTargetVersion: Tg.version + 1 })).status).toBe(409);
    expect((await http('POST', '/api/patients', T.nurse(), { personId: S.personId, organizationId: OA, mrn: 'MRN-X' })).status).toBe(409);
  });

  it('database guards hold against direct writes (merged immutable, merge target rules, append-only history, identifier immutability)', async () => {
    const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? 'ERR');
    await asApp(TA, async (c) => {
      expect(await code(c.query("UPDATE patient.persons SET phone = '0900000000' WHERE person_id = $1", [S.personId]))).toBe('55000');
      expect(await code(c.query("UPDATE patient.persons SET status='merged', merged_into_person_id=$2 WHERE person_id=$1", [D.personId, S.personId]))).toBe('55000'); // đích đã merge
      expect(await code(c.query("UPDATE patient.persons SET status='merged', merged_into_person_id=$1 WHERE person_id=$1", [D.personId]))).toBe('55000'); // tự merge
      expect(await code(c.query('UPDATE patient.persons SET merged_into_person_id=$2 WHERE person_id=$1', [D.personId, Tg.personId]))).toBe('55000'); // không qua merge
      expect(await code(c.query("UPDATE patient.person_merges SET reason='sửa lịch sử'"))).toBe('42501');
      expect(await code(c.query('DELETE FROM patient.person_merges'))).toBe('42501');
      expect(await code(c.query("UPDATE patient.identifiers SET value='000000000' WHERE person_id=$1", [Tg.personId]))).toBe('42501');
      expect(await code(c.query(
        `INSERT INTO patient.person_merges(tenant_id,source_person_id,target_person_id,reason,merged_by_user_id,source_snapshot)
         VALUES ($1,$2,$3,'tạo giả lịch sử',$4,'{}'::jsonb)`, [TB, D.personId, Tg.personId, U.clinicAdmin]))).toBe('42501');
      expect(Number((await c.query('SELECT count(*)::int AS n FROM patient.person_merges')).rows[0].n)).toBe(1);
    });
    await asApp(TB, async (c) => {
      expect(Number((await c.query('SELECT count(*)::int AS n FROM patient.person_merges')).rows[0].n)).toBe(0);
      expect(Number((await c.query('SELECT count(*)::int AS n FROM patient.persons')).rows[0].n)).toBe(0);
    });

    // Định danh "nhập nhầm" là trạng thái cuối.
    const added = await http('POST', `/api/persons/${D.personId}/identifiers`, T.nurse(), { type: 'passport', system: 'urn:passport:vn', value: 'b1234567' });
    expect(added.status).toBe(201);
    expect(added.json.value).toBe('B1234567');
    expect((await http('POST', `/api/identifiers/${added.json.identifierId}/retire`, T.nurse(), { status: 'entered_in_error' })).status).toBe(428);
    expect((await http('POST', `/api/identifiers/${added.json.identifierId}/retire`, T.nurse(), { status: 'entered_in_error' }, { 'if-match': 'W/"7"' })).status).toBe(412);
    expect((await http('POST', `/api/identifiers/${added.json.identifierId}/retire`, T.nurse(), { status: 'entered_in_error' }, { 'if-match': added.etag! })).status).toBe(200);
    await asApp(TA, async (c) => {
      expect(await code(c.query("UPDATE patient.identifiers SET status='active' WHERE identifier_id=$1", [added.json.identifierId]))).toBe('55000');
    });
  });

  it('keeps tenants apart and the audit trail clean (hash-chain intact, no PHI)', async () => {
    const b = await http('POST', '/api/persons', T.nurseB(), { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', identifiers: [CCCD, BHYT] });
    expect(b.status).toBe(201); // cùng danh tính ở tenant khác: không va chạm, không thấy nhau
    expect(b.json.possibleDuplicates).toEqual([]);

    expect(Number(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND action LIKE 'person.%' AND outcome='success'`)) >= 5).toBe(true);
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND action LIKE 'person.%' AND outcome='denied'`)).not.toBe('0');
    expect(scalar(`
      WITH o AS (SELECT prev_hash, lag(event_hash) OVER (ORDER BY occurred_at, event_id) AS expected FROM platform.audit_events WHERE tenant_id='${TA}')
      SELECT count(*) FROM o WHERE expected IS NOT NULL AND prev_hash <> expected`)).toBe('0');
    for (const phi of ['Nguyen', 'Nguyễn', '079090000001', 'DN4797912345678', '0987654321', 'an@example.vn', '1990-05-17']) {
      expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE payload::text ILIKE '%${phi}%'`)).toBe('0');
    }
  });
});
