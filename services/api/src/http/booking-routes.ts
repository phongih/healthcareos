/**
 * HCOS-F7 | HTTP: đặt lịch khám online.
 *
 * Nhân viên (đã đăng nhập, JSON thường):
 *   GET  /api/bookings?organization=<uuid>[&date=YYYY-MM-DD]            lịch hẹn trong ngày (booking:read)
 *   GET  /api/bookings/by-code?organization=<uuid>&code=<mã>            lịch + hồ sơ có thể trùng (booking:read)
 *   GET  /api/bookings/:id                                               lịch + hồ sơ có thể trùng (khi người bệnh quên mã)
 *   POST /api/bookings/:id/check-in      { patientId, priorityReason? }  gắn hồ sơ + cấp số (queue:issue)
 *   POST /api/bookings/:id/cancel                                        (queue:issue)
 *   POST /api/service-points/:id/booking-capacity { capacity } + If-Match (queue:manage)
 *   GET  /api/booking-portal?organization=<uuid>
 *   POST /api/booking-portal             { organizationId, slug }        (queue:manage)
 *   POST /api/booking-portal/active      { organizationId, isActive } + If-Match (queue:manage)
 *
 * Công khai (KHÔNG đăng nhập; xử lý trong server.ts trước xác thực, có giới hạn tần suất theo IP):
 *   GET  /api/public/booking/:slug/options
 *   POST /api/public/booking/:slug/bookings  { servicePointId, visitDate, period, familyName, givenName, birthDate, sex, phone,
 *                                              nationalId?, reason?, consent, consentVersion, website? } => { code, ... } (mã chỉ trả MỘT lần)
 *   POST /api/public/booking/:slug/lookup    { code, phone }   (POST để số điện thoại không nằm trong URL / log)
 *   POST /api/public/booking/:slug/cancel    { code, phone }
 *   Sai mã / sai số điện thoại / cổng không tồn tại đều trả cùng một 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { BookingService, PublicBookingService } from '../clinical/booking.service';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { FHIR_JSON, HttpError, PLAIN_JSON, mapError, operationOutcome, readJsonBody, sendJson } from './http-kernel';

export type BookingApi = Pick<BookingService, 'listForDay' | 'findByCode' | 'getById' | 'checkIn' | 'cancel' | 'setBookingCapacity' | 'getPortal' | 'createPortal' | 'setPortalActive'>;
export type PublicBookingApi = Pick<PublicBookingService, 'options' | 'create' | 'lookup' | 'cancel'>;

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({
  status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}),
});
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
function params(url: URL, allowed: readonly string[]): URLSearchParams {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
  return url.searchParams;
}
const required = (p: URLSearchParams, k: string): string => {
  const v = p.get(k);
  if (!v || p.getAll(k).length > 1) throw new HttpError(400, 'required', `Parameter '${k}' is required`);
  return v;
};
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function buildBookingRoutes(api: BookingApi): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: ['api', 'bookings'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'date']);
        const date = p.get('date');
        return json(200, { bookings: await api.listForDay({ organizationId: required(p, 'organization'), ...(date ? { date } : {}) }, input.ctx) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'bookings', 'by-code'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'code']);
        const r = await api.findByCode({ organizationId: required(p, 'organization'), code: required(p, 'code') }, input.ctx);
        if (!r) throw new HttpError(404, 'not-found', 'Booking not found');
        return json(200, r);
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'bookings', ':id'],
      handler: async (input, [id]) => json(200, await api.getById(id!, input.ctx)),
    },
    {
      method: 'POST',
      pattern: ['api', 'bookings', ':id', 'check-in'],
      handler: async (input, [id]) => {
        const o = await obj(input, ['patientId', 'priorityReason']);
        const pr = o['priorityReason'];
        if (pr !== undefined && pr !== null && typeof pr !== 'string') throw new HttpError(400, 'invalid', 'priorityReason must be a string or null');
        return json(200, await api.checkIn(id!, { patientId: s(o['patientId']), priorityReason: (pr as string | null | undefined) ?? null }, input.ctx));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'bookings', ':id', 'cancel'],
      handler: async (input, [id]) => json(200, await api.cancel(id!, input.ctx)),
    },
    {
      method: 'POST',
      pattern: ['api', 'service-points', ':id', 'booking-capacity'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['capacity']);
        if (typeof o['capacity'] !== 'number') throw new HttpError(400, 'invalid', 'capacity must be a number');
        const sp = await api.setBookingCapacity(id!, o['capacity'], version, input.ctx);
        return json(200, sp, { etag: `W/"${sp.version}"` });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'booking-portal'],
      handler: async (input) => json(200, { portal: await api.getPortal(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'booking-portal'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'slug']);
        const portal = await api.createPortal({ organizationId: s(o['organizationId']), slug: s(o['slug']) }, input.ctx);
        return json(201, portal, { etag: `W/"${portal.version}"` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'booking-portal', 'active'],
      handler: async (input) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['organizationId', 'isActive']);
        const portal = await api.setPortalActive({ organizationId: s(o['organizationId']), isActive: o['isActive'] as boolean }, version, input.ctx);
        return json(200, portal, { etag: `W/"${portal.version}"` });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Công khai
// ---------------------------------------------------------------------------
/** Giới hạn tần suất cửa sổ cố định, trong bộ nhớ (một tiến trình API). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly clock: () => number = Date.now) {}
  /** true = cho phép. */
  take(key: string, limit: number, windowMs: number): boolean {
    const now = this.clock();
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    h.count += 1;
    return h.count <= limit;
  }
}

