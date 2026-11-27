/**
 * HCOS | Đăng ký khách: quy tắc đầu vào và băm OTP (thuần, không DB).
 */
import { describe, expect, it } from 'vitest';

import { checkEmail, checkLicense, checkSlug } from '../../services/api/src/signup/signup-rules';
import { hashOtp, otpMatches } from '../../services/api/src/signup/signup.service';

const key = Buffer.from('unit-key');

describe('signup-rules', () => {
  it('email: chuẩn hoá chữ thường, từ chối sai định dạng', () => {
    expect(checkEmail('  Chu@PK.vn ')).toEqual({ ok: true, value: 'chu@pk.vn' });
    expect(checkEmail('khong-co-at').ok).toBe(false);
  });

  it('slug: 3–30 ký tự, không bắt đầu / kết thúc bằng gạch, không trong danh sách cấm', () => {
    expect(checkSlug('pk1').ok).toBe(true);
    expect(checkSlug('ab').ok).toBe(false);
    expect(checkSlug('-pk1').ok).toBe(false);
    expect(checkSlug('pk1-').ok).toBe(false);
    expect(checkSlug('pk_1').ok).toBe(false);
    expect(checkSlug('a'.repeat(31)).ok).toBe(false);
    expect(checkSlug('app')).toEqual({ ok: false, error: { field: 'slug', code: 'RESERVED_SLUG' } });
  });

  it('giấy phép: 5–40 ký tự sau khi cắt khoảng trắng', () => {
    expect(checkLicense('  GPKD  ').ok).toBe(false);
    expect(checkLicense(' GPKD-12 ')).toEqual({ ok: true, value: 'GPKD-12' });
  });

  it('OTP: băm có muối, khớp đúng mã, sai mã hoặc sai định dạng thì không khớp', () => {
    const stored = hashOtp(key, '042917');
    expect(stored).not.toContain('042917');
    expect(otpMatches(key, '042917', stored)).toBe(true);
    expect(otpMatches(key, '042918', stored)).toBe(false);
    expect(otpMatches(key, '42917', stored)).toBe(false);
    expect(otpMatches(Buffer.from('khac'), '042917', stored)).toBe(false);
    expect(hashOtp(key, '042917')).not.toBe(stored); // muối khác nhau mỗi lần
  });
});
