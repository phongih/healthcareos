/**
 * Quy tắc đầu vào đăng ký khách (thiết kế 27/11/2026, mục 2 và 4). Thuần, không truy cập DB.
 * Cùng quy tắc với CHECK trong migration 026/027; kiểm ở đây để trả lỗi rõ ràng trước khi ghi.
 */

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'app', 'api', 'auth', 'admin', 'www', 'login', 'portal', 'fhir', 'healthz', 'readyz',
  'opsstatus', 'static', 'support', 'help', 'mail',
]);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9 ]{8,20}$/;

export type RuleError = { readonly field: 'email' | 'orgName' | 'phone' | 'license' | 'slug'; readonly code: string };
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RuleError };

const fail = (field: RuleError['field'], code: string): { ok: false; error: RuleError } => ({ ok: false, error: { field, code } });

export function checkEmail(raw: string): Checked<string> {
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) return fail('email', 'INVALID_EMAIL');
  return { ok: true, value: v };
}

export function checkOrgName(raw: string): Checked<string> {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (v.length < 2 || v.length > 200) return fail('orgName', 'INVALID_ORG_NAME');
  return { ok: true, value: v };
}

/** Số điện thoại: bỏ khoảng trắng thừa, giữ dấu + ở đầu nếu có. */
export function checkPhone(raw: string): Checked<string> {
  const v = raw.trim();
  if (!PHONE_RE.test(v)) return fail('phone', 'INVALID_PHONE');
  return { ok: true, value: v };
}

/** Số giấy phép kinh doanh: 5–40 ký tự sau khi cắt khoảng trắng hai đầu. */
export function checkLicense(raw: string): Checked<string> {
  const v = raw.trim();
  if (v.length < 5 || v.length > 40) return fail('license', 'INVALID_LICENSE');
  return { ok: true, value: v };
}

export function checkSlug(raw: string): Checked<string> {
  const v = raw.trim().toLowerCase();
  if (!SLUG_RE.test(v)) return fail('slug', 'INVALID_SLUG');
  if (RESERVED_SLUGS.has(v)) return fail('slug', 'RESERVED_SLUG');
  return { ok: true, value: v };
}

/** Mã OTP 6 chữ số, ví dụ "004271". */
export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
