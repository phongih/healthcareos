/**
 * HCOS-P0-ENG-001 | S3 × IAM | Phân quyền dược theo membership (DB) + access policy; kiểm tra đợt khám khi cấp phát.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessPolicyId, CorrelationId, Membership, NewAuditEvent, OrganizationId, Role, TenantContext, TenantId, UserId,
} from '../../packages/domain/src/s0-contracts';
import type { Medication, StockLocation, StockLocationType } from '../../packages/domain/src/s3-pharmacy-contracts';
import { validateAccessRules, type AccessPolicy } from '../../packages/security/src/access-policy';
import {
  PharmacyInventoryService,
  type EncounterRef,
  type PharmacyRepository,
  type StockLine,
} from '../../services/api/src/pharmacy/inventory.service';

const ISO = '2026-11-10T03:00:00.000Z' as never;
const T = randomUUID() as TenantId;
const ORG_A = randomUUID() as OrganizationId;
const ORG_B = randomUUID() as OrganizationId;
const USER = randomUUID() as UserId;
const POL = randomUUID() as AccessPolicyId;

interface World {
  memberships: Membership[];
  policies: AccessPolicy[];
  locations: Record<string, StockLocation>;
  encounter: EncounterRef | null;
  movements: number;
  inTx: NewAuditEvent[];
  outOfTx: NewAuditEvent[];
}
let w: World;
let svc: PharmacyInventoryService;

const member = (role: Role, organizationId = ORG_A, accessPolicyId: AccessPolicyId | null = null): Membership => ({
  tenantId: T, membershipId: randomUUID() as never, userId: USER, organizationId, role, status: 'active',
  validFrom: ISO, validTo: null, accessPolicyId, createdAt: ISO, updatedAt: ISO, version: 1,
});
const location = (type: StockLocationType, organizationId = ORG_A): StockLocation => {
  const l: StockLocation = { tenantId: T, locationId: randomUUID() as never, organizationId, name: type, type, isActive: true, createdAt: ISO, updatedAt: ISO };
  w.locations[l.locationId] = l;
  return l;
};
const ctx = (jwtRoles: Role[] = [], orgs: OrganizationId[] = [ORG_A, ORG_B]): TenantContext =>
  Object.freeze({
    tenantId: T, userSubject: 'sub-ds', userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze(jwtRoles), tokenId: null, correlationId: 'c' as CorrelationId,
  });
const med: Medication = { tenantId: T, medicationId: randomUUID() as never, brandName: 'Hapacol', strength: '500mg', form: 'tablet', unitOfMeasure: 'viên', isActive: true, createdAt: ISO, updatedAt: ISO };
const restrict = (rules: unknown) => {
  w.policies = [{ tenantId: T, policyId: POL, name: 'p', description: null, status: 'active', rules: validateAccessRules(rules), createdBy: USER, createdAt: ISO, updatedAt: ISO, version: 1 }];
};

beforeEach(() => {
  w = { memberships: [], policies: [], locations: {}, encounter: { organizationId: ORG_A, patientId: randomUUID(), status: 'in_progress' }, movements: 0, inTx: [], outOfTx: [] };
  const repo: Partial<PharmacyRepository> = {
    findUserBySubject: async () => ({ tenantId: T, userId: USER, externalSubject: 'sub-ds', email: null, displayName: 'DS', personId: null, status: 'active', lastLoginAt: null, createdAt: ISO, updatedAt: ISO, version: 1 }),
    listMemberships: async () => w.memberships,
    findAccessPolicies: async (ids) => w.policies.filter((p) => ids.includes(p.policyId)),
    findEncounterRef: async () => w.encounter,
    findStockLocation: async (id) => w.locations[id] ?? null,
    findMedication: async () => med,
    lockAvailableBatchesForFefo: async () => [{ balanceId: randomUUID(), batchId: randomUUID(), batchNumber: 'L1', expiryDate: '2027-01-01' as never, quantityOnHand: 100, quantityReserved: 0, version: 1 }],
    updateBalanceQuantity: async () => true,
    insertStockMovement: async () => { w.movements++; },
    listStockAtLocation: async () => [{ batchId: randomUUID() as never, batchNumber: 'L1', expiryDate: '2027-01-01' as never, medicationId: med.medicationId, brandName: 'Hapacol', quantityOnHand: 100, quantityReserved: 0, unitCost: 1234.5 } satisfies StockLine],
    listMedications: async () => [med],
    insertStockLocation: async () => {},
    appendAudit: async (e) => { w.inTx.push(e); },
  };
  svc = new PharmacyInventoryService({
    uow: { run: async (_c, fn) => fn(repo as PharmacyRepository) },
    audit: { record: async (e) => { w.outOfTx.push(e); } },
    clock: () => new Date('2026-11-10T03:00:00Z'),
  });
});

const dispense = (locationId: string, c = ctx()) =>
  svc.dispenseMedication({ medicationId: med.medicationId, locationId, quantity: 2, encounterId: randomUUID() }, c);

describe('vai trò lấy từ DB, theo organization của kho', () => {
  it('JWT ghi pharmacist nhưng DB chỉ có doctor => 403 (không tin roles trong token)', async () => {
    w.memberships = [member('doctor')];
    await expect(dispense(location('dispensary_counter').locationId, ctx(['pharmacist']))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(w.outOfTx.at(-1)).toMatchObject({ outcome: 'denied', action: 'pharmacy.stock.dispense' });
  });

  it('là dược sĩ ở ORG_B nhưng kho thuộc ORG_A => 403', async () => {
    w.memberships = [member('pharmacist', ORG_B)];
    await expect(dispense(location('dispensary_counter', ORG_A).locationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(w.movements).toBe(0);
  });

  it('kho thuộc organization ngoài phạm vi token => 403 dù có membership', async () => {
    w.memberships = [member('pharmacist', ORG_A), member('pharmacist', ORG_B)];
    await expect(dispense(location('dispensary_counter', ORG_B).locationId, ctx([], [ORG_A]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('dược sĩ đúng organization: cấp phát được; performedBy = user từ DB; audit ghi organization của kho', async () => {
    w.memberships = [member('pharmacist')];
    const plan = await dispense(location('dispensary_counter').locationId);
    expect(plan.isFullyAllocated).toBe(true);
    expect(w.inTx.at(-1)).toMatchObject({ outcome: 'success', organizationId: ORG_A, actor: { id: USER } });
  });

  it('danh mục thuốc: bác sĩ đọc được, không thêm được', async () => {
    w.memberships = [member('doctor')];
    await expect(svc.listMedications({}, ctx())).resolves.toHaveLength(1);
    await expect(svc.createMedication({ brandName: 'X', strength: '1', form: 'tab', unitOfMeasure: 'viên' }, ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('kiểm tra đợt khám khi cấp phát', () => {
  beforeEach(() => { w.memberships = [member('pharmacist')]; });

  it('đợt khám ở organization khác => VALIDATION ENCOUNTER_ORG_MISMATCH, không trừ kho', async () => {
    w.encounter = { organizationId: ORG_B, patientId: randomUUID(), status: 'in_progress' };
    await expect(dispense(location('dispensary_counter').locationId)).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'ENCOUNTER_ORG_MISMATCH' } });
    expect(w.movements).toBe(0);
  });

  it('đợt khám không tồn tại / bị huỷ / nhập nhầm => VALIDATION', async () => {
    const loc = location('dispensary_counter').locationId;
    w.encounter = null;
    await expect(dispense(loc)).rejects.toMatchObject({ details: { reason: 'REFERENCE_NOT_FOUND' } });
    for (const status of ['cancelled', 'entered_in_error']) {
      w.encounter = { organizationId: ORG_A, patientId: randomUUID(), status };
      await expect(dispense(loc)).rejects.toMatchObject({ details: { reason: 'ENCOUNTER_NOT_ACTIVE' } });
    }
    w.encounter = { organizationId: ORG_A, patientId: randomUUID(), status: 'finished' };
    await expect(dispense(loc)).resolves.toMatchObject({ isFullyAllocated: true });
  });
});

describe('access policy trên dược', () => {
  it('chỉ cấp phát tại quầy cấp phát; tủ trực bị từ chối với reason ACCESS_POLICY', async () => {
    w.memberships = [member('pharmacist', ORG_A, POL)];
    restrict([{ action: 'pharmacy:stock:dispense', criteria: { locationType: ['dispensary_counter'] } }]);
    await expect(dispense(location('dispensary_counter').locationId)).resolves.toMatchObject({ isFullyAllocated: true });
    expect(w.inTx.at(-1)?.payload).toMatchObject({ accessPolicyIds: [POL] });
    await expect(dispense(location('ward_cabinet').locationId)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'ACCESS_POLICY' } });
    expect(w.outOfTx.at(-1)?.payload).toMatchObject({ reason: 'ACCESS_POLICY' });
  });

  it('xem tồn kho: che giá vốn theo policy', async () => {
    w.memberships = [member('pharmacist', ORG_A, POL)];
    restrict([{ action: 'pharmacy:stock:read', hiddenFields: ['unitCost'] }]);
    const loc = location('main_warehouse');
    const r = await svc.getStock(loc.locationId, ctx());
    expect(r.lines[0]!.unitCost).toBeNull();
    expect(r.redacted).toEqual(['unitCost']);
  });

  it('policy không có luật cho thao tác => từ chối dù vai trò cho phép; không policy => thấy giá vốn', async () => {
    w.memberships = [member('pharmacist', ORG_A, POL)];
    restrict([{ action: 'pharmacy:stock:read' }]);
    await expect(svc.receiveStock({ medicationId: med.medicationId, locationId: location('main_warehouse').locationId, batchNumber: 'L9', expiryDate: '2028-01-01' as never, unitCost: 1, quantity: 1 }, ctx()))
      .rejects.toMatchObject({ details: { reason: 'ACCESS_POLICY' } });
    w.memberships = [member('pharmacist')];
    const r = await svc.getStock(location('main_warehouse').locationId, ctx());
    expect(r.lines[0]!.unitCost).toBe(1234.5);
  });

  it('pharmacy_admin chỉ tạo tủ trực theo policy', async () => {
    w.memberships = [member('pharmacy_admin', ORG_A, POL)];
    restrict([{ action: 'pharmacy:location:write', criteria: { locationType: ['ward_cabinet'] } }]);
    await expect(svc.createStockLocation({ organizationId: ORG_A, name: 'Tủ trực Nội', type: 'ward_cabinet' }, ctx())).resolves.toMatchObject({ type: 'ward_cabinet' });
    await expect(svc.createStockLocation({ organizationId: ORG_A, name: 'Kho chính', type: 'main_warehouse' }, ctx())).rejects.toMatchObject({ details: { reason: 'ACCESS_POLICY' } });
    await expect(svc.createStockLocation({ organizationId: ORG_A, name: 'X', type: 'spaceship' as never }, ctx())).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
