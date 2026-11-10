import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PharmacyInventoryService,
  type AvailableBatchBalance,
  type PharmacyRepository,
  type PharmacyUnitOfWork,
} from '../../services/api/src/pharmacy/inventory.service';
import {
  asBatchId,
  asMedicationId,
  asStockLocationId,
  type StockMovement,
} from '../../packages/domain/src/s3-pharmacy-contracts';
import { type CorrelationId, type TenantContext, type TenantId } from '../../packages/domain/src/s0-contracts';

describe('PharmacyInventoryService - FEFO Allocation Logic', () => {
  const dummyCtx: TenantContext = Object.freeze({
    tenantId: randomUUID() as TenantId,
    userSubject: 'doctor-sub-01',
    userId: null,
    personId: null,
    activeOrganizationId: null,
    allowedOrganizationIds: Object.freeze([]),
    roles: Object.freeze(['pharmacist'] as const),
    tokenId: null,
    correlationId: 'unit-pharmacy-corr' as CorrelationId,
  });

  const createMockUow = (repo: PharmacyRepository): PharmacyUnitOfWork => ({
    run: async (_ctx, fn) => fn(repo),
  });

  const dummyAuditSink = {
    record: async () => {},
  };

  it('nên tự động ưu tiên bốc từ lô có hạn dùng gần nhất (FEFO)', async () => {
    const medId = asMedicationId(randomUUID());
    const locId = asStockLocationId(randomUUID());
    const batchIdB = asBatchId(randomUUID());
    const batchIdA = asBatchId(randomUUID());

    const availableBatches: AvailableBatchBalance[] = [
      {
        balanceId: randomUUID(),
        batchId: batchIdB,
        batchNumber: 'LOT-B-SOON',
        expiryDate: '2026-12-01' as any,
        quantityOnHand: 20,
        quantityReserved: 0,
        version: 1,
      },
      {
        balanceId: randomUUID(),
        batchId: batchIdA,
        batchNumber: 'LOT-A-LATER',
        expiryDate: '2027-06-01' as any,
        quantityOnHand: 50,
        quantityReserved: 0,
        version: 1,
      },
    ];

    const updatedBalances: Array<{ id: string; qty: number }> = [];
    const recordedMovements: StockMovement[] = [];

    const mockRepo: Partial<PharmacyRepository> = {
      appendAudit: async () => {},
      findStockLocation: async (id) => ({
        locationId: id,
        tenantId: dummyCtx.tenantId,
        organizationId: randomUUID() as any,
        name: 'Kho Test',
        type: 'main_warehouse',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      }),
      findMedication: async (id) => ({
        medicationId: id,
        tenantId: dummyCtx.tenantId,
        substanceId: randomUUID() as any,
        brandName: 'Test Med',
        strength: '500mg',
        form: 'tablet',
        unitOfMeasure: 'viên',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      }),
      lockAvailableBatchesForFefo: async () => availableBatches,
      updateBalanceQuantity: async (id, qty) => {
        updatedBalances.push({ id, qty });
        return true;
      },
      insertStockMovement: async (m) => {
        recordedMovements.push(m);
      },
    };

    const service = new PharmacyInventoryService({
      uow: createMockUow(mockRepo as PharmacyRepository),
      audit: dummyAuditSink as any,
      clock: () => new Date('2026-11-08T00:00:00Z'),
    });

    const result = await service.dispenseMedication(
      {
        medicationId: medId,
        locationId: locId,
        quantity: 15,
        encounterId: randomUUID(),
        reason: 'Outpatient prescription',
      },
      dummyCtx,
    );

    expect(result.isFullyAllocated).toBe(true);
    expect(result.allocatedTotal).toBe(15);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.batchNumber).toBe('LOT-B-SOON');
    expect(result.items[0]!.allocatedQuantity).toBe(15);
    expect(updatedBalances).toEqual([{ id: availableBatches[0]!.balanceId, qty: 5 }]);
    expect(recordedMovements).toHaveLength(1);
    expect(recordedMovements[0]!.movementType).toBe('dispense');
  });

  it('nên bốc liên lô (multi-batch split) khi lô hết hạn gần nhất không đủ số lượng', async () => {
    const medId = asMedicationId(randomUUID());
    const locId = asStockLocationId(randomUUID());
    const batchIdB = asBatchId(randomUUID());
    const batchIdA = asBatchId(randomUUID());

    const availableBatches: AvailableBatchBalance[] = [
      {
        balanceId: randomUUID(),
        batchId: batchIdB,
        batchNumber: 'LOT-B-SOON',
        expiryDate: '2026-12-01' as any,
        quantityOnHand: 10,
        quantityReserved: 0,
        version: 1,
      },
      {
        balanceId: randomUUID(),
        batchId: batchIdA,
        batchNumber: 'LOT-A-LATER',
        expiryDate: '2027-06-01' as any,
        quantityOnHand: 50,
        quantityReserved: 0,
        version: 1,
      },
    ];

    const updatedBalances: Array<{ id: string; qty: number }> = [];
    const mockRepo: Partial<PharmacyRepository> = {
      appendAudit: async () => {},
      findStockLocation: async (id) => ({
        locationId: id,
        tenantId: dummyCtx.tenantId,
        organizationId: randomUUID() as any,
        name: 'Kho Test',
        type: 'main_warehouse',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      }),
      findMedication: async (id) => ({
        medicationId: id,
        tenantId: dummyCtx.tenantId,
        substanceId: randomUUID() as any,
        brandName: 'Test Med',
        strength: '500mg',
        form: 'tablet',
        unitOfMeasure: 'viên',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      }),
      lockAvailableBatchesForFefo: async () => availableBatches,
      updateBalanceQuantity: async (id, qty) => {
        updatedBalances.push({ id, qty });
        return true;
      },
      insertStockMovement: async () => {},
    };

    const service = new PharmacyInventoryService({
      uow: createMockUow(mockRepo as PharmacyRepository),
      audit: dummyAuditSink as any,
      clock: () => new Date('2026-11-08T00:00:00Z'),
    });

    const result = await service.dispenseMedication(
      {
        medicationId: medId,
        locationId: locId,
        quantity: 25,
        encounterId: randomUUID(),
      },
      dummyCtx,
    );

    expect(result.isFullyAllocated).toBe(true);
    expect(result.allocatedTotal).toBe(25);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.batchNumber).toBe('LOT-B-SOON');
    expect(result.items[0]!.allocatedQuantity).toBe(10);
    expect(result.items[1]!.batchNumber).toBe('LOT-A-LATER');
    expect(result.items[1]!.allocatedQuantity).toBe(15);
    expect(updatedBalances).toEqual([
      { id: availableBatches[0]!.balanceId, qty: 0 },
      { id: availableBatches[1]!.balanceId, qty: 35 },
    ]);
  });

  it('phải từ chối giao dịch (INSUFFICIENT_STOCK) nếu tổng khả dụng không đủ', async () => {
    const medId = asMedicationId(randomUUID());
    const locId = asStockLocationId(randomUUID());

    const availableBatches: AvailableBatchBalance[] = [
      {
        balanceId: randomUUID(),
        batchId: asBatchId(randomUUID()),
        batchNumber: 'LOT-B-SOON',
        expiryDate: '2026-12-01' as any,
        quantityOnHand: 5,
        quantityReserved: 0,
        version: 1,
      },
    ];

    const mockRepo: Partial<PharmacyRepository> = {
      appendAudit: async () => {},
      findStockLocation: async (id) => ({
        locationId: id,
        tenantId: dummyCtx.tenantId,
        organizationId: randomUUID() as any,
        name: 'Kho Test',
        type: 'main_warehouse',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      }),
      findMedication: async (id) => ({
        medicationId: id,
        tenantId: dummyCtx.tenantId,
        substanceId: randomUUID() as any,
        brandName: 'Test Med',
        strength: '500mg',
        form: 'tablet',
        unitOfMeasure: 'viên',
        isActive: true,
        createdAt: '2026-11-08T00:00:00Z' as any,
        updatedAt: '2026-11-08T00:00:00Z' as any,
      }),
      lockAvailableBatchesForFefo: async () => availableBatches,
    };

    const service = new PharmacyInventoryService({
      uow: createMockUow(mockRepo as PharmacyRepository),
      audit: dummyAuditSink as any,
    });

    await expect(
      service.dispenseMedication(
        {
          medicationId: medId,
          locationId: locId,
          quantity: 10,
          encounterId: randomUUID(),
        },
        dummyCtx,
      ),
    ).rejects.toThrowError(/Insufficient stock/);
  });
});
