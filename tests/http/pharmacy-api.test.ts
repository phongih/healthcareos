/**
 * HCOS-P0-ENG-001 | S3 | HTTP: route dược (API giả, server node:http thật) — parse body, ánh xạ lỗi, FHIR Medication.
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { Medication } from '../../packages/domain/src/s3-pharmacy-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { PharmacyApi } from '../../services/api/src/http/pharmacy-routes';
import { createApiServer } from '../../services/api/src/http/server';
import { PharmacyError } from '../../services/api/src/pharmacy/inventory.service';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const MED = uid(21);
const LOC = uid(31);
const ENC = uid(41);
const ISO = '2026-11-10T03:00:00.000Z' as never;
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

const med: Medication = {
  tenantId: TA, medicationId: MED as never, brandName: 'Hapacol', genericName: 'Paracetamol', strength: '500mg', form: 'tablet',
  unitOfMeasure: 'viên', barcode: '8934567890123', isActive: true, createdAt: ISO, updatedAt: ISO,
};

let calls: Array<{ fn: string; arg: unknown }>;
const keys = new Set<string>();
/** Giả lập kho khoá: lần đầu => thực hiện, lần sau => replay. */
const seen = (k: string) => { const had = keys.has(k); keys.add(k); return had; };
let failWith: unknown;
const hit = async (fn: string, arg: unknown) => {
  calls.push({ fn, arg });
  if (failWith) throw failWith;
};

const pharmacy: PharmacyApi = {
  async listMedications(q) { await hit('listMedications', q); return [med]; },
  async getMedication(id) { await hit('getMedication', id); return med; },
  async createMedication(i) { await hit('createMedication', i); return med; },
  async createSubstance(i) { await hit('createSubstance', i); return { tenantId: TA, substanceId: uid(51) as never, code: i.code, name: i.name, isActive: true, createdAt: ISO, updatedAt: ISO }; },
  async listStockLocations(org) { await hit('listStockLocations', org); return []; },
  async createStockLocation(i) { await hit('createStockLocation', i); return { tenantId: TA, locationId: LOC as never, organizationId: OA, name: i.name, type: i.type, isActive: true, createdAt: ISO, updatedAt: ISO }; },
  async getStock(id) { await hit('getStock', id); return { location: { tenantId: TA, locationId: LOC as never, organizationId: OA, name: 'Quầy', type: 'dispensary_counter', isActive: true, createdAt: ISO, updatedAt: ISO }, lines: [], redacted: ['unitCost'] }; },
  async receiveStockOnce(i, key) { await hit('receiveStockOnce', { i, key }); return { value: { batch: {} as never, movement: {} as never }, replayed: seen(key) }; },
  async dispenseMedicationOnce(i, key) {
    await hit('dispenseMedicationOnce', { i, key });
    return { value: { medicationId: MED as never, requestedQuantity: i.quantity, allocatedTotal: i.quantity, items: [], isFullyAllocated: true }, replayed: seen(key) };
  },
  async listDispensesByEncounter(id) { await hit('listDispensesByEncounter', id); return []; },
};
const clinical = {} as ClinicalApi;

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const tok = await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['pharmacist'] })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-ds').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  const headers: Record<string, string> = { authorization: `Bearer ${tok}`, ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, location: r.headers.get('location'), replayed: r.headers.get('idempotent-replayed'), json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical, pharmacy });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; failWith = undefined; });

const receipt = { medicationId: MED, locationId: LOC, batchNumber: 'L1', expiryDate: '2027-06-30', unitCost: 1000, quantity: 10 };
const dispense = { medicationId: MED, locationId: LOC, encounterId: ENC, quantity: 2 };

