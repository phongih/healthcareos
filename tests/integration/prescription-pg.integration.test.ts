/**
 * HCOS-F5 | Kê đơn + cấp phát theo đơn trên PostgreSQL thật (migration 009): quyền, trạng thái, khớp sổ cái,
 * cấp đồng thời không vượt số kê, ràng buộc DB khi đi vòng service, RLS.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/prescription-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type ISODate, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { PgPrescriptionUnitOfWork, PrescriptionService } from '../../services/api/src/clinical/prescription.service';
import { PharmacyInventoryService, PgPharmacyUnitOfWork } from '../../services/api/src/pharmacy/inventory.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_rx_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const U = { doc: asUserId(uid(101)), doc2: asUserId(uid(102)), ds: asUserId(uid(103)), admin: asUserId(uid(104)), nurse: asUserId(uid(105)) };
const PERSON = uid(301);
const PAT = uid(401);
const ENC = uid(501);
const ENC2 = uid(502);
const EXP = '2028-12-31' as ISODate;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-rx' as CorrelationId,
  });
const C = {
  doc: ctx(TA, U.doc, [OA]), doc2: ctx(TA, U.doc2, [OA]), ds: ctx(TA, U.ds, [OA]), admin: ctx(TA, U.admin, [OA]), nurse: ctx(TA, U.nurse, [OA]),
};

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.doc}','${TA}','sub-${U.doc}','BS Một'),('${U.doc2}','${TA}','sub-${U.doc2}','BS Hai'),('${U.ds}','${TA}','sub-${U.ds}','DS'),
  ('${U.admin}','${TA}','sub-${U.admin}','Kho'),('${U.nurse}','${TA}','sub-${U.nurse}','DD');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.doc2}','${OA}','doctor'),('${TA}','${U.ds}','${OA}','pharmacist'),
  ('${TA}','${U.admin}','${OA}','pharmacy_admin'),('${TA}','${U.nurse}','${OA}','clinic_staff');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${PERSON}','${TA}','An','Nguyen');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT}','${TA}','${PERSON}','${OA}','MRN-RX');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class) VALUES
  ('${ENC}','${TA}','${PAT}','${OA}','${U.doc}','ambulatory'),('${ENC2}','${TA}','${PAT}','${OA}','${U.doc}','ambulatory');
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Kê đơn + cấp phát theo đơn / PostgreSQL', () => {
  let rx: PrescriptionService;
  let ph: PharmacyInventoryService;
  let para: string;
  let amox: string;
  let loc: string;
  const line = (medicationId: string, quantity: number) => ({ medicationId, doseQuantity: 1, doseUnit: 'viên', frequencyPerDay: 2, durationDays: 5, quantity, instructions: 'uống sau ăn' });

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    rx = new PrescriptionService({ uow: new PgPrescriptionUnitOfWork(pool), audit });
    ph = new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(pool), audit });
    para = (await ph.createMedication({ brandName: 'Paracetamol 500', strength: '500mg', form: 'viên nén', unitOfMeasure: 'viên' }, C.admin)).medicationId;
    amox = (await ph.createMedication({ brandName: 'Amoxicillin 500', strength: '500mg', form: 'viên nang', unitOfMeasure: 'viên' }, C.admin)).medicationId;
    loc = (await ph.createStockLocation({ organizationId: OA, name: 'Quầy', type: 'dispensary_counter' }, C.admin)).locationId;
    await ph.receiveStockOnce({ medicationId: para, locationId: loc, batchNumber: 'P1', expiryDate: EXP, unitCost: 300, quantity: 100 }, 'rcpt-rx-0001', C.admin);
    await ph.receiveStockOnce({ medicationId: amox, locationId: loc, batchNumber: 'A1', expiryDate: EXP, unitCost: 900, quantity: 100 }, 'rcpt-rx-0002', C.admin);
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('quyền kê đơn: chỉ bác sĩ phụ trách; dược sĩ / điều dưỡng / bác sĩ khác bị từ chối', async () => {
    const input = { encounterId: ENC, items: [line(para, 10)] };
    expect(await outcome(rx.createPrescription(input, C.ds))).toBe('FORBIDDEN');
    expect(await outcome(rx.createPrescription(input, C.nurse))).toBe('FORBIDDEN');
    expect(await outcome(rx.createPrescription(input, C.doc2))).toBe('FORBIDDEN');
    expect(su(`SELECT count(*) FROM clinical.prescriptions`)).toBe('0');
  });

  it('kiểm tra dữ liệu: thuốc trùng, số lượng sai, thuốc không có', async () => {
    expect(await outcome(rx.createPrescription({ encounterId: ENC, items: [line(para, 10), line(para, 5)] }, C.doc))).toBe('VALIDATION:DUPLICATE_MEDICATION');
    expect(await outcome(rx.createPrescription({ encounterId: ENC, items: [line(para, 0)] }, C.doc))).toBe('VALIDATION');
    expect(await outcome(rx.createPrescription({ encounterId: ENC, items: [line(uid(999), 1)] }, C.doc))).toBe('VALIDATION:MEDICATION_NOT_FOUND');
    expect(await outcome(rx.createPrescription({ encounterId: ENC, items: [] }, C.doc))).toBe('VALIDATION');
  });

  let rxId: string;
  let paraItem: string;
  let amoxItem: string;

  it('bác sĩ kê đơn 2 thuốc; dược sĩ thấy trong hàng đợi kèm MRN và tên bệnh nhân', async () => {
    const v = await rx.createPrescription({ encounterId: ENC, note: 'Tái khám sau 5 ngày', items: [line(para, 10), line(amox, 14)] }, C.doc);
    rxId = v.prescription.prescriptionId;
    paraItem = v.items.find((i) => i.medicationId === para)!.itemId;
    amoxItem = v.items.find((i) => i.medicationId === amox)!.itemId;
    expect(v.items.map((i) => i.lineNo)).toEqual([1, 2]);
    expect(v.prescriber.displayName).toBe('BS Một');
    const queue = await rx.listForOrganization({ organizationId: OA }, C.ds);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.patient).toMatchObject({ mrn: 'MRN-RX', givenName: 'An', familyName: 'Nguyen' });
    expect(queue[0]!.items[0]!.medication.brandName).toBe('Paracetamol 500');
    expect(await outcome(rx.listForOrganization({ organizationId: OA }, C.nurse))).toBe('FORBIDDEN');
    expect((await rx.listForEncounter(ENC, C.doc))[0]!.prescription.note).toBe('Tái khám sau 5 ngày');
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action='prescription.create' AND outcome='success'`)).toBe('1');
  });

  it('cấp theo đơn: sai thuốc / vượt số kê bị từ chối; cấp từng phần rồi đủ => đơn completed', async () => {
    const d = (medicationId: string, item: string, quantity: number, key: string) =>
      ph.dispenseMedicationOnce({ medicationId, locationId: loc, encounterId: ENC, quantity, prescriptionItemId: item }, key, C.ds);
    expect(await outcome(d(amox, paraItem, 1, 'rx-disp-wrong-01'))).toBe('VALIDATION:PRESCRIPTION_MISMATCH');
    expect(await outcome(d(para, paraItem, 11, 'rx-disp-over-001'))).toBe('CONFLICT:EXCEEDS_PRESCRIPTION');
    const a = await d(para, paraItem, 6, 'rx-disp-part-001');
    expect(a.value.prescriptionStatus).toBe('active');
    await d(para, paraItem, 4, 'rx-disp-part-002');
    expect(await outcome(d(para, paraItem, 1, 'rx-disp-over-002'))).toBe('CONFLICT:EXCEEDS_PRESCRIPTION');
    const last = await d(amox, amoxItem, 14, 'rx-disp-amox-01');
    expect(last.value.prescriptionStatus).toBe('completed');
    // Gửi lại cùng khoá: không cộng lần hai.
    expect((await d(amox, amoxItem, 14, 'rx-disp-amox-01')).replayed).toBe(true);
    expect(su(`SELECT status FROM clinical.prescriptions WHERE prescription_id='${rxId}'`)).toBe('completed');
    expect(su(`SELECT string_agg(quantity_dispensed::text, ',' ORDER BY line_no) FROM clinical.prescription_items WHERE prescription_id='${rxId}'`)).toBe('10,14');
    expect(su(`SELECT sum(quantity) FROM pharmacy.stock_movements WHERE prescription_item_id='${paraItem}'`)).toBe('10');
    // Đơn đã xong: không cấp thêm, không huỷ được, không còn trong hàng đợi.
    expect(await outcome(d(para, paraItem, 1, 'rx-disp-after-01'))).toBe('CONFLICT:PRESCRIPTION_NOT_ACTIVE');
    expect(await rx.listForOrganization({ organizationId: OA }, C.ds)).toHaveLength(0);
    expect(await rx.listForOrganization({ organizationId: OA, status: 'completed' }, C.ds)).toHaveLength(1);
  });

  it('cấp ĐỒNG THỜI cùng một dòng đơn (khoá khác nhau): tổng không vượt số kê', async () => {
    const v = await rx.createPrescription({ encounterId: ENC2, items: [line(para, 10)] }, C.doc);
    const item = v.items[0]!.itemId;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        outcome(ph.dispenseMedicationOnce({ medicationId: para, locationId: loc, encounterId: ENC2, quantity: 4, prescriptionItemId: item }, `rx-conc-${i}-0000`, C.ds)),
      ),
    );
    expect(results.filter((r) => r === 'OK')).toHaveLength(2);
    expect(su(`SELECT quantity_dispensed FROM clinical.prescription_items WHERE item_id='${item}'`)).toBe('8');
    expect(su(`SELECT sum(quantity) FROM pharmacy.stock_movements WHERE prescription_item_id='${item}'`)).toBe('8');
  });

  it('huỷ đơn: chỉ người kê, chỉ khi chưa cấp gì, phải đúng version', async () => {
    const v = await rx.createPrescription({ encounterId: ENC2, items: [line(amox, 5)] }, C.doc);
    const id = v.prescription.prescriptionId;
    expect(await outcome(rx.cancelPrescription(id, 1, C.doc2))).toBe('FORBIDDEN');
    expect(await outcome(rx.cancelPrescription(id, 7, C.doc))).toBe('ERR'); // VersionConflictError (412 qua HTTP)
    const c = await rx.cancelPrescription(id, 1, C.doc);
    expect(c.status).toBe('cancelled');
    expect(await outcome(ph.dispenseMedicationOnce({ medicationId: amox, locationId: loc, encounterId: ENC2, quantity: 1, prescriptionItemId: v.items[0]!.itemId }, 'rx-disp-cancel-1', C.ds)))
      .toBe('CONFLICT:PRESCRIPTION_NOT_ACTIVE');
    // Đơn đã cấp một phần thì không huỷ được.
    const partial = (await rx.listForOrganization({ organizationId: OA }, C.ds)).find((p) => p.items.some((i) => i.quantityDispensed > 0))!;
    expect(await outcome(rx.cancelPrescription(partial.prescription.prescriptionId, partial.prescription.version, C.doc))).toBe('CONFLICT:ALREADY_DISPENSED');
  });

  it('đợt khám đã đóng: không kê đơn mới', async () => {
    su(`UPDATE clinical.encounters SET status='finished', period_end=now() WHERE encounter_id='${ENC}'`);
    expect(await outcome(rx.createPrescription({ encounterId: ENC, items: [line(para, 1)] }, C.doc))).toBe('INVALID_STATE:ENCOUNTER_NOT_OPEN');
  });

  it('DB chặn khi đi vòng service: sửa nội dung, giảm số đã cấp, lệch sổ cái, xoá, khác tenant', async () => {
    const c = new PsqlClient({ database: DB });
    // Mỗi câu lệnh tự commit: constraint trigger hoãn chạy ở cuối chính câu lệnh đó.
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`UPDATE clinical.prescription_items SET quantity_prescribed = 99 WHERE item_id='${paraItem}'`)).toBe('42501');
      expect(await code(`UPDATE clinical.prescriptions SET note = 'x' WHERE prescription_id='${rxId}'`)).toBe('42501');
      expect(await code(`UPDATE clinical.prescriptions SET status = 'active' WHERE prescription_id='${rxId}'`)).toBe('55000');
      expect(await code(`DELETE FROM clinical.prescriptions WHERE prescription_id='${rxId}'`)).toBe('42501');
      // Cộng "đã cấp" mà không có sổ cái => lỗi khi COMMIT (constraint trigger hoãn).
      const open = su(`SELECT i.item_id FROM clinical.prescription_items i JOIN clinical.prescriptions p USING (prescription_id) WHERE p.status='active' AND i.quantity_dispensed < i.quantity_prescribed LIMIT 1`);
      expect(await code(`UPDATE clinical.prescription_items SET quantity_dispensed = quantity_dispensed + 1 WHERE item_id='${open}'`)).toBe('23514');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query(`SELECT 1 FROM clinical.prescriptions`)).rows).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
