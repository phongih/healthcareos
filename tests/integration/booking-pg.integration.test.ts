/**
 * HCOS-F7 | Đặt lịch khám online trên PostgreSQL thật (migration 011): sức chứa theo buổi khi đặt ĐỒNG THỜI,
 * một lịch còn hiệu lực / số điện thoại / ngày, tra cứu + huỷ cần đúng mã VÀ số điện thoại, huỷ trả lại chỗ,
 * check-in gắn hồ sơ + cấp số trong cùng transaction, bộ đếm luôn khớp, cổng tắt => không truy cập, RLS.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/booking-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { nameKey } from '../../packages/domain/src/person-registry';
import { BookingService, CONSENT_VERSION, PgBookingUnitOfWork, PublicBookingService, vnNow, type PublicCreateInput } from '../../services/api/src/clinical/booking.service';
import { PgQueueUnitOfWork, QueueService } from '../../services/api/src/clinical/queue.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_booking_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const U = { doc: asUserId(uid(101)), staff: asUserId(uid(103)), admin: asUserId(uid(104)) };
const PAT_OLD = uid(1001);
const PAT_FAMILY = uid(1002);
const PAT_CCCD = uid(1003);

// Thứ Hai 23/11/2026 11:30 giờ VN: buổi sáng hôm nay đã đóng, buổi chiều còn mở.
const FIXED = new Date('2026-11-23T04:30:00Z');
const TOMORROW = '2026-11-24';
const SUNDAY = '2026-11-29';

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-booking' as CorrelationId,
  });
const C = { doc: ctx(TA, U.doc, [OA]), staff: ctx(TA, U.staff, [OA]), admin: ctx(TA, U.admin, [OA]) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','Phòng khám A');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.doc}','${TA}','sub-${U.doc}','BS Một'),('${U.staff}','${TA}','sub-${U.staff}','Lễ tân'),('${U.admin}','${TA}','sub-${U.admin}','Quản lý');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.admin}','${OA}','clinic_admin');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name,birth_date,name_key)
  VALUES ('${uid(2001)}','${TA}','An','Nguyễn Văn','1950-03-04','${nameKey('An', 'Nguyễn Văn')}');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT_OLD}','${TA}','${uid(2001)}','${OA}','B0001');
-- Người nhà dùng chung SĐT (khác tên, khác ngày sinh) và một hồ sơ có đúng CCCD nhưng tên gõ khác.
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name,birth_date,name_key,phone_key)
  VALUES ('${uid(2002)}','${TA}','Bình','Nguyễn Thị','1952-07-07','${nameKey('Bình', 'Nguyễn Thị')}','0912345678'),
         ('${uid(2003)}','${TA}','Anh','Nguyen Van','1950-03-04','${nameKey('Anh', 'Nguyen Van')}',NULL);
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES
  ('${PAT_FAMILY}','${TA}','${uid(2002)}','${OA}','B0002'),('${PAT_CCCD}','${TA}','${uid(2003)}','${OA}','B0003');
INSERT INTO patient.identifiers(tenant_id,person_id,type,system,value) VALUES ('${TA}','${uid(2003)}','national_id','https://moh.gov.vn/cccd','001050000001');
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const form = (over: Partial<PublicCreateInput> = {}): PublicCreateInput => ({
  servicePointId: '', visitDate: TOMORROW, period: 'morning', familyName: 'Nguyễn Văn', givenName: 'An', birthDate: '1950-03-04', sex: 'male',
  phone: '0912345678', nationalId: null, reason: 'Ho kéo dài', consent: true, consentVersion: CONSENT_VERSION, ...over,
});

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Đặt lịch khám online / PostgreSQL', () => {
  let q: QueueService;
  let bk: BookingService;
  let pub: PublicBookingService;
  let r1: string;
  let r2: string;
  let codeA = '';

  const consistent = () =>
    su(`SELECT count(*) FROM clinical.booking_counters c WHERE c.booked <> (SELECT count(*) FROM clinical.bookings b
          WHERE b.tenant_id = c.tenant_id AND b.service_point_id = c.service_point_id AND b.visit_date = c.visit_date AND b.period = c.period
            AND b.status IN ('booked','checked_in'))`);

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    q = new QueueService({ uow: new PgQueueUnitOfWork(pool), audit });
    bk = new BookingService({ uow: new PgBookingUnitOfWork(pool), audit });
    pub = new PublicBookingService({ pool, audit, clock: () => FIXED });
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('cấu hình: chỉ quản lý đặt sức chứa / tạo cổng; slug trùng hoặc cổng thứ hai => CONFLICT', async () => {
    const a = await q.createServicePoint({ organizationId: OA, code: 'N1', name: 'Phòng Nội 1' }, C.admin);
    const b = await q.createServicePoint({ organizationId: OA, code: 'N2', name: 'Phòng Nội 2' }, C.admin);
    r1 = a.servicePointId;
    r2 = b.servicePointId;
    expect(await outcome(bk.setBookingCapacity(r1, 2, a.version, C.staff))).toBe('FORBIDDEN');
    expect((await bk.setBookingCapacity(r1, 2, a.version, C.admin)).bookingCapacity).toBe(2);
    expect(await outcome(bk.setBookingCapacity(r1, 3, a.version, C.admin))).toBe('CONFLICT:VERSION_CONFLICT');
    expect(await outcome(bk.createPortal({ organizationId: OA, slug: 'pk-a' }, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(bk.createPortal({ organizationId: OA, slug: 'A B' }, C.admin))).toBe('VALIDATION');
    expect((await bk.createPortal({ organizationId: OA, slug: 'PK-A' }, C.admin)).slug).toBe('pk-a');
    expect(await outcome(bk.createPortal({ organizationId: OA, slug: 'pk-b' }, C.admin))).toBe('CONFLICT:PORTAL_EXISTS');
  });

  it('options: chỉ phòng có sức chứa; không Chủ nhật; buổi sáng hôm nay đã đóng; slug lạ => null', async () => {
    expect(await pub.options('khong-co')).toBeNull();
    const o = (await pub.options('pk-a'))!;
    expect(o.organizationName).toBe('Phòng khám A');
    expect(o.rooms.map((r) => r.code)).toEqual(['N1']);
    expect(o.slots.some((s) => s.date === '2026-11-23' && s.period === 'morning')).toBe(false);
    expect(o.slots.some((s) => s.date === '2026-11-23' && s.period === 'afternoon')).toBe(true);
    expect(o.slots.some((s) => s.date === SUNDAY)).toBe(false);
    expect(o.slots.some((s) => s.date > '2026-12-07')).toBe(false);
    expect(o.slots.find((s) => s.date === TOMORROW && s.period === 'morning')?.remaining).toBe(2);
    expect(JSON.stringify(o)).not.toContain(r2);
  });

  it('create: kiểm tra đồng ý, bẫy bot, SĐT, buổi đóng, phòng không nhận lịch', async () => {
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, consent: false })))).toBe('VALIDATION:CONSENT_REQUIRED');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, website: 'http://spam' })))).toBe('VALIDATION:REJECTED');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, phone: '12345' })))).toBe('VALIDATION:INVALID_PHONE');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, nationalId: '123' })))).toBe('VALIDATION:INVALID_NATIONAL_ID');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, visitDate: '2026-11-23', period: 'morning' })))).toBe('VALIDATION:SESSION_CLOSED');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, visitDate: SUNDAY })))).toBe('VALIDATION:SESSION_CLOSED');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r2 })))).toBe('VALIDATION:ROOM_NOT_BOOKABLE');
    expect(su('SELECT count(*) FROM clinical.bookings')).toBe('0');
  });

  it('đặt ĐỒNG THỜI 4 người vào buổi sức chứa 2 => đúng 2 thành công, 2 SESSION_FULL; bộ đếm khớp', async () => {
    const phones = ['0900000001', '0900000002', '0900000003', '0900000004'];
    const res = await Promise.all(phones.map((p, i) => outcome(pub.create('pk-a', form({ servicePointId: r1, phone: p, givenName: `Khách ${'ABCD'[i]}` })))));
    expect(res.filter((x) => x === 'OK')).toHaveLength(2);
    expect(res.filter((x) => x === 'CONFLICT:SESSION_FULL')).toHaveLength(2);
    expect(su(`SELECT booked FROM clinical.booking_counters WHERE visit_date='${TOMORROW}' AND period='morning'`)).toBe('2');
    expect((await pub.options('pk-a'))!.slots.find((s) => s.date === TOMORROW && s.period === 'morning')?.remaining).toBe(0);
    expect(consistent()).toBe('0');
  });

  it('mã đặt lịch trả một lần (DB chỉ lưu hash); một SĐT chỉ một lịch còn hiệu lực mỗi ngày', async () => {
    const r = (await pub.create('pk-a', form({ servicePointId: r1, period: 'afternoon', phone: '+84 912 345 678', nationalId: '001050000001' })))!;
    expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(r).toMatchObject({ visitDate: TOMORROW, period: 'afternoon', servicePointName: 'Phòng Nội 1' });
    codeA = r.code;
    expect(su(`SELECT count(*) FROM clinical.bookings WHERE code_hash = sha256(convert_to('${r.code.replace('-', '')}', 'UTF8')) AND phone = '0912345678'`)).toBe('1');
    expect(su(`SELECT octet_length(code_hash) FROM clinical.bookings WHERE phone = '0912345678'`)).toBe('32');
    expect(await outcome(pub.create('pk-a', form({ servicePointId: r1, period: 'afternoon', phone: '0912345678' })))).toBe('CONFLICT:PHONE_ALREADY_BOOKED');
    // Lỗi trùng SĐT xảy ra SAU khi giữ chỗ => transaction rollback, chỗ không bị mất.
    expect(su(`SELECT booked FROM clinical.booking_counters WHERE visit_date='${TOMORROW}' AND period='afternoon'`)).toBe('1');
  });

  it('tra cứu / huỷ: sai SĐT hoặc mã => null (không phân biệt); đúng => trạng thái tối thiểu; huỷ trả chỗ', async () => {
    expect(await pub.lookup('pk-a', codeA, '0999999999')).toBeNull();
    expect(await pub.lookup('pk-a', 'ZZZZ-ZZZZ', '0912345678')).toBeNull();
    expect(await pub.lookup('pk-a', 'bad', '0912345678')).toBeNull();
    const l = (await pub.lookup('pk-a', codeA.toLowerCase().replace('-', ' '), '0912 345 678'))!;
    expect(l).toEqual({ status: 'booked', visitDate: TOMORROW, period: 'afternoon', servicePointName: 'Phòng Nội 1', givenName: 'An' });
    expect(await pub.cancel('pk-a', codeA, '0999999999')).toBeNull();
    expect((await pub.cancel('pk-a', codeA, '0912345678'))!.status).toBe('cancelled');
    expect(await outcome(pub.cancel('pk-a', codeA, '0912345678'))).toBe('INVALID_STATE:NOT_CANCELLABLE');
    expect(su(`SELECT booked FROM clinical.booking_counters WHERE visit_date='${TOMORROW}' AND period='afternoon'`)).toBe('0');
    expect(consistent()).toBe('0');
    // Đã huỷ => cùng SĐT đặt lại được.
    codeA = (await pub.create('pk-a', form({ servicePointId: r1, period: 'afternoon', phone: '0912345678', nationalId: '001050000001' })))!.code;
  });

  it('lễ tân: bác sĩ không xem được; tra mã => lịch + hồ sơ có thể trùng; check-in khác ngày => NOT_VISIT_DAY', async () => {
    expect(await outcome(bk.listForDay({ organizationId: OA, date: TOMORROW }, C.doc))).toBe('FORBIDDEN');
    const list = await bk.listForDay({ organizationId: OA, date: TOMORROW }, C.staff);
    expect(list.map((b) => b.status).sort()).toEqual(['booked', 'booked', 'booked', 'cancelled']);
    const f = (await bk.findByCode({ organizationId: OA, code: codeA }, C.staff))!;
    expect(f.booking.phone).toBe('0912345678');
    // Xếp theo độ tin cậy: CCCD trước (dù tên gõ khác), rồi họ tên + ngày sinh, cuối cùng chỉ trùng SĐT (người nhà).
    expect(f.candidates.map((x) => [x.mrn, x.matchedBy.join()])).toEqual([
      ['B0003', 'national_id'], ['B0001', 'name_birthdate'], ['B0002', 'phone'],
    ]);
    expect(await bk.findByCode({ organizationId: OA, code: 'ZZZZ-ZZZZ' }, C.staff)).toBeNull();
    expect((await bk.getById(f.booking.bookingId, C.staff)).candidates).toHaveLength(3);
    expect(await outcome(bk.getById(f.booking.bookingId, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(bk.checkIn(f.booking.bookingId, { patientId: PAT_OLD }, C.staff))).toBe('INVALID_STATE:NOT_VISIT_DAY');
  });

  it('check-in hôm nay: gắn hồ sơ + cấp số vào phòng đã đặt trong cùng transaction; lần hai => BOOKING_NOT_ACTIVE', async () => {
    const today = vnNow(new Date()).date;
    const code = 'ABCD2345';
    su(`BEGIN;
        INSERT INTO clinical.booking_counters(tenant_id,service_point_id,visit_date,period,booked) VALUES ('${TA}','${r1}','${today}','afternoon',1)
          ON CONFLICT (tenant_id,service_point_id,visit_date,period) DO UPDATE SET booked = clinical.booking_counters.booked + 1;
        INSERT INTO clinical.bookings(tenant_id,organization_id,service_point_id,visit_date,period,code_hash,family_name,given_name,birth_date,sex,phone,consent_version,consent_at)
          VALUES ('${TA}','${OA}','${r1}','${today}','afternoon',sha256(convert_to('${code}','UTF8')),'Nguyễn Văn','An','1950-03-04','male','0977000000','${CONSENT_VERSION}',now());
        COMMIT;`);
    const f = (await bk.findByCode({ organizationId: OA, code: 'abcd-2345' }, C.staff))!;
    expect(await outcome(bk.checkIn(f.booking.bookingId, { patientId: PAT_OLD }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(bk.checkIn(f.booking.bookingId, { patientId: PAT_OLD, priorityReason: 'vip' }, C.staff))).toBe('VALIDATION');
    const r = await bk.checkIn(f.booking.bookingId, { patientId: PAT_OLD, priorityReason: 'elderly_75' }, C.staff);
    expect(r.booking).toMatchObject({ status: 'checked_in', patientId: PAT_OLD, ticketId: r.ticket.ticketId });
    expect(r.ticket).toMatchObject({ displayNo: 'N1-001', servicePointId: r1, priorityReason: 'elderly_75', status: 'waiting' });
    expect(await outcome(bk.checkIn(f.booking.bookingId, { patientId: PAT_OLD }, C.staff))).toBe('INVALID_STATE:BOOKING_NOT_ACTIVE');
    expect(await outcome(bk.cancel(f.booking.bookingId, C.staff))).toBe('INVALID_STATE:BOOKING_NOT_ACTIVE');
    expect(consistent()).toBe('0');
  });

  it('lễ tân huỷ lịch => trả chỗ; DB chặn: bộ đếm lệch, sửa chi tiết, quay lại booked, xoá; RLS', async () => {
    const f = (await bk.findByCode({ organizationId: OA, code: codeA }, C.staff))!;
    expect((await bk.cancel(f.booking.bookingId, C.staff)).cancelledBy).toBe('staff');
    expect(consistent()).toBe('0');

    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const bid = su(`SELECT booking_id FROM clinical.bookings WHERE status='booked' LIMIT 1`);
      expect(await code(`UPDATE clinical.booking_counters SET booked = booked + 1 WHERE visit_date='${TOMORROW}' AND period='morning'`)).toBe('23514');
      expect(await code(`UPDATE clinical.bookings SET phone = '0911111111' WHERE booking_id='${bid}'`)).toBe('42501');
      expect(await code(`UPDATE clinical.bookings SET status = 'booked', cancelled_by = NULL, cancelled_at = NULL WHERE booking_id='${f.booking.bookingId}'`)).not.toBe('OK');
      expect(await code(`DELETE FROM clinical.bookings WHERE booking_id='${bid}'`)).toBe('42501');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query(`SELECT 1 FROM clinical.bookings`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT 1 FROM clinical.booking_counters`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT 1 FROM clinical.booking_portals`)).rows).toHaveLength(0);
    } finally {
      c.close();
    }
  });

  it('cổng tắt => options/create/lookup trả null; bật lại => hoạt động; tenant bị đình chỉ => null', async () => {
    const p = (await bk.getPortal(OA, C.admin))!;
    await bk.setPortalActive({ organizationId: OA, isActive: false }, p.version, C.admin);
    expect(await pub.options('pk-a')).toBeNull();
    expect(await pub.create('pk-a', form({ servicePointId: r1, visitDate: '2026-11-25', phone: '0933333333' }))).toBeNull();
    const p2 = (await bk.getPortal(OA, C.admin))!;
    expect(p2.isActive).toBe(false);
    await bk.setPortalActive({ organizationId: OA, isActive: true }, p2.version, C.admin);
    expect(await pub.options('pk-a')).not.toBeNull();
    su(`UPDATE iam.tenants SET status = 'suspended' WHERE tenant_id = '${TA}'`);
    expect(await pub.options('pk-a')).toBeNull();
    su(`UPDATE iam.tenants SET status = 'active' WHERE tenant_id = '${TA}'`);
  });
});
