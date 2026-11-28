/**
 * Giấy phép khám chữa bệnh trên PostgreSQL thật (migration 031):
 *  - tổ chức chưa được duyệt đăng ký => TENANT_NOT_ACTIVE;
 *  - người không phải tenant_admin không nộp và không xem được => NOT_TENANT_ADMIN;
 *  - nộp => pending; từ chối => rejected (cần lý do) và nộp lại được; duyệt => approved, không đổi số nữa;
 *  - người không phải vận hành => NOT_OPERATOR; quyết định lần hai => NOT_PENDING.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { psqlPool } from './psql-pool';
import { SignupService, type SignupOtpSender } from '../../services/api/src/signup/signup.service';
import { PlatformReviewService } from '../../services/api/src/platform/review.service';
import { LicenseError, MedicalLicenseService } from '../../services/api/src/platform/medical-license.service';
import { type IdentityProviderAdmin } from '../../services/api/src/iam/keycloak-admin';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_license_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;
const KEY = Buffer.from('it-license-key-0123456789abcdef');
const OPERATOR = 'e44fdf60-5fc3-46da-a0b7-1baef4942de0';
const OTHER = '00000000-0000-4000-8000-00000000dead';
const LICENSE = 'KCB-0001-2026';

const su = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();

class Sender implements SignupOtpSender {
  readonly vendor = 'test-vendor';
  async send(): Promise<boolean> { return true; }
}

class FakeIdp {
  private n = 0;
  async createSelfUser(): Promise<string> {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }
  async setEnabled(): Promise<void> { /* không dùng */ }
}
const idp = new FakeIdp() as unknown as IdentityProviderAdmin;

const base = { orgName: 'Phòng khám Giấy Phép', contactName: 'Trần Văn Phép', phone: '0908697966', license: 'GPKD-LIC-0001', slug: 'x' };

async function registeredTenant(slug: string, email: string): Promise<{ tenantId: string; adminSub: string }> {
  const svc = new SignupService({
    pool: psqlPool({ database: DB }), sender: new Sender(), otpKey: KEY, idp, randomCode: () => '987654',
  });
  const { signupId } = await svc.start({ ...base, slug, email }, null);
  await svc.verify(signupId, '987654');
  const out = await svc.complete(signupId, 'mat-khau-dai-12');
  const adminSub = su(`SELECT external_subject FROM iam.users WHERE tenant_id = '${out.tenantId}'`);
  return { tenantId: out.tenantId, adminSub };
}

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'NO_ERROR';
  } catch (e) {
    return e instanceof LicenseError ? e.code : `OTHER:${String(e)}`;
  }
};

