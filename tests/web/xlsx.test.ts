/** Ghi .xlsx tối giản: cấu trúc ZIP đúng (CRC, thư mục trung tâm), XML hợp lệ, số là số, chuỗi được escape; sheet báo cáo. */
import { describe, expect, it } from 'vitest';

import { reportSheets, type ReportData } from '../../packages/exports/src/report-sheets';
import { buildXlsx, crc32, sheetName } from '../../packages/exports/src/xlsx';

/** Đọc ZIP kiểu STORE (đủ cho file do buildXlsx tạo), kiểm CRC từng mục. */
function unzip(buf: Uint8Array): Map<string, string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    expect(dv.getUint32(off, true)).toBe(0x04034b50);
    const start = off + 30 + dv.getUint16(off + 26, true);
    const data = buf.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    p += 46 + nameLen;
  }
  return out;
}

describe('xlsx', () => {
  it('CRC-32 đúng vector chuẩn', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });
  it('tên sheet: bỏ ký tự cấm, ≤ 31 ký tự, không trùng', () => {
    const used = new Set<string>();
    expect(sheetName('Tạm ứng & công nợ', used)).toBe('Tạm ứng & công nợ');
    expect(sheetName('a/b:c', used)).toBe('a b c');
    expect(sheetName('x'.repeat(40), used)).toHaveLength(31);
    expect(sheetName('A B C', used)).toBe('A B C 2'); // Excel không phân biệt hoa/thường
  });
  it('đóng gói đủ phần, số là ô số, chuỗi có <&> được escape, có cố định dòng đầu cột', () => {
    const z = unzip(buildXlsx([{ name: 'S1', title: ['Tiêu đề'], columns: [{ header: 'Tên' }, { header: 'Tiền', money: true }], rows: [['A <&> "B"', 1500000], { cells: ['Cộng', 1500000], bold: true }] }]));
    expect([...z.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const s = z.get('xl/worksheets/sheet1.xml')!;
    expect(s).toContain('A &lt;&amp;&gt; &quot;B&quot;');
    expect(s).toContain('<c r="B4" s="2"><v>1500000</v></c>');
    expect(s).toContain('<c r="B5" s="3"><v>1500000</v></c>');
    expect(s).toContain('ySplit="3"');
    expect(z.get('xl/workbook.xml')).toContain('name="S1"');
  });
  it('báo cáo => 6 sheet, tổng hợp có thực thu ròng và doanh thu dịch vụ', () => {
    const zero = { cash: { in: 0, out: 0 }, bank_transfer: { in: 0, out: 0 }, card: { in: 0, out: 0 } };
    const r: ReportData = {
      from: '2026-11-01', to: '2026-11-20', generatedAt: '2026-11-20T12:00:00Z',
      cashflow: {
        days: [{ date: '2026-11-20', deposit: 500000, payment: 200000, refund: 170000, net: 530000, receiptCount: 3, byMethod: { ...zero, cash: { in: 500000, out: 170000 }, card: { in: 200000, out: 0 } } }],
        totals: { deposit: 500000, payment: 200000, refund: 170000, net: 530000, receiptCount: 3, byMethod: { ...zero, cash: { in: 500000, out: 170000 }, card: { in: 200000, out: 0 } } },
      },
      services: { items: [{ code: 'KB-NOI', name: 'Khám nội', category: 'exam', quantity: 1, amount: 150000, cases: 1 }], byCategory: [{ category: 'exam', quantity: 1, amount: 150000 }], total: 150000 },
      openCases: { cases: [], depositsHeld: 0, receivable: 0 },
      cashiers: [],
      controls: { cancelledReceipts: [], voidedCharges: [] },
    };
    const sheets = reportSheets(r, 'Phòng khám A');
    expect(sheets.map((s) => s.name)).toEqual(['Tổng hợp', 'Thực thu theo ngày', 'Theo dịch vụ', 'Tạm ứng & công nợ', 'Theo thu ngân', 'Phiếu huỷ & chi phí gỡ']);
    const z = unzip(buildXlsx(sheets));
    const s1 = z.get('xl/worksheets/sheet1.xml')!;
    expect(s1).toContain('THỰC THU RÒNG');
    expect(s1).toContain('<v>530000</v>');
    expect(s1).toContain('Từ 01/11/2026 đến 20/11/2026');
  });
});
