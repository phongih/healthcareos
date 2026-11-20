/**
 * Mô phỏng kịch bản (What-If) cho dòng tiền 30 ngày — hàm thuần, tính ngay trên trình duyệt khi kéo thanh trượt.
 * Giả định (ghi rõ trên giao diện): phí khám đổi không làm đổi lượng khách; thêm lịch đặt online là khách MỚI;
 * giảm tỷ lệ huỷ / vắng chỉ áp cho khách đặt lịch; 30 ngày ≈ 1 tháng cho chi phí cố định.
 */
export interface WhatIfBase {
  walkIn: number;
  followUp: number;
  /** Khách đặt lịch dự kiến đến (đã nhân tỷ lệ đến). */
  booked: number;
  showRate: number;
  revenuePerVisit: number;
  examShare: number;
  fixedCostsMonthly: number;
  variableCostPct: number;
}
export interface WhatIfLevers {
  /** % thay đổi số lịch đặt online (−50 … +100). */
  bookingPct: number;
  /** Đổi phí khám (đ / lượt có phí khám). */
  examFeeDelta: number;
  /** % giảm tỷ lệ huỷ / vắng của lịch hẹn (0 … 100). */
  cancelReductionPct: number;
}
export interface WhatIfResult {
  visits: number;
  bookedVisits: number;
  showRate: number;
  revenuePerVisit: number;
  revenue: number;
  variableCost: number;
  contributionPerVisit: number;
  profit: number;
  /** Doanh thu hòa vốn = chi phí cố định ÷ (1 − % biến đổi). */
  breakEvenRevenue: number;
  /** Số lượt hòa vốn trong 30 ngày; null nếu mỗi lượt không còn lãi góp. */
  breakEvenVisits: number | null;
  /** (Doanh thu − hòa vốn) ÷ doanh thu; âm = dưới hòa vốn. */
  safetyMargin: number | null;
}

export const NO_CHANGE: WhatIfLevers = { bookingPct: 0, examFeeDelta: 0, cancelReductionPct: 0 };

export function simulate(b: WhatIfBase, l: WhatIfLevers): WhatIfResult {
  const s = Math.min(1, Math.max(0, b.showRate));
  const bookedRaw = s > 0 ? b.booked / s : 0;
  const s2 = 1 - (1 - s) * (1 - Math.min(100, Math.max(0, l.cancelReductionPct)) / 100);
  const bookedVisits = bookedRaw * Math.max(0, 1 + l.bookingPct / 100) * s2;
  const visits = b.walkIn + b.followUp + bookedVisits;
  const rpv = Math.max(0, b.revenuePerVisit + b.examShare * l.examFeeDelta);
  const v = Math.min(99.99, Math.max(0, b.variableCostPct)) / 100;
  const revenue = visits * rpv;
  const variableCost = revenue * v;
  const contribution = rpv * (1 - v);
  const profit = revenue - variableCost - b.fixedCostsMonthly;
  const breakEvenRevenue = b.fixedCostsMonthly / (1 - v);
  return {
    visits: Math.round(visits * 10) / 10,
    bookedVisits: Math.round(bookedVisits * 10) / 10,
    showRate: Math.round(s2 * 1000) / 1000,
    revenuePerVisit: Math.round(rpv),
    revenue: Math.round(revenue),
    variableCost: Math.round(variableCost),
    contributionPerVisit: Math.round(contribution),
    profit: Math.round(profit),
    breakEvenRevenue: Math.round(breakEvenRevenue),
    breakEvenVisits: contribution > 0 ? Math.ceil(b.fixedCostsMonthly / contribution) : null,
    safetyMargin: revenue > 0 ? Math.round(((revenue - breakEvenRevenue) / revenue) * 1000) / 1000 : null,
  };
}