describe('route dược', () => {
  it('danh mục: tham số hợp lệ được chuyển xuống service; tham số lạ => 400', async () => {
    expect((await call('GET', '/api/pharmacy/medications?active=false&_count=50')).status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'listMedications', arg: { activeOnly: false, limit: 50 } });
    expect((await call('GET', '/api/pharmacy/medications?q=x')).status).toBe(400);
    expect((await call('GET', '/api/pharmacy/medications?active=yes')).status).toBe(400);
  });

  it('FHIR Medication', async () => {
    const r = await call('GET', `/fhir/Medication/${MED}`);
    expect(r.json).toMatchObject({
      resourceType: 'Medication', id: MED, status: 'active', code: { text: 'Hapacol 500mg (Paracetamol)' }, form: { text: 'tablet' },
      identifier: [{ system: 'urn:hcos:medication-barcode', value: '8934567890123' }],
    });
  });

  it('tạo thuốc / kho: 201 + Location; khoá lạ bị bỏ, kiểu sai => 422 không vào service', async () => {
    const m = await call('POST', '/api/pharmacy/medications', { brandName: 'Hapacol', strength: '500mg', form: 'tablet', unitOfMeasure: 'viên', isActive: false });
    expect(m.status).toBe(201);
    expect(m.location).toBe(`/fhir/Medication/${MED}`);
    expect(calls.at(-1)!.arg).not.toHaveProperty('isActive');
    expect((await call('POST', '/api/pharmacy/medications', { brandName: 1, strength: 'x', form: 'y', unitOfMeasure: 'z' })).status).toBe(422);
    expect((await call('POST', '/api/pharmacy/locations', { organizationId: OA, name: 'Kho', type: 'garage' })).status).toBe(422);
    const l = await call('POST', '/api/pharmacy/locations', { organizationId: OA, name: 'Tủ trực', type: 'ward_cabinet' });
    expect(l.location).toBe(`/api/pharmacy/locations/${LOC}/stock`);
    expect(calls.filter((c) => c.fn === 'createStockLocation')).toHaveLength(1);
  });

  it('nhập / xuất: số lượng phải là number; kết quả 201', async () => {
    expect((await call('POST', '/api/pharmacy/receipts', { ...receipt, quantity: '10' }, { 'idempotency-key': 'rcpt-0001' })).status).toBe(422);
    expect((await call('POST', '/api/pharmacy/receipts', receipt, { 'idempotency-key': 'rcpt-0002' })).status).toBe(201);
    const d = await call('POST', '/api/pharmacy/dispenses', dispense, { 'idempotency-key': 'disp-0001' });
    expect(d.status).toBe(201);
    expect(d.json).toMatchObject({ isFullyAllocated: true, allocatedTotal: 2 });
    expect((await call('GET', '/api/pharmacy/dispenses')).status).toBe(400);
    expect((await call('GET', `/api/pharmacy/dispenses?encounter=${ENC}`)).status).toBe(200);
  });

  it('tồn kho trả danh sách trường bị che', async () => {
    expect((await call('GET', `/api/pharmacy/locations/${LOC}/stock`)).json.redacted).toEqual(['unitCost']);
  });

  it('ánh xạ lỗi dược thành HTTP an toàn', async () => {
    const cases: Array<[PharmacyError, number, string, string | undefined]> = [
      [new PharmacyError('INSUFFICIENT_STOCK', 'Insufficient stock. Requested: 5, Available: 2', { requested: 5, available: 2 }), 409, 'business-rule', 'INSUFFICIENT_STOCK'],
      [new PharmacyError('EXPIRED_BATCH', 'expired'), 422, 'business-rule', 'EXPIRED_BATCH'],
      [new PharmacyError('VALIDATION', 'Encounter belongs to a different organization', { reason: 'ENCOUNTER_ORG_MISMATCH' }), 422, 'invalid', 'ENCOUNTER_ORG_MISMATCH'],
      [new PharmacyError('FORBIDDEN', 'Access policy does not permit pharmacy:stock:dispense', { reason: 'ACCESS_POLICY' }), 403, 'forbidden', undefined],
      [new PharmacyError('NOT_FOUND', 'Stock location not found'), 404, 'not-found', undefined],
      [new PharmacyError('CONFLICT', 'Batch exists', { reason: 'BATCH_ATTRIBUTE_MISMATCH' }), 409, 'conflict', 'BATCH_ATTRIBUTE_MISMATCH'],
    ];
    for (const [err, status, code, detail] of cases) {
      failWith = err;
      const r = await call('POST', '/api/pharmacy/dispenses', dispense, { 'idempotency-key': 'disp-err-01' });
      expect(r.status).toBe(status);
      expect(r.json.issue[0].code).toBe(code);
      expect(r.json.issue[0].details?.text).toBe(detail);
    }
    failWith = new PharmacyError('FORBIDDEN', 'Access policy does not permit pharmacy:stock:dispense');
    const f = await call('POST', '/api/pharmacy/dispenses', dispense, { 'idempotency-key': 'disp-err-02' });
    expect(JSON.stringify(f.json)).not.toContain('pharmacy:stock');
  });

  it('Idempotency-Key: thiếu => 428 (không vào service); gửi lại => cùng kết quả + Idempotent-Replayed', async () => {
    for (const path of ['/api/pharmacy/dispenses', '/api/pharmacy/receipts']) {
      const r = await call('POST', path, path.endsWith('dispenses') ? dispense : receipt);
      expect(r.status).toBe(428);
    }
    expect(calls).toHaveLength(0);
    const first = await call('POST', '/api/pharmacy/dispenses', dispense, { 'idempotency-key': 'retry-key-0001' });
    const again = await call('POST', '/api/pharmacy/dispenses', dispense, { 'idempotency-key': 'retry-key-0001' });
    expect(first.status).toBe(201);
    expect(first.replayed).toBeNull();
    expect(again.status).toBe(201);
    expect(again.replayed).toBe('true');
    expect(again.json).toEqual(first.json);
    expect(calls.at(-1)).toMatchObject({ fn: 'dispenseMedicationOnce', arg: { key: 'retry-key-0001' } });
  });

  it('khoá dùng lại với body khác => 422 IDEMPOTENCY_KEY_REUSED', async () => {
    failWith = new PharmacyError('VALIDATION', 'Idempotency-Key was already used with a different request', { reason: 'IDEMPOTENCY_KEY_REUSED' });
    const r = await call('POST', '/api/pharmacy/receipts', receipt, { 'idempotency-key': 'reused-key-01' });
    expect(r.status).toBe(422);
    expect(r.json.issue[0].details.text).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
