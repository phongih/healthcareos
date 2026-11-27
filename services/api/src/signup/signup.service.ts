/**
 * HCOS | Đăng ký khách (thiết kế 27/11/2026): bắt đầu đăng ký và xác minh OTP qua email.
 *  - start: kiểm đầu vào, sinh OTP 6 số, lưu bản băm có muối (qua iam.signup_start), gửi mã qua kênh OTP;
 *  - verify: so khớp mã, ghi kết quả qua iam.signup_check_otp (đủ 5 lần sai => khoá yêu cầu).
 * Không tạo tài khoản, tổ chức hay Keycloak ở đây; đó là bước sau khi quản trị viên duyệt.
 * Mã OTP không bao giờ được ghi log hay trả về cho người gọi ngoài kênh gửi.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import type { PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { checkEmail, checkLicense, checkOrgName, checkPhone, checkSlug, OTP_LENGTH, OTP_TTL_MS, type Checked, type RuleError } from './signup-rules';

/** Kênh gửi mã OTP tới email. Trả true nếu nhà cung cấp đã nhận. */
export interface SignupOtpSender {
  /** Mã vendor phải có trong platform.signup_vendors (đã duyệt, còn hạn) thì mới được gửi. */
  readonly vendor: string;
  send(to: string, code: string, orgName: string): Promise<boolean>;
}

/** Loại kênh trong danh mục vendor cấp nền tảng (khớp CHECK của migration 028). */
export const OTP_CHANNEL_CATEGORY = 'signup_otp_email';

export type SignupErrorCode =
  | 'INVALID_INPUT' | 'RATE_LIMITED' | 'SLUG_TAKEN' | 'OTP_UNAVAILABLE' | 'NOT_PENDING' | 'EXPIRED' | 'LOCKED' | 'WRONG';

export class SignupError extends Error {
  constructor(readonly code: SignupErrorCode, readonly detail?: RuleError) {
    super(code);
    this.name = 'SignupError';
  }
}

export interface StartInput {
  readonly email: string;
  readonly orgName: string;
  readonly phone: string;
  readonly license: string;
  readonly slug: string;
}

export interface SignupDeps {
  readonly pool: PgPoolLike;
  readonly sender: SignupOtpSender;
  /** Khoá HMAC cho bản băm OTP (cấu hình bí mật, không lưu trong DB). */
  readonly otpKey: Buffer;
  readonly randomCode?: () => string;
}

function must<T>(c: Checked<T>): T {
  if (!c.ok) throw new SignupError('INVALID_INPUT', c.error);
  return c.value;
}

const defaultCode = (): string => String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

/** Băm có muối: "<salt-hex>:<hmac-hex>". Muối riêng mỗi yêu cầu, khoá HMAC giữ ngoài DB. */
export function hashOtp(key: Buffer, code: string, salt: Buffer = randomBytes(16)): string {
  return `${salt.toString('hex')}:${createHmac('sha256', key).update(salt).update(code).digest('hex')}`;
}

