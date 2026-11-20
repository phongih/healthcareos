/**
 * Bộ mã hoá QR tự viết (apps/web/src/lib/qr.ts).
 * Các ma trận tham chiếu dưới đây đã được giải mã lại đúng nội dung bằng OpenCV (QRCodeDetectorAruco) khi viết test;
 * test giữ cho thay đổi sau này không làm sai mã (so băm ma trận + kiểm tra cấu trúc).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { encodeQr, qrPath, type QrMatrix } from '../../apps/web/src/lib/qr';

const bits = (m: QrMatrix) => {
  let s = '';
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) s += m.get(x, y) ? '1' : '0';
  return createHash('sha256').update(s).digest('hex');
};

describe('encodeQr', () => {
  it('khớp ma trận tham chiếu đã giải mã kiểm chứng', () => {
    const a = encodeQr('SYTA-KPFA', 'M');
    expect([a.version, a.size]).toEqual([1, 21]);
    expect(bits(a)).toBe('eed0a1fba108203b2be9c7638de0e2fd7a5913078e65a2976bb236a6f7950fb0');
    const b = encodeQr('Tiếng Việt có dấu – mã HCOS', 'M');
    expect(b.version).toBe(3);
    expect(bits(b)).toBe('bafa4db0aca756f7cb8ca79d2fe6ee85cf7ebb1f6491454a45edca594d5fcddd');
    const c = encodeQr('A'.repeat(300), 'L');
    expect(c.version).toBe(11);
    expect(bits(c)).toBe('f63f080f5a3c129cc21b7b68916abf056d9dc448d9c082758ff24af28c675cdc');
  });

  it('có 3 mẫu định vị ở góc; ngoài phạm vi là ô trắng', () => {
    const m = encodeQr('ABCD-2345', 'M');
    const finderOk = (x0: number, y0: number) => {
      for (let dy = 0; dy < 7; dy++)
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          if (m.get(x0 + dx, y0 + dy) !== (ring !== 2)) return false;
        }
      return true;
    };
    expect(finderOk(0, 0) && finderOk(m.size - 7, 0) && finderOk(0, m.size - 7)).toBe(true);
    expect(m.get(-1, 0) || m.get(0, m.size)).toBe(false);
  });

  it('mức sửa lỗi cao hơn => phiên bản không nhỏ hơn; quá dài => lỗi', () => {
    const t = 'x'.repeat(120);
    const v = (['L', 'M', 'Q', 'H'] as const).map((e) => encodeQr(t, e).version);
    expect([...v].sort((p, q) => p - q)).toEqual(v);
    expect(() => encodeQr('x'.repeat(4000), 'H')).toThrow();
  });

  it('qrPath: mỗi ô đen một hình vuông, có viền', () => {
    const m = encodeQr('A', 'L');
    const d = qrPath(m, 4);
    let dark = 0;
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.get(x, y)) dark++;
    expect(d.match(/M/g)?.length).toBe(dark);
    expect(d.startsWith('M4,4')).toBe(true);
  });
});
