/**
 * HCOS-F16 | Lõi mật mã: bản mã gắn tenant + miền (AAD), chống sửa, blind index tách khoá, chuẩn hoá, dạng che, KEK.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  indexWith, isSealed, LocalKeyProvider, maskEmail, maskIdentifier, maskPhone, normalizePhoneVn, openWith, PiiConfigError, PiiCryptoError,
  sealWith, tokenVersion, wrapAad,
} from '../../packages/security/src/pii';

const K = randomBytes(32);
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';

describe('Mã hoá theo trường', () => {
  it('bản mã: định dạng e1.<phiên bản>.…, mở lại đúng; mỗi lần mã hoá khác nhau (IV ngẫu nhiên)', () => {
    const a = sealWith(K, 3, T1, 'phone', '0912345678');
    const b = sealWith(K, 3, T1, 'phone', '0912345678');
    expect(isSealed(a)).toBe(true);
    expect(tokenVersion(a)).toBe(3);
    expect(a).not.toBe(b);
    expect(a).not.toContain('0912345678');
    expect(openWith(K, T1, 'phone', a)).toBe('0912345678');
  });

  it('bản mã gắn tenant + miền: chép sang tenant khác / miền khác / sửa một byte => không mở được', () => {
    const t = sealWith(K, 1, T1, 'identifier', '079090000001');
    expect(() => openWith(K, T2, 'identifier', t)).toThrow(PiiCryptoError);
    expect(() => openWith(K, T1, 'phone', t)).toThrow(PiiCryptoError);
    expect(() => openWith(randomBytes(32), T1, 'identifier', t)).toThrow(PiiCryptoError);
    const body = t.split('.')[2]!;
    const flipped = `e1.1.${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}`;
    expect(() => openWith(K, T1, 'identifier', flipped)).toThrow(PiiCryptoError);
    expect(() => openWith(K, T1, 'identifier', 'plain-text')).toThrow(PiiCryptoError);
  });

  it('blind index: ổn định, chuẩn hoá cách gõ SĐT / giấy tờ; khác miền / khác khoá => khác; không lộ giá trị', () => {
    const k2 = randomBytes(32);
    const a = indexWith(K, 'phone', '0912345678');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(indexWith(K, 'phone', '+84 912 345 678')).toBe(a);
    expect(indexWith(K, 'phone', '84912345678')).toBe(a);
    expect(indexWith(K, 'identifier', ' 0790 9000 0001')).toBe(indexWith(K, 'identifier', '079090000001'));
    expect(indexWith(K, 'identifier', 'b1234567')).toBe(indexWith(K, 'identifier', 'B1234567'));
    expect(indexWith(K, 'email', 'An@Example.VN ')).toBe(indexWith(K, 'email', 'an@example.vn'));
    expect(indexWith(K, 'identifier', '0912345678')).not.toBe(a);
    expect(indexWith(k2, 'phone', '0912345678')).not.toBe(a);
  });

  it('dạng che để hiển thị', () => {
    expect(maskPhone('0912345678')).toBe('091****678');
    expect(maskEmail('nguyen.an@gmail.com')).toBe('n***@gmail.com');
    expect(maskIdentifier('079090000001')).toBe('********0001');
    expect(maskIdentifier('AB12')).toBe('****');
    expect(normalizePhoneVn('+84 912.345-678')).toBe('0912345678');
    expect(normalizePhoneVn('12345')).toBeNull();
  });
});

describe('KEK', () => {
  it('HCOS_KEKS: khoá đầu là khoá đang dùng; bọc / mở theo id; sai AAD hoặc KEK lạ => lỗi', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const p = LocalKeyProvider.parse(`k2:${k2.toString('base64')}, k1:${k1.toString('base64')}`);
    expect(p.activeKekId).toBe('k2');
    expect(p.kekIds()).toEqual(['k2', 'k1']);
    const dek = randomBytes(32);
    const aad = wrapAad(T1, 'data', 1);
    const w = p.wrap(dek, aad);
    expect(w.kekId).toBe('k2');
    expect(w.wrapped).toHaveLength(60);
    expect(p.unwrap('k2', w.wrapped, aad).equals(dek)).toBe(true);
    expect(() => p.unwrap('k2', w.wrapped, wrapAad(T2, 'data', 1))).toThrow(PiiCryptoError); // DEK bọc gắn tenant
    expect(() => p.unwrap('k1', w.wrapped, aad)).toThrow(PiiCryptoError);
    expect(() => LocalKeyProvider.parse(`k1:${k1.toString('base64')}`).unwrap('k2', w.wrapped, aad)).toThrow(PiiConfigError);
  });

  it('cấu hình sai bị từ chối', () => {
    expect(() => LocalKeyProvider.parse('')).toThrow(PiiConfigError);
    expect(() => LocalKeyProvider.parse('k1:' + randomBytes(16).toString('base64'))).toThrow(PiiConfigError);
    expect(() => LocalKeyProvider.parse('bad id:' + randomBytes(32).toString('base64'))).toThrow(PiiConfigError);
    const k = randomBytes(32).toString('base64');
    expect(() => LocalKeyProvider.parse(`k1:${k},k1:${k}`)).toThrow(PiiConfigError);
    expect(() => LocalKeyProvider.parse('nocolon')).toThrow(PiiConfigError);
  });
});
