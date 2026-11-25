/**
 * HCOS-F20 | HTTP cổng bệnh nhân /api/portal/* — KHÔNG dùng JWT nhân viên. Xử lý trước bước xác thực nội bộ; route nội bộ /api/* khác
 * không bao giờ chấp nhận token cổng (token cổng không phải JWT => verify thất bại => 401).
 *
 * Công khai (giới hạn tần suất theo IP):
 *   GET  /api/portal/:slug/info
 *   POST /api/portal/:slug/otp             { method: 'phone', phone } | { method: 'mrn', mrn, birthDate }
 *   POST /api/portal/:slug/session         { challengeId, code }                       => { token, expiresAt }
 *   POST /api/portal/share-view            { token, pin }                               (bác sĩ tuyến trên)
 * Trong phiên (header  Authorization: Portal <token>):
 *   POST /api/portal/logout                 GET /api/portal/me
 *   GET  /api/portal/profiles/:personId     GET /api/portal/profiles/:personId/encounters/:encounterId
 *   GET  /api/portal/booking/options        POST /api/portal/bookings {personId, servicePointId, visitDate, period, reason?, consent}
 *   POST /api/portal/bookings/cancel        {personId, bookingId}
 *   POST /api/portal/contact/phone          {phone}           POST /api/portal/contact/phone/confirm {challengeId, code}
 *   POST /api/portal/contact/email          {email}
 *   GET  /api/portal/requests               POST /api/portal/requests/correction {personId, message}
 *   POST /api/portal/requests/erasure       {personId, note?}
 *   GET  /api/portal/shares                 POST /api/portal/shares {personId, encounterId}     POST /api/portal/shares/:id/revoke
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PortalService } from '../portal/portal.service';
import { PortalError } from '../portal/portal.service';
import { clientIp, type RateLimiter } from './booking-routes';
import { FHIR_JSON, HttpError, mapError, operationOutcome, PLAIN_JSON, readJsonBody, sendJson } from './http-kernel';

export type PortalApi = Pick<
  PortalService,
  | 'info' | 'start' | 'verify' | 'logout' | 'me' | 'overview' | 'encounter' | 'bookingOptions' | 'book' | 'cancelBooking' | 'startPhoneChange'
  | 'confirmPhoneChange' | 'setEmail' | 'myRequests' | 'submitCorrection' | 'requestErasure' | 'listShares' | 'createShare' | 'revokeShare' | 'viewShare'
>;

/** Giới hạn theo IP (cửa sổ 15 phút) — bổ sung cho giới hạn theo định danh trong CSDL. */
export const PORTAL_LIMITS = {
  otp: { limit: 10, windowMs: 15 * 60_000 },
  verify: { limit: 30, windowMs: 15 * 60_000 },
  share: { limit: 30, windowMs: 15 * 60_000 },
  session: { limit: 600, windowMs: 15 * 60_000 },
} as const;

const SLUG = '([a-z0-9][a-z0-9-]{2,39})';
const UUID = '([0-9a-fA-F-]{36})';
type Handler = (a: { body: Record<string, unknown>; token: string; m: string[]; meta: { ip: string; userAgent: string | null } }) => Promise<unknown>;
interface PRoute { method: 'GET' | 'POST'; re: RegExp; bucket: keyof typeof PORTAL_LIMITS; auth: boolean; fields?: readonly string[]; run: Handler }

