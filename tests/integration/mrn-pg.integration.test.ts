/**
 * HCOS-F13 | Mã bệnh nhân tự sinh trên PostgreSQL thật (migration 016):
 * BN26-000001-c tăng dần theo cơ sở × năm (giờ Việt Nam), số kiểm tra Luhn, không trùng khi đăng ký đồng thời,
 * tiền tố theo cơ sở, mã cũ chỉ khi được bật và không được có dạng mã tự sinh, tìm theo mã gõ thiếu gạch / chữ thường,
 * sai số kiểm tra báo lỗi rõ, quyền cài đặt, bộ đếm chỉ tăng + RLS.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from '../../services/api/src/clinical/encounter.service';
import { formatAutoMrn, luhnDigit } from '../../services/api/src/registry/mrn';
import { MrnSettingsService } from '../../services/api/src/registry/mrn-settings.service';
import { PersonRegistryService, PgRegistryUnitOfWork } from '../../services/api/src/registry/person-registry.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_mrn_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));
const U = { admin: asUserId(uid(101)), staff: asUserId(uid(102)), cash: asUserId(uid(103)) };
const ctx = (u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: TA as TenantId, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-mrn' as CorrelationId,
  });
const C = { admin: ctx(U.admin, [OA, OB]), staff: ctx(U.staff, [OA]), cash: ctx(U.cash, [OA]) };
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const outcome = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('MRN tự sinh / PostgreSQL', () => {
  let now = new Date('2026-11-21T03:00:00Z');
  const clock = () => now;
  let reg: PersonRegistryService;
  let clin: ClinicalEncounterService;
  let settings: MrnSettingsService;
  let n = 0;
  const register = (org: OrganizationId, mrn?: string, c: TenantContext = C.admin) =>
    reg.registerPersonAndPatient({ organizationId: org, ...(mrn !== undefined ? { mrn } : {}), person: { givenName: `Hoa${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + Math.floor(n++ / 26))}`, familyName: 'Trần' } }, c);

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const x of readdirSync(MIG).filter((y) => /^\d+_.+\.sql$/.test(y)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${x}`]);
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB], {
      encoding: 'utf8',
      input: `
INSERT INTO iam.tenants(tenant_id,code,name,medical_license_no,medical_license_status) VALUES ('${TA}','ta','A','GP-TEST-A','approved');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TA}','clinic','c2','PK B');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES ('${U.admin}','${TA}','sub-${U.admin}','Quản lý'),('${U.staff}','${TA}','sub-${U.staff}','Lễ tân'),('${U.cash}','${TA}','sub-${U.cash}','Thu ngân');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES ('${TA}','${U.admin}','${OA}','clinic_admin'),('${TA}','${U.admin}','${OB}','clinic_admin'),('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.cash}','${OA}','cashier');
UPDATE iam.memberships SET valid_from = '2025-01-01';`,
    });
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    reg = new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit, clock });
    clin = new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit, clock });
    settings = new MrnSettingsService({ pool, audit, clock });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('CSDL và TypeScript tính cùng số kiểm tra', () => {
    for (const d of ['26000001', '26000123', '99999999', '00000000', '27000010']) expect(Number(su(`SELECT patient.luhn_digit('${d}')`))).toBe(luhnDigit(d));
  });

  it('không nhập mã => tự sinh BN26-000001-c, tăng dần, mỗi cơ sở một bộ đếm', async () => {
    const a1 = await register(OA);
    const a2 = await register(OA);
    const b1 = await register(OB);
    expect(a1.patient.mrn).toBe(formatAutoMrn('BN', 26, 1));
    expect(a2.patient.mrn).toBe(formatAutoMrn('BN', 26, 2));
    expect(b1.patient.mrn).toBe(formatAutoMrn('BN', 26, 1));
    expect(a1.patient.mrn).toMatch(/^BN26-000001-\d$/);
    // Đăng ký từ API cũ (người đã có) cũng tự sinh.
    const p = await clin.registerPatient({ personId: b1.person.personId, organizationId: OA }, C.staff);
    expect(p.mrn).toBe(formatAutoMrn('BN', 26, 3));
  });

  it('đăng ký đồng thời không trùng mã', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => register(OA)));
    const mrns = rs.map((r) => r.patient.mrn);
    expect(new Set(mrns).size).toBe(6);
    expect(mrns.map((m) => Number(m.slice(5, 11))).sort((x, y) => x - y)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('năm theo giờ Việt Nam: 31/12/2026 17:30 UTC đã là 2027 => đếm lại từ 1', async () => {
    now = new Date('2026-12-31T17:30:00Z');
    expect((await register(OA)).patient.mrn).toBe(formatAutoMrn('BN', 27, 1));
    now = new Date('2026-12-31T16:30:00Z');
    expect((await register(OA)).patient.mrn).toBe(formatAutoMrn('BN', 26, 10));
    now = new Date('2026-11-21T03:00:00Z');
  });

  it('cài đặt: chỉ quản lý sửa; đổi tiền tố áp dụng cho mã mới; xem trước mã kế tiếp', async () => {
    const s0 = await settings.get(OA, C.staff);
    expect(s0).toMatchObject({ prefix: 'BN', allowLegacy: false, version: 0, nextPreview: formatAutoMrn('BN', 26, 11), example: formatAutoMrn('BN', 26, 123) });
    expect(await outcome(settings.get(OA, C.cash))).toBe('FORBIDDEN');
    expect(await outcome(settings.update(OA, { prefix: 'PKA', allowLegacy: false }, 0, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(settings.update(OA, { prefix: 'pk', allowLegacy: false }, 0, C.admin))).toBe('VALIDATION:INVALID_PREFIX');
    expect(await outcome(settings.update(OA, { prefix: 'PKAB1', allowLegacy: false }, 0, C.admin))).toBe('VALIDATION:INVALID_PREFIX');
    const s1 = await settings.update(OA, { prefix: 'PKA', allowLegacy: false }, 0, C.admin);
    expect(s1).toMatchObject({ prefix: 'PKA', version: 1, nextPreview: formatAutoMrn('PKA', 26, 11) });
    expect(await outcome(settings.update(OA, { prefix: 'BN', allowLegacy: true }, 0, C.admin))).toBe('CONFLICT:VERSION_CONFLICT');
    expect((await register(OA)).patient.mrn).toBe(formatAutoMrn('PKA', 26, 11));
    // Cơ sở B không bị ảnh hưởng.
    expect((await register(OB)).patient.mrn).toBe(formatAutoMrn('BN', 26, 2));
  });

  it('mã cũ: mặc định bị từ chối; bật thì nhận; không được có dạng mã tự sinh; vẫn kiểm trùng', async () => {
    expect(await outcome(register(OA, 'SO-1998-0042', C.staff))).toBe('CONFLICT:LEGACY_MRN_DISABLED');
    const s = await settings.get(OA, C.admin);
    await settings.update(OA, { prefix: s.prefix, allowLegacy: true }, s.version, C.admin);
    const legacy = await register(OA, 'SO-1998-0042', C.staff);
    expect(legacy.patient.mrn).toBe('SO-1998-0042');
    expect(await outcome(register(OA, 'SO-1998-0042', C.staff))).toBe('CONFLICT:MRN_TAKEN');
    expect(await outcome(register(OA, 'BN26-000500-3', C.staff))).toBe('VALIDATION:MRN_RESERVED_FORMAT');
    expect(await outcome(register(OA, 'bn26000500 3'.replace(' ', ''), C.staff))).toBe('VALIDATION:MRN_RESERVED_FORMAT');
    expect(await outcome(register(OA, '-bad', C.staff))).toBe('VALIDATION');
    // Mã cũ không làm nhảy bộ đếm.
    expect((await register(OA)).patient.mrn).toBe(formatAutoMrn('PKA', 26, 12));
  });

  it('tìm theo mã: gõ chữ thường / thiếu gạch / quét mã vạch vẫn ra; sai số kiểm tra báo lỗi rõ', async () => {
    const mrn = formatAutoMrn('BN', 26, 2);
    const compact = mrn.replace(/-/g, '').toLowerCase();
    expect((await clin.searchPatients({ organizationId: OA, mrn: compact }, C.staff)).map((v) => v.patient.mrn)).toEqual([mrn]);
    expect((await clin.searchPatients({ organizationId: OA, mrn }, C.staff)).length).toBe(1);
    const wrong = `${mrn.slice(0, -1)}${(Number(mrn.slice(-1)) + 1) % 10}`;
    expect(await outcome(clin.searchPatients({ organizationId: OA, mrn: wrong }, C.staff))).toBe('VALIDATION:MRN_CHECK_DIGIT');
    // Đảo hai chữ số kề nhau cũng bị phát hiện.
    const swapped = mrn.replace('000002', '000020');
    expect(await outcome(clin.searchPatients({ organizationId: OA, mrn: swapped }, C.staff))).toBe('VALIDATION:MRN_CHECK_DIGIT');
    expect((await clin.searchPatients({ organizationId: OA, mrn: 'SO-1998-0042' }, C.staff)).length).toBe(1);
  });

  it('tầng CSDL: bộ đếm chỉ tăng, không xoá; RLS', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`UPDATE patient.mrn_counters SET last_value = 1`)).toBe('42501');
      expect(await code(`DELETE FROM patient.mrn_counters`)).toBe('42501');
      expect(await code(`DELETE FROM patient.mrn_settings`)).toBe('42501');
      expect(await code(`INSERT INTO patient.mrn_settings(tenant_id, organization_id, prefix) VALUES ('${TA}', '${OB}', 'bn')`)).toBe('23514');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [uid(999)]);
      expect(await c.query('SELECT count(*) AS n FROM patient.mrn_counters').then((r) => (r.rows[0] as { n: string }).n)).toBe('0');
    } finally {
      c.close();
    }
  });
});
