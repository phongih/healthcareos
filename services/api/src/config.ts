/**
 * HCOS-P0-ENG-001 | Cấu hình từ biến môi trường. Thuần, fail-fast: thiếu/sai => ném lỗi liệt kê MỌI vấn đề, không mặc định ngầm
 * cho các giá trị liên quan bảo mật (issuer, audience, JWKS, DB).
 *
 *   HCOS_DATABASE_URL   postgres://<login-role>:<pw>@host:5432/db  (TCP; URL dạng unix-socket không được hỗ trợ). Login-role phải là thành viên hcos_app,
 *                       KHÔNG superuser/BYPASSRLS (main.ts kiểm tra lúc khởi động và từ chối nếu vi phạm)
 *   HCOS_JWT_ISSUER     vd https://idp.example.vn/        (nhiều giá trị: phân tách bằng dấu phẩy)
 *   HCOS_JWT_AUDIENCE   vd hcos-api
 *   HCOS_KC_ADMIN_URL / HCOS_KC_REALM / HCOS_KC_ADMIN_CLIENT_ID / HCOS_KC_ADMIN_CLIENT_SECRET  client Keycloak Admin cho quản trị nhân sự (F21); thiếu secret = tắt tạo tài khoản
 *   HCOS_REQUIRE_AMR    bắt buộc MFA: danh sách amr chấp nhận, cách nhau dấu phẩy (vd otp,hwk). Rỗng = không kiểm (chỉ dev / test)
 *   HCOS_JWKS_URL       https://idp.example.vn/.well-known/jwks.json (bắt buộc https, trừ localhost)
 *   HCOS_PORT           mặc định 8080
 *   HCOS_HOST           địa chỉ IP (v4/v6) để lắng nghe, vd 127.0.0.1 khi chạy sau reverse proxy cùng máy; mặc định: mọi giao diện
 *   HCOS_MAX_BODY_BYTES mặc định 1048576
 *   HCOS_DB_POOL_MAX    mặc định 10
 *   HCOS_READY_TIMEOUT_MS  timeout của /readyz, mặc định 2000
 *   HCOS_DECISION_INTERVAL_SEC  chu kỳ chạy Decision Engine (giây), mặc định 300; 0 = tắt bộ lập lịch (vẫn bấm "Chạy ngay" được)
 *   HCOS_NO_SHOW_INTERVAL_SEC   chu kỳ job đánh dấu vắng lịch hẹn (giây), mặc định 3600; 0 = tắt, tối thiểu 300
 *   HCOS_RETENTION_INTERVAL_SEC chu kỳ job lưu giữ / xoá (giây), mặc định 86400 (1 ngày); 0 = tắt (vẫn bấm "Chạy ngay" được), tối thiểu 300
 *   HCOS_BACKUP_HORIZON_DAYS  thời hạn giữ bản sao lưu dài nhất (bucket + bản dump cục bộ), mặc định 90 — ghi vào biên nhận xoá:
 *                             ngày "không thể khôi phục" = lúc xoá + số ngày này
 *   HCOS_INTEGRATION_KEY  khoá AES-256 (base64, đúng 32 byte) để mã hoá URL / bí mật webhook khi lưu. Không đặt => tắt tính năng tích hợp
 *                         (API vẫn chạy). Tạo: openssl rand -base64 32. Mất khoá => phải nhập lại URL các kết nối.
 *   HCOS_PUBLIC_BASE_URL  vd https://smart.id.vn — để thẻ Teams có nút "Mở trong HealthcareOS"; bắt buộc https
 *   HCOS_INTEGRATION_DISPATCH_SEC  chu kỳ giao webhook (giây), mặc định 15; 0 = tắt
 *   HCOS_PORTAL_OTP       HCOS-F20 kênh gửi OTP cổng bệnh nhân: off (mặc định, tắt đăng nhập cổng) | training | webhook.
 *                         training: mã OTP hiện ngay trên màn đăng nhập — CHỈ được bật cùng HCOS_TRAINING_ENV=1 (môi trường dữ liệu giả).
 *                         webhook: POST {to, text} tới HCOS_PORTAL_OTP_URL (https) với Bearer HCOS_PORTAL_OTP_TOKEN; nhà cung cấp
 *                         HCOS_PORTAL_OTP_VENDOR (id trong sổ F18) phải có đánh giá còn hiệu lực cho loại dữ liệu 'personal' — kiểm mỗi lần gửi.
 *   HCOS_KEKS             BẮT BUỘC (HCOS-F16): KEK bọc khoá mã hoá dữ liệu, dạng "id:base64[,id:base64…]" (32 byte mỗi khoá),
 *                         khoá ĐẦU là khoá đang dùng. Tạo: echo "k1:$(openssl rand -base64 32)". KHÔNG để trong CSDL / bản sao lưu CSDL;
 *                         sao lưu riêng ngoại tuyến — mất KEK là mất dữ liệu đã mã hoá. Phải khác HCOS_INTEGRATION_KEY.
 */
import { isIP } from 'node:net';

