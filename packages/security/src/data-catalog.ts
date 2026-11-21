/**
 * HCOS-F15 | Danh mục dữ liệu & phân loại cấp độ rủi ro an ninh dữ liệu (Luật An ninh dữ liệu 2026, hiệu lực 01/7/2027).
 *
 * Mỗi bảng của CSDL có MỘT nhãn: cấp độ rủi ro (1–5), nhóm dữ liệu, chủ thể dữ liệu, vai trò chịu trách nhiệm nghiệp vụ
 * (data steward), mục đích xử lý, nhóm thời hạn lưu trữ (F17 sẽ gắn thời hạn cụ thể). Cột nào khác bảng thì ghi đè.
 *
 * Quy tắc (kiểm trên CI bằng tests/integration/data-catalog-pg.integration.test.ts, chạy trên CSDL sau MỌI migration):
 *   1. Mọi bảng trong CSDL đều có nhãn; nhãn không trỏ tới bảng / cột không tồn tại.
 *   2. Bảng có dữ liệu của người (subject ≠ 'none'): mọi cột có tên gợi ý dữ liệu cá nhân / nội dung tự do
 *      (PERSONAL_HINT) phải được gắn nhãn RIÊNG — thêm cột `phone` mới không được lặng lẽ "thừa hưởng" nhãn bảng.
 *   3. Cấp độ của bảng = cấp cao nhất của các cột trong bảng (cột không được cao hơn bảng).
 *   4. Cấp độ của hệ thống = cấp độ CAO NHẤT phát sinh (nguyên tắc của luật khi một hệ thống xử lý nhiều cấp độ).
 *
 * Chủ quản dữ liệu (data owner) là cơ sở khám chữa bệnh sử dụng HealthcareOS (tenant). Nhà cung cấp phần mềm / hạ tầng là
 * bên xử lý dữ liệu và KHÔNG nhận chuyển giao trách nhiệm pháp lý. Cột `steward` là vai trò trong cơ sở chịu trách nhiệm
 * nghiệp vụ cho bảng đó (duyệt quyền truy cập, chất lượng, thời hạn lưu).
 *
 * Danh mục là mã nguồn (review qua PR, có lịch sử git) và có `catalogVersion()` = SHA-256 nội dung để hồ sơ tự đánh giá
 * ghi rõ đánh giá dựa trên phiên bản nào.
 */
import { createHash } from 'node:crypto';

export type RiskLevel = 1 | 2 | 3 | 4 | 5;
export type DataCategory = 'reference' | 'internal' | 'security' | 'personal' | 'personal_sensitive' | 'financial';
export type DataSubject = 'patient' | 'staff' | 'organization' | 'none';
export type Steward = 'clinic_admin' | 'pharmacy_admin' | 'tenant_admin';
export type RetentionClass = 'medical_record' | 'financial_record' | 'contact' | 'operational' | 'audit_log' | 'security' | 'reference';
/** Cách cột đang được lưu. 'retired' = cột bản rõ cũ: CSDL chặn ghi giá trị mới, backfill (F16) xoá giá trị cũ, sẽ DROP sau. */
export type Storage = 'plain' | 'hashed' | 'encrypted' | 'derived' | 'retired';

export interface ColumnLabel {
  readonly level?: RiskLevel;
  readonly category?: DataCategory;
  readonly storage?: Storage;
  /** Vì sao cột này khác bảng / cần chú ý. */
  readonly note: string;
  /** Quyết định CÓ CHỦ ĐÍCH giữ dạng rõ (không mã hoá) + lý do / biện pháp thay thế. */
  readonly plainReason?: string;
}
export interface TableLabel {
  readonly level: RiskLevel;
  readonly category: DataCategory;
  readonly subject: DataSubject;
  readonly steward: Steward;
  readonly retention: RetentionClass;
  readonly purpose: string;
  readonly columns?: Readonly<Record<string, ColumnLabel>>;
}

