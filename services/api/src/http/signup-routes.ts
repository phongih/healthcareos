/**
 * HCOS | HTTP: đăng ký khách và tra đường dẫn tổ chức (không đăng nhập; xử lý trong server.ts trước xác thực).
 *
 *   GET  /api/public/tenants/:slug        => { displayName, slug } | { redirect: true } | 404 (không lộ tổ chức chưa hoạt động)
 *   POST /api/public/signup/start         { email, orgName, contactName, phone, license, slug } => 201 { signupId, expiresAt }
 *   POST /api/public/signup/verify        { signupId, code }                       => 200 { slug }
 *   POST /api/public/signup/complete      { signupId, password }                   => 201 { slug, status: 'pending_review' }
 *     (mật khẩu chỉ đi qua HTTPS, không bao giờ được ghi log hay trả lại)
 *
 * Lỗi nghiệp vụ trả { error: <mã> } (vd. SLUG_TAKEN, RATE_LIMITED, WRONG); lỗi không rõ chỉ trả INTERNAL, không lộ chi tiết.
 * Giới hạn tần suất theo IP chạy trước khi gọi dịch vụ.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SignupError, type SignupService, type StartInput } from '../signup/signup.service';
import { clientIp, type RateLimiter } from './booking-routes';
import { HttpError, PLAIN_JSON, readJsonBody, sendJson } from './http-kernel';

export type PublicSignupApi = Pick<SignupService, 'start' | 'verify' | 'resolve' | 'complete'>;

const LIMITS = {
  tenant: { limit: 120, windowMs: 60_000 },
  start: { limit: 5, windowMs: 60 * 60_000 },
  verify: { limit: 30, windowMs: 60 * 60_000 },
  complete: { limit: 10, windowMs: 60 * 60_000 },
} as const;

/** Mã lỗi nghiệp vụ => HTTP status. */
export const SIGNUP_HTTP_STATUS: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  WRONG: 400,
  EXPIRED: 410,
  LOCKED: 423,
  NOT_PENDING: 409,
  SLUG_TAKEN: 409,
  RATE_LIMITED: 429,
  OTP_UNAVAILABLE: 503,
  ACCOUNT_EXISTS: 409,
  IDP_UNAVAILABLE: 503,
};

const START_FIELDS: readonly string[] = ['email', 'orgName', 'contactName', 'phone', 'license', 'slug'];
const VERIFY_FIELDS: readonly string[] = ['signupId', 'code'];
const COMPLETE_FIELDS: readonly string[] = ['signupId', 'password'];
const TENANT_PATH = /^\/api\/public\/tenants\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function handlePublicSignup(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: { api: PublicSignupApi; limiter: RateLimiter; baseHeaders: Record<string, string>; onError: (e: unknown) => void },
): Promise<boolean> {
  const p = url.pathname;
  const tenantM = TENANT_PATH.exec(p);
  const isStart = p === '/api/public/signup/start';
  const isVerify = p === '/api/public/signup/verify';
  const isComplete = p === '/api/public/signup/complete';
  if (!tenantM && !isStart && !isVerify && !isComplete) return false;

  const method = (req.method ?? 'GET').toUpperCase();
  const h = { ...deps.baseHeaders, 'cache-control': 'no-store' };
  const send = (status: number, body: unknown, extra: Record<string, string> = {}): void =>
    sendJson(res, status, body, PLAIN_JSON, { ...h, ...extra });
  const ip = clientIp(req);

  if (tenantM) {
    if (method !== 'GET') return (send(405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' }), true);
    if (!deps.limiter.take(`tenant|${ip}`, LIMITS.tenant.limit, LIMITS.tenant.windowMs)) return (send(429, { error: 'RATE_LIMITED' }), true);
    try {
      const r = await deps.api.resolve(tenantM[1]!);
      if (!r || r.status !== 'active') send(404, { error: 'NOT_FOUND' });
      else if (r.redirect) send(200, { redirect: true });
      else send(200, { displayName: r.displayName, slug: tenantM[1] });
    } catch (e) {
      deps.onError(e);
      send(500, { error: 'INTERNAL' });
    }
    return true;
  }

  if (method !== 'POST') return (send(405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' }), true);
  const lim = isStart ? LIMITS.start : isVerify ? LIMITS.verify : LIMITS.complete;
  if (!deps.limiter.take(`${p}|${ip}`, lim.limit, lim.windowMs)) {
    send(429, { error: 'RATE_LIMITED' }, { 'retry-after': String(Math.ceil(lim.windowMs / 1000)) });
    return true;
  }
  try {
    const body = await readJsonBody(req, 8_192);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SignupError('INVALID_INPUT');
    const o = body as Record<string, unknown>;
    const allowed = isStart ? START_FIELDS : isVerify ? VERIFY_FIELDS : COMPLETE_FIELDS;
    for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new SignupError('INVALID_INPUT');

    if (isStart) {
      const input: StartInput = {
        email: str(o['email']), orgName: str(o['orgName']), contactName: str(o['contactName']),
        phone: str(o['phone']), license: str(o['license']), slug: str(o['slug']),
      };
      const out = await deps.api.start(input, ip);
      send(201, { signupId: out.signupId, expiresAt: out.expiresAt.toISOString() });
    } else if (isVerify) {
      const signupId = str(o['signupId']);
      if (!UUID_RE.test(signupId)) throw new SignupError('INVALID_INPUT');
      const out = await deps.api.verify(signupId, str(o['code']));
      send(200, { slug: out.slug });
    } else {
      const signupId = str(o['signupId']);
      if (!UUID_RE.test(signupId)) throw new SignupError('INVALID_INPUT');
      const out = await deps.api.complete(signupId, str(o['password']));
      send(201, { slug: out.slug, status: 'pending_review' });
    }
  } catch (e) {
    if (e instanceof SignupError) {
      send(SIGNUP_HTTP_STATUS[e.code] ?? 400, { error: e.code, ...(e.detail ? { field: e.detail.field } : {}) });
    } else if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
      send(400, { error: 'INVALID_INPUT' });
    } else {
      deps.onError(e);
      send(500, { error: 'INTERNAL' });
    }
  }
  return true;
}
