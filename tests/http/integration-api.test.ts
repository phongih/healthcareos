/** HCOS-F12 | HTTP: route tích hợp (API giả) — đúng hàm, tham số, If-Match, no-store cho bí mật, cần đăng nhập. */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { IntegrationApi } from '../../services/api/src/http/integration-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const EP = uid(21);
const DL = uid(31);
let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const ep = (v: number) => ({ endpointId: EP, version: v }) as never;
const api: IntegrationApi = {
  catalog() { hit('catalog', null); return {} as never; },
  async overview(o) { hit('overview', o); return {} as never; },
  async listEndpoints(o) { hit('listEndpoints', o); return []; },
  async createEndpoint(i) { hit('createEndpoint', i); return { endpoint: ep(1), signingSecret: 'whsec_x' }; },
  async updateEndpoint(id, i, v) { hit('updateEndpoint', { id, i, v }); return { endpoint: ep(v + 1), signingSecret: null }; },
  async setEndpointStatus(id, s, v) { hit('setEndpointStatus', { id, s, v }); return { endpoint: ep(v + 1), cancelledStale: 0 }; },
  async testEndpoint(id) { hit('testEndpoint', id); return { deliveryId: DL, outcome: 'success', statusCode: 202, error: null, durationMs: 1 }; },
  async endpointHistory(id) { hit('endpointHistory', id); return []; },
  async deliveries(q) { hit('deliveries', q); return []; },
  async deliveryAttempts(id) { hit('deliveryAttempts', id); return []; },
  async retryDelivery(id) { hit('retryDelivery', id); return { deliveryId: DL, outcome: 'success', statusCode: 202, error: null, durationMs: 1 }; },
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
  return { status: r.status, etag: r.headers.get('etag'), cache: r.headers.get('cache-control') };
}
beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: 'https://idp.test', audience: 'api', key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, integrations: api });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; });

const body = { organizationId: OA, kind: 'teams_workflow', name: 'Kênh trực', url: 'https://x.logic.azure.com/workflows/a', eventTypes: ['decision.event'], maxPriority: 1 };

describe('HTTP tích hợp', () => {
  it('cần đăng nhập; đọc đúng hàm; tham số lạ / lặp bị từ chối', async () => {
    expect((await call('GET', `/api/integrations/endpoints?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    await call('GET', '/api/integrations/catalog');
    await call('GET', `/api/integrations/overview?organization=${OA}`);
    await call('GET', `/api/integrations/endpoints?organization=${OA}`);
    await call('GET', `/api/integrations/endpoints/${EP}/history`);
    await call('GET', `/api/integrations/deliveries?organization=${OA}&endpoint=${EP}&status=dead&limit=20`);
    await call('GET', `/api/integrations/deliveries/${DL}/attempts`);
    expect(calls.map((c) => c.fn)).toEqual(['catalog', 'overview', 'listEndpoints', 'endpointHistory', 'deliveries', 'deliveryAttempts']);
    expect(calls[4]!.arg).toEqual({ organizationId: OA, endpointId: EP, status: 'dead', limit: 20 });
    expect((await call('GET', `/api/integrations/deliveries?organization=${OA}&limit=x`)).status).toBe(400);
    expect((await call('GET', `/api/integrations/endpoints?organization=${OA}&organization=${OA}`)).status).toBe(400);
  });
  it('tạo 201 + no-store (bí mật một lần); sửa / trạng thái cần If-Match; trường lạ / sai kiểu bị từ chối', async () => {
    expect(await call('POST', '/api/integrations/endpoints', body)).toEqual({ status: 201, etag: 'W/"1"', cache: 'no-store' });
    expect((await call('POST', '/api/integrations/endpoints', { ...body, secret: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/integrations/endpoints', { ...body, maxPriority: '1' })).status).toBe(400);
    const upd = { name: 'Kênh trực', eventTypes: ['decision.event'], maxPriority: 2 };
    expect((await call('POST', `/api/integrations/endpoints/${EP}`, upd)).status).toBe(428);
    expect((await call('POST', `/api/integrations/endpoints/${EP}`, { ...upd, rotateSecret: 'yes' }, { 'if-match': 'W/"1"' })).status).toBe(400);
    expect(await call('POST', `/api/integrations/endpoints/${EP}`, { ...upd, url: 'https://x.logic.azure.com/workflows/b', rotateSecret: false }, { 'if-match': 'W/"1"' })).toEqual({ status: 200, etag: 'W/"2"', cache: 'no-store' });
    expect((await call('POST', `/api/integrations/endpoints/${EP}/status`, { status: 'paused' }, { 'if-match': 'W/"2"' })).etag).toBe('W/"3"');
    expect(calls.map((c) => c.fn)).toEqual(['createEndpoint', 'updateEndpoint', 'setEndpointStatus']);
    expect(calls[1]!.arg).toEqual({ id: EP, i: { ...upd, url: 'https://x.logic.azure.com/workflows/b' }, v: 1 });
  });
  it('gửi thử / gửi lại', async () => {
    expect((await call('POST', `/api/integrations/endpoints/${EP}/test`)).status).toBe(200);
    expect((await call('POST', `/api/integrations/deliveries/${DL}/retry`)).status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(['testEndpoint', 'retryDelivery']);
  });
});
