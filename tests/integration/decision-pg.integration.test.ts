/**
 * HCOS-F11 | Decision Engine trên PostgreSQL thật (migration 014):
 * luật theo danh mục đóng, thử luật không ghi, chạy → sự kiện / nhật ký / thông báo theo vai trò, cooldown, tạm dừng / xoá mềm,
 * hộp thông báo (áp dụng / bỏ qua / đã xử lý, phân tách vai trò), chỉ-thêm ở tầng CSDL, khoá chạy song song,
 * bộ lập lịch, engine KHÔNG đổi dữ liệu lâm sàng / tài chính / kho, sự kiện không chứa tên bệnh nhân.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/decision-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { DETECTORS } from '../../services/api/src/decision/catalog';
import { DecisionEngineService, DecisionScheduler, PgDecisionUnitOfWork, type Rule, type RuleInput } from '../../services/api/src/decision/decision.service';
import { FinanceService, PgFinanceUnitOfWork } from '../../services/api/src/finance/finance.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_decision_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));
const U = { admin: asUserId(uid(101)), doc: asUserId(uid(102)), staff: asUserId(uid(103)), cash: asUserId(uid(104)), exec: asUserId(uid(105)), pharm: asUserId(uid(106)) };
const PAT = (i: number) => uid(1000 + i);
const E = { e1: uid(5001), e2: uid(5002), e3: uid(5003) };

const ctx = (u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: TA as TenantId, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-decision' as CorrelationId,
  });
const C = {
  admin: ctx(U.admin, [OA, OB]), doc: ctx(U.doc, [OA]), staff: ctx(U.staff, [OA]), cash: ctx(U.cash, [OA]), exec: ctx(U.exec, [OA]), pharm: ctx(U.pharm, [OB]),
};

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const obs = (enc: string, pat: string, code: string, display: string, unit: string, value: number, minutesAgo: number, extra = '') =>
  `INSERT INTO clinical.observations(observation_id,tenant_id,patient_id,encounter_id,code_system,code,display,value_numeric,value_unit,effective_at,recorded_by_user_id${extra ? ',status,supersedes_observation_id' : ''})
   VALUES (gen_random_uuid(),'${TA}','${pat}','${enc}','http://loinc.org','${code}','${display}',${value},'${unit}',now() - interval '${minutesAgo} minutes','${U.doc}'${extra});`;

function seedSql(): string {
  return `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TA}','clinic','c2','PK B');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.admin}','${TA}','sub-${U.admin}','Quản lý'),('${U.doc}','${TA}','sub-${U.doc}','BS An'),('${U.staff}','${TA}','sub-${U.staff}','ĐD Bình'),
  ('${U.cash}','${TA}','sub-${U.cash}','TN Chi'),('${U.exec}','${TA}','sub-${U.exec}','GĐ'),('${U.pharm}','${TA}','sub-${U.pharm}','DS Dung');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.admin}','${OA}','clinic_admin'),('${TA}','${U.admin}','${OB}','clinic_admin'),('${TA}','${U.doc}','${OA}','doctor'),
  ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.cash}','${OA}','cashier'),('${TA}','${U.exec}','${OA}','executive'),('${TA}','${U.pharm}','${OB}','pharmacist');
UPDATE iam.memberships SET valid_from = '2026-01-01';
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${TA}', 'Hoa' || chr(64 + g), 'Nguyễn' FROM generate_series(1, 6) g;
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(1000 + g), 12, '0'))::uuid, '${TA}', ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${OA}', 'P' || g
    FROM generate_series(1, 6) g;
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,status,encounter_class,period_start) VALUES
  ('${E.e1}','${TA}','${PAT(1)}','${OA}','${U.doc}','in_progress','ambulatory',now() - interval '1 hour'),
  ('${E.e2}','${TA}','${PAT(2)}','${OA}','${U.doc}','in_progress','ambulatory',now() - interval '1 hour'),
  ('${E.e3}','${TA}','${PAT(3)}','${OA}','${U.doc}','in_progress','ambulatory',now() - interval '1 hour');
-- E1: SpO₂ 89 % + sốt 39,4 °C; E2: SpO₂ 97 %; E3: SpO₂ 85 % đo nhầm, đã được thay bằng 94 % => không báo.
${obs(E.e1, PAT(1), '59408-5', 'SpO₂', '%', 89, 10)}
${obs(E.e1, PAT(1), '8310-5', 'Nhiệt độ', 'Cel', 39.4, 10)}
${obs(E.e2, PAT(2), '59408-5', 'SpO₂', '%', 97, 10)}
INSERT INTO clinical.observations(observation_id,tenant_id,patient_id,encounter_id,code_system,code,display,value_numeric,value_unit,effective_at,recorded_by_user_id)
  VALUES ('${uid(6001)}','${TA}','${PAT(3)}','${E.e3}','http://loinc.org','59408-5','SpO₂',85,'%',now() - interval '20 minutes','${U.doc}');
${obs(E.e3, PAT(3), '59408-5', 'SpO₂', '%', 94, 5, `,'corrected','${uid(6001)}'`)}
`;
}

/** Dấu vân tay dữ liệu nghiệp vụ: số dòng + tổng version của các bảng engine KHÔNG được đụng tới. */
function businessFingerprint(): string {
  const t = [
    'clinical.encounters', 'clinical.observations', 'clinical.conditions', 'clinical.prescriptions', 'clinical.prescription_items', 'clinical.queue_tickets',
    'clinical.bookings', 'clinical.service_points', 'finance.billing_cases', 'finance.receipts', 'finance.charges', 'finance.cashier_shifts',
    'pharmacy.inventory_balances', 'pharmacy.stock_movements', 'patient.patients', 'patient.persons',
  ];
  return t.map((x) => su(`SELECT '${x}:' || count(*) || ':' || COALESCE(sum(${x === 'pharmacy.stock_movements' ? '1' : 'version'}), 0) FROM ${x}`)).join('|');
}

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Decision Engine / PostgreSQL', () => {
  let d: DecisionEngineService;
  let f: FinanceService;
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const rules: Record<string, Rule> = {};

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const x of readdirSync(MIG).filter((y) => /^\d+_.+\.sql$/.test(y)).sort()) suFile(`${MIG}/${x}`);
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB], { input: seedSql(), encoding: 'utf8' });
    const pool = psqlPool({ database: DB });
    d = new DecisionEngineService({ uow: new PgDecisionUnitOfWork(pool), audit: { record: async () => {} }, clock });
    f = new FinanceService({ uow: new PgFinanceUnitOfWork(pool), audit: { record: async () => {} } });
    // Thu ngân: quỹ đầu ca 1 tr; tạm ứng 500k (BN4, hồ sơ còn mở); thu 200k (BN5) rồi huỷ; đếm 1,45 tr => thiếu 50k.
    const s = await f.openShift({ organizationId: OA, openingFloat: 1_000_000 }, C.cash);
    await f.createReceipt({ organizationId: OA, patientId: PAT(4), kind: 'deposit', method: 'cash', amount: 500_000 }, 'it-dec-0001', C.cash);
    const r5 = await f.createReceipt({ organizationId: OA, patientId: PAT(5), kind: 'deposit', method: 'cash', amount: 200_000 }, 'it-dec-0002', C.cash);
    await f.cancelReceipt(r5.value.receipt.receiptId, { reason: 'Lập nhầm bệnh nhân' }, C.cash);
    const mine = (await f.myShift(OA, C.cash))!;
    await f.closeShift(s.shiftId, { countedCash: 1_450_000 }, mine.version, C.cash);
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('luật theo danh mục đóng; chỉ quản lý tạo / sửa; ban giám đốc chỉ xem', async () => {
    const base: RuleInput = { organizationId: OA, name: 'Thử', detector: 'vital_abnormal', conditions: [{ metric: 'spo2_pct', op: '<', value: 92 }], priority: 1, cooldownMinutes: 60, actions: ['notify_doctor'] };
    expect(await outcome(d.createRule(base, C.staff))).toBe('FORBIDDEN');
    expect(await outcome(d.createRule(base, C.exec))).toBe('FORBIDDEN');
    expect(await outcome(d.createRule({ ...base, detector: 'make_coffee' }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    expect(await outcome(d.createRule({ ...base, conditions: [{ metric: 'held_vnd', op: '>', value: 0 }] }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    // Sinh hiệu không được gửi cho thu ngân.
    expect(await outcome(d.createRule({ ...base, actions: ['notify_cashier'] }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    expect(await outcome(d.createRule({ ...base, actions: ['log_only', 'notify_doctor'] }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    expect(await outcome(d.createRule({ ...base, actions: ['suggest'] }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    expect(await outcome(d.createRule({ ...base, conditions: [{ metric: 'spo2_pct', op: '~' as never, value: 92 }] }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    // Cơ sở ngoài phạm vi.
    expect(await outcome(d.createRule({ ...base, organizationId: OB }, C.doc))).toBe('ORG_NOT_ALLOWED');

    const mk = async (k: string, x: Partial<RuleInput>) => {
      rules[k] = await d.createRule({ ...base, ...x }, C.admin);
    };
    await mk('spo2', { name: 'SpO₂ thấp', actions: ['notify_doctor', 'notify_clinic_staff', 'suggest'] });
    await mk('fever', { name: 'Sốt cao', conditions: [{ metric: 'temperature_c', op: '>=', value: 39 }], priority: 2, cooldownMinutes: 120, actions: ['notify_doctor'] });
    await mk('cash', { name: 'Lệch quỹ', detector: 'cash_difference', conditions: [{ metric: 'abs_difference_vnd', op: '>=', value: 10_000 }], cooldownMinutes: 1440, actions: ['notify_clinic_admin', 'suggest'] });
    await mk('deposit', { name: 'Tạm ứng treo', detector: 'deposit_aging', conditions: [{ metric: 'held_vnd', op: '>', value: 0 }, { metric: 'age_days', op: '>=', value: 0 }], priority: 3, cooldownMinutes: 1440, actions: ['notify_cashier'] });
    await mk('cancel', { name: 'Huỷ phiếu', detector: 'receipt_cancellations', conditions: [{ metric: 'cancel_count', op: '>=', value: 1 }], priority: 2, cooldownMinutes: 1440, actions: ['log_only'] });
    expect(rules['spo2']).toMatchObject({ status: 'active', version: 1, createdByName: 'Quản lý', actions: ['suggest', 'notify_doctor', 'notify_clinic_staff'] });
    // Trùng tên (không phân biệt hoa thường) trong cùng cơ sở.
    expect(await outcome(d.createRule({ ...base, name: 'sốt cao' }, C.admin))).toBe('CONFLICT:RULE_NAME_TAKEN');
    expect((await d.listRules(OA, C.exec)).map((r) => r.name).sort()).toEqual(['Huỷ phiếu', 'Lệch quỹ', 'Sốt cao', 'SpO₂ thấp', 'Tạm ứng treo'].sort());
    expect(await outcome(d.listRules(OA, C.doc))).toBe('FORBIDDEN');
  });

  it('thử luật: đúng ứng viên (bỏ kết quả đã bị thay thế), không ghi gì; mọi bộ phát hiện chạy được trên CSDL thật', async () => {
    const before = su('SELECT count(*) FROM decision.events');
    const p = await d.preview({ organizationId: OA, detector: 'vital_abnormal', conditions: [{ metric: 'spo2_pct', op: '<', value: 92 }] }, C.admin);
    expect(p.matched).toBe(1);
    expect(p.sample[0]!.link).toBe(`#/encounters/${E.e1}`);
    expect(p.sample[0]!.metrics['spo2_pct']).toBe(89);
    expect(su('SELECT count(*) FROM decision.events')).toBe(before);
    for (const det of DETECTORS) {
      const m = det.metrics[0]!.id;
      const r = await d.preview({ organizationId: OA, detector: det.id, conditions: [{ metric: m, op: '>=', value: -1e9 }] }, C.admin);
      expect(r.candidates).toBeGreaterThanOrEqual(0);
    }
    expect(await outcome(d.preview({ organizationId: OA, detector: 'vital_abnormal', conditions: [] }, C.admin))).toBe('VALIDATION:INVALID_RULE');
    expect(await outcome(d.preview({ organizationId: OA, detector: 'vital_abnormal', conditions: [{ metric: 'spo2_pct', op: '<', value: 92 }] }, C.exec))).toBe('FORBIDDEN');
  });

  it('chạy: sự kiện + nhật ký + thông báo theo vai trò; KHÔNG đổi dữ liệu nghiệp vụ; sự kiện không có tên bệnh nhân', async () => {
    const fp = businessFingerprint();
    expect(await outcome(d.runNow(OA, C.exec))).toBe('FORBIDDEN');
    const r = await d.runNow(OA, C.admin);
    expect(r).toMatchObject({ status: 'success', trigger: 'manual', rulesEvaluated: 5, eventsCreated: 5, suppressed: 0 });
    expect(r.events.map((e) => e.ruleName).sort()).toEqual(['Huỷ phiếu', 'Lệch quỹ', 'Sốt cao', 'SpO₂ thấp', 'Tạm ứng treo'].sort());
    expect(businessFingerprint()).toBe(fp);

    const ev = await d.events({ organizationId: OA }, C.exec);
    const cash = ev.find((e) => e.ruleName === 'Lệch quỹ')!;
    expect(cash.metrics).toMatchObject({ difference_vnd: -50_000, abs_difference_vnd: 50_000 });
    expect(cash.title).toContain('TN Chi');
    expect(ev.find((e) => e.ruleName === 'Tạm ứng treo')!.metrics['held_vnd']).toBe(500_000);
    expect(ev.find((e) => e.ruleName === 'SpO₂ thấp')!.notifications.map((n) => n.targetRole)).toEqual(['clinic_staff', 'doctor']);
    expect(ev.find((e) => e.ruleName === 'Huỷ phiếu')!.notifications).toEqual([]);
    for (const e of ev) expect(`${e.title} ${e.detail ?? ''}`).not.toMatch(/Nguyễn|Hoa[A-F]\b|P[1-6]\b/);

    const actions = await d.actionLog({ organizationId: OA }, C.admin);
    expect(actions.filter((a) => a.actorType === 'engine').map((a) => a.action).sort()).toEqual(
      ['log_only', 'notify_cashier', 'notify_clinic_admin', 'notify_clinic_staff', 'notify_doctor', 'notify_doctor', 'suggest', 'suggest'].sort(),
    );
    const runs = await d.runs({ organizationId: OA }, C.exec);
    expect(runs[0]).toMatchObject({ trigger: 'manual', triggeredByName: 'Quản lý', eventsCreated: 5, status: 'success' });
    expect(runs[0]!.detail.map((x) => x.detector).sort()).toEqual(['cash_difference', 'deposit_aging', 'receipt_cancellations', 'vital_abnormal']);
    const ov = await d.overview(OA, C.exec);
    expect(ov).toMatchObject({ rules: { active: 5, paused: 0 }, events24h: 5, eventsByPriority24h: { p1: 2, p2: 2, p3: 1 }, openNotifications: 4, pendingSuggestions: 2 });
  });

  it('cooldown theo (luật, đối tượng): chạy lại ngay => bị chặn; sau 61 phút chỉ luật cooldown 60 phút báo lại', async () => {
    const again = await d.runNow(OA, C.admin);
    expect(again).toMatchObject({ eventsCreated: 0, suppressed: 5 });
    offsetMs = 61 * 60_000;
    const later = await d.runNow(OA, C.admin);
    expect(later.events.map((e) => e.ruleName)).toEqual(['SpO₂ thấp']);
    expect(later.suppressed).toBe(4);
  });

  it('hộp thông báo: mỗi vai trò chỉ thấy phần của mình; áp dụng gợi ý trả liên kết, không tự sửa gì; vai trò khác vẫn mở', async () => {
    const doc = await d.inbox({ organizationId: OA }, C.doc);
    expect(doc.items.map((i) => i.ruleName).sort()).toEqual(['Sốt cao', 'SpO₂ thấp', 'SpO₂ thấp'].sort());
    expect((await d.inbox({ organizationId: OA }, C.cash)).items.map((i) => i.ruleName)).toEqual(['Tạm ứng treo']);
    expect((await d.inbox({ organizationId: OA }, C.staff)).items.map((i) => i.ruleName)).toEqual(['SpO₂ thấp', 'SpO₂ thấp']);
    expect((await d.inbox({ organizationId: OA }, C.admin)).items.map((i) => i.ruleName)).toEqual(['Lệch quỹ']);
    expect((await d.inbox({ organizationId: OA }, C.exec)).items).toEqual([]);
    expect(await outcome(d.inbox({ organizationId: OA }, C.pharm))).toBe('ORG_NOT_ALLOWED');

    const spo2 = doc.items.find((i) => i.ruleName === 'SpO₂ thấp')!;
    const fever = doc.items.find((i) => i.ruleName === 'Sốt cao')!;
    expect(spo2).toMatchObject({ hasSuggestion: true, suggestionStatus: 'pending', suggestionLabel: 'Mở hồ sơ đợt khám', priority: 1 });
    // Thu ngân không thao tác được thông báo của bác sĩ (coi như không tồn tại).
    expect(await outcome(d.actOnNotification(spo2.notificationId, 'handle', null, spo2.version, C.cash))).toBe('NOT_FOUND');
    expect(await outcome(d.actOnNotification(fever.notificationId, 'apply', null, fever.version, C.doc))).toBe('CONFLICT:NO_PENDING_SUGGESTION');

    const fp = businessFingerprint();
    const a = await d.actOnNotification(spo2.notificationId, 'apply', 'Đã cho thở oxy, khám ngay', spo2.version, C.doc);
    expect(a.link).toBe(`#/encounters/${E.e1}`);
    expect(a.item).toMatchObject({ status: 'handled', suggestionStatus: 'applied', handledByName: 'BS An', handledNote: 'Đã cho thở oxy, khám ngay' });
    expect(businessFingerprint()).toBe(fp);
    expect(await outcome(d.actOnNotification(spo2.notificationId, 'apply', null, spo2.version, C.doc))).toBe('CONFLICT:NO_PENDING_SUGGESTION');
    const h = await d.actOnNotification(fever.notificationId, 'handle', null, fever.version, C.doc);
    expect(h.item?.status).toBe('handled');
    expect(await outcome(d.actOnNotification(fever.notificationId, 'reopen', null, fever.version, C.doc))).toBe('CONFLICT:VERSION_CONFLICT');
    expect((await d.actOnNotification(fever.notificationId, 'reopen', null, h.item!.version, C.doc)).item?.status).toBe('open');

    // Điều dưỡng: thông báo SpO₂ của cùng sự kiện vẫn mở (hộp thư theo vai trò).
    const staff = await d.inbox({ organizationId: OA }, C.staff);
    expect(staff.items.find((i) => i.eventId === spo2.eventId)).toMatchObject({ status: 'open', suggestionStatus: 'pending' });
    const dis = staff.items.find((i) => i.eventId === spo2.eventId)!;
    expect((await d.actOnNotification(dis.notificationId, 'dismiss', 'Bác sĩ đã xử lý', dis.version, C.staff)).item).toMatchObject({ suggestionStatus: 'dismissed', status: 'handled' });

    const log = await d.actionLog({ organizationId: OA }, C.admin);
    expect(log.filter((x) => x.actorType === 'user').map((x) => [x.action, x.actorName])).toEqual([
      ['human_dismissed', 'ĐD Bình'], ['human_reopened', 'BS An'], ['human_handled', 'BS An'], ['human_applied', 'BS An'],
    ]);
    expect((await d.inbox({ organizationId: OA, all: true }, C.doc)).items.some((i) => i.status === 'handled')).toBe(true);
  });

  it('tạm dừng / sửa / xoá mềm có lịch sử phiên bản; luật tạm dừng không chạy', async () => {
    let s = await d.setRuleStatus(rules['spo2']!.ruleId, 'paused', 1, C.admin);
    expect(s).toMatchObject({ status: 'paused', version: 2 });
    expect(await outcome(d.setRuleStatus(rules['spo2']!.ruleId, 'active', 1, C.admin))).toBe('CONFLICT:VERSION_CONFLICT');
    offsetMs = 3 * 3600_000;
    const r = await d.runNow(OA, C.admin);
    expect(r.events.map((e) => e.ruleName)).toEqual(['Sốt cao']);
    s = await d.updateRule(rules['spo2']!.ruleId, { name: 'SpO₂ rất thấp', conditions: [{ metric: 'spo2_pct', op: '<', value: 90 }], priority: 1, cooldownMinutes: 30, actions: ['notify_doctor'] }, 2, C.admin);
    expect(s).toMatchObject({ name: 'SpO₂ rất thấp', version: 3, status: 'paused' });
    await d.setRuleStatus(rules['cash']!.ruleId, 'retired', 1, C.admin);
    expect((await d.listRules(OA, C.admin)).map((x) => x.name)).not.toContain('Lệch quỹ');
    expect(await outcome(d.setRuleStatus(rules['cash']!.ruleId, 'active', 2, C.admin))).toBe('CONFLICT:RULE_RETIRED');
    // Tên của luật đã xoá được dùng lại.
    expect(await outcome(d.createRule({ organizationId: OA, name: 'Lệch quỹ', detector: 'cash_difference', conditions: [{ metric: 'abs_difference_vnd', op: '>=', value: 1 }], priority: 1, cooldownMinutes: 0, actions: ['log_only'] }, C.admin))).toBe('OK');
    const v = await d.ruleVersions(rules['spo2']!.ruleId, C.exec);
    expect(v.map((x) => [x.version, x.status, x.name])).toEqual([[3, 'paused', 'SpO₂ rất thấp'], [2, 'paused', 'SpO₂ thấp'], [1, 'active', 'SpO₂ thấp']]);
    // Sự kiện cũ vẫn trỏ đúng phiên bản luật lúc phát.
    expect((await d.events({ organizationId: OA, detector: 'vital_abnormal', priority: 1 }, C.admin)).every((e) => e.ruleVersion === 1)).toBe(true);
  });

  it('tầng CSDL: sự kiện / nhật ký / lần chạy / lịch sử chỉ thêm; thông báo chỉ đổi trạng thái; RLS theo tenant', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`UPDATE decision.events SET title = 'x'`)).toBe('42501');
      expect(await code(`DELETE FROM decision.events`)).toBe('42501');
      expect(await code(`UPDATE decision.action_log SET note = 'x'`)).toBe('42501');
      expect(await code(`UPDATE decision.job_runs SET status = 'success'`)).toBe('42501');
      expect(await code(`INSERT INTO decision.rule_versions(tenant_id,rule_id,version,name,conditions,priority,cooldown_minutes,actions,status) VALUES ('${TA}','${rules['spo2']!.ruleId}',99,'x','[]',1,0,'{log_only}','active')`)).toBe('42501');
      expect(await code(`UPDATE decision.rule_versions SET name = 'x'`)).toBe('42501');
      expect(await code(`UPDATE decision.notifications SET target_role = 'cashier'`)).toBe('42501');
      expect(await code(`DELETE FROM decision.rules`)).toBe('42501');
      expect(await code(`UPDATE decision.rules SET detector = 'icd_spike'`)).toBe('42501');
      expect(await code(`INSERT INTO decision.rules(tenant_id,organization_id,name,detector,conditions,priority,cooldown_minutes,actions) VALUES ('${TA}','${OA}','abc','vital_abnormal','[{}]',1,0,'{suggest}')`)).toBe('23514');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [uid(999)]);
      expect(await c.query('SELECT count(*) AS n FROM decision.events').then((r) => (r.rows[0] as { n: string }).n)).toBe('0');
    } finally {
      c.close();
    }
  });

  it('khoá chạy: hai lần chạy không chồng nhau; bộ lập lịch chạy bằng tài khoản hệ thống', async () => {
    const c = new PsqlClient({ database: DB });
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('hcos.decision:' || '${TA}' || ':' || '${OA}', 0))`);
      expect(await outcome(d.runNow(OA, C.admin))).toBe('CONFLICT:RUN_IN_PROGRESS');
      expect(await d.runScheduled(TA, OA)).toBeNull();
      await c.query('ROLLBACK');
    } finally {
      c.close();
    }
    offsetMs = 10 * 3600_000;
    const sched = new DecisionScheduler({ pool: psqlPool({ database: DB }), engine: d, intervalMs: 60_000 });
    await sched.tick();
    const runs = await d.runs({ organizationId: OA, limit: 1 }, C.admin);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', triggeredByName: null, status: 'success' });
    // OB không có luật => không chạy.
    expect(su(`SELECT count(*) FROM decision.job_runs WHERE organization_id = '${OB}'`)).toBe('0');
  });
});