export function otpMatches(key: Buffer, code: string, stored: string): boolean {
  const [saltHex, macHex] = stored.split(':');
  if (!saltHex || !macHex || !/^\d{6}$/.test(code)) return false;
  const expected = Buffer.from(macHex, 'hex');
  const actual = createHmac('sha256', key).update(Buffer.from(saltHex, 'hex')).update(code).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class SignupService {
  constructor(private readonly deps: SignupDeps) {}

  async start(input: StartInput, clientIp: string | null): Promise<{ signupId: string; expiresAt: Date }> {
    const email = must(checkEmail(input.email));
    const orgName = must(checkOrgName(input.orgName));
    const phone = must(checkPhone(input.phone));
    const license = must(checkLicense(input.license));
    const slug = must(checkSlug(input.slug));
    const client = await this.deps.pool.connect();
    let row: { signup_id: string; expires_at: Date };
    try {
      // Kiểm tra vendor trước khi ghi yêu cầu: kênh chưa duyệt thì không tạo bản ghi và không gửi gì.
      // Trả chuỗi 'OK'/'NO' thay vì boolean: driver khác nhau biểu diễn boolean khác nhau.
      const c = await client.query(
        "SELECT CASE WHEN platform.signup_channel_cleared($1, $2) THEN 'OK' ELSE 'NO' END AS state",
        [OTP_CHANNEL_CATEGORY, this.deps.sender.vendor],
      );
      if ((c.rows[0] as { state: string } | undefined)?.state !== 'OK') throw new SignupError('OTP_UNAVAILABLE');
    } catch (e) {
      client.release();
      throw e instanceof SignupError ? e : mapPgError(e);
    }
    const code = (this.deps.randomCode ?? defaultCode)();
    const hash = hashOtp(this.deps.otpKey, code);
    try {
      const r = await client.query(
        'SELECT signup_id, expires_at FROM iam.signup_start($1, $2, $3, $4, $5, $6, $7::interval, $8::inet)',
        [email, orgName, phone, license, slug, hash, `${OTP_TTL_MS / 1000} seconds`, clientIp],
      );
      row = r.rows[0] as { signup_id: string; expires_at: Date };
    } catch (e) {
      throw mapPgError(e);
    } finally {
      client.release();
    }
    const delivered = await this.deps.sender.send(email, code, orgName).catch(() => false);
    if (!delivered) throw new SignupError('OTP_UNAVAILABLE');
    return { signupId: row.signup_id, expiresAt: row.expires_at };
  }

  /** Tra slug công khai: chỉ tên hiển thị, trạng thái và chuyển hướng (không có danh sách cơ sở / nhân viên). */
  async resolve(slug: string): Promise<{ displayName: string; status: string; redirect: boolean } | null> {
    const v = checkSlug(slug);
    if (!v.ok) return null;
    const client = await this.deps.pool.connect();
    try {
      const r = await client.query('SELECT display_name, status, is_redirect FROM iam.resolve_slug($1)', [v.value]);
      const row = r.rows[0] as { display_name: string; status: string; is_redirect: boolean } | undefined;
      return row ? { displayName: row.display_name, status: row.status, redirect: row.is_redirect } : null;
    } finally {
      client.release();
    }
  }

  async verify(signupId: string, code: string): Promise<{ slug: string }> {
    const client = await this.deps.pool.connect();
    try {
      const s = await client.query('SELECT otp_hash, status, slug FROM iam.signup_otp_state($1)', [signupId]);
      const st = s.rows[0] as { otp_hash: string; status: string; slug: string } | undefined;
      if (!st || st.status !== 'pending') throw new SignupError('NOT_PENDING');
      const ok = otpMatches(this.deps.otpKey, code, st.otp_hash);
      const r = await client.query('SELECT iam.signup_check_otp($1, $2) AS result', [signupId, ok]);
      const result = (r.rows[0] as { result: string }).result;
      if (result === 'OK') return { slug: st.slug };
      if (result === 'WRONG' || result === 'LOCKED' || result === 'EXPIRED' || result === 'NOT_PENDING') {
        throw new SignupError(result);
      }
      throw new SignupError('NOT_PENDING');
    } finally {
      client.release();
    }
  }
}

/** Ánh xạ lỗi từ hàm PostgreSQL sang mã nghiệp vụ. Lỗi khác giữ nguyên (không lộ chi tiết ra ngoài). */
export function mapPgError(e: unknown): unknown {
  const err = e as { code?: string; message?: string };
  if (err?.message?.includes('SIGNUP_RATE_LIMITED')) return new SignupError('RATE_LIMITED');
  if (err?.code === '23505' && err.message?.includes('SLUG_TAKEN')) return new SignupError('SLUG_TAKEN');
  if (err?.code === '23505') return new SignupError('SLUG_TAKEN');
  return e;
}

/** Kênh OTP mặc định: chưa cấu hình nhà cung cấp => không gửi được (fail-closed, không bao giờ hiện mã). */
export const NO_SIGNUP_OTP_CHANNEL: SignupOtpSender = { vendor: 'none', send: async () => false };
