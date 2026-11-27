/**
 * HCOS-F18 | Sổ nguồn dữ liệu AI + chặn dữ liệu người bệnh ra ngoài.
 *  - Khoá phiên bản: SHA-256 trong sổ phải khớp nội dung file. Sửa dữ liệu / luật AI mà không cập nhật thẻ => lỗi.
 *  - Không đường ra ngoài lạ: trình duyệt chỉ nói chuyện với máy chủ (CSP connect-src 'self', không URL tuyệt đối);
 *    máy chủ chỉ ra ngoài qua bộ giao tích hợp (F12, có kiểm tra nhà cung cấp) và tải khoá JWKS của IdP.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AI_REGISTRY } from '../../packages/security/src/ai-registry';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = `${dir}/${n}`;
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};

describe('Sổ nguồn dữ liệu AI', () => {
  it('mỗi thẻ đủ thông tin; SHA-256 khớp đúng nội dung file (sửa mà không cập nhật sổ => CI đỏ)', () => {
    const ids = new Set<string>();
    for (const c of AI_REGISTRY) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      expect(c.files.length, c.id).toBeGreaterThan(0);
      expect(c.validationNote.length, c.id).toBeGreaterThan(20);
      expect(c.patientDataLeavesSystem).toBe(false);
      const h = createHash('sha256');
      for (const f of c.files) h.update(`${f}\0${read(f)}\0`);
      const got = h.digest('hex');
      if (got !== c.sha256) {
        throw new Error(
          `Thành phần AI "${c.id}" đã thay đổi (SHA-256 mới ${got}). Cập nhật packages/security/src/ai-registry.ts: version, sha256, changeNote ` +
            '(và trạng thái kiểm định nếu cần) — thay đổi dữ liệu AI phải được duyệt.',
        );
      }
    }
  });

  it('mọi file trong apps/web/src/lib/ai (trừ giao diện) đều có thẻ', () => {
    const covered = new Set(AI_REGISTRY.flatMap((c) => c.files));
    const files = walk('apps/web/src/lib/ai').filter((f) => f.endsWith('.ts'));
    expect(files.filter((f) => !covered.has(f))).toEqual([]);
  });

  it("trình duyệt chỉ kết nối tới chính máy chủ: CSP connect-src 'self', mã web không gọi URL tuyệt đối", () => {
    const caddy = read('deploy/staging/Caddyfile');
    expect(caddy).toMatch(/connect-src 'self';/);
    const offenders = walk('apps/web/src').filter((f) => /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(\s*['"`]https?:/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('máy chủ chỉ ra ngoài qua bộ giao tích hợp (F12) và JWKS của IdP', () => {
    const egress = /from 'node:(https|tls|dgram)'|import \{[^}]*\b(connect|createConnection|Socket)\b[^}]*\} from 'node:net'|request as https?Request|\bfetch\s*\(|createRemoteJWKSet\s*\(|from 'undici'|from 'axios'/;
    const files = [...walk('services/api/src'), ...walk('packages')].filter((f) => egress.test(read(f)));
    // smtp-otp-sender.ts: điểm ra ngoài duy nhất cho OTP đăng ký khách (SMTP qua TLS, port 465).
    // Chỉ được gọi khi kênh đã được duyệt trong danh mục vendor; mặc định fail-closed.
    expect(files.sort()).toEqual([
      'services/api/src/app.ts',
      'services/api/src/integration/transport.ts',
      'services/api/src/signup/smtp-otp-sender.ts',
    ]);
  });
});
