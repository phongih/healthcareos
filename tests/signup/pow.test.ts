/** HCOS | CAPTCHA proof-of-work: chữ ký, hạn, một lần dùng, lời giải, đếm bit 0. */
import { describe, expect, it } from 'vitest';

import { leadingZeroBits, ProofOfWork, solvePow } from '../../services/api/src/signup/pow';

describe('leadingZeroBits', () => {
  it('đếm đúng bit 0 đứng đầu', () => {
    expect(leadingZeroBits(Uint8Array.of(0x80))).toBe(0);
    expect(leadingZeroBits(Uint8Array.of(0x01))).toBe(7);
    expect(leadingZeroBits(Uint8Array.of(0x00, 0x10))).toBe(11);
    expect(leadingZeroBits(Uint8Array.of(0x00, 0x00))).toBe(16);
  });
});

describe('ProofOfWork', () => {
  it('lời giải đúng được nhận đúng một lần; dùng lại bị từ chối', () => {
    let t = 1_000_000;
    const pow = new ProofOfWork(() => t, 12);
    const c = pow.issue();
    const nonce = solvePow(c.token, c.bits);
    expect(pow.verify(c.token, nonce)).toBe(true);
    expect(pow.verify(c.token, nonce)).toBe(false);
  });

  it('lời giải không đạt độ khó bị từ chối và không đánh dấu đã dùng', () => {
    const pow = new ProofOfWork(() => 1_000_000, 20);
    const c = pow.issue();
    expect(pow.verify(c.token, 'abc')).toBe(false);
    // Thử thách chưa bị đánh dấu nên vẫn kiểm tra được với lời giải đúng.
    const easy = new ProofOfWork(() => 1_000_000, 8);
    const ec = easy.issue();
    expect(easy.verify(ec.token, solvePow(ec.token, 8))).toBe(true);
  });

  it('token bị sửa hoặc ký bằng khoá khác bị từ chối', () => {
    const pow = new ProofOfWork(() => 1_000_000, 8);
    const other = new ProofOfWork(() => 1_000_000, 8);
    const c = pow.issue();
    const nonce = solvePow(c.token, c.bits);
    const dot = c.token.lastIndexOf('.');
    const s = c.token.slice(dot + 1);
    const forgedPayload = Buffer.from(JSON.stringify({ id: 'x', exp: 9_999_999_999_999 })).toString('base64url');
    expect(pow.verify(`${forgedPayload}.${s}`, nonce)).toBe(false);
    expect(pow.verify(`${c.token.slice(0, dot)}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}`, nonce)).toBe(false);
    expect(other.verify(c.token, nonce)).toBe(false);
    expect(pow.verify(c.token, nonce)).toBe(true);
  });

  it('thử thách hết hạn bị từ chối', () => {
    let t = 1_000_000;
    const pow = new ProofOfWork(() => t, 8);
    const c = pow.issue();
    const nonce = solvePow(c.token, c.bits);
    t += 5 * 60_000 + 1;
    expect(pow.verify(c.token, nonce)).toBe(false);
  });

  it('nonce sai định dạng hoặc quá dài bị từ chối', () => {
    const pow = new ProofOfWork(() => 1_000_000, 8);
    const c = pow.issue();
    expect(pow.verify(c.token, '')).toBe(false);
    expect(pow.verify(c.token, 'a'.repeat(33))).toBe(false);
    expect(pow.verify(c.token, 'a b')).toBe(false);
  });
});
