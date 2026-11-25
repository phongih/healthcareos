/**
 * HCOS-F20 | Gọi API cổng bệnh nhân. Tách khỏi lib/api.ts (không kéo OIDC / token nhân viên vào bundle cổng).
 * Token phiên cổng giữ trong sessionStorage của TAB (đóng tab là mất), gửi bằng header  Authorization: Portal <token>.
 */
export class PortalApiError extends Error {
  constructor(readonly status: number, readonly reason: string | null, message: string) {
    super(message);
    this.name = 'PortalApiError';
  }
}

/** Lý do lỗi => câu tiếng Việt cho người bệnh. */
export const REASON_TEXT: Record<string, string> = {
  OTP_INVALID: 'Mã xác thực không đúng.',
  OTP_EXPIRED: 'Mã đã hết hạn hoặc đã dùng — bấm "Gửi lại mã".',
  OTP_FORMAT: 'Mã gồm 6 chữ số.',
  OTP_THROTTLED: 'Bạn đã yêu cầu mã quá nhiều lần. Vui lòng thử lại sau 15 phút.',
  LOGIN_LOCKED: 'Nhập sai quá nhiều lần. Tạm khoá đăng nhập 30 phút.',
  RATE_LIMITED: 'Thao tác quá nhanh. Vui lòng thử lại sau ít phút.',
  PORTAL_DISABLED: 'Cơ sở chưa mở đăng nhập cổng bệnh nhân.',
  VENDOR_NOT_CLEARED: 'Kênh gửi tin nhắn tạm ngừng. Vui lòng liên hệ quầy lễ tân.',
  PHONE_INVALID: 'Số điện thoại không hợp lệ.',
  EMAIL_INVALID: 'Email không hợp lệ.',
  BIRTHDATE_INVALID: 'Ngày sinh không hợp lệ.',
  INVALID_MRN: 'Mã bệnh nhân không đúng định dạng.',
  MRN_CHECK_DIGIT: 'Mã bệnh nhân sai số kiểm tra — kiểm tra lại từng chữ số.',
  SESSION_INVALID: 'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.',
  SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn do lâu không thao tác. Vui lòng đăng nhập lại.',
  CONSENT_REQUIRED: 'Cần đồng ý điều khoản xử lý dữ liệu để đặt lịch.',
  PHONE_MISSING: 'Hồ sơ chưa có số điện thoại.',
  BIRTHDATE_MISSING: 'Hồ sơ chưa có ngày sinh — vui lòng cập nhật tại quầy.',
  NOT_CANCELLABLE: 'Lịch này không còn huỷ được (đã qua giờ khám hoặc đã tiếp nhận).',
  BOOKING_CHANGED: 'Lịch vừa thay đổi — tải lại trang.',
  SESSION_FULL: 'Buổi này đã hết chỗ — chọn buổi khác.',
  SESSION_CLOSED: 'Buổi này đã đóng đặt lịch — chọn buổi khác.',
  ROOM_NOT_BOOKABLE: 'Phòng khám này không nhận đặt lịch online.',
  MESSAGE_TOO_SHORT: 'Mô tả ít nhất 10 ký tự.',
  TOO_MANY_OPEN: 'Bạn đang có 5 yêu cầu chưa xử lý — chờ cơ sở phản hồi.',
  ERASURE_ALREADY_OPEN: 'Đã có yêu cầu xoá dữ liệu đang xử lý.',
  ALREADY_ERASED: 'Dữ liệu đã được xoá.',
  TOO_MANY_SHARES: 'Tối đa 5 link chia sẻ còn hiệu lực — thu hồi bớt một link.',
  PIN_INVALID: 'Mã PIN không đúng.',
  PIN_FORMAT: 'Mã PIN gồm 6 chữ số.',
  SHARE_LOCKED: 'Link đã bị khoá do nhập sai PIN 5 lần.',
  SHARE_EXPIRED: 'Link đã hết hạn (24 giờ).',
  SHARE_REVOKED: 'Link đã bị thu hồi.',
  NOT_FOUND: 'Không tìm thấy.',
};
const STATUS_TEXT: Record<number, string> = { 400: 'Yêu cầu không hợp lệ', 401: 'Cần đăng nhập lại', 404: 'Không tìm thấy', 409: 'Không thực hiện được', 422: 'Dữ liệu không hợp lệ', 429: 'Thử lại sau' };

