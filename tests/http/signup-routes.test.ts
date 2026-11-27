/**
 * HCOS | HTTP đăng ký khách: ánh xạ mã lỗi, xác thực body, giới hạn tần suất, không lộ tổ chức chưa hoạt động.
 * Chạy một HTTP server thật, dịch vụ giả (không DB).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handlePublicSignup, type PublicSignupApi } from '../../services/api/src/http/signup-routes';
import { RateLimiter } from '../../services/api/src/http/booking-routes';
import { SignupError } from '../../services/api/src/signup/signup.service';
import { checkEmail } from '../../services/api/src/signup/signup-rules';

const SIGNUP_ID = '11111111-2222-4333-8444-555555555555';
const api: PublicSignupApi = {
  async start(input) {
    if (!checkEmail(input.email).ok) throw new SignupError('INVALID_INPUT', { field: 'email', code: 'INVALID_EMAIL' });
    if (input.slug === 'taken') throw new SignupError('SLUG_TAKEN');
    if (input.email === 'loi@pk.vn') throw new SignupError('OTP_UNAVAILABLE');
    return { signupId: SIGNUP_ID, expiresAt: new Date('2026-11-27T04:00:00Z') };
  },
  async verify(id, code) {
    if (code === '000001') throw new SignupError('WRONG');
    if (code === '000009') throw new SignupError('LOCKED');
    if (id !== SIGNUP_ID) throw new SignupError('NOT_PENDING');
    return { slug: 'pkmoi' };
  },
  async resolve(slug) {
    if (slug === 'pk1') return { displayName: 'Phòng khám 1', status: 'active', redirect: false };
    if (slug === 'cu1') return { displayName: 'Phòng khám cũ', status: 'active', redirect: true };
    if (slug === 'ngung') return { displayName: 'Đã ngừng', status: 'suspended', redirect: false };
    return null;
  },
};

let server: Server;
let base = '';

beforeAll(async () => {
  const limiter = new RateLimiter();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    handlePublicSignup(req, res, url, { api, limiter, baseHeaders: {}, onError: () => undefined }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

// Mỗi yêu cầu một IP mới (qua X-Forwarded-For từ proxy nội bộ) để test không dùng chung hạn mức.
let seq = 0;
const freshIp = () => `203.0.113.${(seq++ % 200) + 1}`;
const post = (path: string, body: unknown, ip = freshIp()) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

const good = { email: 'chu@pk.vn', orgName: 'Phòng khám Mới', phone: '0908697966', license: 'GPKD-0001234', slug: 'pkmoi' };

describe('HTTP đăng ký khách', () => {
  it('tra slug: tổ chức đang hoạt động trả tên; chuyển hướng; ngừng hoạt động hoặc lạ => 404', async () => {
    expect(await (await fetch(base + '/api/public/tenants/pk1', { headers: { 'x-forwarded-for': freshIp() } })).json()).toEqual({ displayName: 'Phòng khám 1', slug: 'pk1' });
    expect(await (await fetch(base + '/api/public/tenants/cu1', { headers: { 'x-forwarded-for': freshIp() } })).json()).toEqual({ redirect: true });
    expect((await fetch(base + '/api/public/tenants/ngung', { headers: { 'x-forwarded-for': freshIp() } })).status).toBe(404);
    expect((await fetch(base + '/api/public/tenants/khong-co', { headers: { 'x-forwarded-for': freshIp() } })).status).toBe(404);
    expect((await fetch(base + '/api/public/tenants/pk1', { method: 'POST', headers: { 'x-forwarded-for': freshIp() } })).status).toBe(405);
  });

  it('start hợp lệ => 201 kèm signupId, không trả mã OTP', async () => {
    const r = await post('/api/public/signup/start', good);
    expect(r.status).toBe(201);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toEqual({ signupId: SIGNUP_ID, expiresAt: '2026-11-27T04:00:00.000Z' });
    expect(JSON.stringify(body)).not.toMatch(/code|otp/i);
  });

  it('lỗi nghiệp vụ map sang mã HTTP đúng', async () => {
    expect((await post('/api/public/signup/start', { ...good, slug: 'taken' })).status).toBe(409);
    expect((await post('/api/public/signup/start', { ...good, email: 'loi@pk.vn' })).status).toBe(503);
    const bad = await post('/api/public/signup/start', { ...good, email: 'khong-phai-email' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'INVALID_INPUT', field: 'email' });
  });

  it('body sai: trường lạ, JSON hỏng, signupId không phải UUID => 400', async () => {
    expect((await post('/api/public/signup/start', { ...good, role: 'admin' })).status).toBe(400);
    const junk = await fetch(base + '/api/public/signup/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{' });
    expect(junk.status).toBe(400);
    expect((await post('/api/public/signup/verify', { signupId: 'khong-phai-uuid', code: '123456' })).status).toBe(400);
  });

  it('verify: WRONG => 400, LOCKED => 423, đúng => 200 kèm slug', async () => {
    expect((await post('/api/public/signup/verify', { signupId: SIGNUP_ID, code: '000001' })).status).toBe(400);
    expect((await post('/api/public/signup/verify', { signupId: SIGNUP_ID, code: '000009' })).status).toBe(423);
    const ok = await post('/api/public/signup/verify', { signupId: SIGNUP_ID, code: '123456' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ slug: 'pkmoi' });
  });

  it('start vượt 5 lần / giờ từ cùng IP => 429', async () => {
    const ip = '203.0.113.250';
    for (let i = 0; i < 5; i++) await post('/api/public/signup/start', good, ip);
    const r = await post('/api/public/signup/start', good, ip);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
  });
});
