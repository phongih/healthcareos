/**
 * HCOS-F7 | HTTP: route lịch hẹn (API giả) + cổng đặt lịch công khai (không token, giới hạn tần suất theo IP).
 */
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId } from '../../packages/domain/src/s0-contracts';
import { ClinicalError } from '../../services/api/src/clinical/encounter.service';
import { clientIp, RateLimiter, type BookingApi, type PublicBookingApi } from '../../services/api/src/http/booking-routes';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import { createApiServer } from '../../services/api/src/http/server';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const SP = uid(21);
const BK = uid(31);
const PAT = uid(41);
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

let calls: Array<{ fn: string; arg: unknown }>;
const hit = (fn: string, arg: unknown) => { calls.push({ fn, arg }); };
let mode: 'ok' | 'full' | 'crash' = 'ok';

const bookings: BookingApi = {
  async listForDay(q) { hit('listForDay', q); return []; },
  async findByCode(q) { hit('findByCode', q); return q.code === 'ABCD-2345' ? ({ booking: { bookingId: BK }, candidates: [] } as never) : null; },
  async getById(id) { hit('getById', id); return { booking: { bookingId: id }, candidates: [] } as never; },
  async checkIn(id, i) { hit('checkIn', { id, i }); return { booking: {}, ticket: {} } as never; },
  async cancel(id) { hit('cancel', id); return {} as never; },
  async setBookingCapacity(id, c, v) { hit('capacity', { id, c, v }); return { version: v + 1 } as never; },
  async getPortal(o) { hit('getPortal', o); return null; },
  async createPortal(i) { hit('createPortal', i); return { version: 1 } as never; },
  async setPortalActive(i, v) { hit('setPortalActive', { i, v }); return { version: v + 1 } as never; },
};
const publicBooking: PublicBookingApi = {
  async options(slug) { hit('options', slug); return slug === 'pk-a' ? ({ rooms: [], slots: [] } as never) : null; },
  async create(slug, i) {
    hit('create', { slug, i });
    if (mode === 'full') throw new ClinicalError('CONFLICT', 'This session is fully booked', { reason: 'SESSION_FULL' });
    if (mode === 'crash') throw new Error('secret internal detail');
    return slug === 'pk-a' ? ({ code: 'ABCD-2345' } as never) : null;
  },
  async lookup(slug, code, phone) { hit('lookup', { slug, code, phone }); return slug === 'pk-a' && code === 'ABCD-2345' && phone === '0912345678' ? ({ status: 'booked' } as never) : null; },
  async cancel(slug, code, phone) { hit('pcancel', { slug, code, phone }); return null; },
};

