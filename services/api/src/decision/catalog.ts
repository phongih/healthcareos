/**
 * HCOS-F11 | Danh mục ĐÓNG của Decision Engine: bộ phát hiện (detector), chỉ số của từng bộ, phép so sánh, hành động,
 * và vai trò được phép nhận thông báo của từng bộ. Luật lạ (detector / chỉ số / hành động không có ở đây) bị từ chối khi lưu.
 *
 * Vai trò nhận được giới hạn theo nội dung: ví dụ cảnh báo sinh hiệu không bao giờ gửi cho thu ngân, lệch quỹ không gửi cho dược.
 */
import type { Role } from '../../../../packages/domain/src/s0-contracts';

export type NotifyRole = 'doctor' | 'clinic_staff' | 'cashier' | 'pharmacist' | 'pharmacy_admin' | 'clinic_admin' | 'executive';
export type ActionId = 'log_only' | 'suggest' | `notify_${NotifyRole}`;
export type Op = '<' | '<=' | '>' | '>=' | '=' | '!=';
export const OPS: readonly Op[] = ['<', '<=', '>', '>=', '=', '!='];

export interface MetricSpec {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
}
export type DetectorGroup = 'clinical' | 'operations' | 'pharmacy' | 'finance' | 'equipment' | 'security';
export interface DetectorSpec {
  readonly id: string;
  readonly group: DetectorGroup;
  readonly label: string;
  readonly description: string;
  /** Mô tả cách tính / nguồn dữ liệu, hiện cho quản lý khi tạo luật. */
  readonly method: string;
  readonly metrics: readonly MetricSpec[];
  readonly targets: readonly NotifyRole[];
  /** Nhãn nút "Áp dụng" của gợi ý (mở màn hình nghiệp vụ). */
  readonly suggestion: string;
}

const m = (id: string, label: string, unit = ''): MetricSpec => ({ id, label, unit });

