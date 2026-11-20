/** HCOS-F13 | Mã bệnh nhân tự sinh: định dạng, số kiểm tra Luhn, chuẩn hoá khi tìm. */
import { describe, expect, it } from 'vitest';

import { formatAutoMrn, luhnDigit, MrnError, normalizeMrnQuery } from '../../services/api/src/registry/mrn';

describe('mã tự sinh', () => {
  it('định dạng <TIỀN TỐ><YY>-<NNNNNN>-<C>', () => {
    expect(formatAutoMrn('BN', 26, 123)).toMatch(/^BN26-000123-\d$/);
    expect(formatAutoMrn('PKA', 7, 1)).toMatch(/^PKA07-000001-\d$/);
  });
  it('Luhn chuẩn', () => {
    expect(luhnDigit('7992739871')).toBe(3);
    expect(luhnDigit('26000123')).toBe(5);
  });
  it('mọi lỗi gõ sai MỘT chữ số đều bị phát hiện', () => {
    const base = '26000123';
    const c = luhnDigit(base);
    for (let i = 0; i < base.length; i++)
      for (let d = 0; d <= 9; d++) {
        if (String(d) === base[i]) continue;
        const wrong = base.slice(0, i) + d + base.slice(i + 1);
        expect(luhnDigit(wrong), wrong).not.toBe(c);
      }
  });
});

describe('chuẩn hoá khi tìm', () => {
  const ok = formatAutoMrn('BN', 26, 123);
  it('chữ thường / thiếu gạch / quét mã vạch => dạng chuẩn', () => {
    expect(normalizeMrnQuery(ok.toLowerCase())).toBe(ok);
    expect(normalizeMrnQuery(ok.replace(/-/g, ''))).toBe(ok);
    expect(normalizeMrnQuery(`  ${ok} `)).toBe(ok);
  });
  it('sai số kiểm tra => lỗi rõ', () => {
    const wrong = ok.slice(0, -1) + ((Number(ok.slice(-1)) + 1) % 10);
    expect(() => normalizeMrnQuery(wrong)).toThrow(MrnError);
    try { normalizeMrnQuery(wrong); } catch (e) { expect((e as MrnError).reason).toBe('MRN_CHECK_DIGIT'); }
  });
  it('mã cũ giữ nguyên; ký tự lạ bị từ chối', () => {
    expect(normalizeMrnQuery('TT00030')).toBe('TT00030');
    expect(normalizeMrnQuery('SO-1998/42')).toBe('SO-1998/42');
    expect(() => normalizeMrnQuery("x' OR 1=1")).toThrow(MrnError);
  });
});
