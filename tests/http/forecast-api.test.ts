/** HCOS-F10 | HTTP: route dự báo (API giả) — đi đúng hàm, tham số, If-Match, cần đăng nhập. */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { ForecastApi } from '../../services/api/src/http/forecast-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const SP = uid(21);
let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const forecast: ForecastApi = {
  async load(q) { hit('load', q); return {} as never; },
  async inventory(o) { hit('inventory', o); return {} as never; },
  async cashflowBase(o) { hit('cashflow', o); return {} as never; },
  async getSettings(o) { hit('getSettings', o); return { version: 0 } as never; },
  async updateSettings(i, v) { hit('updateSettings', { i, v }); return { version: v + 1 } as never; },
  async setVisitCapacity(id, c, v) { hit('capacity', { id, c, v }); return { servicePointId: id, visitCapacity: c, version: v + 1 }; },
};
let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, auth = true) {
  const headers: Record<string, string> = { ...extra };
  if (auth) {
    headers['authorization'] = `Bearer ${await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['clinic_admin'] })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-x').setIssuer('https://idp.test').setAudience('api').setIssuedAt().setExpirationTime('5m').sign(privateKey)}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, etag: r.headers.get('etag') };
}
beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: 'https://idp.test', audience: 'api', key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, forecast });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; });

describe('HTTP dự báo', () => {
  it('cần đăng nhập; tải / tồn kho / dòng tiền đi đúng hàm; days phải là số', async () => {
    expect((await call('GET', `/api/forecast/load?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    await call('GET', `/api/forecast/load?organization=${OA}&days=30`);
    expect(calls.at(-1)).toEqual({ fn: 'load', arg: { organizationId: OA, days: 30 } });
    expect((await call('GET', `/api/forecast/load?organization=${OA}&days=abc`)).status).toBe(400);
    await call('GET', `/api/forecast/inventory?organization=${OA}`);
    await call('GET', `/api/forecast/cashflow?organization=${OA}`);
    expect(calls.map((c) => c.fn)).toEqual(['load', 'inventory', 'cashflow']);
  });
  it('thông số và sức khám: If-Match bắt buộc; số phải là number; null = bỏ khai báo', async () => {
    const body = { organizationId: OA, fixedCostsMonthly: 60000000, variableCostPct: 30, leadTimeDays: 3, serviceLevelPct: 95 };
    expect((await call('POST', '/api/forecast/settings', body)).status).toBe(428);
    expect((await call('POST', '/api/forecast/settings', { ...body, leadTimeDays: '3' }, { 'if-match': 'W/"0"' })).status).toBe(400);
    expect((await call('POST', '/api/forecast/settings', body, { 'if-match': 'W/"0"' })).etag).toBe('W/"1"');
    expect((await call('POST', `/api/forecast/capacity/${SP}`, { visitCapacity: null }, { 'if-match': 'W/"4"' })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'capacity', arg: { id: SP, c: null, v: 4 } });
    expect((await call('POST', `/api/forecast/capacity/${SP}`, { visitCapacity: '15' }, { 'if-match': 'W/"4"' })).status).toBe(400);
  });
});
