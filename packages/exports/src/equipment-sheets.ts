/**
 * HCOS-F19 | Sổ thiết bị y tế (Excel) — hồ sơ xuất trình khi Sở Y tế thanh tra:
 * phân loại rủi ro, số lưu hành, bảo hành, kiểm định / hiệu chuẩn (chế độ, hạn, kết quả, đơn vị, số giấy chứng nhận), trạng thái,
 * khấu hao. Không có dữ liệu cá nhân.
 */
import type { SheetSpec } from './xlsx';

export interface RegisterDevice {
  readonly assetCode: string; readonly name: string; readonly typeName: string; readonly manufacturer: string | null; readonly model: string | null;
  readonly serialNo: string | null; readonly roomCode: string | null; readonly riskClass: string; readonly registrationNo: string | null;
  readonly warrantyUntil: string | null; readonly inServiceOn: string | null; readonly status: string; readonly blockers: readonly string[];
  readonly regimes: ReadonlyArray<{ regime: string; cycleMonths: number; mandatory: boolean; state: string; validUntil: string | null }>;
  readonly cost: number | null; readonly usefulLifeMonths: number | null;
  readonly depreciation: { monthly: number; accumulated: number; bookValue: number } | null;
}
export interface RegisterData {
  readonly organizationName: string;
  readonly asOf: string;
  readonly devices: readonly RegisterDevice[];
  readonly inspections: ReadonlyArray<{ assetCode: string; regime: string; performedOn: string; result: string; validUntil: string; provider: string; certificateNo: string | null }>;
}

export const REGIME_TEXT: Readonly<Record<string, string>> = {
  atkt: 'Kiểm định an toàn & tính năng kỹ thuật', do_luong: 'Kiểm định phương tiện đo', buc_xa: 'Kiểm định an toàn bức xạ',
  ap_luc: 'Kiểm định thiết bị áp lực', hieu_chuan: 'Hiệu chuẩn / bảo dưỡng định kỳ',
};
const STATUS_TEXT: Readonly<Record<string, string>> = { active: 'Đang dùng', broken: 'Hỏng', maintenance: 'Bảo trì', retired: 'Đã thanh lý' };
const STATE_TEXT: Readonly<Record<string, string>> = {
  ok: 'Còn hạn', due_soon: 'Sắp đến hạn', overdue: 'Quá hạn', failed: 'Không đạt', missing: 'Chưa kiểm định', reinspect: 'Cần kiểm định lại (sau sửa chữa lớn)',
};
const dmy = (d: string | null): string => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
export const blockerText = (b: string): string => {
  const [k, a, c] = b.split(':');
  if (k === 'status') return STATUS_TEXT[a ?? ''] ?? a ?? '';
  return `${REGIME_TEXT[a ?? ''] ?? a}: ${STATE_TEXT[c ?? ''] ?? c}`;
};

export function equipmentSheets(d: RegisterData): SheetSpec[] {
  const title = [`SỔ THIẾT BỊ Y TẾ — ${d.organizationName}`, `Tính đến ngày ${dmy(d.asOf)}. Phân loại rủi ro theo NĐ 98/2021/NĐ-CP (đã sửa đổi).`];
  return [
    {
      name: 'Sổ thiết bị', title,
      columns: [
        { header: 'Mã tài sản', width: 15 }, { header: 'Tên thiết bị', width: 32 }, { header: 'Loại', width: 20 }, { header: 'Hãng', width: 16 }, { header: 'Model', width: 16 },
        { header: 'Số serial', width: 18 }, { header: 'Phòng', width: 8 }, { header: 'Phân loại', width: 9 }, { header: 'Số lưu hành', width: 22 },
        { header: 'Bảo hành đến', width: 13 }, { header: 'Đưa vào dùng', width: 13 }, { header: 'Trạng thái', width: 12 }, { header: 'Được dùng', width: 10 },
        { header: 'Lý do không được dùng', width: 40 }, { header: 'Kiểm định / hiệu chuẩn (hạn)', width: 60 },
        { header: 'Nguyên giá', width: 14, money: true }, { header: 'Số tháng KH', width: 10 }, { header: 'KH / tháng', width: 12, money: true },
        { header: 'KH luỹ kế', width: 14, money: true }, { header: 'Giá trị còn lại', width: 14, money: true },
      ],
      rows: d.devices.map((x) => [
        x.assetCode, x.name, x.typeName, x.manufacturer ?? '', x.model ?? '', x.serialNo ?? '', x.roomCode ?? '', `Loại ${x.riskClass}`, x.registrationNo ?? '(chưa nhập)',
        dmy(x.warrantyUntil), dmy(x.inServiceOn), STATUS_TEXT[x.status] ?? x.status, x.status === 'retired' ? '' : x.blockers.length ? 'KHÔNG' : 'Có',
        x.blockers.map(blockerText).join('; '),
        x.regimes.map((r) => `${REGIME_TEXT[r.regime] ?? r.regime}${r.mandatory ? '' : ' (không bắt buộc)'}: ${STATE_TEXT[r.state] ?? r.state}${r.validUntil ? ` — hạn ${dmy(r.validUntil)}` : ''}`).join('; '),
        x.cost, x.usefulLifeMonths, x.depreciation?.monthly ?? null, x.depreciation?.accumulated ?? null, x.depreciation?.bookValue ?? null,
      ]),
    },
    {
      name: 'Kiểm định - hiệu chuẩn', title,
      columns: [
        { header: 'Mã tài sản', width: 15 }, { header: 'Chế độ', width: 38 }, { header: 'Ngày thực hiện', width: 14 }, { header: 'Kết quả', width: 10 },
        { header: 'Hiệu lực đến', width: 13 }, { header: 'Đơn vị thực hiện', width: 36 }, { header: 'Số giấy chứng nhận / tem', width: 24 },
      ],
      rows: d.inspections.map((i) => [i.assetCode, REGIME_TEXT[i.regime] ?? i.regime, dmy(i.performedOn), i.result === 'pass' ? 'Đạt' : 'Không đạt', dmy(i.validUntil), i.provider, i.certificateNo ?? '']),
    },
  ];
}
