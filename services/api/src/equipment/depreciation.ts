/**
 * HCOS-F19 | Khấu hao đường thẳng theo tháng (hàm thuần, test được).
 *
 * Quy ước: trích từ tháng đưa vào sử dụng (tính cả tháng đó), mỗi tháng = nguyên giá / số tháng (làm tròn đồng);
 * tháng cuối trích phần còn lại để tổng đúng bằng nguyên giá. Máy hỏng / bảo trì vẫn trích; thanh lý thì dừng sau tháng thanh lý.
 * Thời gian sử dụng do cơ sở nhập theo khung của Bộ Tài chính, kế toán xác nhận — hệ thống không tự chọn.
 */
export interface DepreciationInput {
  readonly cost: number;
  readonly usefulLifeMonths: number;
  /** YYYY-MM-DD */
  readonly inServiceOn: string;
  /** YYYY-MM-DD hoặc null */
  readonly retiredOn: string | null;
}
export interface DepreciationResult {
  readonly monthly: number;
  /** Phần trích của tháng `asOf` (0 nếu chưa dùng / đã hết / đã thanh lý trước tháng đó). */
  readonly thisMonth: number;
  readonly accumulated: number;
  readonly bookValue: number;
  /** Số tháng đã trích tính đến hết tháng `asOf`. */
  readonly monthsElapsed: number;
  /** YYYY-MM tháng trích cuối cùng. */
  readonly endsOn: string;
}

const monthIndex = (date: string): number => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const ym = (idx: number): string => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;

/** Số tiền trích của tháng thứ k (1-based). */
function chargeOf(cost: number, life: number, k: number): number {
  const monthly = Math.round(cost / life);
  if (k < 1 || k > life) return 0;
  return k < life ? monthly : cost - monthly * (life - 1);
}

export function depreciation(x: DepreciationInput, asOf: string): DepreciationResult {
  const life = x.usefulLifeMonths;
  const start = monthIndex(x.inServiceOn);
  const now = monthIndex(asOf);
  const stop = x.retiredOn ? monthIndex(x.retiredOn) : Number.POSITIVE_INFINITY;
  const lastActive = Math.min(now, stop);
  const elapsed = Math.max(0, Math.min(life, lastActive - start + 1));
  let accumulated = 0;
  for (let k = 1; k <= elapsed; k++) accumulated += chargeOf(x.cost, life, k);
  const k = now - start + 1;
  const thisMonth = now <= stop ? chargeOf(x.cost, life, k) : 0;
  return {
    monthly: Math.round(x.cost / life),
    thisMonth,
    accumulated,
    bookValue: x.cost - accumulated,
    monthsElapsed: elapsed,
    endsOn: ym(start + life - 1),
  };
}
