/** Mô phỏng What-If: số liệu tính tay. */
import { describe, expect, it } from 'vitest';

import { NO_CHANGE, simulate, type WhatIfBase } from '../../apps/web/src/lib/whatif';

const base: WhatIfBase = { walkIn: 300, followUp: 50, booked: 85, showRate: 0.85, revenuePerVisit: 250_000, examShare: 0.8, fixedCostsMonthly: 60_000_000, variableCostPct: 30 };

describe('simulate', () => {
  it('không đổi gì: 435 lượt × 250k = 108,75 tr; hòa vốn 60 tr ÷ 0,7 = 85,71 tr = 343 lượt', () => {
    const r = simulate(base, NO_CHANGE);
    expect(r).toMatchObject({ visits: 435, revenue: 108_750_000, variableCost: 32_625_000, profit: 16_125_000, contributionPerVisit: 175_000 });
    expect(r.breakEvenRevenue).toBe(85_714_286);
    expect(r.breakEvenVisits).toBe(343);
    expect(r.safetyMargin).toBe(0.212);
  });
  it('đặt lịch +20%: 100 lịch × 1,2 × 0,85 = 102 khách đặt lịch', () => {
    expect(simulate(base, { ...NO_CHANGE, bookingPct: 20 }).bookedVisits).toBe(102);
  });
  it('giảm huỷ/vắng 50%: tỷ lệ đến 0,925 => 92,5 khách đặt lịch', () => {
    const r = simulate(base, { ...NO_CHANGE, cancelReductionPct: 50 });
    expect([r.showRate, r.bookedVisits]).toEqual([0.925, 92.5]);
  });
  it('tăng phí khám 20.000đ: doanh thu / lượt + 0,8 × 20.000 = 266.000đ', () => {
    const r = simulate(base, { ...NO_CHANGE, examFeeDelta: 20_000 });
    expect([r.revenuePerVisit, r.revenue]).toEqual([266_000, 115_710_000]);
  });
  it('không có chi phí cố định => hòa vốn 0; doanh thu / lượt 0 => không tính được số lượt hòa vốn', () => {
    expect(simulate({ ...base, fixedCostsMonthly: 0 }, NO_CHANGE).breakEvenVisits).toBe(0);
    expect(simulate({ ...base, revenuePerVisit: 0, examShare: 0 }, NO_CHANGE).breakEvenVisits).toBeNull();
  });
});