function routes(api: PortalApi): PRoute[] {
  return [
    { method: 'GET', re: new RegExp(`^/api/portal/${SLUG}/info$`), bucket: 'session', auth: false, run: async ({ m }) => (await api.info(m[1]!)) ?? notFound() },
    { method: 'POST', re: new RegExp(`^/api/portal/${SLUG}/otp$`), bucket: 'otp', auth: false, fields: ['method', 'phone', 'mrn', 'birthDate'], run: ({ m, body, meta }) => api.start(m[1]!, body, meta) },
    { method: 'POST', re: new RegExp(`^/api/portal/${SLUG}/session$`), bucket: 'verify', auth: false, fields: ['challengeId', 'code'], run: ({ m, body, meta }) => api.verify(m[1]!, body, meta) },
    { method: 'POST', re: /^\/api\/portal\/share-view$/, bucket: 'share', auth: false, fields: ['token', 'pin'], run: ({ body, meta }) => api.viewShare(String(body['token'] ?? ''), body['pin'], meta) },
    { method: 'POST', re: /^\/api\/portal\/logout$/, bucket: 'session', auth: true, fields: [], run: ({ token }) => api.logout(token) },
    { method: 'GET', re: /^\/api\/portal\/me$/, bucket: 'session', auth: true, run: ({ token }) => api.me(token) },
    { method: 'GET', re: new RegExp(`^/api/portal/profiles/${UUID}$`), bucket: 'session', auth: true, run: ({ token, m }) => api.overview(token, m[1]) },
    { method: 'GET', re: new RegExp(`^/api/portal/profiles/${UUID}/encounters/${UUID}$`), bucket: 'session', auth: true, run: ({ token, m }) => api.encounter(token, m[1], m[2]) },
    { method: 'GET', re: /^\/api\/portal\/booking\/options$/, bucket: 'session', auth: true, run: ({ token }) => api.bookingOptions(token) },
    { method: 'POST', re: /^\/api\/portal\/bookings$/, bucket: 'session', auth: true, fields: ['personId', 'servicePointId', 'visitDate', 'period', 'reason', 'consent'], run: ({ token, body }) => api.book(token, body) },
    { method: 'POST', re: /^\/api\/portal\/bookings\/cancel$/, bucket: 'session', auth: true, fields: ['personId', 'bookingId'], run: ({ token, body }) => api.cancelBooking(token, body) },
    { method: 'POST', re: /^\/api\/portal\/contact\/phone$/, bucket: 'otp', auth: true, fields: ['phone'], run: ({ token, body, meta }) => api.startPhoneChange(token, body, meta) },
    { method: 'POST', re: /^\/api\/portal\/contact\/phone\/confirm$/, bucket: 'verify', auth: true, fields: ['challengeId', 'code'], run: ({ token, body }) => api.confirmPhoneChange(token, body) },
    { method: 'POST', re: /^\/api\/portal\/contact\/email$/, bucket: 'session', auth: true, fields: ['email'], run: ({ token, body }) => api.setEmail(token, body) },
    { method: 'GET', re: /^\/api\/portal\/requests$/, bucket: 'session', auth: true, run: ({ token }) => api.myRequests(token) },
    { method: 'POST', re: /^\/api\/portal\/requests\/correction$/, bucket: 'session', auth: true, fields: ['personId', 'message'], run: ({ token, body }) => api.submitCorrection(token, body) },
    { method: 'POST', re: /^\/api\/portal\/requests\/erasure$/, bucket: 'session', auth: true, fields: ['personId', 'note'], run: ({ token, body }) => api.requestErasure(token, body) },
    { method: 'GET', re: /^\/api\/portal\/shares$/, bucket: 'session', auth: true, run: ({ token }) => api.listShares(token) },
    { method: 'POST', re: /^\/api\/portal\/shares$/, bucket: 'session', auth: true, fields: ['personId', 'encounterId'], run: ({ token, body }) => api.createShare(token, body) },
    { method: 'POST', re: new RegExp(`^/api/portal/shares/${UUID}/revoke$`), bucket: 'session', auth: true, fields: [], run: ({ token, m }) => api.revokeShare(token, m[1]) },
  ];
}
const notFound = (): never => {
  throw new PortalError(404, 'NOT_FOUND', 'Not found');
};

export async function handlePortal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: { api: PortalApi; limiter: RateLimiter; baseHeaders: Record<string, string>; onError: (e: unknown) => void },
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const h = { ...deps.baseHeaders, 'cache-control': 'no-store' };
  const fail = (status: number, reason: string, msg: string, extra: Record<string, string> = {}) =>
    sendJson(res, status, operationOutcome(status === 429 ? 'throttled' : status === 401 ? 'login' : 'processing', msg, reason), FHIR_JSON, { ...h, ...extra });
  const all = routes(deps.api).filter((r) => r.re.test(url.pathname));
  const r = all.find((x) => x.method === method);
  if (!r) {
    if (all.length) fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { allow: all.map((x) => x.method).join(', ') });
    else fail(404, 'NOT_FOUND', 'Not found');
    return;
  }
  const ip = clientIp(req);
  const lim = PORTAL_LIMITS[r.bucket];
  if (!deps.limiter.take(`portal-${r.bucket}|${ip}`, lim.limit, lim.windowMs)) {
    fail(429, 'RATE_LIMITED', 'Too many requests', { 'retry-after': String(Math.ceil(lim.windowMs / 1000)) });
    return;
  }
  try {
    if (url.search) throw new HttpError(400, 'not-supported', 'Query parameters are not supported');
    let token = '';
    if (r.auth) {
      const raw = req.headers['authorization'];
      const a = (Array.isArray(raw) ? raw[0] : raw) ?? '';
      const mm = /^Portal (hpt_[A-Za-z0-9_-]{20,60})$/.exec(a);
      if (!mm) throw new PortalError(401, 'SESSION_INVALID', 'Sign in again');
      token = mm[1]!;
    }
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      const b = await readJsonBody(req, 8_192);
      if (b !== undefined && b !== null) {
        if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
        body = b as Record<string, unknown>;
      }
      for (const k of Object.keys(body)) if (!(r.fields ?? []).includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
    }
    const ua = req.headers['user-agent'];
    const out = await r.run({ body, token, m: r.re.exec(url.pathname)!.slice(0), meta: { ip, userAgent: typeof ua === 'string' ? ua : null } });
    sendJson(res, method === 'POST' && /\/(bookings|shares|correction|erasure)$/.test(url.pathname) ? 201 : 200, out, PLAIN_JSON, h);
  } catch (e) {
    if (e instanceof PortalError) {
      fail(e.status, e.reason, e.message, e.retryAfterSec ? { 'retry-after': String(e.retryAfterSec) } : {});
      return;
    }
    const mapped = mapError(e);
    if (mapped.status >= 500) deps.onError(e);
    sendJson(res, mapped.status, operationOutcome(mapped.fhirCode, mapped.status >= 500 ? 'Temporarily unavailable' : mapped.message, mapped.detail), FHIR_JSON, { ...h, ...mapped.headers });
    if (mapped.headers['connection'] === 'close') res.once('finish', () => req.destroy());
  }
}
