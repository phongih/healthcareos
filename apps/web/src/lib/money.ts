/** Tiền VND: định dạng, đọc ô nhập, đọc số thành chữ (in trên phiếu thu). */
export const fmtVnd = (n: number): string => `${new Intl.NumberFormat('vi-VN').format(n)} đ`;

/** "500.000", "500 000", "500000đ" => 500000; rỗng / không hợp lệ => null. */
export function parseVnd(raw: string): number | null {
  const d = raw.replace(/[.\s,đ₫]/gi, '');
  if (!/^\d{1,13}$/.test(d)) return null;
  const n = Number(d);
  return Number.isSafeInteger(n) ? n : null;
}

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const SCALES = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];

function readGroup(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const w: string[] = [];
  if (full || h > 0) w.push(DIGITS[h]!, 'trăm');
  if (t === 0) {
    if (u > 0) w.push(...(full || h > 0 ? ['linh', DIGITS[u]!] : [DIGITS[u]!]));
  } else if (t === 1) {
    w.push('mười');
    if (u > 0) w.push(u === 5 ? 'lăm' : DIGITS[u]!);
  } else {
    w.push(DIGITS[t]!, 'mươi');
    if (u > 0) w.push(u === 1 ? 'mốt' : u === 4 ? 'tư' : u === 5 ? 'lăm' : DIGITS[u]!);
  }
  return w.join(' ');
}

/** 1050000 => "Một triệu không trăm năm mươi nghìn đồng". */
export function vndInWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid amount');
  if (n === 0) return 'Không đồng';
  const groups: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 1000)) groups.push(x % 1000);
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g === 0) continue;
    parts.push(readGroup(g, i < groups.length - 1), SCALES[i]!);
  }
  const s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} đồng`;
}
