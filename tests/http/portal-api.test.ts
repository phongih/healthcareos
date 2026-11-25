/**
 * HCOS-F20 | HTTP cổng bệnh nhân (API giả): token cổng KHÔNG dùng được ở API nội bộ, JWT nhân viên KHÔNG dùng được ở cổng;
 * danh sách trường cho phép, không nhận query, lỗi cổng => OperationOutcome có lý do, giới hạn theo IP.
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import type { PortalApi } from '../../services/api/src/http/portal-routes';
import { createApiServer } from '../../services/api/src/http/server';
import { PortalError } from '../../services/api/src/portal/portal.service';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const PID = uid(21);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';
const TOKEN = 'hpt_' + 'A'.repeat(43);

let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
const portal = {
  async info(slug: string) { hit('info', slug); return slug === 'pk-a' ? { organizationName: 'PK A', enabled: true, training: true } : null; },
  async start(slug: string, body: unknown) { hit('start', { slug, body }); return { challengeId: uid(31), expiresInSec: 300 }; },
  async verify(_s: string, body: Record<string, unknown>) {
    hit('verify', body);
    if (body['code'] !== '123456') throw new PortalError(401, 'OTP_INVALID', 'Wrong code (4 tries left)');
    return { token: TOKEN, expiresAt: '2026-11-23T12:00:00Z' };
  },
  async me(token: string) { hit('me', token); return { organizationName: 'PK A', profiles: [], contact: { phoneHint: null, emailHint: null }, training: true }; },
  async overview(token: string, pid: unknown) { hit('overview', { token, pid }); return { encounters: [], bookings: [], receipts: [] }; },
  async submitCorrection(token: string, body: unknown) { hit('correction', { token, body }); return { requestId: uid(41), status: 'open' }; },
  async viewShare(t: string, pin: unknown) { hit('viewShare', { t, pin }); throw new PortalError(423, 'SHARE_LOCKED', 'SHARE_LOCKED'); },
  async logout(token: string) { hit('logout', token); return { ok: true }; },
} as unknown as PortalApi;

let base: string;
let server: ReturnType<typeof createApiServer>;
let jwt: string;

async function call(method: string, path: string, body?: unknown, auth?: string) {
  const headers: Record<string, string> = {};
  if (auth) headers['authorization'] = auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const json = text ? JSON.parse(text) : undefined;
  return { status: r.status, json, reason: json?.issue?.[0]?.details?.text as string | undefined, cache: r.headers.get('cache-control') };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  jwt = await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['clinic_staff'] })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-x').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(kp.privateKey);
  server = createApiServer({ tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, portal });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { calls = []; });

describe('HTTP cổng bệnh nhân', () => {
  it('token cổng bị API nội bộ từ chối; JWT nhân viên bị cổng từ chối', async () => {
    for (const path of ['/api/me', `/fhir/Patient/${PID}`, `/api/portal-admin/patients/${PID}`]) {
      expect((await call('GET', path, undefined, `Portal ${TOKEN}`)).status).toBe(401);
      expect((await call('GET', path, undefined, `Bearer ${TOKEN}`)).status).toBe(401);
    }
    const r = await call('GET', '/api/portal/me', undefined, `Bearer ${jwt}`);
    expect([r.status, r.reason]).toEqual([401, 'SESSION_INVALID']);
    expect((await call('GET', '/api/portal/me')).status).toBe(401);
    expect(calls).toEqual([]);
    const ok = await call('GET', '/api/portal/me', undefined, `Portal ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.cache).toBe('no-store');
    expect(calls).toEqual([{ fn: 'me', arg: TOKEN }]);
  });

  it('công khai: info / otp / session; lỗi cổng => lý do; trường lạ / query => 400', async () => {
    expect((await call('GET', '/api/portal/pk-a/info')).json).toMatchObject({ organizationName: 'PK A' });
    expect((await call('GET', '/api/portal/khong-co/info')).status).toBe(404);
    expect((await call('POST', '/api/portal/pk-a/otp', { method: 'phone', phone: '0912000001' })).status).toBe(200);
    expect((await call('POST', '/api/portal/pk-a/otp', { method: 'phone', phone: '0912000001', personId: PID })).status).toBe(400);
    expect((await call('GET', '/api/portal/pk-a/info?x=1')).status).toBe(400);
    const bad = await call('POST', '/api/portal/pk-a/session', { challengeId: uid(31), code: '000000' });
    expect([bad.status, bad.reason]).toEqual([401, 'OTP_INVALID']);
    expect((await call('POST', '/api/portal/pk-a/session', { challengeId: uid(31), code: '123456' })).json).toMatchObject({ token: TOKEN });
    const sv = await call('POST', '/api/portal/share-view', { token: 'hps_x', pin: '123456' });
    expect([sv.status, sv.reason]).toEqual([423, 'SHARE_LOCKED']);
    expect((await call('DELETE', '/api/portal/me', undefined, `Portal ${TOKEN}`)).status).toBe(405);
  });

  it('trong phiên: đúng hàm, 201 khi tạo; personId trong đường dẫn', async () => {
    await call('GET', `/api/portal/profiles/${PID}`, undefined, `Portal ${TOKEN}`);
    const c = await call('POST', '/api/portal/requests/correction', { personId: PID, message: 'Sai ngày sinh của tôi' }, `Portal ${TOKEN}`);
    expect(c.status).toBe(201);
    expect(calls.map((x) => x.fn)).toEqual(['overview', 'correction']);
    expect(calls[0]!.arg).toEqual({ token: TOKEN, pid: PID });
  });

  it('giới hạn theo IP: quá 10 lần yêu cầu OTP / 15 phút => 429', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/portal/pk-a/otp', { method: 'phone', phone: '0912000001' })).status;
    expect(last).toBe(429);
  });
});