export const LEVEL_LABEL: Readonly<Record<RiskLevel, string>> = {
  1: 'Cấp độ 1 — không hoặc không đáng kể tổn hại',
  2: 'Cấp độ 2 — có thể gây gián đoạn / tổn hại quyền, lợi ích hợp pháp',
  3: 'Cấp độ 3 — có thể gây tổn hại nghiêm trọng đến quyền cá nhân, tổ chức',
  4: 'Cấp độ 4 — tổn hại rất nghiêm trọng trật tự xã hội / nghiêm trọng an ninh quốc gia',
  5: 'Cấp độ 5 — tổn hại đặc biệt nghiêm trọng an ninh quốc gia',
};
export const CATEGORY_LABEL: Readonly<Record<DataCategory, string>> = {
  reference: 'Danh mục / tham chiếu',
  internal: 'Vận hành nội bộ',
  security: 'An ninh / xác thực / kiểm toán',
  personal: 'Dữ liệu cá nhân cơ bản',
  personal_sensitive: 'Dữ liệu cá nhân nhạy cảm (sức khoẻ)',
  financial: 'Tài chính',
};
export const RETENTION_LABEL: Readonly<Record<RetentionClass, string>> = {
  medical_record: 'Hồ sơ bệnh án — theo thời hạn lưu trữ của pháp luật khám chữa bệnh',
  financial_record: 'Chứng từ tài chính — theo pháp luật kế toán',
  contact: 'Thông tin liên hệ / đặt lịch — xoá hoặc ẩn danh khi hết mục đích',
  operational: 'Vận hành — giữ ngắn hạn',
  audit_log: 'Nhật ký kiểm toán — giữ để làm bằng chứng',
  security: 'Bí mật / khoá — thay khi xoay khoá, xoá khi thu hồi',
  reference: 'Danh mục — giữ khi còn dùng',
};
export const STEWARD_LABEL: Readonly<Record<Steward, string>> = {
  clinic_admin: 'Quản lý phòng khám',
  pharmacy_admin: 'Quản lý kho dược',
  tenant_admin: 'Quản trị hệ thống',
};

/** Tên cột gợi ý dữ liệu cá nhân hoặc nội dung tự do (có thể chứa dữ liệu cá nhân) — bắt buộc gắn nhãn riêng. */
export const PERSONAL_HINT =
  /(^|_)(given_name|family_name|display_name|payer_name|birth_date|sex|phone|email|national_id|mrn|name_key|phone_key|reason|reason_text|note|close_note|prep_note|handled_note|void_reason|cancel_reason|instructions|display|value_numeric|value_string|snapshot|source_snapshot|target_snapshot|payload|response|source_ip|user_agent|storage_uri|title|detail|checklist|external_subject|last_error)$/;

// ---------------------------------------------------------------------------
// Nhãn dùng lại
// ---------------------------------------------------------------------------
const NAME = (note = 'Họ tên người bệnh'): ColumnLabel => ({ level: 3, category: 'personal', note });
const FREE_TEXT_HEALTH: ColumnLabel = { level: 3, category: 'personal_sensitive', note: 'Văn bản tự do có thể chứa thông tin sức khoẻ' };
const FREE_TEXT_OPS: ColumnLabel = { category: 'internal', note: 'Ghi chú nghiệp vụ — không được ghi thông tin sức khoẻ / định danh' };
const SNAPSHOT_HEALTH: ColumnLabel = { level: 3, category: 'personal_sensitive', note: 'Ảnh chụp bản ghi (có thể chứa dữ liệu sức khoẻ / định danh)' };
const NO_PATIENT_PAYLOAD: ColumnLabel = { note: 'Thiết kế không chứa dữ liệu bệnh nhân (chỉ số liệu tổng hợp / id)' };
const HASH = (note: string): ColumnLabel => ({ storage: 'hashed', note });
// HCOS-F16: bộ ba cột cho một trường đã mã hoá + cột bản rõ cũ.
const RETIRED = (what: string): ColumnLabel => ({ level: 3, category: 'personal', storage: 'retired', note: `${what} bản rõ cũ — CSDL chặn ghi mới; scripts/pii-backfill.ts mã hoá rồi xoá` });
const ENC = (what: string): ColumnLabel => ({ level: 3, category: 'personal', storage: 'encrypted', note: `${what} — AES-256-GCM, DEK theo tenant bọc bằng KEK ngoài CSDL` });
const BIDX = (what: string): ColumnLabel => ({ level: 3, category: 'personal', storage: 'hashed', note: `Blind index ${what} (HMAC, khoá index riêng) — chỉ so khớp bằng nhau` });
const HINT = (what: string): ColumnLabel => ({ level: 3, category: 'personal', storage: 'derived', note: `${what} dạng che để hiển thị (vd. 091****678)` });