run('Giấy phép khám chữa bệnh / PostgreSQL (migration 031)', () => {
  let lic: MedicalLicenseService;
  let review: PlatformReviewService;
  let t1: string;
  let adminSub1: string;
  let t2: string;

  beforeAll(async () => {
    execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    }
    su(`INSERT INTO platform.operators (external_subject, granted_by) VALUES ('${OPERATOR}', 'test')`);
    su(`INSERT INTO platform.signup_vendors (vendor, category, cleared_by, review_due) VALUES ('test-vendor', 'signup_otp_email', 'test', now() + interval '180 days')`);
    lic = new MedicalLicenseService({ pool: psqlPool({ database: DB }) });
    review = new PlatformReviewService({ pool: psqlPool({ database: DB }) });
    const a = await registeredTenant('gp-mot', 'mot@gp.vn');
    t1 = a.tenantId;
    adminSub1 = a.adminSub;
    t2 = (await registeredTenant('gp-hai', 'hai@gp.vn')).tenantId;
  });
  afterAll(() => {
    try {
      execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`]);
    } catch {
      /* dọn dẹp best-effort */
    }
  });

  it('tổ chức chưa được duyệt đăng ký thì không nộp được giấy phép', async () => {
    expect(await errCode(lic.submit(adminSub1, t1, LICENSE))).toBe('TENANT_NOT_ACTIVE');
    expect(su(`SELECT medical_license_status FROM iam.tenants WHERE tenant_id = '${t1}'`)).toBe('none');
  });

  it('người không phải tenant_admin không nộp và không xem được', async () => {
    expect(await errCode(lic.submit(OTHER, t1, LICENSE))).toBe('NOT_TENANT_ADMIN');
    expect(await errCode(lic.getState(OTHER, t1))).toBe('NOT_TENANT_ADMIN');
  });

  it('số giấy phép ngắn hoặc tenant sai định dạng bị từ chối trước khi ghi DB', async () => {
    expect(await errCode(lic.submit(adminSub1, t1, 'AB'))).toBe('INVALID_LICENSE_NO');
    expect(await errCode(lic.submit(adminSub1, 'khong-uuid', LICENSE))).toBe('INVALID_INPUT');
  });

  it('sau khi duyệt đăng ký, tenant_admin nộp số giấy phép => pending; danh sách chờ có tổ chức này', async () => {
    expect(await review.decide(OPERATOR, t1, 'approve', null)).toBe('OK');
    expect(await lic.submit(adminSub1, t1, `  ${LICENSE}  `)).toBe('OK');
    expect(su(`SELECT medical_license_status || '|' || medical_license_no FROM iam.tenants WHERE tenant_id = '${t1}'`)).toBe(`pending|${LICENSE}`);
    const pending = await lic.listPending(OPERATOR);
    expect(pending.some((x) => x.tenantId === t1 && x.medicalLicenseNo === LICENSE)).toBe(true);
  });

  it('người không phải vận hành không xem và không quyết định được', async () => {
    expect(await errCode(lic.listPending(OTHER))).toBe('NOT_OPERATOR');
    expect(await errCode(lic.decide(OTHER, t1, 'approve', null))).toBe('NOT_OPERATOR');
    expect(su(`SELECT medical_license_status FROM iam.tenants WHERE tenant_id = '${t1}'`)).toBe('pending');
  });

  it('từ chối không có lý do => NOTE_REQUIRED; từ chối có lý do => rejected, tenant nộp lại được và lý do được xoá', async () => {
    expect(await errCode(lic.decide(OPERATOR, t1, 'reject', ''))).toBe('NOTE_REQUIRED');
    expect(await lic.decide(OPERATOR, t1, 'reject', 'Số giấy phép không khớp hồ sơ')).toBe('OK');
    const state = await lic.getState(adminSub1, t1);
    expect(state).toMatchObject({ status: 'rejected', note: 'Số giấy phép không khớp hồ sơ' });
    expect(await lic.submit(adminSub1, t1, 'KCB-0002-2026')).toBe('OK');
    expect(su(`SELECT medical_license_status || '|' || coalesce(medical_license_note, '-') || '|' || coalesce(medical_license_reviewed_by, '-') FROM iam.tenants WHERE tenant_id = '${t1}'`))
      .toBe('pending|-|-');
  });

  it('duyệt giấy phép => approved, người vận hành được ghi nhận; không đổi số nữa; quyết định lần hai => NOT_PENDING', async () => {
    expect(await lic.decide(OPERATOR, t1, 'approve', null)).toBe('OK');
    expect(su(`SELECT medical_license_status || '|' || medical_license_reviewed_by FROM iam.tenants WHERE tenant_id = '${t1}'`)).toBe(`approved|${OPERATOR}`);
    expect(await errCode(lic.submit(adminSub1, t1, 'KCB-9999-2026'))).toBe('ALREADY_APPROVED');
    expect(await lic.decide(OPERATOR, t1, 'approve', null)).toBe('NOT_PENDING');
    expect((await lic.listPending(OPERATOR)).some((x) => x.tenantId === t1)).toBe(false);
  });

  it('tổ chức thứ hai chỉ có số giấy phép sau khi nộp và vẫn chờ duyệt', async () => {
    expect(await review.decide(OPERATOR, t2, 'approve', null)).toBe('OK');
    const sub2 = su(`SELECT external_subject FROM iam.users WHERE tenant_id = '${t2}'`);
    expect(await lic.submit(sub2, t2, LICENSE)).toBe('OK');
    expect((await lic.listPending(OPERATOR)).map((x) => x.tenantId)).toEqual([t2]);
  });
});
