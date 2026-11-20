/**
 * HCOS-F8 | HTTP: route thu ngân (API giả) — đi đúng hàm, Idempotency-Key bắt buộc, If-Match, tiền phải là number.
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { FinanceApi } from '../../services/api/src/http/finance-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const CASE = uid(21);
const SH = uid(31);
const PAT = uid(41);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const detail = { caseId: CASE, version: 4 } as never;
let replay = false;

const finance: FinanceApi = {
  async getSettings(o) { hit('getSettings', o); return { version: 0 } as never; },
  async updateSettings(i, v) { hit('updateSettings', { i, v }); return { version: v + 1 } as never; },
  async listPriceItems(o) { hit('listPriceItems', o); return []; },
  async createPriceItem(i) { hit('createPriceItem', i); return { version: 1 } as never; },
  async updatePriceItem(id, i, v) { hit('updatePriceItem', { id, i, v }); return { version: v + 1 } as never; },
  async myShift(o) { hit('myShift', o); return null; },
  async openShift(i) { hit('openShift', i); return { version: 1 } as never; },
  async closeShift(id, i, v) { hit('closeShift', { id, i, v }); return { version: v + 1 } as never; },
  async getShift(id) { hit('getShift', id); return { version: 2 } as never; },
  async listShifts(q) { hit('listShifts', q); return []; },
  async report(q) { hit('report', q); return { from: q.from } as never; },
  async listCases(q) { hit('listCases', q); return []; },
  async openCase(i) { hit('openCase', i); return detail; },
  async getCase(id) { hit('getCase', id); return detail; },
  async addCharge(id, i) { hit('addCharge', { id, i }); return detail; },
  async voidCharge(id, i) { hit('voidCharge', { id, i }); return detail; },
  async closeCase(id, v) { hit('closeCase', { id, v }); return detail; },
  async createReceipt(i, k) { hit('createReceipt', { i, k }); return { value: { receipt: { receiptNo: 'PT2026-000001' }, case: detail } as never, replayed: replay }; },
  async cancelReceipt(id, i) { hit('cancelReceipt', { id, i }); return detail; },
};

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, auth = true) {
  const headers: Record<string, string> = { ...extra };
  if (auth) {
    headers['authorization'] = `Bearer ${await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['clinic_staff'] })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-x').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey)}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, etag: r.headers.get('etag'), replayed: r.headers.get('idempotent-replayed'), json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, finance });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; replay = false; });

const RECEIPT = { organizationId: OA, patientId: PAT, kind: 'deposit', method: 'cash', amount: 500000 };

describe('HTTP thu ngân', () => {
  it('cần đăng nhập', async () => {
    expect((await call('GET', `/api/finance/shifts/mine?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    expect((await call('POST', '/api/finance/receipts', RECEIPT, { 'idempotency-key': 'k-12345678' }, false)).status).toBe(401);
  });

  it('lập phiếu: thiếu Idempotency-Key => 428; có => 201; gửi lại => header Idempotent-Replayed', async () => {
    expect((await call('POST', '/api/finance/receipts', RECEIPT)).status).toBe(428);
    const r = await call('POST', '/api/finance/receipts', RECEIPT, { 'idempotency-key': 'k-12345678' });
    expect(r.status).toBe(201);
    expect(r.replayed).toBeNull();
    expect(calls.at(-1)).toEqual({ fn: 'createReceipt', arg: { i: { ...RECEIPT, reference: null, payerName: null }, k: 'k-12345678' } });
    replay = true;
    expect((await call('POST', '/api/finance/receipts', RECEIPT, { 'idempotency-key': 'k-12345678' })).replayed).toBe('true');
    expect((await call('POST', '/api/finance/receipts', { ...RECEIPT, amount: '500000' }, { 'idempotency-key': 'k-2' })).status).toBe(400);
    expect((await call('POST', '/api/finance/receipts', { ...RECEIPT, discount: 1 }, { 'idempotency-key': 'k-3' })).status).toBe(400);
  });

  it('If-Match bắt buộc khi đóng ca / đóng hồ sơ / sửa giá; W/"0" khi tạo cài đặt lần đầu', async () => {
    expect((await call('POST', `/api/finance/shifts/${SH}/close`, { countedCash: 1 })).status).toBe(428);
    expect((await call('POST', `/api/finance/shifts/${SH}/close`, { countedCash: 1, note: 'ok' }, { 'if-match': 'W/"3"' })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'closeShift', arg: { id: SH, i: { countedCash: 1, note: 'ok' }, v: 3 } });
    expect((await call('POST', `/api/finance/cases/${CASE}/close`, undefined, { 'if-match': 'W/"4"' })).status).toBe(200);
    const st = await call('POST', '/api/finance/settings', { organizationId: OA, depositDefault: 500000, bank: null }, { 'if-match': 'W/"0"' });
    expect([st.status, st.etag]).toEqual([200, 'W/"1"']);
    expect((await call('POST', '/api/finance/settings', { organizationId: OA, depositDefault: 500000, bank: 'x' }, { 'if-match': 'W/"1"' })).status).toBe(400);
  });

  it('đi đúng hàm: ca của tôi, mở hồ sơ, chi phí, gỡ, huỷ phiếu; "mine" không nhầm với :id', async () => {
    expect((await call('GET', `/api/finance/shifts/mine?organization=${OA}`)).json).toEqual({ shift: null });
    expect(calls.at(-1)?.fn).toBe('myShift');
    await call('GET', `/api/finance/shifts/${SH}`);
    expect(calls.at(-1)).toEqual({ fn: 'getShift', arg: SH });
    await call('POST', '/api/finance/cases', { organizationId: OA, patientId: PAT });
    expect(calls.at(-1)).toEqual({ fn: 'openCase', arg: { organizationId: OA, patientId: PAT } });
    expect((await call('POST', `/api/finance/cases/${CASE}/charges`, { itemId: uid(51), quantity: 2 })).status).toBe(201);
    await call('POST', `/api/finance/charges/${uid(61)}/void`, { reason: 'Nhầm' });
    expect(calls.at(-1)).toEqual({ fn: 'voidCharge', arg: { id: uid(61), i: { reason: 'Nhầm' } } });
    await call('POST', `/api/finance/receipts/${uid(71)}/cancel`, { reason: 'Khách đổi ý' });
    expect(calls.at(-1)?.fn).toBe('cancelReceipt');
    await call('GET', `/api/finance/cases?organization=${OA}&status=open&patient=${PAT}`);
    expect(calls.at(-1)).toEqual({ fn: 'listCases', arg: { organizationId: OA, status: 'open', patientId: PAT } });
    expect((await call('GET', `/api/finance/cases?organization=${OA}&x=1`)).status).toBe(400);
    await call('GET', `/api/finance/reports?organization=${OA}&from=2026-11-01&to=2026-11-20`);
    expect(calls.at(-1)).toEqual({ fn: 'report', arg: { organizationId: OA, from: '2026-11-01', to: '2026-11-20' } });
    expect((await call('GET', `/api/finance/reports?organization=${OA}`, undefined, {}, false)).status).toBe(401);
  });
});
