/**
 * HCOS-F17 | Chính sách lưu giữ & xoá.
 *
 * Sàn pháp lý và mặc định được CSDL thực thi (governance.retention_floor / retention_default, CHECK trên retention_settings);
 * bản dưới đây dùng cho giao diện, biên nhận và hồ sơ tự đánh giá — test tích hợp đối chiếu hai bên phải khớp.
 *
 * Bốn loại hành động, không lẫn với nhau:
 *   anonymize   ẩn danh: huỷ khoá chủ thể + xoá trường định danh, giữ dòng cho thống kê (lịch hẹn).
 *   delete      xoá dữ liệu nghiệp vụ / kỹ thuật hết mục đích (idempotency, outbox).
 *   hold        GIỮ theo nghĩa vụ pháp lý: không tự xoá; chặn / hoãn yêu cầu xoá cho tới hết hạn giữ.
 * Thời hạn pháp lý cần pháp chế xác nhận trước khi dùng thật.
 */
import { createHash } from 'node:crypto';

export type RetentionRuleId = 'booking_contact' | 'idempotency' | 'outbox' | 'medical_record' | 'financial_record';
export type RetentionAction = 'anonymize' | 'delete' | 'hold';

export interface RetentionRule {
  readonly id: RetentionRuleId;
  readonly label: string;
  readonly tables: readonly string[];
  readonly action: RetentionAction;
  readonly floorDays: number;
  readonly defaultDays: number;
  /** Mốc tính thời hạn. */
  readonly from: string;
  readonly legalBasis: string;
}

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    id: 'booking_contact', label: 'Lịch hẹn online — dữ liệu người đặt', tables: ['clinical.bookings'], action: 'anonymize',
    floorDays: 30, defaultDays: 90, from: 'ngày hẹn khám',
    legalBasis:
      'Luật Bảo vệ dữ liệu cá nhân 2025 (Điều 14): xoá khi đã hoàn thành mục đích xử lý. Lịch hẹn chỉ để check-in; giữ thêm một thời gian ' +
      'ngắn để tra cứu khiếu nại / đối soát, sau đó ẩn danh (giữ ngày, buổi, phòng, trạng thái cho thống kê).',
  },
  {
    id: 'idempotency', label: 'Kết quả API lưu để chống gửi trùng', tables: ['platform.idempotency_keys'], action: 'delete',
    floorDays: 1, defaultDays: 7, from: 'lúc tạo',
    legalBasis: 'Dữ liệu kỹ thuật, hết mục đích sau khi máy khách không còn gửi lại (nguyên tắc tối thiểu hoá, Luật Bảo vệ dữ liệu cá nhân 2025).',
  },
  {
    id: 'outbox', label: 'Sự kiện miền chờ phát (chỉ id)', tables: ['platform.outbox_events'], action: 'delete',
    floorDays: 7, defaultDays: 30, from: 'lúc tạo',
    legalBasis: 'Dữ liệu kỹ thuật (chỉ id bệnh nhân / đợt khám), hết mục đích sau khi đã phát hoặc quá hạn.',
  },
  {
    id: 'medical_record', label: 'Hồ sơ bệnh án (danh tính + dữ liệu khám)',
    tables: ['patient.persons', 'patient.identifiers', 'patient.patients', 'clinical.encounters', 'clinical.observations', 'clinical.conditions', 'clinical.prescriptions'],
    action: 'hold', floorDays: 3650, defaultDays: 3650, from: 'lần khám cuối',
    legalBasis:
      'Luật Khám bệnh, chữa bệnh 2023 (Điều 69) và văn bản hướng dẫn: hồ sơ bệnh án nội trú, ngoại trú lưu tối thiểu 10 năm ' +
      '(một số loại lâu hơn). Yêu cầu xoá của người bệnh có hồ sơ còn hạn: chỉ xoá phần không bắt buộc, hạn chế xử lý, xoá phần còn lại khi hết hạn.',
  },
  {
    id: 'financial_record', label: 'Chứng từ thu / chi', tables: ['finance.receipts', 'finance.billing_cases', 'finance.charges'], action: 'hold',
    floorDays: 3650, defaultDays: 3650, from: 'hết năm tài chính của chứng từ cuối',
    legalBasis:
      'Luật Kế toán 2015 (Điều 41), Nghị định 174/2016/NĐ-CP (Điều 13, 15): chứng từ kế toán dùng trực tiếp để ghi sổ lưu tối thiểu 10 năm, ' +
      'tính từ ngày kết thúc kỳ kế toán năm.',
  },
];

export const RETENTION_RULE_IDS = RETENTION_RULES.map((r) => r.id);
export const ruleById = (id: string): RetentionRule | undefined => RETENTION_RULES.find((r) => r.id === id);

/** Phiên bản chính sách có hiệu lực (quy tắc + số ngày của tenant): ghi vào mỗi biên nhận xoá. */
export function retentionPolicyVersion(effective: Readonly<Record<string, number>>): string {
  const body = RETENTION_RULES.map((r) => ({ id: r.id, action: r.action, floor: r.floorDays, days: effective[r.id] ?? r.defaultDays, basis: r.legalBasis }));
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export const ACTION_LABEL: Readonly<Record<RetentionAction, string>> = {
  anonymize: 'Ẩn danh (huỷ khoá chủ thể)',
  delete: 'Xoá',
  hold: 'Giữ theo nghĩa vụ pháp lý',
};
