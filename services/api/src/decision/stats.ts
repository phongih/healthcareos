/**
 * HCOS-F11 | Native AI phía máy chủ: phát hiện bất thường bằng thống kê — chạy cục bộ, không gửi dữ liệu ra ngoài,
 * giải thích được (mỗi điểm số kèm trung vị / kỳ vọng làm căn cứ).
 */

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
}

/** Độ lệch tuyệt đối trung vị (MAD). */
export function mad(xs: readonly number[]): number {
  const md = median(xs);
  return median(xs.map((x) => Math.abs(x - md)));
}

/**
 * Robust z-score: (x − trung vị) / (1.4826 × MAD). Ít bị kéo lệch bởi vài ngày đột biến hơn z-score thường.
 * MAD = 0 (lịch sử gần như hằng) => dùng độ lệch tuyệt đối trung bình; vẫn 0 => dùng √(trung vị) (xấp xỉ Poisson, cho dữ liệu đếm), tối thiểu 1.
 * Trả null nếu lịch sử ít hơn `minSample` điểm (không đủ căn cứ => không báo).
 */
export function robustZ(x: number, history: readonly number[], minSample = 4): number | null {
  if (history.length < minSample) return null;
  const md = median(history);
  let scale = 1.4826 * mad(history);
  if (scale === 0) scale = 1.2533 * (history.reduce((a, h) => a + Math.abs(h - md), 0) / history.length);
  if (scale === 0) scale = Math.max(1, Math.sqrt(Math.abs(md)));
  return round2((x - md) / scale);
}

/** z theo Poisson cho dữ liệu đếm: (quan sát − kỳ vọng) / √max(kỳ vọng, 1). */
export function poissonZ(observed: number, expected: number): number {
  return round2((observed - expected) / Math.sqrt(Math.max(expected, 1)));
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
