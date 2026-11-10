/**
 * HCOS-P0-ENG-001 | S3 | Hardening: phân quyền, audit, validate nhập liệu, trạng thái kho/thuốc, nhập lô.
 * Chạy với repo giả trong bộ nhớ; tính đúng đắn của SQL (cộng dồn, FK ghép, sổ cái) do
 * tests/integration/pharmacy-hardening-pg.integration.test.ts kiểm trên PostgreSQL thật.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PharmacyError,
  PharmacyInventoryService,
  type PharmacyRepository,
  type PharmacyUnitOfWork,
} from '../../services/api/src/pharmacy/inventory.service';
import {
  type Batch,
  type Medication,
  type StockLocation,
  type StockMovement,
} from '../../packages/domain/src/s3-pharmacy-contracts';
import {
  type CorrelationId,
  type NewAuditEvent,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantId,
  type UserId,
} from '../../packages/domain/src/s0-contracts';

const NOW = new Date('2026-11-10T03:00:00Z');
const ISO = '2026-11-10T03:00:00.000Z' as never;

const mkCtx = (roles: Role[]): TenantContext =>
  Object.freeze({
    tenantId: randomUUID() as TenantId,
    userSubject: 'sub-1',
    userId: randomUUID() as UserId,
    personId: null,
    activeOrganizationId: null,
    allowedOrganizationIds: Object.freeze([]),
    roles: Object.freeze(roles),
    tokenId: null,
    correlationId: 'hardening-corr' as CorrelationId,
  });

interface Harness {
  svc: PharmacyInventoryService;
  inTx: NewAuditEvent[];
  outOfTx: NewAuditEvent[];
  movements: StockMovement[];
  increases: Array<{ qty: number }>;
  batches: Batch[];
}

function harness(opts: { loc?: Partial<StockLocation>; med?: Partial<Medication> } = {}, ctx?: TenantContext): Harness {
  const c = ctx ?? mkCtx(['pharmacist']);
  const inTx: NewAuditEvent[] = [];
  const outOfTx: NewAuditEvent[] = [];
  const movements: StockMovement[] = [];
  const increases: Array<{ qty: number }> = [];
  const batches: Batch[] = [];
  const loc: StockLocation = {
    locationId: randomUUID() as never,
    tenantId: c.tenantId,
    organizationId: randomUUID() as OrganizationId,
    name: 'Kho',
    type: 'main_warehouse',
    isActive: true,
    createdAt: ISO,
    updatedAt: ISO,
    ...opts.loc,
  };
  const med: Medication = {
    medicationId: randomUUID() as never,
    tenantId: c.tenantId,
    brandName: 'Med',
    strength: '500mg',
    form: 'tablet',
    unitOfMeasure: 'viên',
    isActive: true,
    createdAt: ISO,
    updatedAt: ISO,
    ...opts.med,
  };
  const repo: Partial<PharmacyRepository> = {
    findStockLocation: async () => loc,
    findMedication: async () => med,
    findBatch: async (_m, n) => batches.find((b) => b.batchNumber === n) ?? null,
    insertBatch: async (b) => {
      batches.push(b);
      return true;
    },
    increaseBalance: async (_t, _l, _b, qty) => {
      increases.push({ qty });
    },
    insertStockMovement: async (m) => {
      movements.push(m);
    },
    lockAvailableBatchesForFefo: async () => [],
    appendAudit: async (e) => {
      inTx.push(e);
    },
  };
  const uow: PharmacyUnitOfWork = { run: async (_c, fn) => fn(repo as PharmacyRepository) };
  const svc = new PharmacyInventoryService({
    uow,
    audit: { record: async (e) => void outOfTx.push(e) },
    clock: () => NOW,
  });
  return { svc, inTx, outOfTx, movements, increases, batches };
}

const receive = (h: Harness, c: TenantContext, over: Record<string, unknown> = {}) =>
  h.svc.receiveStock(
    {
      medicationId: randomUUID(),
      locationId: randomUUID(),
      batchNumber: 'L1',
      expiryDate: '2027-06-30' as never,
      unitCost: 1000,
      quantity: 10,
      ...over,
    } as never,
    c,
  );

describe('Pharmacy hardening', () => {
  it('từ chối vai trò không có quyền và ghi audit denied (ngoài giao dịch)', async () => {
    const c = mkCtx(['doctor']);
    const h = harness({}, c);
    await expect(receive(h, c)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.increases).toHaveLength(0);
    expect(h.inTx).toHaveLength(0);
    expect(h.outOfTx).toHaveLength(1);
    expect(h.outOfTx[0]!.outcome).toBe('denied');
    expect(h.outOfTx[0]!.action).toBe('pharmacy.stock.receive');
  });

  it('chỉ dược sĩ được xuất thuốc; pharmacy_admin thì không', async () => {
    const c = mkCtx(['pharmacy_admin']);
    const h = harness({}, c);
    await expect(
      h.svc.dispenseMedication(
        { medicationId: randomUUID(), locationId: randomUUID(), quantity: 1, encounterId: randomUUID() },
        c,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('nhập kho thành công: audit trong giao dịch, performed_by = người gọi, dùng increaseBalance', async () => {
    const c = mkCtx(['pharmacist']);
    const h = harness({}, c);
    const r = await receive(h, c);
    expect(r.movement.performedBy).toBe(c.userId);
    expect(h.increases).toEqual([{ qty: 10 }]);
    expect(h.inTx).toHaveLength(1);
    expect(h.inTx[0]!.outcome).toBe('success');
    expect(h.inTx[0]!.actor.id).toBe(c.userId);
    expect(h.outOfTx).toHaveLength(0);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])('từ chối số lượng không hợp lệ: %s', async (q) => {
    const c = mkCtx(['pharmacist']);
    const h = harness({}, c);
    await expect(receive(h, c, { quantity: q })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(h.increases).toHaveLength(0);
  });

  it('từ chối giá vốn âm / không phải số, ngày sai, ngày sản xuất sau hạn dùng', async () => {
    const c = mkCtx(['pharmacist']);
    const h = harness({}, c);
    await expect(receive(h, c, { unitCost: -1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(receive(h, c, { unitCost: Number.NaN })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(receive(h, c, { expiryDate: '2027-02-30' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(receive(h, c, { manufacturingDate: '2028-01-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('từ chối nhập lô đã hết hạn hoặc hết hạn hôm nay (EXPIRED_BATCH)', async () => {
    const c = mkCtx(['pharmacist']);
    const h = harness({}, c);
    await expect(receive(h, c, { expiryDate: '2026-11-10' })).rejects.toMatchObject({ code: 'EXPIRED_BATCH' });
    await expect(receive(h, c, { expiryDate: '2026-01-01' })).rejects.toMatchObject({ code: 'EXPIRED_BATCH' });
    expect(h.increases).toHaveLength(0);
  });

  it('nhập thêm vào lô đã có: thuộc tính khác thì CONFLICT, giống thì cộng dồn', async () => {
    const c = mkCtx(['pharmacist']);
    const h = harness({}, c);
    await receive(h, c);
    await expect(receive(h, c, { expiryDate: '2030-01-01' })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'BATCH_ATTRIBUTE_MISMATCH' },
    });
    await expect(receive(h, c, { unitCost: 2000 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await receive(h, c, { quantity: 5 });
    expect(h.increases).toEqual([{ qty: 10 }, { qty: 5 }]);
    expect(h.batches).toHaveLength(1);
  });

  it('không nhập vào kho/thuốc đã ngừng hoạt động', async () => {
    const c = mkCtx(['pharmacist']);
    await expect(receive(harness({ loc: { isActive: false } }, c), c)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(receive(harness({ med: { isActive: false } }, c), c)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('không xuất từ kho cách ly, kho ngừng hoạt động hoặc thuốc ngừng hoạt động', async () => {
    const c = mkCtx(['pharmacist']);
    const input = { medicationId: randomUUID(), locationId: randomUUID(), quantity: 1, encounterId: randomUUID() };
    for (const o of [{ loc: { type: 'quarantine' as const } }, { loc: { isActive: false } }, { med: { isActive: false } }]) {
      const h = harness(o, c);
      const err = await h.svc.dispenseMedication(input, c).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PharmacyError);
      expect((err as PharmacyError).code).toBe('VALIDATION');
      expect(h.movements).toHaveLength(0);
    }
  });

  it('xuất thuốc yêu cầu encounterId là UUID và số lượng nguyên dương', async () => {
    const c = mkCtx(['pharmacist']);
    const h = harness({}, c);
    const base = { medicationId: randomUUID(), locationId: randomUUID(), quantity: 1, encounterId: randomUUID() };
    await expect(h.svc.dispenseMedication({ ...base, encounterId: 'not-a-uuid' }, c)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(h.svc.dispenseMedication({ ...base, quantity: 2.5 }, c)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('tạo vị trí kho: tổ chức ngoài phạm vi người gọi bị FORBIDDEN', async () => {
    const c = mkCtx(['pharmacy_admin']);
    const h = harness({}, c);
    await expect(
      h.svc.createStockLocation({ organizationId: randomUUID(), name: 'Tủ trực', type: 'ward_cabinet' }, c),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
