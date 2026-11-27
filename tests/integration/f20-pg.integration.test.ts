/**
 * HCOS-F20 | Cổng bệnh nhân trên PostgreSQL thật:
 *  - vai hcos_portal: chỉ SELECT; không chính sách nào khác ngoài portal_read áp cho nó; login role thừa kế hcos_app KHÔNG thừa hưởng hcos_portal;
 *    RLS chỉ trả hồ sơ của các person trong phiên, đợt khám đã kết thúc, chẩn đoán không nhập nhầm, chỉ số chính thức, chỉ thuốc (không vật tư);
 *  - OTP: không lưu mã rõ, token chỉ lưu SHA-256; định danh không khớp / SĐT dùng chung => thử thách mồi; 3 lần gửi / 15 phút; sai 5 lần => khoá;
 *  - người giám hộ: xác minh tại quầy, trẻ em tự hết khi đủ 18 tuổi, thu hồi;
 *  - ghi: đặt / huỷ lịch (portal_person_id), đổi SĐT qua OTP số mới (mã hoá lại + blind index, thu hồi phiên khác), email,
 *    yêu cầu đính chính (nhân viên xử lý), yêu cầu xoá qua F17 (channel portal, requested_by NULL);
 *  - link chia sẻ: 1 đợt khám đã kết thúc, PIN 6 số, sai 5 lần khoá, thu hồi; không lộ mã BN;
 *  - F17 xoá dữ liệu => phiên cổng bị thu hồi ngay, nội dung yêu cầu người bệnh tự viết được thay bằng nhãn.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { configureKeyProvider, LocalKeyProvider } from '../../packages/security/src/pii';
import { BookingService, PgBookingUnitOfWork, PublicBookingService } from '../../services/api/src/clinical/booking.service';
import { PgQueueUnitOfWork, QueueService } from '../../services/api/src/clinical/queue.service';
import { RetentionService } from '../../services/api/src/governance/retention.service';
import { TRAINING_OTP } from '../../services/api/src/portal/otp-sender';
import { PortalAdminService } from '../../services/api/src/portal/portal-admin.service';
import { PortalService } from '../../services/api/src/portal/portal.service';
import { PersonRegistryService, PgRegistryUnitOfWork } from '../../services/api/src/registry/person-registry.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_f20_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(13));
const U = { staff: asUserId(uid(101)), doc: asUserId(uid(103)), mgr: asUserId(uid(106)), pharm: asUserId(uid(104)), root: asUserId(uid(105)), rootB: asUserId(uid(107)) };
const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-f20' as CorrelationId,
  });
const C = { staff: ctx(TA, U.staff, [OA]), doc: ctx(TA, U.doc, [OA]), mgr: ctx(TA, U.mgr, [OA]), pharm: ctx(TA, U.pharm, [OA]), root: ctx(TA, U.root, [OA]) };
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));
/** Lỗi cổng: "<status>:<reason>". */
const pout = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { status?: number; reason?: string; code?: string }) => (e.status ? `${e.status}:${e.reason}` : `ERR:${e.code ?? String(e)}`));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const vnDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asApp = async <T>(fn: (c: PsqlClient) => Promise<T>): Promise<T> => {
  const c = new PsqlClient({ database: DB });
  try {
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
    return await fn(c);
  } finally {
    c.close();
  }
};
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

const META = { ip: '203.0.113.7', userAgent: 'it-f20' };
const SLUG = 'pk-f20';
const P_MOM = '0912000001';
const P_Y = '0912000009';
const P_NEW = '0987000123';
const MOM_BIRTH = '1988-04-12';
const TODAY = vnDate(new Date());
// Con tròn 18 tuổi vào NGÀY MAI (giờ VN) => liên kết tự hết từ ngày mai.
const KID_BIRTH = `${Number(addDays(TODAY, 1).slice(0, 4)) - 18}${addDays(TODAY, 1).slice(4)}`;
const E = { mom: uid(6001), momOpen: uid(6002), y: uid(6003), kid: uid(6004) };
const DRUG = uid(5001);
const SUPPLY = uid(5002);

