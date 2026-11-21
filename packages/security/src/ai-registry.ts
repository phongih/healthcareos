/**
 * HCOS-F18 | Sổ nguồn dữ liệu AI (AI Data Integrity).
 *
 * Mỗi thành phần "AI" của HealthcareOS có một thẻ: nguồn dữ liệu, phiên bản, SHA-256 của ĐÚNG các file mã / dữ liệu,
 * người chịu trách nhiệm, trạng thái kiểm định, mục đích được phép và bị cấm, luồng dữ liệu.
 *
 * Khoá phiên bản: tests/security/ai-registry.test.ts tính lại SHA-256 từ file — sửa nội dung mà không cập nhật thẻ
 * (phiên bản + SHA-256 + ghi chú thay đổi) thì CI báo lỗi. Thay đổi dữ liệu AI vì thế luôn có dấu vết, có người duyệt (PR).
 *
 * Nguyên tắc chung (cũng là kiểm tra trong test):
 *  - Mọi thành phần chạy CỤC BỘ (trình duyệt hoặc máy chủ của chủ quản); không gọi dịch vụ AI bên ngoài.
 *  - Trình duyệt chỉ được kết nối tới chính máy chủ (CSP connect-src 'self'); máy chủ chỉ ra ngoài qua bộ giao tích hợp (F12),
 *    và bộ giao chỉ gửi tới nhà cung cấp đã đánh giá; nhà cung cấp loại 'ai_service' không bao giờ được duyệt nhận dữ liệu cá nhân / sức khoẻ.
 *  - Kết quả AI là GỢI Ý cho người có chuyên môn; giao diện ghi rõ trạng thái kiểm định.
 */

export type AiValidation = 'unvalidated' | 'internal_review' | 'validated';
export interface AiComponent {
  readonly id: string;
  readonly name: string;
  readonly kind: 'reference_list' | 'dictionary' | 'rules' | 'statistics';
  readonly version: string;
  /** SHA-256 trên (đường dẫn \0 nội dung \0) của từng file theo thứ tự, xuống dòng chuẩn hoá về \n. */
  readonly sha256: string;
  readonly files: readonly string[];
  readonly source: string;
  readonly owner: string;
  readonly validation: AiValidation;
  readonly validationNote: string;
  readonly permittedUse: string;
  readonly prohibitedUse: string;
  readonly runsAt: 'browser' | 'server';
  readonly patientDataLeavesSystem: false;
  readonly changeNote: string;
}

