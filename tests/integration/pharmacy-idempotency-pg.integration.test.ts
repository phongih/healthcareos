/**
 * HCOS-P0-ENG-001 | S3 | Idempotency trên PostgreSQL thật (migration 008): gửi trùng ĐỒNG THỜI, lỗi không lưu khoá,
 * RLS, bất biến của bản ghi khoá.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/pharmacy-idempotency-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type ISODate, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { PharmacyInventoryService, PgPharmacyUnitOfWork } from '../../services/api/src/pharmacy/inventory.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_idem_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const U = { ds: asUserId(uid(101)), ds2: asUserId(uid(102)), admin: asUserId(uid(103)), doc: asUserId(uid(104)) };
const PERSON = uid(301);
const PAT = uid(401);
const ENC = uid(501);
const EXP = '2028-12-31' as ISODate;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-idem' as CorrelationId,
  });
const C = { ds: ctx(TA, U.ds, [OA]), ds2: ctx(TA, U.ds2, [OA]), admin: ctx(TA, U.admin, [OA]) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.ds}','${TA}','sub-${U.ds}','DS1'),('${U.ds2}','${TA}','sub-${U.ds2}','DS2'),('${U.admin}','${TA}','sub-${U.admin}','Admin'),('${U.doc}','${TA}','sub-${U.doc}','Doc');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.ds}','${OA}','pharmacist'),('${TA}','${U.ds2}','${OA}','pharmacist'),('${TA}','${U.admin}','${OA}','pharmacy_admin'),('${TA}','${U.doc}','${OA}','doctor');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${PERSON}','${TA}','An','Nguyen');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT}','${TA}','${PERSON}','${OA}','MRN-1');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class) VALUES
  ('${ENC}','${TA}','${PAT}','${OA}','${U.doc}','ambulatory');
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Idempotency nhập / cấp phát / PostgreSQL', () => {
  let svc: PharmacyInventoryService;
  let medId: string;
  let loc: string;
  const onHand = () => Number(su(`SELECT COALESCE(SUM(quantity_on_hand),0) FROM pharmacy.inventory_balances WHERE location_id='${loc}'`));
  const dispenses = () => Number(su(`SELECT count(*) FROM pharmacy.stock_movements WHERE movement_type='dispense'`));
  const dispense = (quantity: number) => ({ medicationId: medId, locationId: loc, encounterId: ENC, quantity });

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    svc = new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(psqlPool({ database: DB })), audit: { record: async () => {} } });
    medId = (await svc.createMedication({ brandName: 'Hapacol', strength: '500mg', form: 'tablet', unitOfMeasure: 'viên' }, C.ds)).medicationId;
    loc = (await svc.createStockLocation({ organizationId: OA, name: 'Quầy', type: 'dispensary_counter' }, C.admin)).locationId;
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('nhập kho: gửi lại 3 lần cùng khoá => chỉ cộng một lần', async () => {
    const rc = { medicationId: medId, locationId: loc, batchNumber: 'LOT-1', expiryDate: EXP, unitCost: 1500, quantity: 100 };
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await svc.receiveStockOnce(rc, 'rcpt-key-0001', C.ds));
    expect(r.map((x) => x.replayed)).toEqual([false, true, true]);
    expect(r[2]!.value.movement.movementId).toBe(r[0]!.value.movement.movementId);
    expect(onHand()).toBe(100);
  });

  it('8 lần gửi ĐỒNG THỜI cùng khoá: đúng 1 lần trừ kho, 7 lần nhận lại kết quả, không lỗi', async () => {
    const before = onHand();
    const n0 = dispenses();
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.dispenseMedicationOnce(dispense(5), 'disp-concurrent-01', C.ds)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(7);
    // jsonb không giữ thứ tự khoá => so sánh theo dạng chuẩn hoá.
    const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
    expect(new Set(results.map((r) => canon(r.value))).size).toBe(1);
    expect(onHand()).toBe(before - 5);
    expect(dispenses()).toBe(n0 + 1);
    expect(su(`SELECT count(*) FROM platform.idempotency_keys WHERE idem_key='disp-concurrent-01' AND response IS NOT NULL`)).toBe('1');
    expect(Number(su(`SELECT count(*) FROM platform.audit_events WHERE action='pharmacy.stock.dispense' AND payload->>'idempotentReplay'='true'`))).toBe(7);
  });

  it('khoá giống nhau nhưng khác nội dung => 422, khác người gọi => độc lập', async () => {
    expect(await outcome(svc.dispenseMedicationOnce(dispense(6), 'disp-concurrent-01', C.ds))).toBe('VALIDATION:IDEMPOTENCY_KEY_REUSED');
    const other = await svc.dispenseMedicationOnce(dispense(5), 'disp-concurrent-01', C.ds2);
    expect(other.replayed).toBe(false);
  });

  it('lần gửi lỗi (hết hàng) không lưu khoá; gửi lại sau khi nhập thêm thì chạy thật', async () => {
    const big = dispense(500);
    expect(await outcome(svc.dispenseMedicationOnce(big, 'disp-retry-0001', C.ds))).toBe('INSUFFICIENT_STOCK');
    expect(su(`SELECT count(*) FROM platform.idempotency_keys WHERE idem_key='disp-retry-0001'`)).toBe('0');
    await svc.receiveStockOnce({ medicationId: medId, locationId: loc, batchNumber: 'LOT-1', expiryDate: EXP, unitCost: 1500, quantity: 500 }, 'rcpt-key-0002', C.ds);
    const r = await svc.dispenseMedicationOnce(big, 'disp-retry-0001', C.ds);
    expect(r.replayed).toBe(false);
    expect(r.value.allocatedTotal).toBe(500);
  });

  it('DB: bản ghi khoá bất biến sau khi hoàn tất, không xoá được, RLS theo tenant', async () => {
    const c = new PsqlClient({ database: DB });
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const upd = await c.query(`UPDATE platform.idempotency_keys SET response='{}'::jsonb WHERE idem_key='rcpt-key-0001'`).then(() => 'OK', (e: { code?: string }) => e.code);
      expect(upd).toBe('55000');
      const del = await c.query(`DELETE FROM platform.idempotency_keys WHERE idem_key='rcpt-key-0001'`).then(() => 'OK', (e: { code?: string }) => e.code);
      expect(del).toBe('42501');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query(`SELECT 1 FROM platform.idempotency_keys`)).rows).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