export const DETECTORS: readonly DetectorSpec[] = [
  {
    id: 'vital_abnormal', group: 'clinical', label: 'Sinh hiệu bất thường',
    description: 'Chỉ số sinh hiệu mới nhất của đợt khám đang mở (24 giờ qua).',
    method: 'Lấy kết quả đo cuối cùng theo từng loại của mỗi đợt khám đang mở (bỏ kết quả đã bị thay thế / nhập nhầm).',
    metrics: [
      m('spo2_pct', 'SpO₂', '%'), m('temperature_c', 'Nhiệt độ', '°C'), m('pulse_bpm', 'Mạch', 'lần/phút'),
      m('systolic_mmhg', 'Huyết áp tâm thu', 'mmHg'), m('diastolic_mmhg', 'Huyết áp tâm trương', 'mmHg'), m('age_minutes', 'Đo cách đây', 'phút'),
    ],
    targets: ['doctor', 'clinic_staff', 'clinic_admin'],
    suggestion: 'Mở hồ sơ đợt khám',
  },
  {
    id: 'room_overload', group: 'operations', label: 'Phòng khám sắp quá tải',
    description: 'Dự báo tải 7 ngày tới theo ngày × buổi × phòng (cùng công thức màn Dự báo).',
    method: 'Vãng lai theo thứ × buổi (8 tuần) + lịch đã đặt × tỷ lệ đến + tái khám dự kiến, so với sức khám mỗi buổi đã khai báo.',
    metrics: [m('utilization_pct', 'Mức tải', '%'), m('forecast_visits', 'Lượt dự báo', 'lượt'), m('capacity', 'Sức khám', 'lượt'), m('days_ahead', 'Còn', 'ngày')],
    targets: ['clinic_admin', 'clinic_staff', 'doctor', 'executive'],
    suggestion: 'Mở dự báo tải',
  },
  {
    id: 'stock_low', group: 'pharmacy', label: 'Thuốc / vật tư dưới điểm đặt hàng',
    description: 'Tồn khả dụng so với điểm đặt hàng lại (ROP) có hiệu chỉnh xu hướng ICD-10.',
    method: 'ROP = tiêu thụ ngày × thời gian chờ hàng + tồn an toàn (z × σ × √L); chỉ xét thuốc có tiêu thụ.',
    metrics: [
      m('below_reorder_point', 'Dưới điểm đặt hàng (1 = có)'), m('days_of_cover', 'Đủ dùng', 'ngày'), m('available_qty', 'Tồn khả dụng'),
      m('reorder_point', 'Điểm đặt hàng'), m('suggested_order', 'Lượng đặt gợi ý'), m('trend_factor', 'Hệ số xu hướng'),
    ],
    targets: ['pharmacy_admin', 'pharmacist', 'clinic_admin', 'executive'],
    suggestion: 'Mở dự báo tồn kho',
  },
  {
    id: 'stock_expiry', group: 'pharmacy', label: 'Thuốc sắp hết hạn',
    description: 'Lô gần hết hạn và lượng có thể hết hạn trước khi dùng hết (FEFO).',
    method: 'Giả định dùng đều theo tiêu thụ đã hiệu chỉnh, cấp theo lô hết hạn trước.',
    metrics: [m('days_to_expiry', 'Lô gần nhất còn', 'ngày'), m('expiry_risk_qty', 'Có thể hết hạn'), m('available_qty', 'Tồn khả dụng')],
    targets: ['pharmacy_admin', 'pharmacist', 'clinic_admin', 'executive'],
    suggestion: 'Mở dự báo tồn kho',
  },
  {
    id: 'cash_difference', group: 'finance', label: 'Lệch quỹ cuối ca',
    description: 'Ca thu ngân đã đóng trong 7 ngày có tiền đếm khác tiền dự kiến.',
    method: 'Chênh lệch = tiền mặt đếm thực tế − (quỹ đầu ca + thu tiền mặt − chi tiền mặt), do CSDL tính khi đóng ca.',
    metrics: [m('abs_difference_vnd', 'Lệch (trị tuyệt đối)', 'đ'), m('difference_vnd', 'Lệch (thừa + / thiếu −)', 'đ'), m('hours_since_close', 'Đóng ca cách đây', 'giờ')],
    targets: ['clinic_admin', 'executive'],
    suggestion: 'Mở báo cáo ca',
  },
  {
    id: 'receipt_cancellations', group: 'finance', label: 'Huỷ phiếu bất thường',
    description: 'Số phiếu thu / chi bị huỷ của từng thu ngân trong 7 ngày.',
    method: 'Đếm phiếu huỷ theo người lập; điểm bất thường = robust z-score của tỷ lệ huỷ so với các thu ngân khác (cần ≥ 3 người).',
    metrics: [m('cancel_count', 'Số phiếu huỷ'), m('cancel_pct', 'Tỷ lệ huỷ', '%'), m('receipt_count', 'Số phiếu đã lập'), m('robust_z', 'Điểm bất thường (z)')],
    targets: ['clinic_admin', 'executive'],
    suggestion: 'Mở báo cáo kiểm soát',
  },
  {
    id: 'booking_no_show', group: 'operations', label: 'Tỷ lệ vắng lịch hẹn tăng',
    description: 'Tỷ lệ lịch hẹn không đến trong 7 ngày qua so với 8 tuần trước.',
    method: 'Vắng = lịch đánh dấu vắng hoặc vẫn "đã đặt" sau ngày hẹn; z-score robust theo tỷ lệ vắng từng tuần.',
    metrics: [m('no_show_pct', 'Tỷ lệ vắng 7 ngày', '%'), m('no_show_count', 'Số lịch vắng'), m('booked_count', 'Số lịch hẹn'), m('baseline_pct', 'Tỷ lệ vắng 8 tuần trước', '%'), m('robust_z', 'Điểm bất thường (z)')],
    targets: ['clinic_admin', 'clinic_staff', 'executive'],
    suggestion: 'Mở lịch hẹn',
  },
  {
    id: 'deposit_aging', group: 'finance', label: 'Tạm ứng treo lâu',
    description: 'Hồ sơ thanh toán còn mở đang giữ tiền của người bệnh.',
    method: 'Tiền đang giữ = phiếu thu hợp lệ − phiếu chi hợp lệ; tuổi = số ngày từ khi mở hồ sơ.',
    metrics: [m('age_days', 'Mở được', 'ngày'), m('held_vnd', 'Đang giữ', 'đ'), m('balance_due_vnd', 'Còn phải thu', 'đ')],
    targets: ['cashier', 'clinic_admin', 'executive'],
    suggestion: 'Mở hồ sơ thanh toán',
  },
  {
    id: 'icd_spike', group: 'clinical', label: 'Mã bệnh tăng đột biến',
    description: 'Số ca theo mã ICD-10 trong 7 ngày gần nhất so với 21 ngày trước (tín hiệu dịch tễ sớm).',
    method: 'Kỳ vọng = trung bình tuần của 21 ngày trước; z = (thực − kỳ vọng) / √kỳ vọng (Poisson).',
    metrics: [m('last7_count', 'Số ca 7 ngày'), m('prior_weekly_avg', 'Trung bình tuần trước đó'), m('ratio', 'Gấp (lần)'), m('poisson_z', 'Điểm bất thường (z)')],
    targets: ['doctor', 'clinic_admin', 'executive'],
    suggestion: 'Mở dự báo',
  },
  {
    id: 'rx_not_dispensed', group: 'pharmacy', label: 'Đơn thuốc chưa phát',
    description: 'Đơn còn hiệu lực (30 ngày) có dòng thuốc chưa phát đủ.',
    method: 'So số lượng đã phát với số lượng kê của từng dòng.',
    metrics: [m('age_hours', 'Kê cách đây', 'giờ'), m('undispensed_items', 'Số dòng chưa phát đủ')],
    targets: ['pharmacist', 'pharmacy_admin', 'doctor', 'clinic_admin'],
    suggestion: 'Mở quầy dược',
  },
  {
    id: 'visit_volume', group: 'operations', label: 'Lượt khám bất thường',
    description: 'Lượt khám hôm qua so với cùng thứ 8 tuần trước.',
    method: 'Robust z-score (trung vị, MAD) theo cùng thứ trong tuần; cần ≥ 4 tuần lịch sử.',
    metrics: [m('visits', 'Lượt khám hôm qua'), m('baseline_median', 'Trung vị cùng thứ'), m('robust_z', 'Điểm bất thường (z)'), m('abs_robust_z', 'Độ lệch (|z|)')],
    targets: ['clinic_admin', 'executive'],
    suggestion: 'Mở báo cáo',
  },
  {
    id: 'device_inspection', group: 'equipment', label: 'Thiết bị đến hạn / quá hạn kiểm định',
    description: 'Từng chế độ kiểm định / hiệu chuẩn đang áp dụng của thiết bị chưa thanh lý.',
    method: 'Hạn = "hiệu lực đến" của lần gần nhất. Quá hạn cũng gồm: chưa kiểm định lần nào, kết quả không đạt, sửa chữa lớn sau lần gần nhất.',
    metrics: [m('days_to_due', 'Còn', 'ngày'), m('overdue', 'Quá hạn / không đạt / chưa có (1 = có)'), m('mandatory', 'Bắt buộc (1 = có)')],
    targets: ['clinic_admin', 'clinic_staff', 'doctor', 'executive'],
    suggestion: 'Mở trang thiết bị',
  },
  {
    id: 'device_out_of_service', group: 'equipment', label: 'Thiết bị hỏng / đang bảo trì',
    description: 'Thiết bị đang ở trạng thái Hỏng hoặc Bảo trì (không được chỉ định dịch vụ dùng máy).',
    method: 'Trạng thái lấy từ nhật ký thiết bị (báo hỏng qua QR, bắt đầu bảo trì).',
    metrics: [m('out_of_service', 'Ngừng dùng (1 = có)'), m('broken', 'Hỏng (1 = có)'), m('hours_out', 'Đã ngừng', 'giờ')],
    targets: ['clinic_admin', 'clinic_staff', 'doctor', 'executive'],
    suggestion: 'Mở trang thiết bị',
  },
  {
    id: 'supply_shortfall', group: 'equipment', label: 'Vật tư thiếu khi tất toán',
    description: 'Dòng vật tư theo định mức không đủ tồn ở kho trừ lúc tất toán, chưa đối soát.',
    method: 'Tổng số lượng thiếu chưa đối soát theo từng vật tư (30 ngày).',
    metrics: [m('shortfall_qty', 'Thiếu'), m('lines', 'Số dòng'), m('oldest_hours', 'Dòng cũ nhất', 'giờ')],
    targets: ['pharmacy_admin', 'clinic_admin', 'executive'],
    suggestion: 'Mở vật tư',
  },
  {
    id: 'portal_otp_abuse', group: 'security', label: 'Cổng bệnh nhân: OTP bất thường từ một địa chỉ',
    description: 'Số lần yêu cầu mã / nhập sai mã OTP của cổng bệnh nhân theo từng địa chỉ mạng (chỉ lưu HMAC của IP) trong 60 phút.',
    method: 'Đếm thử thách OTP và số lần nhập sai trong 60 phút theo HMAC địa chỉ IP; số định danh khác nhau cho thấy dò tài khoản.',
    metrics: [m('failed_verifications', 'Nhập sai mã'), m('otp_requests', 'Yêu cầu mã'), m('distinct_targets', 'Định danh khác nhau')],
    targets: ['clinic_admin', 'executive'],
    suggestion: 'Xem nhật ký kiểm toán',
  },
];
export const DETECTOR_BY_ID: ReadonlyMap<string, DetectorSpec> = new Map(DETECTORS.map((d) => [d.id, d]));

