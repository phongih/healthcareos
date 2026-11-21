/** Gọi API HealthcareOS (cùng origin). Lỗi trả về OperationOutcome / JSON => ApiError có thông điệp tiếng Việt dễ hiểu. */
import { accessToken, login } from './auth';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail: string | null,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Yêu cầu không hợp lệ',
  401: 'Phiên đăng nhập đã hết hạn',
  403: 'Bạn không có quyền thực hiện thao tác này',
  404: 'Không tìm thấy',
  409: 'Xung đột dữ liệu',
  412: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
  422: 'Dữ liệu không hợp lệ',
  428: 'Thiếu điều kiện bắt buộc',
};

/** Lý do lỗi đã biết => câu tiếng Việt cho người dùng (thay thông điệp kỹ thuật). */
const REASON_TEXT: Record<string, string> = {
  VENDOR_NOT_CLEARED: 'Nhà cung cấp của kết nối chưa có đánh giá còn hiệu lực (hoặc bị thu hồi / tạm ngừng) — không gửi được. Ghi đánh giá ở tab Quản trị dữ liệu → Nhà cung cấp.',
  VENDOR_REQUIRED: 'Chọn nhà cung cấp nhận dữ liệu (đăng ký ở tab Quản trị dữ liệu → Nhà cung cấp).',
  DPA_REQUIRED: 'Duyệt nhà cung cấp cần số thoả thuận xử lý dữ liệu.',
  ASSESSMENT_VALIDITY: 'Hiệu lực đánh giá tối đa 3 năm.',
  AI_NO_PATIENT_DATA: 'Dịch vụ AI không được nhận dữ liệu cá nhân / sức khoẻ.',
  VENDOR_TERMINATED: 'Nhà cung cấp đã chấm dứt — đăng ký mới nếu hợp tác lại.',
  VENDOR_NAME_TAKEN: 'Đã có nhà cung cấp cùng tên.',
  PURPOSE_REQUIRED: 'File có dữ liệu cá nhân: cần ghi mục đích xuất (tối thiểu 5 ký tự).',
  FOUR_EYES: 'Người lập yêu cầu không được tự duyệt — cần một quản trị viên khác.',
  ERASURE_ALREADY_OPEN: 'Người bệnh này đã có yêu cầu xoá đang xử lý.',
  ALREADY_ERASED: 'Dữ liệu của người bệnh này đã được xoá.',
  ERASURE_NOT_PENDING: 'Yêu cầu không còn ở trạng thái chờ duyệt.',
  RETENTION_BELOW_FLOOR: 'Thời hạn thấp hơn mức tối thiểu theo quy định.',
  PII_ERASED: 'Dữ liệu này đã bị xoá theo yêu cầu / hết hạn lưu (khoá đã huỷ) — không thể xem lại.',
  MRN_CHECK_DIGIT: 'Mã bệnh nhân sai số kiểm tra — có thể gõ nhầm một chữ số. Kiểm tra lại mã.',
  MRN_RESERVED_FORMAT: 'Mã cũ không được có dạng mã tự sinh (vd. BN26-000123-5). Bỏ trống để hệ thống tự cấp.',
  LEGACY_MRN_DISABLED: 'Cơ sở không cho nhập mã cũ — bỏ trống để hệ thống tự cấp mã.',
  MRN_TAKEN: 'Mã bệnh nhân này đã được dùng trong cơ sở.',
  INVALID_PREFIX: 'Tiền tố phải gồm 1–4 chữ cái in hoa A–Z.',
  // HCOS-F14 quầy trả (BALANCE_NOT_SETTLED giữ thông báo của máy chủ: có số tiền còn thu / còn dư).
  DESK_BUSY: 'Quầy đang phục vụ một số khác — hoàn tất, báo vắng hoặc trả số đó về hàng chờ trước.',
  DESK_INACTIVE: 'Quầy này đang tạm ngưng.',
  DESK_CODE_TAKEN: 'Mã quầy đã có.',
  CALLED_BY_OTHER: 'Số này do người khác gọi ra quầy.',
  HANDOVER_STATE: 'Phiếu trả đã đổi trạng thái — tải lại danh sách.',
  HANDOVER_CHANGED: 'Phiếu trả vừa được người khác cập nhật — tải lại danh sách.',
  MEDICATION_NOT_DISPENSED: 'Đơn còn thuốc chưa cấp. Cấp đủ ở "Đơn chờ cấp", hoặc ghi lý do (vd. hết thuốc) để vẫn chuyển ra quầy.',
  MEDICATION_NOT_HANDED: 'Đánh dấu "Đã giao đủ thuốc" trước khi hoàn tất.',
  DECLARED_BELOW_COMPUTED: 'Không được xác định cấp độ thấp hơn cấp tính từ danh mục dữ liệu.',
  RATIONALE_REQUIRED: 'Cần ghi căn cứ (20–4000 ký tự).',
  REASON_REQUIRED: 'Cần ghi lý do (ít nhất 5 ký tự).',
  // HCOS-F19 thiết bị & vật tư
  DEVICE_UNAVAILABLE: 'Dịch vụ này cần máy nhưng cơ sở không còn máy dùng được (hỏng / bảo trì / quá hạn hoặc không đạt kiểm định) — không chỉ định được. Xem tab Thiết bị.',
  DEVICE_STATE: 'Trạng thái máy không cho thao tác này (vd. máy đang hỏng thì không báo hỏng lần nữa; chỉ "sửa xong" khi máy hỏng / bảo trì).',
  DEVICE_RETIRED: 'Thiết bị đã thanh lý — không ghi thêm được.',
  NOTE_REQUIRED: 'Cần ghi mô tả (ít nhất 3 ký tự).',
  ASSET_CODE_INVALID: 'Mã tài sản sai định dạng hoặc sai số kiểm tra (dạng TB26-0001-3) — kiểm tra lại.',
  SERIAL_TAKEN: 'Đã có thiết bị cùng loại / hãng / model với số serial này.',
  TYPE_CODE_TAKEN: 'Mã loại thiết bị đã có.',
  DEPRECIATION_INCOMPLETE: 'Khấu hao cần đủ nguyên giá, số tháng sử dụng và ngày đưa vào dùng (hoặc bỏ trống cả ba).',
  CERTIFICATE_REQUIRED: 'Kết quả đạt cần số giấy chứng nhận / tem kiểm định.',
  REGIME_NOT_CONFIGURED: 'Thiết bị chưa khai báo chế độ kiểm định này — thêm chế độ trước.',
  DATE_IN_FUTURE: 'Ngày thực hiện không được ở tương lai.',
  NO_OPEN_CASE: 'Người bệnh chưa có hồ sơ thanh toán đang mở — nhờ thu ngân / lễ tân mở hồ sơ (thu tạm ứng) trước khi ghi lô.',
  BATCH_NOT_FOUND: 'Không có lô vật tư với số này — kiểm tra số lô hoặc nhập kho trước.',
  BATCH_AMBIGUOUS: 'Nhiều vật tư có cùng số lô — chọn vật tư rồi ghi lại.',
  NOT_A_SUPPLY: 'Chỉ vật tư tiêu hao mới đưa vào định mức (thuốc thì kê đơn).',
  LOCATION_INVALID: 'Kho không thuộc cơ sở này.',
  ALREADY_RESOLVED: 'Dòng thiếu này đã được đối soát.',
  ALREADY_CANCELLED: 'Dòng này đã huỷ.',
};

export async function api<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const token = await accessToken();
  if (!token) return login();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = path.startsWith('/fhir/') ? 'application/fhir+json' : 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.', null, null);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (res.status === 401) return login();
  if (!res.ok) {
    const issue = (data as { issue?: Array<{ diagnostics?: string; details?: { text?: string } }> } | undefined)?.issue?.[0];
    const custom = data as { error?: string; message?: string } | undefined;
    const detail = issue?.details?.text ?? custom?.error ?? null;
    const message = (detail ? REASON_TEXT[detail] : undefined) ?? issue?.diagnostics ?? custom?.message ?? custom?.error ?? STATUS_TEXT[res.status] ?? `Lỗi ${res.status}`;
    throw new ApiError(res.status, res.status === 403 ? STATUS_TEXT[403]! : message, detail, data);
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

/** ETag W/"3" => 3 */
export const versionFromEtag = (h: Headers): number | null => {
  const m = /"(\d+)"/.exec(h.get('etag') ?? '');
  return m ? Number(m[1]) : null;
};

export const newIdempotencyKey = (): string => crypto.randomUUID();
