/**
 * HCOS-F21 | Quản trị nhân sự & cơ sở trên PostgreSQL thật (IdP giả):
 *  - phạm vi: quản lý cơ sở chỉ thấy / quản lý cơ sở mình; tenant_admin mọi nơi; người không có quyền => FORBIDDEN;
 *  - tạo tài khoản: Keycloak trước (mật khẩu tạm trả 1 lần, không vào audit), rồi user + membership; trùng => CONFLICT;
 *    liên kết tài khoản Keycloak có sẵn chỉ khi yêu cầu rõ; lỗi DB => tắt tài khoản Keycloak vừa tạo;
 *  - trần vai trò: quản lý cơ sở không cấp vai trò quản trị, không đụng tài khoản quản trị / làm ở cơ sở khác; không tự sửa mình;
 *  - thu hồi là cuối cùng (trigger), cấp lại = membership mới; khoá => tắt + đăng xuất ở IdP, API từ chối (USER_NOT_PROVISIONED);
 *  - IdP lỗi => không đổi DB; tạo cơ sở + sao chép cấu hình (không chép tài khoản ngân hàng), ngừng cơ sở cuối cùng bị chặn.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext } from '../../packages/domain/src/s0-contracts';
import { PgOrgScopeLookup } from '../../packages/security/src/pg-org-scope';
import { IdpError, temporaryPassword, type IdentityProviderAdmin, type IdpUser } from '../../services/api/src/iam/keycloak-admin';
import { StaffAdminService } from '../../services/api/src/iam/staff-admin.service';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_staff_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const [O1, O2] = [asOrganizationId(uid(11)), asOrganizationId(uid(12))];
const U = { tadmin: uid(101), cadmin: uid(102), cadmin2: uid(103), doc: uid(104), staff1: uid(105), pharm: uid(106) };
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const ctx = (sub: string, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({ tenantId: TA, userSubject: sub, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null, allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-staff' as CorrelationId });
const C = { tadmin: ctx('kc-tadmin', [O1, O2]), cadmin: ctx('kc-cadmin', [O1]), cadmin2: ctx('kc-cadmin2', [O2]), doc: ctx('kc-doc', [O1, O2]) };
const outcome = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? String(e)));
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

class FakeIdp implements IdentityProviderAdmin {
  users = new Map<string, Omit<IdpUser, 'enabled'> & { enabled: boolean; password?: string; otp: boolean; sessions: number }>();
  calls: string[] = [];
  fail: IdpError | null = null;
  private n = 900;
  private guard() { if (this.fail) throw this.fail; }
  async findByUsername(u: string) { this.guard(); return [...this.users.values()].find((x) => x.username === u) ?? null; }
  async getUser(id: string) { this.guard(); return this.users.get(id) ?? null; }
  async createUser(i: { username: string; firstName: string; lastName: string; email: string | null; temporaryPassword: string }) {
    this.guard();
    if ([...this.users.values()].some((x) => x.username === i.username)) throw new IdpError('IDP_CONFLICT', 'dup');
    const id = uid(++this.n);
    this.users.set(id, { id, username: i.username, enabled: true, firstName: i.firstName, lastName: i.lastName, password: i.temporaryPassword, otp: false, sessions: 0, requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'] });
    this.calls.push(`create:${i.username}`);
    return id;
  }
  async setEnabled(id: string, e: boolean) { this.guard(); this.users.get(id)!.enabled = e; this.calls.push(`enabled:${id}:${e}`); }
  async logout(id: string) { this.guard(); this.users.get(id)!.sessions = 0; this.calls.push(`logout:${id}`); }
  async resetCredentials(id: string, p: string) { this.guard(); const u = this.users.get(id)!; u.password = p; u.otp = false; this.calls.push(`reset:${id}`); }
}

run('Quản trị nhân sự & cơ sở / PostgreSQL', () => {
  let svc: StaffAdminService;
  const idp = new FakeIdp();
  let invalidations = 0;
  let scope: PgOrgScopeLookup;

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${O1}','${TA}','clinic','c1','PK 1'),('${O2}','${TA}','clinic','c2','PK 2');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name,username) VALUES
        ('${U.tadmin}','${TA}','kc-tadmin','Quản trị','qtv'),('${U.cadmin}','${TA}','kc-cadmin','Quản lý 1','ql1'),('${U.cadmin2}','${TA}','kc-cadmin2','Quản lý 2','ql2'),
        ('${U.doc}','${TA}','kc-doc','BS Hai nơi','bs2noi'),('${U.staff1}','${TA}','kc-staff1','Lễ tân 1','lt1'),('${U.pharm}','${TA}','kc-pharm','DS 1','ds1');
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.tadmin}','${O1}','tenant_admin'),('${TA}','${U.cadmin}','${O1}','clinic_admin'),('${TA}','${U.cadmin2}','${O2}','clinic_admin'),
        ('${TA}','${U.doc}','${O1}','doctor'),('${TA}','${U.doc}','${O2}','doctor'),('${TA}','${U.staff1}','${O1}','clinic_staff'),('${TA}','${U.pharm}','${O1}','pharmacist');
      INSERT INTO clinical.service_points(tenant_id,organization_id,code,name,booking_capacity) VALUES ('${TA}','${O1}','N1','Nội 1',10),('${TA}','${O1}','N2','Nội 2',8);
      INSERT INTO finance.price_items(item_id,tenant_id,organization_id,code,name,category,unit_price) VALUES
        ('${uid(501)}','${TA}','${O1}','KB','Khám bệnh','exam',150000),('${uid(502)}','${TA}','${O1}','XN-CTM','Công thức máu','lab',90000);
      INSERT INTO finance.settings(tenant_id,organization_id,deposit_default,bank_bin,bank_account,bank_account_name) VALUES ('${TA}','${O1}',500000,'970436','0123456789','PK DEMO');
      INSERT INTO pharmacy.medications(medication_id,tenant_id,brand_name,strength,form,unit_of_measure,item_kind) VALUES ('${uid(601)}','${TA}','Ống nghiệm EDTA','2 ml','ống','cái','supply');
      INSERT INTO equipment.supply_norms(tenant_id,organization_id,item_id,medication_id,quantity,updated_by) VALUES ('${TA}','${O1}','${uid(502)}','${uid(601)}',1,'${U.tadmin}');
      INSERT INTO patient.mrn_settings(tenant_id,organization_id,prefix) VALUES ('${TA}','${O1}','BN');
    `);
    for (const [id, sub, name] of [[U.tadmin, 'kc-tadmin', 'qtv'], [U.cadmin, 'kc-cadmin', 'ql1'], [U.staff1, 'kc-staff1', 'lt1'], [U.doc, 'kc-doc', 'bs2noi'], [U.pharm, 'kc-pharm', 'ds1']] as const) {
      void id;
      idp.users.set(sub, { id: sub, username: name, enabled: true, otp: true, sessions: 2 });
    }
    idp.users.set(uid(800), { id: uid(800), username: 'nv.cu', enabled: true, otp: true, sessions: 0 });
    const pool = psqlPool({ database: DB });
    scope = new PgOrgScopeLookup(pool, { ttlMs: 60_000 });
    svc = new StaffAdminService({ pool, audit: { record: async () => {} }, idp, onAccessChanged: (t) => { invalidations++; scope.invalidate(asTenantId(t)); } });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('mật khẩu tạm: 4 nhóm × 4 ký tự dễ đọc', () => {
    const p = temporaryPassword((n) => new Uint8Array(n).map((_, i) => (i * 37) % 256));
    expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{4}(-[a-km-zA-HJ-NP-Z2-9]{4}){3}$/);
  });

  it('phạm vi xem: quản lý cơ sở chỉ thấy cơ sở mình; tenant_admin thấy hết; bác sĩ bị từ chối', async () => {
    const a = await svc.listStaff({}, C.cadmin);
    expect(a.tenantAdmin).toBe(false);
    expect(a.grantableRoles).toEqual(['doctor', 'clinic_staff', 'cashier', 'pharmacist', 'pharmacy_admin']);
    expect(a.staff.map((s) => s.username).sort()).toEqual(['bs2noi', 'ds1', 'lt1', 'ql1', 'qtv']);
    const doc = a.staff.find((s) => s.username === 'bs2noi')!;
    expect(doc.memberships.map((m) => (m as { organizationName: string }).organizationName)).toEqual(['PK 1']); // chỉ thấy membership ở cơ sở mình
    expect(doc.manageable).toBe(true); // giao diện; thao tác khoá vẫn bị chặn vì làm ở PK 2 (xem dưới)
    expect(a.staff.find((s) => s.username === 'qtv')!.manageable).toBe(false);
    expect(a.staff.find((s) => s.username === 'ql1')!.self).toBe(true);
    expect((await svc.listStaff({}, C.tadmin)).staff).toHaveLength(6);
    expect(await outcome(svc.listStaff({ organizationId: O2 }, C.cadmin))).toBe('FORBIDDEN:ORG_SCOPE');
    expect(await outcome(svc.listStaff({}, C.doc))).toBe('FORBIDDEN');
  });

  it('tạo tài khoản: Keycloak + user + membership; mật khẩu tạm 1 lần; trần vai trò; trùng; liên kết tài khoản có sẵn', async () => {
    const base = { displayName: 'Trần Văn Mới', username: 'tv.moi', email: 'tv.moi@example.invalid', organizationId: O1, roles: ['doctor'] };
    expect(await outcome(svc.createStaff({ ...base, roles: ['clinic_admin'] }, C.cadmin))).toBe('FORBIDDEN:ROLE_CEILING');
    expect(await outcome(svc.createStaff({ ...base, organizationId: O2 }, C.cadmin))).toBe('FORBIDDEN:ORG_SCOPE');
    expect(await outcome(svc.createStaff({ ...base, roles: ['system'] }, C.tadmin))).toBe('VALIDATION:ROLE_INVALID');
    expect(await outcome(svc.createStaff({ ...base, username: 'Có Dấu' }, C.cadmin))).toBe('VALIDATION:USERNAME_INVALID');
    expect(idp.calls).toEqual([]); // chưa đụng tới Keycloak khi kiểm tra thất bại
    const r = await svc.createStaff(base, C.cadmin);
    expect(r.temporaryPassword).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/);
    expect(r.linkedExisting).toBe(false);
    expect(idp.calls).toEqual(['create:tv.moi']);
    const kc = [...idp.users.values()].find((u) => u.username === 'tv.moi')!;
    expect(kc.requiredActions).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
    expect(su(`SELECT u.external_subject || '|' || u.username || '|' || m.role || '|' || g.username FROM iam.users u JOIN iam.memberships m USING (user_id) JOIN iam.users g ON g.user_id = m.granted_by WHERE u.user_id = '${r.userId}'`))
      .toBe(`${kc.id}|tv.moi|doctor|ql1`);
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE payload::text LIKE '%${r.temporaryPassword}%'`)).toBe('0');
    expect(await outcome(svc.createStaff(base, C.cadmin))).toBe('CONFLICT:USER_EXISTS');
    // Tài khoản Keycloak có sẵn: phải yêu cầu liên kết rõ ràng; liên kết => không có mật khẩu tạm.
    const old = { displayName: 'Nhân viên cũ', username: 'nv.cu', organizationId: O1, roles: ['clinic_staff'] };
    expect(await outcome(svc.createStaff(old, C.cadmin))).toBe('CONFLICT:IDP_USER_EXISTS');
    const l = await svc.createStaff({ ...old, linkExisting: true }, C.cadmin);
    expect([l.linkedExisting, l.temporaryPassword]).toEqual([true, null]);
    expect(invalidations).toBeGreaterThanOrEqual(2);
  });

  it('lỗi DB sau khi đã tạo trên Keycloak => tắt tài khoản Keycloak vừa tạo', async () => {
    su(`CREATE FUNCTION pg_temp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.username = 'loi.db' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER it_fail BEFORE INSERT ON iam.users FOR EACH ROW EXECUTE FUNCTION pg_temp_fail();`);
    try {
      expect(await outcome(svc.createStaff({ displayName: 'Lỗi DB', username: 'loi.db', organizationId: O1, roles: ['cashier'] }, C.cadmin))).not.toBe('OK');
      expect([...idp.users.values()].find((u) => u.username === 'loi.db')!.enabled).toBe(false);
    } finally {
      su(`DROP TRIGGER it_fail ON iam.users; DROP FUNCTION pg_temp_fail();`);
    }
  });

  it('cấp / thu hồi: trần vai trò, không tự sửa mình, thu hồi là cuối cùng, cấp lại = membership mới', async () => {
    expect(await outcome(svc.grantRole(U.staff1, { organizationId: O1, role: 'cashier' }, C.cadmin))).toBe('OK');
    expect(await outcome(svc.grantRole(U.staff1, { organizationId: O1, role: 'cashier' }, C.cadmin))).toBe('CONFLICT:ROLE_EXISTS');
    expect(await outcome(svc.grantRole(U.cadmin2, { organizationId: O1, role: 'doctor' }, C.cadmin))).toBe('FORBIDDEN:ROLE_CEILING');
    expect(await outcome(svc.grantRole(U.cadmin, { organizationId: O1, role: 'doctor' }, C.cadmin))).toBe('FORBIDDEN:SELF_CHANGE');
    expect(await outcome(svc.grantRole(U.staff1, { organizationId: O1, role: 'executive' }, C.cadmin))).toBe('FORBIDDEN:ROLE_CEILING');
    // Bác sĩ làm ở 2 cơ sở: quản lý PK 1 vẫn thêm được vai trò TẠI PK 1.
    expect(await outcome(svc.grantRole(U.doc, { organizationId: O1, role: 'cashier' }, C.cadmin))).toBe('OK');
    const mid = su(`SELECT membership_id FROM iam.memberships WHERE user_id = '${U.staff1}' AND role = 'cashier'`);
    expect(await outcome(svc.revokeMembership(mid, { reason: 'x' }, C.cadmin))).toBe('VALIDATION');
    await svc.revokeMembership(mid, { reason: 'Chuyển bộ phận' }, C.cadmin);
    expect(su(`SELECT status || '|' || (revoked_at IS NOT NULL)::text || '|' || (valid_to <= now())::text || '|' || revoke_reason FROM iam.memberships WHERE membership_id = '${mid}'`))
      .toBe('revoked|true|true|Chuyển bộ phận');
    expect(await outcome(svc.revokeMembership(mid, { reason: 'Lần hai' }, C.cadmin))).toBe('CONFLICT:ALREADY_REVOKED');
    expect(() => su(`UPDATE iam.memberships SET status = 'active' WHERE membership_id = '${mid}'`)).toThrow();
    expect(() => su(`UPDATE iam.memberships SET role = 'tenant_admin' WHERE user_id = '${U.staff1}' AND status = 'active'`)).toThrow();
    expect(await outcome(svc.grantRole(U.staff1, { organizationId: O1, role: 'cashier' }, C.cadmin))).toBe('OK'); // cấp lại = dòng mới
    expect(su(`SELECT count(*) FROM iam.memberships WHERE user_id = '${U.staff1}' AND role = 'cashier'`)).toBe('2');
    const tadm = su(`SELECT membership_id FROM iam.memberships WHERE user_id = '${U.tadmin}'`);
    expect(await outcome(svc.revokeMembership(tadm, { reason: 'Thử' }, C.cadmin))).toBe('FORBIDDEN:ROLE_CEILING');
    expect(await outcome(svc.revokeMembership(tadm, { reason: 'Thử' }, C.tadmin))).toBe('FORBIDDEN:SELF_CHANGE');
  });

  it('khoá / mở khoá / đặt lại: IdP trước, đăng xuất, API từ chối ngay; phạm vi; IdP lỗi => DB giữ nguyên', async () => {
    expect((await scope.scopeFor(TA, 'kc-staff1'))?.organizationIds).toEqual([O1]);
    expect(await outcome(svc.setStatus(U.doc, { status: 'locked', reason: 'Nghỉ việc' }, C.cadmin))).toBe('FORBIDDEN:ORG_SCOPE'); // còn làm ở PK 2
    expect(await outcome(svc.setStatus(U.cadmin, { status: 'locked', reason: 'Tự khoá' }, C.cadmin))).toBe('FORBIDDEN:SELF_CHANGE');
    idp.fail = new IdpError('IDP_UNAVAILABLE', 'down');
    expect(await outcome(svc.setStatus(U.staff1, { status: 'locked', reason: 'Nghỉ việc' }, C.cadmin))).toBe('INVALID_STATE:IDP_UNAVAILABLE');
    expect(su(`SELECT status FROM iam.users WHERE user_id = '${U.staff1}'`)).toBe('active');
    idp.fail = null;
    await svc.setStatus(U.staff1, { status: 'locked', reason: 'Nghỉ việc' }, C.cadmin);
    expect([idp.users.get('kc-staff1')!.enabled, idp.users.get('kc-staff1')!.sessions]).toEqual([false, 0]);
    expect(su(`SELECT status FROM iam.users WHERE user_id = '${U.staff1}'`)).toBe('locked');
    expect(await scope.scopeFor(TA, 'kc-staff1')).toBeNull(); // cache đã xoá => từ chối ngay
    expect(await outcome(svc.resetCredentials(U.staff1, { reason: 'Quên mật khẩu' }, C.cadmin))).toBe('CONFLICT:USER_NOT_ACTIVE');
    await svc.setStatus(U.staff1, { status: 'active', reason: 'Đi làm lại' }, C.cadmin);
    expect(idp.users.get('kc-staff1')!.enabled).toBe(true);
    const r = await svc.resetCredentials(U.staff1, { reason: 'Mất điện thoại' }, C.cadmin);
    expect(r.temporaryPassword).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/);
    expect([idp.users.get('kc-staff1')!.otp, idp.users.get('kc-staff1')!.password]).toEqual([false, r.temporaryPassword]);
    expect(await outcome(svc.resetCredentials(U.tadmin, { reason: 'Thử' }, C.cadmin))).toBe('FORBIDDEN:ROLE_CEILING');
  });

  it('cơ sở: chỉ tenant_admin tạo; sao chép cấu hình (không chép tài khoản ngân hàng); mã trùng; ngừng cơ sở cuối cùng bị chặn', async () => {
    expect((await svc.listOrganizations(C.cadmin)).canManage).toBe(false);
    const input = {
      code: 'c3', name: 'PK 3', mrnPrefix: 'PK', copyFrom: O1,
      copy: { servicePoints: true, priceList: true, financeSettings: true, supplyNorms: true, mrnSettings: true, decisionRules: true },
    };
    expect(await outcome(svc.createOrganization(input, C.cadmin))).toBe('FORBIDDEN');
    const o = await svc.createOrganization(input, C.tadmin);
    expect(o.copied).toMatchObject({ servicePoints: 2, priceList: 2, financeSettings: 1, supplyNorms: 1, mrnSettings: 1, decisionRules: 0 });
    expect(su(`SELECT deposit_default || '|' || COALESCE(bank_account, '-') FROM finance.settings WHERE organization_id = '${o.organizationId}'`)).toBe('500000|-');
    expect(su(`SELECT prefix FROM patient.mrn_settings WHERE organization_id = '${o.organizationId}'`)).toBe('PK');
    expect(su(`SELECT p.code FROM equipment.supply_norms n JOIN finance.price_items p ON p.item_id = n.item_id WHERE n.organization_id = '${o.organizationId}'`)).toBe('XN-CTM');
    expect(await outcome(svc.createOrganization({ code: 'c3', name: 'Trùng' }, C.tadmin))).toBe('CONFLICT:ORG_CODE_EXISTS');
    const list = await svc.listOrganizations(C.tadmin);
    expect(list.organizations.find((x) => x.code === 'c3')).toMatchObject({ rooms: 2, prices: 2, staff: 0, status: 'active' });
    // tenant_admin thấy cơ sở mới ngay (cache đã xoá).
    expect((await scope.scopeFor(TA, 'kc-tadmin'))?.organizationIds).toContain(o.organizationId);
    await svc.setOrganizationStatus(o.organizationId, { status: 'inactive', reason: 'Tạm dừng' }, C.tadmin);
    await svc.setOrganizationStatus(O2, { status: 'inactive', reason: 'Tạm dừng' }, C.tadmin);
    expect(await outcome(svc.setOrganizationStatus(O1, { status: 'inactive', reason: 'Tạm dừng' }, C.tadmin))).toBe('CONFLICT:LAST_ORGANIZATION');
    expect(await outcome(svc.grantRole(U.staff1, { organizationId: o.organizationId, role: 'doctor' }, C.tadmin))).toBe('CONFLICT:ORG_INACTIVE');
  });
});