export const AI_REGISTRY: readonly AiComponent[] = [
  {
    id: 'icd10_shortlist', name: 'Danh mục ICD-10 rút gọn (tìm mã chẩn đoán)', kind: 'reference_list', version: '2026.11-f11',
    sha256: 'eb30e36839457d291217c0c8bfd6d376fdd924a72d144e1de6a273889177788a',
    files: ['apps/web/src/lib/ai/icd10.ts'],
    source: 'Biên soạn nội bộ: khoảng 200 mã ngoại trú thường gặp + tên gọi thông thường (HCOS-F11).',
    owner: 'Quản lý phòng khám (chuyên môn) + nhóm phát triển',
    validation: 'unvalidated',
    validationNote: 'Chưa đối chiếu với danh mục ICD-10 của Bộ Y tế (QĐ 4469/QĐ-BYT). Không dùng cho báo cáo / thanh toán BHYT cho tới khi thay bằng danh mục chính thức.',
    permittedUse: 'Gợi ý mã khi bác sĩ gõ tìm; bác sĩ tự chọn và chịu trách nhiệm mã cuối cùng.',
    prohibitedUse: 'Tự gán chẩn đoán; dùng làm danh mục chính thức cho báo cáo / BHYT.',
    runsAt: 'browser', patientDataLeavesSystem: false,
    changeNote: 'Bản đầu (F11).',
  },
  {
    id: 'medical_abbreviations', name: 'Tìm kiếm mờ tiếng Việt + từ điển viết tắt y khoa / thuốc', kind: 'dictionary', version: '2026.11-f11',
    sha256: '85c45a66a3af99ae14091010efc3ac62992af2dd4eae78268371d12bec806e13',
    files: ['apps/web/src/lib/ai/fuzzy.ts'],
    source: 'Biên soạn nội bộ (viết tắt thông dụng: tha, sxh, pcm…); thuật toán Damerau–Levenshtein.',
    owner: 'Nhóm phát triển; quản lý phòng khám duyệt từ viết tắt',
    validation: 'internal_review',
    validationNote: 'Đã thử trên bộ ca kiểm thử tự động (tests/web). Từ viết tắt mới phải được người có chuyên môn duyệt trong PR.',
    permittedUse: 'Xếp hạng kết quả tìm kiếm mã bệnh / thuốc; hiển thị lý do khớp.',
    prohibitedUse: 'Tự động chọn thuốc / mã thay người dùng.',
    runsAt: 'browser', patientDataLeavesSystem: false,
    changeNote: 'Bản đầu (F11).',
  },
  {
    id: 'symptom_normalizer', name: 'Chuẩn hoá triệu chứng từ ghi chú tự do', kind: 'rules', version: '2026.11-f11',
    sha256: 'c9c76bb4a14ba4c3ebdc039a9835959685489e1cd92fa9c0932fc8f7d0fb2449',
    files: ['apps/web/src/lib/ai/symptoms.ts'],
    source: 'Luật biên soạn nội bộ: 39 khái niệm triệu chứng, phủ định, thời gian, nhiệt độ, dấu hiệu cần chú ý.',
    owner: 'Quản lý phòng khám (chuyên môn) + nhóm phát triển',
    validation: 'unvalidated',
    validationNote: 'Chưa có đánh giá lâm sàng có hệ thống (độ nhạy / độ đặc hiệu). Dấu hiệu cần chú ý chỉ để nhắc, không thay đánh giá của bác sĩ.',
    permittedUse: 'Gợi ý triệu chứng và mã cho bác sĩ chọn; ghi chú không lưu, không gửi đi.',
    prohibitedUse: 'Phân loại cấp cứu; ra quyết định điều trị; lưu ghi chú gốc.',
    runsAt: 'browser', patientDataLeavesSystem: false,
    changeNote: 'Bản đầu (F11).',
  },
  {
    id: 'decision_engine_stats', name: 'Decision Engine: danh mục bộ phát hiện + thống kê bất thường', kind: 'statistics', version: '2026.11-f19',
    sha256: '3f32a624f931cfcbc7b2a5f850a02218d6ead8cf851e7e7bf12ad6c97695d4b4',
    files: ['services/api/src/decision/stats.ts', 'services/api/src/decision/catalog.ts'],
    source: 'Dữ liệu vận hành của chính chủ quản (lượt khám, tồn kho, quỹ, sinh hiệu, thiết bị) — robust z-score (trung vị / MAD), z Poisson.',
    owner: 'Quản lý phòng khám (ngưỡng luật) + nhóm phát triển (thuật toán)',
    validation: 'internal_review',
    validationNote: 'Thuật toán có test đơn vị; ngưỡng do quản lý cấu hình và có lịch sử phiên bản. Chưa đo tỉ lệ báo động giả trên dữ liệu thật.',
    permittedUse: 'Phát hiện bất thường vận hành, gợi ý hành động; mọi hành động do người xử lý.',
    prohibitedUse: 'Tự động thay đổi dữ liệu lâm sàng / tài chính; gửi dữ liệu người bệnh trong thông báo ra ngoài.',
    runsAt: 'server', patientDataLeavesSystem: false,
    changeNote: 'F19: thêm 3 bộ phát hiện quy tắc (không thống kê) — thiết bị đến hạn / quá hạn kiểm định, thiết bị hỏng / bảo trì, vật tư thiếu khi tất toán; "Thuốc dưới điểm đặt hàng" gồm cả vật tư. Thuật toán thống kê không đổi.',
  },
];

export const VALIDATION_LABEL: Readonly<Record<AiValidation, string>> = {
  unvalidated: 'Chưa kiểm định',
  internal_review: 'Đã rà soát nội bộ',
  validated: 'Đã kiểm định',
};