export const NOTIFY_ROLES: readonly NotifyRole[] = ['doctor', 'clinic_staff', 'cashier', 'pharmacist', 'pharmacy_admin', 'clinic_admin', 'executive'];
export const ACTIONS: readonly { id: ActionId; label: string }[] = [
  { id: 'log_only', label: 'Chỉ ghi nhật ký' },
  { id: 'suggest', label: 'Kèm gợi ý (người dùng bấm Áp dụng)' },
  { id: 'notify_doctor', label: 'Báo bác sĩ' },
  { id: 'notify_clinic_staff', label: 'Báo điều dưỡng / lễ tân' },
  { id: 'notify_cashier', label: 'Báo thu ngân' },
  { id: 'notify_pharmacist', label: 'Báo dược sĩ' },
  { id: 'notify_pharmacy_admin', label: 'Báo quản lý kho dược' },
  { id: 'notify_clinic_admin', label: 'Báo quản lý phòng khám' },
  { id: 'notify_executive', label: 'Báo ban giám đốc' },
];
export const ACTION_IDS: ReadonlySet<string> = new Set(ACTIONS.map((a) => a.id));

export interface Condition {
  readonly metric: string;
  readonly op: Op;
  readonly value: number;
}

/** Kiểm tra luật theo danh mục; trả về danh sách lỗi (rỗng = hợp lệ). */
export function validateRule(r: { detector: string; conditions: unknown; actions: unknown; priority: unknown; cooldownMinutes: unknown; name: unknown }): string[] {
  const errs: string[] = [];
  const d = DETECTOR_BY_ID.get(r.detector);
  if (!d) errs.push(`Unknown detector ${r.detector}`);
  if (typeof r.name !== 'string' || r.name.trim().length < 3 || r.name.trim().length > 120) errs.push('name must be 3..120 characters');
  if (!Number.isInteger(r.priority) || (r.priority as number) < 1 || (r.priority as number) > 3) errs.push('priority must be 1..3');
  if (!Number.isInteger(r.cooldownMinutes) || (r.cooldownMinutes as number) < 0 || (r.cooldownMinutes as number) > 43_200) errs.push('cooldownMinutes must be 0..43200');
  if (!Array.isArray(r.conditions) || r.conditions.length < 1 || r.conditions.length > 5) errs.push('conditions must have 1..5 items');
  else
    for (const [i, c] of (r.conditions as unknown[]).entries()) {
      const x = c as Partial<Condition> | null;
      if (!x || typeof x !== 'object' || Array.isArray(x)) {
        errs.push(`conditions[${i}] must be an object`);
        continue;
      }
      const keys = Object.keys(x);
      if (keys.some((k) => !['metric', 'op', 'value'].includes(k))) errs.push(`conditions[${i}] has unknown fields`);
      if (d && !d.metrics.some((mm) => mm.id === x.metric)) errs.push(`conditions[${i}].metric ${String(x.metric)} is not a metric of ${d.id}`);
      if (!OPS.includes(x.op as Op)) errs.push(`conditions[${i}].op must be one of ${OPS.join(' ')}`);
      if (typeof x.value !== 'number' || !Number.isFinite(x.value) || Math.abs(x.value) > 1e12) errs.push(`conditions[${i}].value must be a finite number`);
    }
  if (!Array.isArray(r.actions) || r.actions.length < 1 || r.actions.length > 8) errs.push('actions must have 1..8 items');
  else {
    const a = r.actions as unknown[];
    if (a.some((x) => typeof x !== 'string' || !ACTION_IDS.has(x))) errs.push('actions contains an unknown action');
    if (new Set(a).size !== a.length) errs.push('actions must be distinct');
    if (a.includes('log_only') && a.length > 1) errs.push('log_only cannot be combined with other actions');
    const notifies = a.filter((x): x is string => typeof x === 'string' && x.startsWith('notify_'));
    if (a.includes('suggest') && notifies.length === 0) errs.push('suggest requires at least one notify action');
    if (d) for (const n of notifies) if (!d.targets.includes(n.slice('notify_'.length) as NotifyRole)) errs.push(`${n} is not allowed for ${d.id}`);
  }
  return errs;
}

export function matches(conditions: readonly Condition[], metrics: Readonly<Record<string, number | null | undefined>>): boolean {
  return conditions.every((c) => {
    const v = metrics[c.metric];
    if (v === null || v === undefined || !Number.isFinite(v)) return false; // thiếu chỉ số => không khớp (fail-closed)
    switch (c.op) {
      case '<': return v < c.value;
      case '<=': return v <= c.value;
      case '>': return v > c.value;
      case '>=': return v >= c.value;
      case '=': return v === c.value;
      case '!=': return v !== c.value;
      default: return false;
    }
  });
}

/** Vai trò membership nào xem được thông báo gửi tới `target`. */
export function rolesSeeing(target: NotifyRole): readonly Role[] {
  return target === 'clinic_admin' ? ['clinic_admin', 'tenant_admin'] : [target];
}
