/**
 * HCOS-F14 | HTTP: route quầy trả (API giả) — đi đúng hàm, kiểm tham số / body, If-Match.
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { HandoverApi } from '../../services/api/src/http/handover-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const DESK = uid(21);
const H = uid(31);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const view = { handoverId: H, status: 'ready' } as never;

const handover: HandoverApi = {
  async listDesks(o) { hit('listDesks', o); return []; },
  async createDesk(i) { hit('createDesk', i); return { version: 1 } as never; },
  async setDeskActive(id, a, v) { hit('setDeskActive', { id, a, v }); return { version: v + 1 } as never; },
  async listToday(q) { hit('listToday', q); return []; },
  async get(id) { hit('get', id); return view; },
  async markPrepared(id, i) { hit('prepared', { id, i }); return view; },
  async callNext(id) { hit('callNext', id); return null; },
  async recall(id) { hit('recall', id); return view; },
  async skip(id) { hit('skip', id); return view; },
  async release(id) { hit('release', id); return view; },
  async requeue(id) { hit('requeue', id); return view; },
  async cancel(id, i) { hit('cancel', { id, i }); return view; },
  async complete(id, i) { hit('complete', { id, i }); return view; },
};

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  headers['authorization'] = `Bearer ${await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['pharmacist'] })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-x').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, etag: r.headers.get('etag'), json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, handover });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; });

describe('HTTP quầy trả', () => {
  it('quầy: danh sách / tạo / bật tắt (If-Match) / gọi tiếp', async () => {
    expect((await call('GET', `/api/handover/desks?organization=${OA}`)).json).toEqual({ desks: [] });
    const c = await call('POST', '/api/handover/desks', { organizationId: OA, code: 'Q1', name: 'Quầy 1' });
    expect(c.status).toBe(201);
    expect(c.etag).toBe('W/"1"');
    expect((await call('POST', '/api/handover/desks', { organizationId: OA, code: 'Q1', name: 'Quầy 1', x: 1 })).status).toBe(400);
    expect((await call('POST', `/api/handover/desks/${DESK}/active`, { isActive: false })).status).toBe(428);
    expect((await call('POST', `/api/handover/desks/${DESK}/active`, { isActive: false }, { 'if-match': 'W/"3"' })).etag).toBe('W/"4"');
    expect((await call('POST', `/api/handover/desks/${DESK}/call-next`)).json).toEqual({ handover: null });
    expect(calls.map((x) => x.fn)).toEqual(['listDesks', 'createDesk', 'setDeskActive', 'callNext']);
  });

  it('danh sách: includeDone chỉ nhận 0/1; tham số lạ => 400; thiếu organization => 400', async () => {
    await call('GET', `/api/handover?organization=${OA}&includeDone=1`);
    expect(calls.at(-1)).toEqual({ fn: 'listToday', arg: { organizationId: OA, includeDone: true } });
    expect((await call('GET', `/api/handover?organization=${OA}&includeDone=yes`)).status).toBe(400);
    expect((await call('GET', `/api/handover?organization=${OA}&x=1`)).status).toBe(400);
    expect((await call('GET', '/api/handover')).status).toBe(400);
  });

  it('thao tác trên phiếu: đúng hàm, body đúng; id không phải UUID => 404', async () => {
    await call('POST', `/api/handover/${H}/prepared`, { note: 'Hết Amoxicillin' });
    await call('POST', `/api/handover/${H}/prepared`);
    for (const a of ['recall', 'skip', 'release', 'requeue']) await call('POST', `/api/handover/${H}/${a}`);
    await call('POST', `/api/handover/${H}/cancel`, { note: 'Về trước' });
    await call('POST', `/api/handover/${H}/complete`, { checklist: { medication: true, documents: 'returned' } });
    expect(calls.map((x) => x.fn)).toEqual(['prepared', 'prepared', 'recall', 'skip', 'release', 'requeue', 'cancel', 'complete']);
    expect(calls[0]!.arg).toEqual({ id: H, i: { note: 'Hết Amoxicillin' } });
    expect(calls[1]!.arg).toEqual({ id: H, i: { note: null } });
    expect(calls.at(-1)!.arg).toEqual({ id: H, i: { checklist: { medication: true, documents: 'returned' }, note: null } });
    expect((await call('POST', `/api/handover/${H}/complete`)).status).toBe(400);
    expect((await call('POST', `/api/handover/${H}/cancel`, { note: 5 })).status).toBe(400);
    expect((await call('POST', '/api/handover/abc/recall')).status).toBe(404);
    expect((await call('GET', `/api/handover/${H}`)).json).toEqual(view);
  });
});
