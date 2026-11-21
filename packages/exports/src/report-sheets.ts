/** Báo cáo tài chính (HCOS-F9) => các sheet Excel. Không phụ thuộc React để test được ở Node. */
import type { SheetSpec } from './xlsx';

type Method = 'cash' | 'bank_transfer' | 'card';
type Kind = 'deposit' | 'payment' | 'refund';
export interface ReportData {
  from: string;
  to: string;
  generatedAt: string;
  cashflow: {
    days: Array<{ date: string; deposit: number; payment: number; refund: number; net: number; receiptCount: number; byMethod: Record<Method, { in: number; out: number }> }>;
    totals: { deposit: number; payment: number; refund: number; net: number; receiptCount: number; byMethod: Record<Method, { in: number; out: number }> };
  };
  services: {
    items: Array<{ code: string; name: string; category: string; quantity: number; amount: number; cases: number }>;
    byCategory: Array<{ category: string; quantity: number; amount: number }>;
    total: number;
  };
  openCases: {
    cases: Array<{ caseId: string; openedAt: string; patient: { mrn: string; familyName: string; givenName: string }; totals: { charges: number; received: number; refunded: number; balance: number } }>;
    depositsHeld: number;
    receivable: number;
  };
  cashiers: Array<{
    name: string | null; receiptCount: number; in: number; out: number; cancelledCount: number; cancelledAmount: number; voidedCharges: number;
    shifts: number; openShifts: number; cashDifference: number;
  }>;
  controls: {
    cancelledReceipts: Array<{ receiptNo: string; kind: Kind; method: Method; amount: number; patientName: string; mrn: string; createdByName: string | null; createdAt: string; cancelledByName: string | null; cancelledAt: string; reason: string }>;
    voidedCharges: Array<{ itemCode: string; description: string; quantity: number; amount: number; patientName: string; mrn: string; createdByName: string | null; createdAt: string; voidedByName: string | null; voidedAt: string; reason: string }>;
  };
}

export const CATEGORY_LABEL: Record<string, string> = { exam: 'Khám', procedure: 'Thủ thuật', lab: 'Xét nghiệm', imaging: 'Chẩn đoán hình ảnh', drug: 'Thuốc', other: 'Khác' };
const KIND: Record<Kind, string> = { deposit: 'Tạm ứng', payment: 'Thanh toán', refund: 'Hoàn ứng' };
const METHOD: Record<Method, string> = { cash: 'Tiền mặt', bank_transfer: 'Chuyển khoản', card: 'Thẻ (POS)' };
/** dd/mm/yyyy từ YYYY-MM-DD. */
export const dmy = (d: string): string => d.split('-').reverse().join('/');
/** Giờ Việt Nam, dd/mm/yyyy HH:MM. */
export const vnTime = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso));