import { LocalKeyProvider, PiiConfigError } from '../../../packages/security/src/pii';
export interface AppConfig {
  readonly databaseUrl: string;
  readonly issuer: string[];
  readonly audience: string[];
  readonly jwksUrl: string;
  readonly port: number;
  /** Địa chỉ IP để lắng nghe; undefined = mọi giao diện (hành vi cũ, cần cho container). */
  readonly host: string | undefined;
  readonly maxBodyBytes: number;
  readonly dbPoolMax: number;
  readonly readyTimeoutMs: number;
  /** Chu kỳ chạy Decision Engine (giây); 0 = tắt bộ lập lịch. */
  readonly decisionIntervalSec: number;
  readonly retentionIntervalSec: number;
  readonly noShowIntervalSec: number;
  /** Rỗng = không kiểm MFA ở API. */
  readonly requireAmr: readonly string[];
  /** null = chưa cấu hình (tạo / khoá tài khoản trên Keycloak bị tắt, báo IDP_NOT_CONFIGURED). */
  readonly keycloakAdmin: { readonly baseUrl: string; readonly realm: string; readonly clientId: string; readonly clientSecret: string } | null;
  readonly backupHorizonDays: number;
  /** Khoá mã hoá bí mật tích hợp (32 byte); null = tắt tích hợp. */
  readonly integrationKey: Buffer | null;
  /** Khoá HMAC băm OTP đăng ký khách (HCOS_SIGNUP_OTP_KEY, base64 32 byte). Không đặt => đăng ký tắt. */
  readonly signupOtpKey: Buffer | null;
  readonly publicBaseUrl: string | null;
  readonly integrationDispatchSec: number;
  /** HCOS-F16: KEK cục bộ (bọc DEK). */
  readonly keyProvider: LocalKeyProvider | null;
  /** HCOS-F20: kênh OTP cổng bệnh nhân. */
  readonly portalOtp: PortalOtpConfig;
}
export type PortalOtpConfig =
  | { readonly mode: 'off' }
  | { readonly mode: 'training' }
  | { readonly mode: 'webhook'; readonly url: string; readonly token: string; readonly vendorId: string };

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const problems: string[] = [];
  const req = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) problems.push(`${k} is required`);
    return v ?? '';
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const raw = env[k]?.trim();
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${k} must be an integer in [${min}, ${max}]`);
      return def;
    }
    return n;
  };

  const hostRaw = env['HCOS_HOST']?.trim();
  if (hostRaw && isIP(hostRaw) === 0) problems.push('HCOS_HOST must be an IPv4 or IPv6 address');

  const databaseUrl = req('HCOS_DATABASE_URL');
  if (databaseUrl) {
    let u: URL | undefined;
    try { u = new URL(databaseUrl); } catch { problems.push('HCOS_DATABASE_URL is not a valid URL'); }
    if (u) {
      if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push('HCOS_DATABASE_URL must be a postgres:// URL');
      if (['postgres', 'hcos_provisioner'].includes(decodeURIComponent(u.username))) {
        problems.push('HCOS_DATABASE_URL must use the restricted hcos_app role, not a superuser/provisioner');
      }
    }
  }

  const issuer = list(req('HCOS_JWT_ISSUER'));
  const audience = list(req('HCOS_JWT_AUDIENCE'));

  const jwksUrl = req('HCOS_JWKS_URL');
  if (jwksUrl) {
    try {
      const u = new URL(jwksUrl);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) problems.push('HCOS_JWKS_URL must be https');
    } catch {
      problems.push('HCOS_JWKS_URL is not a valid URL');
    }
  }

  let integrationKey: Buffer | null = null;
  const keyRaw = env['HCOS_INTEGRATION_KEY']?.trim();
  if (keyRaw) {
    const k = /^[A-Za-z0-9+/]+={0,2}$/.test(keyRaw) ? Buffer.from(keyRaw, 'base64') : Buffer.alloc(0);
    if (k.length !== 32) problems.push('HCOS_INTEGRATION_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)');
    else integrationKey = k;
  }
  let signupOtpKey: Buffer | null = null;
  const signupRaw = env['HCOS_SIGNUP_OTP_KEY']?.trim();
  if (signupRaw) {
    const k = /^[A-Za-z0-9+/]+={0,2}$/.test(signupRaw) ? Buffer.from(signupRaw, 'base64') : Buffer.alloc(0);
    if (k.length !== 32) problems.push('HCOS_SIGNUP_OTP_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)');
    else signupOtpKey = k;
  }
  let publicBaseUrl: string | null = null;
  const baseRaw = env['HCOS_PUBLIC_BASE_URL']?.trim();
  if (baseRaw) {
    try {
      const u = new URL(baseRaw);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) problems.push('HCOS_PUBLIC_BASE_URL must be a plain https URL');
      else publicBaseUrl = u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      problems.push('HCOS_PUBLIC_BASE_URL is not a valid URL');
    }
  }

  let keyProvider: LocalKeyProvider | null = null;
  const keksRaw = req('HCOS_KEKS');
  if (keksRaw) {
    try {
      keyProvider = LocalKeyProvider.parse(keksRaw);
      if (integrationKey && keksRaw.split(',').some((s) => Buffer.from(s.slice(s.indexOf(':') + 1).trim(), 'base64').equals(integrationKey!))) {
        problems.push('HCOS_KEKS must not reuse HCOS_INTEGRATION_KEY');
      }
    } catch (e) {
      problems.push(e instanceof PiiConfigError ? `HCOS_KEKS: ${e.message}` : 'HCOS_KEKS is invalid');
    }
  }

  // HCOS-F20
  let portalOtp: PortalOtpConfig = { mode: 'off' };
  const otpMode = env['HCOS_PORTAL_OTP']?.trim() || 'off';
  if (otpMode === 'training') {
    if (env['HCOS_TRAINING_ENV']?.trim() !== '1') problems.push('HCOS_PORTAL_OTP=training requires HCOS_TRAINING_ENV=1 (fake-data environment only)');
    else portalOtp = { mode: 'training' };
  } else if (otpMode === 'webhook') {
    const url = env['HCOS_PORTAL_OTP_URL']?.trim() ?? '';
    const token = env['HCOS_PORTAL_OTP_TOKEN']?.trim() ?? '';
    const vendorId = (env['HCOS_PORTAL_OTP_VENDOR']?.trim() ?? '').toLowerCase();
    let ok = true;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password) { problems.push('HCOS_PORTAL_OTP_URL must be a plain https URL'); ok = false; }
    } catch {
      problems.push('HCOS_PORTAL_OTP_URL is required (https)');
      ok = false;
    }
    if (token.length < 16) { problems.push('HCOS_PORTAL_OTP_TOKEN must be at least 16 characters'); ok = false; }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(vendorId)) { problems.push('HCOS_PORTAL_OTP_VENDOR must be a vendor id (UUID) from the vendor register'); ok = false; }
    if (ok) portalOtp = { mode: 'webhook', url, token, vendorId };
  } else if (otpMode !== 'off') {
    problems.push('HCOS_PORTAL_OTP must be off, training or webhook');
  }

  const cfg: AppConfig = {
    portalOtp,
    databaseUrl,
    keyProvider,
    issuer,
    audience,
    jwksUrl,
    port: int('HCOS_PORT', 8080, 1, 65535),
    host: hostRaw && isIP(hostRaw) !== 0 ? hostRaw : undefined,
    maxBodyBytes: int('HCOS_MAX_BODY_BYTES', 1_048_576, 1024, 50 * 1_048_576),
    dbPoolMax: int('HCOS_DB_POOL_MAX', 10, 1, 200),
    readyTimeoutMs: int('HCOS_READY_TIMEOUT_MS', 2000, 100, 30_000),
    retentionIntervalSec: (() => {
      const v = int('HCOS_RETENTION_INTERVAL_SEC', 86_400, 0, 7 * 86_400);
      if (v > 0 && v < 300) problems.push('HCOS_RETENTION_INTERVAL_SEC must be 0 (off) or at least 300');
      return v;
    })(),
    keycloakAdmin: (() => {
      const secret = env['HCOS_KC_ADMIN_CLIENT_SECRET']?.trim() ?? '';
      if (!secret) return null;
      const baseUrl = env['HCOS_KC_ADMIN_URL']?.trim() || 'http://127.0.0.1:8081/auth';
      if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) problems.push('HCOS_KC_ADMIN_URL must be an http(s) URL');
      if (secret.length < 16) problems.push('HCOS_KC_ADMIN_CLIENT_SECRET looks too short');
      return Object.freeze({ baseUrl, realm: env['HCOS_KC_REALM']?.trim() || 'hcos', clientId: env['HCOS_KC_ADMIN_CLIENT_ID']?.trim() || 'hcos-admin-api', clientSecret: secret });
    })(),
    requireAmr: (() => {
      const v = list(env['HCOS_REQUIRE_AMR'] ?? '');
      for (const x of v) if (!/^[a-z0-9_-]{2,32}$/.test(x)) problems.push('HCOS_REQUIRE_AMR must be a comma list of amr values (e.g. otp,hwk)');
      return Object.freeze([...new Set(v)]);
    })(),
    noShowIntervalSec: (() => {
      const v = int('HCOS_NO_SHOW_INTERVAL_SEC', 3600, 0, 86_400);
      if (v > 0 && v < 300) problems.push('HCOS_NO_SHOW_INTERVAL_SEC must be 0 (off) or at least 300');
      return v;
    })(),
    backupHorizonDays: int('HCOS_BACKUP_HORIZON_DAYS', 90, 0, 3650),
    decisionIntervalSec: (() => {
      const v = int('HCOS_DECISION_INTERVAL_SEC', 300, 0, 86_400);
      if (v > 0 && v < 60) {
        problems.push('HCOS_DECISION_INTERVAL_SEC must be 0 (off) or at least 60');
      }
      return v;
    })(),
    integrationKey,
    signupOtpKey,
    publicBaseUrl,
    integrationDispatchSec: (() => {
      const v = int('HCOS_INTEGRATION_DISPATCH_SEC', 15, 0, 3600);
      if (v > 0 && v < 5) problems.push('HCOS_INTEGRATION_DISPATCH_SEC must be 0 (off) or at least 5');
      return v;
    })(),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
