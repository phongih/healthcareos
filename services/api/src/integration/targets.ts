/**
 * HCOS-F12 | Kiểm tra địa chỉ đích (chống SSRF):
 *  - Microsoft Teams: chỉ URL Workflows của Microsoft (*.logic.azure.com, *.environment.api.powerplatform.com), https, cổng 443.
 *  - Webhook chung: https; không user:pass; không tên máy nội bộ; IP nội bộ / loopback / link-local bị chặn
 *    cả lúc lưu (IP viết thẳng) lẫn lúc gửi (sau khi phân giải DNS, xem transport.ts).
 *  - Không theo chuyển hướng (transport.ts).
 */
import { isIP } from 'node:net';

export type EndpointKind = 'teams_workflow' | 'webhook';

const TEAMS_SUFFIXES = ['.logic.azure.com', '.environment.api.powerplatform.com'];

export function validateTarget(kind: EndpointKind, raw: unknown, opts: { allowPrivate?: boolean } = {}): { url: string; hint: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length < 10 || raw.length > 2000) return { error: 'URL phải là chuỗi 10–2000 ký tự' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'URL không hợp lệ' };
  }
  if (u.username || u.password) return { error: 'URL không được chứa tên đăng nhập / mật khẩu' };
  if (u.hash) return { error: 'URL không được có phần #' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (kind === 'teams_workflow') {
    if (u.protocol !== 'https:') return { error: 'URL Teams phải là https' };
    if (u.port && u.port !== '443') return { error: 'URL Teams phải dùng cổng 443' };
    if (!TEAMS_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) {
      return { error: 'Không phải URL webhook của Workflows (Microsoft Teams): cần *.logic.azure.com hoặc *.environment.api.powerplatform.com' };
    }
    if (u.pathname.length < 5) return { error: 'URL Teams thiếu đường dẫn workflow' };
  } else {
    const local = opts.allowPrivate === true;
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return { error: 'URL webhook phải là https' };
    if (!local) {
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host)) {
        return { error: 'Không gửi tới tên máy nội bộ' };
      }
      if (isIP(host) && isBlockedAddress(host)) return { error: 'Không gửi tới địa chỉ IP nội bộ' };
    }
  }
  const url = u.toString();
  return { url, hint: hintOf(u) };
}

/** Gợi ý đã che để hiển thị: tên máy + 4 ký tự cuối (không lộ chữ ký trong query). */
function hintOf(u: URL): string {
  const tail = u.toString().replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return `${u.protocol === 'http:' ? 'http://' : ''}${u.host}/…${tail}`.slice(0, 200);
}

/** Địa chỉ không được phép gửi tới (nội bộ, loopback, link-local, multicast, dành riêng). */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && ip.split('.')[2] === '0') ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}
