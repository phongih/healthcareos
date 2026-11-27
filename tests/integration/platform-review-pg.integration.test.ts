/**
 * Màn duyệt tổ chức trên PostgreSQL thật (migration 030, ứng dụng chạy bằng hcos_app):
 *  - chỉ người trong platform.operators xem và quyết định được; người khác => NOT_OPERATOR;
 *  - từ chối bắt buộc có lý do; duyệt / từ chối chỉ áp dụng cho tổ chức 'provisioning' (lần hai => NOT_PENDING);
 *  - tổ chức sau khi duyệt không còn trong danh sách chờ; lý do và người duyệt được ghi.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { psqlPool } from './psql-pool';
import { SignupService, type SignupOtpSender } from '../../services/api/src/signup/signup.service';
import { PlatformReviewService, ReviewError } from '../../services/api/src/platform/review.service';
import { IdpError, type IdentityProviderAdmin } from '../../services/api/src/iam/keycloak-admin';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_review_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;
const KEY = Buffer.from('it-review-key-0123456789abcdef');
const OPERATOR = 'e44fdf60-5fc3-46da-a0b7-1baef4942de0';
const OTHER = '00000000-0000-4000-8000-00000000dead';

const su = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();

class Sender implements SignupOtpSender {
  readonly vendor = 'test-vendor';
  async send(): Promise<boolean> { return true; }
}

class FakeIdp {
  private n = 0;
  async createSelfUser(i: { username: string }): Promise<string> {
    if (i.username.startsWith('dup')) throw new IdpError('IDP_CONFLICT', 'dup');
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }
  async setEnabled(): Promise<void> { /* không dùng trong test này */ }
}
const idp = new FakeIdp() as unknown as IdentityProviderAdmin;

const base = { orgName: 'Phòng khám Duyệt', contactName: 'Lê Thị Duyệt', phone: '0908697966', license: 'GPKD-REV-0001', slug: 'x' };

/** Tạo một tổ chức chờ duyệt qua đúng luồng đăng ký (start -> verify -> complete). */
async function pendingTenant(slug: string, email: string): Promise<string> {
  const svc = new SignupService({
    pool: psqlPool({ database: DB }), sender: new Sender(), otpKey: KEY, idp, randomCode: () => '987654',
  });
  const { signupId } = await svc.start({ ...base, slug, email }, null);
  await svc.verify(signupId, '987654');
  const out = await svc.complete(signupId, 'mat-khau-dai-12');
  return out.tenantId;
}

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'NO_ERROR';
  } catch (e) {
    return e instanceof ReviewError ? e.code : `OTHER:${String(e)}`;
  }
};

run('Màn duyệt tổ chức / PostgreSQL (migration 030)', () => {
  let svc: PlatformReviewService;
  let t1: string;
  let t2: string;
  let t3: string;

  beforeAll(async () => {
    execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    }
    su(`INSERT INTO platform.operators (external_subject, granted_by) VALUES ('${OPERATOR}', 'test')`);
    su(`INSERT INTO platform.signup_vendors (vendor, category, cleared_by, review_due) VALUES ('test-vendor', 'signup_otp_email', 'test', now() + interval '180 days')`);
    svc = new PlatformReviewService({ pool: psqlPool({ database: DB }) });
    t1 = await pendingTenant('rv-mot', 'mot@pk.vn');
    t2 = await pendingTenant('rv-hai', 'hai@pk.vn');
    t3 = await pendingTenant('rv-ba', 'ba@pk.vn');
  });
  afterAll(() => {
    try {
      execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`]);
    } catch {
      /* dọn dẹp best-effort */
    }
  });

  it('người không phải người vận hành => NOT_OPERATOR khi xem và khi quyết định', async () => {
    expect(await errCode(svc.listPending(OTHER))).toBe('NOT_OPERATOR');
    expect(await errCode(svc.decide(OTHER, t1, 'approve', null))).toBe('NOT_OPERATOR');
    expect(su(`SELECT status FROM iam.tenants WHERE tenant_id = '${t1}'`)).toBe('provisioning');
  });

  it('danh sách chờ có tên, slug, giấy phép, điện thoại và người quản trị tạm thời', async () => {
    const list = await svc.listPending(OPERATOR);
    const row = list.find((x) => x.tenantId === t1);
    expect(row).toMatchObject({
      name: 'Phòng khám Duyệt', slug: 'rv-mot', businessLicenseNo: 'GPKD-REV-0001', contactPhone: '0908697966',
      adminName: 'Lê Thị Duyệt', adminEmail: 'mot@pk.vn',
    });
  });

  it('từ chối không có lý do => NOTE_REQUIRED; quyết định sai => INVALID_DECISION; id sai => INVALID_INPUT', async () => {
    expect(await errCode(svc.decide(OPERATOR, t1, 'reject', ''))).toBe('NOTE_REQUIRED');
    expect(await errCode(svc.decide(OPERATOR, t1, 'xoa', null))).toBe('INVALID_DECISION');
    expect(await errCode(svc.decide(OPERATOR, 'khong-uuid', 'approve', null))).toBe('INVALID_INPUT');
  });

  it('từ chối có lý do => OK, trạng thái closed, lý do và người duyệt được ghi; lần hai => NOT_PENDING', async () => {
    expect(await svc.decide(OPERATOR, t1, 'reject', 'Giấy phép không khớp tên tổ chức')).toBe('OK');
    expect(su(`SELECT status || '|' || review_note || '|' || reviewed_by FROM iam.tenants WHERE tenant_id = '${t1}'`))
      .toBe(`closed|Giấy phép không khớp tên tổ chức|${OPERATOR}`);
    expect(await svc.decide(OPERATOR, t1, 'approve', null)).toBe('NOT_PENDING');
    expect((await svc.listPending(OPERATOR)).some((x) => x.tenantId === t1)).toBe(false);
  });

  it('duyệt => OK, trạng thái active, không còn trong danh sách chờ', async () => {
    expect(await svc.decide(OPERATOR, t2, 'approve', null)).toBe('OK');
    expect(su(`SELECT status || '|' || reviewed_by FROM iam.tenants WHERE tenant_id = '${t2}'`)).toBe(`active|${OPERATOR}`);
    expect((await svc.listPending(OPERATOR)).some((x) => x.tenantId === t2)).toBe(false);
  });

  it('tổ chức còn lại vẫn chờ duyệt', async () => {
    expect((await svc.listPending(OPERATOR)).map((x) => x.tenantId)).toEqual([t3]);
  });
});
