/**
 * HCOS-P0-ENG-001 | Person Registry | Integration: HTTP -> PersonRegistryService -> PostgreSQL thật (migration 001-004)
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
    suFile(`${MIG}/004_person_unmerge.sql`);
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

  // ---- Unmerge ----------------------------------------------------------
  const OID = (n: number) => `00000000-0000-4000-8000-${(0xa000 + n).toString(16).padStart(12, '0')}`;
  async function mkPair(n: number, extraSrcIds: object[] = []) {
    const mkP = async (given: string, family: string, dob: string, extra: object) => {
      const r = await http('POST', '/api/persons', T.nurse(), { givenName: given, familyName: family, birthDate: dob, ...extra });
      expect(r.status).toBe(201);
      return r.json.person;
    };
    const src = await mkP(`Nguồn${'ab'[n % 2]}${n}`, `Họ${n}`, `1980-0${(n % 9) + 1}-1${n}`, {
      sex: 'female', phone: `09010000${n}${n}`, email: `src${n}@example.vn`,
      identifiers: [{ type: 'external', system: `urn:test:u${n}`, value: `SRC${n}` }, ...extraSrcIds],
    });
    const tgt = await mkP(`Đích${n}`, `Lê${n}`, `1970-0${(n % 9) + 1}-2${n}`, {});
    const reg = await http('POST', '/api/patients', T.nurse(), { personId: src.personId, organizationId: OA, mrn: `MRN-U${n}` });
    expect(reg.status).toBe(201);
    return { src, tgt, patientId: reg.json.patientId as string };
  }
  const ver = (id: string) => Number(scalar(`SELECT version FROM patient.persons WHERE person_id='${id}'`));
  const doMerge = (src: any, tgt: any) => http('POST', `/api/persons/${src.personId}/merge`, T.clinicAdmin(), {
    targetPersonId: tgt.personId, reason: 'Gộp để kiểm thử unmerge', expectedSourceVersion: ver(src.personId), expectedTargetVersion: ver(tgt.personId),
  });
  const unmergeBody = (src: any, tgt: any, o: object = {}) => ({ reason: 'Merge nhầm, hai người khác nhau', expectedSourceVersion: ver(src.personId), expectedTargetVersion: ver(tgt.personId), ...o });

  it('unmerges for real: restores source/target/patients/identifiers/users, writes history + outbox; guarded by role and versions', async () => {
    const { src, tgt, patientId: pid } = await mkPair(1);
    const sid = scalar(`SELECT identifier_id FROM patient.identifiers WHERE person_id='${src.personId}' AND value='SRC1'`);
    su(`UPDATE iam.users SET person_id='${src.personId}' WHERE user_id='${U.tenantAdmin}'`);
    const m = await doMerge(src, tgt);
    expect(m.status).toBe(200);
    expect(scalar(`SELECT phone FROM patient.persons WHERE person_id='${tgt.personId}'`)).toBe('0901000011'); // target nhận phone của source

    const u = `/api/persons/${src.personId}/unmerge`;
    expect((await http('POST', u, T.nurse(), unmergeBody(src, tgt))).status).toBe(403);
    expect((await http('POST', u, T.pharm(), unmergeBody(src, tgt))).status).toBe(403);
    expect((await http('POST', u, T.nurseB(), unmergeBody(src, tgt))).status).toBe(403);
    expect((await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt, { reason: 'ngắn' }))).status).toBe(422);
    expect((await http('POST', u, T.clinicAdmin(), { reason: 'Merge nhầm, hai người khác nhau' })).status).toBe(422);
    expect((await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt, { expectedSourceVersion: 99 }))).status).toBe(412);
    expect((await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt, { expectedTargetVersion: 99 }))).status).toBe(412);
    expect(scalar(`SELECT count(*) FROM patient.person_unmerges`)).toBe('0');
    expect(scalar(`SELECT status FROM patient.persons WHERE person_id='${src.personId}'`)).toBe('merged');

    const r = await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ restoredPatientIds: [pid], restoredIdentifierIds: [sid], restoredUserIds: [U.tenantAdmin], leftInactiveIdentifierIds: [] });
    expect(r.etag).toBe(`W/"${ver(src.personId)}"`);
    expect(scalar(`SELECT status||'|'||coalesce(merged_into_person_id::text,'-') FROM patient.persons WHERE person_id='${src.personId}'`)).toBe('active|-');
    expect(scalar(`SELECT coalesce(phone,'-')||'|'||coalesce(email,'-')||'|'||coalesce(sex,'-')||'|'||coalesce(phone_key,'-') FROM patient.persons WHERE person_id='${tgt.personId}'`)).toBe('-|-|-|-'); // target về đúng như trước merge
    expect(scalar(`SELECT person_id FROM patient.patients WHERE patient_id='${pid}'`)).toBe(src.personId);
    expect(scalar(`SELECT person_id FROM patient.identifiers WHERE identifier_id='${sid}'`)).toBe(src.personId);
    expect(scalar(`SELECT person_id FROM iam.users WHERE user_id='${U.tenantAdmin}'`)).toBe(src.personId);
    expect(scalar(`SELECT reason||'|'||unmerged_by_user_id||'|'||cardinality(restored_patient_ids) FROM patient.person_unmerges`)).toBe(`Merge nhầm, hai người khác nhau|${U.clinicAdmin}|1`);
    expect(scalar(`SELECT count(*) FROM platform.outbox_events WHERE event_type='patient.person.unmerged'`)).toBe('1');
    // source đọc lại như person độc lập (không còn redirect)
    const g = await http('GET', `/api/persons/${src.personId}`, T.pharm());
    expect(g.status).toBe(200);
    expect(g.json.person.personId).toBe(src.personId);
    expect(g.json.redirectedFrom).toBeNull();

    // Không hoàn tác hai lần; nhưng có thể merge lại và hoàn tác lại (merge đang hiệu lực mới).
    expect((await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt))).status).toBe(409);
    expect((await doMerge(src, tgt)).status).toBe(200);
    expect(scalar(`SELECT count(*) FROM patient.person_merges WHERE source_person_id='${src.personId}'`)).toBe('2');
    expect((await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt))).status).toBe(200);
    expect(scalar(`SELECT count(*) FROM patient.person_unmerges`)).toBe('2');
    su(`UPDATE iam.users SET person_id=NULL WHERE user_id='${U.tenantAdmin}'`);
  });

  it('refuses to unmerge (409 UNMERGE_BLOCKED, nothing changes) once the survivor, its records or users were altered', async () => {
    const { src, tgt, patientId: pid } = await mkPair(2);
    await doMerge(src, tgt);
    const snap = () => scalar(`SELECT (SELECT string_agg(status||':'||version, ',' ORDER BY person_id) FROM patient.persons) || '#' ||
      (SELECT count(*) FROM patient.person_unmerges) || '#' || (SELECT person_id FROM patient.patients WHERE patient_id='${pid}')`);
    const u = `/api/persons/${src.personId}/unmerge`;

    su(`UPDATE patient.persons SET email='doi@example.vn' WHERE person_id='${tgt.personId}'`); // target bị sửa sau merge
    let before = snap();
    let r = await http('POST', u, T.clinicAdmin(), unmergeBody(src, tgt));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('UNMERGE_BLOCKED');
    expect(r.json.blockers).toContain('TARGET_MODIFIED');
    expect(snap()).toBe(before);

    // Hồ sơ bệnh nhân đã bị chuyển sang người khác => PATIENTS_CHANGED
    const { src: s3, tgt: t3, patientId: p3 } = await mkPair(3);
    await doMerge(s3, t3);
    const other = (await http('POST', '/api/persons', T.nurse(), { givenName: 'Người', familyName: 'Khác', birthDate: '1960-06-06' })).json.person;
    su(`ALTER TABLE patient.patients DISABLE TRIGGER USER; UPDATE patient.patients SET person_id='${other.personId}' WHERE patient_id='${p3}'; ALTER TABLE patient.patients ENABLE TRIGGER USER;`);
    before = snap();
    r = await http('POST', `/api/persons/${s3.personId}/unmerge`, T.clinicAdmin(), unmergeBody(s3, t3));
    expect(r.status).toBe(409);
    expect(r.json.blockers).toContain('PATIENTS_CHANGED');
    expect(scalar(`SELECT count(*) FROM patient.person_unmerges`)).toBe('2'); // chỉ hai bản ghi từ test trước
  });

  it('rolls an unmerge back completely when a step fails midway (real transaction)', async () => {
    const { src, tgt, patientId: pid } = await mkPair(4);
    await doMerge(src, tgt);
    su(`CREATE FUNCTION public.boom2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.value = 'SRC4' AND NEW.person_id <> OLD.person_id THEN RAISE EXCEPTION 'boom2'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER zz_boom2 BEFORE UPDATE ON patient.identifiers FOR EACH ROW EXECUTE FUNCTION public.boom2();`);
    const snap = () => scalar(`SELECT (SELECT string_agg(status||':'||version, ',' ORDER BY person_id) FROM patient.persons) || '#' ||
      (SELECT count(*) FROM patient.person_unmerges) || '#' || (SELECT person_id FROM patient.patients WHERE patient_id='${pid}')`);
    const before = snap();
    const r = await http('POST', `/api/persons/${src.personId}/unmerge`, T.clinicAdmin(), unmergeBody(src, tgt));
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('boom2');
    expect(snap()).toBe(before);
    su('DROP TRIGGER zz_boom2 ON patient.identifiers; DROP FUNCTION public.boom2()');
  });

  it('database: a merged person can only return to active together with a matching, same-transaction unmerge record', async () => {
    const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? 'ERR');
    const { src, tgt } = await mkPair(5);
    await doMerge(src, tgt);
    await asApp(TA, async (c) => {
      // Không có bản ghi unmerge => vẫn bất biến.
      expect(await code(c.query("UPDATE patient.persons SET status='active', merged_into_person_id=NULL WHERE person_id=$1", [src.personId]))).toBe('55000');
      // Bản ghi unmerge giả (merge_id không tồn tại / sai cặp) không đủ.
      expect(await code(c.query(
        `INSERT INTO patient.person_unmerges(tenant_id,merge_id,source_person_id,target_person_id,reason,unmerged_by_user_id)
         VALUES ($1,$2,$3,$4,'tạo giả để mở khoá',$5)`, [TA, uid(424242), src.personId, tgt.personId, U.clinicAdmin]))).not.toBe('OK');
      expect(await code(c.query("UPDATE patient.persons SET status='active', merged_into_person_id=NULL WHERE person_id=$1", [src.personId]))).toBe('55000');
      // Lịch sử unmerge là append-only.
      expect(await code(c.query("UPDATE patient.person_unmerges SET reason='sửa lịch sử'"))).toBe('42501');
      expect(await code(c.query('DELETE FROM patient.person_unmerges'))).toBe('42501');
      // Không thể sửa thông tin định danh khi hoàn tác (kể cả có bản ghi hợp lệ): chỉ trạng thái được đổi.
    });
    // Tenant khác không thấy lịch sử unmerge.
    await asApp(TB, async (c) => {
      expect(Number((await c.query('SELECT count(*)::int AS n FROM patient.person_unmerges')).rows[0].n)).toBe(0);
    });
    // Merge một lần: không thể có hai merge đang hiệu lực cho cùng một source.
    expect((await doMerge(src, tgt)).status).toBe(409);
  });

  // ---- POST /fhir/Patient & GET /fhir/Patient ----------------------------
  const fhirPatient = (o: { mrn: string; family?: string; given?: string[]; birth?: string; ids?: object[]; org?: string }) => ({
    resourceType: 'Patient',
    name: [{ family: o.family ?? 'Võ', given: o.given ?? ['Thanh', 'Hà'] }],
    gender: 'female',
    birthDate: o.birth ?? '2001-09-09',
    telecom: [{ system: 'phone', value: '0933111222' }],
    managingOrganization: { reference: `Organization/${o.org ?? OA}` },
    identifier: [
      { type: { text: 'mrn' }, system: `urn:hcos:mrn:${o.org ?? OA}`, value: o.mrn },
      ...(o.ids ?? []),
    ],
  });
  const FHIR_CT = { 'content-type': 'application/fhir+json' };

  it('POST /fhir/Patient creates person + identifiers + patient atomically (201, Location, ETag, FHIR body)', async () => {
    const body = fhirPatient({ mrn: 'MRN-F1', ids: [{ type: { text: 'national_id' }, system: 'https://moh.gov.vn/cccd', value: '079301000777' }] });
    const r = await http('POST', '/fhir/Patient', T.nurse(), body, FHIR_CT);
    expect(r.status).toBe(201);
    expect(r.etag).toBe('W/"1"');
    expect(r.json.resourceType).toBe('Patient');
    expect(r.json.managingOrganization.reference).toBe(`Organization/${OA}`);
    expect(r.json.id).toBeTruthy();
    expect(scalar(`SELECT count(*) FROM patient.patients WHERE mrn='MRN-F1' AND organization_id='${OA}'`)).toBe('1');
    expect(scalar(`SELECT count(*) FROM patient.identifiers WHERE value='079301000777' AND status='active'`)).toBe('1');
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE action='patient.register' AND outcome='success' AND payload::text NOT ILIKE '%Thanh%'`)).not.toBe('0');
    const got = await http('GET', `/fhir/Patient/${r.json.id}`, T.pharm());
    expect(got.status).toBe(200);
  });

  it('POST /fhir/Patient leaves NO orphan person when MRN or identifier clashes, and rejects bad FHIR / wrong role / other tenant', async () => {
    const persons = () => scalar('SELECT count(*) FROM patient.persons');
    const before = persons();
    const mrnClash = await http('POST', '/fhir/Patient', T.nurse(), fhirPatient({ mrn: 'MRN-F1', family: 'Khác', given: ['Hoàn'], birth: '1999-01-01' }), FHIR_CT);
    expect(mrnClash.status).toBe(409);
    const idClash = await http('POST', '/fhir/Patient', T.nurse(), fhirPatient({ mrn: 'MRN-F2', family: 'Khác', given: ['Hoàn'], birth: '1999-01-01', ids: [{ type: { text: 'national_id' }, system: 'https://moh.gov.vn/cccd', value: '079301000777' }] }), FHIR_CT);
    expect(idClash.status).toBe(409);
    expect(persons()).toBe(before);
    expect(scalar(`SELECT count(*) FROM patient.patients WHERE mrn='MRN-F2'`)).toBe('0');

    const dup = await http('POST', '/fhir/Patient', T.nurse(), fhirPatient({ mrn: 'MRN-F3' }), FHIR_CT); // cùng tên/ngày sinh với MRN-F1
    expect(dup.status).toBe(409);
    expect(persons()).toBe(before);

    expect((await http('POST', '/fhir/Patient', T.pharm(), fhirPatient({ mrn: 'MRN-F4', family: 'Ba', given: ['Lê'], birth: '1950-05-05' }), FHIR_CT)).status).toBe(403);
    expect((await http('POST', '/fhir/Patient', T.patientUser(), fhirPatient({ mrn: 'MRN-F4', family: 'Ba', given: ['Lê'], birth: '1950-05-05' }), FHIR_CT)).status).toBe(403);
    expect((await http('POST', '/fhir/Patient', T.nurseB(), fhirPatient({ mrn: 'MRN-F4', family: 'Ba', given: ['Lê'], birth: '1950-05-05' }), FHIR_CT)).status).toBe(403);
    expect((await http('POST', '/fhir/Patient', T.nurse(), fhirPatient({ mrn: 'MRN-F4', org: OB, family: 'Ba', given: ['Lê'], birth: '1950-05-05' }), FHIR_CT)).status).toBe(403);
    const noMrn = fhirPatient({ mrn: 'x' }); (noMrn.identifier as object[]).shift();
    expect((await http('POST', '/fhir/Patient', T.nurse(), noMrn, FHIR_CT)).status).toBe(422);
    expect((await http('POST', '/fhir/Patient', T.nurse(), { ...fhirPatient({ mrn: 'MRN-F5' }), resourceType: 'Observation' }, FHIR_CT)).status).toBe(422);
    expect((await http('POST', '/fhir/Patient', T.nurse(), { ...fhirPatient({ mrn: 'MRN-F5' }), managingOrganization: { reference: 'Organization/nope' } }, FHIR_CT)).status).toBe(422);
    expect((await http('POST', '/fhir/Patient', T.nurse(), { ...fhirPatient({ mrn: 'MRN-F5' }), birthDate: '31/12/2000' }, FHIR_CT)).status).toBe(422);
    expect(persons()).toBe(before);
  });

  it('GET /fhir/Patient searches inside one organization (mrn, identifier, name+birthdate), strictly validated and tenant-safe', async () => {
    const q = (qs: string, t = T.pharm()) => http('GET', `/fhir/Patient?${qs}`, t);
    const byMrn = await q(`organization=${OA}&mrn=MRN-F1`);
    expect(byMrn.status).toBe(200);
    expect(byMrn.json).toMatchObject({ resourceType: 'Bundle', type: 'searchset' });
    expect(byMrn.json.entry).toHaveLength(1);
    const byId = await q(`organization=${OA}&identifier=${encodeURIComponent('https://moh.gov.vn/cccd|079301000777')}`);
    expect(byId.json.entry).toHaveLength(1);
    const byName = await q(`organization=${OA}&given=${encodeURIComponent('Thanh Ha')}&family=Vo&birthdate=2001-09-09`);
    expect(byName.json.entry).toHaveLength(1);
    expect((await q(`organization=${OA}&mrn=MRN-NOPE`)).json.entry ?? []).toHaveLength(0);

    expect((await q('mrn=MRN-F1')).status).toBe(400);                                        // thiếu organization
    expect((await q(`organization=${OA}&mrn=MRN-F1&foo=1`)).status).toBe(400);               // tham số lạ
    expect((await q(`organization=${OA}&mrn=A&mrn=B`)).status).toBe(400);                    // lặp tham số
    expect((await q(`organization=${OA}`)).status).toBe(422);                                // không có tiêu chí
    expect((await q(`organization=${OA}&given=Thanh&family=Vo`)).status).toBe(422);          // thiếu birthdate
    expect((await q(`organization=${OA}&identifier=novalue`)).status).toBe(422);
    expect((await q(`organization=${OA}&mrn=MRN-F1&_count=99`)).status).toBe(422);
    expect((await q(`organization=${OA}&mrn=MRN-F1`, T.patientUser())).status).toBe(403);
    expect((await q(`organization=${OA}&mrn=MRN-F1`, T.nurseB())).status).toBe(403);         // tenant khác
    expect((await q(`organization=${OB}&mrn=MRN-F1`)).status).toBe(403);                     // org ngoài phạm vi token
    const dump = scalar(`SELECT count(*) FROM platform.audit_events WHERE action='patient.search' AND (payload::text ILIKE '%MRN-F1%' OR payload::text ILIKE '%079301000777%' OR payload::text ILIKE '%2001-09-09%')`);
    expect(dump).toBe('0');
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE action='patient.search' AND outcome='success'`)).not.toBe('0');
  });

  it('keeps tenants apart and the audit trail clean (hash-chain intact, no PHI)', async () => {
    const b = await http('POST', '/api/persons', T.nurseB(), { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', identifiers: [CCCD, BHYT] });
    expect(b.status).toBe(201); // cùng danh tính ở tenant khác: không va chạm, không thấy nhau
    expect(b.json.possibleDuplicates).toEqual([]);

    expect(Number(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND action LIKE 'person.%' AND outcome='success'`)) >= 5).toBe(true);
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND action LIKE 'person.%' AND outcome='denied'`)).not.toBe('0');
    // Chuỗi hash toàn vẹn, KHÔNG phụ thuộc thứ tự thời gian (nhiều sự kiện cùng transaction có cùng occurred_at):
    // mỗi prev_hash là genesis hoặc event_hash của đúng một sự kiện khác; không rẽ nhánh; đúng một genesis.
    expect(scalar(`SELECT count(*) FROM platform.audit_events e WHERE e.tenant_id='${TA}' AND e.prev_hash <> '\\x00'::bytea
      AND NOT EXISTS (SELECT 1 FROM platform.audit_events p WHERE p.tenant_id=e.tenant_id AND p.event_hash=e.prev_hash)`)).toBe('0');
    expect(scalar(`SELECT count(*) - count(DISTINCT prev_hash) FROM platform.audit_events WHERE tenant_id='${TA}'`)).toBe('0');
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND prev_hash = '\\x00'::bytea`)).toBe('1');
    for (const phi of ['Nguyen', 'Nguyễn', '079090000001', 'DN4797912345678', '0987654321', 'an@example.vn', '1990-05-17']) {
      expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE payload::text ILIKE '%${phi}%'`)).toBe('0');
    }
  });
});
