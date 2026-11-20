/**
 * HCOS-F5 | HTTP: route đơn thuốc (API giả, server node:http thật) — parse body/tham số, If-Match, ánh xạ lỗi,
 * và dispense nhận prescriptionItemId.
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, VersionConflictError } from '../../packages/domain/src/s0-contracts';
import type { PrescriptionView } from '../../packages/domain/src/prescription-contracts';
import { ClinicalError } from '../../services/api/src/clinical/encounter.service';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { PharmacyApi } from '../../services/api/src/http/pharmacy-routes';
import type { PrescriptionApi } from '../../services/api/src/http/prescription-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const ENC = uid(41);
const RX = uid(61);
const ITEM = uid(62);
const MED = uid(21);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

const view = (version = 1): PrescriptionView => ({
  prescription: {
    tenantId: TA, prescriptionId: RX as never, organizationId: OA, encounterId: ENC as never, patientId: uid(51) as never,
    prescriberUserId: uid(71) as never, status: 'active', note: null, prescribedAt: 't', createdAt: 't', updatedAt: 't', version,
  },
  items: [],
  prescriber: { userId: uid(71) as never, displayName: 'BS' },
});

let calls: Array<{ fn: string; arg: unknown }>;
let failWith: unknown;
const hit = async (fn: string, arg: unknown) => {
  calls.push({ fn, arg });
  if (failWith) throw failWith;
};

const prescriptions: PrescriptionApi = {
  async createPrescription(i) { await hit('create', i); return view(); },
  async cancelPrescription(id, v) { await hit('cancel', { id, v }); return { ...view(v + 1).prescription, status: 'cancelled' }; },
  async listForEncounter(e) { await hit('byEncounter', e); return [view()]; },
  async listForOrganization(q) { await hit('byOrg', q); return [view()]; },
};
const pharmacy = {
  async dispenseMedicationOnce(i: unknown, key: string) {
    await hit('dispense', { i, key });
    return { value: { medicationId: MED, requestedQuantity: 1, allocatedTotal: 1, items: [], isFullyAllocated: true }, replayed: false };
  },
} as unknown as PharmacyApi;
const clinical = {} as ClinicalApi;

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const tok = await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['doctor'] })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-bs').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  const headers: Record<string, string> = { authorization: `Bearer ${tok}`, ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, etag: r.headers.get('etag'), json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical, pharmacy, prescriptions });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; failWith = undefined; });

describe('HTTP đơn thuốc', () => {
  it('POST /api/prescriptions: 201 + ETag; trường lạ => 400', async () => {
    const body = { encounterId: ENC, items: [{ medicationId: MED, doseQuantity: 1, doseUnit: 'viên', frequencyPerDay: 2, durationDays: 5, quantity: 10 }] };
    const r = await call('POST', '/api/prescriptions', body);
    expect(r.status).toBe(201);
    expect(r.etag).toBe('W/"1"');
    expect(calls[0]).toMatchObject({ fn: 'create', arg: { encounterId: ENC, note: null } });
    expect((await call('POST', '/api/prescriptions', { ...body, patientId: uid(9) })).status).toBe(400);
  });

  it('GET: encounter HOẶC organization (đúng một); status chỉ đi với organization', async () => {
    expect((await call('GET', `/api/prescriptions?encounter=${ENC}`)).json.prescriptions).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ fn: 'byEncounter', arg: ENC });
    await call('GET', `/api/prescriptions?organization=${OA}&status=completed`);
    expect(calls.at(-1)).toEqual({ fn: 'byOrg', arg: { organizationId: OA, status: 'completed' } });
    expect((await call('GET', '/api/prescriptions')).status).toBe(400);
    expect((await call('GET', `/api/prescriptions?encounter=${ENC}&organization=${OA}`)).status).toBe(400);
    expect((await call('GET', `/api/prescriptions?encounter=${ENC}&status=active`)).status).toBe(400);
    expect((await call('GET', `/api/prescriptions?organization=${OA}&x=1`)).status).toBe(400);
  });

  it('cancel: thiếu If-Match => 428; có => truyền version; lệch version => 412', async () => {
    expect((await call('POST', `/api/prescriptions/${RX}/cancel`)).status).toBe(428);
    const r = await call('POST', `/api/prescriptions/${RX}/cancel`, undefined, { 'if-match': 'W/"3"' });
    expect(r.status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'cancel', arg: { id: RX, v: 3 } });
    failWith = new VersionConflictError('Prescription', RX, 3);
    expect((await call('POST', `/api/prescriptions/${RX}/cancel`, undefined, { 'if-match': 'W/"3"' })).status).toBe(412);
  });

  it('lỗi nghiệp vụ có reason trong OperationOutcome', async () => {
    failWith = new ClinicalError('CONFLICT', 'Prescription already has dispensed items', { reason: 'ALREADY_DISPENSED' });
    const r = await call('POST', `/api/prescriptions/${RX}/cancel`, undefined, { 'if-match': 'W/"1"' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.json)).toContain('ALREADY_DISPENSED');
    failWith = new ClinicalError('FORBIDDEN', 'x');
    expect((await call('GET', `/api/prescriptions?encounter=${ENC}`)).status).toBe(403);
  });

  it('dispense nhận prescriptionItemId', async () => {
    const r = await call('POST', '/api/pharmacy/dispenses', { medicationId: MED, locationId: uid(31), encounterId: ENC, quantity: 1, prescriptionItemId: ITEM }, { 'idempotency-key': 'k-12345678' });
    expect(r.status).toBe(201);
    expect(calls.at(-1)).toMatchObject({ fn: 'dispense', arg: { i: { prescriptionItemId: ITEM } } });
  });
});
