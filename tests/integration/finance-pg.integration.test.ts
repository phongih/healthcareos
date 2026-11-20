/**
 * HCOS-F8 | Thu ngân trên PostgreSQL thật (migration 012): bảng giá, ca thu ngân + kiểm két (DB tự tính), tạm ứng /
 * thanh toán / hoàn ứng, số phiếu liên tục khi lập đồng thời, chống thu hai lần (Idempotency-Key), huỷ phiếu trong ca,
 * đóng hồ sơ khi số dư = 0, ràng buộc DB khi đi vòng service, RLS.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/finance-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { FinanceService, PgFinanceUnitOfWork, type PriceItem } from '../../services/api/src/finance/finance.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_finance_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const U = { doc: asUserId(uid(101)), staff: asUserId(uid(102)), staff2: asUserId(uid(103)), cashier: asUserId(uid(104)), admin: asUserId(uid(105)) };
const PAT = (i: number) => uid(1000 + i);

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-finance' as CorrelationId,
  });
const C = Object.fromEntries(Object.entries(U).map(([k, v]) => [k, ctx(TA, v, [OA])])) as Record<keyof typeof U, TenantContext>;

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','Phòng khám A');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ${Object.entries(U).map(([k, v]) => `('${v}','${TA}','sub-${v}','${k}')`).join(',')};
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.staff2}','${OA}','clinic_staff'),
  ('${TA}','${U.cashier}','${OA}','cashier'),('${TA}','${U.admin}','${OA}','clinic_admin');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${TA}', 'Khách ' || g, 'Thử' FROM generate_series(1, 9) g;
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(1000 + g), 12, '0'))::uuid, '${TA}',
         ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${OA}', 'F' || lpad(g::text, 4, '0')
    FROM generate_series(1, 9) g;
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));
let keySeq = 0;
const key = () => `it-key-${process.pid}-${++keySeq}`;

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Thu ngân / PostgreSQL', () => {
  let f: FinanceService;
  const items: Record<string, PriceItem> = {};
  let shiftId = '';
  let case1 = '';
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric' }).format(new Date());

  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const x of readdirSync(MIG).filter((y) => /^\d+_.+\.sql$/.test(y)).sort()) suFile(`${MIG}/${x}`);
    su(SEED);
    f = new FinanceService({ uow: new PgFinanceUnitOfWork(psqlPool({ database: DB })), audit: { record: async () => {} } });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('cài đặt + bảng giá: chỉ quản lý sửa; mặc định tạm ứng 500k; tên tài khoản bỏ dấu; mã trùng => CONFLICT', async () => {
    expect((await f.getSettings(OA, C.staff)).depositDefault).toBe(500_000);
    expect(await outcome(f.getSettings(OA, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(f.updateSettings({ organizationId: OA, depositDefault: 300_000, bank: null }, 0, C.staff))).toBe('FORBIDDEN');
    const s = await f.updateSettings({ organizationId: OA, depositDefault: 300_000, bank: { bin: '970436', account: '0011001234567', accountName: 'Phòng khám Đa khoa A' } }, 0, C.admin);
    expect(s).toMatchObject({ depositDefault: 300_000, bank: { accountName: 'PHONG KHAM DA KHOA A' }, version: 1 });
    expect(await outcome(f.updateSettings({ organizationId: OA, depositDefault: 500_000, bank: null }, 0, C.admin))).toBe('CONFLICT:VERSION_CONFLICT');
    expect((await f.updateSettings({ organizationId: OA, depositDefault: 500_000, bank: s.bank }, 1, C.admin)).depositDefault).toBe(500_000);

    for (const [code, name, category, unitPrice] of [
      ['KB-NOI', 'Khám nội', 'exam', 150_000], ['XN-CTM', 'Công thức máu', 'lab', 90_000], ['SA-BUNG', 'Siêu âm bụng', 'imaging', 200_000],
    ] as const) {
      items[code] = await f.createPriceItem({ organizationId: OA, code, name, category, unitPrice }, C.admin);
    }
    expect(await outcome(f.createPriceItem({ organizationId: OA, code: 'kb-noi', name: 'Trùng', category: 'exam', unitPrice: 1 }, C.admin))).toBe('CONFLICT:PRICE_CODE_TAKEN');
    expect(await outcome(f.createPriceItem({ organizationId: OA, code: 'X1', name: 'Lạ', category: 'exam', unitPrice: 1 }, C.staff))).toBe('FORBIDDEN');
    // Sắp theo nhóm (exam, imaging, lab) rồi mã.
    expect((await f.listPriceItems(OA, C.cashier)).map((i) => i.code)).toEqual(['KB-NOI', 'SA-BUNG', 'XN-CTM']);
  });

  it('ca: phải mở ca mới lập phiếu; mỗi người một ca đang mở; bác sĩ không thu được', async () => {
    expect(await outcome(f.createReceipt({ organizationId: OA, patientId: PAT(1), kind: 'deposit', method: 'cash', amount: 500_000 }, key(), C.staff))).toBe('INVALID_STATE:NO_OPEN_SHIFT');
    expect(await outcome(f.openShift({ organizationId: OA, openingFloat: 0 }, C.doc))).toBe('FORBIDDEN');
    const s = await f.openShift({ organizationId: OA, openingFloat: 1_000_000 }, C.staff);
    shiftId = s.shiftId;
    expect(s).toMatchObject({ status: 'open', openingFloat: 1_000_000, cashOnHand: 1_000_000 });
    expect(await outcome(f.openShift({ organizationId: OA, openingFloat: 0 }, C.staff))).toBe('CONFLICT:SHIFT_ALREADY_OPEN');
    expect((await f.myShift(OA, C.staff))?.shiftId).toBe(shiftId);
    expect(await f.myShift(OA, C.staff2)).toBeNull();
  });

  it('tạm ứng theo bệnh nhân mở hồ sơ; gửi lại cùng khoá => cùng phiếu (không thu hai lần); khoá dùng lại với nội dung khác => lỗi', async () => {
    const k = key();
    const input = { organizationId: OA, patientId: PAT(1), kind: 'deposit', method: 'cash', amount: 500_000, payerName: 'Người nhà' };
    const a = await f.createReceipt(input, k, C.staff);
    expect(a.replayed).toBe(false);
    expect(a.value.receipt).toMatchObject({ kind: 'deposit', amount: 500_000, receiptNo: `PT${year}-000001`, status: 'valid' });
    expect(a.value.case.totals).toEqual({ charges: 0, received: 500_000, refunded: 0, balance: 500_000 });
    case1 = a.value.case.caseId;
    const b = await f.createReceipt(input, k, C.staff);
    expect(b.replayed).toBe(true);
    expect(b.value.receipt.receiptId).toBe(a.value.receipt.receiptId);
    expect(su(`SELECT count(*) FROM finance.receipts`)).toBe('1');
    expect(await outcome(f.createReceipt({ ...input, amount: 1 }, k, C.staff))).toBe('VALIDATION:IDEMPOTENCY_KEY_REUSED');
    // Lập tiếp theo bệnh nhân => dùng hồ sơ đang mở, không mở thêm.
    expect((await f.openCase({ organizationId: OA, patientId: PAT(1) }, C.staff2)).caseId).toBe(case1);
  });

  it('chi phí chụp giá; thanh toán không vượt số còn phải thu; hoàn ứng không vượt số dư; đóng hồ sơ khi số dư = 0', async () => {
    await f.addCharge(case1, { itemId: items['KB-NOI']!.itemId, quantity: 1 }, C.staff);
    let d = await f.addCharge(case1, { itemId: items['XN-CTM']!.itemId, quantity: 2 }, C.staff);
    expect(d.totals).toEqual({ charges: 330_000, received: 500_000, refunded: 0, balance: 170_000 });
    // Đổi bảng giá không làm đổi chi phí đã ghi.
    await f.updatePriceItem(items['XN-CTM']!.itemId, { name: 'Công thức máu', category: 'lab', unitPrice: 120_000, isActive: true }, 1, C.admin);
    expect((await f.getCase(case1, C.staff)).totals.charges).toBe(330_000);
    expect(await outcome(f.createReceipt({ organizationId: OA, caseId: case1, kind: 'payment', method: 'cash', amount: 1 }, key(), C.staff))).toBe('VALIDATION:PAYMENT_EXCEEDS_DUE');
    expect(await outcome(f.createReceipt({ organizationId: OA, caseId: case1, kind: 'refund', method: 'cash', amount: 200_000 }, key(), C.staff))).toBe('VALIDATION:REFUND_EXCEEDS_CREDIT');
    expect(await outcome(f.closeCase(case1, d.version, C.staff))).toBe('INVALID_STATE:BALANCE_NOT_ZERO');
    const r = await f.createReceipt({ organizationId: OA, caseId: case1, kind: 'refund', method: 'cash', amount: 170_000 }, key(), C.staff);
    expect(r.value.receipt.receiptNo).toBe(`PC${year}-000001`);
    d = r.value.case;
    expect(d.totals.balance).toBe(0);
    expect((await f.closeCase(case1, d.version, C.staff)).status).toBe('closed');
    expect(await outcome(f.addCharge(case1, { itemId: items['KB-NOI']!.itemId, quantity: 1 }, C.staff))).toBe('INVALID_STATE:CASE_NOT_OPEN');
    expect(await outcome(f.createReceipt({ organizationId: OA, caseId: case1, kind: 'payment', method: 'cash', amount: 1 }, key(), C.staff))).toBe('INVALID_STATE:CASE_NOT_OPEN');
  });

  it('gỡ chi phí cần lý do; thẻ / chuyển khoản cần mã tham chiếu; thu ngân (cashier) thu được', async () => {
    const c = await f.openCase({ organizationId: OA, patientId: PAT(2) }, C.cashier);
    let d = await f.addCharge(c.caseId, { itemId: items['SA-BUNG']!.itemId, quantity: 1 }, C.cashier);
    d = await f.addCharge(c.caseId, { itemId: items['KB-NOI']!.itemId, quantity: 1 }, C.cashier);
    const wrong = d.charges.find((x) => x.itemCode === 'KB-NOI')!;
    expect(await outcome(f.voidCharge(wrong.chargeId, { reason: '' }, C.cashier))).toBe('VALIDATION:REASON_REQUIRED');
    d = await f.voidCharge(wrong.chargeId, { reason: 'Ghi nhầm dịch vụ' }, C.cashier);
    expect(d.totals.charges).toBe(200_000);
    expect(await outcome(f.voidCharge(wrong.chargeId, { reason: 'Lần hai' }, C.cashier))).toBe('INVALID_STATE:ALREADY_VOIDED');
    await f.openShift({ organizationId: OA, openingFloat: 0 }, C.cashier);
    expect(await outcome(f.createReceipt({ organizationId: OA, caseId: c.caseId, kind: 'payment', method: 'card', amount: 200_000 }, key(), C.cashier))).toBe('VALIDATION:REFERENCE_REQUIRED');
    const r = await f.createReceipt({ organizationId: OA, caseId: c.caseId, kind: 'payment', method: 'card', amount: 200_000, reference: 'POS 123456' }, key(), C.cashier);
    expect((await f.closeCase(c.caseId, r.value.case.version, C.cashier)).status).toBe('closed');
  });

  it('huỷ phiếu: chỉ người lập, trong ca còn mở, có lý do; hồ sơ trở lại số dư cũ', async () => {
    const r = await f.createReceipt({ organizationId: OA, patientId: PAT(3), kind: 'deposit', method: 'bank_transfer', amount: 200_000, reference: 'HCOS F0003 TAM UNG' }, key(), C.staff);
    await f.openShift({ organizationId: OA, openingFloat: 0 }, C.staff2);
    expect(await outcome(f.cancelReceipt(r.value.receipt.receiptId, { reason: 'Khách đổi ý' }, C.staff2))).toBe('FORBIDDEN:NOT_SHIFT_OWNER');
    expect(await outcome(f.cancelReceipt(r.value.receipt.receiptId, { reason: 'ab' }, C.staff))).toBe('VALIDATION');
    const d = await f.cancelReceipt(r.value.receipt.receiptId, { reason: 'Chuyển khoản không về' }, C.staff);
    expect(d.totals).toEqual({ charges: 0, received: 0, refunded: 0, balance: 0 });
    expect(d.receipts[0]).toMatchObject({ status: 'cancelled', cancelReason: 'Chuyển khoản không về' });
    expect(await outcome(f.cancelReceipt(r.value.receipt.receiptId, { reason: 'Huỷ lần hai' }, C.staff))).toBe('INVALID_STATE:ALREADY_CANCELLED');
  });

  it('lập phiếu ĐỒNG THỜI: số phiếu liên tục, không trùng, không lỗ', async () => {
    const res = await Promise.all([4, 5, 6, 7, 8].map((i) =>
      f.createReceipt({ organizationId: OA, patientId: PAT(i), kind: 'deposit', method: 'cash', amount: 100_000 }, key(), C.staff)));
    const nos = res.map((r) => Number(r.value.receipt.receiptNo.slice(-6))).sort((a, b) => a - b);
    // PT: 1 (bn1), 2 (bn2, thẻ), 3 (bn3, đã huỷ — vẫn giữ số) => 4..8
    expect(nos).toEqual([4, 5, 6, 7, 8]);
  });

  it('đóng ca: DB tự tính tiền mặt phải có (bỏ qua thẻ, chuyển khoản, phiếu huỷ) + chênh lệch; sau đó không lập / huỷ phiếu trong ca đó', async () => {
    const before = (await f.myShift(OA, C.staff))!;
    // 1.000.000 đầu ca + 500.000 tạm ứng − 170.000 hoàn + 5 × 100.000 = 1.830.000 (chuyển khoản đã huỷ không tính).
    expect(before.cashOnHand).toBe(1_830_000);
    expect(before.totals.bank_transfer).toEqual({ in: 0, out: 0, count: 0 });
    expect(before.cancelledCount).toBe(1);
    expect(await outcome(f.closeShift(shiftId, { countedCash: 1_820_000 }, before.version, C.staff2))).toBe('FORBIDDEN:NOT_SHIFT_OWNER');
    const closed = await f.closeShift(shiftId, { countedCash: 1_820_000, note: 'Thiếu 10.000 tiền lẻ' }, before.version, C.staff);
    expect(closed).toMatchObject({ status: 'closed', expectedCash: 1_830_000, countedCash: 1_820_000, cashDifference: -10_000 });
    const last = (await f.getShift(shiftId, C.staff)).receipts.find((r) => r.status === 'valid' && r.kind === 'deposit' && r.amount === 100_000)!;
    expect(await outcome(f.cancelReceipt(last.receiptId, { reason: 'Thử sau đóng ca' }, C.staff))).toBe('INVALID_STATE:SHIFT_NOT_OPEN');
    expect(await outcome(f.createReceipt({ organizationId: OA, patientId: PAT(9), kind: 'deposit', method: 'cash', amount: 1 }, key(), C.staff))).toBe('INVALID_STATE:NO_OPEN_SHIFT');
  });

  it('báo cáo ca: quản lý xem mọi ca; lễ tân chỉ xem ca của mình', async () => {
    const list = await f.listShifts({ organizationId: OA }, C.admin);
    expect(list.map((s) => s.userName).sort()).toEqual(['cashier', 'staff', 'staff2']);
    expect(await outcome(f.listShifts({ organizationId: OA }, C.staff))).toBe('FORBIDDEN:REPORT_ROLE');
    const other = list.find((s) => s.userName === 'cashier')!;
    expect(await outcome(f.getShift(other.shiftId, C.staff))).toBe('FORBIDDEN:REPORT_ROLE');
    expect((await f.getShift(other.shiftId, C.admin)).totals.card).toEqual({ in: 200_000, out: 0, count: 1 });
  });

  it('báo cáo tài chính: thực thu theo ngày + hình thức, doanh thu dịch vụ, tạm ứng còn giữ, theo thu ngân, phiếu huỷ / chi phí gỡ', async () => {
    expect(await outcome(f.report({ organizationId: OA }, C.staff))).toBe('FORBIDDEN:REPORT_ROLE');
    expect(await outcome(f.report({ organizationId: OA }, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(f.report({ organizationId: OA, from: '2026-11-20', to: '2026-11-01' }, C.admin))).toBe('VALIDATION:INVALID_RANGE');
    expect(await outcome(f.report({ organizationId: OA, from: '2026-01-01', to: '2026-06-01' }, C.admin))).toBe('VALIDATION:INVALID_RANGE');
    expect(await outcome(f.report({ organizationId: OA, from: '2026-02-30' }, C.admin))).toBe('VALIDATION:INVALID_RANGE');

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    const r = await f.report({ organizationId: OA }, C.admin);
    expect([r.from, r.to]).toEqual([today, today]);
    // Phiếu hợp lệ: tạm ứng 500k + 5×100k tiền mặt, thanh toán thẻ 200k, hoàn 170k tiền mặt; phiếu chuyển khoản đã huỷ không tính.
    expect(r.cashflow.totals).toEqual({
      deposit: 1_000_000, payment: 200_000, refund: 170_000, net: 1_030_000, receiptCount: 8,
      byMethod: { cash: { in: 1_000_000, out: 170_000 }, bank_transfer: { in: 0, out: 0 }, card: { in: 200_000, out: 0 } },
    });
    expect(r.cashflow.days.map((d) => d.date)).toEqual([today]);
    // Doanh thu dịch vụ: chi phí còn hiệu lực, giá đã chụp (XN-CTM ghi 90k trước khi đổi giá), không tính dòng đã gỡ.
    expect(r.services.items.map((i) => [i.code, i.quantity, i.amount, i.cases])).toEqual([['SA-BUNG', 1, 200_000, 1], ['XN-CTM', 2, 180_000, 1], ['KB-NOI', 1, 150_000, 1]]);
    expect(r.services.byCategory).toEqual([{ category: 'imaging', quantity: 1, amount: 200_000 }, { category: 'lab', quantity: 2, amount: 180_000 }, { category: 'exam', quantity: 1, amount: 150_000 }]);
    expect(r.services.total).toBe(530_000);
    expect(r.openCases.cases).toHaveLength(6);
    expect([r.openCases.depositsHeld, r.openCases.receivable]).toEqual([500_000, 0]);
    const by = Object.fromEntries(r.cashiers.map((c) => [c.name, c]));
    expect(by['staff']).toMatchObject({ receiptCount: 7, in: 1_000_000, out: 170_000, cancelledCount: 1, cancelledAmount: 200_000, shifts: 1, openShifts: 0, cashDifference: -10_000 });
    expect(by['cashier']).toMatchObject({ receiptCount: 1, in: 200_000, voidedCharges: 1, shifts: 1, openShifts: 1 });
    expect(by['staff2']).toMatchObject({ receiptCount: 0, shifts: 1, openShifts: 1 });
    expect(r.controls.cancelledReceipts.map((x) => [x.method, x.amount, x.reason, x.cancelledByName])).toEqual([['bank_transfer', 200_000, 'Chuyển khoản không về', 'staff']]);
    expect(r.controls.voidedCharges.map((x) => [x.itemCode, x.amount, x.reason, x.voidedByName])).toEqual([['KB-NOI', 150_000, 'Ghi nhầm dịch vụ', 'cashier']]);
    // Khoảng ngày không có dữ liệu.
    const empty = await f.report({ organizationId: OA, from: '2026-01-01', to: '2026-01-31' }, C.admin);
    expect([empty.cashflow.days.length, empty.services.total, empty.cashiers.length]).toEqual([0, 0, 0]);
  });

  it('DB chặn khi đi vòng service: sửa phiếu, hoàn vượt đã thu, đóng hồ sơ lệch số dư, tự ghi tiền phải có, xoá; RLS', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const rid = su(`SELECT receipt_id FROM finance.receipts WHERE status='valid' LIMIT 1`);
      expect(await code(`UPDATE finance.receipts SET amount = 1 WHERE receipt_id='${rid}'`)).toBe('42501');
      expect(await code(`DELETE FROM finance.receipts WHERE receipt_id='${rid}'`)).toBe('42501');
      const open4 = su(`SELECT case_id FROM finance.billing_cases WHERE patient_id='${PAT(4)}'`);
      const s2 = su(`SELECT shift_id FROM finance.cashier_shifts WHERE user_id='${U.staff2}' AND status='open'`);
      expect(await code(`INSERT INTO finance.receipts(tenant_id,organization_id,case_id,shift_id,kind,series,year,seq,method,amount,created_by)
        VALUES ('${TA}','${OA}','${open4}','${s2}','refund','PC',2026,999,'cash',100001,'${U.staff2}')`)).toBe('23514');
      // Phiếu phải nằm trong ca của chính người lập.
      expect(await code(`INSERT INTO finance.receipts(tenant_id,organization_id,case_id,shift_id,kind,series,year,seq,method,amount,created_by)
        VALUES ('${TA}','${OA}','${open4}','${s2}','deposit','PT',2026,999,'cash',1,'${U.staff}')`)).toBe('42501');
      expect(await code(`UPDATE finance.billing_cases SET status='closed', closed_by='${U.staff}', closed_at=now() WHERE case_id='${open4}'`)).toBe('23514');
      expect(await code(`UPDATE finance.cashier_shifts SET expected_cash = 0 WHERE shift_id='${s2}'`)).toBe('55000');
      expect(await code(`UPDATE finance.cashier_shifts SET counted_cash = 5 WHERE shift_id='${shiftId}'`)).toBe('55000');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      for (const t of ['receipts', 'billing_cases', 'charges', 'cashier_shifts', 'price_items', 'settings']) {
        expect((await c.query(`SELECT 1 FROM finance.${t}`)).rows).toHaveLength(0);
      }
    } finally {
      c.close();
    }
  });
});
