/**
 * Tenant / cơ sở THEO TỪNG TÀI KHOẢN + bắt buộc MFA ở API (PostgreSQL thật, role ứng dụng):
 *  - token không có tenant_id => tenant tra theo sub; sub ở 2 tenant => từ chối;
 *  - cơ sở được phép = membership còn hiệu lực trong DB (bỏ membership hết hạn / bị thu hồi / cơ sở ngừng);
 *    claim org_ids chỉ THU HẸP, không mở rộng; tenant_admin => mọi cơ sở đang hoạt động;
 *  - user bị khoá / không có membership => USER_NOT_PROVISIONED; claim tenant khác tenant của tài khoản => từ chối;
 *  - requireAmr: thiếu otp => AUTH_MFA_REQUIRED (401);
 *  - cache 30 giây: thu hồi có hiệu lực sau TTL.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgOrgScopeLookup } from '../../packages/security/src/pg-org-scope';
import { buildTenantContext, type TenantContextOptions } from '../../packages/security/src/tenant-context';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_orgscope_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [TA, TB] = [uid(1), uid(2)];
const [O1, O2, O3, OB] = [uid(11), uid(12), uid(13), uid(21)];
const U = { doc: uid(101), admin: uid(102), locked: uid(103), none: uid(104), twoA: uid(105), twoB: uid(106), staff: uid(107) };
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;
const ISS = 'https://idp.test/realms/hcos';
const AUD = 'hcos-api';

run('Phạm vi theo tài khoản + MFA / PostgreSQL', () => {
  let priv: KeyLike;
  let pub: KeyLike;
  let now = Date.now();
  let scope: PgOrgScopeLookup;
  const token = (sub: string, extra: Record<string, unknown> = {}) =>
    new SignJWT({ amr: ['pwd', 'otp'], ...extra }).setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(priv);
  const opts = (o: Partial<TenantContextOptions> = {}): TenantContextOptions => ({ issuer: ISS, audience: AUD, key: pub, algorithms: ['RS256'], orgScope: scope, requireAmr: ['otp', 'hwk'], ...o });
  const ctxOf = async (t: string, o?: Partial<TenantContextOptions>) => buildTenantContext({ headers: { authorization: `Bearer ${t}` } }, opts(o));
  const err = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string; httpStatus?: number }) => `${e.httpStatus}:${e.code}`);

  beforeAll(async () => {
    ({ privateKey: priv, publicKey: pub } = await generateKeyPair('RS256'));
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name,status) VALUES
        ('${O1}','${TA}','clinic','c1','PK 1','active'),('${O2}','${TA}','clinic','c2','PK 2','active'),('${O3}','${TA}','clinic','c3','PK 3 (ngừng)','inactive'),
        ('${OB}','${TB}','clinic','b1','PK B','active');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name,status) VALUES
        ('${U.doc}','${TA}','kc-doc','BS','active'),('${U.admin}','${TA}','kc-admin','QT','active'),('${U.locked}','${TA}','kc-locked','Khoá','locked'),
        ('${U.none}','${TA}','kc-none','Không quyền','active'),('${U.twoA}','${TA}','kc-two','Hai A','active'),('${U.twoB}','${TB}','kc-two','Hai B','active'),
        ('${U.staff}','${TA}','kc-staff','LT','active');
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role,status,valid_from,valid_to) VALUES
        ('${TA}','${U.doc}','${O1}','doctor','active',now() - interval '1 day',NULL),
        ('${TA}','${U.doc}','${O2}','doctor','active',now() - interval '1 day',NULL),
        ('${TA}','${U.doc}','${O3}','doctor','active',now() - interval '1 day',NULL),
        ('${TA}','${U.admin}','${O1}','tenant_admin','active',now() - interval '1 day',NULL),
        ('${TA}','${U.locked}','${O1}','doctor','active',now() - interval '1 day',NULL),
        ('${TA}','${U.none}','${O1}','doctor','revoked',now() - interval '1 day',NULL),
        ('${TA}','${U.none}','${O2}','doctor','active',now() - interval '10 days',now() - interval '1 day'),
        ('${TA}','${U.twoA}','${O1}','doctor','active',now() - interval '1 day',NULL),
        ('${TB}','${U.twoB}','${OB}','doctor','active',now() - interval '1 day',NULL),
        ('${TA}','${U.staff}','${O2}','clinic_staff','active',now() - interval '1 day',NULL);
    `);
    scope = new PgOrgScopeLookup(psqlPool({ database: DB }), { clock: () => now });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('tenant + cơ sở theo tài khoản; bỏ cơ sở ngừng hoạt động; claim chỉ thu hẹp', async () => {
    const c = await ctxOf(await token('kc-doc'));
    expect([c.tenantId, c.userId, [...c.allowedOrganizationIds].sort(), c.activeOrganizationId]).toEqual([TA, U.doc, [O1, O2], null]);
    // Chỉ một cơ sở => tự chọn làm cơ sở đang hoạt động.
    expect((await ctxOf(await token('kc-staff'))).activeOrganizationId).toBe(O2);
    // org_ids trong token THU HẸP; ngoài membership => từ chối; không mở rộng sang cơ sở không có membership.
    expect((await ctxOf(await token('kc-doc', { org_ids: [O1] }))).allowedOrganizationIds).toEqual([O1]);
    expect(await err(ctxOf(await token('kc-staff', { org_ids: [O1] })))).toBe('403:ORG_NOT_ALLOWED');
    expect((await ctxOf(await token('kc-doc', { org_id: O2, org_ids: [O1, O2] }))).activeOrganizationId).toBe(O2);
    // Claim cố định cũ (tenant + org_ids của staging) vẫn được chấp nhận nếu khớp DB.
    expect((await ctxOf(await token('kc-doc', { tenant_id: TA, org_ids: [O1], org_id: O1 }))).allowedOrganizationIds).toEqual([O1]);
  });

  it('tenant_admin: mọi cơ sở đang hoạt động', async () => {
    expect([...(await ctxOf(await token('kc-admin'))).allowedOrganizationIds]).toEqual([O1, O2]);
  });

  it('không được cấp / bị khoá / membership hết hạn hoặc thu hồi / tenant mơ hồ / claim tenant khác => từ chối', async () => {
    expect(await err(ctxOf(await token('kc-locked')))).toBe('403:USER_NOT_PROVISIONED');
    expect(await err(ctxOf(await token('kc-none')))).toBe('403:USER_NOT_PROVISIONED');
    expect(await err(ctxOf(await token('kc-khong-co')))).toBe('403:USER_NOT_PROVISIONED');
    expect(await err(ctxOf(await token('kc-two')))).toBe('403:TENANT_CLAIM_MISSING');
    expect((await ctxOf(await token('kc-two', { tenant_id: TB }))).allowedOrganizationIds).toEqual([OB]);
    expect(await err(ctxOf(await token('kc-doc', { tenant_id: TB })))).toBe('403:USER_NOT_PROVISIONED');
  });

  it('MFA: amr phải có otp (hoặc hwk); không kiểm khi không cấu hình', async () => {
    expect(await err(ctxOf(await token('kc-doc', { amr: undefined })))).toBe('401:AUTH_MFA_REQUIRED');
    expect(await err(ctxOf(await token('kc-doc', { amr: ['pwd'] })))).toBe('401:AUTH_MFA_REQUIRED');
    expect(await err(ctxOf(await token('kc-doc', { amr: 'otp' })))).toBe('401:AUTH_MFA_REQUIRED'); // phải là mảng
    expect(await err(ctxOf(await token('kc-doc', { amr: ['hwk'] })))).toBe('OK');
    expect(await err(ctxOf(await token('kc-doc', { amr: ['pwd'] }), { requireAmr: [] }))).toBe('OK');
  });

  it('cache: thu hồi membership có hiệu lực sau TTL (30 giây)', async () => {
    expect((await ctxOf(await token('kc-staff'))).allowedOrganizationIds).toEqual([O2]);
    su(`UPDATE iam.memberships SET status = 'revoked' WHERE user_id = '${U.staff}'`);
    expect((await ctxOf(await token('kc-staff'))).allowedOrganizationIds).toEqual([O2]); // còn trong cache
    now += 31_000;
    expect(await err(ctxOf(await token('kc-staff')))).toBe('403:USER_NOT_PROVISIONED');
  });

  it('hàm tra tenant: role ứng dụng gọi được, không đọc trực tiếp iam.users của tenant khác', () => {
    expect(su(`SET ROLE hcos_app; SELECT count(*) FROM iam.tenants_for_subject('kc-two')`)).toBe('2');
    expect(su(`SET ROLE hcos_app; SELECT count(*) FROM iam.users`)).toBe('0');
  });
});