export function reportSheets(r: ReportData, orgName: string): SheetSpec[] {
  const period = r.from === r.to ? `Ngày ${dmy(r.from)}` : `Từ ${dmy(r.from)} đến ${dmy(r.to)}`;
  const head = (title: string, note?: string) => [`${title} — ${orgName}`, `${period} (giờ Việt Nam) · lập lúc ${vnTime(r.generatedAt)}`, ...(note ? [note] : [])];
  const t = r.cashflow.totals;
  const svc = r.services;
  return [
    {
      name: 'Tổng hợp',
      title: head('BÁO CÁO TÀI CHÍNH', 'Thực thu = tiền vào/ra két theo phiếu hợp lệ. Doanh thu dịch vụ = chi phí đã ghi (còn hiệu lực). Tạm ứng là tiền giữ hộ, chưa phải doanh thu.'),
      columns: [{ header: 'Chỉ tiêu', width: 48 }, { header: 'Số tiền (đ)', width: 18, money: true }],
      rows: [
        ['Thu tạm ứng', t.deposit],
        ['Thu thanh toán', t.payment],
        ['Chi hoàn ứng', t.refund],
        { cells: ['THỰC THU RÒNG', t.net], bold: true },
        ['  · Tiền mặt (thu − chi)', t.byMethod.cash.in - t.byMethod.cash.out],
        ['  · Chuyển khoản (thu − chi)', t.byMethod.bank_transfer.in - t.byMethod.bank_transfer.out],
        ['  · Thẻ POS (thu − chi)', t.byMethod.card.in - t.byMethod.card.out],
        ['Số phiếu hợp lệ', t.receiptCount],
        [null, null],
        { cells: ['DOANH THU DỊCH VỤ', svc.total], bold: true },
        ...svc.byCategory.map((c) => [`  · ${CATEGORY_LABEL[c.category] ?? c.category}`, c.amount]),
        [null, null],
        ['Tạm ứng còn giữ (hồ sơ đang mở, hiện tại)', r.openCases.depositsHeld],
        ['Còn phải thu (hồ sơ đang mở, hiện tại)', r.openCases.receivable],
        ['Phiếu đã huỷ trong kỳ (số phiếu)', r.controls.cancelledReceipts.length],
        ['Chi phí đã gỡ trong kỳ (số dòng)', r.controls.voidedCharges.length],
      ],
    },
    {
      name: 'Thực thu theo ngày',
      title: head('THỰC THU THEO NGÀY'),
      columns: [
        { header: 'Ngày', width: 12 }, { header: 'Tạm ứng', money: true, width: 14 }, { header: 'Thanh toán', money: true, width: 14 },
        { header: 'Hoàn ứng', money: true, width: 14 }, { header: 'Thực thu ròng', money: true, width: 16 },
        { header: 'Tiền mặt thu', money: true, width: 14 }, { header: 'Tiền mặt chi', money: true, width: 14 },
        { header: 'Chuyển khoản', money: true, width: 14 }, { header: 'Thẻ', money: true, width: 14 }, { header: 'Số phiếu', money: true, width: 10 },
      ],
      rows: [
        ...r.cashflow.days.map((d) => [
          dmy(d.date), d.deposit, d.payment, d.refund, d.net, d.byMethod.cash.in, d.byMethod.cash.out,
          d.byMethod.bank_transfer.in - d.byMethod.bank_transfer.out, d.byMethod.card.in - d.byMethod.card.out, d.receiptCount,
        ]),
        {
          cells: ['Cộng', t.deposit, t.payment, t.refund, t.net, t.byMethod.cash.in, t.byMethod.cash.out,
            t.byMethod.bank_transfer.in - t.byMethod.bank_transfer.out, t.byMethod.card.in - t.byMethod.card.out, t.receiptCount],
          bold: true,
        },
      ],
    },
    {
      name: 'Theo dịch vụ',
      title: head('DOANH THU THEO DỊCH VỤ', 'Theo chi phí đã ghi trong kỳ, đơn giá tại thời điểm ghi; không tính dòng đã gỡ.'),
      columns: [
        { header: 'Mã', width: 12 }, { header: 'Dịch vụ', width: 40 }, { header: 'Nhóm', width: 20 },
        { header: 'Số lượng', money: true, width: 10 }, { header: 'Số hồ sơ', money: true, width: 10 }, { header: 'Thành tiền', money: true, width: 16 },
      ],
      rows: [
        ...svc.items.map((i) => [i.code, i.name, CATEGORY_LABEL[i.category] ?? i.category, i.quantity, i.cases, i.amount]),
        { cells: ['Cộng', null, null, svc.items.reduce((s, i) => s + i.quantity, 0), null, svc.total], bold: true },
        [null],
        { cells: ['Theo nhóm'], bold: true },
        ...svc.byCategory.map((c) => [null, null, CATEGORY_LABEL[c.category] ?? c.category, c.quantity, null, c.amount]),
      ],
    },
    {
      name: 'Tạm ứng & công nợ',
      title: head('HỒ SƠ THANH TOÁN ĐANG MỞ', 'Số liệu tại thời điểm lập báo cáo (không phụ thuộc kỳ). Số dư > 0: tạm ứng còn giữ; < 0: còn phải thu.'),
      columns: [
        { header: 'Mở lúc', width: 18 }, { header: 'MRN', width: 12 }, { header: 'Bệnh nhân', width: 28 }, { header: 'Chi phí', money: true, width: 14 },
        { header: 'Đã thu', money: true, width: 14 }, { header: 'Đã hoàn', money: true, width: 14 }, { header: 'Số dư', money: true, width: 14 },
      ],
      rows: [
        ...r.openCases.cases.map((c) => [vnTime(c.openedAt), c.patient.mrn, `${c.patient.familyName} ${c.patient.givenName}`, c.totals.charges, c.totals.received, c.totals.refunded, c.totals.balance]),
        { cells: ['Tạm ứng còn giữ', null, null, null, null, null, r.openCases.depositsHeld], bold: true },
        { cells: ['Còn phải thu', null, null, null, null, null, r.openCases.receivable], bold: true },
      ],
    },
    {
      name: 'Theo thu ngân',
      title: head('THEO THU NGÂN'),
      columns: [
        { header: 'Thu ngân', width: 26 }, { header: 'Số phiếu', money: true, width: 10 }, { header: 'Thu', money: true, width: 14 }, { header: 'Chi', money: true, width: 14 },
        { header: 'Phiếu huỷ', money: true, width: 10 }, { header: 'Tiền phiếu huỷ', money: true, width: 14 }, { header: 'Chi phí gỡ', money: true, width: 10 },
        { header: 'Số ca', money: true, width: 8 }, { header: 'Ca chưa đóng', money: true, width: 12 }, { header: 'Chênh lệch két', money: true, width: 14 },
      ],
      rows: r.cashiers.map((c) => [c.name ?? '', c.receiptCount, c.in, c.out, c.cancelledCount, c.cancelledAmount, c.voidedCharges, c.shifts, c.openShifts, c.cashDifference]),
    },
    {
      name: 'Phiếu huỷ & chi phí gỡ',
      title: head('KIỂM SOÁT: PHIẾU HUỶ VÀ CHI PHÍ GỠ TRONG KỲ'),
      columns: [
        { header: 'Loại', width: 12 }, { header: 'Số phiếu / mã DV', width: 18 }, { header: 'Nội dung', width: 26 }, { header: 'Số tiền', money: true, width: 14 },
        { header: 'Bệnh nhân', width: 26 }, { header: 'MRN', width: 12 }, { header: 'Người lập', width: 20 }, { header: 'Lập lúc', width: 18 },
        { header: 'Người huỷ / gỡ', width: 20 }, { header: 'Huỷ / gỡ lúc', width: 18 }, { header: 'Lý do', width: 36 },
      ],
      rows: [
        ...r.controls.cancelledReceipts.map((x) => [
          'Phiếu huỷ', x.receiptNo, `${KIND[x.kind]} · ${METHOD[x.method]}`, x.amount, x.patientName, x.mrn, x.createdByName ?? '', vnTime(x.createdAt),
          x.cancelledByName ?? '', vnTime(x.cancelledAt), x.reason,
        ]),
        ...r.controls.voidedCharges.map((x) => [
          'Chi phí gỡ', x.itemCode, `${x.description} × ${x.quantity}`, x.amount, x.patientName, x.mrn, x.createdByName ?? '', vnTime(x.createdAt),
          x.voidedByName ?? '', vnTime(x.voidedAt), x.reason,
        ]),
      ],
    },
  ];
}
