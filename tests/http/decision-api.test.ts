/** HCOS-F11 | HTTP: route Decision Engine + hộp thông báo (API giả) — đi đúng hàm, tham số, If-Match, cần đăng nhập. */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { DecisionApi } from '../../services/api/src/http/decision-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const RULE = uid(31);
const NOTE = uid(41);
let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const decision: DecisionApi = {
  catalog() { hit('catalog', null); return { detectors: [], actions: [], ops: [], notifyRoles: [] } as never; },
  async overview(o) { hit('overview', o); return {} as never; },
  async listRules(o) { hit('listRules', o); return []; },
  async createRule(i) { hit('createRule', i); return { version: 1 } as never; },
  async updateRule(id, i, v) { hit('updateRule', { id, i, v }); return { version: v + 1 } as never; },
  async setRuleStatus(id, s, v) { hit('setRuleStatus', { id, s, v }); return { version: v + 1 } as never; },
  async ruleVersions(id) { hit('ruleVersions', id); return []; },
  async preview(i) { hit('preview', i); return { candidates: 0, matched: 0, suppressed: 0, sample: [] }; },
  async events(q) { hit('events', q); return []; },
  async actionLog(q) { hit('actionLog', q); return []; },
  async runs(q) { hit('runs', q); return []; },
  async runNow(o) { hit('runNow', o); return {} as never; },
  async inbox(q) { hit('inbox', q); return { items: [], openCount: 0 }; },
  async actOnNotification(id, a, note, v) { hit('act', { id, a, note, v }); return { link: '#/forecast', item: { version: v + 1 } as never }; },
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
  server = createApiServer({ tenant: { issuer: 'https://idp.test', audience: 'api', key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, decision });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; });

const rule = { name: 'SpO2 thấp', conditions: [{ metric: 'spo2_pct', op: '<', value: 92 }], priority: 1, cooldownMinutes: 60, actions: ['notify_doctor'] };

describe('HTTP Decision Engine', () => {
  it('cần đăng nhập; đọc đi đúng hàm; tham số lạ / lặp / sai kiểu bị từ chối', async () => {
    expect((await call('GET', `/api/decision/rules?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    expect((await call('GET', `/api/notifications?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    await call('GET', '/api/decision/catalog');
    await call('GET', `/api/decision/overview?organization=${OA}`);
    await call('GET', `/api/decision/rules?organization=${OA}`);
    await call('GET', `/api/decision/events?organization=${OA}&limit=50&priority=1&detector=vital_abnormal`);
    await call('GET', `/api/decision/actions?organization=${OA}`);
    await call('GET', `/api/decision/runs?organization=${OA}&limit=10`);
    await call('GET', `/api/decision/rules/${RULE}/versions`);
    expect(calls.map((c) => c.fn)).toEqual(['catalog', 'overview', 'listRules', 'events', 'actionLog', 'runs', 'ruleVersions']);
    expect(calls[3]!.arg).toEqual({ organizationId: OA, limit: 50, priority: 1, detector: 'vital_abnormal' });
    expect((await call('GET', `/api/decision/events?organization=${OA}&limit=abc`)).status).toBe(400);
    expect((await call('GET', `/api/decision/events?organization=${OA}&organization=${OA}`)).status).toBe(400);
    expect((await call('GET', `/api/decision/rules?organization=${OA}&x=1`)).status).toBe(400);
    expect((await call('GET', `/api/notifications?organization=${OA}&all=yes`)).status).toBe(400);
    await call('GET', `/api/notifications?organization=${OA}&all=1`);
    expect(calls.at(-1)).toEqual({ fn: 'inbox', arg: { organizationId: OA, all: true } });
  });
  it('luật: tạo 201 + ETag; sửa / đổi trạng thái cần If-Match; trường lạ bị từ chối', async () => {
    const c = await call('POST', '/api/decision/rules', { organizationId: OA, detector: 'vital_abnormal', ...rule });
    expect(c).toEqual({ status: 201, etag: 'W/"1"' });
    expect((await call('POST', '/api/decision/rules', { organizationId: OA, detector: 'vital_abnormal', ...rule, status: 'active' })).status).toBe(400);
    expect((await call('POST', '/api/decision/rules', { organizationId: OA, detector: 'vital_abnormal', ...rule, priority: '1' })).status).toBe(400);
    expect((await call('POST', `/api/decision/rules/${RULE}`, rule)).status).toBe(428);
    expect((await call('POST', `/api/decision/rules/${RULE}`, { ...rule, detector: 'x' }, { 'if-match': 'W/"1"' })).status).toBe(400);
    expect(await call('POST', `/api/decision/rules/${RULE}`, rule, { 'if-match': 'W/"1"' })).toEqual({ status: 200, etag: 'W/"2"' });
    expect(await call('POST', `/api/decision/rules/${RULE}/status`, { status: 'paused' }, { 'if-match': 'W/"2"' })).toEqual({ status: 200, etag: 'W/"3"' });
    expect(calls.map((x) => x.fn)).toEqual(['createRule', 'updateRule', 'setRuleStatus']);
    expect(calls[2]!.arg).toEqual({ id: RULE, s: 'paused', v: 2 });
  });
  it('thử luật / chạy ngay / xử lý thông báo', async () => {
    await call('POST', '/api/decision/preview', { organizationId: OA, detector: 'vital_abnormal', conditions: rule.conditions, cooldownMinutes: 60 });
    await call('POST', '/api/decision/run', { organizationId: OA });
    expect((await call('POST', `/api/notifications/${NOTE}`, { action: 'apply' })).status).toBe(428);
    expect((await call('POST', `/api/notifications/${NOTE}`, { action: 'apply', extra: 1 }, { 'if-match': 'W/"1"' })).status).toBe(400);
    expect(await call('POST', `/api/notifications/${NOTE}`, { action: 'apply', note: 'ok' }, { 'if-match': 'W/"1"' })).toEqual({ status: 200, etag: 'W/"2"' });
    expect(calls.map((x) => x.fn)).toEqual(['preview', 'runNow', 'act']);
    expect(calls[2]!.arg).toEqual({ id: NOTE, a: 'apply', note: 'ok', v: 1 });
  });
});