const KEY = 'hcos-portal';
interface Stored { slug: string; token: string }
export function storedSession(slug: string): string | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Stored | null;
    return s && s.slug === slug && /^hpt_[A-Za-z0-9_-]{20,60}$/.test(s.token) ? s.token : null;
  } catch {
    return null;
  }
}
export function storeSession(slug: string, token: string | null): void {
  try {
    if (token) sessionStorage.setItem(KEY, JSON.stringify({ slug, token }));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* trình duyệt chặn storage: giữ trong bộ nhớ (tải lại trang phải đăng nhập lại) */
  }
}

export async function papi<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Portal ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new PortalApiError(0, null, 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const issue = (data as { issue?: Array<{ diagnostics?: string; details?: { text?: string } }> } | null)?.issue?.[0];
    const reason = issue?.details?.text ?? null;
    let msg = (reason && REASON_TEXT[reason]) ?? STATUS_TEXT[res.status] ?? 'Có lỗi xảy ra';
    // Sai mã: giữ số lần còn lại từ máy chủ ("Wrong code (3 tries left)").
    const left = /\((\d) tries left\)/.exec(issue?.diagnostics ?? '');
    if (reason === 'OTP_INVALID' && left) msg = `${msg} Còn ${left[1]} lần thử.`;
    throw new PortalApiError(res.status, reason, msg);
  }
  return data as T;
}

export const errorText = (e: unknown): string => (e instanceof PortalApiError ? e.message : 'Có lỗi xảy ra. Vui lòng thử lại.');

// ---- kiểu dữ liệu (khớp services/api/src/portal/portal.service.ts) ----
export interface Profile { personId: string; name: string; birthDate: string | null; sex: string | null; mrns: string[]; relationship: string | null; validUntil: string | null; self: boolean }
export interface Me { organizationName: string; profiles: Profile[]; contact: { phoneHint: string | null; emailHint: string | null }; training: boolean }
export type Period = 'morning' | 'afternoon';
export interface Overview {
  encounters: Array<{ encounterId: string; start: string; end: string | null; class: string; organizationName: string | null; practitioner: string | null; diagnoses: string | null; prescriptions: number }>;
  bookings: Array<{ bookingId: string; visitDate: string; period: Period; status: string; room: string; viaPortal: boolean; cancellable: boolean }>;
  receipts: Array<{ receiptNo: string; kind: string; method: string; amount: number; at: string }>;
}
export interface EncounterDetail {
  encounterId: string; start: string; end: string | null; class: string; reason: string | null; organizationName: string | null; practitioner: string | null;
  patient: { name: string; birthDate: string | null; sex: string | null; mrn: string | null };
  diagnoses: Array<{ code: string; display: string | null; verification: string }>;
  observations: Array<{ code: string; display: string | null; value: number | null; unit: string | null; text: string | null; at: string }>;
  medications: Array<{ name: string; form: string | null; dose: string; perDay: number; days: number; quantity: number; unit: string | null; instructions: string | null }>;
}
export interface BookingOptions {
  organizationName: string; consentVersion: string; consentText: string;
  rooms: Array<{ servicePointId: string; code: string; name: string }>;
  slots: Array<{ servicePointId: string; date: string; period: Period; remaining: number }>;
}
export interface Requests {
  corrections: Array<{ requestId: string; personId: string; message: string; status: string; resolutionNote: string | null; createdAt: string; resolvedAt: string | null }>;
  erasures: Array<{ requestId: string; personId: string; status: string; decisionNote: string | null; requestedAt: string; decidedAt: string | null; deferredUntil: string | null }>;
}
export interface Share { shareId: string; personId: string; encounterId: string; createdAt: string; expiresAt: string; revokedAt: string | null; views: number; locked: boolean; lastViewAt: string | null; state: 'active' | 'revoked' | 'locked' | 'expired' }
