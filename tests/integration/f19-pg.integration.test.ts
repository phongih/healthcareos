/**
 * HCOS-F19 | Thiết bị & vật tư y khoa trên PostgreSQL thật:
 *  - thiết bị: mã tài sản TByy-nnnn-c (Luhn), quyền đăng ký / dùng, trạng thái CHỈ đổi qua nhật ký chỉ-thêm (role app không UPDATE được),
 *    báo hỏng qua QR, sửa chữa lớn => phải kiểm định lại, kiểm định đạt / không đạt, thanh lý là cuối;
 *  - chặn chỉ định: dịch vụ cần loại máy, máy hỏng / quá hạn kiểm định bắt buộc => service + CSDL đều chặn ghi chi phí;
 *  - vật tư: định mức theo dịch vụ, trừ khi tất toán: lô ghi thực tế trước, FEFO phần còn lại, thiếu tồn không chặn tất toán;
 *    sổ cái kho khớp; chạy lại không trừ thêm; giá vốn; truy xuất thu hồi (chắc chắn / suy theo FEFO), bắt buộc lý do; đối soát;
 *  - vật tư không kê đơn được; xuất sổ thiết bị qua máy chủ; khấu hao vào What-If.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { ForecastService, PgForecastUnitOfWork } from '../../services/api/src/analytics/forecast.service';
import { EquipmentService, validAssetCode } from '../../services/api/src/equipment/equipment.service';
import { FinanceService, PgFinanceUnitOfWork } from '../../services/api/src/finance/finance.service';
import { ExportService } from '../../services/api/src/governance/export.service';
import { GovernanceService } from '../../services/api/src/governance/governance.service';
import { RetentionService } from '../../services/api/src/governance/retention.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_f19_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(13));
const U = {
  staff: asUserId(uid(101)), doc: asUserId(uid(103)), cashier: asUserId(uid(104)), mgr: asUserId(uid(106)), kho: asUserId(uid(108)), exec: asUserId(uid(109)), rootB: asUserId(uid(107)),
};
const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-f19' as CorrelationId,
  });
const C = {
  staff: ctx(TA, U.staff, [OA]), doc: ctx(TA, U.doc, [OA]), cashier: ctx(TA, U.cashier, [OA]), mgr: ctx(TA, U.mgr, [OA]), kho: ctx(TA, U.kho, [OA]),
  exec: ctx(TA, U.exec, [OA]), rootB: ctx(TB, U.rootB, [OB]),
};
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
// Ngày theo giờ Việt Nam, đúng như service (vnToday). Dùng ngày UTC sẽ lệch một ngày sau 17:00 UTC
// và làm test "cùng ngày" thất bại.
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(Date.now() + n * 86_400_000));
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

const PAT = uid(1001);
const PAT2 = uid(1002);
const ROOM = uid(3001);
const LOC = uid(4001);
const SYR = uid(5001); // bơm tiêm 5ml (vật tư)
const COT = uid(5002); // bông cồn (vật tư)
const DRUG = uid(5003); // thuốc
const B_A = uid(6001); // bơm tiêm lô A (cận hạn)
const B_B = uid(6002); // bơm tiêm lô B (xa hạn)
const B_C = uid(6003); // bông cồn lô C (hết tồn)
const I_XN = uid(7001);
const I_SA = uid(7002);

run('Thiết bị & vật tư / PostgreSQL', () => {
  let eq: EquipmentService;
  let fin: FinanceService;
  let ex: ExportService;
  let fc: ForecastService;
  let typeSA: string;

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TB}','clinic','c3','PK B');
      INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name)
        SELECT u, t, 'sub-' || u, n FROM (VALUES ('${U.staff}'::uuid,'${TA}'::uuid,'ĐD A'),('${U.doc}','${TA}','BS A'),('${U.cashier}','${TA}','Thu ngân A'),
          ('${U.mgr}','${TA}','Quản lý A'),('${U.kho}','${TA}','Thủ kho A'),('${U.exec}','${TA}','GĐ A'),('${U.rootB}','${TB}','Quản trị B')) v(u,t,n);
      INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
        ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.cashier}','${OA}','cashier'),
        ('${TA}','${U.mgr}','${OA}','clinic_admin'),('${TA}','${U.kho}','${OA}','pharmacy_admin'),('${TA}','${U.exec}','${OA}','executive'),('${TB}','${U.rootB}','${OB}','tenant_admin');
      INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${uid(2001)}','${TA}','Bình','Trần Thị'),('${uid(2002)}','${TA}','An','Lê Văn');
      INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${PAT}','${TA}','${uid(2001)}','${OA}','F19-001'),('${PAT2}','${TA}','${uid(2002)}','${OA}','F19-002');
      INSERT INTO clinical.service_points(service_point_id,tenant_id,organization_id,code,name) VALUES ('${ROOM}','${TA}','${OA}','N1','Phòng khám Nội 1');
      INSERT INTO pharmacy.stock_locations(location_id,tenant_id,organization_id,name,type) VALUES ('${LOC}','${TA}','${OA}','Tủ vật tư thủ thuật','ward_cabinet');
      INSERT INTO pharmacy.medications(medication_id,tenant_id,brand_name,strength,form,unit_of_measure,item_kind) VALUES
        ('${SYR}','${TA}','Bơm tiêm 5ml','5 ml','bơm tiêm','cái','supply'),('${COT}','${TA}','Bông cồn','1 miếng','miếng','miếng','supply'),
        ('${DRUG}','${TA}','Paracetamol 500','500mg','viên nén','viên','drug');
      INSERT INTO pharmacy.batches(batch_id,tenant_id,medication_id,batch_number,expiry_date,unit_cost,created_at) VALUES
        ('${B_A}','${TA}','${SYR}','SYR-A','${day(30)}',1500,now() - interval '2 days'),('${B_B}','${TA}','${SYR}','SYR-B','${day(700)}',1200,now() - interval '1 day'),
        ('${B_C}','${TA}','${COT}','COT-C','${day(300)}',300,now());
      INSERT INTO finance.price_items(item_id,tenant_id,organization_id,code,name,category,unit_price) VALUES
        ('${I_XN}','${TA}','${OA}','XN-CTM','Tổng phân tích tế bào máu','lab',90000),('${I_SA}','${TA}','${OA}','SA-BUNG','Siêu âm ổ bụng','imaging',200000);
    `);
    // Nhập kho (sổ cái + tồn cùng transaction).
    su(`
      INSERT INTO pharmacy.stock_movements(tenant_id,destination_location_id,batch_id,quantity,movement_type) VALUES ('${TA}','${LOC}','${B_A}',1,'receipt'),('${TA}','${LOC}','${B_B}',10,'receipt');
      INSERT INTO pharmacy.inventory_balances(tenant_id,location_id,batch_id,quantity_on_hand) VALUES ('${TA}','${LOC}','${B_A}',1),('${TA}','${LOC}','${B_B}',10);
    `);
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    eq = new EquipmentService({ pool, audit });
    fin = new FinanceService({ uow: new PgFinanceUnitOfWork(pool), audit });
    const gov = new GovernanceService({ pool, audit });
    ex = new ExportService({ pool, audit, finance: fin, governance: gov, retention: new RetentionService({ pool, audit }), equipment: eq });
    fc = new ForecastService({ uow: new PgForecastUnitOfWork(pool), audit });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('thiết bị: mã tài sản Luhn, quyền, trạng thái chỉ qua nhật ký, sửa chữa lớn => kiểm định lại, thanh lý', async () => {
    expect(await outcome(eq.createType({ code: 'SIEU_AM', name: 'Máy siêu âm' }, C.doc))).toBe('FORBIDDEN');
    typeSA = (await eq.createType({ code: 'sieu_am', name: 'Máy siêu âm' }, C.mgr)).typeId;
    expect(await outcome(eq.createType({ code: 'SIEU_AM', name: 'Trùng' }, C.mgr))).toBe('CONFLICT:TYPE_CODE_TAKEN');
    const base = {
      organizationId: OA, typeId: typeSA, name: 'Máy siêu âm tổng quát', manufacturer: 'GE', model: 'Logiq P9', serialNo: 'LP9-0001', servicePointId: ROOM,
      riskClass: 'C', registrationNo: '2300123ĐKLH/BYT-HTTB', warrantyUntil: day(400), acquiredOn: '2025-01-10', inServiceOn: '2025-01-15', cost: 600_000_000, usefulLifeMonths: 96,
      regimes: [{ regime: 'atkt', cycleMonths: 12, mandatory: true }, { regime: 'hieu_chuan', cycleMonths: 6, mandatory: false }],
    };
    expect(await outcome(eq.registerDevice(base, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(eq.registerDevice({ ...base, cost: 1000, usefulLifeMonths: null }, C.mgr))).toBe('VALIDATION:DEPRECIATION_INCOMPLETE');
    let d = await eq.registerDevice(base, C.mgr);
    expect(d.assetCode).toMatch(/^TB\d{2}-0001-\d$/);
    expect(validAssetCode(d.assetCode)).toBe(true);
    expect(validAssetCode(d.assetCode.slice(0, -1) + String((Number(d.assetCode.slice(-1)) + 1) % 10))).toBe(false);
    expect(await outcome(eq.registerDevice({ ...base }, C.mgr))).toBe('CONFLICT:SERIAL_TAKEN');
    expect(d).toMatchObject({ status: 'active', roomCode: 'N1', riskClass: 'C' });
    // Chưa kiểm định lần nào => bị chặn (chế độ bắt buộc); hiệu chuẩn không bắt buộc không chặn.
    expect(d.blockers).toEqual(['regime:atkt:missing']);
    expect(d.depreciation).toMatchObject({ monthly: 6_250_000 });

    // Ghi kiểm định: đạt cần số giấy chứng nhận; hạn tự tính theo chu kỳ.
    expect(await outcome(eq.recordInspection(d.deviceId, { regime: 'atkt', performedOn: day(-10), result: 'pass', provider: 'Trung tâm kiểm định X' }, C.mgr))).toBe('VALIDATION:CERTIFICATE_REQUIRED');
    expect(await outcome(eq.recordInspection(d.deviceId, { regime: 'buc_xa', performedOn: day(-10), result: 'pass', provider: 'Đơn vị X', certificateNo: 'C1' }, C.mgr))).toBe('VALIDATION:REGIME_NOT_CONFIGURED');
    expect(await outcome(eq.recordInspection(d.deviceId, { regime: 'atkt', performedOn: day(5), result: 'pass', provider: 'Đơn vị X', certificateNo: 'C1' }, C.mgr))).toBe('VALIDATION:DATE_IN_FUTURE');
    d = await eq.recordInspection(d.deviceId, { regime: 'atkt', performedOn: day(-340), result: 'pass', provider: 'Trung tâm kiểm định X', certificateNo: 'KĐ-2025/001' }, C.mgr);
    expect(d.blockers).toEqual([]);
    expect(d.regimes.find((r) => r.regime === 'atkt')).toMatchObject({ state: 'due_soon' });

    // Trạng thái: role app KHÔNG cập nhật thẳng được.
    await asApp(async (c) => {
      expect(await code(c.query(`UPDATE equipment.devices SET status = 'retired', retired_on = current_date WHERE device_id = $1`, [d.deviceId]))).toBe('42501');
      expect(await code(c.query(`UPDATE equipment.device_events SET note = 'x'`))).toBe('42501');
      expect(await code(c.query(`DELETE FROM equipment.device_inspections`))).toBe('42501');
    });

    // Báo hỏng qua QR (bác sĩ, theo mã tài sản); bảo trì / sửa xong chỉ quản lý.
    expect(await outcome(eq.addEvent(d.assetCode, { kind: 'fault', via: 'qr' }, C.doc))).toBe('VALIDATION:NOTE_REQUIRED');
    d = await eq.addEvent(d.assetCode.toLowerCase(), { kind: 'fault', note: 'Đầu dò bụng mất tín hiệu', via: 'qr' }, C.doc);
    expect(d.status).toBe('broken');
    expect(d.blockers).toEqual(['status:broken']);
    expect(await outcome(eq.addEvent(d.assetCode, { kind: 'fault', note: 'Lần hai' }, C.staff))).toBe('CONFLICT:DEVICE_STATE');
    expect(await outcome(eq.addEvent(d.assetCode, { kind: 'repaired', note: 'Thay đầu dò' }, C.doc))).toBe('FORBIDDEN');
    await eq.addEvent(d.assetCode, { kind: 'handover', note: 'Nhận đầu ca — máy đang hỏng' }, C.staff); // bàn giao không đổi trạng thái
    d = await eq.addEvent(d.assetCode, { kind: 'repaired', note: 'Thay đầu dò bụng mới', majorRepair: true }, C.mgr);
    // Sửa chữa lớn sau lần kiểm định gần nhất => phải kiểm định lại mới được dùng.
    expect(d.status).toBe('active');
    expect(d.blockers).toEqual(['regime:atkt:reinspect']);
    expect(await outcome(eq.getDevice('TB26-0001-0', C.doc))).toMatch(/^(VALIDATION:ASSET_CODE_INVALID|NOT_FOUND)$/);
    const page = await eq.getDevice(d.assetCode, C.doc);
    expect(page.events.map((e) => e.kind)).toEqual(['repaired', 'handover', 'fault', 'registered']);
    expect(page.events[2]).toMatchObject({ via: 'qr', fromStatus: 'active', toStatus: 'broken', actorName: 'BS A' });
    expect(page).toMatchObject({ canUse: true, canManage: false });

    // Thiết bị thứ hai để thanh lý.
    const d2 = await eq.registerDevice({ ...base, serialNo: 'LP9-0002', regimes: [] }, C.mgr);
    expect(d2.assetCode).toMatch(/^TB\d{2}-0002-\d$/);
    await eq.addEvent(d2.deviceId, { kind: 'retired', note: 'Thanh lý theo quyết định 12/QĐ' }, C.mgr);
    expect(await outcome(eq.addEvent(d2.deviceId, { kind: 'handover' }, C.staff))).toBe('CONFLICT:DEVICE_RETIRED');
    // Tách tenant.
    expect(await outcome(eq.getDevice(d.assetCode, C.rootB))).toBe('NOT_FOUND');
  });

  it('chặn chỉ định: dịch vụ cần máy, không còn máy dùng được => service + CSDL chặn', async () => {
    await eq.setServiceRequirement({ organizationId: OA, itemId: I_SA, typeId: typeSA }, C.mgr);
    await fin.openShift({ organizationId: OA, openingFloat: 0 }, C.cashier);
    const c = await fin.openCase({ organizationId: OA, patientId: PAT2 }, C.cashier);
    // Máy duy nhất đang "cần kiểm định lại" => chặn.
    expect(await outcome(fin.addCharge(c.caseId, { itemId: I_SA, quantity: 1 }, C.cashier))).toBe('INVALID_STATE:DEVICE_UNAVAILABLE');
    await asApp(async (x) => {
      expect(await code(x.query(
        `INSERT INTO finance.charges (tenant_id, organization_id, case_id, item_id, item_code, description, quantity, unit_price, created_by) VALUES ($1,$2,$3,$4,'SA-BUNG','Siêu âm',1,200000,$5)`,
        [TA, OA, c.caseId, I_SA, U.cashier]))).toBe('55000');
    });
    const dev = (await eq.listDevices({ organizationId: OA }, C.mgr)).devices.find((d) => d.status === 'active')!;
    await eq.recordInspection(dev.deviceId, { regime: 'atkt', performedOn: day(0), result: 'pass', provider: 'Trung tâm kiểm định X', certificateNo: 'KĐ-2026/077' }, C.mgr);
    expect(await outcome(fin.addCharge(c.caseId, { itemId: I_SA, quantity: 1 }, C.cashier))).toBe('OK');
    // Không đạt => chặn lại.
    await eq.recordInspection(dev.deviceId, { regime: 'atkt', performedOn: day(0), result: 'fail', provider: 'Trung tâm kiểm định X', note: 'Dòng rò vượt ngưỡng' }, C.mgr);
    expect(await outcome(fin.addCharge(c.caseId, { itemId: I_SA, quantity: 1 }, C.cashier))).toBe('INVALID_STATE:DEVICE_UNAVAILABLE');
    const list = await eq.listDevices({ organizationId: OA }, C.mgr);
    expect(list.requirements).toMatchObject([{ itemCode: 'SA-BUNG', blocked: true }]);
  });

  it('vật tư: định mức, lô ghi thực tế trước, FEFO, thiếu không chặn tất toán, sổ cái khớp, giá vốn, thu hồi, đối soát', async () => {
    expect(await outcome(eq.setNorm({ organizationId: OA, itemId: I_XN, medicationId: SYR, quantity: 2 }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(eq.setNorm({ organizationId: OA, itemId: I_XN, medicationId: DRUG, quantity: 1 }, C.kho))).toBe('VALIDATION:NOT_A_SUPPLY');
    await eq.setNorm({ organizationId: OA, itemId: I_XN, medicationId: SYR, quantity: 2 }, C.kho);
    await eq.setNorm({ organizationId: OA, itemId: I_XN, medicationId: COT, quantity: 1 }, C.kho);
    await eq.setSupplyLocation({ organizationId: OA, locationId: LOC, version: 0 }, C.kho);
    let ov = await eq.supplyOverview({ organizationId: OA }, C.kho);
    expect(ov.services.find((s) => s.code === 'XN-CTM')).toMatchObject({ standardCost: 2 * 1200 + 300 });

    // Chưa có hồ sơ mở => không ghi lô được.
    expect(await outcome(eq.recordLot({ organizationId: OA, patientId: PAT, batchNumber: 'SYR-B', quantity: 1 }, C.staff))).toBe('INVALID_STATE:NO_OPEN_CASE');
    const c = await fin.openCase({ organizationId: OA, patientId: PAT }, C.cashier);
    await fin.addCharge(c.caseId, { itemId: I_XN, quantity: 1 }, C.cashier);
    expect(await outcome(eq.recordLot({ organizationId: OA, patientId: PAT, batchNumber: 'SYR-B', quantity: 1 }, C.cashier))).toBe('FORBIDDEN');
    expect(await outcome(eq.recordLot({ organizationId: OA, patientId: PAT, batchNumber: 'KHONG-CO', quantity: 1 }, C.staff))).toBe('NOT_FOUND:BATCH_NOT_FOUND');
    const lot = await eq.recordLot({ organizationId: OA, patientId: PAT, batchNumber: 'syr-b', quantity: 1 }, C.staff);
    const extra = await eq.recordLot({ organizationId: OA, patientId: PAT, batchNumber: 'SYR-B', quantity: 2 }, C.staff);
    await eq.cancelLot(extra.usageId, { reason: 'Ghi nhầm số lượng' }, C.staff);
    expect((await eq.patientLots({ organizationId: OA, patientId: PAT }, C.staff)).lots.map((l) => l.status).sort()).toEqual(['active', 'cancelled']);
    expect(lot.usageId).toBeTruthy();

    // Tất toán: thu đủ rồi đóng.
    const due = (await fin.getCase(c.caseId, C.cashier)).totals.balance;
    await fin.createReceipt({ organizationId: OA, caseId: c.caseId, kind: 'payment', method: 'cash', amount: -due }, `it-f19-${randomUUID()}`, C.cashier);
    const before = await fin.getCase(c.caseId, C.cashier);
    await fin.closeCase(c.caseId, before.version, C.cashier);
    // Không ghi / huỷ lô sau tất toán.
    expect(await outcome(eq.cancelLot(lot.usageId, { reason: 'Muộn' }, C.staff))).toBe('INVALID_STATE:CASE_NOT_OPEN');

    const cs = await eq.caseSupplies(c.caseId, C.cashier);
    const rows = cs.lines.map((l) => `${l.name}|${l.batchNumber ?? '-'}|${l.source}|${l.quantity}`).sort();
    // Bơm tiêm cần 2: 1 lô ghi thực tế (B) + 1 FEFO (A cận hạn); bông cồn hết tồn => thiếu 1.
    expect(rows).toEqual(['Bông cồn|-|shortfall|1', 'Bơm tiêm 5ml|SYR-A|fefo|1', 'Bơm tiêm 5ml|SYR-B|recorded|1']);
    expect(cs.cogs).toBe(1200 + 1500 + 300);
    expect(cs.shortfallQty).toBe(1);
    // Sổ cái 'consume' gắn hồ sơ; tồn giảm đúng; chạy lại không trừ thêm.
    expect(su(`SELECT string_agg(b.batch_number || ':' || ib.quantity_on_hand, ',' ORDER BY b.batch_number) FROM pharmacy.inventory_balances ib JOIN pharmacy.batches b USING (batch_id)`)).toBe('SYR-A:0,SYR-B:9');
    expect(su(`SELECT count(*) FROM pharmacy.stock_movements WHERE movement_type = 'consume' AND billing_case_id = '${c.caseId}'`)).toBe('2');
    await asApp(async (x) => {
      const r = await x.query(`SELECT lines FROM equipment.consume_case($1, $2, $3)`, [TA, c.caseId, U.cashier]);
      expect(Number((r.rows[0] as { lines: string }).lines)).toBe(3);
      expect(await code(x.query(`UPDATE equipment.supply_consumptions SET quantity = 9`))).toBe('42501');
      // Vật tư không kê đơn được.
      expect(await code(x.query(`SELECT equipment.consume_case($1, $2, $3)`, [TA, uid(9999), U.cashier]))).toBe('55000');
    });
    expect(su(`SELECT count(*) FROM pharmacy.stock_movements WHERE movement_type = 'consume'`)).toBe('2');

    // Thu hồi: cần quyền + lý do; phân biệt chắc chắn / suy theo FEFO.
    expect(await outcome(eq.recall({ organizationId: OA, batchNumber: 'SYR-B', reason: 'TB thu hồi 01' }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(eq.recall({ organizationId: OA, batchNumber: 'SYR-B', reason: '' }, C.kho))).toBe('VALIDATION:REASON_REQUIRED');
    const rb = await eq.recall({ organizationId: OA, batchNumber: 'SYR-B', reason: 'Thông báo thu hồi số 01/2026 của nhà cung cấp' }, C.kho);
    expect(rb.patients).toMatchObject([{ mrn: 'F19-001', name: 'Trần Thị Bình', certainty: 'recorded', caseStatus: 'closed', quantity: 1 }]);
    const ra = await eq.recall({ organizationId: OA, batchNumber: 'SYR-A', reason: 'Thông báo thu hồi số 02/2026' }, C.mgr);
    expect(ra.patients).toMatchObject([{ mrn: 'F19-001', certainty: 'fefo' }]);

    // Đối soát dòng thiếu.
    ov = await eq.supplyOverview({ organizationId: OA }, C.kho);
    expect(ov.shortfalls).toMatchObject([{ name: 'Bông cồn', quantity: 1 }]);
    expect(await outcome(eq.resolveShortfall(ov.shortfalls[0]!.consumptionId, { note: 'Đã nhập bù' }, C.cashier))).toBe('FORBIDDEN');
    await eq.resolveShortfall(ov.shortfalls[0]!.consumptionId, { note: 'Đã nhập bù 100 miếng, điều chỉnh kho' }, C.kho);
    expect(await outcome(eq.resolveShortfall(ov.shortfalls[0]!.consumptionId, { note: 'Lần hai nữa' }, C.kho))).toBe('CONFLICT:ALREADY_RESOLVED');
    expect((await eq.supplyOverview({ organizationId: OA }, C.kho)).shortfalls).toEqual([]);
  });

  it('vật tư không kê đơn được; xuất sổ thiết bị; khấu hao + giá vốn vào What-If', async () => {
    await asApp(async (x) => {
      expect(await code(x.query(
        `INSERT INTO clinical.prescription_items (tenant_id, prescription_id, line_no, medication_id, dose_quantity, dose_unit, frequency_per_day, duration_days, quantity_prescribed)
         VALUES ($1, $2, 1, $3, 1, 'cái', 1, 1, 1)`, [TA, uid(8888), SYR]))).toBe('23514');
    });
    const f = await ex.create({ dataset: 'equipment_register', params: { organizationId: OA } }, C.mgr);
    expect(f.containsPersonal).toBe(false);
    expect(f.rowCount).toBe(2 + 3); // 2 thiết bị + 3 lần kiểm định
    expect(f.fileName).toMatch(/^so-thiet-bi_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(await outcome(ex.create({ dataset: 'equipment_register', params: { organizationId: OA } }, C.rootB))).toMatch(/FORBIDDEN|NOT_FOUND/);
    const cb = await fc.cashflowBase(OA, C.mgr);
    // Máy 1 còn dùng; máy 2 thanh lý trong tháng này vẫn trích tháng này.
    expect(cb.depreciationMonthly).toBe(2 * 6_250_000);
    expect(cb.supplyCogsLast30).toBe(3000);
    expect(cb.supplyCogsPerCase).toBe(3000);
  });

  it('sửa chữa lớn cùng ngày, SAU lần kiểm định => vẫn phải kiểm định lại', async () => {
    let d = await eq.registerDevice({
      organizationId: OA, typeId: typeSA, name: 'Máy siêu âm dự phòng', serialNo: 'LP9-0003', riskClass: 'C', regimes: [{ regime: 'atkt', cycleMonths: 12, mandatory: true }],
    }, C.mgr);
    d = await eq.recordInspection(d.deviceId, { regime: 'atkt', performedOn: day(0), result: 'pass', provider: 'Trung tâm kiểm định X', certificateNo: 'KĐ-2026/100' }, C.mgr);
    expect(d.blockers).toEqual([]);
    await eq.addEvent(d.deviceId, { kind: 'fault', note: 'Rơi đầu dò' }, C.staff);
    d = await eq.addEvent(d.deviceId, { kind: 'repaired', note: 'Thay đầu dò', majorRepair: true }, C.mgr);
    expect(d.blockers).toEqual(['regime:atkt:reinspect']);
    d = await eq.recordInspection(d.deviceId, { regime: 'atkt', performedOn: day(0), result: 'pass', provider: 'Trung tâm kiểm định X', certificateNo: 'KĐ-2026/101' }, C.mgr);
    expect(d.blockers).toEqual([]);
  });
});