// ---------------------------------------------------------------------------
// Danh mục (sắp theo schema.bảng)
// ---------------------------------------------------------------------------
export const DATA_CATALOG: Readonly<Record<string, TableLabel>> = {
  // ---- clinical ------------------------------------------------------------
  'clinical.booking_counters': { level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational', purpose: 'Đếm số lịch đã đặt mỗi buổi (giới hạn sức chứa)' },
  'clinical.booking_portals': { level: 1, category: 'reference', subject: 'none', steward: 'clinic_admin', retention: 'reference', purpose: 'Cổng đặt lịch công khai (slug)' },
  'clinical.bookings': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'contact',
    purpose: 'Đặt lịch khám online theo đồng ý của người đặt; dùng để check-in',
    columns: {
      code_hash: HASH('Mã đặt lịch chỉ lưu SHA-256'),
      family_name: NAME(), given_name: NAME(),
      birth_date: { level: 3, category: 'personal', note: 'Ngày sinh' },
      sex: { level: 3, category: 'personal', note: 'Giới tính' },
      phone: RETIRED('SĐT'), national_id: RETIRED('CCCD'),
      phone_enc: ENC('SĐT liên hệ'), phone_bidx: BIDX('SĐT'), phone_hint: HINT('SĐT'),
      national_id_enc: ENC('Số CCCD'), national_id_bidx: BIDX('CCCD'), national_id_hint: HINT('CCCD'),
      reason: { level: 3, category: 'personal_sensitive', note: 'Lý do khám do người đặt tự khai (triệu chứng)' },
    },
  },
  'clinical.clinical_documents': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Tài liệu lâm sàng của đợt khám (siêu dữ liệu + vị trí lưu)',
    columns: { title: FREE_TEXT_HEALTH, storage_uri: { level: 3, note: 'Vị trí tệp tài liệu lâm sàng' } },
  },
  'clinical.conditions': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Chẩn đoán (ICD-10) của đợt khám',
    columns: { display: { level: 3, note: 'Tên chẩn đoán' } },
  },
  'clinical.encounters': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Đợt khám: bệnh nhân, bác sĩ phụ trách, thời gian, lý do khám',
    columns: { reason_text: { level: 3, note: 'Lý do khám' } },
  },
  'clinical.handover_counters': { level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational', purpose: 'Cấp số R-… cho quầy trả' },
  'clinical.handover_desks': { level: 1, category: 'reference', subject: 'none', steward: 'clinic_admin', retention: 'reference', purpose: 'Danh sách quầy trả' },
  'clinical.handover_tickets': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'operational',
    purpose: 'Quầy trả: soạn thuốc, gọi ra quầy, biên bản giao thuốc / giấy tờ',
    columns: {
      prep_note: { level: 3, note: 'Ghi chú của dược (vd. thiếu thuốc) — có thể nhắc tên thuốc' },
      note: { level: 3, note: 'Ghi chú tại quầy / lý do huỷ' },
      checklist: { category: 'internal', note: 'Biên bản giao: đã giao thuốc, tình trạng giấy tờ (không có nội dung giấy tờ)' },
    },
  },
  'clinical.observations': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Sinh hiệu / kết quả quan sát',
    columns: {
      display: { level: 3, note: 'Tên chỉ số' },
      value_numeric: { level: 3, note: 'Giá trị đo' },
      value_string: { level: 3, note: 'Giá trị dạng chữ' },
    },
  },
  'clinical.prescription_items': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Dòng thuốc trong đơn (liều, số lần, số ngày, số lượng)',
    columns: { instructions: { level: 3, note: 'Cách dùng' } },
  },
  'clinical.prescriptions': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Đơn thuốc của đợt khám',
    columns: { note: { level: 3, note: 'Lời dặn của bác sĩ' } },
  },
  'clinical.queue_counters': { level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational', purpose: 'Cấp số thứ tự theo phòng / ngày' },
  'clinical.queue_displays': {
    level: 2, category: 'security', subject: 'none', steward: 'clinic_admin', retention: 'security',
    purpose: 'Màn hình TV gọi số (khoá hiển thị)',
    columns: { key_hash: HASH('Khoá hiển thị chỉ lưu SHA-256') },
  },
  'clinical.queue_tickets': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'operational',
    purpose: 'Số thứ tự khám, mức ưu tiên',
    columns: { priority_reason: { level: 3, category: 'personal_sensitive', note: 'Lý do ưu tiên lộ tình trạng (mang thai, khuyết tật, cấp cứu)' } },
  },
  'clinical.record_history': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Lịch sử thay đổi bản ghi lâm sàng (provenance)',
    columns: { snapshot: SNAPSHOT_HEALTH },
  },
  'clinical.service_points': { level: 1, category: 'reference', subject: 'none', steward: 'clinic_admin', retention: 'reference', purpose: 'Phòng khám / điểm phục vụ' },

  // ---- decision (F11) ------------------------------------------------------------
  'decision.action_log': {
    level: 2, category: 'internal', subject: 'staff', steward: 'clinic_admin', retention: 'audit_log',
    purpose: 'Nhật ký hành động trên sự kiện Decision Engine',
    columns: { note: FREE_TEXT_OPS },
  },
  'decision.events': {
    level: 2, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational',
    purpose: 'Sự kiện phát hiện (tải phòng khám, tồn kho, lệch quỹ…)',
    columns: { title: NO_PATIENT_PAYLOAD, detail: NO_PATIENT_PAYLOAD },
  },
  'decision.job_runs': {
    level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational', purpose: 'Lần chạy Decision Engine',
    columns: { detail: NO_PATIENT_PAYLOAD },
  },
  'decision.notifications': {
    level: 2, category: 'internal', subject: 'staff', steward: 'clinic_admin', retention: 'operational',
    purpose: 'Hộp thông báo theo vai trò',
    columns: { handled_note: FREE_TEXT_OPS },
  },
  'decision.rule_versions': { level: 2, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'audit_log', purpose: 'Lịch sử luật Decision Engine' },
  'decision.rules': { level: 2, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'reference', purpose: 'Luật Decision Engine' },

  // ---- finance (F8–F10) ------------------------------------------------------------
  'finance.billing_cases': { level: 3, category: 'financial', subject: 'patient', steward: 'clinic_admin', retention: 'financial_record', purpose: 'Hồ sơ thanh toán của một lần đến khám' },
  'finance.cashier_shifts': {
    level: 2, category: 'financial', subject: 'staff', steward: 'clinic_admin', retention: 'financial_record',
    purpose: 'Ca thu ngân: tiền đầu ca, tiền đếm, chênh lệch',
    columns: { close_note: FREE_TEXT_OPS },
  },
  'finance.charges': {
    level: 3, category: 'financial', subject: 'patient', steward: 'clinic_admin', retention: 'financial_record',
    purpose: 'Chi phí dịch vụ của hồ sơ thanh toán',
    columns: { void_reason: FREE_TEXT_OPS },
  },
  'finance.forecast_settings': { level: 2, category: 'financial', subject: 'organization', steward: 'clinic_admin', retention: 'operational', purpose: 'Thông số dự báo (chi phí cố định…)' },
  'finance.forecast_settings_history': { level: 2, category: 'financial', subject: 'organization', steward: 'clinic_admin', retention: 'audit_log', purpose: 'Lịch sử thông số dự báo' },
  'finance.price_items': { level: 1, category: 'reference', subject: 'none', steward: 'clinic_admin', retention: 'reference', purpose: 'Bảng giá dịch vụ' },
  'finance.receipt_counters': { level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'financial_record', purpose: 'Đánh số phiếu thu / chi' },
  'finance.receipts': {
    level: 3, category: 'financial', subject: 'patient', steward: 'clinic_admin', retention: 'financial_record',
    purpose: 'Phiếu thu / chi (tạm ứng, thanh toán, hoàn ứng)',
    columns: {
      payer_name: { level: 3, category: 'personal', note: 'Tên người nộp / nhận tiền' },
      cancel_reason: FREE_TEXT_OPS,
    },
  },
  'finance.settings': {
    level: 2, category: 'financial', subject: 'organization', steward: 'clinic_admin', retention: 'reference',
    purpose: 'Cài đặt thu ngân: tạm ứng mặc định, tài khoản nhận chuyển khoản của cơ sở',
    columns: { bank_account_name: { note: 'Tên tài khoản của cơ sở (không phải người bệnh)' } },
  },

  // ---- governance (F15) ------------------------------------------------------------
  'governance.risk_assessments': {
    level: 2, category: 'security', subject: 'staff', steward: 'tenant_admin', retention: 'audit_log',
    purpose: 'Bằng chứng tự xác định cấp độ rủi ro an ninh dữ liệu của hệ thống',
    columns: { summary: { note: 'Số liệu tổng hợp (số bảng theo cấp, quy mô bản ghi) — không có dữ liệu cá nhân' } },
  },

  // ---- lưu giữ & xoá (F17) ---------------------------------------------------------
  'governance.retention_settings': {
    level: 1, category: 'internal', subject: 'none', steward: 'tenant_admin', retention: 'reference',
    purpose: 'Thời hạn lưu giữ do chủ quản đặt (CSDL chặn thấp hơn sàn pháp lý)',
  },
  'governance.retention_runs': {
    level: 1, category: 'internal', subject: 'none', steward: 'tenant_admin', retention: 'operational', purpose: 'Lần chạy job ẩn danh / xoá dữ liệu hết hạn',
    columns: { detail: NO_PATIENT_PAYLOAD },
  },
  'governance.deletion_receipts': {
    level: 2, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'audit_log',
    purpose: 'Biên nhận xoá: chính sách, căn cứ, phạm vi (số đếm), thời điểm, kết quả, ngày không thể khôi phục — không lưu dữ liệu đã xoá',
  },
  'governance.erasure_requests': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'audit_log',
    purpose: 'Yêu cầu xoá dữ liệu của người bệnh (người lập ≠ người duyệt), đánh giá nghĩa vụ lưu giữ — chỉ id, không họ tên / liên hệ',
    columns: { note: FREE_TEXT_OPS, decision_note: FREE_TEXT_OPS },
  },

  // ---- keyvault (F16) ------------------------------------------------------------
  'keyvault.subject_keys': {
    level: 3, category: 'security', subject: 'patient', steward: 'tenant_admin', retention: 'security',
    purpose: 'Khoá riêng của từng người / giấy tờ / lịch hẹn (F17), bọc bằng DEK tenant; huỷ khoá = xoá không khôi phục được (crypto-shredding)',
    columns: { wrapped_key: { level: 3, category: 'security', storage: 'encrypted', note: 'Khoá chủ thể bọc AES-256-GCM bằng DEK tenant; NULL sau khi huỷ' } },
  },
  'keyvault.shred_events': {
    level: 2, category: 'security', subject: 'patient', steward: 'tenant_admin', retention: 'audit_log',
    purpose: 'Sổ huỷ khoá / ẩn danh (chỉ id) — đẩy ra ngoài bản sao lưu để phát lại sau khi khôi phục',
  },
  'keyvault.tenant_keys': {
    level: 3, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'security',
    purpose: 'Khoá dữ liệu (DEK) và khoá blind index theo tenant, có phiên bản; chỉ lưu dạng đã bọc bằng KEK nằm ngoài CSDL',
    columns: { wrapped_key: { level: 3, category: 'security', storage: 'encrypted', note: 'DEK bọc AES-256-GCM bằng KEK (không mở được nếu chỉ có CSDL / bản sao lưu)' } },
  },

  // ---- iam ------------------------------------------------------------
  'iam.access_policies': { level: 2, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'reference', purpose: 'Access policy thu hẹp quyền' },
  'iam.access_policy_versions': { level: 2, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'audit_log', purpose: 'Lịch sử access policy' },
  'iam.memberships': { level: 2, category: 'security', subject: 'staff', steward: 'tenant_admin', retention: 'audit_log', purpose: 'Vai trò của nhân viên tại cơ sở' },
  'iam.organizations': { level: 1, category: 'reference', subject: 'organization', steward: 'tenant_admin', retention: 'reference', purpose: 'Cơ sở khám chữa bệnh' },
  'iam.tenants': { level: 1, category: 'reference', subject: 'organization', steward: 'tenant_admin', retention: 'reference', purpose: 'Chủ quản dữ liệu (đơn vị sử dụng)' },
  'iam.users': {
    level: 2, category: 'personal', subject: 'staff', steward: 'tenant_admin', retention: 'audit_log',
    purpose: 'Tài khoản nhân viên (liên kết danh tính ở IdP)',
    columns: {
      external_subject: { category: 'security', note: 'Mã định danh ở IdP' },
      email: { level: 2, category: 'personal', note: 'Email công việc' },
      display_name: { level: 2, category: 'personal', note: 'Tên hiển thị nhân viên' },
    },
  },

  // ---- integration (F12) ------------------------------------------------------------
  'integration.deliveries': {
    level: 2, category: 'internal', subject: 'none', steward: 'tenant_admin', retention: 'operational', purpose: 'Lượt giao sự kiện tới kết nối ngoài',
    columns: { last_error: NO_PATIENT_PAYLOAD },
  },
  'integration.delivery_attempts': { level: 2, category: 'internal', subject: 'none', steward: 'tenant_admin', retention: 'operational', purpose: 'Nhật ký từng lần gửi' },
  'integration.endpoint_health': { level: 1, category: 'internal', subject: 'none', steward: 'tenant_admin', retention: 'operational', purpose: 'Sức khoẻ kết nối' },
  'integration.endpoint_history': { level: 2, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'audit_log', purpose: 'Lịch sử cấu hình kết nối (không lưu URL / bí mật)' },
  'integration.endpoints': {
    level: 2, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'security',
    purpose: 'Kết nối ngoài (Teams, webhook) — bên thứ ba nhận dữ liệu',
    columns: {
      url_ciphertext: { storage: 'encrypted', note: 'URL kết nối mã hoá AES-256-GCM' },
      secret_ciphertext: { storage: 'encrypted', note: 'Khoá ký HMAC mã hoá AES-256-GCM' },
    },
  },
  'integration.outbox': {
    level: 2, category: 'internal', subject: 'none', steward: 'tenant_admin', retention: 'operational',
    purpose: 'Sự kiện chờ gửi ra ngoài',
    columns: { payload: NO_PATIENT_PAYLOAD },
  },

  // ---- patient ------------------------------------------------------------
  'patient.identifiers': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Giấy tờ định danh (CCCD, BHYT, MRN cũ)',
    columns: {
      value: RETIRED('Số giấy tờ'),
      value_enc: ENC('Số giấy tờ (CCCD, BHYT, hộ chiếu…)'), value_bidx: BIDX('số giấy tờ (chống trùng, tra cứu)'), value_hint: HINT('Số giấy tờ'),
    },
  },
  'patient.mrn_counters': { level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational', purpose: 'Cấp mã bệnh nhân tự sinh' },
  'patient.mrn_settings': { level: 1, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'reference', purpose: 'Cài đặt mã bệnh nhân' },
  'patient.patients': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Hồ sơ bệnh nhân tại cơ sở',
    columns: {
      mrn: {
        level: 3, category: 'personal', note: 'Mã bệnh nhân (không chứa dữ liệu cá nhân, nhưng định danh được)',
        plainReason: 'Mã tra cứu tự sinh, không chứa thông tin cá nhân; cần tìm chính xác và in trên phiếu — bảo vệ bằng RLS + phân quyền',
      },
    },
  },
  'patient.person_merges': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'audit_log',
    purpose: 'Gộp hồ sơ trùng (lưu ảnh chụp để hoàn tác)',
    columns: { reason: FREE_TEXT_OPS, source_snapshot: SNAPSHOT_HEALTH, target_snapshot: SNAPSHOT_HEALTH },
  },
  'patient.person_unmerges': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'audit_log',
    purpose: 'Hoàn tác gộp hồ sơ',
    columns: { reason: FREE_TEXT_OPS },
  },
  'patient.persons': {
    level: 3, category: 'personal', subject: 'patient', steward: 'clinic_admin', retention: 'medical_record',
    purpose: 'Danh tính người bệnh (dùng chung giữa các cơ sở của tenant)',
    columns: {
      given_name: NAME(), family_name: NAME(),
      birth_date: { level: 3, category: 'personal', note: 'Ngày sinh' },
      sex: { level: 3, category: 'personal', note: 'Giới tính' },
      phone: RETIRED('SĐT'), email: RETIRED('Email'),
      phone_key: { level: 3, category: 'personal', storage: 'retired', note: 'Khoá so khớp SĐT dạng rõ cũ — thay bằng phone_bidx (F16)' },
      phone_enc: ENC('SĐT'), phone_bidx: BIDX('SĐT'), phone_hint: HINT('SĐT'),
      email_enc: ENC('Email'), email_hint: HINT('Email'),
      name_key: { level: 3, category: 'personal', storage: 'derived', note: 'Khoá so khớp họ tên (chuẩn hoá) — mã hoá họ tên ở F16b' },
    },
  },

  // ---- pharmacy ------------------------------------------------------------
  'pharmacy.batches': { level: 2, category: 'internal', subject: 'none', steward: 'pharmacy_admin', retention: 'financial_record', purpose: 'Lô thuốc, hạn dùng, giá vốn' },
  'pharmacy.inventory_balances': { level: 2, category: 'internal', subject: 'none', steward: 'pharmacy_admin', retention: 'operational', purpose: 'Tồn kho theo lô / vị trí' },
  'pharmacy.medications': { level: 1, category: 'reference', subject: 'none', steward: 'pharmacy_admin', retention: 'reference', purpose: 'Danh mục thuốc' },
  'pharmacy.stock_locations': { level: 1, category: 'reference', subject: 'none', steward: 'pharmacy_admin', retention: 'reference', purpose: 'Kho / quầy' },
  'pharmacy.stock_movements': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'pharmacy_admin', retention: 'financial_record',
    purpose: 'Sổ cái nhập / cấp / điều chỉnh kho; dòng cấp phát gắn đợt khám (lộ thuốc người bệnh dùng)',
    columns: { reason: FREE_TEXT_OPS },
  },
  'pharmacy.substances': { level: 1, category: 'reference', subject: 'none', steward: 'pharmacy_admin', retention: 'reference', purpose: 'Danh mục hoạt chất' },

  // ---- platform ------------------------------------------------------------
  'platform.audit_chain_heads': {
    level: 2, category: 'security', subject: 'none', steward: 'tenant_admin', retention: 'audit_log', purpose: 'Đầu chuỗi băm nhật ký kiểm toán',
    columns: { last_hash: HASH('Băm cuối chuỗi') },
  },
  'platform.audit_events': {
    level: 3, category: 'security', subject: 'patient', steward: 'tenant_admin', retention: 'audit_log',
    purpose: 'Nhật ký kiểm toán chỉ-thêm, nối chuỗi băm: ai làm gì, với bản ghi nào, kết quả',
    columns: {
      payload: { level: 3, note: 'Chi tiết thao tác (id, mã lỗi); không ghi nội dung lâm sàng' },
      source_ip: { level: 2, category: 'personal', note: 'IP người thao tác' },
      user_agent: { level: 2, category: 'personal', note: 'Trình duyệt người thao tác' },
      prev_hash: HASH('Băm bản ghi trước'), event_hash: HASH('Băm bản ghi'),
    },
  },
  'platform.idempotency_keys': {
    level: 3, category: 'security', subject: 'patient', steward: 'tenant_admin', retention: 'operational',
    purpose: 'Chống gửi trùng: lưu kết quả lần đầu để trả lại',
    columns: {
      request_hash: HASH('Băm nội dung yêu cầu'),
      response: {
        level: 3, category: 'personal_sensitive', note: 'Kết quả API lần đầu (có thể chứa dữ liệu bệnh nhân)',
        plainReason: 'Dữ liệu tạm để chống gửi trùng — xử lý bằng thời hạn lưu ngắn (F17), không mã hoá',
      },
    },
  },
  'platform.outbox_events': {
    level: 3, category: 'personal_sensitive', subject: 'patient', steward: 'tenant_admin', retention: 'operational',
    purpose: 'Sự kiện miền (đợt khám tạo / đóng…) chờ phát',
    columns: {
      payload: {
        level: 3, note: 'Chỉ id (bệnh nhân, đợt khám) — vẫn cho biết ai đến khám khi nào',
        plainReason: 'Chỉ chứa id (không có họ tên / liên hệ) — xử lý bằng thời hạn lưu ngắn (F17)',
      },
      last_error: FREE_TEXT_OPS,
    },
  },
};

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------
export interface EffectiveLabel {
  readonly table: string;
  readonly column: string | null;
  readonly level: RiskLevel;
  readonly category: DataCategory;
  readonly storage: Storage;
  readonly explicit: boolean;
}

