/**
 * HCOS-F19 | Hàm thuần: khấu hao đường thẳng theo tháng, mã tài sản (Luhn), sổ thiết bị Excel.
 */
import { describe, expect, it } from 'vitest';

import { blockerText, equipmentSheets } from '../../packages/exports/src/equipment-sheets';
import { depreciation } from '../../services/api/src/equipment/depreciation';
import { validAssetCode } from '../../services/api/src/equipment/equipment.service';
import { matchRoute } from '../../services/api/src/http/clinical-routes';
import { buildEquipmentRoutes, type EquipmentApi } from '../../services/api/src/http/equipment-routes';

describe('khấu hao đường thẳng theo tháng', () => {
  const m = { cost: 120_000_000, usefulLifeMonths: 60, inServiceOn: '2025-03-20', retiredOn: null };
  it('trích từ tháng đưa vào dùng, tính cả tháng đó', () => {
    expect(depreciation(m, '2025-02-28')).toMatchObject({ thisMonth: 0, accumulated: 0, monthsElapsed: 0, bookValue: 120_000_000 });
    expect(depreciation(m, '2025-03-31')).toMatchObject({ monthly: 2_000_000, thisMonth: 2_000_000, accumulated: 2_000_000, monthsElapsed: 1 });
    expect(depreciation(m, '2026-02-15')).toMatchObject({ accumulated: 24_000_000, monthsElapsed: 12, bookValue: 96_000_000 });
    expect(depreciation(m, '2026-02-15').endsOn).toBe('2030-02');
  });
  it('hết thời gian sử dụng: không trích thêm, giá trị còn lại 0; tháng cuối trích phần lẻ', () => {
    expect(depreciation(m, '2030-02-01')).toMatchObject({ thisMonth: 2_000_000, accumulated: 120_000_000, bookValue: 0 });
    expect(depreciation(m, '2031-01-01')).toMatchObject({ thisMonth: 0, accumulated: 120_000_000, monthsElapsed: 60 });
    const odd = depreciation({ cost: 1000, usefulLifeMonths: 12, inServiceOn: '2025-01-01', retiredOn: null }, '2026-06-01');
    expect(odd.monthly).toBe(83);
    expect(odd.accumulated).toBe(1000);
    expect(depreciation({ cost: 1000, usefulLifeMonths: 12, inServiceOn: '2025-01-01', retiredOn: null }, '2025-12-01').thisMonth).toBe(1000 - 83 * 11);
  });
  it('thanh lý: trích hết tháng thanh lý rồi dừng', () => {
    const r = { ...m, retiredOn: '2025-06-10' };
    expect(depreciation(r, '2025-06-30')).toMatchObject({ thisMonth: 2_000_000, accumulated: 8_000_000 });
    expect(depreciation(r, '2025-07-01')).toMatchObject({ thisMonth: 0, accumulated: 8_000_000, bookValue: 112_000_000 });
  });
});

describe('mã tài sản TByy-nnnn-c', () => {
  it('Luhn trên yy + nnnn; chấp nhận chữ thường / khoảng trắng; bắt lỗi gõ sai một số', () => {
    // Luhn("260001") = 3; Luhn("2612345") = 5 (quá 9999 máy / năm thì phần số dài thêm).
    expect(['TB26-0001-3', 'tb26-0001-3 ', 'TB26-12345-5'].every(validAssetCode)).toBe(true);
    expect(validAssetCode('TB26-0001-4')).toBe(false);
    expect(validAssetCode('TB26-0010-3')).toBe(false);
    expect(validAssetCode('TB26-001-3')).toBe(false);
    expect(validAssetCode('BN26-0001-3')).toBe(false);
  });
});

describe('sổ thiết bị Excel', () => {
  it('hai sheet; lý do chặn dịch ra tiếng Việt; không có dữ liệu cá nhân', () => {
    expect(blockerText('status:broken')).toBe('Hỏng');
    expect(blockerText('regime:atkt:overdue')).toBe('Kiểm định an toàn & tính năng kỹ thuật: Quá hạn');
    const s = equipmentSheets({
      organizationName: 'PK A', asOf: '2026-11-21',
      devices: [{
        assetCode: 'TB26-0001-6', name: 'Máy siêu âm', typeName: 'Máy siêu âm', manufacturer: 'GE', model: 'P9', serialNo: 'S1', roomCode: 'N1', riskClass: 'C',
        registrationNo: null, warrantyUntil: '2027-01-01', inServiceOn: '2025-01-15', status: 'broken', blockers: ['status:broken'],
        regimes: [{ regime: 'atkt', cycleMonths: 12, mandatory: true, state: 'due_soon', validUntil: '2026-12-01' }],
        cost: 600_000_000, usefulLifeMonths: 96, depreciation: { monthly: 6_250_000, accumulated: 143_750_000, bookValue: 456_250_000 },
      }],
      inspections: [{ assetCode: 'TB26-0001-6', regime: 'atkt', performedOn: '2025-12-01', result: 'pass', validUntil: '2026-12-01', provider: 'TT KĐ', certificateNo: 'KĐ-1' }],
    });
    expect(s.map((x) => x.name)).toEqual(['Sổ thiết bị', 'Kiểm định - hiệu chuẩn']);
    const row = s[0]!.rows[0] as unknown[];
    expect(row).toContain('KHÔNG');
    expect(row).toContain('(chưa nhập)');
    expect(row).toContain('Loại C');
    expect(String(row[14])).toContain('hạn 01/12/2026');
    expect(s[1]!.rows[0]).toContain('Đạt');
  });
});

describe('định tuyến trang thiết bị theo mã tài sản (QR)', () => {
  it("':ref' nhận mã tài sản hoặc UUID; từ chối ký tự lạ", () => {
    const routes = buildEquipmentRoutes({} as EquipmentApi);
    const m = matchRoute(routes, 'GET', '/api/equipment/devices/TB26-0001-3');
    expect(m.kind).toBe('match');
    expect(matchRoute(routes, 'POST', '/api/equipment/devices/TB26-0001-3/events').kind).toBe('match');
    expect(matchRoute(routes, 'GET', '/api/equipment/devices/TB26%200001').kind).not.toBe('match');
  });
});
