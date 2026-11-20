/**
 * HCOS-P0-ENG-001 | S3 | Idempotency cho nhập / cấp phát (repo in-memory, transaction mô phỏng bằng snapshot).
 * Tranh chấp đồng thời thật trên PostgreSQL: tests/integration/pharmacy-idempotency-pg.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CorrelationId, Membership, NewAuditEvent, OrganizationId, Role, TenantContext, TenantId, UserId } from '../../packages/domain/src/s0-contracts';
import type { Medication, StockLocation } from '../../packages/domain/src/s3-pharmacy-contracts';
import {
  PharmacyInventoryService,
  type AvailableBatchBalance,
  type PharmacyRepository,
} from '../../services/api/src/pharmacy/inventory.service';

const ISO = '2026-11-10T03:00:00.000Z' as never;
const T = randomUUID() as TenantId;
const ORG = randomUUID() as OrganizationId;
const DS1 = randomUUID() as UserId;
const DS2 = randomUUID() as UserId;
const LOC = randomUUID();
const MED = randomUUID();
const ENC = randomUUID();

interface State {
  onHand: number;
  movements: number;
  increases: number;
  keys: Map<string, { requestHash: string; response: unknown | null }>;
  audit: NewAuditEvent[];
}
let st: State;
let svc: PharmacyInventoryService;

const ctx = (sub: string): TenantContext =>
  Object.freeze({
    tenantId: T, userSubject: sub, userId: null, personId: null, activeOrganizationId: ORG,
    allowedOrganizationIds: Object.freeze([ORG]), roles: Object.freeze([] as Role[]), tokenId: null, correlationId: 'c' as CorrelationId,
  });
const C1 = ctx('sub-ds1');
const C2 = ctx('sub-ds2');

beforeEach(() => {
  st = { onHand: 10, movements: 0, increases: 0, keys: new Map(), audit: [] };
  const loc: StockLocation = { tenantId: T, locationId: LOC as never, organizationId: ORG, name: 'Quầy', type: 'dispensary_counter', isActive: true, createdAt: ISO, updatedAt: ISO };
  const med: Medication = { tenantId: T, medicationId: MED as never, brandName: 'Hapacol', strength: '500mg', form: 'tablet', unitOfMeasure: 'viên', isActive: true, createdAt: ISO, updatedAt: ISO };
  const repo = (): PharmacyRepository => {
    const r: Partial<PharmacyRepository> = {
    claimIdempotencyKey: async (c) => {
      const k = `${c.actorUserId}|${c.scope}|${c.key}`;
      const ex = st.keys.get(k);
      if (ex) return { kind: 'existing', requestHash: ex.requestHash, response: ex.response };
      st.keys.set(k, { requestHash: c.requestHash, response: null });
      return { kind: 'claimed' };
    },
    completeIdempotencyKey: async (c, response) => {
      st.keys.get(`${c.actorUserId}|${c.scope}|${c.key}`)!.response = response;
    },
    findUserBySubject: async (sub) => ({
      tenantId: T, userId: sub === 'sub-ds1' ? DS1 : DS2, externalSubject: sub, email: null, displayName: 'DS', personId: null,
      status: 'active', lastLoginAt: null, createdAt: ISO, updatedAt: ISO, version: 1,
    }),
    listMemberships: async (userId) => [{
      tenantId: T, membershipId: randomUUID() as never, userId, organizationId: ORG, role: 'pharmacist', status: 'active',
      validFrom: ISO, validTo: null, accessPolicyId: null, createdAt: ISO, updatedAt: ISO, version: 1,
    } satisfies Membership],
    findAccessPolicies: async () => [],
    findEncounterRef: async () => ({ organizationId: ORG, patientId: randomUUID(), status: 'in_progress' }),
    findStockLocation: async () => loc,
    findMedication: async () => med,
    lockAvailableBatchesForFefo: async (): Promise<AvailableBatchBalance[]> =>
      st.onHand > 0 ? [{ balanceId: 'b1', batchId: randomUUID(), batchNumber: 'L1', expiryDate: '2027-01-01' as never, quantityOnHand: st.onHand, quantityReserved: 0, version: 1 }] : [],
    updateBalanceQuantity: async (_id, q) => { st.onHand = q; return true; },
    insertStockMovement: async () => { st.movements++; },
    findBatch: async () => null,
    insertBatch: async () => true,
    increaseBalance: async (_t, _l, _b, q) => { st.onHand += q; st.increases++; },
    appendAudit: async (e) => { st.audit.push(e); },
    };
    return r as PharmacyRepository;
  };
  svc = new PharmacyInventoryService({
    uow: {
      run: async (_c, fn) => {
        const snap = { onHand: st.onHand, movements: st.movements, increases: st.increases, keys: new Map([...st.keys].map(([k, v]) => [k, { ...v }])), audit: [...st.audit] };
        try {
          return await fn(repo());
        } catch (e) {
          Object.assign(st, snap); // rollback, kể cả khoá idempotency
          throw e;
        }
      },
    },
    audit: { record: async () => {} },
    clock: () => new Date('2026-11-10T03:00:00Z'),
  });
});

const input = (quantity = 3) => ({ medicationId: MED, locationId: LOC, encounterId: ENC, quantity });

describe('cấp phát có Idempotency-Key', () => {
  it('gửi lại cùng khoá + cùng nội dung: trả kết quả cũ, không trừ kho lần hai, audit đánh dấu replay', async () => {
    const a = await svc.dispenseMedicationOnce(input(), 'key-00000001', C1);
    const b = await svc.dispenseMedicationOnce(input(), 'key-00000001', C1);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.value).toEqual(JSON.parse(JSON.stringify(a.value)));
    expect(st.onHand).toBe(7);
    expect(st.movements).toBe(1);
    expect(st.audit.at(-1)?.payload).toMatchObject({ idempotentReplay: true, idempotencyKey: 'key-00000001' });
    expect(st.audit.at(-2)?.payload).toMatchObject({ idempotencyKey: 'key-00000001', quantity: 3 });
  });

  it('cùng khoá, nội dung khác => VALIDATION IDEMPOTENCY_KEY_REUSED, không đổi kho', async () => {
    await svc.dispenseMedicationOnce(input(3), 'key-00000002', C1);
    await expect(svc.dispenseMedicationOnce(input(4), 'key-00000002', C1)).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(st.onHand).toBe(7);
  });

  it('khoá thuộc không gian riêng của từng người: người khác dùng trùng khoá vẫn là yêu cầu mới', async () => {
    await svc.dispenseMedicationOnce(input(2), 'shared-key-01', C1);
    const r = await svc.dispenseMedicationOnce(input(2), 'shared-key-01', C2);
    expect(r.replayed).toBe(false);
    expect(st.onHand).toBe(6);
  });

  it('lần trước lỗi (hết hàng) => khoá không được lưu; gửi lại sau khi có hàng thì thực hiện', async () => {
    await expect(svc.dispenseMedicationOnce(input(50), 'key-00000003', C1)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(st.keys.size).toBe(0);
    st.onHand = 60;
    const r = await svc.dispenseMedicationOnce(input(50), 'key-00000003', C1);
    expect(r.replayed).toBe(false);
    expect(st.onHand).toBe(10);
  });

  it('khoá sai định dạng => VALIDATION, không chạm DB', async () => {
    for (const k of ['short', 'x'.repeat(129), 'có dấu-12345', 'a b c d e f g']) {
      await expect(svc.dispenseMedicationOnce(input(), k, C1)).rejects.toMatchObject({ details: { reason: 'INVALID_IDEMPOTENCY_KEY' } });
    }
    expect(st.movements).toBe(0);
  });

  it('thứ tự khoá trong body không ảnh hưởng (hash JSON chuẩn hoá)', async () => {
    await svc.dispenseMedicationOnce({ quantity: 1, encounterId: ENC, locationId: LOC, medicationId: MED }, 'key-00000004', C1);
    const r = await svc.dispenseMedicationOnce({ medicationId: MED, locationId: LOC, encounterId: ENC, quantity: 1 }, 'key-00000004', C1);
    expect(r.replayed).toBe(true);
  });
});

describe('nhập kho có Idempotency-Key', () => {
  it('gửi lại không cộng kho lần hai; cùng khoá ở scope khác (cấp phát) là độc lập', async () => {
    const rc = { medicationId: MED, locationId: LOC, batchNumber: 'L9', expiryDate: '2028-01-01' as never, unitCost: 10, quantity: 5 };
    await svc.receiveStockOnce(rc, 'key-rcpt-0001', C1);
    const again = await svc.receiveStockOnce(rc, 'key-rcpt-0001', C1);
    expect(again.replayed).toBe(true);
    expect(st.increases).toBe(1);
    expect(st.onHand).toBe(15);
    const d = await svc.dispenseMedicationOnce(input(1), 'key-rcpt-0001', C1);
    expect(d.replayed).toBe(false);
  });
});
