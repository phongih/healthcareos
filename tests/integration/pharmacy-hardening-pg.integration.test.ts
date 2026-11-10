/**
 * HCOS-P0-ENG-001 | S3 | Hardening trên PostgreSQL thật: nhập/xuất song song, FK ghép tenant,
 * khớp sổ cái, lô bất biến, phân quyền và audit.
 *
 * Chạy: HCOS_IT=1 PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres vitest run tests/integration/pharmacy-hardening-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId,
  asPatientId,
  asPersonId,
  asTenantId,
  asUserId,
  type CorrelationId,
  type ISODate,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantId,
  type UserId,
} from '../../packages/domain/src/s0-contracts';
import { asEncounterId } from '../../packages/domain/src/s1-contracts';
import {
  PharmacyInventoryService,
  PgPharmacyUnitOfWork,
} from '../../services/api/src/pharmacy/inventory.service';
import { withTenantTransaction } from '../../packages/security/src/tenant-context';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_pharmacy_hard_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));
const U = { pharmA: asUserId(uid(101)), pharmB: asUserId(uid(201)), docA: asUserId(uid(102)) };
const PA = asPersonId(uid(301));
const PB = asPersonId(uid(302));
const PAT_A = asPatientId(uid(401));
const PAT_B = asPatientId(uid(402));
const ENC_A = asEncounterId(uid(501));
const ENC_B = asEncounterId(uid(502));

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[], roles: Role[]): TenantContext =>
  Object.freeze({
    tenantId: t,
    userSubject: `sub-${u}`,
    userId: u,
    personId: null,
    activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]),
    roles: Object.freeze([...roles]),
    tokenId: null,
    correlationId: 'it-pharmacy-hard-corr' as CorrelationId,
  });

const su = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) =>
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id, code, name) VALUES ('${TA}', 'ta', 'Tenant A'), ('${TB}', 'tb', 'Tenant B');
INSERT INTO iam.organizations(organization_id, tenant_id, type, code, name) VALUES
  ('${OA}', '${TA}', 'clinic', 'cA', 'Clinic A'),
  ('${OB}', '${TB}', 'clinic', 'cB', 'Clinic B');
INSERT INTO iam.users(user_id, tenant_id, external_subject, display_name) VALUES
  ('${U.pharmA}', '${TA}', 'sub-${U.pharmA}', 'Pharmacist A'),
  ('${U.docA}', '${TA}', 'sub-${U.docA}', 'Doctor A'),
  ('${U.pharmB}', '${TB}', 'sub-${U.pharmB}', 'Pharmacist B');
INSERT INTO iam.memberships(tenant_id, user_id, organization_id, role) VALUES
  ('${TA}', '${U.pharmA}', '${OA}', 'pharmacist'),
  ('${TA}', '${U.docA}', '${OA}', 'doctor'),
  ('${TB}', '${U.pharmB}', '${OB}', 'pharmacist');
INSERT INTO patient.persons(person_id, tenant_id, given_name, family_name) VALUES
  ('${PA}', '${TA}', 'Hoa', 'Pham'), ('${PB}', '${TB}', 'Nam', 'Vu');
INSERT INTO patient.patients(patient_id, tenant_id, person_id, organization_id, mrn) VALUES
  ('${PAT_A}', '${TA}', '${PA}', '${OA}', 'MRN-A1'), ('${PAT_B}', '${TB}', '${PB}', '${OB}', 'MRN-B1');
INSERT INTO clinical.encounters(encounter_id, tenant_id, patient_id, organization_id, practitioner_user_id, encounter_class, reason_text) VALUES
  ('${ENC_A}', '${TA}', '${PAT_A}', '${OA}', '${U.pharmA}', 'ambulatory', 'A'),
  ('${ENC_B}', '${TB}', '${PAT_B}', '${OB}', '${U.pharmB}', 'ambulatory', 'B');
`;

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Pharmacy hardening / PostgreSQL', () => {
  let pool: ReturnType<typeof psqlPool>;
  let svc: PharmacyInventoryService;
  const ctxA = ctx(TA, U.pharmA, [OA], ['pharmacist']);
  const ctxAdminA = ctx(TA, U.pharmA, [OA], ['pharmacy_admin']);
  const ctxDocA = ctx(TA, U.docA, [OA], ['doctor']);
  const ctxB = ctx(TB, U.pharmB, [OB], ['pharmacist']);

  let medId: string;
  let locId: string;
  let medB: string;
  let locB: string;
  const EXP = '2027-12-31' as ISODate;

  const onHand = () =>
    Number(su(`SELECT COALESCE(SUM(quantity_on_hand),0) FROM pharmacy.inventory_balances WHERE location_id='${locId}'`));
  const ledger = () =>
    Number(
      su(`SELECT COALESCE(SUM(CASE WHEN destination_location_id='${locId}' THEN quantity ELSE 0 END) -
                          SUM(CASE WHEN source_location_id='${locId}' THEN quantity ELSE 0 END),0)
            FROM pharmacy.stock_movements`),
    );

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    pool = psqlPool({ database: DB });
    svc = new PharmacyInventoryService({
      uow: new PgPharmacyUnitOfWork(pool),
      audit: { record: async () => {} },
    });

    const med = await svc.createMedication({ brandName: 'Hapacol', strength: '500mg', form: 'tablet', unitOfMeasure: 'viên' }, ctxA);
    medId = med.medicationId;
    const loc = await svc.createStockLocation({ organizationId: OA, name: 'Kho A', type: 'main_warehouse' }, ctxAdminA);
    locId = loc.locationId;
    const medBb = await svc.createMedication({ brandName: 'B-Med', strength: '1g', form: 'tablet', unitOfMeasure: 'viên' }, ctxB);
    medB = medBb.medicationId;
    const locBb = await svc.createStockLocation({ organizationId: OB, name: 'Kho B', type: 'main_warehouse' }, ctx(TB, U.pharmB, [OB], ['pharmacy_admin']));
    locB = locBb.locationId;
  });

  afterAll(() => {
    try {
      su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres');
    } catch {
      /* best effort */
    }
  });

  const receive = (qty: number, batch = 'LOT-1') =>
    svc.receiveStock(
      { medicationId: medId, locationId: locId, batchNumber: batch, expiryDate: EXP, unitCost: 1000, quantity: qty },
      ctxA,
    );
  const dispense = (qty: number) =>
    svc.dispenseMedication({ medicationId: medId, locationId: locId, quantity: qty, encounterId: ENC_A }, ctxA);

  it('nhập và xuất chạy song song: tồn kho luôn bằng sổ cái (không mất cập nhật)', async () => {
    await receive(100); // tạo lô; 20 lần nhập kế tiếp tranh nhau cùng dòng tồn
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) jobs.push(receive(5));
    for (let i = 0; i < 10; i++) jobs.push(dispense(3));
    const res = await Promise.allSettled(jobs);
    const failed = res.filter((r) => r.status === 'rejected');
    expect(failed).toHaveLength(0);
    expect(onHand()).toBe(100 + 20 * 5 - 10 * 3);
    expect(ledger()).toBe(onHand());
  });

  it('nhiều lần nhập đồng thời cùng một số lô MỚI: chỉ tạo một lô, không lỗi 500', async () => {
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => receive(2, 'LOT-RACE')));
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(su(`SELECT count(*) FROM pharmacy.batches WHERE batch_number='LOT-RACE'`)).toBe('1');
    expect(ledger()).toBe(onHand());
  });

  it('xuất thuốc gắn lượt khám của tenant khác bị từ chối và hoàn tác toàn bộ', async () => {
    const before = onHand();
    await expect(
      svc.dispenseMedication({ medicationId: medId, locationId: locId, quantity: 1, encounterId: ENC_B }, ctxA),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'REFERENCE_NOT_FOUND' } });
    expect(onHand()).toBe(before);
    expect(ledger()).toBe(before);
  });

  it('tenant B không thể ghi sổ cái trỏ vào lô/kho của tenant A (FK ghép)', async () => {
    const batchA = su(`SELECT batch_id FROM pharmacy.batches WHERE batch_number='LOT-1'`);
    await expect(
      withTenantTransaction(pool, (db) =>
        db.query(
          `INSERT INTO pharmacy.stock_movements(tenant_id, batch_id, quantity, movement_type, destination_location_id)
           VALUES ($1, $2, 1, 'receipt', $3)`,
          [TB, batchA, locId],
        ),
      ctxB),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('sổ cái bị chặn khi sai hình dạng (dispense không có kho nguồn)', async () => {
    const batchA = su(`SELECT batch_id FROM pharmacy.batches WHERE batch_number='LOT-1'`);
    await expect(
      withTenantTransaction(pool, (db) =>
        db.query(
          `INSERT INTO pharmacy.stock_movements(tenant_id, batch_id, quantity, movement_type, encounter_id)
           VALUES ($1, $2, 1, 'dispense', $3)`,
          [TA, batchA, ENC_A],
        ),
      ctxA),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('sửa thẳng tồn kho không có dòng sổ cái bị từ chối lúc COMMIT', async () => {
    const before = onHand();
    await expect(
      withTenantTransaction(pool, (db) =>
        db.query(`UPDATE pharmacy.inventory_balances SET quantity_on_hand = quantity_on_hand + 1000 WHERE location_id = $1`, [locId]),
      ctxA),
    ).rejects.toMatchObject({ code: '23514' });
    expect(onHand()).toBe(before);
  });

  it('ghi sổ cái mà không đổi tồn kho cũng bị từ chối lúc COMMIT', async () => {
    const batchA = su(`SELECT batch_id FROM pharmacy.batches WHERE batch_number='LOT-1'`);
    await expect(
      withTenantTransaction(pool, (db) =>
        db.query(
          `INSERT INTO pharmacy.stock_movements(tenant_id, batch_id, quantity, movement_type, destination_location_id)
           VALUES ($1, $2, 7, 'receipt', $3)`,
          [TA, batchA, locId],
        ),
      ctxA),
    ).rejects.toMatchObject({ code: '23514' });
    expect(ledger()).toBe(onHand());
  });

  it('lô bất biến: role app không sửa được hạn dùng', async () => {
    await expect(
      withTenantTransaction(pool, (db) => db.query(`UPDATE pharmacy.batches SET expiry_date = expiry_date + 3650`), ctxA),
    ).rejects.toMatchObject({ code: '42501' });
    // owner/superuser cũng bị trigger chặn
    let err = '';
    try {
      su(`UPDATE pharmacy.batches SET expiry_date = expiry_date + 1`);
    } catch (e) {
      err = String((e as { stderr?: unknown }).stderr ?? e);
    }
    expect(/immutable/.test(err)).toBe(true);
  });

  it('nhập lô đã có với hạn dùng khác bị CONFLICT, không đổi tồn kho', async () => {
    const before = onHand();
    await expect(
      svc.receiveStock(
        { medicationId: medId, locationId: locId, batchNumber: 'LOT-1', expiryDate: '2030-01-01' as ISODate, unitCost: 1000, quantity: 5 },
        ctxA,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(onHand()).toBe(before);
  });

  it('phân quyền: bác sĩ không nhập/xuất kho; tenant B không dùng được kho của A', async () => {
    await expect(
      svc.receiveStock({ medicationId: medId, locationId: locId, batchNumber: 'X', expiryDate: EXP, unitCost: 1, quantity: 1 }, ctxDocA),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      svc.receiveStock({ medicationId: medId, locationId: locId, batchNumber: 'X', expiryDate: EXP, unitCost: 1, quantity: 1 }, ctxB),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(medB && locB).toBeTruthy();
  });

  it('audit thành công nằm trong giao dịch và có người thực hiện trong sổ cái', async () => {
    const n = Number(su(`SELECT count(*) FROM platform.audit_events WHERE action='pharmacy.stock.receive' AND outcome='success'`));
    expect(n >= 29).toBe(true); // 1 + 20 + 8 lần nhập thành công ở trên
    expect(su(`SELECT count(*) FROM pharmacy.stock_movements WHERE performed_by IS NULL`)).toBe('0');
  });
});