run('Cổng bệnh nhân / PostgreSQL', () => {
  let portal: PortalService;
  let admin: PortalAdminService;
  let reg: PersonRegistryService;
  let ret: RetentionService;
  let shiftMs = 0;
  const P: Record<'mom' | 'kid' | 'y', { personId: string; patientId: string; mrn: string }> = {} as never;
  let spId: string;

  /** Đẩy các thử thách OTP về quá khứ (giữa các test) để giới hạn gửi / khoá của test trước không ảnh hưởng. */
  const age = () => su(`ALTER TABLE portal.otp_challenges DISABLE TRIGGER USER;
    UPDATE portal.otp_challenges SET created_at = created_at - d, expires_at = expires_at - d
      FROM (SELECT challenge_id AS id, GREATEST(created_at - now(), interval '0') + interval '2 hours' AS d FROM portal.otp_challenges) x WHERE challenge_id = x.id;
    ALTER TABLE portal.otp_challenges ENABLE TRIGGER USER;`);
  const login = async (svc: PortalService, input: Record<string, unknown>) => {
    const s = await svc.start(SLUG, input, META);
    expect(s.trainingCode).toMatch(/^\d{6}$/);
    return (await svc.verify(SLUG, { challengeId: s.challengeId, code: s.trainingCode }, META)).token;
  };

  beforeAll(async () => {
    configureKeyProvider(new LocalKeyProvider([['k1', randomBytes(32)]]));
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TB}','clinic','c3','PK B');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name)
        SELECT u, t, 'sub-' || u, n FROM (VALUES ('${U.staff}'::uuid,'${TA}'::uuid,'Lễ tân A'),('${U.doc}','${TA}','BS A'),('${U.mgr}','${TA}','Quản lý A'),
          ('${U.pharm}','${TA}','DS A'),('${U.root}','${TA}','Quản trị A'),('${U.rootB}','${TB}','Quản trị B')) v(u,t,n);
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.mgr}','${OA}','clinic_admin'),
        ('${TA}','${U.pharm}','${OA}','pharmacist'),('${TA}','${U.root}','${OA}','tenant_admin'),('${TB}','${U.rootB}','${OB}','tenant_admin');
      INSERT INTO patient.mrn_settings(tenant_id,organization_id,allow_legacy) VALUES ('${TA}','${OA}',true);
      INSERT INTO pharmacy.medications(medication_id,tenant_id,brand_name,strength,form,unit_of_measure,item_kind) VALUES
        ('${DRUG}','${TA}','Paracetamol','500mg','viên nén','viên','drug'),('${SUPPLY}','${TA}','Bơm tiêm 5ml','5 ml','bơm tiêm','cái','supply');
    `);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    reg = new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit });
    const bk = new BookingService({ uow: new PgBookingUnitOfWork(pool), audit });
    const q = new QueueService({ uow: new PgQueueUnitOfWork(pool), audit });
    const sp = await q.createServicePoint({ organizationId: OA, code: 'N1', name: 'Nội 1' }, C.mgr);
    spId = sp.servicePointId;
    await bk.setBookingCapacity(sp.servicePointId, 10, sp.version, C.mgr);
    await bk.createPortal({ organizationId: OA, slug: SLUG }, C.mgr);
    const pub = new PublicBookingService({ pool, audit });
    const retention = new RetentionService({ pool, audit });
    ret = retention;
    portal = new PortalService({ pool, audit, sender: TRAINING_OTP, publicBooking: pub, retention, clock: () => new Date(Date.now() + shiftMs) });
    admin = new PortalAdminService({ pool, audit });

    const mk = async (k: 'mom' | 'kid' | 'y', givenName: string, birthDate: string, phone: string | null, n: number) => {
      const r = await reg.createPerson({ givenName, familyName: 'Nguyễn', birthDate, sex: 'female', phone } as never, C.staff);
      const patientId = uid(1000 + n);
      const mrn = `F20-${k.toUpperCase()}1`;
      su(`INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${patientId}','${TA}','${r.person.personId}','${OA}','${mrn}')`);
      P[k] = { personId: r.person.personId, patientId, mrn };
    };
    await mk('mom', 'Lan', MOM_BIRTH, P_MOM, 1);
    await mk('kid', 'Bông', KID_BIRTH, null, 2);
    await mk('y', 'Yến', '1970-01-01', P_Y, 3);

    // Đợt khám: ghi chẩn đoán / chỉ số / đơn khi đang khám, rồi kết thúc (trừ momOpen).
    const enc = (id: string, pt: string) =>
      `INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,status,encounter_class,period_start,reason_text)
         VALUES ('${id}','${TA}','${pt}','${OA}','${U.doc}','in_progress','ambulatory',now() - interval '3 hours','Sốt 2 ngày');`;
    su([enc(E.mom, P.mom.patientId), enc(E.momOpen, P.mom.patientId), enc(E.y, P.y.patientId), enc(E.kid, P.kid.patientId)].join('\n'));
    su(`
      INSERT INTO clinical.conditions(tenant_id,patient_id,encounter_id,code_system,code,display,recorded_by_user_id,verification_status) VALUES
        ('${TA}','${P.mom.patientId}','${E.mom}','http://hl7.org/fhir/sid/icd-10','J06.9','Nhiễm trùng hô hấp trên','${U.doc}','confirmed'),
        ('${TA}','${P.mom.patientId}','${E.mom}','http://hl7.org/fhir/sid/icd-10','I10','Nhập nhầm','${U.doc}','entered_in_error'),
        ('${TA}','${P.mom.patientId}','${E.momOpen}','http://hl7.org/fhir/sid/icd-10','K29','Đang khám dở','${U.doc}','provisional'),
        ('${TA}','${P.y.patientId}','${E.y}','http://hl7.org/fhir/sid/icd-10','E11','Người khác','${U.doc}','confirmed');
      INSERT INTO clinical.observations(observation_id,tenant_id,patient_id,encounter_id,code_system,code,display,value_numeric,value_unit,effective_at,recorded_by_user_id,status) VALUES
        ('${uid(7001)}','${TA}','${P.mom.patientId}','${E.mom}','http://loinc.org','8310-5','Nhiệt độ',38.5,'Cel',now() - interval '2 hours','${U.doc}','final'),
        ('${uid(7002)}','${TA}','${P.mom.patientId}','${E.mom}','http://loinc.org','8867-4','Mạch',90,'/min',now() - interval '2 hours','${U.doc}','preliminary');
      INSERT INTO clinical.observations(observation_id,tenant_id,patient_id,encounter_id,code_system,code,display,value_numeric,value_unit,effective_at,recorded_by_user_id,status,supersedes_observation_id) VALUES
        ('${uid(7003)}','${TA}','${P.mom.patientId}','${E.mom}','http://loinc.org','8310-5','Nhiệt độ',37.5,'Cel',now() - interval '2 hours','${U.doc}','amended','${uid(7001)}');
      INSERT INTO clinical.prescriptions(prescription_id,tenant_id,organization_id,encounter_id,patient_id,prescriber_user_id,prescribed_at,status) VALUES
        ('${uid(8001)}','${TA}','${OA}','${E.mom}','${P.mom.patientId}','${U.doc}',now() - interval '1 hour','active'),
        ('${uid(8002)}','${TA}','${OA}','${E.mom}','${P.mom.patientId}','${U.doc}',now() - interval '1 hour','active');
      INSERT INTO clinical.prescription_items(tenant_id,prescription_id,line_no,medication_id,dose_quantity,dose_unit,frequency_per_day,duration_days,quantity_prescribed) VALUES
        ('${TA}','${uid(8001)}',1,'${DRUG}',1,'viên',3,5,15),('${TA}','${uid(8002)}',1,'${DRUG}',2,'viên',3,5,30);
      UPDATE clinical.prescriptions SET status = 'cancelled' WHERE prescription_id = '${uid(8002)}';
      UPDATE clinical.encounters SET status = 'finished', period_end = now() - interval '30 minutes' WHERE encounter_id IN ('${E.mom}','${E.y}','${E.kid}');
    `);
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('vai hcos_portal: chỉ SELECT, chỉ chính sách cổng; login role của app không thừa hưởng; RLS lọc đúng', async () => {
    // Bất biến: mọi bảng hcos_portal đọc được KHÔNG có chính sách permissive nào khác áp cho nó (PUBLIC / hcos_portal) ngoài portal_read.
    expect(su(`
      SELECT count(*) FROM pg_policies p
       WHERE p.permissive = 'PERMISSIVE' AND p.policyname <> 'portal_read' AND (p.roles @> '{public}' OR p.roles @> '{hcos_portal}')
         AND (p.schemaname, p.tablename) IN (SELECT table_schema, table_name FROM information_schema.role_table_grants WHERE grantee = 'hcos_portal'
                                             UNION SELECT table_schema, table_name FROM information_schema.column_privileges WHERE grantee = 'hcos_portal')`)).toBe('0');
    expect(su(`SELECT DISTINCT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'hcos_portal'`)).toBe('SELECT');
    su(`CREATE ROLE hcos_it_f20_login LOGIN IN ROLE hcos_app`);
    try {
      // Đổi vai được (SET), nhưng không thừa hưởng quyền của hcos_portal (USAGE).
      expect(su(`SELECT pg_has_role('hcos_it_f20_login','hcos_portal','SET')::text || ',' || pg_has_role('hcos_it_f20_login','hcos_portal','USAGE')::text`)).toBe('true,false');
    } finally {
      su(`DROP ROLE hcos_it_f20_login`);
    }

    const c = new PsqlClient({ database: DB, role: 'hcos_portal' });
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const n = async (sql: string) => Number((await c.query(sql)).rows[0]?.n);
      // Chưa đặt danh sách person => không thấy gì.
      expect(await n('SELECT count(*) AS n FROM patient.persons')).toBe(0);
      expect(await n('SELECT count(*) AS n FROM clinical.encounters')).toBe(0);
      await c.query("SELECT set_config('app.portal_person_ids', $1, false)", [`{${P.mom.personId}}`]);
      expect(await n('SELECT count(*) AS n FROM patient.persons')).toBe(1);
      expect(await n('SELECT count(*) AS n FROM clinical.encounters')).toBe(1); // momOpen chưa kết thúc => ẩn
      expect(await n('SELECT count(*) AS n FROM clinical.conditions')).toBe(1); // bỏ nhập nhầm + của đợt đang mở
      expect(await n('SELECT count(*) AS n FROM clinical.observations')).toBe(2); // final + amended; bỏ preliminary
      expect(await n('SELECT count(*) AS n FROM clinical.prescriptions')).toBe(1); // bỏ đơn đã huỷ
      expect(await n('SELECT count(*) AS n FROM clinical.prescription_items')).toBe(1);
      expect(await n("SELECT count(*) AS n FROM pharmacy.medications WHERE item_kind = 'supply'")).toBe(0);
      expect(await code(c.query('SELECT external_subject FROM iam.users'))).toBe('42501');
      expect(await code(c.query(`UPDATE patient.persons SET given_name = 'x'`))).toBe('42501');
      expect(await code(c.query(`INSERT INTO portal.requests (tenant_id) VALUES ('${TA}')`))).toBe('42501');
      expect(await code(c.query('SELECT 1 FROM portal.sessions'))).toBe('42501');
      expect(await code(c.query('SELECT 1 FROM governance.erasure_requests'))).toBe('42501');
      // Tenant khác: không thấy.
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect(await n('SELECT count(*) AS n FROM patient.persons')).toBe(0);
    } finally {
      c.close();
    }
  });

  it('OTP: mồi khi không khớp, không lưu mã rõ, token chỉ SHA-256, 3 lần gửi / 15 phút, sai 5 lần => khoá', async () => {
    expect(await portal.info(SLUG)).toMatchObject({ organizationName: 'PK A', enabled: true, training: true });
    expect(await portal.info('khong-co')).toBeNull();
    // Không khớp: phản hồi cùng hình dạng, không có mã; nhập mã gì cũng sai.
    const decoy = await portal.start(SLUG, { method: 'phone', phone: '0900000000' }, META);
    expect(decoy.trainingCode).toBeUndefined();
    expect(decoy.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await pout(portal.verify(SLUG, { challengeId: decoy.challengeId, code: '000000' }, META))).toBe('401:OTP_INVALID');
    expect(await pout(portal.start(SLUG, { method: 'mrn', mrn: P.mom.mrn, birthDate: '1999-01-01' }, META)).then(() => 'OK')).toBe('OK');
    expect(await pout(portal.start(SLUG, { method: 'phone', phone: 'abc' }, META))).toBe('422:PHONE_INVALID');

    const s = await portal.start(SLUG, { method: 'phone', phone: '+84 912 000 001' }, META);
    expect(s.trainingCode).toMatch(/^\d{6}$/);
    const row = su(`SELECT code_mac || '|' || channel || '|' || (ip_mac <> '${META.ip}')::text FROM portal.otp_challenges WHERE challenge_id = '${s.challengeId}'`);
    expect(row).not.toContain(s.trainingCode!);
    expect(row.endsWith('|training|true')).toBe(true);
    const wrong = s.trainingCode === '111111' ? '222222' : '111111';
    expect(await pout(portal.verify(SLUG, { challengeId: s.challengeId, code: wrong }, META))).toBe('401:OTP_INVALID');
    const { token } = await portal.verify(SLUG, { challengeId: s.challengeId, code: s.trainingCode }, META);
    expect(token).toMatch(/^hpt_[A-Za-z0-9_-]{43}$/);
    // Dùng lại mã => hết hiệu lực.
    expect(await pout(portal.verify(SLUG, { challengeId: s.challengeId, code: s.trainingCode }, META))).toBe('410:OTP_EXPIRED');
    expect(su(`SELECT token_hash FROM portal.sessions WHERE person_id = '${P.mom.personId}'`)).toBe(createHash('sha256').update(token).digest('hex'));
    const me = await portal.me(token);
    expect(me.profiles.map((p) => [p.name, p.self])).toEqual([['Nguyễn Lan', true]]);
    expect(me.contact.phoneHint).toMatch(/^091\*+001$/);
    expect(await pout(portal.me('hpt_' + 'x'.repeat(43)))).toBe('401:SESSION_INVALID');

    // Tối đa 3 lần gửi / 15 phút cho cùng SĐT (đã gửi 1).
    await portal.start(SLUG, { method: 'phone', phone: P_MOM }, META);
    await portal.start(SLUG, { method: 'phone', phone: P_MOM }, META);
    expect(await pout(portal.start(SLUG, { method: 'phone', phone: P_MOM }, META))).toBe('429:OTP_THROTTLED');

    // Sai 5 lần (định danh mã BN + ngày sinh của Y) => khoá, kể cả với mã đúng và thử thách mới.
    const ident = { method: 'mrn', mrn: P.y.mrn.toLowerCase(), birthDate: '1970-01-01' };
    const y = await portal.start(SLUG, ident, META);
    const bad = y.trainingCode === '123456' ? '654321' : '123456';
    for (let i = 0; i < 4; i++) expect(await pout(portal.verify(SLUG, { challengeId: y.challengeId, code: bad }, META))).toBe('401:OTP_INVALID');
    expect(await pout(portal.verify(SLUG, { challengeId: y.challengeId, code: bad }, META))).toBe('401:OTP_INVALID');
    expect(await pout(portal.verify(SLUG, { challengeId: y.challengeId, code: y.trainingCode }, META))).toBe('423:LOGIN_LOCKED');
    expect(await pout(portal.start(SLUG, ident, META))).toBe('423:LOGIN_LOCKED');
    // Đăng nhập bằng SĐT của Y là định danh khác => vẫn được (khoá theo định danh, IP có giới hạn riêng ở tầng HTTP).
    expect(await pout(login(portal, { method: 'phone', phone: P_Y }))).toBe('OK');

    // Detector Decision Engine thấy số lần sai theo IP.
    expect(Number(su(`SELECT COALESCE(sum(failed_attempts),0) FROM portal.otp_challenges WHERE ip_mac = (SELECT ip_mac FROM portal.otp_challenges WHERE challenge_id = '${y.challengeId}')`)))
      .toBeGreaterThanOrEqual(7);
  });

  it('đọc qua cổng: chỉ hồ sơ của mình, đợt đã kết thúc, bỏ nhập nhầm / bản bị thay; không đọc được người khác', async () => {
    age();
    const t = await login(portal, { method: 'mrn', mrn: P.mom.mrn, birthDate: MOM_BIRTH });
    const ov = await portal.overview(t, P.mom.personId);
    expect(ov.encounters.map((e) => e.encounterId)).toEqual([E.mom]);
    expect(ov.encounters[0]).toMatchObject({ diagnoses: 'Nhiễm trùng hô hấp trên', practitioner: 'BS A', organizationName: 'PK A', prescriptions: 1 });
    const d = await portal.encounter(t, P.mom.personId, E.mom);
    expect(d.diagnoses.map((x) => x.code)).toEqual(['J06.9']);
    expect(d.observations.map((o) => [o.display, o.value])).toEqual([['Nhiệt độ', 37.5]]);
    expect(d.medications).toHaveLength(1);
    expect(d.medications[0]).toMatchObject({ name: 'Paracetamol 500mg', perDay: 3, days: 5, quantity: 15 });
    expect(d.patient.mrn).toBe(P.mom.mrn);
    expect(await pout(portal.encounter(t, P.mom.personId, E.momOpen))).toBe('404:NOT_FOUND');
    expect(await pout(portal.encounter(t, P.mom.personId, E.y))).toBe('404:NOT_FOUND');
    expect(await pout(portal.overview(t, P.y.personId))).toBe('404:NOT_FOUND');
    expect(await pout(portal.overview(t, P.kid.personId))).toBe('404:NOT_FOUND'); // chưa liên kết
    // Audit: actor là service cổng, personId = người đăng nhập, payload chỉ id.
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action = 'portal.encounter.read' AND actor_type = 'service' AND actor_id = 'patient-portal' AND person_id = '${P.mom.personId}'`)).toBe('1');
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action LIKE 'portal.%' AND payload::text ~ '(912000001|Lan|Paracetamol)'`)).toBe('0');
  });

  it('người giám hộ: xác minh tại quầy, chuyển hồ sơ, trẻ tự hết khi đủ 18 tuổi, thu hồi', async () => {
    age();
    const base = { dependentPatientId: P.kid.patientId, guardianMrn: P.mom.mrn, relationship: 'parent' };
    expect(await outcome(admin.link({ ...base, verified: false }, C.staff))).toBe('VALIDATION:VERIFICATION_REQUIRED');
    expect(await outcome(admin.link({ ...base, verified: true }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(admin.link({ ...base, guardianMrn: 'F20-KHONG', verified: true }, C.staff))).toBe('NOT_FOUND:GUARDIAN_NOT_FOUND');
    expect(await outcome(admin.link({ ...base, guardianMrn: P.kid.mrn, verified: true }, C.staff))).toBe('VALIDATION:SELF_LINK');
    // Người phụ thuộc là người lớn => bắt buộc ngày hết hạn.
    expect(await outcome(admin.link({ dependentPatientId: P.y.patientId, guardianMrn: P.mom.mrn, relationship: 'other', verified: true }, C.staff))).toBe('VALIDATION:VALID_UNTIL_REQUIRED');
    await admin.link({ ...base, verified: true, validUntil: '2099-01-01' }, C.staff);
    expect(su(`SELECT valid_until::text FROM patient.guardian_links WHERE dependent_person_id = '${P.kid.personId}'`)).toBe(addDays(TODAY, 1)); // trần = sinh nhật 18
    expect(await outcome(admin.link({ ...base, verified: true }, C.staff))).toBe('CONFLICT:LINK_EXISTS');
    // Trẻ nhỏ: hạn = sinh nhật 18 dù xa hơn 10 năm; người lớn: tối đa 10 năm.
    const baby = await reg.createPerson({ givenName: 'Bé', familyName: 'Nguyễn', birthDate: addDays(TODAY, -200), sex: 'male' } as never, C.staff);
    su(`INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${uid(1008)}','${TA}','${baby.person.personId}','${OA}','F20-BABY1')`);
    await admin.link({ dependentPatientId: uid(1008), guardianMrn: P.mom.mrn, relationship: 'parent', verified: true }, C.staff);
    expect(su(`SELECT valid_until::text FROM patient.guardian_links WHERE dependent_person_id = '${baby.person.personId}'`))
      .toBe(`${Number(addDays(TODAY, -200).slice(0, 4)) + 18}${addDays(TODAY, -200).slice(4)}`);
    expect(await outcome(admin.link({ dependentPatientId: P.y.patientId, guardianMrn: P.mom.mrn, relationship: 'other', verified: true, validUntil: addDays(TODAY, 3700) }, C.staff)))
      .toBe('VALIDATION:LINK_INVALID');
    su(`UPDATE patient.guardian_links SET status = 'revoked', revoked_by = verified_by, revoked_at = now(), revoke_reason = 'dọn test' WHERE dependent_person_id = '${baby.person.personId}'`);
    // Không sửa / xoá trực tiếp được.
    expect(await asApp((c) => code(c.query(`DELETE FROM patient.guardian_links`)))).toBe('42501');
    expect(await asApp((c) => code(c.query(`UPDATE patient.guardian_links SET valid_until = '2099-01-01'`)))).not.toBe('OK');

    const t = await login(portal, { method: 'mrn', mrn: P.mom.mrn, birthDate: MOM_BIRTH });
    const me = await portal.me(t);
    expect(me.profiles.map((p) => [p.name, p.self, p.relationship])).toEqual([['Nguyễn Lan', true, null], ['Nguyễn Bông', false, 'parent']]);
    expect((await portal.overview(t, P.kid.personId)).encounters.map((e) => e.encounterId)).toEqual([E.kid]);
    const panel = await admin.patientPanel(P.kid.patientId, C.staff);
    expect(panel.links).toHaveLength(1);
    expect(panel.links[0]).toMatchObject({ role: 'dependent', relationship: 'parent', verifiedByName: 'Lễ tân A', status: 'active', other: { name: 'Nguyễn Lan', mrn: P.mom.mrn } });
    expect(panel.activeSessions).toBe(0); // phiên là của người giám hộ, không phải của trẻ

    // Hai ngày sau: con đã đủ 18 => liên kết tự hết (đăng nhập lại theo đồng hồ mới).
    shiftMs = 2 * 86_400_000;
    try {
      const t2 = await login(portal, { method: 'mrn', mrn: P.mom.mrn, birthDate: MOM_BIRTH });
      expect((await portal.me(t2)).profiles.map((p) => p.self)).toEqual([true]);
      expect(await pout(portal.overview(t2, P.kid.personId))).toBe('404:NOT_FOUND');
      // Phiên cũ nhàn rỗi > 30 phút theo đồng hồ mới => hết.
      expect(await pout(portal.me(t))).toBe('401:SESSION_EXPIRED');
    } finally {
      shiftMs = 0;
    }
    // Thu hồi (cần lý do).
    const linkId = su(`SELECT link_id FROM patient.guardian_links WHERE dependent_person_id = '${P.kid.personId}'`);
    expect(await outcome(admin.revokeLink(linkId, { reason: '' }, C.staff))).toMatch(/^VALIDATION/);
    await admin.revokeLink(linkId, { reason: 'Hết quyền nuôi con theo quyết định toà' }, C.staff);
    age();
    const t3 = await login(portal, { method: 'mrn', mrn: P.mom.mrn, birthDate: MOM_BIRTH });
    expect((await portal.me(t3)).profiles).toHaveLength(1);
    // Nhân viên thu hồi mọi phiên của người bệnh.
    expect(await outcome(admin.revokeSessions(P.mom.patientId, C.doc))).toBe('FORBIDDEN');
    await admin.revokeSessions(P.mom.patientId, C.staff);
    expect(await pout(portal.me(t3))).toBe('401:SESSION_INVALID');
  });

  it('ghi: đặt / huỷ lịch, đổi SĐT qua OTP số mới, email, yêu cầu đính chính, yêu cầu xoá qua F17', async () => {
    age();
    const t = await login(portal, { method: 'mrn', mrn: P.mom.mrn, birthDate: MOM_BIRTH });
    const other = await login(portal, { method: 'mrn', mrn: P.mom.mrn, birthDate: MOM_BIRTH });
    // Lịch hẹn: thông tin hành chính lấy từ hồ sơ; portal_person_id ghi qua trigger.
    const opts = await portal.bookingOptions(t);
    expect(opts).toBeTruthy();
    // Ngày đặt lịch: hôm nay + 2, bỏ Chủ nhật (phòng khám không nhận lịch CN — test từng hỏng khi chạy vào thứ Sáu).
    const plus2 = addDays(TODAY, 2);
    const visitDate = new Date(`${plus2}T00:00:00Z`).getUTCDay() === 0 ? addDays(TODAY, 3) : plus2;
    expect(await pout(portal.book(t, { personId: P.mom.personId, servicePointId: spId, visitDate, period: 'morning' }))).toBe('422:CONSENT_REQUIRED');
    const b = await portal.book(t, { personId: P.mom.personId, servicePointId: spId, visitDate, period: 'morning', reason: 'Tái khám', consent: true });
    expect(b).toHaveProperty('code');
    expect(su(`SELECT portal_person_id FROM clinical.bookings`)).toBe(P.mom.personId);
    const ov = await portal.overview(t, P.mom.personId);
    expect(ov.bookings).toHaveLength(1);
    expect(ov.bookings[0]).toMatchObject({ visitDate, period: 'morning', status: 'booked', viaPortal: true, cancellable: true });
    // Ứng dụng thường không đặt được portal_person_id tuỳ ý.
    expect(await asApp((c) => code(c.query(`UPDATE clinical.bookings SET portal_person_id = '${P.y.personId}'`)))).not.toBe('OK');
    await portal.cancelBooking(t, { personId: P.mom.personId, bookingId: ov.bookings[0]!.bookingId });
    expect(await pout(portal.cancelBooking(t, { personId: P.mom.personId, bookingId: ov.bookings[0]!.bookingId }))).toBe('409:NOT_CANCELLABLE');

    // Đổi SĐT: OTP gửi tới số MỚI; xác nhận => mã hoá lại + blind index; phiên khác bị thu hồi.
    const pc = await portal.startPhoneChange(t, { phone: P_NEW }, META);
    expect(pc.trainingCode).toMatch(/^\d{6}$/);
    expect(await pout(portal.confirmPhoneChange(other, { challengeId: pc.challengeId, code: pc.trainingCode }))).toBe('410:OTP_EXPIRED'); // khác phiên
    const r = await portal.confirmPhoneChange(t, { challengeId: pc.challengeId, code: pc.trainingCode });
    expect(r.phoneHint).toMatch(/^098\*+123$/);
    expect(su(`SELECT count(*) FROM patient.persons WHERE person_id = '${P.mom.personId}' AND row_to_json(persons)::text ~ '987000123'`)).toBe('0');
    expect(su(`SELECT left(phone_enc, 3) FROM patient.persons WHERE person_id = '${P.mom.personId}'`)).toBe('s1.');
    expect(su(`SELECT count(*) FROM portal.otp_challenges WHERE target_enc IS NOT NULL AND challenge_id = '${pc.challengeId}'`)).toBe('0');
    expect(await pout(portal.me(other))).toBe('401:SESSION_INVALID');
    expect(await pout(login(portal, { method: 'phone', phone: P_NEW }))).toBe('OK');
    expect((await portal.start(SLUG, { method: 'phone', phone: '0912000002' }, META)).trainingCode).toBeUndefined();
    expect(await pout(portal.startPhoneChange(t, { phone: '12' }, META))).toBe('422:PHONE_INVALID');

    // SĐT dùng chung (người nhà): không đoán => mồi; phải đăng nhập bằng mã BN + ngày sinh.
    su(`UPDATE patient.persons SET (phone_enc, phone_bidx, phone_hint) = (SELECT phone_enc, phone_bidx, phone_hint FROM patient.persons WHERE person_id = '${P.mom.personId}') WHERE person_id = '${P.kid.personId}'`);
    expect((await portal.start(SLUG, { method: 'phone', phone: P_NEW }, { ...META, ip: '198.51.100.2' })).trainingCode).toBeUndefined();

    // Email: đổi trực tiếp, có audit.
    expect(await pout(portal.setEmail(t, { email: 'khong-hop-le' }))).toBe('422:EMAIL_INVALID');
    expect((await portal.setEmail(t, { email: 'Lan@Example.vn' })).emailHint).toMatch(/^l.*@example\.vn$/);
    expect(su(`SELECT count(*) FROM patient.persons WHERE row_to_json(persons)::text ILIKE '%lan@example.vn%'`)).toBe('0');

    // Yêu cầu đính chính => nhân viên xử lý.
    expect(await pout(portal.submitCorrection(t, { personId: P.mom.personId, message: 'ngắn' }))).toBe('422:MESSAGE_TOO_SHORT');
    const cr = await portal.submitCorrection(t, { personId: P.mom.personId, message: 'Ngày sinh của tôi bị ghi sai, đúng là 12/04/1988.' });
    expect(await outcome(admin.listRequests({ organizationId: OA }, C.pharm))).toBe('FORBIDDEN');
    const open = await admin.listRequests({ organizationId: OA }, C.staff);
    expect(open.canResolve).toBe(true);
    expect(open.requests.find((x) => x.requestId === cr.requestId)).toMatchObject({ mrn: P.mom.mrn, name: 'Nguyễn Lan', byGuardian: false, status: 'open' });
    await admin.resolveRequest(cr.requestId, { status: 'resolved', note: 'Đã đối chiếu CCCD, sửa ngày sinh.' }, C.staff);
    expect(await outcome(admin.resolveRequest(cr.requestId, { status: 'rejected', note: 'Lần hai' }, C.staff))).toBe('CONFLICT:REQUEST_CLOSED');
    expect((await portal.myRequests(t)).corrections[0]).toMatchObject({ status: 'resolved', resolutionNote: 'Đã đối chiếu CCCD, sửa ngày sinh.' });

    // Yêu cầu xoá qua F17: channel portal, không có người nhận là nhân viên.
    const er = await portal.requestErasure(t, { personId: P.mom.personId, note: 'Tôi muốn xoá dữ liệu' });
    expect(er).toHaveProperty('requestId');
    expect(su(`SELECT channel || '|' || (requested_by IS NULL)::text || '|' || portal_person_id FROM governance.erasure_requests WHERE request_id = '${er.requestId}'`))
      .toBe(`portal|true|${P.mom.personId}`);
    expect(await pout(portal.requestErasure(t, { personId: P.mom.personId }))).toBe('409:ERASURE_ALREADY_OPEN');
    expect((await portal.myRequests(t)).erasures[0]).toMatchObject({ status: 'pending' });
  });

  it('link chia sẻ: 1 đợt khám đã kết thúc, PIN 6 số, sai 5 lần khoá, thu hồi, không lộ mã BN', async () => {
    age();
    const t = await login(portal, { method: 'phone', phone: P_Y });
    expect(await pout(portal.createShare(t, { personId: P.y.personId, encounterId: E.mom }))).toBe('404:NOT_FOUND');
    const sh = await portal.createShare(t, { personId: P.y.personId, encounterId: E.y });
    expect(sh.shareToken).toMatch(/^hps_/);
    expect(sh.pin).toMatch(/^\d{6}$/);
    expect(Date.parse(sh.expiresAt) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(su(`SELECT count(*) FROM portal.shares WHERE pin_mac = '${sh.pin}' OR token_hash = '${sh.shareToken}'`)).toBe('0');
    const v = await portal.viewShare(sh.shareToken, sh.pin, META);
    expect(v).toMatchObject({ encounterId: E.y, patient: { name: 'Nguyễn Yến', mrn: null } });
    expect(v.diagnoses.map((d) => d.code)).toEqual(['E11']);
    expect(await pout(portal.viewShare('hps_khong-co', sh.pin, META))).toBe('404:NOT_FOUND');

    const bad = sh.pin === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect(await pout(portal.viewShare(sh.shareToken, bad, META))).toBe('401:PIN_INVALID');
    expect(await pout(portal.viewShare(sh.shareToken, bad, META))).toBe('401:SHARE_LOCKED');
    expect(await pout(portal.viewShare(sh.shareToken, sh.pin, META))).toBe('423:SHARE_LOCKED');
    const sh2 = await portal.createShare(t, { personId: P.y.personId, encounterId: E.y });
    const list = await portal.listShares(t);
    expect(list.map((x) => x.state).sort()).toEqual(['active', 'locked']);
    await portal.revokeShare(t, list.find((x) => x.state === 'active')!.shareId);
    expect(await pout(portal.viewShare(sh2.shareToken, sh2.pin, META))).toBe('410:SHARE_REVOKED');
    expect(su(`SELECT string_agg(outcome, ',' ORDER BY viewed_at, outcome) FROM portal.share_views`)).toMatch(/^ok,(bad_pin,){5}locked,revoked$/);
    // CSDL: link chỉ cho đợt khám ĐÃ KẾT THÚC của chính người đó (kể cả ghi thẳng).
    const ins = (eid: string, pid: string) => asApp((c) => code(c.query(
      `INSERT INTO portal.shares (tenant_id, organization_id, person_id, encounter_id, token_hash, pin_mac, created_by_person_id, expires_at)
       VALUES ('${TA}', '${OA}', '${pid}', '${eid}', md5(random()::text) || md5(random()::text), 'y', '${pid}', now() + interval '1 hour')`)));
    expect(await ins(E.momOpen, P.mom.personId)).not.toBe('OK'); // đợt chưa kết thúc
    expect(await ins(E.y, P.mom.personId)).not.toBe('OK'); // đợt của người khác
    expect(await ins(E.mom, P.mom.personId)).toBe('OK');

    // F17 xoá dữ liệu (người chưa có bệnh án => xoá ngay) => phiên đang mở bị thu hồi trong cùng transaction; không đăng nhập lại được.
    const z = await reg.createPerson({ givenName: 'Zung', familyName: 'Phạm', birthDate: '1995-05-05', sex: 'male', phone: '0912000077' } as never, C.staff);
    su(`INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${uid(1009)}','${TA}','${z.person.personId}','${OA}','F20-Z1')`);
    const tz = await login(portal, { method: 'phone', phone: '0912000077' });
    await portal.submitCorrection(tz, { personId: z.person.personId, message: 'Tôi bị dị ứng penicillin, xin ghi vào hồ sơ.' });
    const er = await portal.requestErasure(tz, { personId: z.person.personId, note: 'Xoá giúp tôi' });
    const dec = await ret.decide(er.requestId, { decision: 'approve', note: 'Đã đối chiếu CCCD tại quầy' }, C.root);
    expect(dec.request.status).toBe('completed');
    expect(su(`SELECT string_agg(DISTINCT revoked_reason, ',') FROM portal.sessions WHERE person_id = '${z.person.personId}'`)).toBe('erased');
    expect(await pout(portal.me(tz))).toBe('401:SESSION_INVALID');
    expect(su(`SELECT message FROM portal.requests WHERE person_id = '${z.person.personId}'`)).toBe('[đã xoá theo yêu cầu xoá dữ liệu]');
    age();
    expect((await portal.start(SLUG, { method: 'phone', phone: '0912000077' }, META)).trainingCode).toBeUndefined();
  });
});