export function labelOf(table: string, column?: string): EffectiveLabel | null {
  const t = DATA_CATALOG[table];
  if (!t) return null;
  const c = column ? t.columns?.[column] : undefined;
  return {
    table, column: column ?? null, level: c?.level ?? t.level, category: c?.category ?? t.category, storage: c?.storage ?? 'plain', explicit: !!c,
  };
}

/** Cấp độ hệ thống = cấp CAO NHẤT phát sinh trong danh mục. */
export function systemLevel(catalog: Readonly<Record<string, TableLabel>> = DATA_CATALOG): RiskLevel {
  let max: RiskLevel = 1;
  for (const t of Object.values(catalog)) {
    if (t.level > max) max = t.level;
    for (const c of Object.values(t.columns ?? {})) if (c.level && c.level > max) max = c.level;
  }
  return max;
}

/** Phiên bản danh mục: SHA-256 của JSON chuẩn hoá (khoá sắp xếp). Đổi một nhãn => đổi phiên bản. */
export function catalogVersion(catalog: Readonly<Record<string, TableLabel>> = DATA_CATALOG): string {
  const canon = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
  return createHash('sha256').update(JSON.stringify(canon(catalog))).digest('hex');
}

export interface CatalogProblem {
  readonly kind: 'UNLABELED_TABLE' | 'STALE_TABLE' | 'STALE_COLUMN' | 'UNLABELED_PERSONAL_COLUMN' | 'COLUMN_ABOVE_TABLE';
  readonly table: string;
  readonly column?: string;
}

