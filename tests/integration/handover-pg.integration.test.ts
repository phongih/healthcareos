/**
 * HCOS-F14 | Quầy trả trên PostgreSQL thật (migration 017): BS kết thúc khám => tự có phiếu trả giữ số cũ,
 * dược sĩ soạn xong, quầy gọi số (ưu tiên, mỗi quầy một số), gọi lại / vắng / đưa lại hàng chờ,
 * hoàn tất chỉ khi đã giao thuốc + số dư thanh toán = 0 (đóng hồ sơ thanh toán cùng lúc), màn hình TV không lộ dữ liệu, ràng buộc DB.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/handover-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type ISODate, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { asEncounterId } from '../../packages/domain/src/s1-contracts';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../../services/api/src/clinical/encounter.service';
import { HandoverService } from '../../services/api/src/clinical/handover.service';
import { PgPrescriptionUnitOfWork, PrescriptionService } from '../../services/api/src/clinical/prescription.service';
import { PgQueueBoard, PgQueueUnitOfWork, QueueService } from '../../services/api/src/clinical/queue.service';
import { FinanceService, PgFinanceUnitOfWork } from '../../services/api/src/finance/finance.service';
import { PgPharmacyUnitOfWork, PharmacyInventoryService } from '../../services/api/src/pharmacy/inventory.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_handover_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const U = {
  doc: asUserId(uid(101)), ds: asUserId(uid(102)), desk1: asUserId(uid(103)), desk2: asUserId(uid(104)), admin: asUserId(uid(105)), kho: asUserId(uid(106)),
};
const PAT = (i: number) => uid(1000 + i);
const ENC_WALKIN = uid(5001);
const EXP = '2028-12-31' as ISODate;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-handover' as CorrelationId,
  });
const C = Object.fromEntries(Object.entries(U).map(([k, v]) => [k, ctx(TA, v, [OA])])) as Record<keyof typeof U, TenantContext>;

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','Phòng khám A');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.doc}','${TA}','sub-${U.doc}','BS Một'),('${U.ds}','${TA}','sub-${U.ds}','DS Soạn'),('${U.desk1}','${TA}','sub-${U.desk1}','Quầy Một'),
  ('${U.desk2}','${TA}','sub-${U.desk2}','Quầy Hai'),('${U.admin}','${TA}','sub-${U.admin}','Quản lý'),('${U.kho}','${TA}','sub-${U.kho}','Thủ kho');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.ds}','${OA}','pharmacist'),
  ('${TA}','${U.desk1}','${OA}','pharmacist'),('${TA}','${U.desk1}','${OA}','cashier'),
  ('${TA}','${U.desk2}','${OA}','clinic_staff'),('${TA}','${U.admin}','${OA}','clinic_admin'),('${TA}','${U.kho}','${OA}','pharmacy_admin');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${TA}', 'Bệnh nhân ' || g, 'Thử' FROM generate_series(1, 4) g;
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(1000 + g), 12, '0'))::uuid, '${TA}',
         ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${OA}', 'H' || lpad(g::text, 4, '0')
    FROM generate_series(1, 4) g;
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class) VALUES
  ('${ENC_WALKIN}','${TA}','${PAT(2)}','${OA}','${U.doc}','ambulatory');
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Quầy trả / PostgreSQL', () => {
  let h: HandoverService;
  let q: QueueService;
  let clin: ClinicalEncounterService;
  let rx: PrescriptionService;
  let ph: PharmacyInventoryService;
  let fin: FinanceService;
  let board: PgQueueBoard;
  let q1: string;
  let q2: string;
  let enc1: string;
  let item: string;
  let para: string;
  let loc: string;

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    h = new HandoverService({ pool, audit });
    q = new QueueService({ uow: new PgQueueUnitOfWork(pool), audit });
    clin = new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit });
    rx = new PrescriptionService({ uow: new PgPrescriptionUnitOfWork(pool), audit });
    ph = new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(pool), audit });
    fin = new FinanceService({ uow: new PgFinanceUnitOfWork(pool), audit });
    board = new PgQueueBoard(pool);
    para = (await ph.createMedication({ brandName: 'Paracetamol 500', strength: '500mg', form: 'viên nén', unitOfMeasure: 'viên' }, C.kho)).medicationId;
    loc = (await ph.createStockLocation({ organizationId: OA, name: 'Quầy', type: 'dispensary_counter' }, C.kho)).locationId;
    await ph.receiveStockOnce({ medicationId: para, locationId: loc, batchNumber: 'P1', expiryDate: EXP, unitCost: 300, quantity: 100 }, 'rcpt-ho-0001', C.kho);
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('quầy: chỉ quản lý tạo / tạm ngưng; mã trùng => CONFLICT', async () => {
    expect(await outcome(h.createDesk({ organizationId: OA, code: 'Q1', name: 'Quầy 1' }, C.desk2))).toBe('FORBIDDEN');
    q1 = (await h.createDesk({ organizationId: OA, code: 'q1', name: 'Quầy trả 1' }, C.admin)).deskId;
    q2 = (await h.createDesk({ organizationId: OA, code: 'Q2', name: 'Quầy trả 2' }, C.admin)).deskId;
    expect(await outcome(h.createDesk({ organizationId: OA, code: 'Q1', name: 'Trùng' }, C.admin))).toBe('CONFLICT:DESK_CODE_TAKEN');
    expect((await h.listDesks(OA, C.desk1)).map((d) => d.code)).toEqual(['Q1', 'Q2']);
    expect(await outcome(h.listDesks(OA, C.doc))).toBe('FORBIDDEN');
  });

  it('BS kết thúc khám => tự có phiếu trả: giữ số hàng đợi (N1-001, đang soạn thuốc); khám không qua hàng đợi => R-001 (sẵn sàng)', async () => {
    const sp = (await q.createServicePoint({ organizationId: OA, code: 'N1', name: 'Nội 1' }, C.admin)).servicePointId;
    const t = await q.issueTicket({ servicePointId: sp, patientId: PAT(1), priorityReason: 'elderly_75' }, C.desk2);
    await q.callNext(sp, C.doc);
    enc1 = (await q.startTicket(t.ticketId, {}, C.doc)).encounterId;
    const p = await rx.createPrescription({ encounterId: enc1, items: [{ medicationId: para, doseQuantity: 1, doseUnit: 'viên', frequencyPerDay: 2, durationDays: 5, quantity: 10 }] }, C.doc);
    item = p.items[0]!.itemId;
    expect(su(`SELECT count(*) FROM clinical.handover_tickets`)).toBe('0');
    await clin.closeEncounter(asEncounterId(enc1), 1, C.doc);
    await clin.closeEncounter(asEncounterId(ENC_WALKIN), 1, C.doc);

    const list = await h.listToday({ organizationId: OA }, C.desk1);
    expect(list.map((x) => `${x.displayNo}:${x.status}:${x.needsMedication}`)).toEqual(['R-001:ready:false', 'N1-001:preparing:true']);
    const n1 = list.find((x) => x.displayNo === 'N1-001')!;
    expect(n1.priorityRank).toBe(1);
    expect(n1.patient).toMatchObject({ mrn: 'H0001', givenName: 'Bệnh nhân 1' });
    expect(n1.practitionerName).toBe('BS Một');
    expect(n1.medications).toHaveLength(1);
    expect(n1.medications[0]).toMatchObject({ brandName: 'Paracetamol 500', prescribed: 10, dispensed: 0 });
    expect(n1.medications[0]!.usage).toBe('1 viên × 2 lần/ngày × 5 ngày');
    expect(n1.finance).toBeNull();
  });

  it('dược sĩ soạn xong: còn thuốc chưa cấp thì phải ghi lý do; lễ tân không được bấm', async () => {
    const n1 = (await h.listToday({ organizationId: OA }, C.ds)).find((x) => x.displayNo === 'N1-001')!;
    expect(await outcome(h.markPrepared(n1.handoverId, {}, C.desk2))).toBe('FORBIDDEN');
    expect(await outcome(h.markPrepared(n1.handoverId, {}, C.ds))).toBe('INVALID_STATE:MEDICATION_NOT_DISPENSED');
    await ph.dispenseMedicationOnce({ medicationId: para, locationId: loc, encounterId: enc1, quantity: 10, prescriptionItemId: item }, 'ho-disp-00001', C.ds);
    const v = await h.markPrepared(n1.handoverId, {}, C.ds);
    expect(v.status).toBe('ready');
    expect(v.preparedByName).toBe('DS Soạn');
    expect(v.medications[0]!.dispensed).toBe(10);
    expect(await outcome(h.markPrepared(n1.handoverId, {}, C.ds))).toBe('INVALID_STATE:HANDOVER_STATE');
  });

  let n1Id: string;
  let r1Id: string;

  it('gọi ra quầy: ưu tiên trước; mỗi quầy một số; bác sĩ không gọi được; hết số => null', async () => {
    expect(await outcome(h.callNext(q1, C.doc))).toBe('FORBIDDEN');
    const a = await h.callNext(q1, C.desk1);
    expect(a?.displayNo).toBe('N1-001'); // ưu tiên người cao tuổi dù sẵn sàng sau
    expect(a?.desk?.code).toBe('Q1');
    n1Id = a!.handoverId;
    expect(await outcome(h.callNext(q1, C.desk1))).toBe('INVALID_STATE:DESK_BUSY');
    const b = await h.callNext(q2, C.desk2);
    expect(b?.displayNo).toBe('R-001');
    r1Id = b!.handoverId;
  });

  it('gọi lại / vắng / đưa lại hàng chờ / trả về hàng chờ: chỉ người đã gọi', async () => {
    expect(await outcome(h.recall(r1Id, C.desk1))).toBe('INVALID_STATE:CALLED_BY_OTHER');
    expect((await h.recall(r1Id, C.desk2)).calledCount).toBe(2);
    expect((await h.skip(r1Id, C.desk2)).status).toBe('skipped');
    expect(await h.callNext(q2, C.desk2)).toBeNull();
    expect((await h.requeue(r1Id, C.desk2)).status).toBe('ready');
    expect((await h.callNext(q2, C.desk2))?.handoverId).toBe(r1Id);
    const rel = await h.release(r1Id, C.desk2);
    expect(rel.status).toBe('ready');
    expect(rel.desk).toBeNull();
    expect((await h.callNext(q2, C.desk2))?.calledCount).toBe(4);
  });

  it('hoàn tất: phải xác nhận giao thuốc; số dư ≠ 0 bị chặn; hoàn ứng xong => hoàn tất + đóng hồ sơ thanh toán', async () => {
    await fin.openShift({ organizationId: OA, openingFloat: 0 }, C.desk1);
    const kham = await fin.createPriceItem({ organizationId: OA, code: 'KB', name: 'Khám bệnh', category: 'exam', unitPrice: 150_000 }, C.admin);
    const dep = await fin.createReceipt({ organizationId: OA, patientId: PAT(1), kind: 'deposit', method: 'cash', amount: 500_000 }, 'ho-dep-000001', C.desk1);
    const caseId = dep.value.case.caseId;
    await fin.addCharge(caseId, { itemId: kham.itemId, quantity: 1 }, C.desk1);

    const v = await h.get(n1Id, C.desk1);
    expect(v.finance).toMatchObject({ caseId, balance: 350_000, charges: 150_000, received: 500_000 });

    expect(await outcome(h.complete(n1Id, { checklist: { documents: 'returned' } }, C.desk1))).toBe('INVALID_STATE:MEDICATION_NOT_HANDED');
    expect(await outcome(h.complete(n1Id, { checklist: { medication: true, documents: 'maybe' } }, C.desk1))).toBe('VALIDATION');
    expect(await outcome(h.complete(n1Id, { checklist: { medication: true, documents: 'returned' } }, C.desk1))).toBe('INVALID_STATE:BALANCE_NOT_SETTLED');
    expect(await outcome(h.complete(n1Id, { checklist: { medication: true, documents: 'returned' } }, C.desk2))).toBe('INVALID_STATE:CALLED_BY_OTHER');

    await fin.createReceipt({ organizationId: OA, caseId, kind: 'refund', method: 'cash', amount: 350_000 }, 'ho-ref-000001', C.desk1);
    const done = await h.complete(n1Id, { checklist: { medication: true, documents: 'returned' }, note: 'Đã dặn tái khám' }, C.desk1);
    expect(done.status).toBe('done');
    expect(done.checklist).toEqual({ medication: true, documents: 'returned' });
    expect(done.completedByName).toBe('Quầy Một');
    expect(done.finance).toBeNull();
    expect(su(`SELECT status || '|' || closed_by FROM finance.billing_cases WHERE case_id='${caseId}'`)).toBe(`closed|${U.desk1}`);
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action='handover.complete' AND outcome='success'`)).toBe('1');

    // Không đơn thuốc, không hồ sơ thanh toán => chỉ cần xác nhận giấy tờ.
    const r = await h.complete(r1Id, { checklist: { documents: 'none' } }, C.desk2);
    expect(r.checklist).toEqual({ medication: null, documents: 'none' });
    // Danh sách mặc định không còn số đã xong; includeDone => có.
    expect(await h.listToday({ organizationId: OA }, C.desk1)).toHaveLength(0);
    expect(await h.listToday({ organizationId: OA, includeDone: true }, C.desk1)).toHaveLength(2);
  });

  it('huỷ cần lý do; không huỷ số đang gọi / đã xong', async () => {
    const enc = (await clin.createEncounter({ patientId: PAT(3), organizationId: OA, encounterClass: 'ambulatory' } as never, C.doc)).encounterId;
    await clin.closeEncounter(enc, 1, C.doc);
    const t = (await h.listToday({ organizationId: OA }, C.desk2))[0]!;
    expect(t.displayNo).toBe('R-002');
    expect(await outcome(h.cancel(t.handoverId, {}, C.desk2))).toBe('VALIDATION:REASON_REQUIRED');
    expect((await h.cancel(t.handoverId, { note: 'Bệnh nhân về trước' }, C.desk2)).status).toBe('cancelled');
    expect(await outcome(h.cancel(n1Id, { note: 'thử huỷ số đã xong' }, C.desk2))).toBe('INVALID_STATE:HANDOVER_STATE');
  });

  it('đợt khám cũ (bắt đầu trước 24 giờ) / khám từ xa: đóng không tạo phiếu trả', async () => {
    su(`INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class,period_start) VALUES
      ('${uid(5002)}','${TA}','${PAT(4)}','${OA}','${U.doc}','ambulatory', now() - interval '2 days'),
      ('${uid(5003)}','${TA}','${PAT(4)}','${OA}','${U.doc}','virtual', now())`);
    await clin.closeEncounter(asEncounterId(uid(5002)), 1, C.doc);
    await clin.closeEncounter(asEncounterId(uid(5003)), 1, C.doc);
    expect(su(`SELECT count(*) FROM clinical.handover_tickets WHERE encounter_id IN ('${uid(5002)}', '${uid(5003)}')`)).toBe('0');
  });

  it('màn hình TV: có số đang gọi ra quầy / chờ / đang soạn, không có tên hay MRN', async () => {
    const enc = (await clin.createEncounter({ patientId: PAT(4), organizationId: OA, encounterClass: 'ambulatory' } as never, C.doc)).encounterId;
    await clin.closeEncounter(enc, 1, C.doc);
    const { key } = await q.createDisplay({ organizationId: OA, name: 'Sảnh' }, C.admin);
    const b0 = await board.read(key);
    expect(b0?.handover.map((x) => `${x.kind}:${x.displayNo}`)).toEqual(['ready:R-003']);
    const called = await h.callNext(q1, C.desk1);
    const b = await board.read(key);
    expect(b?.handover).toHaveLength(1);
    expect(b?.handover[0]).toMatchObject({ kind: 'called', displayNo: 'R-003', deskCode: 'Q1', deskName: 'Quầy trả 1', calledCount: 1 });
    expect(JSON.stringify(b)).not.toMatch(/H000|Bệnh nhân|Thử/);
    await h.release(called!.handoverId, C.desk1);
  });

  it('DB chặn khi đi vòng service: chuyển trạng thái sai, sửa nội dung, hai số cùng quầy, xoá; RLS theo tenant', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const ready = su(`SELECT handover_id FROM clinical.handover_tickets WHERE status='ready' LIMIT 1`);
      expect(await code(`UPDATE clinical.handover_tickets SET status='done' WHERE handover_id='${ready}'`)).toBe('55000');
      expect(await code(`UPDATE clinical.handover_tickets SET display_no='X-999' WHERE handover_id='${ready}'`)).toBe('42501');
      expect(await code(`UPDATE clinical.handover_tickets SET status='ready' WHERE handover_id='${n1Id}'`)).toBe('55000');
      // Gọi đi vòng: thiếu quầy => vi phạm CHECK.
      expect(await code(`UPDATE clinical.handover_tickets SET status='called', called_count = called_count + 1 WHERE handover_id='${ready}'`)).toBe('23514');
      // Quầy 1 đang rảnh; gọi một số khác vào Quầy 1 rồi thử gọi số thứ hai => unique.
      await h.callNext(q1, C.desk1);
      const other = await (async () => {
        const enc = (await clin.createEncounter({ patientId: PAT(3), organizationId: OA, encounterClass: 'ambulatory' } as never, C.doc)).encounterId;
        await clin.closeEncounter(enc, 1, C.doc);
        return su(`SELECT handover_id FROM clinical.handover_tickets WHERE status='ready' LIMIT 1`);
      })();
      expect(await code(`UPDATE clinical.handover_tickets SET status='called', desk_id='${q1}', called_by='${U.desk1}', called_at=now(), called_count=1 WHERE handover_id='${other}'`)).toBe('23505');
      expect(await code(`DELETE FROM clinical.handover_tickets WHERE handover_id='${other}'`)).toBe('42501');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query(`SELECT 1 FROM clinical.handover_tickets`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT 1 FROM clinical.handover_desks`)).rows).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
