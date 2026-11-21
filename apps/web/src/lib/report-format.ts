/**
 * Kiểu dữ liệu + định dạng của báo cáo tài chính (HCOS-F9) dùng trên giao diện.
 * Web build ĐỘC LẬP (staging chỉ mount apps/web vào container build) nên không import từ packages/.
 * Bản dùng cho xuất Excel ở máy chủ: packages/exports/src/report-sheets.ts — tests/web/report-format.test.ts giữ hai bên khớp nhau.
 */
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
/** dd/mm/yyyy từ YYYY-MM-DD. */
export const dmy = (d: string): string => d.split('-').reverse().join('/');
/** Giờ Việt Nam, dd/mm/yyyy HH:MM. */
export const vnTime = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso));