let base: string;
let server: ReturnType<typeof createApiServer>;
let privateKey: any;
let now = 0;
const limiter = new RateLimiter(() => now);

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, auth = true) {
  const headers: Record<string, string> = { ...extra };
  if (auth) {
    headers['authorization'] = `Bearer ${await new SignJWT({ tenant_id: TA, org_id: OA, roles: ['clinic_staff'] })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('sub-x').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey)}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, cache: r.headers.get('cache-control'), retry: r.headers.get('retry-after'), text, json: text ? JSON.parse(text) : undefined };
}

const FORM = {
  servicePointId: SP, visitDate: '2026-11-24', period: 'morning', familyName: 'Nguyễn', givenName: 'An', birthDate: '1950-03-04', sex: 'male',
  phone: '0912345678', consent: true, consentVersion: '2026-11',
};

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  server = createApiServer({
    tenant: { issuer: ISSUER, audience: AUDIENCE, key: kp.publicKey, algorithms: ['RS256'] }, clinical: {} as ClinicalApi, bookings, publicBooking, rateLimiter: limiter,
    logger: { error: () => {} },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
let ipSeq = 0;
beforeEach(() => { calls = []; mode = 'ok'; now += 3_600_000; ipSeq += 1; });
const ip = () => ({ 'x-forwarded-for': `203.0.113.${ipSeq}` });

describe('HTTP lịch hẹn (nhân viên)', () => {
  it('cần đăng nhập; đi đúng hàm; tra mã không thấy => 404; sức chứa cần If-Match', async () => {
    expect((await call('GET', `/api/bookings?organization=${OA}`, undefined, {}, false)).status).toBe(401);
    await call('GET', `/api/bookings?organization=${OA}&date=2026-11-24`);
    expect(calls.at(-1)).toEqual({ fn: 'listForDay', arg: { organizationId: OA, date: '2026-11-24' } });
    expect((await call('GET', `/api/bookings?organization=${OA}&x=1`)).status).toBe(400);
    expect((await call('GET', `/api/bookings/by-code?organization=${OA}&code=ABCD-2345`)).status).toBe(200);
    expect((await call('GET', `/api/bookings/by-code?organization=${OA}&code=ZZZZ-ZZZZ`)).status).toBe(404);
    expect((await call('GET', `/api/bookings/${BK}`)).status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'getById', arg: BK });
    expect((await call('GET', '/api/bookings/not-a-uuid')).status).toBe(404);
    await call('POST', `/api/bookings/${BK}/check-in`, { patientId: PAT, priorityReason: 'elderly_75' });
    expect(calls.at(-1)).toEqual({ fn: 'checkIn', arg: { id: BK, i: { patientId: PAT, priorityReason: 'elderly_75' } } });
    expect((await call('POST', `/api/bookings/${BK}/check-in`, { patientId: PAT, x: 1 })).status).toBe(400);
    expect((await call('POST', `/api/service-points/${SP}/booking-capacity`, { capacity: 10 })).status).toBe(428);
    expect((await call('POST', `/api/service-points/${SP}/booking-capacity`, { capacity: '10' }, { 'if-match': 'W/"3"' })).status).toBe(400);
    expect((await call('POST', `/api/service-points/${SP}/booking-capacity`, { capacity: 10 }, { 'if-match': 'W/"3"' })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'capacity', arg: { id: SP, c: 10, v: 3 } });
    expect((await call('POST', '/api/booking-portal', { organizationId: OA, slug: 'pk-a' })).status).toBe(201);
    expect((await call('POST', '/api/booking-portal/active', { organizationId: OA, isActive: false }, { 'if-match': 'W/"1"' })).status).toBe(200);
  });
});

describe('Cổng đặt lịch công khai', () => {
  it('không cần token; slug lạ / sai mã / sai SĐT => cùng một 404; luôn no-store', async () => {
    const o = await call('GET', '/api/public/booking/pk-a/options', undefined, ip(), false);
    expect(o.status).toBe(200);
    expect(o.cache).toBe('no-store');
    expect((await call('GET', '/api/public/booking/khac/options', undefined, ip(), false)).status).toBe(404);
    expect((await call('GET', '/api/public/booking/A_B/options', undefined, ip(), false)).status).toBe(404);
    expect((await call('GET', '/api/public/booking/pk-a/options?x=1', undefined, ip(), false)).status).toBe(400);
    expect((await call('POST', '/api/public/booking/pk-a/options', {}, ip(), false)).status).toBe(405);
    const good = await call('POST', '/api/public/booking/pk-a/lookup', { code: 'ABCD-2345', phone: '0912345678' }, ip(), false);
    expect(good.status).toBe(200);
    const wrong = await call('POST', '/api/public/booking/pk-a/lookup', { code: 'ABCD-2345', phone: '0999999999' }, ip(), false);
    const noPortal = await call('POST', '/api/public/booking/khac/lookup', { code: 'ABCD-2345', phone: '0912345678' }, ip(), false);
    expect([wrong.status, noPortal.status]).toEqual([404, 404]);
    expect(wrong.text).toBe(noPortal.text);
  });

  it('tạo lịch: 201 + mã; trường lạ => 400; hết chỗ => 409 SESSION_FULL; lỗi lạ => 500 không lộ chi tiết', async () => {
    const r = await call('POST', '/api/public/booking/pk-a/bookings', FORM, ip(), false);
    expect(r.status).toBe(201);
    expect(r.json.code).toBe('ABCD-2345');
    expect(calls.at(-1)).toEqual({ fn: 'create', arg: { slug: 'pk-a', i: { ...FORM, nationalId: null, reason: null } } });
    expect((await call('POST', '/api/public/booking/pk-a/bookings', { ...FORM, isAdmin: true }, ip(), false)).status).toBe(400);
    mode = 'full';
    const full = await call('POST', '/api/public/booking/pk-a/bookings', FORM, ip(), false);
    expect(full.status).toBe(409);
    expect(full.json.issue[0].details.text).toBe('SESSION_FULL');
    mode = 'crash';
    const crash = await call('POST', '/api/public/booking/pk-a/bookings', FORM, ip(), false);
    expect(crash.status).toBe(500);
    expect(crash.text).not.toContain('secret');
  });

  it('giới hạn tần suất: 5 lượt tạo / 10 phút mỗi IP => lượt 6 bị 429 + Retry-After; IP khác không bị ảnh hưởng', async () => {
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/public/booking/pk-a/bookings', FORM, ip(), false)).status).toBe(201);
    const blocked = await call('POST', '/api/public/booking/pk-a/bookings', FORM, ip(), false);
    expect(blocked.status).toBe(429);
    expect(blocked.retry).toBe('600');
    expect(calls.filter((c) => c.fn === 'create')).toHaveLength(5);
    expect((await call('POST', '/api/public/booking/pk-a/bookings', FORM, { 'x-forwarded-for': '198.51.100.7' }, false)).status).toBe(201);
    now += 600_001;
    expect((await call('POST', '/api/public/booking/pk-a/bookings', FORM, ip(), false)).status).toBe(201);
  });

  it('các route nhân viên vẫn bắt buộc đăng nhập', async () => {
    expect((await call('POST', `/api/bookings/${BK}/check-in`, { patientId: PAT }, {}, false)).status).toBe(401);
    expect((await call('GET', `/api/booking-portal?organization=${OA}`, undefined, {}, false)).status).toBe(401);
  });
});

describe('clientIp', () => {
  const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as never;
  it('chỉ tin X-Forwarded-For từ proxy nội bộ; lấy phần tử cuối', () => {
    expect(clientIp(req('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9');
    expect(clientIp(req('127.0.0.1', '6.6.6.6, 203.0.113.5'))).toBe('203.0.113.5');
    expect(clientIp(req('::ffff:172.18.0.3', '203.0.113.5'))).toBe('203.0.113.5');
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
  });
});
