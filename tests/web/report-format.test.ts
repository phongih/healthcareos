/**
 * Web giữ bản sao nhỏ của kiểu ReportData + định dạng (build web độc lập, không import packages/).
 * Test này giữ bản sao khớp với bản dùng cho xuất Excel ở máy chủ — kiểu (lúc typecheck) và giá trị (lúc chạy).
 */
import { describe, expect, it } from 'vitest';

import * as server from '../../packages/exports/src/report-sheets';
import * as web from '../../apps/web/src/lib/report-format';

// Kiểm tra lúc typecheck: hai kiểu gán được cho nhau.
const a: web.ReportData = {} as server.ReportData;
const b: server.ReportData = {} as web.ReportData;
void a;
void b;

describe('report-format (web) khớp report-sheets (máy chủ)', () => {
  it('nhãn và hàm định dạng giống nhau', () => {
    expect(web.CATEGORY_LABEL).toEqual(server.CATEGORY_LABEL);
    expect(web.dmy('2026-11-21')).toBe(server.dmy('2026-11-21'));
    expect(web.vnTime('2026-11-21T03:04:05Z')).toBe(server.vnTime('2026-11-21T03:04:05Z'));
  });
});
