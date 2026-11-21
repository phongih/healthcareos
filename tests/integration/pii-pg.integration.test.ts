/**
 * HCOS-F16 | Mã hoá theo trường trên PostgreSQL thật:
 *  - người chỉ đọc được CSDL (kể cả superuser / bản sao lưu) không thấy bản rõ và không mở được DEK khi thiếu KEK;
 *  - CSDL chặn ghi bản rõ; xem bản rõ cần pii:reveal tại đúng cơ sở + lý do, có audit (không ghi giá trị);
 *  - lịch hẹn -> hồ sơ: blind index khớp, CCCD không qua trình duyệt;
 *  - xoay DEK + mã hoá lại, xoay KEK (bọc lại) rồi bỏ KEK cũ, xoay khoá blind index;
 *  - backfill dữ liệu cũ (cả ảnh chụp gộp hồ sơ), tách tenant.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/pii-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { configureKeyProvider, LocalKeyProvider, TenantPii } from '../../packages/security/src/pii';
import { BookingService, CONSENT_VERSION, PgBookingUnitOfWork, PublicBookingService } from '../../services/api/src/clinical/booking.service';
import { PgQueueUnitOfWork, QueueService } from '../../services/api/src/clinical/queue.service';
import { PersonRegistryService, PgRegistryUnitOfWork } from '../../services/api/src/registry/person-registry.service';
import { PiiService } from '../../services/api/src/security/pii.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_pii_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OA2 = asOrganizationId(uid(12));
const OB = asOrganizationId(uid(13));
const U = {
  staff: asUserId(uid(101)), staff2: asUserId(uid(102)), doc: asUserId(uid(103)), pharm: asUserId(uid(104)), root: asUserId(uid(105)), mgr: asUserId(uid(106)), rootB: asUserId(uid(107)),
};
const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-pii' as CorrelationId,
  });
const C = {
  staff: ctx(TA, U.staff, [OA]), staff2: ctx(TA, U.staff2, [OA2]), doc: ctx(TA, U.doc, [OA]), pharm: ctx(TA, U.pharm, [OA]),
  root: ctx(TA, U.root, [OA]), mgr: ctx(TA, U.mgr, [OA]), rootB: ctx(TB, U.rootB, [OB]),
};

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const FIXED = new Date('2026-11-23T04:30:00Z');
const K1 = randomBytes(32);
const K2 = randomBytes(32);
const PHONE = '0912345678';
const CCCD = '079090000001';
const CCCD_SYSTEM = 'https://moh.gov.vn/cccd';

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Mã hoá theo trường / PostgreSQL', () => {
  let reg: PersonRegistryService;
  let pii: PiiService;
  let bk: BookingService;
  let pub: PublicBookingService;
  let personId: string;
  let identifierId: string;
  let patientId: string;

  beforeAll(async () => {
    configureKeyProvider(new LocalKeyProvider([['k1', K1]]));
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES
        ('${OA}','${TA}','clinic','c1','PK A'),('${OA2}','${TA}','clinic','c2','PK A2'),('${OB}','${TB}','clinic','c3','PK B');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name)
        SELECT u, t, 'sub-' || u, n FROM (VALUES
          ('${U.staff}'::uuid,'${TA}'::uuid,'Lễ tân A'),('${U.staff2}','${TA}','Lễ tân A2'),('${U.doc}','${TA}','BS A'),('${U.pharm}','${TA}','DS A'),
          ('${U.root}','${TA}','Quản trị A'),('${U.mgr}','${TA}','Quản lý A'),('${U.rootB}','${TB}','Quản trị B')) v(u,t,n);
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.staff2}','${OA2}','clinic_staff'),('${TA}','${U.doc}','${OA}','doctor'),
        ('${TA}','${U.pharm}','${OA}','pharmacist'),('${TA}','${U.root}','${OA}','tenant_admin'),('${TA}','${U.mgr}','${OA}','clinic_admin'),
        ('${TB}','${U.rootB}','${OB}','tenant_admin');
      INSERT INTO patient.mrn_settings(tenant_id,organization_id,allow_legacy) VALUES ('${TA}','${OA}',true);
    `);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    reg = new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit });
    pii = new PiiService({ pool, audit });
    bk = new BookingService({ uow: new PgBookingUnitOfWork(pool), audit, registrar: (input, c) => reg.registerPersonAndPatient(input as never, c) });
    pub = new PublicBookingService({ pool, audit, clock: () => FIXED });
    const q = new QueueService({ uow: new PgQueueUnitOfWork(pool), audit });
    const sp = await q.createServicePoint({ organizationId: OA, code: 'N1', name: 'Nội 1' }, C.mgr);
    await bk.setBookingCapacity(sp.servicePointId, 10, sp.version, C.mgr);
    await bk.createPortal({ organizationId: OA, slug: 'pk-pii' }, C.mgr);
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('người chỉ đọc được CSDL không thấy bản rõ, không mở được DEK khi thiếu KEK', async () => {
    const r = await reg.registerPersonAndPatient({
      organizationId: OA, mrn: 'PII-001',
      person: { givenName: 'An', familyName: 'Nguyễn Văn', birthDate: '1980-01-01', sex: 'male', phone: '+84 912 345 678', email: 'an@example.vn',
        identifiers: [{ type: 'national_id', system: CCCD_SYSTEM, value: CCCD }] },
    } as never, C.staff);
    personId = r.person.personId;
    identifierId = r.identifiers[0]!.identifierId;
    patientId = r.patient.patientId;
    expect(r.person.phone).toBe('091****678');
    expect(r.identifiers[0]!.value).toBe('********0001');
    // Quét toàn bộ dòng (kể cả audit, outbox) bằng superuser: không có bản rõ.
    for (const t of ['patient.persons', 'patient.identifiers', 'platform.audit_events', 'platform.outbox_events', 'keyvault.tenant_keys']) {
      expect(su(`SELECT count(*) FROM ${t} x WHERE row_to_json(x)::text ~ '(912345678|090000001|an@example)'`), t).toBe('0');
    }
    expect(su(`SELECT string_agg(purpose || ':' || version || ':' || kek_id || ':' || length(wrapped_key), ',' ORDER BY purpose) FROM keyvault.tenant_keys WHERE tenant_id='${TA}'`))
      .toBe('data:1:k1:60,index:1:k1:60');
    // "Kẻ tấn công" có bản sao CSDL nhưng không có KEK: không mở được DEK.
    const c = new PsqlClient({ database: DB });
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const thief = new TenantPii({ tenantId: TA, query: (s: string, p?: readonly unknown[]) => c.query(s, p ?? []) } as never, new LocalKeyProvider([['k1', randomBytes(32)]]));
      const token = su(`SELECT phone_enc FROM patient.persons WHERE person_id='${personId}'`);
      expect(await outcome(thief.open('phone', token))).not.toBe('OK');
    } finally {
      c.close();
    }
  });

  it('CSDL chặn ghi bản rõ (role ứng dụng lẫn superuser)', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`UPDATE patient.persons SET phone='0900000000' WHERE person_id='${personId}'`)).toBe('42501');
      expect(await code(`UPDATE patient.persons SET phone_key='0900000000' WHERE person_id='${personId}'`)).toBe('42501');
      expect(await code(`UPDATE patient.identifiers SET value='1' WHERE identifier_id='${identifierId}'`)).toBe('42501');
      expect(await code(`INSERT INTO patient.persons(tenant_id,given_name,family_name,email) VALUES ('${TA}','X','Y','x@y.vn')`)).toBe('42501');
      expect(await code(`UPDATE patient.persons SET phone_enc='not-a-token', phone_bidx='x', phone_hint='x' WHERE person_id='${personId}'`)).toBe('23514');
      expect(await code(`DELETE FROM keyvault.tenant_keys`)).toBe('42501');
    } finally {
      c.close();
    }
    expect(() => su(`UPDATE patient.persons SET email='x@y.vn' WHERE person_id='${personId}'`)).toThrow();
  });

  it('xem bản rõ: cần pii:reveal tại cơ sở của bản ghi + lý do; mỗi lần đều audit, không ghi giá trị', async () => {
    const body = (o: object = {}) => ({ kind: 'person', id: personId, field: 'phone', reason: 'Gọi điện báo kết quả', ...o });
    expect(await outcome(pii.reveal(body(), C.pharm))).toBe('FORBIDDEN');
    expect(await outcome(pii.reveal(body(), C.staff2))).toBe('FORBIDDEN'); // lễ tân cơ sở khác (người bệnh không có hồ sơ ở đó)
    expect(await outcome(pii.reveal(body({ reason: 'x' }), C.staff))).toBe('VALIDATION:REASON_REQUIRED');
    expect(await outcome(pii.reveal(body({ field: 'given_name' }), C.staff))).toBe('VALIDATION');
    expect(await pii.reveal(body(), C.staff)).toEqual({ value: PHONE });
    expect(await pii.reveal(body({ field: 'email' }), C.doc)).toEqual({ value: 'an@example.vn' });
    expect(await pii.reveal({ kind: 'identifier', id: identifierId, field: 'value', reason: 'Đối chiếu CCCD' }, C.staff)).toEqual({ value: CCCD });
    // Giao diện gọi theo patientId (FHIR Patient.id): ánh xạ về person / CCCD đang hiệu lực.
    expect(await pii.reveal({ kind: 'patient', id: patientId, field: 'nationalId', reason: 'Đối chiếu CCCD' }, C.doc)).toEqual({ value: CCCD });
    expect(await outcome(pii.reveal({ kind: 'patient', id: patientId, field: 'phone', reason: 'Gọi điện báo kết quả' }, C.pharm))).toBe('FORBIDDEN');
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action='pii.reveal' AND outcome='success'`)).toBe('4');
    expect(su(`SELECT payload->>'reason' FROM platform.audit_events WHERE action='pii.reveal' ORDER BY occurred_at LIMIT 1`)).toBe('Gọi điện báo kết quả');
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE payload::text ~ '(912345678|079090000001)'`)).toBe('0');
  });

  it('lịch hẹn: SĐT / CCCD chỉ lưu bản mã; khớp hồ sơ cũ bằng blind index; tạo hồ sơ từ lịch mà không lộ CCCD ra trình duyệt', async () => {
    const tomorrow = '2026-11-24';
    const sp = su(`SELECT service_point_id FROM clinical.service_points WHERE code='N1'`);
    const base = { servicePointId: sp, visitDate: tomorrow, period: 'morning', familyName: 'Trần', givenName: 'Bình', birthDate: '1990-02-02', sex: 'female', consent: true, consentVersion: CONSENT_VERSION };
    // Lịch 1: cùng CCCD với người bệnh đã có => khớp "national_id".
    const a = (await pub.create('pk-pii', { ...base, phone: '0977000001', nationalId: CCCD } as never))!;
    const fa = (await bk.findByCode({ organizationId: OA, code: a.code }, C.staff))!;
    expect(fa.booking).toMatchObject({ phone: '097****001', nationalId: '********0001' });
    expect(fa.candidates.map((x) => x.matchedBy)).toEqual([['national_id']]);
    expect(await pub.lookup('pk-pii', a.code, '+84 977 000 001')).not.toBeNull();
    expect(await pub.lookup('pk-pii', a.code, '0977000002')).toBeNull();
    // Lịch 2: người mới => tạo hồ sơ ở server; blind index SĐT / CCCD khớp giữa lịch hẹn và hồ sơ.
    const b = (await pub.create('pk-pii', { ...base, givenName: 'Cúc', phone: '0977000003', nationalId: '079090000003' } as never))!;
    const fb = (await bk.findByCode({ organizationId: OA, code: b.code }, C.staff))!;
    expect(await outcome(bk.registerPatient(fb.booking.bookingId, {}, C.doc))).toBe('FORBIDDEN');
    const created = await bk.registerPatient(fb.booking.bookingId, {}, C.staff);
    expect(created.mrn).toMatch(/^BN\d{2}-\d{6}-\d$/);
    expect(su(`SELECT (ps.phone_bidx = b.phone_bidx AND i.value_bidx = b.national_id_bidx)::text
                 FROM clinical.bookings b, patient.patients pt JOIN patient.persons ps ON ps.person_id = pt.person_id
                 JOIN patient.identifiers i ON i.person_id = ps.person_id
                WHERE b.booking_id='${fb.booking.bookingId}' AND pt.patient_id='${created.patientId}'`)).toBe('true');
    expect(await pii.reveal({ kind: 'booking', id: fb.booking.bookingId, field: 'nationalId', reason: 'Đối chiếu CCCD' }, C.staff)).toEqual({ value: '079090000003' });
    expect(su(`SELECT count(*) FROM clinical.bookings x WHERE row_to_json(x)::text ~ '(977000003|079090000003)'`)).toBe('0');
  });

  it('xoay DEK + mã hoá lại: dữ liệu cũ vẫn mở được; chỉ quản trị hệ thống', async () => {
    expect(await outcome(pii.rotate('data', C.mgr))).toBe('FORBIDDEN');
    expect(await pii.rotate('data', C.root)).toEqual({ purpose: 'data', version: 2 });
    const p2 = await reg.createPerson({ givenName: 'Dung', familyName: 'Lê', birthDate: '1991-03-03', phone: '0911000002' } as never, C.staff);
    expect(su(`SELECT split_part(phone_enc, '.', 2) FROM patient.persons WHERE person_id='${p2.person.personId}'`)).toBe('2');
    expect((await pii.keys(C.root)).byDataVersion['1']).toBeGreaterThan(0);
    expect(await pii.reveal({ kind: 'person', id: personId, field: 'phone', reason: 'Gọi điện báo kết quả' }, C.staff)).toEqual({ value: PHONE });
    expect((await pii.reencrypt(1000, C.root)).reencrypted).toBeGreaterThan(0);
    const k = await pii.keys(C.root);
    expect(Object.keys(k.byDataVersion)).toEqual(['2']);
    expect(k.keys.filter((x) => x.purpose === 'data').map((x) => `${x.version}:${x.status}`)).toEqual(['1:retired', '2:active']);
    expect(await pii.reveal({ kind: 'person', id: personId, field: 'phone', reason: 'Gọi điện báo kết quả' }, C.staff)).toEqual({ value: PHONE });
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action IN ('pii.keys.rotate.data','pii.keys.reencrypt') AND outcome='success'`)).toBe('2');
  });

  it('xoay KEK: bọc lại bằng KEK mới rồi bỏ KEK cũ — dữ liệu vẫn mở được', async () => {
    configureKeyProvider(new LocalKeyProvider([['k2', K2], ['k1', K1]]));
    expect((await pii.keys(C.root)).configuredKekIds).toEqual(['k2', 'k1']);
    expect((await pii.rewrap(C.root)).rewrapped).toBe(3); // data v1, v2, index v1
    expect(su(`SELECT string_agg(DISTINCT kek_id, ',') FROM keyvault.tenant_keys WHERE tenant_id='${TA}'`)).toBe('k2');
    configureKeyProvider(new LocalKeyProvider([['k2', K2]]));
    expect(await pii.reveal({ kind: 'identifier', id: identifierId, field: 'value', reason: 'Đối chiếu CCCD' }, C.staff)).toEqual({ value: CCCD });
  });

  it('xoay khoá blind index: tính lại mọi index trong một transaction; so khớp trùng / tra cứu vẫn đúng', async () => {
    const before = su(`SELECT phone_bidx FROM patient.persons WHERE person_id='${personId}'`);
    const r = await pii.rotate('index', C.root);
    expect(r).toMatchObject({ purpose: 'index', version: 2 });
    expect(r.recomputed).toBeGreaterThan(0);
    expect(su(`SELECT phone_bidx FROM patient.persons WHERE person_id='${personId}'`)).not.toBe(before);
    const dup = await reg.findDuplicates({ birthDate: '1980-01-01', phone: PHONE } as never, C.staff);
    expect(dup.map((d) => d.personId)).toContain(personId);
    expect(await outcome(reg.createPerson({ givenName: 'Khác', familyName: 'Hẳn', birthDate: '2000-01-01', identifiers: [{ type: 'national_id', system: CCCD_SYSTEM, value: CCCD }] } as never, C.staff)))
      .toBe('CONFLICT:IDENTIFIER_TAKEN');
  });

  it('backfill dữ liệu cũ (kể cả ảnh chụp gộp hồ sơ): mã hoá, kiểm tra, xoá bản rõ; chạy lại không đổi gì', async () => {
    const L1 = uid(9001);
    const L2 = uid(9002);
    su(`ALTER TABLE patient.persons DISABLE TRIGGER persons_z_no_plaintext;
        ALTER TABLE patient.identifiers DISABLE TRIGGER identifiers_z_no_plaintext;
        INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name,phone,email,phone_key) VALUES
          ('${L1}','${TA}','Cũ','Một','0988000001','cu1@example.vn','0988000001'),('${L2}','${TA}','Cũ','Hai',NULL,NULL,NULL);
        INSERT INTO patient.identifiers(tenant_id,person_id,type,system,value) VALUES ('${TA}','${L1}','passport','urn:passport:vn','C7654321');
        INSERT INTO patient.person_merges(tenant_id,source_person_id,target_person_id,reason,merged_by_user_id,source_snapshot,target_snapshot)
          VALUES ('${TA}','${L2}','${L1}','Gộp dữ liệu cũ','${U.mgr}','{"givenName":"Cũ","phone":"0988000002","email":null}','{"givenName":"Cũ","phone":null,"email":"cu1@example.vn"}');
        ALTER TABLE patient.persons ENABLE TRIGGER persons_z_no_plaintext;
        ALTER TABLE patient.identifiers ENABLE TRIGGER identifiers_z_no_plaintext;`);
    const k0 = await pii.keys(C.root);
    expect(k0.plaintextRemaining.find((x) => x.column === 'patient.persons.phone')?.rows).toBe(1);
    expect(k0.snapshotsPlaintext).toBe(1);
    expect(await outcome(pii.backfill(100, C.mgr))).toBe('FORBIDDEN');
    expect((await pii.backfill(100, C.root)).encrypted).toBe(4); // phone, email, identifier, 1 ảnh chụp
    expect((await pii.backfill(100, C.root)).encrypted).toBe(0);
    const k1 = await pii.keys(C.root);
    expect(k1.plaintextRemaining.every((x) => x.rows === 0) && k1.snapshotsPlaintext === 0).toBe(true);
    expect(su(`SELECT coalesce(phone,'-')||'|'||coalesce(phone_key,'-')||'|'||phone_hint||'|'||email_hint FROM patient.persons WHERE person_id='${L1}'`)).toBe('-|-|098****001|c***@example.vn');
    expect(su(`SELECT (source_snapshot->>'phone') IS NULL AND (source_snapshot->'contact'->>'phoneHint') = '098****002' FROM patient.person_merges`)).toBe('t');
    expect(su(`SELECT count(*) FROM patient.person_merges x WHERE row_to_json(x)::text ~ '(988000002|cu1@example)'`)).toBe('0');
    expect(await pii.reveal({ kind: 'person', id: L1, field: 'email', reason: 'Kiểm tra backfill' }, C.root).catch(() => null)).toBeNull(); // L1 không có hồ sơ ở cơ sở nào
    su(`INSERT INTO patient.patients(tenant_id,person_id,organization_id,mrn) VALUES ('${TA}','${L1}','${OA}','LEGACY-1')`);
    expect(await pii.reveal({ kind: 'person', id: L1, field: 'phone', reason: 'Kiểm tra backfill' }, C.staff)).toEqual({ value: '0988000001' });
    // Ảnh chụp: chỉ được thay phone/email bằng contact mã hoá — sửa trường khác bị chặn.
    const c = new PsqlClient({ database: DB });
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const mid = su(`SELECT merge_id FROM patient.person_merges`);
      const bad = await c.query(`SELECT patient.seal_merge_snapshot('${mid}', '{"givenName":"Đổi tên","phone":null,"email":null,"contact":null}'::jsonb, NULL)`).then(() => 'OK', (e: { code?: string }) => e.code);
      expect(bad).toBe('42501');
      expect(await c.query('UPDATE patient.person_merges SET reason = $1', ['Sửa lý do gộp']).then(() => 'OK', (e: { code?: string }) => e.code)).toBe('42501');
    } finally {
      c.close();
    }
  });

  it('tách tenant: không thấy khoá / không mở được bản mã của tenant khác', async () => {
    expect((await pii.keys(C.rootB)).keys).toEqual([]);
    expect(await outcome(pii.reveal({ kind: 'person', id: personId, field: 'phone', reason: 'Thử tenant khác' }, C.rootB))).toBe('NOT_FOUND');
    const c = new PsqlClient({ database: DB });
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query('SELECT 1 FROM keyvault.tenant_keys')).rows).toHaveLength(0);
      const tokenA = su(`SELECT phone_enc FROM patient.persons WHERE person_id='${personId}'`);
      const asB = new TenantPii({ tenantId: TB, query: (s: string, p?: readonly unknown[]) => c.query(s, p ?? []) } as never);
      expect(await outcome(asB.open('phone', tokenA))).not.toBe('OK');
    } finally {
      c.close();
    }
  });
});
