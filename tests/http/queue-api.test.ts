/**
 * HCOS-F6 | HTTP: route hàng đợi (API giả) + màn hình gọi số công khai (không cần token, chỉ khoá hiển thị).
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { QueueApi } from '../../services/api/src/http/queue-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const SP = uid(21);
const TK = uid(31);
const PAT = uid(41);
const KEY = 'k'.repeat(43);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const ticket = { ticketId: TK, status: 'waiting' } as never;

const queue: QueueApi = {
  async listServicePoints(o) { hit('listServicePoints', o); return []; },
  async createServicePoint(i) { hit('createServicePoint', i); return { version: 1 } as never; },
  async setServicePointActive(id, a, v) { hit('setServicePointActive', { id, a, v }); return { version: v + 1 } as never; },
  async issueTicket(i) { hit('issueTicket', i); return ticket; },
  async requeueTicket(id) { hit('requeue', id); return ticket; },
  async cancelTicket(id) { hit('cancel', id); return ticket; },
  async listToday(q) { hit('listToday', q); return []; },
  async callNext(id) { hit('callNext', id); return null; },
  async recallTicket(id) { hit('recall', id); return ticket; },
  async skipTicket(id) { hit('skip', id); return ticket; },
  async startTicket(id, i) { hit('start', { id, i }); return { ticket, encounterId: uid(51) }; },
  async createDisplay(i) { hit('createDisplay', i); return { display: {} as never, key: KEY }; },
  async listDisplays(o) { hit('listDisplays', o); return []; },
  async revokeDisplay(id, o) { hit('revokeDisplay', { id, o }); return {} as never; },
};
let boardFail = false;
const queueBoard = {
  async read(key: string) {
    hit('board', key);
    if (boardFail) throw new Error('db down');
    return key === KEY ? { displayName: 'Sảnh', organizationName: 'PK', called: [], waiting: [] } : null;
  },
};

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, auth = true) {
  const headers: Record<string, string> = { ...extra };
  if (auth) {
    headers['authorization'] = `Bearer ${await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['doctor'] })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-x').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey)}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, cache: r.headers.get('cache-control'), json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, queue, queueBoard });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; boardFail = false; });

describe('HTTP hàng đợi', () => {
  it('cấp số / gọi / bắt đầu khám đi đúng hàm; trường lạ => 400', async () => {
    expect((await call('POST', '/api/queue/tickets', { servicePointId: SP, patientId: PAT, priorityReason: 'elderly_75' })).status).toBe(201);
    expect(calls.at(-1)).toEqual({ fn: 'issueTicket', arg: { servicePointId: SP, patientId: PAT, priorityReason: 'elderly_75' } });
    expect((await call('POST', '/api/queue/tickets', { servicePointId: SP, patientId: PAT, x: 1 })).status).toBe(400);
    expect((await call('POST', `/api/queue/service-points/${SP}/call-next`)).json).toEqual({ ticket: null });
    for (const a of ['recall', 'skip', 'requeue', 'cancel']) {
      expect((await call('POST', `/api/queue/tickets/${TK}/${a}`)).status).toBe(200);
      expect(calls.at(-1)).toEqual({ fn: a, arg: TK });
    }
    await call('POST', `/api/queue/tickets/${TK}/start`);
    expect(calls.at(-1)).toEqual({ fn: 'start', arg: { id: TK, i: { reasonText: null } } });
    await call('POST', `/api/queue/tickets/${TK}/start`, { encounterClass: 'emergency', reasonText: 'Khó thở' });
    expect(calls.at(-1)).toEqual({ fn: 'start', arg: { id: TK, i: { encounterClass: 'emergency', reasonText: 'Khó thở' } } });
  });

  it('danh sách cần organization; tham số lạ => 400; đổi trạng thái phòng cần If-Match', async () => {
    await call('GET', `/api/queue?organization=${OA}&servicePoint=${SP}`);
    expect(calls.at(-1)).toEqual({ fn: 'listToday', arg: { organizationId: OA, servicePointId: SP } });
    expect((await call('GET', '/api/queue')).status).toBe(400);
    expect((await call('GET', `/api/queue?organization=${OA}&all=1`)).status).toBe(400);
    expect((await call('POST', `/api/service-points/${SP}/active`, { isActive: false })).status).toBe(428);
    expect((await call('POST', `/api/service-points/${SP}/active`, { isActive: false }, { 'if-match': 'W/"2"' })).status).toBe(200);
  });

  it('tạo màn hình: không cache (khoá chỉ hiện một lần)', async () => {
    const r = await call('POST', '/api/queue/displays', { organizationId: OA, name: 'Sảnh' });
    expect(r.status).toBe(201);
    expect(r.json.key).toBe(KEY);
    expect(r.cache).toBe('no-store');
  });
});

describe('Màn hình gọi số công khai', () => {
  it('không cần token; khoá đúng => 200; sai / thiếu => 404; lỗi DB => 503; luôn no-store', async () => {
    const ok = await call('GET', '/api/public/queue-board', undefined, { 'x-display-key': KEY }, false);
    expect(ok.status).toBe(200);
    expect(ok.json.displayName).toBe('Sảnh');
    expect(ok.cache).toBe('no-store');
    expect((await call('GET', '/api/public/queue-board', undefined, { 'x-display-key': 'z'.repeat(43) }, false)).status).toBe(404);
    expect((await call('GET', '/api/public/queue-board', undefined, {}, false)).status).toBe(404);
    boardFail = true;
    expect((await call('GET', '/api/public/queue-board', undefined, { 'x-display-key': KEY }, false)).status).toBe(503);
  });

  it('các route hàng đợi khác vẫn bắt buộc đăng nhập', async () => {
    expect((await call('GET', `/api/queue?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    expect((await call('POST', `/api/queue/service-points/${SP}/call-next`, undefined, {}, false)).status).toBe(401);
  });
});
