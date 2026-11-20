/**
 * HCOS-P0-ENG-001 | S3 × IAM | Dược trên PostgreSQL thật: vai trò từ membership, access policy đọc từ DB,
 * kiểm tra đợt khám khi cấp phát, các API đọc mới.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/pharmacy-access-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type ISODate, type OrganizationId, type Role, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { PharmacyInventoryService, PgPharmacyUnitOfWork } from '../../services/api/src/pharmacy/inventory.service';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_pharm_ap_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const OA2 = asOrganizationId(uid(12));
const U = { ds: asUserId(uid(101)), admin: asUserId(uid(102)), doc: asUserId(uid(103)), ta: asUserId(uid(104)) };
const M_DS = uid(701);
const PERSON = uid(301);
const PAT = uid(401);
const PAT2 = uid(402);
const ENC = uid(501);
const ENC_OTHER_ORG = uid(502);
const ENC_CANCELLED = uid(503);
const POL = uid(901);
const EXP = '2028-12-31' as ISODate;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[], roles: Role[] = []): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([...roles]), tokenId: null, correlationId: 'it-ph-ap' as CorrelationId,
  });
const C = { ds: ctx(TA, U.ds, [OA, OA2]), admin: ctx(TA, U.admin, [OA]), doc: ctx(TA, U.doc, [OA], ['pharmacy_admin', 'pharmacist']) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1'),('${OA2}','${TA}','clinic','c2','C2');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.ds}','${TA}','sub-${U.ds}','DS'),('${U.admin}','${TA}','sub-${U.admin}','Admin kho'),('${U.doc}','${TA}','sub-${U.doc}','Doc'),('${U.ta}','${TA}','sub-${U.ta}','TA');
INSERT INTO iam.memberships(membership_id,tenant_id,user_id,organization_id,role) VALUES ('${M_DS}','${TA}','${U.ds}','${OA}','pharmacist');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.admin}','${OA}','pharmacy_admin'),('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.ta}','${OA}','tenant_admin');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${PERSON}','${TA}','An','Nguyen');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES
  ('${PAT}','${TA}','${PERSON}','${OA}','MRN-1'),('${PAT2}','${TA}','${PERSON}','${OA2}','MRN-2');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class) VALUES
  ('${ENC}','${TA}','${PAT}','${OA}','${U.doc}','ambulatory'),('${ENC_OTHER_ORG}','${TA}','${PAT2}','${OA2}','${U.doc}','ambulatory');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,encounter_class,status) VALUES
  ('${ENC_CANCELLED}','${TA}','${PAT}','${OA}','${U.doc}','ambulatory','cancelled');
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Dược × access policy / PostgreSQL', () => {
  let svc: PharmacyInventoryService;
  let medId: string;
  let counter: string;
  let cabinet: string;

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    svc = new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(psqlPool({ database: DB })), audit: { record: async () => {} } });
    medId = (await svc.createMedication({ brandName: 'Hapacol', strength: '500mg', form: 'tablet', unitOfMeasure: 'viên' }, C.ds)).medicationId;
    counter = (await svc.createStockLocation({ organizationId: OA, name: 'Quầy cấp phát', type: 'dispensary_counter' }, C.admin)).locationId;
    cabinet = (await svc.createStockLocation({ organizationId: OA, name: 'Tủ trực Nội', type: 'ward_cabinet' }, C.admin)).locationId;
    for (const loc of [counter, cabinet]) {
      await svc.receiveStock({ medicationId: medId, locationId: loc, batchNumber: 'LOT-1', expiryDate: EXP, unitCost: 1500, quantity: 50 }, C.ds);
    }
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('vai trò lấy từ DB: JWT ghi pharmacy_admin/pharmacist nhưng membership là doctor => 403', async () => {
    expect(await outcome(svc.createStockLocation({ organizationId: OA, name: 'Kho lậu', type: 'main_warehouse' }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(svc.dispenseMedication({ medicationId: medId, locationId: counter, quantity: 1, encounterId: ENC }, C.doc))).toBe('FORBIDDEN');
    // nhưng bác sĩ xem được danh mục thuốc
    await expect(svc.listMedications({}, C.doc)).resolves.toHaveLength(1);
  });

  it('API đọc: danh mục, FHIR-able medication, vị trí kho, tồn kho theo lô có giá vốn', async () => {
    await expect(svc.getMedication(medId, C.doc)).resolves.toMatchObject({ brandName: 'Hapacol' });
    const locs = await svc.listStockLocations(OA, C.ds);
    expect(locs.map((l) => l.type).sort()).toEqual(['dispensary_counter', 'ward_cabinet']);
    const stock = await svc.getStock(counter, C.ds);
    expect(stock.lines).toHaveLength(1);
    expect(stock.lines[0]).toMatchObject({ batchNumber: 'LOT-1', expiryDate: EXP, quantityOnHand: 50, unitCost: 1500, brandName: 'Hapacol' });
    expect(stock.redacted).toEqual([]);
  });

  it('cấp phát cho đợt khám ở organization khác bị chặn, không đổi tồn kho', async () => {
    expect(await outcome(svc.dispenseMedication({ medicationId: medId, locationId: counter, quantity: 1, encounterId: ENC_OTHER_ORG }, C.ds)))
      .toBe('VALIDATION:ENCOUNTER_ORG_MISMATCH');
    expect(await outcome(svc.dispenseMedication({ medicationId: medId, locationId: counter, quantity: 1, encounterId: ENC_CANCELLED }, C.ds)))
      .toBe('VALIDATION:ENCOUNTER_NOT_ACTIVE');
    expect(su(`SELECT quantity_on_hand FROM pharmacy.inventory_balances WHERE location_id='${counter}'`)).toBe('50');
  });

  it('policy đọc từ DB: chỉ cấp phát ở quầy, che giá vốn; người thực hiện ghi đúng user', async () => {
    su(`SET app.user_id='seed'; INSERT INTO iam.access_policies(policy_id,tenant_id,name,rules,created_by) VALUES ('${POL}','${TA}','Dược sĩ quầy',
      '[{"action":"pharmacy:stock:dispense","criteria":{"locationType":["dispensary_counter"]}},{"action":"pharmacy:stock:read","hiddenFields":["unitCost"]}]','${U.ta}');
      UPDATE iam.memberships SET access_policy_id='${POL}' WHERE membership_id='${M_DS}';`);
    const plan = await svc.dispenseMedication({ medicationId: medId, locationId: counter, quantity: 3, encounterId: ENC }, C.ds);
    expect(plan).toMatchObject({ allocatedTotal: 3, isFullyAllocated: true });
    expect(await outcome(svc.dispenseMedication({ medicationId: medId, locationId: cabinet, quantity: 1, encounterId: ENC }, C.ds))).toBe('FORBIDDEN:ACCESS_POLICY');
    const stock = await svc.getStock(counter, C.ds);
    expect(stock.lines[0]).toMatchObject({ quantityOnHand: 47, unitCost: null });
    expect(stock.redacted).toEqual(['unitCost']);
    // Policy không có luật nhập kho => nhập bị chặn dù vai trò dược sĩ cho phép.
    expect(await outcome(svc.receiveStock({ medicationId: medId, locationId: counter, batchNumber: 'LOT-2', expiryDate: EXP, unitCost: 1, quantity: 1 }, C.ds)))
      .toBe('FORBIDDEN:ACCESS_POLICY');
    expect(su(`SELECT performed_by FROM pharmacy.stock_movements WHERE movement_type='dispense' LIMIT 1`)).toBe(U.ds);
    const audit = su(`SELECT payload->>'accessPolicyIds' FROM platform.audit_events WHERE action='pharmacy.stock.dispense' AND outcome='success' ORDER BY occurred_at DESC LIMIT 1`);
    expect(audit).toContain(POL);
    expect(su(`SELECT organization_id FROM platform.audit_events WHERE action='pharmacy.stock.dispense' AND outcome='success' LIMIT 1`)).toBe(OA);
  });

  it('các lần cấp phát của đợt khám (cần quyền xem tồn kho tại organization của đợt khám)', async () => {
    su(`UPDATE iam.memberships SET access_policy_id=NULL WHERE membership_id='${M_DS}'`);
    const list = await svc.listDispensesByEncounter(ENC, C.ds);
    expect(list.map((m) => m.quantity)).toEqual([3]);
    expect(await outcome(svc.listDispensesByEncounter(ENC_OTHER_ORG, C.ds))).toBe('FORBIDDEN');
  });
});