/** So danh mục với cấu trúc CSDL thật (danh sách bảng => cột). Rỗng = đạt. */
export function checkCatalog(schema: ReadonlyMap<string, readonly string[]>, catalog: Readonly<Record<string, TableLabel>> = DATA_CATALOG): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  for (const [table, cols] of schema) {
    const t = catalog[table];
    if (!t) {
      out.push({ kind: 'UNLABELED_TABLE', table });
      continue;
    }
    if (t.subject !== 'none') {
      for (const c of cols) if (PERSONAL_HINT.test(c) && !t.columns?.[c]) out.push({ kind: 'UNLABELED_PERSONAL_COLUMN', table, column: c });
    }
    for (const [c, l] of Object.entries(t.columns ?? {})) {
      if (!cols.includes(c)) out.push({ kind: 'STALE_COLUMN', table, column: c });
      if (l.level !== undefined && l.level > t.level) out.push({ kind: 'COLUMN_ABOVE_TABLE', table, column: c });
    }
  }
  for (const table of Object.keys(catalog)) if (!schema.has(table)) out.push({ kind: 'STALE_TABLE', table });
  return out;
}

export interface CatalogSummary {
  readonly version: string;
  readonly systemLevel: RiskLevel;
  readonly tables: number;
  readonly byLevel: Readonly<Record<RiskLevel, number>>;
  /** Cột cấp ≥ 3 thuộc nhóm cá nhân / nhạy cảm còn lưu dạng rõ, CHƯA có quyết định — việc còn lại (F16b). */
  readonly plaintextSensitive: readonly string[];
  /** Cột nhạy cảm giữ dạng rõ CÓ CHỦ ĐÍCH, kèm lý do. */
  readonly plainByDesign: ReadonlyArray<{ readonly column: string; readonly reason: string }>;
  /** Cột đã mã hoá. */
  readonly encrypted: readonly string[];
}
export function summarize(catalog: Readonly<Record<string, TableLabel>> = DATA_CATALOG): CatalogSummary {
  const byLevel: Record<RiskLevel, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const plaintextSensitive: string[] = [];
  const plainByDesign: Array<{ column: string; reason: string }> = [];
  const encrypted: string[] = [];
  for (const [name, t] of Object.entries(catalog)) {
    byLevel[t.level]++;
    for (const [c, l] of Object.entries(t.columns ?? {})) {
      const level = l.level ?? t.level;
      const category = l.category ?? t.category;
      if ((l.storage ?? 'plain') === 'encrypted') encrypted.push(`${name}.${c}`);
      if (level < 3 || (category !== 'personal' && category !== 'personal_sensitive') || (l.storage ?? 'plain') !== 'plain') continue;
      if (l.plainReason) plainByDesign.push({ column: `${name}.${c}`, reason: l.plainReason });
      else plaintextSensitive.push(`${name}.${c}`);
    }
  }
  return { version: catalogVersion(catalog), systemLevel: systemLevel(catalog), tables: Object.keys(catalog).length, byLevel, plaintextSensitive, plainByDesign, encrypted };
}
