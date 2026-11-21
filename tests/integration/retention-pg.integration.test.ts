/**
 * HCOS-F17 | Lưu giữ & xoá trên PostgreSQL thật:
 *  - khoá theo chủ thể: bản mã s1; role ứng dụng KHÔNG tự huỷ khoá / xoá dữ liệu được (chỉ qua hàm governance.*);
 *  - sàn pháp lý của thời hạn (service + CHECK của CSDL);
 *  - job: ẩn danh lịch hẹn quá hạn (huỷ khoá, xoá định danh, giữ thống kê), xoá idempotency / outbox hết hạn; biên nhận không chứa giá trị;
 *  - yêu cầu xoá: người lập ≠ người duyệt (service + CSDL); không ràng buộc => xoá toàn bộ, bản mã cũ (như trong bản sao lưu) không mở được nữa;
 *    còn hồ sơ bệnh án => xoá phần không bị ràng buộc + hạn chế xử lý + hoãn; hết hạn giữ => job xoá nốt;
 *  - sổ huỷ: chỉ id, đánh dấu đã đẩy một lần; phát lại sau khôi phục (chỉ superuser), idempotent; tách tenant.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { configureKeyProvider, LocalKeyProvider, PiiShreddedError, TenantPii } from '../../packages/security/src/pii';
import { RETENTION_RULES } from '../../packages/security/src/retention';
import { RetentionService } from '../../services/api/src/governance/retention.service';
import { PersonRegistryService, PgRegistryUnitOfWork } from '../../services/api/src/registry/person-registry.service';
import { PiiService } from '../../services/api/src/security/pii.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_ret_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(13));
const U = { staff: asUserId(uid(101)), doc: asUserId(uid(103)), root: asUserId(uid(105)), boss: asUserId(uid(106)), rootB: asUserId(uid(107)) };
const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-ret' as CorrelationId,
  });
const C = { staff: ctx(TA, U.staff, [OA]), doc: ctx(TA, U.doc, [OA]), root: ctx(TA, U.root, [OA]), boss: ctx(TA, U.boss, [OA]), rootB: ctx(TB, U.rootB, [OB]) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));
const asApp = async <T>(t: TenantId, fn: (c: PsqlClient) => Promise<T>): Promise<T> => {
  const c = new PsqlClient({ database: DB });
  try {
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [t]);
    return await fn(c);
  } finally {
    c.close();
  }
};
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const codec = (c: PsqlClient, t: TenantId = TA) => new TenantPii({ tenantId: t, query: (s: string, p?: readonly unknown[]) => c.query(s, p ?? []) } as never);
const CCCD_SYSTEM = 'https://moh.gov.vn/cccd';

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Lưu giữ & xoá dữ liệu / PostgreSQL', () => {
  let reg: PersonRegistryService;
  let pii: PiiService;
  let ret: RetentionService;
  let sp: string;

  /** Người bệnh có hồ sơ tại OA (qua service thật => bản mã s1 bằng khoá của người đó). */
  const patient = async (mrn: string, phone: string, cccd: string, given = 'An') => {
    const r = await reg.registerPersonAndPatient({
      organizationId: OA, mrn,
      person: { givenName: given, familyName: 'Nguyễn Văn', birthDate: '1980-01-01', sex: 'male', phone, email: `${mrn.toLowerCase()}@example.vn`,
        identifiers: [{ type: 'national_id', system: CCCD_SYSTEM, value: cccd }] },
    } as never, C.staff);
    return { personId: r.person.personId as string, patientId: r.patient.patientId as string, identifierId: r.identifiers[0]!.identifierId as string };
  };
  /** Lịch hẹn (đã mã hoá bằng khoá của lịch) chèn thẳng — kể cả ngày trong quá khứ. */
  const booking = async (visitDate: string, phone: string, nid: string | null, patientId: string | null = null, status = 'booked') => {
    const id = randomUUID();
    const s = await asApp(TA, async (c) => {
      const k = codec(c);
      return { ph: await k.protect('phone', phone, { kind: 'booking', id }), n: await k.protect('identifier', nid, { kind: 'booking', id }) };
    });
    const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
    su(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO clinical.bookings(booking_id,tenant_id,organization_id,service_point_id,visit_date,period,code_hash,family_name,given_name,birth_date,sex,
          phone_enc,phone_bidx,phone_hint,national_id_enc,national_id_bidx,national_id_hint,reason,consent_version,consent_at,status,patient_id,cancelled_by,cancelled_at)
        VALUES ('${id}','${TA}','${OA}','${sp}','${visitDate}','morning',sha256(convert_to('${id}','UTF8')),'Trần Thị','Bình${id.slice(0, 4)}','1990-02-02','female',
          ${q(s.ph.enc)},${q(s.ph.bidx)},${q(s.ph.hint)},${q(s.n.enc)},${q(s.n.bidx)},${q(s.n.hint)},'Đau đầu','2026-11',now(),'${status}',${q(patientId)},
          ${status === 'cancelled' ? "'patient',now()" : 'NULL,NULL'});
        ${status === 'booked' ? `INSERT INTO clinical.booking_counters(tenant_id,service_point_id,visit_date,period,booked) VALUES ('${TA}','${sp}','${visitDate}','morning',1)
          ON CONFLICT (tenant_id,service_point_id,visit_date,period) DO UPDATE SET booked = clinical.booking_counters.booked + 1;` : ''}
        COMMIT;`);
    return id;
  };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    configureKeyProvider(new LocalKeyProvider([['k1', randomBytes(32)]]));
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TB}','clinic','c3','PK B');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name)
        SELECT u, t, 'sub-' || u, n FROM (VALUES
          ('${U.staff}'::uuid,'${TA}'::uuid,'Lễ tân A'),('${U.doc}','${TA}','BS A'),('${U.root}','${TA}','Quản trị A'),('${U.boss}','${TA}','Quản lý kiêm quản trị'),
          ('${U.rootB}','${TB}','Quản trị B')) v(u,t,n);
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.root}','${OA}','tenant_admin'),
        ('${TA}','${U.boss}','${OA}','clinic_admin'),('${TA}','${U.boss}','${OA}','tenant_admin'),('${TB}','${U.rootB}','${OB}','tenant_admin');
      INSERT INTO patient.mrn_settings(tenant_id,organization_id,allow_legacy) VALUES ('${TA}','${OA}',true);
      INSERT INTO clinical.service_points(service_point_id,tenant_id,organization_id,code,name) VALUES ('${uid(500)}','${TA}','${OA}','N1','Nội 1');
    `);
    sp = uid(500);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    reg = new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit });
    pii = new PiiService({ pool, audit });
    ret = new RetentionService({ pool, audit, backupHorizonDays: 90 });
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('sàn pháp lý / mặc định trong mã nguồn khớp với CSDL; không đặt được thấp hơn sàn', async () => {
    for (const r of RETENTION_RULES) {
      expect(su(`SELECT governance.retention_floor('${r.id}') || '|' || governance.retention_default('${r.id}')`), r.id).toBe(`${r.floorDays}|${r.defaultDays}`);
    }
    expect(await outcome(ret.setDays({ ruleId: 'booking_contact', days: 60 }, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(ret.setDays({ ruleId: 'medical_record', days: 365 }, C.root))).toBe('VALIDATION:RETENTION_BELOW_FLOOR');
    expect((await ret.setDays({ ruleId: 'booking_contact', days: 60 }, C.root)).days).toBe(60);
    await asApp(TA, async (c) => {
      expect(await code(c.query(`UPDATE governance.retention_settings SET days = 10 WHERE rule_id = 'booking_contact'`))).toBe('23514');
    });
    await ret.setDays({ ruleId: 'booking_contact', days: 90 }, C.root);
  });

  it('role ứng dụng không tự huỷ khoá / xoá / phát lại sổ được — chỉ qua hàm governance', async () => {
    const p = await patient('KEY-1', '0911000001', '079000000011');
    expect(su(`SELECT left(phone_enc,3) || '|' || (SELECT count(*) FROM keyvault.subject_keys WHERE subject_id IN ('${p.personId}','${p.identifierId}')) FROM patient.persons WHERE person_id='${p.personId}'`))
      .toBe('s1.|2');
    await asApp(TA, async (c) => {
      expect(await code(c.query(`UPDATE keyvault.subject_keys SET status='shredded', wrapped_key=NULL, shredded_at=now() WHERE subject_id='${p.personId}'`))).toBe('42501');
      expect(await code(c.query(`SELECT set_config('hcos.erasure','on',false)`))).toBe('OK');
      expect(await code(c.query(`UPDATE keyvault.subject_keys SET status='shredded', wrapped_key=NULL, shredded_at=now() WHERE subject_id='${p.personId}'`))).toBe('42501');
      expect(await code(c.query(`UPDATE patient.persons SET status='erased', erased_at=now(), given_name=NULL WHERE person_id='${p.personId}'`))).toBe('42501');
      expect(await code(c.query(`DELETE FROM platform.idempotency_keys`))).toBe('42501');
      expect(await code(c.query(`SELECT governance._erase_person('${p.personId}', gen_random_uuid(), false)`))).toBe('42501');
      expect(await code(c.query(`SELECT governance.replay_shred('${TA}', 'person', '${p.personId}', gen_random_uuid())`))).toBe('42501');
      expect(await code(c.query(`INSERT INTO keyvault.shred_events (tenant_id,subject_kind,subject_id,action,receipt_id) VALUES ('${TA}','person','${p.personId}','erase_person',gen_random_uuid())`))).toBe('42501');
    });
    expect(su(`SELECT status FROM keyvault.subject_keys WHERE subject_id='${p.personId}'`)).toBe('active');
  });

  it('job: ẩn danh lịch hẹn quá hạn (huỷ khoá), xoá idempotency / outbox hết hạn; biên nhận chỉ có số đếm; chạy lại không làm gì', async () => {
    const old1 = await booking(daysAgo(120), '0977111001', '079111000001', null, 'no_show');
    const old2 = await booking(daysAgo(95), '0977111002', null, null, 'cancelled');
    const recent = await booking(daysAgo(10), '0977111003', null);
    const tokenOld = su(`SELECT phone_enc FROM clinical.bookings WHERE booking_id='${old1}'`);
    su(`INSERT INTO platform.idempotency_keys(tenant_id,actor_user_id,scope,idem_key,request_hash,response,created_at,completed_at)
          VALUES ('${TA}','${U.staff}','test.scope','old-key-0001',repeat('a',64),'{"a":1}', now() - interval '10 days', now() - interval '10 days'),
                 ('${TA}','${U.staff}','test.scope','new-key-0001',repeat('b',64),'{"a":2}', now(), now());
        INSERT INTO platform.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,created_at)
          VALUES ('${TA}','Encounter','e1','x','{}', now() - interval '40 days'),('${TA}','Encounter','e2','x','{}', now());`);
    const ov = await ret.overview(C.root);
    expect(ov.rules.find((r) => r.id === 'booking_contact')).toMatchObject({ days: 90, due: 2 });
    expect(await outcome(ret.runNow(C.staff))).toBe('FORBIDDEN');
    const r = await ret.runNow(C.root);
    expect(r).toMatchObject({ receipts: 3, detail: { booking_contact: 2, idempotency: 1, outbox: 1, deferredErasures: 0 } });
    // Lịch hẹn cũ: không còn trường định danh, khoá huỷ; vẫn giữ ngày / trạng thái cho thống kê.
    expect(su(`SELECT count(*) FROM clinical.bookings WHERE booking_id IN ('${old1}','${old2}') AND erased_at IS NOT NULL AND family_name IS NULL
                AND birth_date IS NULL AND reason IS NULL AND phone_enc IS NULL AND phone_hint IS NULL AND national_id_bidx IS NULL AND status IN ('no_show','cancelled')`)).toBe('2');
    expect(su(`SELECT count(*) FROM keyvault.subject_keys WHERE subject_id IN ('${old1}','${old2}') AND status='shredded' AND wrapped_key IS NULL`)).toBe('2');
    expect(su(`SELECT (erased_at IS NULL AND phone_enc IS NOT NULL)::text FROM clinical.bookings WHERE booking_id='${recent}'`)).toBe('true');
    // Bản mã cũ (như còn trong bản sao lưu) không mở được nữa, dù có KEK.
    const opened = await asApp(TA, (c) => codec(c).open('phone', tokenOld, { kind: 'booking', id: old1 }).then(() => 'OK', (e) => (e instanceof PiiShreddedError ? 'SHREDDED' : String(e))));
    expect(opened).toBe('SHREDDED');
    expect(su(`SELECT string_agg(idem_key, ',') FROM platform.idempotency_keys WHERE scope = 'test.scope'`)).toBe('new-key-0001');
    expect(su(`SELECT string_agg(aggregate_id, ',') FROM platform.outbox_events WHERE aggregate_id IN ('e1','e2')`)).toBe('e2');
    // Biên nhận: chính sách, căn cứ, phạm vi = số đếm; sổ huỷ có id lịch hẹn; không có giá trị nào đã xoá.
    const rc = (await ret.overview(C.root)).receipts.find((x) => x.ruleId === 'booking_contact')!;
    expect(rc).toMatchObject({ kind: 'retention', outcome: 'completed', scope: { 'clinical.bookings': 2 }, keysShredded: 2, backupHorizonDays: 90, ledger: { events: 2, exported: 0 } });
    expect(Date.parse(rc.irreversibleAfter) - Date.parse(rc.finishedAt)).toBe(90 * 86_400_000);
    expect(rc.policyVersion).toMatch(/^[0-9a-f]{64}$/);
    for (const t of ['governance.deletion_receipts', 'governance.retention_runs', 'keyvault.shred_events', 'platform.audit_events']) {
      expect(su(`SELECT count(*) FROM ${t} x WHERE row_to_json(x)::text ~ '(Trần Thị|Bình|0977111|Đau đầu|079111)'`), t).toBe('0');
    }
    expect((await ret.runNow(C.root)).receipts).toBe(0);
  });

  it('yêu cầu xoá: người lập ≠ người duyệt; không còn ràng buộc => xoá toàn bộ, khoá huỷ, bản mã cũ vô nghĩa', async () => {
    const p = await patient('DEL-1', '0912000001', '079000000021', 'Xoá');
    const linked = await booking(daysAgo(0), '0912000001', null, p.patientId, 'booked');
    const sameCccd = await booking(daysAgo(3), '0988000000', '079000000021');
    const other = await booking(daysAgo(3), '0988000001', '079000000099');
    const oldTokens = su(`SELECT phone_enc || ' ' || email_enc FROM patient.persons WHERE person_id='${p.personId}'`).split(' ');
    const a = await ret.assess(p.patientId, C.staff);
    expect(a).toMatchObject({ holdUntil: null, medicalRecordCount: 0, persons: 1, identifiers: 1, bookings: 1, erased: false });
    expect(await outcome(ret.createRequest({ patientId: p.patientId, channel: 'counter' }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(ret.createRequest({ patientId: p.patientId, channel: 'fax' }, C.staff))).toBe('VALIDATION');
    const req = await ret.createRequest({ patientId: p.patientId, channel: 'written', note: 'Đơn đề nghị số 12' }, C.boss);
    expect(req).toMatchObject({ status: 'pending', mrn: 'DEL-1', assessment: { holdUntil: null } });
    expect(await outcome(ret.createRequest({ patientId: p.patientId, channel: 'counter' }, C.staff))).toBe('CONFLICT:ERASURE_ALREADY_OPEN');
    expect(await outcome(ret.decide(req.requestId, { decision: 'approve' }, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(ret.decide(req.requestId, { decision: 'approve' }, C.boss))).toBe('FORBIDDEN:FOUR_EYES');
    // CSDL cũng chặn: tự duyệt / gọi thực thi khi chưa có người thứ hai.
    await asApp(TA, async (c) => {
      expect(await code(c.query(`UPDATE governance.erasure_requests SET decided_by='${U.boss}', decided_at=now() WHERE request_id='${req.requestId}'`))).toBe('23514');
      expect(await code(c.query(`SELECT governance.execute_erasure('${req.requestId}', gen_random_uuid())`))).toBe('42501');
    });
    const d = await ret.decide(req.requestId, { decision: 'approve', note: 'Đã đối chiếu CCCD' }, C.root);
    expect(d.request).toMatchObject({ status: 'completed', decidedBy: U.root });
    expect(d.receipt).toMatchObject({
      kind: 'erasure', outcome: 'completed', requestId: req.requestId, approvedBy: U.root,
      scope: { 'patient.persons': 1, 'patient.identifiers': 1, 'clinical.bookings': 2 },
    });
    expect(d.receipt!.keysShredded).toBe(4); // người + CCCD + 2 lịch hẹn
    expect(su(`SELECT status || '|' || coalesce(given_name,'-') || '|' || coalesce(birth_date::text,'-') || '|' || coalesce(phone_enc,'-') || '|' || coalesce(name_key,'-')
                FROM patient.persons WHERE person_id='${p.personId}'`)).toBe('erased|-|-|-|-');
    expect(su(`SELECT count(*) FROM patient.identifiers WHERE identifier_id='${p.identifierId}' AND erased_at IS NOT NULL AND value_enc IS NULL AND value_bidx IS NULL`)).toBe('1');
    expect(su(`SELECT string_agg((erased_at IS NOT NULL)::text, ',' ORDER BY booking_id = '${linked}' DESC, booking_id = '${sameCccd}' DESC) FROM clinical.bookings
                WHERE booking_id IN ('${linked}','${sameCccd}','${other}')`)).toBe('true,true,false');
    expect(su(`SELECT count(*) FROM keyvault.subject_keys WHERE subject_id IN ('${p.personId}','${p.identifierId}','${linked}','${sameCccd}') AND status='shredded'`)).toBe('4');
    // Bản mã cũ (như còn trong bản sao lưu) không mở được nữa; xem bản rõ báo đã xoá.
    for (const [i, domain] of [[0, 'phone'], [1, 'email']] as const) {
      const r = await asApp(TA, (c) => codec(c).open(domain, oldTokens[i]!, { kind: 'person', id: p.personId }).then(() => 'OK', (e) => (e instanceof PiiShreddedError ? 'SHREDDED' : String(e))));
      expect(r).toBe('SHREDDED');
    }
    expect(await outcome(pii.reveal({ kind: 'patient', id: p.patientId, field: 'phone', reason: 'Kiểm tra sau khi xoá' }, C.staff))).toBe('NOT_FOUND:PII_ERASED');
    // Không thể ghi lại dữ liệu cho người đã xoá (khoá đã huỷ).
    expect(su(`SELECT count(*) FROM patient.persons x WHERE row_to_json(x)::text ~ '(Xoá|0912000001|del-1@)'`)).toBe('0');
    const letter = await ret.letter(req.requestId, C.staff);
    expect(letter).toContain('xoá toàn bộ');
    expect(letter).not.toMatch(/0912000001|Xoá Nguyễn/);
    expect(await outcome(ret.createRequest({ patientId: p.patientId, channel: 'counter' }, C.staff))).toBe('CONFLICT:ALREADY_ERASED');
  });

  it('còn hồ sơ bệnh án => xoá phần không bị ràng buộc + hạn chế xử lý + hoãn; hết hạn giữ => job xoá nốt', async () => {
    const p = await patient('HOLD-1', '0913000001', '079000000031', 'Giữ');
    const enc = uid(9101);
    su(`INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,status,encounter_class,period_start)
          VALUES ('${enc}','${TA}','${p.patientId}','${OA}','${U.doc}','in_progress','ambulatory', now() - interval '30 days')`);
    const bk = await booking(daysAgo(30), '0913000001', null, p.patientId, 'no_show');
    const req = await ret.createRequest({ patientId: p.patientId, channel: 'counter' }, C.staff);
    expect(req.assessment.medicalRecordCount).toBe(1);
    expect(Date.parse(req.assessment.holdUntil!)).toBeGreaterThan(Date.now() + 3600 * 86_400_000);
    const d = await ret.decide(req.requestId, { decision: 'approve' }, C.root);
    expect(d.request.status).toBe('deferred');
    expect(d.receipt).toMatchObject({ outcome: 'partial', scope: { 'clinical.bookings': 1 } });
    expect(su(`SELECT status || '|' || (processing_restricted_at IS NOT NULL) || '|' || (phone_enc IS NOT NULL) FROM patient.persons WHERE person_id='${p.personId}'`)).toBe('active|true|true');
    expect(su(`SELECT (erased_at IS NOT NULL)::text FROM clinical.bookings WHERE booking_id='${bk}'`)).toBe('true');
    expect(await ret.letter(req.requestId, C.staff)).toContain('phải được lưu giữ');
    // Chưa hết hạn: job không làm gì; gọi thực thi sớm bị chặn trong CSDL.
    expect((await ret.runNow(C.root)).detail['deferredErasures']).toBe(0);
    await asApp(TA, async (c) => expect(await code(c.query(`SELECT governance.execute_erasure('${req.requestId}', gen_random_uuid())`))).toBe('55000'));
    // Mô phỏng 11 năm sau: lần khám cuối đã quá 10 năm, hạn hoãn đã qua => job xoá nốt.
    su(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE clinical.encounters SET period_start = now() - interval '11 years' WHERE encounter_id='${enc}';
        UPDATE governance.erasure_requests SET deferred_until = now() - interval '1 day' WHERE request_id='${req.requestId}'; COMMIT;`);
    expect((await ret.runNow(C.root)).detail['deferredErasures']).toBe(1);
    const after = (await ret.overview(C.root)).requests.find((x) => x.requestId === req.requestId)!;
    expect(after.status).toBe('completed');
    expect(after.finalReceiptId).toBeTruthy();
    expect(su(`SELECT status FROM patient.persons WHERE person_id='${p.personId}'`)).toBe('erased');
    // Đợt khám vẫn còn (pseudonym: chỉ còn mã hồ sơ, không còn danh tính).
    expect(su(`SELECT count(*) FROM clinical.encounters WHERE encounter_id='${enc}'`)).toBe('1');
  });

  it('từ chối cần lý do; sổ huỷ chỉ đánh dấu đã đẩy một lần; phát lại sau khôi phục (superuser) idempotent; tách tenant', async () => {
    const p = await patient('REJ-1', '0914000001', '079000000041', 'Tuchoi');
    const req = await ret.createRequest({ patientId: p.patientId, channel: 'email' }, C.staff);
    expect(await outcome(ret.decide(req.requestId, { decision: 'reject' }, C.root))).toBe('VALIDATION:REASON_REQUIRED');
    expect(await outcome(ret.decide(req.requestId, { decision: 'approve' }, C.rootB))).toBe('NOT_FOUND');
    expect((await ret.decide(req.requestId, { decision: 'reject', note: 'Không xác minh được người yêu cầu' }, C.root)).request.status).toBe('rejected');
    expect(su(`SELECT status FROM patient.persons WHERE person_id='${p.personId}'`)).toBe('active');
    expect((await ret.overview(C.rootB)).requests).toEqual([]);

    // Sổ huỷ: script đẩy ra ngoài (superuser) đánh dấu exported_at một lần; role ứng dụng không sửa được.
    const ev = su(`SELECT min(event_id) FROM keyvault.shred_events`);
    await asApp(TA, async (c) => expect(await code(c.query(`UPDATE keyvault.shred_events SET exported_at = now() WHERE event_id = ${ev}`))).toBe('42501'));
    expect(su(`SELECT count(*) FROM keyvault.shred_events WHERE exported_at IS NOT NULL`)).toBe('0');
    su(`UPDATE keyvault.shred_events SET exported_at = now() WHERE event_id = ${ev}`);
    expect(() => su(`UPDATE keyvault.shred_events SET exported_at = now() WHERE event_id = ${ev}`)).toThrow();
    expect(() => su(`DELETE FROM keyvault.shred_events WHERE event_id = ${ev}`)).toThrow();

    // Phát lại (sau khi khôi phục bản sao lưu cũ hơn lần xoá): áp dụng đúng hàm xoá, lần hai không làm gì, id lạ bỏ qua.
    const q = await patient('RPL-1', '0915000001', '079000000051', 'Phatlai');
    const rid = randomUUID();
    expect(su(`SELECT governance.replay_shred('${TA}', 'person', '${q.personId}', '${rid}')`)).toBe('applied');
    expect(su(`SELECT governance.replay_shred('${TA}', 'person', '${q.personId}', '${rid}')`)).toBe('already');
    expect(su(`SELECT governance.replay_shred('${TA}', 'booking', '${uid(424242)}', '${rid}')`)).toBe('absent');
    expect(su(`SELECT status || '|' || (SELECT status FROM keyvault.subject_keys WHERE subject_id='${q.personId}') FROM patient.persons WHERE person_id='${q.personId}'`)).toBe('erased|shredded');
    expect(su(`SELECT count(*) || '|' || bool_and(replayed AND exported_at IS NOT NULL) FROM keyvault.shred_events WHERE receipt_id='${rid}'`)).toBe('1|true');
  });
});
