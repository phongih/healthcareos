/**
 * HCOS-F18 | Bên thứ ba & xuất dữ liệu trên PostgreSQL thật:
 *  - sổ nhà cung cấp: quyền; duyệt cần thoả thuận xử lý dữ liệu; hiệu lực ≤ 3 năm; dịch vụ AI không được nhận dữ liệu cá nhân / sức khoẻ
 *    (service + CSDL); thu hồi bằng đánh giá mới; tạm ngừng / chấm dứt; đánh giá chỉ-thêm;
 *  - xuất dữ liệu qua máy chủ: quyền theo bộ dữ liệu nguồn; dữ liệu cá nhân bắt buộc mục đích (service + CSDL); dấu người xuất trong file;
 *    nhật ký có SHA-256 khớp file, tra cứu theo SHA-256; nhật ký chỉ-thêm; hồ sơ tự đánh giá có mục bên thứ ba + AI.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { configureKeyProvider, LocalKeyProvider } from '../../packages/security/src/pii';
import { FinanceService, PgFinanceUnitOfWork } from '../../services/api/src/finance/finance.service';
import { ExportService } from '../../services/api/src/governance/export.service';
import { GovernanceService } from '../../services/api/src/governance/governance.service';
import { RetentionService } from '../../services/api/src/governance/retention.service';
import { VendorService } from '../../services/api/src/governance/vendor.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_f18_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(13));
const U = { staff: asUserId(uid(101)), doc: asUserId(uid(103)), root: asUserId(uid(105)), mgr: asUserId(uid(106)), rootB: asUserId(uid(107)) };
const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-f18' as CorrelationId,
  });
const C = { staff: ctx(TA, U.staff, [OA]), doc: ctx(TA, U.doc, [OA]), root: ctx(TA, U.root, [OA]), mgr: ctx(TA, U.mgr, [OA]), rootB: ctx(TB, U.rootB, [OB]) };
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const asApp = async <T>(fn: (c: PsqlClient) => Promise<T>): Promise<T> => {
  const c = new PsqlClient({ database: DB });
  try {
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
    return await fn(c);
  } finally {
    c.close();
  }
};
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Bên thứ ba & xuất dữ liệu / PostgreSQL', () => {
  let ven: VendorService;
  let ex: ExportService;
  let ret: RetentionService;
  let gov: GovernanceService;
  const good = {
    decision: 'approved', dpaReference: 'PL-DPA-2026/01', dataCategories: ['operational'], dataLocation: 'Singapore (asia-southeast1)', crossBorder: true,
    measures: 'Mã hoá khi truyền và khi lưu; chỉ nhận sự kiện vận hành, không định danh người bệnh', rationale: 'Đã xem hợp đồng và phụ lục xử lý dữ liệu',
    validFrom: day(-1), validUntil: day(365),
  };

  beforeAll(() => {
    configureKeyProvider(new LocalKeyProvider([['k1', randomBytes(32)]]));
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TB}','clinic','c3','PK B');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name)
        SELECT u, t, 'sub-' || u, n FROM (VALUES ('${U.staff}'::uuid,'${TA}'::uuid,'Lễ tân A'),('${U.doc}','${TA}','BS A'),('${U.root}','${TA}','Quản trị A'),
          ('${U.mgr}','${TA}','Quản lý A'),('${U.rootB}','${TB}','Quản trị B')) v(u,t,n);
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.root}','${OA}','tenant_admin'),
        ('${TA}','${U.mgr}','${OA}','clinic_admin'),('${TB}','${U.rootB}','${OB}','tenant_admin');
      INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${uid(2001)}','${TA}','Bình','Trần Thị');
      INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${uid(1001)}','${TA}','${uid(2001)}','${OA}','F18-001');
    `);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    ven = new VendorService({ pool, audit });
    gov = new GovernanceService({ pool, audit });
    ret = new RetentionService({ pool, audit });
    ex = new ExportService({ pool, audit, finance: new FinanceService({ uow: new PgFinanceUnitOfWork(pool), audit }), governance: gov, retention: ret });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('sổ nhà cung cấp: quyền, thoả thuận xử lý dữ liệu, hiệu lực ≤ 3 năm, thu hồi, tạm ngừng / chấm dứt', async () => {
    const v0 = { name: 'Google Cloud', kind: 'cloud_hosting', role: 'processor', services: 'Máy chủ ảo, lưu bản sao lưu đã mã hoá' };
    expect(await outcome(ven.create(v0, C.mgr))).toBe('FORBIDDEN');
    expect(await outcome(ven.list(C.doc))).toBe('FORBIDDEN');
    const g = await ven.create(v0, C.root);
    expect(g).toMatchObject({ standing: 'not_assessed', clearedOperational: false, endpoints: 0 });
    expect(await outcome(ven.create(v0, C.root))).toBe('CONFLICT:VENDOR_NAME_TAKEN');
    expect((await ven.list(C.mgr)).canManage).toBe(false);
    expect(await outcome(ven.assess(g.vendorId, { ...good, dpaReference: '' }, C.root))).toBe('VALIDATION:DPA_REQUIRED');
    expect(await outcome(ven.assess(g.vendorId, { ...good, validUntil: day(1200) }, C.root))).toBe('VALIDATION:ASSESSMENT_VALIDITY');
    expect(await outcome(ven.assess(g.vendorId, good, C.mgr))).toBe('FORBIDDEN');
    let x = await ven.assess(g.vendorId, { ...good, dataCategories: ['operational', 'backup_encrypted'] }, C.root);
    expect(x).toMatchObject({ standing: 'approved', clearedOperational: true, latest: { decision: 'approved', crossBorder: true, dataCategories: ['operational', 'backup_encrypted'] } });
    x = await ven.assess(g.vendorId, { ...good, validUntil: day(20) }, C.root);
    expect(x.standing).toBe('expiring');
    // Thu hồi = đánh giá 'rejected' mới hơn.
    x = await ven.assess(g.vendorId, { ...good, decision: 'rejected', dpaReference: null, rationale: 'Phát hiện lưu dữ liệu ngoài vùng đã thoả thuận' }, C.root);
    expect(x).toMatchObject({ standing: 'rejected', clearedOperational: false });
    x = await ven.assess(g.vendorId, good, C.root);
    expect(await outcome(ven.setStatus(g.vendorId, { status: 'suspended', version: x.version }, C.root))).toBe('VALIDATION:REASON_REQUIRED');
    x = await ven.setStatus(g.vendorId, { status: 'suspended', note: 'Đang xem xét sự cố bảo mật', version: x.version }, C.root);
    expect(x).toMatchObject({ standing: 'inactive', clearedOperational: false });
    x = await ven.setStatus(g.vendorId, { status: 'active', version: x.version }, C.root);
    expect(x.clearedOperational).toBe(true);
    expect((await ven.assessments(g.vendorId, C.mgr)).length).toBe(4);
    // Chỉ-thêm.
    await asApp(async (c) => {
      expect(await code(c.query(`UPDATE governance.vendor_assessments SET valid_until = valid_until + 3650`))).toBe('42501');
      expect(await code(c.query(`DELETE FROM governance.vendors`))).toBe('42501');
    });
    const t = await ven.create({ name: 'Đối tác cũ', kind: 'webhook_partner', role: 'third_party', services: 'Nhận thông báo vận hành' }, C.root);
    const tt = await ven.setStatus(t.vendorId, { status: 'terminated', note: 'Hết hợp đồng', version: t.version }, C.root);
    expect(await outcome(ven.setStatus(t.vendorId, { status: 'active', version: tt.version }, C.root))).toBe('CONFLICT:VENDOR_TERMINATED');
    expect(await outcome(ven.assess(t.vendorId, good, C.root))).toBe('CONFLICT:VENDOR_TERMINATED');
    // Tách tenant.
    expect((await ven.list(C.rootB)).vendors).toEqual([]);
    expect(await outcome(ven.assess(g.vendorId, good, C.rootB))).toBe('NOT_FOUND');
  });

  it('dịch vụ AI không bao giờ được duyệt nhận dữ liệu cá nhân / sức khoẻ (service + CSDL)', async () => {
    const ai = await ven.create({ name: 'Dịch vụ AI đám mây X', kind: 'ai_service', role: 'processor', services: 'Mô hình ngôn ngữ' }, C.root);
    expect(await outcome(ven.assess(ai.vendorId, { ...good, dataCategories: ['operational', 'health'] }, C.root))).toBe('VALIDATION:AI_NO_PATIENT_DATA');
    await asApp(async (c) => {
      expect(await code(c.query(
        `INSERT INTO governance.vendor_assessments(tenant_id,vendor_id,decision,dpa_reference,data_categories,data_location,cross_border,measures,rationale,valid_from,valid_until,assessed_by)
         VALUES ($1,$2,'approved','X-1',ARRAY['personal'],'Mỹ',true,'Mô tả biện pháp đủ dài để qua kiểm tra','Thử chèn thẳng',current_date,current_date+10,$3)`, [TA, ai.vendorId, U.root],
      ))).toBe('23514');
    });
    // Chỉ dữ liệu vận hành (không định danh) thì được.
    expect((await ven.assess(ai.vendorId, good, C.root)).clearedOperational).toBe(true);
  });

  it('xuất qua máy chủ: quyền theo bộ dữ liệu nguồn, mục đích khi có dữ liệu cá nhân, dấu người xuất, SHA-256 trong nhật ký', async () => {
    // Bác sĩ không có quyền báo cáo tài chính => không xuất được, không ghi sổ.
    expect(await outcome(ex.create({ dataset: 'finance_report', params: { organizationId: OA, from: day(-7), to: day(0) } }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(ex.create({ dataset: 'raw_sql' }, C.mgr))).toBe('VALIDATION');
    // Báo cáo không có dữ liệu cá nhân (không có công nợ) => không bắt buộc mục đích.
    const f = await ex.create({ dataset: 'finance_report', params: { organizationId: OA, from: day(-7), to: day(0) } }, C.mgr);
    const bytes = Buffer.from(f.base64, 'base64');
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(f.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(bytes.toString('utf8')).toContain(f.exportId); // dấu nhận diện trong file
    expect(bytes.toString('utf8')).toContain('Quản lý A');
    expect(f.containsPersonal).toBe(false);
    // Hồ sơ tự đánh giá: có mục bên thứ ba + nguồn AI; dấu người xuất ở cuối.
    const d = await ex.create({ dataset: 'governance_dossier' }, C.root);
    const md = Buffer.from(d.base64, 'base64').toString('utf8');
    expect(md).toContain('## 7. Bên thứ ba');
    expect(md).toContain('Google Cloud');
    expect(md).toContain('## 8. Nguồn dữ liệu AI');
    expect(md).toContain('Chưa kiểm định');
    expect(md).toContain(`mã xuất ${d.exportId}`);
    // Văn bản trả lời yêu cầu xoá (có mã bệnh nhân) => bắt buộc mục đích.
    const req = await ret.createRequest({ patientId: uid(1001), channel: 'counter' }, C.staff);
    expect(await outcome(ex.create({ dataset: 'erasure_letter', params: { requestId: req.requestId } }, C.staff))).toBe('VALIDATION:PURPOSE_REQUIRED');
    expect(await outcome(ex.create({ dataset: 'erasure_letter', params: { requestId: req.requestId }, purpose: 'x' }, C.staff))).toBe('VALIDATION:PURPOSE_REQUIRED');
    const l = await ex.create({ dataset: 'erasure_letter', params: { requestId: req.requestId }, purpose: 'Gửi người bệnh tại quầy' }, C.staff);
    expect(l.containsPersonal).toBe(true);
    // Nhật ký: chỉ người có export:audit; tra cứu theo SHA-256.
    expect(await outcome(ex.list({}, C.staff))).toBe('FORBIDDEN');
    const log = await ex.list({}, C.mgr);
    expect(log.map((x) => x.dataset)).toEqual(['erasure_letter', 'governance_dossier', 'finance_report']);
    expect(log[0]).toMatchObject({ containsPersonal: true, purpose: 'Gửi người bệnh tại quầy', exportedByName: 'Lễ tân A', params: { requestId: req.requestId } });
    expect((await ex.list({ sha256: f.sha256 }, C.mgr)).map((x) => x.exportId)).toEqual([f.exportId]);
    expect(su(`SELECT count(*) FROM governance.data_exports x WHERE row_to_json(x)::text ~ '(Trần Thị|Bình)'`)).toBe('0');
    // CSDL: chỉ-thêm; dữ liệu cá nhân phải có mục đích.
    await asApp(async (c) => {
      expect(await code(c.query(`UPDATE governance.data_exports SET purpose = 'sửa'`))).toBe('42501');
      expect(await code(c.query(
        `INSERT INTO governance.data_exports(export_id,tenant_id,dataset,params,row_count,contains_personal,file_name,content_type,byte_size,sha256,exported_by)
         VALUES (gen_random_uuid(),$1,'finance_report','{}',1,true,'a.xlsx','x',1,repeat('a',64),$2)`, [TA, U.mgr],
      ))).toBe('23514');
    });
    expect((await ex.list({}, C.rootB))).toEqual([]);
  });
});
