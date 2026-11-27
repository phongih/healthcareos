import { describe, expect, it } from 'vitest';

import { firstName, searchParamsFor, summarizeQueue, todayVN } from '../../apps/web/src/lib/today-model';

describe('màn "Hôm nay" (giao diện đợt 3)', () => {
  it('ngày hôm nay theo giờ Việt Nam', () => {
    expect(todayVN(new Date('2026-11-26T17:30:00Z'))).toBe('2026-11-27'); // 00:30 ngày 27 giờ VN
    expect(todayVN(new Date('2026-11-27T16:59:00Z'))).toBe('2026-11-27');
  });

  it('lời chào lấy tên gọi, bỏ phần trong ngoặc', () => {
    expect(firstName('Nguyễn Thị Lan (Lễ tân)')).toBe('Lan');
    expect(firstName('Điều dưỡng Demo')).toBe('Demo');
    expect(firstName(null)).toBe('');
  });

  it('ô tìm: 12 chữ số là CCCD, còn lại là mã bệnh nhân', () => {
    expect(searchParamsFor(' 099123456789 ')).toEqual({ mode: 'cccd', value: '099123456789' });
    expect(searchParamsFor('bn26-000123-5')).toEqual({ mode: 'mrn', value: 'bn26-000123-5' });
    expect(searchParamsFor('TT00020')).toEqual({ mode: 'mrn', value: 'TT00020' });
  });

  it('tóm tắt hàng đợi theo phòng: số gọi gần nhất + người chờ; bỏ phòng ngừng', () => {
    const points = [
      { servicePointId: 'a', code: 'N1', name: 'Nội 1', isActive: true },
      { servicePointId: 'b', code: 'N2', name: 'Nội 2', isActive: true },
      { servicePointId: 'c', code: 'X', name: 'Ngừng', isActive: false },
    ];
    const t = (id: string, sp: string, no: string, status: string, calledAt: string | null = null) => ({ ticketId: id, servicePointId: sp, displayNo: no, status, calledAt });
    const r = summarizeQueue(points, [
      t('1', 'a', 'N1-001', 'in_service', '2026-11-27T01:00:00Z'),
      t('2', 'a', 'N1-002', 'called', '2026-11-27T01:05:00Z'),
      t('3', 'a', 'N1-003', 'waiting'),
      t('4', 'a', 'N1-004', 'waiting'),
      t('5', 'a', 'N1-005', 'skipped', '2026-11-27T00:50:00Z'),
      t('6', 'c', 'X-001', 'waiting'),
    ]);
    expect(r.map((x) => x.point.code)).toEqual(['N1', 'N2']);
    expect(r[0]!.current!.displayNo).toBe('N1-002');
    expect(r[0]!.waiting).toBe(2);
    expect(r[1]!.current).toBe(null);
    expect(r[1]!.waiting).toBe(0);
  });
});
