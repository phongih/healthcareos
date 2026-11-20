/**
 * HCOS-F10 | Dự báo kinh doanh trên PostgreSQL thật (migration 013), dữ liệu lịch sử dựng sẵn với ngày cố định:
 * tải phòng khám (vãng lai theo thứ × buổi, đặt lịch × tỷ lệ đến, tái khám, cảnh báo quá tải theo sức khám),
 * điểm đặt hàng lại (tiêu thụ ngày, xu hướng ICD-10, tồn an toàn, hàng sắp hết hạn), cơ sở dòng tiền,
 * thông số có lịch sử chỉ-thêm, quyền.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/forecast-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { ForecastService, PgForecastUnitOfWork, reorderLine } from '../../services/api/src/analytics/forecast.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_forecast_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));
const U = { admin: asUserId(uid(101)), staff: asUserId(uid(102)), pharm: asUserId(uid(103)), doc: asUserId(uid(104)) };
const N1 = uid(201);
const N2 = uid(202);
const MED = { x: uid(301), y: uid(302), z: uid(303) };
const LOC = uid(401);

// "Hôm nay" cố định: thứ Sáu 20/11/2026, 10:00 giờ VN.
const FIXED = new Date('2026-11-20T03:00:00Z');

const ctx = (u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: TA as TenantId, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-forecast' as CorrelationId,
  });
const C = { admin: ctx(U.admin, [OA, OB]), staff: ctx(U.staff, [OA]), pharm: ctx(U.pharm, [OB]) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

/** Đợt khám lịch sử: (cơ sở, bệnh nhân, giờ VN 'YYYY-MM-DD HH:MM'). */
const enc = (id: string, org: string, pat: string, at: string, status = 'finished') =>
  `INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,status,encounter_class,period_start${status === 'finished' ? ',period_end' : ''})
   VALUES ('${id}','${TA}','${pat}','${org}','${U.doc}','${status}','ambulatory',TIMESTAMP '${at}' AT TIME ZONE 'Asia/Ho_Chi_Minh'${status === 'finished' ? `,TIMESTAMP '${at}' AT TIME ZONE 'Asia/Ho_Chi_Minh' + interval '15 min'` : ''});`;

