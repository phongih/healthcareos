/**
 * HCOS-F12 | Gửi HTTP ra ngoài: POST JSON, hết giờ 10 giây, KHÔNG theo chuyển hướng, chỉ đọc tối đa 4 KB phản hồi (không lưu),
 * kiểm tra địa chỉ IP SAU khi phân giải DNS (chống DNS rebinding tới mạng nội bộ).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { isBlockedAddress } from './targets';

export interface OutboundRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export interface OutboundResult {
  readonly status: number | null;
  /** Mã lỗi ngắn (A-Z0-9_:) khi không có phản hồi HTTP. */
  readonly error: string | null;
  readonly retryAfterSec: number | null;
  readonly durationMs: number;
}
export type Transport = (r: OutboundRequest) => Promise<OutboundResult>;

export function httpTransport(opts: { timeoutMs?: number; allowPrivate?: boolean } = {}): Transport {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return (r) =>
    new Promise<OutboundResult>((resolve) => {
      const t0 = Date.now();
      let done = false;
      const finish = (x: Omit<OutboundResult, 'durationMs'>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...x, durationMs: Date.now() - t0 });
      };
      let u: URL;
      try {
        u = new URL(r.url);
      } catch {
        finish({ status: null, error: 'BAD_URL', retryAfterSec: null });
        return;
      }
      const guardedLookup = (hostname: string, options: { all?: boolean; family?: number }, cb: (...a: unknown[]) => void) => {
        dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs: LookupAddress[]) => {
          if (err) return cb(Object.assign(err, { hcos: 'DNS' }));
          if (!opts.allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) return cb(Object.assign(new Error('blocked address'), { hcos: 'BLOCKED_ADDRESS' }));
          if (options.all) return cb(null, addrs);
          cb(null, addrs[0]!.address, addrs[0]!.family);
        });
      };
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(r.body), 'user-agent': 'HealthcareOS-Integrations/1', ...r.headers },
          lookup: guardedLookup as never,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? null;
          const ra = res.headers['retry-after'];
          const retryAfterSec = typeof ra === 'string' && /^\d{1,5}$/.test(ra) ? Number(ra) : null;
          let read = 0;
          res.on('data', (c: Buffer) => {
            read += c.length;
            if (read > 4096) res.destroy();
          });
          res.on('end', () => finish({ status, error: null, retryAfterSec }));
          res.on('close', () => finish({ status, error: null, retryAfterSec }));
          res.on('error', () => finish({ status, error: null, retryAfterSec }));
        },
      );
      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error('timeout'), { hcos: 'TIMEOUT' }));
      }, timeoutMs);
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { hcos: 'TIMEOUT' })));
      req.on('error', (e: Error & { hcos?: string; code?: string }) => {
        const code = e.hcos ?? (e.code === 'ECONNREFUSED' ? 'CONNECT_REFUSED' : e.code === 'ECONNRESET' ? 'CONNECT_RESET' : e.code?.startsWith('ERR_TLS') || e.code?.includes('CERT') ? 'TLS' : e.code === 'ENOTFOUND' ? 'DNS' : 'NETWORK');
        finish({ status: null, error: code, retryAfterSec: null });
      });
      req.end(r.body);
    });
}

/** Lịch thử lại sau lần gửi thứ n thất bại (n = 1..6): 1 phút → 5 → 15 → 1 giờ → 6 giờ → 24 giờ. Tối đa 7 lần gửi. */
export const BACKOFF_SEC: readonly number[] = [60, 300, 900, 3600, 21_600, 86_400];
export const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;

export type Verdict = { outcome: 'success' } | { outcome: 'retry'; afterSec: number; error: string } | { outcome: 'dead'; error: string };
/** Phân loại kết quả: 2xx thành công; 408/425/429/5xx/lỗi mạng thử lại; chuyển hướng và 4xx khác là lỗi vĩnh viễn. */
export function classify(r: OutboundResult, attempt: number, allowRetry: boolean): Verdict {
  if (r.status !== null && r.status >= 200 && r.status < 300) return { outcome: 'success' };
  const error = r.status !== null ? (r.status >= 300 && r.status < 400 ? 'REDIRECT_NOT_FOLLOWED' : `HTTP_${r.status}`) : (r.error ?? 'NETWORK');
  const transient = r.status === null ? r.error !== 'BLOCKED_ADDRESS' && r.error !== 'BAD_URL' : [408, 425, 429].includes(r.status) || r.status >= 500;
  if (!transient || !allowRetry || attempt >= MAX_ATTEMPTS) return { outcome: 'dead', error };
  const base = BACKOFF_SEC[attempt - 1] ?? BACKOFF_SEC[BACKOFF_SEC.length - 1]!;
  return { outcome: 'retry', afterSec: Math.max(base, Math.min(r.retryAfterSec ?? 0, 3600)), error };
}
