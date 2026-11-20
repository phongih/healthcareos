/**
 * HCOS-P0-ENG-001 | IAM | Access policy trên PostgreSQL thật (migration 007): RLS, trigger, lịch sử phiên bản,
 * và end-to-end qua PgAccessPolicyUnitOfWork + PgClinicalUnitOfWork bằng role hcos_app.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/access-policy-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asPatientId, asPersonId, asTenantId, asUserId,
  type AccessPolicyId, type AuditSink, type CorrelationId, type MembershipId, type NewAuditEvent, type OrganizationId,
  type Role, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { asEncounterId } from '../../packages/domain/src/s1-contracts';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../../services/api/src/clinical/encounter.service';
import { AccessPolicyService, PgAccessPolicyUnitOfWork } from '../../services/api/src/iam/access-policy.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_ap_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(13));
const U = { admin: asUserId(uid(100)), doc: asUserId(uid(101)), doc2: asUserId(uid(102)), nurse: asUserId(uid(103)), adminB: asUserId(uid(201)) };
const M = { nurse: uid(701) as MembershipId, doc: uid(702) as MembershipId };
const PA1 = asPersonId(uid(301));
const PB1 = asPersonId(uid(401));
const PAT = asPatientId(uid(501));
const ENC_DOC = asEncounterId(uid(601));
const ENC_DOC2 = asEncounterId(uid(602));
const POLICY_B = uid(902);
const sub = (u: string) => `sub-${u}`;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[], roles: Role[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: sub(u), userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([...roles]), tokenId: null, correlationId: 'it-ap' as CorrelationId,
  });
const C = {
  admin: ctx(TA, U.admin, [OA], ['tenant_admin']),
  doc: ctx(TA, U.doc, [OA], ['doctor']),
  nurse: ctx(TA, U.nurse, [OA], ['clinic_staff']),
  adminB: ctx(TB, U.adminB, [OB], ['tenant_admin']),
};

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const suScalar = (sql: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1'),('${OB}','${TB}','clinic','c1','C1');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name,birth_date,phone) VALUES
  ('${PA1}','${TA}','An','Nguyen','1990-05-17','0900000000'),('${PB1}','${TB}','Zed','Le',NULL,NULL);
INSERT INTO patient.identifiers(tenant_id,person_id,type,system,value) VALUES ('${TA}','${PA1}','national_id','https://moh.gov.vn/cccd','079090000777');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.admin}','${TA}','${sub(U.admin)}','Admin'),('${U.doc}','${TA}','${sub(U.doc)}','Doc'),('${U.doc2}','${TA}','${sub(U.doc2)}','Doc2'),
  ('${U.nurse}','${TA}','${sub(U.nurse)}','Nurse'),('${U.adminB}','${TB}','${sub(U.adminB)}','AdminB');
INSERT INTO iam.memberships(membership_id,tenant_id,user_id,organization_id,role) VALUES
  ('${M.nurse}','${TA}','${U.nurse}','${OA}','clinic_staff'),('${M.doc}','${TA}','${U.doc}','${OA}','doctor');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.admin}','${OA}','tenant_admin'),('${TA}','${U.doc2}','${OA}','doctor'),('${TB}','${U.adminB}','${OB}','tenant_admin');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT}','${TA}','${PA1}','${OA}','MRN-1');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class,reason_text) VALUES
  ('${ENC_DOC}','${TA}','${PAT}','${OA}','${U.doc}','ambulatory','A-private'),
  ('${ENC_DOC2}','${TA}','${PAT}','${OA}','${U.doc2}','ambulatory','A2-private');
SET app.user_id = 'seed';
INSERT INTO iam.access_policies(policy_id,tenant_id,name,rules,created_by) VALUES
  ('${POLICY_B}','${TB}','tenant-b-policy','[{"action":"patient:read"}]','${U.adminB}');
`;

class Sink implements AuditSink {
  events: NewAuditEvent[] = [];
  async record(e: NewAuditEvent) { this.events.push(e); }
}

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; name?: string; details?: { reason?: string } }) =>
    e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? e.name ?? 'ERR');

/** Câu lệnh thô bằng hcos_app, có tenant context (và app.user_id nếu cần). */
async function asApp<T>(tenant: TenantId | null, fn: (q: PsqlClient) => Promise<T>, userId: string | null = 'raw-test'): Promise<T> {
  const c = new PsqlClient({ database: DB });
  try {
    if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
    if (userId) await c.query("SELECT set_config('app.user_id', $1, false)", [userId]);
    return await fn(c);
  } finally {
    c.close();
  }
}
const pgCode = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? 'ERR');

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Access policy trên PostgreSQL (migration 007)', () => {
  let policies: AccessPolicyService;
  let clinical: ClinicalEncounterService;
  let nursePolicyId: AccessPolicyId;

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    const pool = psqlPool({ database: DB });
    policies = new AccessPolicyService({ uow: new PgAccessPolicyUnitOfWork(pool), audit: new Sink() });
    clinical = new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit: new Sink() });
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('tạo policy qua service: lưu được, có snapshot phiên bản 1 với changed_by = subject người gọi, audit + outbox cùng transaction', async () => {
    const p = await policies.createPolicy({
      name: 'Điều dưỡng khoa Nội',
      rules: [
        { action: 'patient:read', hiddenFields: ['identifiers'] },
        { action: 'encounter:read', hiddenFields: ['conditions', 'encounter.reasonText'] },
        { action: 'observation:write', criteria: { codes: ['http://loinc.org|8310-5'] }, readonlyFields: ['effectiveAt'] },
      ],
    }, C.admin);
    nursePolicyId = p.policyId;
    expect(p).toMatchObject({ tenantId: TA, status: 'active', version: 1, createdBy: U.admin });
    expect(suScalar(`SELECT version||'|'||changed_by FROM iam.access_policy_versions WHERE policy_id='${p.policyId}'`)).toBe(`1|${sub(U.admin)}`);
    expect(suScalar(`SELECT count(*) FROM platform.audit_events WHERE action='iam.access_policy.create' AND resource_id='${p.policyId}'`)).toBe('1');
    expect(suScalar(`SELECT count(*) FROM platform.outbox_events WHERE event_type='iam.access_policy.changed' AND aggregate_id='${p.policyId}'`)).toBe('1');
  });

  it('gắn policy cho điều dưỡng; dịch vụ lâm sàng đọc policy từ DB và áp dụng', async () => {
    const m = await policies.assignPolicy(M.nurse, nursePolicyId, 1, C.admin);
    expect(m).toMatchObject({ accessPolicyId: nursePolicyId, version: 2 });

    const view = await clinical.getPatient(PAT, C.nurse);
    expect(view.identifiers).toHaveLength(0);
    expect(view.redacted).toEqual(['identifiers']);

    const chart = await clinical.getEncounterChart(ENC_DOC, C.nurse);
    expect(chart.encounter.reasonText).toBeNull();
    expect(chart.conditions).toHaveLength(0);

    const temp = { encounterId: ENC_DOC, code: { system: 'http://loinc.org', code: '8310-5', display: 'T' }, value: { kind: 'quantity' as const, value: 38, unit: 'Cel', ucumCode: 'Cel' } };
    await expect(clinical.recordObservation(temp, C.nurse)).resolves.toMatchObject({ recordedByUserId: U.nurse });
    expect(await outcome(clinical.recordObservation({ ...temp, code: { ...temp.code, code: '4548-4' } }, C.nurse))).toBe('FORBIDDEN:ACCESS_POLICY');
    expect(await outcome(clinical.recordObservation({ ...temp, effectiveAt: '2026-10-01T00:00:00.000Z' }, C.nurse))).toBe('FORBIDDEN:ACCESS_POLICY');
    const audit = suScalar(`SELECT payload->>'accessPolicyIds' FROM platform.audit_events WHERE action='patient.read' ORDER BY occurred_at DESC LIMIT 1`);
    expect(audit).toContain(nursePolicyId);
  });

  it('bác sĩ không gắn policy giữ nguyên quyền (tương thích ngược)', async () => {
    const chart = await clinical.getEncounterChart(ENC_DOC2, C.doc);
    expect(chart.encounter.reasonText).toBe('A2-private');
    expect(chart.redacted).toEqual([]);
  });

  it('không retire được policy đang dùng (service và cả DB trigger)', async () => {
    expect(await outcome(policies.retirePolicy(nursePolicyId, 1, C.admin))).toBe('INVALID_STATE:POLICY_IN_USE');
    const code = await asApp(TA, (q) => pgCode(q.query(`UPDATE iam.access_policies SET status='retired' WHERE policy_id=$1`, [nursePolicyId])));
    expect(code).toBe('55000');
  });

  it('sửa policy: version tăng, snapshot mới; sửa với version cũ => xung đột', async () => {
    const r = await policies.revisePolicy(nursePolicyId, { rules: [{ action: 'patient:read' }, { action: 'encounter:read' }] }, 1, C.admin);
    expect(r.version).toBe(2);
    expect(suScalar(`SELECT string_agg(version::text, ',' ORDER BY version) FROM iam.access_policy_versions WHERE policy_id='${nursePolicyId}'`)).toBe('1,2');
    expect(await outcome(policies.revisePolicy(nursePolicyId, { description: 'x' }, 1, C.admin))).toBe('VersionConflictError');
    // Có hiệu lực ngay ở lần đọc tiếp theo (không cache).
    const view = await clinical.getPatient(PAT, C.nurse);
    expect(view.identifiers).toHaveLength(1);
  });

  it('gỡ policy, retire; policy retired bất biến và không gắn lại được (DB chặn cả khi đi đường tắt)', async () => {
    await policies.assignPolicy(M.nurse, null, 2, C.admin);
    const retired = await policies.retirePolicy(nursePolicyId, 2, C.admin);
    expect(retired.status).toBe('retired');
    expect(await asApp(TA, (q) => pgCode(q.query(`UPDATE iam.access_policies SET description='x' WHERE policy_id=$1`, [nursePolicyId])))).toBe('55000');
    expect(await asApp(TA, (q) => pgCode(q.query(`UPDATE iam.memberships SET access_policy_id=$1 WHERE membership_id=$2`, [nursePolicyId, M.doc])))).toBe('55000');
  });

  it('RLS: tenant A không thấy / không gắn được policy của tenant B; không có tenant context => 0 dòng', async () => {
    expect(await asApp(TA, async (q) => (await q.query(`SELECT policy_id FROM iam.access_policies WHERE policy_id=$1`, [POLICY_B])).rows.length)).toBe(0);
    expect(await asApp(null, async (q) => (await q.query(`SELECT policy_id FROM iam.access_policies`)).rows.length)).toBe(0);
    // FK ghép (tenant_id, policy_id) => membership của A không trỏ được sang policy của B.
    const code = await asApp(TA, (q) => pgCode(q.query(`UPDATE iam.memberships SET access_policy_id=$1 WHERE membership_id=$2`, [POLICY_B, M.doc])));
    expect(['23503', '55000']).toContain(code);
    expect(await outcome(policies.getPolicy(POLICY_B as AccessPolicyId, C.admin))).toBe('NOT_FOUND');
    await expect(policies.getPolicy(POLICY_B as AccessPolicyId, C.adminB)).resolves.toMatchObject({ policy: { name: 'tenant-b-policy' } });
  });

  it('lịch sử phiên bản append-only; không xoá được policy; ghi policy bắt buộc có app.user_id', async () => {
    expect(await asApp(TA, (q) => pgCode(q.query(`UPDATE iam.access_policy_versions SET changed_by='x' WHERE policy_id=$1`, [nursePolicyId])))).toBe('42501');
    expect(await asApp(TA, (q) => pgCode(q.query(`DELETE FROM iam.access_policy_versions WHERE policy_id=$1`, [nursePolicyId])))).toBe('42501');
    expect(await asApp(TA, (q) => pgCode(q.query(`DELETE FROM iam.access_policies WHERE policy_id=$1`, [nursePolicyId])))).toBe('42501');
    const noActor = await asApp(TA, (q) => pgCode(q.query(
      `INSERT INTO iam.access_policies(tenant_id,name,rules,created_by) VALUES ($1,'no-actor','[{"action":"patient:read"}]',$2)`, [TA, U.admin])), null);
    expect(noActor).toBe('42501');
  });

  it('DB chặn rules không phải mảng / rỗng; policy bị sửa tay sai định dạng => từ chối (không thành "không giới hạn")', async () => {
    expect(await asApp(TA, (q) => pgCode(q.query(
      `INSERT INTO iam.access_policies(tenant_id,name,rules,created_by) VALUES ($1,'empty','[]',$2)`, [TA, U.admin])))).toBe('23514');
    const id = uid(950);
    await asApp(TA, (q) => q.query(
      `INSERT INTO iam.access_policies(policy_id,tenant_id,name,rules,created_by) VALUES ($1,$2,'hand-edited','[{"action":"patient:read","criteria":{"bogus":1}}]',$3)`,
      [id, TA, U.admin]));
    su(`UPDATE iam.memberships SET access_policy_id='${id}' WHERE membership_id='${M.doc}'`);
    expect(await outcome(clinical.getPatient(PAT, C.doc))).toBe('FORBIDDEN:ACCESS_POLICY');
  });
});
