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
  REASON_REQUIRED: 'Cần ghi lý do (ít nhất 5 ký tự).',
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
