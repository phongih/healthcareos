import { describe, expect, it } from 'vitest';

import { allowedApps, APPS, defaultPins, fold, matchApps, MAX_PINS } from '../../apps/web/src/lib/nav-model';
import type { Role } from '../../apps/web/src/lib/roles';

const R = (...r: Role[]) => new Set<Role>(r);

describe('điều hướng theo vai trò (giao diện đợt 2)', () => {
  it('bỏ dấu tiếng Việt để tìm', () => {
    expect(fold('Thu ngân · Đơn thuốc')).toBe('thu ngan · don thuoc');
  });

  it('chỉ hiện ứng dụng vai trò được phép', () => {
    expect(allowedApps(R('doctor')).map((a) => a.key)).toEqual(['patients', 'queue', 'equipment']);
    expect(allowedApps(R('cashier')).map((a) => a.key)).not.toContain('staff');
    expect(allowedApps(R('tenant_admin')).map((a) => a.key)).toContain('admin');
    expect(allowedApps(R())).toEqual([]);
  });

  it('ghim mặc định theo vai trò, tối đa 4, chỉ trong ứng dụng được phép', () => {
    expect(defaultPins(R('clinic_staff'))).toEqual(['today', 'patients', 'queue', 'bookings']);
    expect(defaultPins(R('doctor'))).toEqual(['patients', 'queue', 'equipment']);
    expect(defaultPins(R('clinic_admin', 'doctor'))).toEqual(['patients', 'queue', 'reports', 'staff']);
    expect(defaultPins(R('cashier'))).toEqual(['finance', 'handover']);
    for (const r of ['tenant_admin', 'clinic_admin', 'executive', 'doctor', 'clinic_staff', 'pharmacy_admin', 'pharmacist', 'cashier'] as Role[]) {
      const pins = defaultPins(R(r));
      const allowed = new Set(allowedApps(R(r)).map((a) => a.key));
      expect(pins.length <= MAX_PINS).toBe(true);
      expect(pins.every((k) => allowed.has(k))).toBe(true);
    }
  });

  it('tìm không dấu; khớp đúng cả từ được ưu tiên', () => {
    expect(matchApps(APPS, 'thu ngan').map((a) => a.key)).toEqual(['finance']);
    expect(matchApps(APPS, 'Thu ngân').map((a) => a.key)).toEqual(['finance']);
    expect(matchApps(APPS, 'kho').map((a) => a.key)).toEqual(['pharmacy', 'forecast']);
    expect(matchApps(APPS, 'nhan').map((a) => a.key)).toContain('staff'); // gõ dở: khớp đầu từ
    expect(matchApps(APPS, '').length).toBe(APPS.length);
    expect(matchApps(APPS, 'zzz')).toEqual([]);
  });
});
