/**
 * Chuỗi VietQR (chuẩn EMVCo QR thanh toán của NAPAS) cho chuyển khoản nhanh 24/7 tới tài khoản, có sẵn số tiền + nội dung.
 * Thu ngân vẫn phải kiểm tra tiền đã về trong ứng dụng ngân hàng rồi mới bấm xác nhận (chưa nối API ngân hàng).
 */
const tlv = (id: string, value: string): string => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (đa thức 0x1021, khởi tạo 0xFFFF), 4 ký tự hex in hoa. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (const b of new TextEncoder().encode(s)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Nội dung chuyển khoản an toàn cho mọi ngân hàng: chữ in hoa không dấu, số, khoảng trắng; tối đa 25 ký tự. */
export function transferNote(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25)
    .trim();
}

export function vietQrPayload(x: { bin: string; account: string; amount: number; note: string }): string {
  if (!/^\d{6}$/.test(x.bin) || !/^[0-9A-Za-z]{4,19}$/.test(x.account)) throw new Error('invalid bank');
  if (!Number.isSafeInteger(x.amount) || x.amount <= 0) throw new Error('invalid amount');
  const body =
    tlv('00', '01') +
    tlv('01', '12') + // QR động (có số tiền)
    tlv('38', tlv('00', 'A000000727') + tlv('01', tlv('00', x.bin) + tlv('01', x.account)) + tlv('02', 'QRIBFTTA')) +
    tlv('53', '704') +
    tlv('54', String(x.amount)) +
    tlv('58', 'VN') +
    tlv('62', tlv('08', transferNote(x.note))) +
    '6304';
  return body + crc16(body);
}
