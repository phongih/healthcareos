/**
 * HCOS-F15 | Danh mục dữ liệu khớp CSDL thật sau MỌI migration (cổng CI: bảng / cột cá nhân mới phải được gắn nhãn),
 * và hồ sơ tự đánh giá: quyền, không xác định thấp hơn cấp tính được, chỉ-thêm, RLS, quy mô đếm theo tenant.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/data-catalog-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { checkCatalog, summarize } from '../../packages/security/src/data-catalog';
import { GovernanceService } from '../../services/api/src/governance/governance.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_catalog_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));
const U = { root: asUserId(uid(101)), mgr: asUserId(uid(102)), doc: asUserId(uid(103)), rootB: asUserId(uid(104)) };
const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-catalog' as CorrelationId,
  });
const C = { root: ctx(TA, U.root, [OA]), mgr: ctx(TA, U.mgr, [OA]), doc: ctx(TA, U.doc, [OA]), rootB: ctx(TB, U.rootB, [OB]) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Danh mục dữ liệu / PostgreSQL', () => {
  let g: GovernanceService;

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TB}','clinic','c2','PK B');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
        ('${U.root}','${TA}','sub-${U.root}','Quản trị A'),('${U.mgr}','${TA}','sub-${U.mgr}','Quản lý A'),('${U.doc}','${TA}','sub-${U.doc}','BS A'),
        ('${U.rootB}','${TB}','sub-${U.rootB}','Quản trị B');
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.root}','${OA}','tenant_admin'),('${TA}','${U.mgr}','${OA}','clinic_admin'),('${TA}','${U.doc}','${OA}','doctor'),('${TB}','${U.rootB}','${OB}','tenant_admin');
      INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${uid(301)}','${TA}','An','Nguyen'),('${uid(302)}','${TA}','Binh','Tran'),('${uid(303)}','${TB}','Chi','Le');
    `);
    g = new GovernanceService({ pool: psqlPool({ database: DB }), audit: { record: async () => {} } });
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('CỔNG CI: mọi bảng / cột của CSDL sau mọi migration đều có trong danh mục, không nhãn thừa', () => {
    const rows = su(`SELECT c.table_schema || '.' || c.table_name || '|' || c.column_name
                       FROM information_schema.columns c
                       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
                      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'public')
                      ORDER BY 1`).split('\n').filter(Boolean);
    const schema = new Map<string, string[]>();
    for (const r of rows) {
      const [t, c] = r.split('|') as [string, string];
      schema.set(t, [...(schema.get(t) ?? []), c]);
    }
    expect(schema.size).toBeGreaterThan(50);
    const problems = checkCatalog(schema);
    // In ra để người sửa biết phải thêm nhãn gì vào packages/security/src/data-catalog.ts.
    if (problems.length) console.error('Danh mục dữ liệu chưa khớp CSDL:\n' + problems.map((p) => `  ${p.kind} ${p.table}${p.column ? '.' + p.column : ''}`).join('\n'));
    expect(problems).toEqual([]);
  });

  it('mọi bảng của ứng dụng: bật RLS FORCE, hoặc role ứng dụng không có quyền gì (chỉ hàm SECURITY DEFINER chạm tới)', () => {
    const exposed = su(`SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
                           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
                           AND has_table_privilege('hcos_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE') ORDER BY 1`);
    expect(exposed).toBe('');
    // Bảo đảm phép kiểm tra thực sự chạy: đầu chuỗi băm kiểm toán là bảng loại thứ hai.
    expect(su(`SELECT has_table_privilege('hcos_app', 'platform.audit_chain_heads', 'SELECT, INSERT, UPDATE, DELETE')`)).toBe('f');
  });

  it('xem danh mục: quản lý / quản trị được, bác sĩ không; quy mô chỉ đếm dữ liệu của tenant mình', async () => {
    expect(await outcome(g.catalog(C.doc))).toBe('FORBIDDEN');
    const v = await g.catalog(C.mgr);
    expect(v.summary.systemLevel).toBe(3);
    expect(v.summary.version).toBe(summarize().version);
    expect(v.scale.find((r) => r.table === 'patient.persons')?.rows).toBe(2);
    expect(v.latest).toBeNull();
    expect(v.needsAssessment).toBe(true);
    expect(v.canAssess).toBe(false);
    expect((await g.catalog(C.rootB)).scale.find((r) => r.table === 'patient.persons')?.rows).toBe(1);
  });

  it('đánh giá: chỉ quản trị; không thấp hơn cấp tính được; cần căn cứ; lưu phiên bản danh mục + quy mô', async () => {
    const rationale = 'Hệ thống lưu dữ liệu sức khoẻ của người bệnh; quy mô một phòng khám; chưa có dữ liệu cấp 4.';
    expect(await outcome(g.assess({ declaredLevel: 3, rationale }, C.mgr))).toBe('FORBIDDEN');
    expect(await outcome(g.assess({ declaredLevel: 2, rationale }, C.root))).toBe('VALIDATION:DECLARED_BELOW_COMPUTED');
    expect(await outcome(g.assess({ declaredLevel: 3, rationale: 'ngắn' }, C.root))).toBe('VALIDATION:RATIONALE_REQUIRED');
    expect(await outcome(g.assess({ declaredLevel: 6, rationale }, C.root))).toBe('VALIDATION');
    const a = await g.assess({ declaredLevel: 3, rationale }, C.root);
    expect(a).toMatchObject({ computedLevel: 3, declaredLevel: 3, assessedByName: 'Quản trị A', catalogVersion: summarize().version });
    expect(a.summary.scale.find((r) => r.table === 'patient.persons')?.rows).toBe(2);
    const v = await g.catalog(C.root);
    expect(v.needsAssessment).toBe(false);
    expect(v.canAssess).toBe(true);
    expect((await g.listAssessments(C.mgr)).length).toBe(1);
    expect(await g.listAssessments(C.rootB)).toEqual([]);
    const md = await g.dossier(C.mgr);
    expect(md).toContain('Cấp tính từ danh mục: 3');
    expect(md).toContain('`patient.persons.phone_enc`');
    expect(md).toContain('Bản rõ cũ còn lại trong CSDL của chủ quản: **0**');
    expect(md).toContain('`patient.patients.mrn` — Mã tra cứu tự sinh');
    expect(md).toContain('(giờ Việt Nam)');
    expect(md).toContain('Lần xác định gần nhất: **cấp 3**');
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action='governance.assessment.create' AND outcome='success'`)).toBe('1');
  });

  it('CSDL chặn: xác định thấp hơn cấp tính được, sửa / xoá hồ sơ; RLS theo tenant', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`INSERT INTO governance.risk_assessments (tenant_id, catalog_version, computed_level, declared_level, summary, rationale, assessed_by)
                         VALUES ('${TA}', '${'a'.repeat(64)}', 3, 2, '{}', '${'x'.repeat(30)}', '${U.root}')`)).toBe('23514');
      expect(await code(`UPDATE governance.risk_assessments SET declared_level = 4`)).toBe('42501');
      expect(await code(`DELETE FROM governance.risk_assessments`)).toBe('42501');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query('SELECT 1 FROM governance.risk_assessments')).rows).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
