/**
 * Đăng ký khách trên PostgreSQL thật (migration 027, ứng dụng chạy bằng hcos_app):
 *  - start: đầu vào sai => INVALID_INPUT; slug đã có tổ chức => SLUG_TAKEN; email 3 lần / giờ => RATE_LIMITED;
 *    kênh OTP không gửi được => OTP_UNAVAILABLE (không lộ mã);
 *  - verify: sai => WRONG; đúng => OK kèm slug; dùng lại => NOT_PENDING; sai 5 lần => LOCKED; hết hạn => EXPIRED.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { psqlPool } from './psql-pool';
import { SignupError, SignupService, type SignupOtpSender } from '../../services/api/src/signup/signup.service';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_signup_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;
const KEY = Buffer.from('it-signup-key-0123456789abcdef');

const su = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();

class RecordingSender implements SignupOtpSender {
  sent: Array<{ to: string; code: string }> = [];
  constructor(
    private readonly ok = true,
    readonly vendor = 'test-vendor',
  ) {}
  async send(to: string, code: string): Promise<boolean> {
    this.sent.push({ to, code });
    return this.ok;
  }
}

const base = { orgName: 'Phòng khám Mới', phone: '0908 697 966', license: 'GPKD-0001234', slug: 'pkmoi' };
const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'NO_ERROR';
  } catch (e) {
    return e instanceof SignupError ? e.code : `OTHER:${String(e)}`;
  }
};

run('Đăng ký khách / PostgreSQL (migration 027)', () => {
  beforeAll(() => {
    su('CREATE DATABASE ' + DB, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    }
    su(`INSERT INTO iam.tenants (tenant_id, code, name, slug) VALUES ('00000000-0000-4000-8000-0000000000c1', 'co-chu', 'Chủ', 'pk1')`);
    // Danh mục vendor cấp nền tảng (migration 028): một vendor được duyệt, một hết hạn xét lại, một đã tắt.
    su(`INSERT INTO platform.signup_vendors (vendor, category, cleared_by, review_due)
        VALUES ('test-vendor', 'signup_otp_email', 'ops@test', now() + interval '180 days')`);
    su(`INSERT INTO platform.signup_vendors (vendor, category, cleared_by, cleared_at, review_due)
        VALUES ('stale-vendor', 'signup_otp_email', 'ops@test', now() - interval '2 days', now() - interval '1 day')`);
    su(`INSERT INTO platform.signup_vendors (vendor, category, cleared_by, review_due, active)
        VALUES ('off-vendor', 'signup_otp_email', 'ops@test', now() + interval '180 days', false)`);
  });
  afterAll(() => {
    try {
      su('DROP DATABASE IF EXISTS ' + DB, 'postgres');
    } catch {
      /* dọn dẹp best-effort */
    }
  });

  it('đầu vào sai => INVALID_INPUT', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY });
    expect(await errCode(svc.start({ ...base, email: 'khong-phai-email' }, null))).toBe('INVALID_INPUT');
    expect(await errCode(svc.start({ ...base, email: 'a@b.vn', slug: 'app' }, null))).toBe('INVALID_INPUT');
  });

  it('slug đã có tổ chức => SLUG_TAKEN', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY });
    expect(await errCode(svc.start({ ...base, email: 'chu@pk.vn', slug: 'pk1' }, null))).toBe('SLUG_TAKEN');
  });

  it('start hợp lệ gửi mã; verify đúng => OK kèm slug; dùng lại => NOT_PENDING', async () => {
    const sender = new RecordingSender();
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, randomCode: () => '123456' });
    const { signupId } = await svc.start({ ...base, email: 'ok@pk.vn' }, '10.0.0.1');
    expect(sender.sent).toEqual([{ to: 'ok@pk.vn', code: '123456' }]);
    expect(su(`SELECT status FROM iam.signup_requests WHERE signup_id = '${signupId}'`)).toBe('pending');
    // Mã không nằm dạng rõ trong DB.
    expect(su(`SELECT otp_hash FROM iam.signup_requests WHERE signup_id = '${signupId}'`)).not.toContain('123456');
    expect(await svc.verify(signupId, '123456')).toEqual({ slug: 'pkmoi' });
    expect(await errCode(svc.verify(signupId, '123456'))).toBe('NOT_PENDING');
  });

  it('sai mã => WRONG; sai đủ 5 lần => LOCKED', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, randomCode: () => '777777' });
    const { signupId } = await svc.start({ ...base, email: 'sai@pk.vn' }, null);
    expect(await errCode(svc.verify(signupId, '000001'))).toBe('WRONG');
    for (let i = 0; i < 3; i++) await errCode(svc.verify(signupId, '000002'));
    expect(await errCode(svc.verify(signupId, '000003'))).toBe('LOCKED');
    expect(await errCode(svc.verify(signupId, '777777'))).toBe('NOT_PENDING');
  });

  it('hết hạn => EXPIRED', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, randomCode: () => '555555' });
    const { signupId } = await svc.start({ ...base, email: 'het@pk.vn' }, null);
    su(`UPDATE iam.signup_requests SET otp_expires_at = now() - interval '1 minute' WHERE signup_id = '${signupId}'`);
    expect(await errCode(svc.verify(signupId, '555555'))).toBe('EXPIRED');
  });

  it('email vượt 3 yêu cầu / giờ => RATE_LIMITED', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY });
    for (let i = 0; i < 3; i++) await svc.start({ ...base, email: 'nhieu@pk.vn' }, null);
    expect(await errCode(svc.start({ ...base, email: 'nhieu@pk.vn' }, null))).toBe('RATE_LIMITED');
  });

  it('vendor chưa duyệt, quá hạn xét lại hoặc đã tắt => OTP_UNAVAILABLE, không ghi yêu cầu, không gửi', async () => {
    for (const [vendor, email, slug] of [
      ['unknown-vendor', 'chuadk@pk.vn', 'vchuadk'],
      ['stale-vendor', 'quahan@pk.vn', 'vquahan'],
      ['off-vendor', 'taott@pk.vn', 'vtaott'],
    ] as const) {
      const sender = new RecordingSender(true, vendor);
      const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY });
      expect(await errCode(svc.start({ ...base, email, slug }, null))).toBe('OTP_UNAVAILABLE');
      expect(sender.sent).toEqual([]);
      expect(su(`SELECT count(*) FROM iam.signup_requests WHERE email = '${email}'`)).toBe('0');
    }
  });

  it('kênh OTP không gửi được => OTP_UNAVAILABLE', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(false), otpKey: KEY });
    expect(await errCode(svc.start({ ...base, email: 'loi@pk.vn' }, null))).toBe('OTP_UNAVAILABLE');
  });
});