/** Giới hạn mỗi IP (cửa sổ 10 phút, trừ options). */
export const PUBLIC_LIMITS = {
  options: { limit: 120, windowMs: 60_000 },
  create: { limit: 5, windowMs: 600_000 },
  lookup: { limit: 20, windowMs: 600_000 },
} as const;

const PRIVATE_RE = /^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^::1$|^fc|^fd/i;
/**
 * IP người gọi. Chỉ tin X-Forwarded-For khi kết nối đến từ proxy nội bộ (loopback / mạng riêng — Caddy cùng máy / cùng
 * mạng docker); lấy phần tử CUỐI (do proxy của mình thêm vào), không lấy phần tử đầu do client tự đặt.
 */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket?.remoteAddress ?? 'unknown';
  if (!PRIVATE_RE.test(remote)) return remote;
  const raw = req.headers['x-forwarded-for'];
  const xff = (Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1]! : remote;
}

const PUBLIC_RE = /^\/api\/public\/booking\/([a-z0-9][a-z0-9-]{2,39})\/(options|bookings|lookup|cancel)$/;
const CREATE_FIELDS = [
  'servicePointId', 'visitDate', 'period', 'familyName', 'givenName', 'birthDate', 'sex', 'phone', 'nationalId', 'reason', 'consent', 'consentVersion', 'website',
] as const;

/**
 * Xử lý /api/public/booking/*. Trả false nếu đường dẫn không thuộc cổng đặt lịch.
 * Lỗi được trả như các API khác (OperationOutcome; lý do ở details.text) nhưng KHÔNG lộ lỗi nội bộ.
 */
export async function handlePublicBooking(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: { api: PublicBookingApi; limiter: RateLimiter; baseHeaders: Record<string, string>; onError: (e: unknown) => void },
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/public/booking/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const h = { ...deps.baseHeaders, 'cache-control': 'no-store' };
  const m = PUBLIC_RE.exec(url.pathname);
  const fail = (status: number, code: string, msg: string, detail?: string, extra: Record<string, string> = {}) =>
    sendJson(res, status, operationOutcome(code, msg, detail), FHIR_JSON, { ...h, ...extra });
  if (!m) {
    fail(404, 'not-found', 'Not found');
    return true;
  }
  const [, slug, op] = m as unknown as [string, string, 'options' | 'bookings' | 'lookup' | 'cancel'];
  const expected = op === 'options' ? 'GET' : 'POST';
  if (method !== expected) {
    fail(405, 'not-supported', 'Method not allowed', undefined, { allow: expected });
    return true;
  }
  const bucket = op === 'options' ? 'options' : op === 'bookings' ? 'create' : 'lookup';
  const lim = PUBLIC_LIMITS[bucket];
  if (!deps.limiter.take(`${bucket}|${clientIp(req)}`, lim.limit, lim.windowMs)) {
    fail(429, 'throttled', 'Too many requests', 'RATE_LIMITED', { 'retry-after': String(Math.ceil(lim.windowMs / 1000)) });
    return true;
  }
  try {
    if (url.search) throw new HttpError(400, 'not-supported', 'Query parameters are not supported');
    let out: unknown;
    if (op === 'options') {
      out = await deps.api.options(slug);
    } else {
      const body = await readJsonBody(req, 8_192);
      if (!body) throw new HttpError(400, 'required', 'Body is required');
      const o = body as Record<string, unknown>;
      const allowed: readonly string[] = op === 'bookings' ? CREATE_FIELDS : ['code', 'phone'];
      for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
      if (op === 'bookings') {
        const str = (k: string) => (o[k] === undefined || o[k] === null ? undefined : typeof o[k] === 'string' ? (o[k] as string) : '\u0000');
        out = await deps.api.create(slug, {
          servicePointId: str('servicePointId') ?? '', visitDate: str('visitDate') ?? '', period: str('period') ?? '', familyName: str('familyName') ?? '',
          givenName: str('givenName') ?? '', birthDate: str('birthDate') ?? '', sex: str('sex') ?? '', phone: str('phone') ?? '',
          nationalId: str('nationalId') ?? null, reason: str('reason') ?? null, consent: o['consent'] === true, consentVersion: str('consentVersion') ?? '',
          ...(str('website') !== undefined ? { website: str('website')! } : {}),
        });
      } else {
        const code = typeof o['code'] === 'string' ? o['code'] : '';
        const phone = typeof o['phone'] === 'string' ? o['phone'] : '';
        out = op === 'lookup' ? await deps.api.lookup(slug, code, phone) : await deps.api.cancel(slug, code, phone);
      }
    }
    if (out === null) fail(404, 'not-found', 'Not found');
    else sendJson(res, op === 'bookings' ? 201 : 200, out, PLAIN_JSON, h);
  } catch (e) {
    const mapped = mapError(e);
    if (mapped.status >= 500) deps.onError(e);
    // Không lộ chi tiết lỗi nội bộ; lỗi nghiệp vụ trả lý do (vd. SESSION_FULL) để trang hiển thị thông báo.
    sendJson(res, mapped.status, operationOutcome(mapped.fhirCode, mapped.status >= 500 ? 'Temporarily unavailable' : mapped.message, mapped.detail), FHIR_JSON, { ...h, ...mapped.headers });
    if (mapped.headers['connection'] === 'close') res.once('finish', () => req.destroy());
  }
  return true;
}
