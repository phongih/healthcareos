/** Định dạng / đọc tiền VND, số thành chữ trên phiếu thu, chuỗi VietQR (EMVCo). */
import { describe, expect, it } from 'vitest';

import { fmtVnd, parseVnd, vndInWords } from '../../apps/web/src/lib/money';
import { crc16, transferNote, vietQrPayload } from '../../apps/web/src/lib/vietqr';

describe('tiền VND', () => {
  it('định dạng và đọc ô nhập', () => {
    expect(fmtVnd(1500000).replace(/\s/g, ' ')).toBe('1.500.000 đ');
    expect(parseVnd('500.000')).toBe(500000);
    expect(parseVnd('500 000đ')).toBe(500000);
    expect(parseVnd('5e5')).toBeNull();
    expect(parseVnd('')).toBeNull();
    expect(parseVnd('-1')).toBeNull();
  });
  it('số thành chữ', () => {
    expect(vndInWords(0)).toBe('Không đồng');
    expect(vndInWords(15)).toBe('Mười lăm đồng');
    expect(vndInWords(21)).toBe('Hai mươi mốt đồng');
    expect(vndInWords(24)).toBe('Hai mươi tư đồng');
    expect(vndInWords(105)).toBe('Một trăm linh năm đồng');
    expect(vndInWords(170000)).toBe('Một trăm bảy mươi nghìn đồng');
    expect(vndInWords(500000)).toBe('Năm trăm nghìn đồng');
    expect(vndInWords(1000000)).toBe('Một triệu đồng');
    expect(vndInWords(1001)).toBe('Một nghìn không trăm linh một đồng');
    expect(vndInWords(1050000)).toBe('Một triệu không trăm năm mươi nghìn đồng');
    expect(vndInWords(2015300)).toBe('Hai triệu không trăm mười lăm nghìn ba trăm đồng');
    expect(vndInWords(1000000000)).toBe('Một tỷ đồng');
  });
});

describe('VietQR', () => {
  it('CRC-16/CCITT-FALSE đúng vector chuẩn', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
  it('nội dung chuyển khoản: bỏ dấu, in hoa, ≤ 25 ký tự', () => {
    expect(transferNote('HCOS F0003 tạm ứng – Đặng')).toBe('HCOS F0003 TAM UNG DANG');
    expect(transferNote('x'.repeat(40))).toHaveLength(25);
  });
  it('chuỗi EMVCo: đủ trường, độ dài đúng, CRC cuối khớp', () => {
    const p = vietQrPayload({ bin: '970436', account: '0011001234567', amount: 500000, note: 'HCOS F0001 tạm ứng' });
    expect(p.startsWith('000201010212')).toBe(true);
    expect(p).toContain('0010A000000727');
    expect(p).toContain('0006970436');
    expect(p).toContain('01130011001234567');
    expect(p).toContain('0208QRIBFTTA');
    expect(p).toContain('5303704');
    expect(p).toContain('5406500000');
    expect(p).toContain('5802VN');
    expect(p).toContain('0818HCOS F0001 TAM UNG');
    expect(p.slice(-8, -4)).toBe('6304');
    expect(crc16(p.slice(0, -4))).toBe(p.slice(-4));
    expect(() => vietQrPayload({ bin: '97043', account: '1', amount: 1, note: '' })).toThrow();
  });
});