function seedSql(): string {
  const s: string[] = [`
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TA}','clinic','c2','PK B');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.admin}','${TA}','sub-${U.admin}','Quản lý'),('${U.staff}','${TA}','sub-${U.staff}','Lễ tân'),('${U.pharm}','${TA}','sub-${U.pharm}','Kho'),('${U.doc}','${TA}','sub-${U.doc}','BS');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.admin}','${OA}','clinic_admin'),('${TA}','${U.admin}','${OB}','clinic_admin'),('${TA}','${U.staff}','${OA}','clinic_staff'),
  ('${TA}','${U.pharm}','${OB}','pharmacy_admin'),('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.doc}','${OB}','doctor');
-- Đồng hồ test cố định ở quá khứ => membership phải có hiệu lực từ trước đó.
UPDATE iam.memberships SET valid_from = '2026-01-01';
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${TA}', 'K' || g, 'T' FROM generate_series(1, 60) g;
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(1000 + g), 12, '0'))::uuid, '${TA}',
         ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, CASE WHEN g <= 40 THEN '${OA}'::uuid ELSE '${OB}'::uuid END, 'P' || g
    FROM generate_series(1, 60) g;
INSERT INTO clinical.service_points(service_point_id,tenant_id,organization_id,code,name) VALUES ('${N1}','${TA}','${OA}','N1','Nội 1'),('${N2}','${TA}','${OA}','N2','Nội 2');
`];
  const pat = (i: number) => uid(1000 + i);
  let e = 5000;
  // OA: 4 thứ Hai (26/10 → 16/11) mỗi sáng 6 lượt; 4 thứ Tư (28/10 → 18/11) mỗi chiều 2 lượt.
  for (const d of ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']) for (let k = 0; k < 6; k++) s.push(enc(uid(++e), OA, pat(1 + k), `${d} 08:${10 + k}`));
  for (const d of ['2026-10-28', '2026-11-04', '2026-11-11', '2026-11-18']) for (let k = 0; k < 2; k++) s.push(enc(uid(++e), OA, pat(10 + k), `${d} 14:${10 + k}`));
  s.push(`
INSERT INTO pharmacy.medications(medication_id,tenant_id,brand_name,strength,form,unit_of_measure) VALUES
  ('${MED.x}','${TA}','Thuốc X','1','viên','viên'),('${MED.y}','${TA}','Thuốc Y','1','viên','viên'),('${MED.z}','${TA}','Thuốc Z','1','viên','viên');`);
  // (Đợt khám kê đơn để loại 'virtual' — tư vấn từ xa — nên không tính vào lượt đến phòng khám.)
  // OA: đơn thuốc 5 ngày kê 16/11 (kết thúc 21/11 => tái khám dự kiến); đơn kết thúc 02/11 và người đó quay lại 04/11 (lượt thứ Tư) => lượt tái khám.
  s.push(`
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,status,encounter_class,period_start)
  VALUES ('${uid(6001)}','${TA}','${pat(1)}','${OA}','${U.doc}','in_progress','virtual',TIMESTAMP '2026-11-16 08:30' AT TIME ZONE 'Asia/Ho_Chi_Minh'),
         ('${uid(6002)}','${TA}','${pat(10)}','${OA}','${U.doc}','in_progress','virtual',TIMESTAMP '2026-10-28 15:30' AT TIME ZONE 'Asia/Ho_Chi_Minh');
INSERT INTO clinical.prescriptions(prescription_id,tenant_id,organization_id,encounter_id,patient_id,prescriber_user_id,prescribed_at) VALUES
  ('${uid(7001)}','${TA}','${OA}','${uid(6001)}','${pat(1)}','${U.doc}',TIMESTAMP '2026-11-16 08:40' AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  ('${uid(7002)}','${TA}','${OA}','${uid(6002)}','${pat(10)}','${U.doc}',TIMESTAMP '2026-10-28 15:40' AT TIME ZONE 'Asia/Ho_Chi_Minh');
INSERT INTO clinical.prescription_items(tenant_id,prescription_id,line_no,medication_id,dose_quantity,dose_unit,frequency_per_day,duration_days,quantity_prescribed) VALUES
  ('${TA}','${uid(7001)}',1,'${MED.x}',1,'viên',2,5,10),('${TA}','${uid(7002)}',1,'${MED.x}',1,'viên',2,5,10);`);
  // OB (tồn kho): mã J06.9 — 3 lượt trong 7 ngày gần nhất, 6 lượt trong 21 ngày trước => hệ số (3+1)/(6/3+1) = 1.33.
  const j06: string[] = ['2026-11-15', '2026-11-17', '2026-11-19', '2026-10-25', '2026-10-28', '2026-11-01', '2026-11-04', '2026-11-08', '2026-11-11'];
  j06.forEach((d, i) => {
    const id = uid(8000 + i);
    s.push(enc(id, OB, pat(41 + i), `${d} 09:00`, 'in_progress'));
    s.push(`INSERT INTO clinical.conditions(tenant_id,patient_id,encounter_id,code_system,code,display,recorded_by_user_id) VALUES ('${TA}','${pat(41 + i)}','${id}','http://hl7.org/fhir/sid/icd-10','J06.9','NT hô hấp trên','${U.doc}');`);
  });
  s.push(`
INSERT INTO clinical.prescriptions(prescription_id,tenant_id,organization_id,encounter_id,patient_id,prescriber_user_id,prescribed_at)
  VALUES ('${uid(7003)}','${TA}','${OB}','${uid(8000)}','${pat(41)}','${U.doc}',TIMESTAMP '2026-11-15 09:10' AT TIME ZONE 'Asia/Ho_Chi_Minh');
INSERT INTO clinical.prescription_items(tenant_id,prescription_id,line_no,medication_id,dose_quantity,dose_unit,frequency_per_day,duration_days,quantity_prescribed) VALUES
  ('${TA}','${uid(7003)}',1,'${MED.x}',1,'viên',2,5,10);
INSERT INTO pharmacy.stock_locations(location_id,tenant_id,organization_id,name,type) VALUES ('${LOC}','${TA}','${OB}','Quầy','dispensary_counter');
INSERT INTO pharmacy.batches(batch_id,tenant_id,medication_id,batch_number,expiry_date,unit_cost) VALUES
  ('${uid(501)}','${TA}','${MED.x}','XA','2026-11-25',1000),('${uid(502)}','${TA}','${MED.x}','XB','2027-12-31',1000),
  ('${uid(503)}','${TA}','${MED.y}','YA','2027-12-31',2000),('${uid(504)}','${TA}','${MED.z}','ZA','2027-12-31',500);`);
  // Sổ cái: nhập 01/11; X cấp 10/ngày, Y cấp 20/ngày, mỗi ngày 01/11 → 20/11 (20 ngày). Tồn: X 100 (XA) + 30 (XB), Y 50, Z 10.
  s.push(`BEGIN;
INSERT INTO pharmacy.stock_movements(tenant_id,destination_location_id,batch_id,quantity,movement_type,occurred_at) VALUES
  ('${TA}','${LOC}','${uid(501)}',300,'receipt',TIMESTAMP '2026-11-01 07:00' AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  ('${TA}','${LOC}','${uid(502)}',30,'receipt',TIMESTAMP '2026-11-01 07:00' AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  ('${TA}','${LOC}','${uid(503)}',450,'receipt',TIMESTAMP '2026-11-01 07:00' AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  ('${TA}','${LOC}','${uid(504)}',10,'receipt',TIMESTAMP '2026-11-01 07:00' AT TIME ZONE 'Asia/Ho_Chi_Minh');
INSERT INTO pharmacy.stock_movements(tenant_id,source_location_id,batch_id,quantity,movement_type,occurred_at,encounter_id)
  SELECT '${TA}'::uuid,'${LOC}'::uuid,'${uid(501)}'::uuid,10,'dispense',(DATE '2026-11-01' + g + TIME '09:00') AT TIME ZONE 'Asia/Ho_Chi_Minh','${uid(8000)}'::uuid FROM generate_series(0, 19) g
  UNION ALL
  SELECT '${TA}'::uuid,'${LOC}'::uuid,'${uid(503)}'::uuid,20,'dispense',(DATE '2026-11-01' + g + TIME '09:00') AT TIME ZONE 'Asia/Ho_Chi_Minh','${uid(8000)}'::uuid FROM generate_series(0, 19) g;
INSERT INTO pharmacy.inventory_balances(tenant_id,location_id,batch_id,quantity_on_hand) VALUES
  ('${TA}','${LOC}','${uid(501)}',100),('${TA}','${LOC}','${uid(502)}',30),('${TA}','${LOC}','${uid(503)}',50),('${TA}','${LOC}','${uid(504)}',10);
COMMIT;`);
  // OA: một hồ sơ thanh toán 10/11 có phí khám 150k + xét nghiệm 90k.
  s.push(`
INSERT INTO finance.price_items(item_id,tenant_id,organization_id,code,name,category,unit_price) VALUES
  ('${uid(901)}','${TA}','${OA}','KB','Khám','exam',150000),('${uid(902)}','${TA}','${OA}','XN','Xét nghiệm','lab',90000);
INSERT INTO finance.billing_cases(case_id,tenant_id,organization_id,patient_id,opened_by) VALUES ('${uid(951)}','${TA}','${OA}','${pat(2)}','${U.staff}');
INSERT INTO finance.charges(tenant_id,organization_id,case_id,item_id,item_code,description,quantity,unit_price,created_by,created_at) VALUES
  ('${TA}','${OA}','${uid(951)}','${uid(901)}','KB','Khám',1,150000,'${U.staff}',TIMESTAMP '2026-11-10 09:00' AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  ('${TA}','${OA}','${uid(951)}','${uid(902)}','XN','Xét nghiệm',1,90000,'${U.staff}',TIMESTAMP '2026-11-10 09:05' AT TIME ZONE 'Asia/Ho_Chi_Minh');`);
  return s.join('\n');
}

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Dự báo kinh doanh / PostgreSQL', () => {
  let f: ForecastService;

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const x of readdirSync(MIG).filter((y) => /^\d+_.+\.sql$/.test(y)).sort()) suFile(`${MIG}/${x}`);
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB], { input: seedSql(), encoding: 'utf8' });
    f = new ForecastService({ uow: new PgForecastUnitOfWork(psqlPool({ database: DB })), audit: { record: async () => {} }, clock: () => FIXED });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('thông số + sức khám: chỉ quản lý sửa; lịch sử chỉ thêm, app không ghi / sửa lịch sử được', async () => {
    expect(await outcome(f.updateSettings({ organizationId: OA, fixedCostsMonthly: 1, variableCostPct: 1, leadTimeDays: 3, serviceLevelPct: 95 }, 0, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(f.updateSettings({ organizationId: OA, fixedCostsMonthly: 1, variableCostPct: 100, leadTimeDays: 3, serviceLevelPct: 95 }, 0, C.admin))).toBe('VALIDATION:INVALID_SETTINGS');
    expect(await outcome(f.updateSettings({ organizationId: OA, fixedCostsMonthly: 1, variableCostPct: 1, leadTimeDays: 3, serviceLevelPct: 93 }, 0, C.admin))).toBe('VALIDATION:INVALID_SETTINGS');
    let s = await f.updateSettings({ organizationId: OA, fixedCostsMonthly: 60_000_000, variableCostPct: 25, leadTimeDays: 3, serviceLevelPct: 95 }, 0, C.admin);
    s = await f.updateSettings({ organizationId: OA, fixedCostsMonthly: 80_000_000, variableCostPct: 30, leadTimeDays: 3, serviceLevelPct: 95 }, 1, C.admin);
    expect(s).toMatchObject({ fixedCostsMonthly: 80_000_000, variableCostPct: 30, version: 2 });
    expect(s.history.map((h) => [h.version, h.fixedCostsMonthly, h.changedByName])).toEqual([[2, 80_000_000, 'Quản lý'], [1, 60_000_000, 'Quản lý']]);
    expect(await outcome(f.updateSettings({ organizationId: OA, fixedCostsMonthly: 1, variableCostPct: 1, leadTimeDays: 3, serviceLevelPct: 95 }, 1, C.admin))).toBe('CONFLICT:VERSION_CONFLICT');

    expect(await outcome(f.setVisitCapacity(N1, 2, 1, C.staff))).toBe('FORBIDDEN');
    expect((await f.setVisitCapacity(N1, 2, 1, C.admin)).visitCapacity).toBe(2);
    expect(await outcome(f.setVisitCapacity(N2, 0, 1, C.admin))).toBe('VALIDATION');

    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`INSERT INTO finance.forecast_settings_history(tenant_id,organization_id,version,fixed_costs_monthly,variable_cost_pct,lead_time_days,service_level_pct) VALUES ('${TA}','${OA}',99,0,0,3,95)`)).toBe('42501');
      expect(await code(`UPDATE finance.forecast_settings_history SET fixed_costs_monthly = 0`)).toBe('42501');
      expect(await code(`DELETE FROM finance.forecast_settings_history`)).toBe('42501');
    } finally {
      c.close();
    }
  });

  it('tải phòng khám: vãng lai theo thứ × buổi (loại tái khám), đặt lịch × tỷ lệ đến, cảnh báo quá tải theo sức khám', async () => {
    expect(await outcome(f.load({ organizationId: OA }, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(f.load({ organizationId: OA, days: 60 }, C.admin))).toBe('VALIDATION:INVALID_RANGE');
    // Lịch hẹn đã đặt: thứ Tư 25/11 chiều, phòng N1, 2 người.
    su(`BEGIN;
      INSERT INTO clinical.booking_counters(tenant_id,service_point_id,visit_date,period,booked) VALUES ('${TA}','${N1}','2026-11-25','afternoon',2);
      INSERT INTO clinical.bookings(tenant_id,organization_id,service_point_id,visit_date,period,code_hash,family_name,given_name,birth_date,sex,phone,consent_version,consent_at)
        SELECT '${TA}','${OA}','${N1}','2026-11-25','afternoon',sha256(convert_to('C' || g,'UTF8')),'T','K','1990-01-01','male','090000000' || g,'2026-11',now() FROM generate_series(1,2) g;
      COMMIT;`);
    const l = await f.load({ organizationId: OA, days: 14 }, C.admin);
    expect([l.from, l.to]).toEqual(['2026-11-21', '2026-12-04']);
    expect(l.params).toMatchObject({ historyDays: 25, sufficient: true, showRate: 0.85, showRateSource: 'default', returnRateSource: 'default', morningShare: 0.75 });
    // 32 lượt / 25 ngày = 1,28/ngày; thứ Hai 6/ngày => 4,69; thứ Tư 2/ngày => 1,56.
    expect([l.weekdayIndex[1], l.weekdayIndex[3], l.weekdayIndex[5]]).toEqual([4.69, 1.56, 0]);
    const cell = (date: string, p: 'morning' | 'afternoon', sp: string) => l.days.find((d) => d.date === date)!.periods[p].find((c) => c.servicePointId === sp)!;
    // Thứ Hai sáng: 24 lượt / 4 tuần / 2 phòng = 3 mỗi phòng; N1 sức khám 2 => quá tải; N2 chưa khai báo => không đánh giá.
    expect(cell('2026-11-23', 'morning', N1)).toMatchObject({ walkIn: 3, capacity: 2, status: 'overload' });
    expect(cell('2026-11-23', 'morning', N2)).toMatchObject({ walkIn: 3, capacity: null, status: 'unknown' });
    // Thứ Tư chiều: 8 lượt, 1 là tái khám (đơn kết thúc 02/11, quay lại 04/11) => (8 − 1) / 4 / 2 = 0,875; cộng 2 lịch × 0,85.
    const w = cell('2026-11-25', 'afternoon', N1);
    expect([w.walkIn, w.bookedRaw, w.booked]).toEqual([0.9, 2, 1.7]);
    expect(w.status).toBe('overload');
    expect(l.alerts.filter((a) => a.code === 'N1').map((a) => `${a.date}|${a.period}`)).toEqual(['2026-11-23|morning', '2026-11-25|afternoon', '2026-11-30|morning']);
    // Tái khám: đơn kết thúc 21/11 × 0,3, rải đều 9 ngày 20/11 → 28/11 (8 ngày trong kỳ dự báo).
    expect(Math.abs(l.totals.followUp - (0.3 / 9) * 8) < 0.06).toBe(true);
    expect(Math.abs(l.days.find((d) => d.date === '2026-11-22')!.total - 0.3 / 9) < 0.06).toBe(true);
  });

  it('điểm đặt hàng lại: tiêu thụ ngày × xu hướng ICD-10, tồn an toàn, đặt gợi ý, hàng sắp hết hạn; chỉ quản lý / kho dược', async () => {
    expect(await outcome(f.inventory(OB, C.pharm))).toBe('OK');
    expect(await outcome(f.load({ organizationId: OB }, C.pharm))).toBe('FORBIDDEN');
    await f.updateSettings({ organizationId: OB, fixedCostsMonthly: 0, variableCostPct: 0, leadTimeDays: 3, serviceLevelPct: 95 }, 0, C.admin);
    const inv = await f.inventory(OB, C.pharm);
    expect(inv.params).toMatchObject({ windowDays: 20, sufficient: true, leadTimeDays: 3, z: 1.6449, reviewDays: 14 });
    expect(inv.risingCodes.map((c) => [c.code, c.last7, c.prior21, c.ratio])).toEqual([['J06.9', 3, 6, 1.33]]);
    const by = Object.fromEntries(inv.lines.map((x) => [x.name, x]));
    // Y: 20/ngày, tồn 50 => đủ 2,5 ngày < thời gian chờ 3 ngày => khẩn; đặt = 20 × (3 + 14) − 50 = 290.
    expect(by['Thuốc Y']).toMatchObject({ available: 50, avgDaily: 20, trendFactor: 1, reorderPoint: 60, suggestedOrder: 290, daysOfCover: 2.5, status: 'urgent', estimatedOrderValue: 580_000 });
    // X: 10/ngày × 1,33 (J06.9 tăng) = 13,33; tồn 130 > ROP 40 => ổn; lô XA 100 viên hết hạn 25/11 chỉ dùng được ~67 => ~33 có thể hết hạn.
    expect(by['Thuốc X']).toMatchObject({ available: 130, avgDaily: 10, trendFactor: 1.33, adjustedDaily: 13.33, reorderPoint: 40, status: 'ok', earliestExpiry: '2026-11-25', expiryRiskQty: 33 });
    expect(by['Thuốc X']!.trendCodes).toEqual([{ code: 'J06.9', ratio: 1.33 }]);
    expect(by['Thuốc Z']).toMatchObject({ available: 10, avgDaily: 0, status: 'no_demand', suggestedOrder: 0 });
    expect(inv.lines.map((x) => x.status)).toEqual(['urgent', 'ok', 'no_demand']);
  });

  it('cơ sở dòng tiền: lượt dự báo 30 ngày, doanh thu / lượt từ chi phí đã ghi, tỷ trọng phí khám, chi phí cố định', async () => {
    const b = await f.cashflowBase(OA, C.admin);
    expect(b).toMatchObject({
      horizonDays: 30, revenuePerVisit: 240_000, revenueSample: 1, examShare: 1, avgExamPrice: 150_000, actualVisitsLast30: 32,
      actualRevenueLast30: 240_000, fixedCostsMonthly: 80_000_000, variableCostPct: 30,
    });
    expect(b.visits).toBeGreaterThan(30);
    expect(await outcome(f.cashflowBase(OA, C.staff))).toBe('FORBIDDEN');
  });
});

describe('reorderLine (thuần)', () => {
  it('σ > 0 => tồn an toàn = z × σ × √L', () => {
    const r = reorderLine({ available: 100, daily: [0, 20, 0, 20], trendFactor: 1, leadTimeDays: 4, z: 1.6449, reviewDays: 14 });
    expect([r.avgDaily, r.sigmaDaily, r.safetyStock, r.reorderPoint]).toEqual([10, 10, 33, 73]);
    expect(r.status).toBe('ok');
  });
});
