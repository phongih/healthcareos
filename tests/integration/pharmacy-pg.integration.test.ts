/**
 * HCOS-P0-ENG-001 | Slice S3 | Integration test cho Phân hệ Dược (FEFO & RLS) trên PostgreSQL thật.
 *
 * Chạy: HCOS_IT=1 PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres vitest run tests/integration/pharmacy-pg.integration.test.ts
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
  type AuditSink,
  type CorrelationId,
  type ISODate,
  type NewAuditEvent,
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
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_pharmacy_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));

const U = {
  pharmA: asUserId(uid(101)),
  pharmB: asUserId(uid(201)),
};

const PA = asPersonId(uid(301));
const PB = asPersonId(uid(302));
const PAT_A = asPatientId(uid(401));
const PAT_B = asPatientId(uid(402));
const ENC_A = asEncounterId(uid(501));
const ENC_B = asEncounterId(uid(502));

const sub = (u: string) => `sub-${u}`;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[], roles: Role[]): TenantContext =>
  Object.freeze({
    tenantId: t,
    userSubject: sub(u),
    userId: u,
    personId: null,
    activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]),
    roles: Object.freeze([...roles]),
    tokenId: null,
    correlationId: 'it-pharmacy-corr' as CorrelationId,
  });

const su = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
const suFile = (f: string) =>
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id, code, name) VALUES ('${TA}', 'ta', 'Tenant A'), ('${TB}', 'tb', 'Tenant B');
INSERT INTO iam.organizations(organization_id, tenant_id, type, code, name) VALUES
  ('${OA}', '${TA}', 'clinic', 'cA', 'Clinic A'),
  ('${OB}', '${TB}', 'clinic', 'cB', 'Clinic B');
INSERT INTO iam.users(user_id, tenant_id, external_subject, display_name) VALUES
  ('${U.pharmA}', '${TA}', '${sub(U.pharmA)}', 'Pharmacist A'),
  ('${U.pharmB}', '${TB}', '${sub(U.pharmB)}', 'Pharmacist B');
INSERT INTO iam.memberships(tenant_id, user_id, organization_id, role) VALUES
  ('${TA}', '${U.pharmA}', '${OA}', 'pharmacist'),
  ('${TB}', '${U.pharmB}', '${OB}', 'pharmacist');

INSERT INTO patient.persons(person_id, tenant_id, given_name, family_name) VALUES
  ('${PA}', '${TA}', 'Hoa', 'Pham'),
  ('${PB}', '${TB}', 'Nam', 'Vu');
INSERT INTO patient.patients(patient_id, tenant_id, person_id, organization_id, mrn) VALUES
  ('${PAT_A}', '${TA}', '${PA}', '${OA}', 'MRN-A1'),
  ('${PAT_B}', '${TB}', '${PB}', '${OB}', 'MRN-B1');

INSERT INTO clinical.encounters(encounter_id, tenant_id, patient_id, organization_id, practitioner_user_id, encounter_class, reason_text) VALUES
  ('${ENC_A}', '${TA}', '${PAT_A}', '${OA}', '${U.pharmA}', 'ambulatory', 'Kham ngoai tru A'),
  ('${ENC_B}', '${TB}', '${PAT_B}', '${OB}', '${U.pharmB}', 'ambulatory', 'Kham ngoai tru B');
`;

class TestAuditSink implements AuditSink {
  events: NewAuditEvent[] = [];
  async record(e: NewAuditEvent) {
    this.events.push(e);
  }
}

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Phân hệ Dược (S3) / PostgreSQL Integration (RLS, Transactions, FEFO)', () => {
  let pool: ReturnType<typeof psqlPool>;
  let svc: PharmacyInventoryService;
  let sink: TestAuditSink;

  const ctxA = ctx(TA, U.pharmA, [OA], ['pharmacist']);
  const ctxB = ctx(TB, U.pharmB, [OB], ['pharmacist']);

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');

    const files = readdirSync(MIG)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();

    for (const f of files) {
      suFile(`${MIG}/${f}`);
    }

    su(SEED);

    pool = psqlPool({ database: DB });
    sink = new TestAuditSink();
    const uow = new PgPharmacyUnitOfWork(pool);
    svc = new PharmacyInventoryService({ uow, audit: sink });
  });

  afterAll(() => {
    try {
      su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres');
    } catch {
      /* best effort */
    }
  });

  it('thực thi luồng nhập kho và trừ kho FEFO chính xác trên PostgreSQL', async () => {
    // 1. Tạo hoạt chất và biệt dược cho Tenant A
    const subA = await svc.createSubstance({ code: 'PARA', name: 'Paracetamol' }, ctxA);
    const medA = await svc.createMedication(
      {
        substanceId: subA.substanceId,
        brandName: 'Hapacol 500',
        strength: '500mg',
        form: 'tablet',
        unitOfMeasure: 'viên',
      },
      ctxA,
    );

    // 2. Tạo vị trí kho cho Tenant A
    const locId = randomUUID();
    await new PgPharmacyUnitOfWork(pool).run(ctxA, async (repo) => {
      await repo.insertStockLocation({
        tenantId: TA,
        locationId: locId as any,
        organizationId: OA,
        name: 'Kho Dược Nội Trú A',
        type: 'main_warehouse',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      });
    });

    // 3. Nhập 2 lô: BATCH-EARLY (hết hạn 2026-12-15) có 20 viên, BATCH-LATE (hết hạn 2027-05-20) có 50 viên
    await svc.receiveStock(
      {
        medicationId: medA.medicationId,
        locationId: locId,
        batchNumber: 'BATCH-EARLY',
        expiryDate: '2026-12-15' as ISODate,
        unitCost: 1000,
        quantity: 20,
      },
      ctxA,
    );

    await svc.receiveStock(
      {
        medicationId: medA.medicationId,
        locationId: locId,
        batchNumber: 'BATCH-LATE',
        expiryDate: '2027-05-20' as ISODate,
        unitCost: 1050,
        quantity: 50,
      },
      ctxA,
    );

    // 4. Xuất 35 viên gắn với lượt khám ENC_A hợp lệ
    const plan = await svc.dispenseMedication(
      {
        medicationId: medA.medicationId,
        locationId: locId,
        quantity: 35,
        encounterId: ENC_A,
      },
      ctxA,
    );

    expect(plan.isFullyAllocated).toBe(true);
    expect(plan.allocatedTotal).toBe(35);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]!.batchNumber).toBe('BATCH-EARLY');
    expect(plan.items[0]!.allocatedQuantity).toBe(20);
    expect(plan.items[1]!.batchNumber).toBe('BATCH-LATE');
    expect(plan.items[1]!.allocatedQuantity).toBe(15);

    // 5. Kiểm tra trực tiếp số dư tồn kho trong PostgreSQL
    await new PgPharmacyUnitOfWork(pool).run(ctxA, async (repo) => {
      const remainingEarly = await repo.findBatch(medA.medicationId, 'BATCH-EARLY');
      const balEarly = await repo.findBalance(locId as any, remainingEarly!.batchId);
      expect(balEarly?.quantityOnHand).toBe(0);

      const remainingLate = await repo.findBatch(medA.medicationId, 'BATCH-LATE');
      const balLate = await repo.findBalance(locId as any, remainingLate!.batchId);
      expect(balLate?.quantityOnHand).toBe(35);

      const movements = await repo.listStockMovementsByEncounter(ENC_A);
      expect(movements).toHaveLength(2);
      expect(movements.reduce((s, m) => s + m.quantity, 0)).toBe(35);
    });

    // 6. Kiểm tra RLS Isolation: Tenant B không thể truy cập kho hay thuốc của Tenant A
    await expect(
      svc.dispenseMedication(
        {
          medicationId: medA.medicationId,
          locationId: locId,
          quantity: 5,
          encounterId: ENC_B,
        },
        ctxB,
      ),
    ).rejects.toThrowError(/not found/i);
  });
});
