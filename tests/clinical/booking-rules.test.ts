/**
 * HCOS-F7 | Quy tắc thuần: giờ VN, buổi còn nhận lịch, mã đặt lịch.
 */
import { describe, expect, it } from 'vitest';

import { formatCode, newBookingCode, normalizeCode, periodOpen, vnNow } from '../../services/api/src/clinical/booking.service';

describe('giờ Việt Nam', () => {
  it('UTC+7, qua nửa đêm đổi ngày', () => {
    expect(vnNow(new Date('2026-11-23T16:59:00Z'))).toEqual({ date: '2026-11-23', minutes: 23 * 60 + 59, weekday: 1 });
    expect(vnNow(new Date('2026-11-23T17:00:00Z'))).toEqual({ date: '2026-11-24', minutes: 0, weekday: 2 });
  });
});

describe('periodOpen', () => {
  const at = (vn: string) => new Date(`${vn}+07:00`);
  it('hôm nay: sáng đóng lúc 11:00, chiều đóng lúc 16:00', () => {
    expect(periodOpen('2026-11-23', 'morning', at('2026-11-23T10:59:00'))).toBe(true);
    expect(periodOpen('2026-11-23', 'morning', at('2026-11-23T11:00:00'))).toBe(false);
    expect(periodOpen('2026-11-23', 'afternoon', at('2026-11-23T15:59:00'))).toBe(true);
    expect(periodOpen('2026-11-23', 'afternoon', at('2026-11-23T16:00:00'))).toBe(false);
  });
  it('không nhận quá khứ, Chủ nhật, quá 14 ngày', () => {
    const now = at('2026-11-23T08:00:00');
    expect(periodOpen('2026-11-22', 'afternoon', now)).toBe(false);
    expect(periodOpen('2026-11-29', 'morning', now)).toBe(false);
    expect(periodOpen('2026-12-07', 'morning', now)).toBe(true);
    expect(periodOpen('2026-12-08', 'morning', now)).toBe(false);
  });
});

describe('mã đặt lịch', () => {
  it('8 ký tự không dễ nhầm; chuẩn hoá chữ thường / dấu gạch / khoảng trắng', () => {
    for (let i = 0; i < 200; i++) {
      const c = newBookingCode();
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      expect(normalizeCode(formatCode(c).toLowerCase())).toBe(c);
    }
    expect(normalizeCode(' abcd 2345 ')).toBe('ABCD2345');
    expect(normalizeCode('ABCD-234O')).toBeNull();
    expect(normalizeCode('ABCD-2341')).toBeNull();
    expect(normalizeCode('ABCDL345')).toBeNull();
    expect(normalizeCode('ABC')).toBeNull();
  });
});
