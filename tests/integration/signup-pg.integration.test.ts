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
import { IdpError, type IdentityProviderAdmin } from '../../services/api/src/iam/keycloak-admin';

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

/** IdP giả: ghi lại tài khoản tạo mới; không lưu mật khẩu. */
class FakeIdp {
  users = new Map<string, { id: string; enabled: boolean }>();
  calls: string[] = [];
  private n = 0;
  async createSelfUser(i: { username: string; firstName: string; email: string; password: string }): Promise<string> {
    if (this.users.has(i.username)) throw new IdpError('IDP_CONFLICT', 'dup');
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    this.users.set(i.username, { id, enabled: true });
    this.calls.push(`create:${i.username}`);
    return id;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    for (const u of this.users.values()) if (u.id === id) u.enabled = enabled;
    this.calls.push(`enabled:${id}:${enabled}`);
  }
}
const fake = new FakeIdp();
const idpCast = fake as unknown as IdentityProviderAdmin;

const base = { orgName: 'Phòng khám Mới', contactName: 'Nguyễn Văn Mới', phone: '0908 697 966', license: 'GPKD-0001234', slug: 'pkmoi' };
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
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast });
    expect(await errCode(svc.start({ ...base, email: 'khong-phai-email' }, null))).toBe('INVALID_INPUT');
    expect(await errCode(svc.start({ ...base, email: 'a@b.vn', slug: 'app' }, null))).toBe('INVALID_INPUT');
  });

  it('slug đã có tổ chức => SLUG_TAKEN', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast });
    expect(await errCode(svc.start({ ...base, email: 'chu@pk.vn', slug: 'pk1' }, null))).toBe('SLUG_TAKEN');
  });

  it('start hợp lệ gửi mã; verify đúng => OK kèm slug; dùng lại => NOT_PENDING', async () => {
    const sender = new RecordingSender();
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, idp: idpCast, randomCode: () => '123456' });
    const { signupId } = await svc.start({ ...base, email: 'ok@pk.vn' }, '10.0.0.1');
    expect(sender.sent).toEqual([{ to: 'ok@pk.vn', code: '123456' }]);
    expect(su(`SELECT status FROM iam.signup_requests WHERE signup_id = '${signupId}'`)).toBe('pending');
    // Mã không nằm dạng rõ trong DB.
    expect(su(`SELECT otp_hash FROM iam.signup_requests WHERE signup_id = '${signupId}'`)).not.toContain('123456');
    expect(await svc.verify(signupId, '123456')).toEqual({ slug: 'pkmoi' });
    expect(await errCode(svc.verify(signupId, '123456'))).toBe('NOT_PENDING');
  });

  it('sai mã => WRONG; sai đủ 5 lần => LOCKED', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast, randomCode: () => '777777' });
    const { signupId } = await svc.start({ ...base, email: 'sai@pk.vn' }, null);
    expect(await errCode(svc.verify(signupId, '000001'))).toBe('WRONG');
    for (let i = 0; i < 3; i++) await errCode(svc.verify(signupId, '000002'));
    expect(await errCode(svc.verify(signupId, '000003'))).toBe('LOCKED');
    expect(await errCode(svc.verify(signupId, '777777'))).toBe('NOT_PENDING');
  });

  it('hết hạn => EXPIRED', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast, randomCode: () => '555555' });
    const { signupId } = await svc.start({ ...base, email: 'het@pk.vn' }, null);
    su(`UPDATE iam.signup_requests SET otp_expires_at = now() - interval '1 minute' WHERE signup_id = '${signupId}'`);
    expect(await errCode(svc.verify(signupId, '555555'))).toBe('EXPIRED');
  });

  it('email vượt 3 yêu cầu / giờ => RATE_LIMITED', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast });
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
      const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, idp: idpCast });
      expect(await errCode(svc.start({ ...base, email, slug }, null))).toBe('OTP_UNAVAILABLE');
      expect(sender.sent).toEqual([]);
      expect(su(`SELECT count(*) FROM iam.signup_requests WHERE email = '${email}'`)).toBe('0');
    }
  });

  it('kênh OTP không gửi được => OTP_UNAVAILABLE', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(false), otpKey: KEY, idp: idpCast });
    expect(await errCode(svc.start({ ...base, email: 'loi@pk.vn' }, null))).toBe('OTP_UNAVAILABLE');
  });

  it('hoàn tất trước khi xác minh => NOT_PENDING, không gọi IdP', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast });
    const { signupId } = await svc.start({ ...base, email: 'chuaxm@pk.vn', slug: 'chuaxm' }, null);
    expect(await errCode(svc.complete(signupId, 'mat-khau-dai-12'))).toBe('NOT_PENDING');
    expect(fake.users.has('chuaxm@pk.vn')).toBe(false);
  });

  it('hoàn tất sau xác minh: tổ chức chờ duyệt, cơ sở trụ sở, tài khoản quản trị tạm thời, yêu cầu consumed', async () => {
    const sender = new RecordingSender();
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, idp: idpCast, randomCode: () => '246810' });
    const email = 'hoanthanh@pk.vn';
    const { signupId } = await svc.start({ ...base, email, slug: 'hoanthanh', contactName: 'Trần Thị Hoàn' }, null);
    await svc.verify(signupId, '246810');
    const out = await svc.complete(signupId, 'mat-khau-dai-12');
    expect(out.slug).toBe('hoanthanh');
    expect(su(`SELECT status FROM iam.tenants WHERE slug = 'hoanthanh'`)).toBe('provisioning');
    expect(su(`SELECT count(*) FROM iam.organizations o JOIN iam.tenants t ON t.tenant_id = o.tenant_id WHERE t.slug = 'hoanthanh' AND o.type = 'headquarters'`)).toBe('1');
    expect(su(`SELECT u.display_name || '|' || u.email || '|' || m.role || '|' || m.status FROM iam.users u JOIN iam.memberships m ON m.user_id = u.user_id AND m.tenant_id = u.tenant_id JOIN iam.tenants t ON t.tenant_id = u.tenant_id WHERE t.slug = 'hoanthanh'`))
      .toBe('Trần Thị Hoàn|hoanthanh@pk.vn|tenant_admin|active');
    expect(su(`SELECT status FROM iam.signup_requests WHERE signup_id = '${signupId}'`)).toBe('consumed');
    expect(fake.users.get(email)?.enabled).toBe(true);
    expect(fake.calls).not.toContain('enabled:' + fake.users.get(email)?.id + ':false');
  });

  it('hoàn tất lần hai => NOT_PENDING', async () => {
    const sender = new RecordingSender();
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, idp: idpCast, randomCode: () => '135790' });
    const { signupId } = await svc.start({ ...base, email: 'lan2@pk.vn', slug: 'lanhai' }, null);
    await svc.verify(signupId, '135790');
    await svc.complete(signupId, 'mat-khau-dai-12');
    expect(await errCode(svc.complete(signupId, 'mat-khau-dai-12'))).toBe('NOT_PENDING');
  });

  it('username đã có trong IdP => ACCOUNT_EXISTS, không tạo tổ chức', async () => {
    const sender = new RecordingSender();
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, idp: idpCast, randomCode: () => '112233' });
    const email = 'trung@pk.vn';
    await fake.createSelfUser({ username: email, firstName: 'Có sẵn', email, password: 'mat-khau-cu-12345' });
    const { signupId } = await svc.start({ ...base, email, slug: 'trungpk' }, null);
    await svc.verify(signupId, '112233');
    expect(await errCode(svc.complete(signupId, 'mat-khau-dai-12'))).toBe('ACCOUNT_EXISTS');
    expect(su(`SELECT count(*) FROM iam.tenants WHERE slug = 'trungpk'`)).toBe('0');
  });

  it('lỗi DB sau khi tạo IdP (slug trùng mã tổ chức) => SLUG_TAKEN và vô hiệu hoá tài khoản IdP', async () => {
    const sender = new RecordingSender();
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender, otpKey: KEY, idp: idpCast, randomCode: () => '424242' });
    const email = 'loidb@pk.vn';
    const { signupId } = await svc.start({ ...base, email, slug: 'co-chu' }, null);
    await svc.verify(signupId, '424242');
    expect(await errCode(svc.complete(signupId, 'mat-khau-dai-12'))).toBe('SLUG_TAKEN');
    expect(fake.users.get(email)?.enabled).toBe(false);
    expect(su(`SELECT status FROM iam.signup_requests WHERE signup_id = '${signupId}'`)).toBe('verified');
  });

  it('mật khẩu ngắn => INVALID_INPUT, không gọi IdP', async () => {
    const svc = new SignupService({ pool: psqlPool({ database: DB }), sender: new RecordingSender(), otpKey: KEY, idp: idpCast });
    const before = fake.calls.length;
    expect(await errCode(svc.complete('00000000-0000-4000-8000-000000000000', 'ngan'))).toBe('INVALID_INPUT');
    expect(fake.calls.length).toBe(before);
  });
});
