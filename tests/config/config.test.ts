/** HCOS-P0-ENG-001 | Cấu hình: fail-fast, không mặc định ngầm cho giá trị bảo mật. */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../services/api/src/config';

const OK = {
  HCOS_DATABASE_URL: 'postgres://hcos_app:secret@db.internal:5432/hcos',
  HCOS_JWT_ISSUER: 'https://idp.example.vn/',
  HCOS_JWT_AUDIENCE: 'hcos-api',
  HCOS_JWKS_URL: 'https://idp.example.vn/.well-known/jwks.json',
  HCOS_KEKS: 't1:' + Buffer.alloc(32, 7).toString('base64'),
};
const problems = (env: Record<string, string | undefined>): string[] => {
  try { loadConfig(env); } catch (e) { if (e instanceof ConfigError) return [...e.problems]; throw e; }
  return [];
};

describe('loadConfig', () => {
  it('loads a valid environment with defaults', () => {
    const c = loadConfig(OK);
    expect(c.port).toBe(8080);
    expect(c.maxBodyBytes).toBe(1_048_576);
    expect(c.dbPoolMax).toBe(10);
    expect(c.readyTimeoutMs).toBe(2000);
    expect(c.issuer).toEqual(['https://idp.example.vn/']);
  });

  it('splits multiple issuers/audiences and honours overrides', () => {
    const c = loadConfig({ ...OK, HCOS_JWT_ISSUER: 'https://a/, https://b/', HCOS_JWT_AUDIENCE: 'x,y', HCOS_PORT: '9000', HCOS_DB_POOL_MAX: '25' });
    expect(c.issuer).toEqual(['https://a/', 'https://b/']);
    expect(c.audience).toEqual(['x', 'y']);
    expect(c.port).toBe(9000);
    expect(c.dbPoolMax).toBe(25);
  });

  it('reports ALL missing security settings at once (no silent defaults)', () => {
    const p = problems({});
    expect(p).toHaveLength(5);
    expect(p).toContain('HCOS_KEKS is required');
    expect(p.some((x) => x.startsWith('HCOS_JWT_ISSUER'))).toBe(true);
  });

  it('refuses superuser/provisioner database roles', () => {
    expect(problems({ ...OK, HCOS_DATABASE_URL: 'postgres://postgres:x@h/db' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_DATABASE_URL: 'postgres://hcos_provisioner:x@h/db' })).toHaveLength(1);
  });

  it('rejects non-postgres URLs and non-https JWKS (except localhost)', () => {
    expect(problems({ ...OK, HCOS_DATABASE_URL: 'mysql://hcos_app@h/db' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_JWKS_URL: 'http://idp.example.vn/jwks' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_JWKS_URL: 'http://localhost:9000/jwks' })).toHaveLength(0);
  });

  it('HCOS_HOST: optional IP literal; hostnames and garbage are rejected', () => {
    expect(loadConfig(OK).host).toBeUndefined();
    expect(loadConfig({ ...OK, HCOS_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
    expect(loadConfig({ ...OK, HCOS_HOST: '::1' }).host).toBe('::1');
    expect(loadConfig({ ...OK, HCOS_HOST: '  ' }).host).toBeUndefined();
    expect(problems({ ...OK, HCOS_HOST: 'localhost' })).toEqual(['HCOS_HOST must be an IPv4 or IPv6 address']);
    expect(problems({ ...OK, HCOS_HOST: '0.0.0.0/0' })).toHaveLength(1);
  });

  it('rejects bad numbers and never echoes secrets in the error', () => {
    expect(problems({ ...OK, HCOS_PORT: '70000' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_PORT: 'abc' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_READY_TIMEOUT_MS: '5' })).toHaveLength(1);
    try {
      loadConfig({ ...OK, HCOS_DATABASE_URL: 'postgres://postgres:topsecret@h/db' });
    } catch (e) {
      expect(String((e as Error).message).includes('topsecret')).toBe(false);
    }
  });

  it('F20: kênh OTP cổng — mặc định tắt; training chỉ với HCOS_TRAINING_ENV=1; webhook cần https + token + vendor', () => {
    expect(loadConfig(OK).portalOtp).toEqual({ mode: 'off' });
    expect(problems({ ...OK, HCOS_PORTAL_OTP: 'training' })).toEqual(['HCOS_PORTAL_OTP=training requires HCOS_TRAINING_ENV=1 (fake-data environment only)']);
    expect(loadConfig({ ...OK, HCOS_PORTAL_OTP: 'training', HCOS_TRAINING_ENV: '1' }).portalOtp).toEqual({ mode: 'training' });
    expect(problems({ ...OK, HCOS_PORTAL_OTP: 'webhook', HCOS_PORTAL_OTP_URL: 'http://sms.example.vn', HCOS_PORTAL_OTP_TOKEN: 'short', HCOS_PORTAL_OTP_VENDOR: 'x' })).toHaveLength(3);
    const ok = loadConfig({ ...OK, HCOS_PORTAL_OTP: 'webhook', HCOS_PORTAL_OTP_URL: 'https://sms.example.vn/send', HCOS_PORTAL_OTP_TOKEN: 'x'.repeat(24),
      HCOS_PORTAL_OTP_VENDOR: '00000000-0000-4000-8000-000000000001' });
    expect(ok.portalOtp).toMatchObject({ mode: 'webhook', url: 'https://sms.example.vn/send' });
    expect(problems({ ...OK, HCOS_PORTAL_OTP: 'sms' })).toEqual(['HCOS_PORTAL_OTP must be off, training or webhook']);
  });

  it('MFA ở API: HCOS_REQUIRE_AMR — mặc định không kiểm; danh sách amr hợp lệ', () => {
    expect(loadConfig(OK).requireAmr).toEqual([]);
    expect(loadConfig({ ...OK, HCOS_REQUIRE_AMR: 'otp, hwk,otp' }).requireAmr).toEqual(['otp', 'hwk']);
    expect(problems({ ...OK, HCOS_REQUIRE_AMR: 'otp;rm -rf' })).toEqual(['HCOS_REQUIRE_AMR must be a comma list of amr values (e.g. otp,hwk)']);
  });
});

describe('loadConfig: SMTP gửi OTP đăng ký', () => {
  const SMTP = {
    HCOS_SIGNUP_SMTP_HOST: 'smtp.gmail.com',
    HCOS_SIGNUP_SMTP_PORT: '465',
    HCOS_SIGNUP_SMTP_USER: 'noreply@smart.id.vn',
    HCOS_SIGNUP_SMTP_PASS: 'app-pass-abcdefghijkl',
    HCOS_SIGNUP_SMTP_FROM: 'noreply@smart.id.vn',
  };

  it('không đặt biến nào => null (fail-closed)', () => {
    expect(loadConfig(OK).signupSmtp).toBeNull();
  });

  it('đủ năm biến hợp lệ => cấu hình SMTP', () => {
    expect(loadConfig({ ...OK, ...SMTP }).signupSmtp).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      user: 'noreply@smart.id.vn',
      pass: 'app-pass-abcdefghijkl',
      from: 'noreply@smart.id.vn',
    });
  });

  it('đặt thiếu biến => lỗi, không tự tắt im lặng', () => {
    const { HCOS_SIGNUP_SMTP_PASS: _p, ...partial } = SMTP;
    expect(problems({ ...OK, ...partial }).join(' ')).toMatch(/must all be set together/);
  });

  it('cổng khác 465 (không có STARTTLS) và email gửi sai => lỗi', () => {
    expect(problems({ ...OK, ...SMTP, HCOS_SIGNUP_SMTP_PORT: '587' }).join(' ')).toMatch(/PORT must be 465/);
    expect(problems({ ...OK, ...SMTP, HCOS_SIGNUP_SMTP_FROM: 'khong-phai-email' }).join(' ')).toMatch(/FROM must be a plain email/);
  });

  it('mật khẩu có xuống dòng => lỗi, và thông báo lỗi không chứa mật khẩu', () => {
    const p = problems({ ...OK, ...SMTP, HCOS_SIGNUP_SMTP_PASS: 'bi-mat\nxyz' });
    expect(p.join(' ')).toMatch(/PASS must be a single non-empty line/);
    expect(p.join(' ')).not.toContain('bi-mat');
  });
});
