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
    const message = issue?.diagnostics ?? custom?.message ?? custom?.error ?? STATUS_TEXT[res.status] ?? `Lỗi ${res.status}`;
    const detail = issue?.details?.text ?? custom?.error ?? null;
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
