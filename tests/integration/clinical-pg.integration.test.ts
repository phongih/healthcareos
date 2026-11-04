/**
 * HCOS-P0-ENG-001 | Gate G0 + G1 | Integration test trên PostgreSQL thật (RLS, trigger, FK, hash-chain, service end-to-end).
 *
 * Chạy: HCOS_IT=1 PGHOST=<host|socket-dir> PGPORT=5432 PGUSER=<superuser> vitest run tests/integration
 * Test tự tạo database mới `hcos_it_<pid>`, áp migration 001 + 002, seed bằng superuser, rồi chạy mọi thao tác
 * của ứng dụng bằng role `hcos_app` (không bypass RLS) qua PgClinicalUnitOfWork.
 * Không đặt HCOS_IT=1 => suite bị bỏ qua.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asPatientId, asPersonId, asTenantId, asUserId, VersionConflictError,
  type AuditSink, type CorrelationId, type NewAuditEvent, type OrganizationId, type Role, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { asEncounterId } from '../../packages/domain/src/s1-contracts';
import { withTenantTransaction } from '../../packages/security/src/tenant-context';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../../services/api/src/clinical/encounter.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(13));
const U = { doc: asUserId(uid(101)), doc2: asUserId(uid(102)), nurse: asUserId(uid(103)), admin: asUserId(uid(105)), docB: asUserId(uid(201)) };
const PA1 = asPersonId(uid(301));
const PA2 = asPersonId(uid(302));
const PB1 = asPersonId(uid(401));
const PAT_B = asPatientId(uid(501));
const ENC_B = asEncounterId(uid(601));

const ICD = { system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9', display: 'URTI' };
const LOINC = { system: 'http://loinc.org', code: '8310-5', display: 'Body temperature' };
const sub = (u: string) => `sub-${u}`;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[], roles: Role[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: sub(u), userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([...roles]), tokenId: null, correlationId: 'it-corr' as CorrelationId,
  });
const C = {
  doc: ctx(TA, U.doc, [OA], ['doctor']),
  doc2: ctx(TA, U.doc2, [OA], ['doctor']),
  nurse: ctx(TA, U.nurse, [OA], ['clinic_staff']),
  admin: ctx(TA, U.admin, [OA], ['tenant_admin']),
  docB: ctx(TB, U.docB, [OB], ['doctor']),
};

const su = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const suScalar = (sql: string) =>
  execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1'),('${OB}','${TB}','clinic','c1','C1');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES
  ('${PA1}','${TA}','An','Nguyen'),('${PA2}','${TA}','Binh','Tran'),('${PB1}','${TB}','Zed','Le');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.doc}','${TA}','${sub(U.doc)}','Doc'),('${U.doc2}','${TA}','${sub(U.doc2)}','Doc2'),
  ('${U.nurse}','${TA}','${sub(U.nurse)}','Nurse'),('${U.admin}','${TA}','${sub(U.admin)}','Admin'),('${U.docB}','${TB}','${sub(U.docB)}','DocB');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.doc2}','${OA}','doctor'),('${TA}','${U.nurse}','${OA}','clinic_staff'),
  ('${TA}','${U.admin}','${OA}','tenant_admin'),('${TB}','${U.docB}','${OB}','doctor');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT_B}','${TB}','${PB1}','${OB}','MRN-B');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class,reason_text)
  VALUES ('${ENC_B}','${TB}','${PAT_B}','${OB}','${U.docB}','ambulatory','B-private');
`;

class Sink implements AuditSink {
  events: NewAuditEvent[] = [];
  async record(e: NewAuditEvent) { this.events.push(e); }
}

const code = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; name?: string; details?: { reason?: string } }) =>
    e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? e.name ?? 'ERR');

/** Chạy câu lệnh thô với tư cách hcos_app, có/không tenant context. */
async function asApp<T>(tenant: TenantId | null, fn: (q: PsqlClient) => Promise<T>): Promise<T> {
  const c = new PsqlClient({ database: DB });
  try {
    if (tenant) {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
      await c.query("SELECT set_config('app.user_id', 'raw-test', false)");
    }
    return await fn(c);
  } finally {
    c.close();
  }
}

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('G0+G1 / PostgreSQL integration (real RLS, triggers, service)', () => {
  let svc: ClinicalEncounterService;
  let sink: Sink;
  let patientId: ReturnType<typeof asPatientId>;
  let encounterId: ReturnType<typeof asEncounterId>;
  let openEncounterId: ReturnType<typeof asEncounterId>;

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    suFile(`${MIG}/001_s0_init.sql`);
    suFile(`${MIG}/002_s1_clinical_init.sql`);
    su(SEED);
    sink = new Sink();
    svc = new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(psqlPool({ database: DB })), audit: sink });
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  // ---- Service end-to-end trên PostgreSQL thật ----------------------------
  it('registers a patient and runs the full encounter lifecycle through PgClinicalUnitOfWork', async () => {
    const patient = await svc.registerPatient({ personId: PA1, organizationId: OA, mrn: 'MRN-001' }, C.nurse);
    patientId = patient.patientId;
    expect(patient).toMatchObject({ tenantId: TA, personId: PA1, version: 1, status: 'active' });

    const enc = await svc.createEncounter({ patientId, organizationId: OA, encounterClass: 'ambulatory', reasonText: 'Ho sốt' }, C.doc);
    encounterId = enc.encounterId;
    expect(enc).toMatchObject({ status: 'in_progress', practitionerUserId: U.doc, version: 1 });

    await svc.addCondition({ encounterId, code: ICD }, C.doc);
    await svc.recordObservation(
      { encounterId, code: LOINC, value: { kind: 'quantity', value: 38.5, unit: 'Cel', ucumCode: 'Cel' } }, C.nurse);

    const closed = await svc.closeEncounter(encounterId, 1, C.doc);
    expect(closed).toMatchObject({ status: 'finished', version: 2 });
    expect(closed.periodEnd).not.toBeNull();

    const chart = await svc.getEncounterChart(encounterId, C.doc2);
    expect(chart.conditions).toHaveLength(1);
    expect(chart.observations).toHaveLength(1);
    expect(chart.observations[0]!.value).toEqual({ kind: 'quantity', value: 38.5, unit: 'Cel', ucumCode: 'Cel' });

    expect(suScalar(`SELECT string_agg(event_type, ',' ORDER BY created_at, outbox_id) FROM platform.outbox_events WHERE tenant_id='${TA}'`).split(',').sort())
      .toEqual(['clinical.condition.recorded', 'clinical.encounter.created', 'clinical.encounter.finished', 'clinical.observation.recorded', 'patient.registered']);
    expect(suScalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND outcome='success'`)).toBe('6');
    // Provenance: lần UPDATE encounter (close) được chụp snapshot kèm người sửa.
    expect(suScalar(`SELECT record_version||'|'||changed_by FROM clinical.record_history WHERE table_name='encounters' AND record_id='${encounterId}'`))
      .toBe(`1|${sub(U.doc)}`);
  });

  it('keeps the audit hash-chain intact for the tenant', () => {
    const broken = suScalar(`
      WITH o AS (SELECT event_hash, prev_hash, lag(event_hash) OVER (ORDER BY occurred_at, event_id) AS expected
                 FROM platform.audit_events WHERE tenant_id='${TA}')
      SELECT count(*) FROM o WHERE expected IS NOT NULL AND prev_hash <> expected`);
    expect(broken).toBe('0');
  });

  it('detects a stale version on close against the real table', async () => {
    const p = await svc.registerPatient({ personId: PA2, organizationId: OA, mrn: 'MRN-002' }, C.nurse);
    const e = await svc.createEncounter({ patientId: p.patientId, organizationId: OA, encounterClass: 'ambulatory' }, C.doc);
    openEncounterId = e.encounterId;
    await expect(svc.closeEncounter(e.encounterId, 9, C.doc)).rejects.toBeInstanceOf(VersionConflictError);
    expect(suScalar(`SELECT status||'|'||version FROM clinical.encounters WHERE encounter_id='${e.encounterId}'`)).toBe('in_progress|1');
  });

  // ---- Trùng lặp / va chạm ID (lỗi 23505 thật -> CONFLICT) ---------------
  it('maps real unique violations to CONFLICT reasons (person twice, MRN taken, duplicate condition)', async () => {
    expect(await code(svc.registerPatient({ personId: PA1, organizationId: OA, mrn: 'MRN-NEW' }, C.nurse))).toBe('CONFLICT:PERSON_ALREADY_REGISTERED');
    const other = asPersonId(uid(303));
    su(`INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${other}','${TA}','C','D')`);
    expect(await code(svc.registerPatient({ personId: other, organizationId: OA, mrn: 'MRN-001' }, C.nurse))).toBe('CONFLICT:MRN_TAKEN');
    expect(await code(svc.addCondition({ encounterId: openEncounterId, code: ICD }, C.doc))).toBe('OK');
    expect(await code(svc.addCondition({ encounterId: openEncounterId, code: ICD }, C.doc))).toBe('CONFLICT:DUPLICATE_CONDITION');
    expect(suScalar(`SELECT count(*) FROM clinical.conditions WHERE encounter_id='${openEncounterId}'`)).toBe('1');
    // Đợt khám đã đóng: trigger/service từ chối ghi thêm.
    expect(await code(svc.addCondition({ encounterId, code: ICD }, C.doc))).toBe('INVALID_STATE');
  });

  it('patient_id collision across tenants: PK violation surfaces as ID_COLLISION without touching tenant B', async () => {
    const colliding = new ClinicalEncounterService({
      uow: new PgClinicalUnitOfWork(psqlPool({ database: DB })), audit: sink, newId: () => PAT_B,
    });
    const third = asPersonId(uid(304));
    su(`INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${third}','${TA}','E','F')`);
    const before = suScalar(`SELECT tenant_id||'|'||mrn||'|'||version FROM patient.patients WHERE patient_id='${PAT_B}'`);
    expect(await code(colliding.registerPatient({ personId: third, organizationId: OA, mrn: 'MRN-COL' }, C.nurse))).toBe('CONFLICT:ID_COLLISION');
    expect(suScalar(`SELECT tenant_id||'|'||mrn||'|'||version FROM patient.patients WHERE patient_id='${PAT_B}'`)).toBe(before);
    expect(suScalar(`SELECT count(*) FROM patient.patients WHERE tenant_id='${TA}' AND mrn='MRN-COL'`)).toBe('0');
  });

  // ---- Truy cập trái phép -------------------------------------------------
  it('cross-tenant access returns NOT_FOUND in both directions and never mutates the other tenant', async () => {
    expect(await code(svc.getEncounterChart(encounterId, C.docB))).toBe('NOT_FOUND');
    expect(await code(svc.addCondition({ encounterId, code: ICD }, C.docB))).toBe('NOT_FOUND');
    expect(await code(svc.getEncounterChart(ENC_B, C.doc))).toBe('NOT_FOUND');
    expect(await code(svc.closeEncounter(ENC_B, 1, C.doc))).toBe('NOT_FOUND');
    expect(await code(svc.createEncounter({ patientId: PAT_B, organizationId: OA, encounterClass: 'ambulatory' }, C.doc))).toBe('NOT_FOUND');
    expect(suScalar(`SELECT status||'|'||version FROM clinical.encounters WHERE encounter_id='${ENC_B}'`)).toBe('in_progress|1');
  });

  it('role separation holds against the real memberships table', async () => {
    expect(await code(svc.getEncounterChart(encounterId, C.admin))).toBe('FORBIDDEN');
    expect(await code(svc.addCondition({ encounterId, code: ICD }, C.nurse))).toBe('FORBIDDEN');
    expect(await code(svc.getEncounterChart(encounterId, C.nurse))).toBe('OK');
  });

  it('records denied attempts in the audit sink without PHI', () => {
    const denied = sink.events.filter((e) => e.outcome === 'denied');
    expect(denied.length > 0).toBe(true);
    expect(JSON.stringify(denied)).not.toContain('Ho sốt');
  });

  // ---- Bất biến & cách ly ở tầng DB (hcos_app, không bypass RLS) ----------
  it('DB-level RLS: no tenant context => zero rows; tenant B sees none of tenant A; cross-tenant writes rejected', async () => {
    expect((await asApp(null, (c) => c.query('SELECT 1 FROM patient.patients'))).rowCount).toBe(0);
    expect((await asApp(TB, (c) => c.query('SELECT 1 FROM clinical.encounters WHERE tenant_id = $1', [TA]))).rowCount).toBe(0);
    await expect(asApp(TA, (c) => c.query("INSERT INTO patient.persons(tenant_id,given_name,family_name) VALUES ($1,'h','h')", [TB])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('DB-level: composite FKs reject cross-tenant / cross-patient references', async () => {
    await expect(asApp(TA, (c) => c.query(
      'INSERT INTO patient.patients(tenant_id,person_id,organization_id,mrn) VALUES ($1,$2,$3,$4)', [TA, PA2, OB, 'X-1'])))
      .rejects.toMatchObject({ code: '23503' });
    await expect(asApp(TA, (c) => c.query(
      `INSERT INTO clinical.observations(tenant_id,patient_id,encounter_id,code_system,code,value_string,recorded_by_user_id)
       VALUES ($1,$2,$3,'loinc','1','x',$4)`, [TA, PAT_B, openEncounterId, U.doc])))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('DB-level: audit and clinical history are append-only; clinical rows cannot be deleted', async () => {
    await expect(asApp(TA, (c) => c.query("UPDATE platform.audit_events SET action='x'"))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(TA, (c) => c.query('DELETE FROM platform.audit_events'))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(TA, (c) => c.query('DELETE FROM clinical.record_history'))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(TA, (c) => c.query('DELETE FROM clinical.encounters'))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(TA, (c) => c.query('DELETE FROM clinical.observations'))).rejects.toMatchObject({ code: '42501' });
  });

  it('DB-level: finalized observation and closed encounter are immutable; tenant_id cannot change', async () => {
    await expect(asApp(TA, (c) => c.query("UPDATE clinical.observations SET value_numeric = 99 WHERE encounter_id = $1", [encounterId])))
      .rejects.toMatchObject({ code: '55000' });
    await expect(asApp(TA, (c) => c.query("UPDATE clinical.encounters SET status='in_progress' WHERE encounter_id = $1", [encounterId])))
      .rejects.toMatchObject({ code: '55000' });
    await expect(asApp(TA, (c) => c.query('UPDATE patient.persons SET tenant_id = $1 WHERE person_id = $2', [TB, PA1])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asApp(TA, (c) => c.query(
      `INSERT INTO clinical.observations(tenant_id,patient_id,encounter_id,code_system,code,value_string,recorded_by_user_id)
       VALUES ($1,$2,$3,'loinc','1','x',$4)`, [TA, patientId, encounterId, U.doc])))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('withTenantTransaction binds RLS per transaction and does not leak tenant between pooled sessions', async () => {
    const pool = psqlPool({ database: DB });
    const a = await withTenantTransaction(pool, (db) => db.query<{ n: string }>('SELECT count(*)::int AS n FROM clinical.encounters'), C.doc);
    const b = await withTenantTransaction(pool, (db) => db.query<{ n: string }>('SELECT count(*)::int AS n FROM clinical.encounters'), C.docB);
    expect(Number(a.rows[0]!.n) >= 2).toBe(true); // 2 đợt khám tenant A
    expect(Number(b.rows[0]!.n)).toBe(1); // chỉ ENC_B
  });
});
