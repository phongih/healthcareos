/**
 * HCOS-F12 | Hạ tầng tích hợp trên PostgreSQL thật (migration 015) với lớp gửi giả lập:
 * tạo kết nối (URL mã hoá), Decision Engine → outbox → giao (Teams Adaptive Card / webhook HMAC), lọc mức ưu tiên,
 * thử lại theo lịch, lỗi vĩnh viễn, tự tạm dừng + báo sự cố qua kết nối khác, gửi thử / gửi lại, bật lại huỷ tin cũ,
 * không lộ dữ liệu bệnh nhân, chỉ-thêm + RLS, tắt khi thiếu khoá.
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId, type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId } from '../../packages/domain/src/s0-contracts';
import { DecisionEngineService, PgDecisionUnitOfWork } from '../../services/api/src/decision/decision.service';
import { AUTO_PAUSE_AFTER, enqueueOutbox, IntegrationDispatcher, IntegrationService, PgIntegrationUnitOfWork } from '../../services/api/src/integration/integration.service';
import { SecretBox } from '../../services/api/src/integration/secrets';
import type { OutboundRequest, OutboundResult, Transport } from '../../services/api/src/integration/transport';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_integrations_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const OA = asOrganizationId(uid(11));
const OB = asOrganizationId(uid(12));
const U = { admin: asUserId(uid(101)), exec: asUserId(uid(102)), doc: asUserId(uid(103)) };
const ENC = uid(5001);
const ctx = (u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: TA as TenantId, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-int' as CorrelationId,
  });
const C = { admin: ctx(U.admin, [OA, OB]), exec: ctx(U.exec, [OA]), doc: ctx(U.doc, [OA]) };
const TEAMS = 'https://prod-27.southeastasia.logic.azure.com:443/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRETSIG123';
const HOOK = 'https://partner.example.vn/hooks/hcos';

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const outcome = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

/** Lớp gửi giả: ghi lại yêu cầu, trả kết quả theo host. */
const sent: OutboundRequest[] = [];
const replies = new Map<string, OutboundResult>();
const fake: Transport = async (r) => {
  sent.push(r);
  return replies.get(new URL(r.url).host) ?? { status: 202, error: null, retryAfterSec: null, durationMs: 3 };
};

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Integrations / PostgreSQL', () => {
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  let svc: IntegrationService;
  let dec: DecisionEngineService;
  let disp: IntegrationDispatcher;
  const ids: Record<string, string> = {};
  let hookSecret = '';

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const x of readdirSync(MIG).filter((y) => /^\d+_.+\.sql$/.test(y)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${x}`]);
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB], {
      encoding: 'utf8',
      input: `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','Phòng khám A'),('${OB}','${TA}','clinic','c2','Phòng khám B');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES ('${U.admin}','${TA}','sub-${U.admin}','Quản lý'),('${U.exec}','${TA}','sub-${U.exec}','GĐ'),('${U.doc}','${TA}','sub-${U.doc}','BS An');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES ('${TA}','${U.admin}','${OA}','clinic_admin'),('${TA}','${U.admin}','${OB}','clinic_admin'),('${TA}','${U.exec}','${OA}','executive'),('${TA}','${U.doc}','${OA}','doctor');
UPDATE iam.memberships SET valid_from = '2026-01-01';
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name) VALUES ('${uid(2001)}','${TA}','Hoa','Nguyễn Thị');
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn) VALUES ('${uid(1001)}','${TA}','${uid(2001)}','${OA}','MRN777');
INSERT INTO clinical.encounters(encounter_id,tenant_id,patient_id,organization_id,practitioner_user_id,status,encounter_class,period_start)
  VALUES ('${ENC}','${TA}','${uid(1001)}','${OA}','${U.doc}','in_progress','ambulatory',now() - interval '1 hour');
INSERT INTO clinical.observations(observation_id,tenant_id,patient_id,encounter_id,code_system,code,display,value_numeric,value_unit,effective_at,recorded_by_user_id) VALUES
  (gen_random_uuid(),'${TA}','${uid(1001)}','${ENC}','http://loinc.org','59408-5','SpO₂',88,'%',now() - interval '5 minutes','${U.doc}'),
  (gen_random_uuid(),'${TA}','${uid(1001)}','${ENC}','http://loinc.org','8310-5','Nhiệt độ',38.6,'Cel',now() - interval '5 minutes','${U.doc}');`,
    });
    const pool = psqlPool({ database: DB });
    const audit = { record: async () => {} };
    svc = new IntegrationService({ uow: new PgIntegrationUnitOfWork(pool), audit, box: new SecretBox(randomBytes(32)), transport: fake, clock, publicBaseUrl: 'https://smart.id.vn' });
    dec = new DecisionEngineService({ uow: new PgDecisionUnitOfWork(pool), audit, clock });
    disp = new IntegrationDispatcher({ pool, service: svc, intervalMs: 0, clock });
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('tạo kết nối: chỉ quản lý; URL kiểm tra và mã hoá; bí mật ký trả đúng một lần', async () => {
    const base = { organizationId: OA, kind: 'teams_workflow' as const, name: 'Kênh trực ban', url: TEAMS, eventTypes: ['decision.event', 'system.alert'], maxPriority: 1 };
    expect(await outcome(svc.createEndpoint(base, C.exec))).toBe('FORBIDDEN');
    expect(await outcome(svc.createEndpoint(base, C.doc))).toBe('FORBIDDEN');
    expect(await outcome(svc.createEndpoint({ ...base, url: 'https://evil.example.com/workflows/x?sig=1' }, C.admin))).toBe('VALIDATION:INVALID_URL');
    expect(await outcome(svc.createEndpoint({ ...base, eventTypes: ['patient.read'] }, C.admin))).toBe('VALIDATION:INVALID_ENDPOINT');
    expect(await outcome(svc.createEndpoint({ ...base, kind: 'webhook', url: 'https://10.0.0.9/h' }, C.admin))).toBe('VALIDATION:INVALID_URL');
    const t = await svc.createEndpoint(base, C.admin);
    expect(t.signingSecret).toBeNull();
    expect(t.endpoint).toMatchObject({ kind: 'teams_workflow', status: 'active', urlHint: 'prod-27.southeastasia.logic.azure.com/…G123', maxPriority: 1, createdByName: 'Quản lý' });
    expect(JSON.stringify(t)).not.toContain('SECRETSIG');
    ids['teams'] = t.endpoint.endpointId;
    const h = await svc.createEndpoint({ ...base, kind: 'webhook', name: 'Đối tác BI', url: HOOK, maxPriority: 3 }, C.admin);
    expect(h.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    hookSecret = h.signingSecret!;
    ids['hook'] = h.endpoint.endpointId;
    expect(await outcome(svc.createEndpoint({ ...base, name: 'kênh TRỰC BAN' }, C.admin))).toBe('CONFLICT:ENDPOINT_NAME_TAKEN');
    // Bản ghi trong CSDL không có URL / bí mật dạng rõ.
    const raw = su(`SET ROLE postgres; SELECT url_ciphertext || coalesce(secret_ciphertext,'') FROM integration.endpoints`);
    expect(raw).not.toContain('logic.azure');
    expect(raw).not.toContain('partner.example');
    expect(raw).not.toContain(hookSecret);
    expect((await svc.listEndpoints(OA, C.exec)).map((e) => e.name).sort()).toEqual(['Kênh trực ban', 'Đối tác BI'].sort());
    expect(await outcome(svc.listEndpoints(OA, C.doc))).toBe('FORBIDDEN');
  });

  it('Decision Engine → outbox (cùng transaction) → giao theo mức ưu tiên của từng kết nối', async () => {
    await dec.createRule({ organizationId: OA, name: 'SpO₂ thấp', detector: 'vital_abnormal', conditions: [{ metric: 'spo2_pct', op: '<', value: 92 }], priority: 1, cooldownMinutes: 60, actions: ['notify_doctor'] }, C.admin);
    await dec.createRule({ organizationId: OA, name: 'Sốt', detector: 'vital_abnormal', conditions: [{ metric: 'temperature_c', op: '>=', value: 38.5 }], priority: 2, cooldownMinutes: 60, actions: ['log_only'] }, C.admin);
    const run1 = await dec.runNow(OA, C.admin);
    expect(run1.eventsCreated).toBe(2);
    // Teams (max P1) nhận 1; webhook (max P3) nhận 2.
    expect(su(`SET ROLE postgres; SELECT count(*) FROM integration.outbox WHERE event_type = 'decision.event'`)).toBe('2');
    expect(su(`SET ROLE postgres; SELECT count(*) FROM integration.deliveries WHERE endpoint_id = '${ids['teams']}'`)).toBe('1');
    expect(su(`SET ROLE postgres; SELECT count(*) FROM integration.deliveries WHERE endpoint_id = '${ids['hook']}'`)).toBe('2');
    // Không có dữ liệu bệnh nhân / mã đợt khám trong outbox.
    const payloads = su(`SET ROLE postgres; SELECT string_agg(payload::text, ' ') FROM integration.outbox`);
    for (const pii of ['Nguyễn', 'Hoa', 'MRN777', ENC, uid(1001)]) expect(payloads).not.toContain(pii);

    await disp.tick();
    expect(sent.length).toBe(3);
    const teams = sent.find((s) => s.url.includes('logic.azure'))!;
    expect(teams.url).toBe(TEAMS.replace(':443', ''));
    const card = JSON.parse(teams.body) as { attachments: Array<{ content: { body: Array<{ text?: string }>; actions: Array<{ url: string }> } }> };
    expect(card.attachments[0]!.content.body[0]!.text).toContain('P1 KHẨN');
    expect(card.attachments[0]!.content.body[1]!.text).toContain('SpO₂ 88');
    expect(card.attachments[0]!.content.actions[0]!.url).toBe('https://smart.id.vn/app/#/inbox');
    expect(teams.headers['x-hcos-signature']).toBeUndefined();
    for (const s of sent) for (const pii of ['Nguyễn', 'MRN777', ENC]) expect(s.body).not.toContain(pii);
    // Webhook: chữ ký kiểm được bằng bí mật đã nhận.
    const hook = sent.find((s) => s.url === HOOK)!;
    expect(hook.headers['x-hcos-signature']).toBe(`v1=${createHmac('sha256', hookSecret).update(`${hook.headers['x-hcos-timestamp']}.${hook.body}`).digest('hex')}`);
    expect(JSON.parse(hook.body)).toMatchObject({ type: 'decision.event', organizationId: OA, data: { organizationName: 'Phòng khám A' } });
    const d = await svc.deliveries({ organizationId: OA }, C.exec);
    expect(d.every((x) => x.status === 'succeeded' && x.attempts === 1)).toBe(true);
    // Gửi không làm đổi phiên bản cấu hình (quản lý vẫn sửa / tạm dừng được kết nối đang bận gửi).
    const after = await svc.listEndpoints(OA, C.admin);
    expect(after.map((e) => e.version)).toEqual([1, 1]);
    expect(after.every((e) => e.lastSuccessAt !== null && e.consecutiveFailures === 0)).toBe(true);
    // Chạy lại bộ giao: không gửi trùng.
    await disp.tick();
    expect(sent.length).toBe(3);
  });

  it('lỗi tạm thời: thử lại 1 phút → 5 phút…; lỗi vĩnh viễn: dừng ngay; gửi lại tay', async () => {
    sent.length = 0;
    replies.set('partner.example.vn', { status: 503, error: null, retryAfterSec: null, durationMs: 4 });
    replies.set('prod-27.southeastasia.logic.azure.com', { status: 404, error: null, retryAfterSec: null, durationMs: 4 });
    offsetMs = 2 * 3600_000; // hết cooldown
    await dec.runNow(OA, C.admin);
    await disp.tick();
    const d1 = await svc.deliveries({ organizationId: OA, status: 'pending' }, C.admin);
    expect(d1.length).toBe(2);
    expect(d1.every((x) => x.attempts === 1 && x.lastStatusCode === 503 && x.lastError === 'HTTP_503')).toBe(true);
    const dead = await svc.deliveries({ organizationId: OA, endpointId: ids['teams']!, status: 'dead' }, C.admin);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ lastStatusCode: 404, lastError: 'HTTP_404', attempts: 1 });
    // Chưa tới hạn: không gửi lại.
    const n0 = sent.length;
    await disp.tick();
    expect(sent.length).toBe(n0);
    offsetMs += 61_000;
    await disp.tick();
    const d2 = await svc.deliveries({ organizationId: OA, status: 'pending' }, C.admin);
    expect(d2.every((x) => x.attempts === 2)).toBe(true);
    const nextIn = Date.parse(d2[0]!.nextAttemptAt!) - clock().getTime();
    expect(nextIn).toBeGreaterThan(290_000);
    expect(nextIn).toBeLessThan(300_001);
    const att = await svc.deliveryAttempts(d2[0]!.deliveryId, C.exec);
    expect(att.map((a) => [a.attemptNo, a.outcome, a.statusCode, a.trigger])).toEqual([[1, 'retry', 503, 'dispatcher'], [2, 'retry', 503, 'dispatcher']]);
    // Phía Teams đã sửa => gửi lại tay lượt "dead".
    replies.delete('prod-27.southeastasia.logic.azure.com');
    expect(await outcome(svc.retryDelivery(dead[0]!.deliveryId, C.exec))).toBe('FORBIDDEN');
    const rr = await svc.retryDelivery(dead[0]!.deliveryId, C.admin);
    expect(rr).toMatchObject({ outcome: 'success', statusCode: 202 });
    expect((await svc.deliveryAttempts(dead[0]!.deliveryId, C.admin)).map((a) => [a.outcome, a.trigger, a.actorName])).toEqual([['dead', 'dispatcher', null], ['success', 'manual', 'Quản lý']]);
    expect(await outcome(svc.retryDelivery(dead[0]!.deliveryId, C.admin))).toBe('CONFLICT:NOT_RETRYABLE');
  });

  it(`lỗi liên tiếp ${AUTO_PAUSE_AFTER} lần => tự tạm dừng + báo sự cố qua kết nối còn lại; bật lại huỷ tin cũ`, async () => {
    // Webhook đang lỗi 503: đẩy thêm sự kiện để đủ số lần lỗi liên tiếp.
    let guard = 0;
    while ((await svc.listEndpoints(OA, C.admin)).find((e) => e.endpointId === ids['hook'])!.status === 'active' && guard++ < 40) {
      offsetMs += 25 * 3600_000;
      await dec.runNow(OA, C.admin);
      await disp.tick();
    }
    const hook = (await svc.listEndpoints(OA, C.admin)).find((e) => e.endpointId === ids['hook'])!;
    expect(hook).toMatchObject({ status: 'paused', pausedReason: 'auto_failures' });
    expect(hook.consecutiveFailures).toBeGreaterThan(AUTO_PAUSE_AFTER - 1);
    // Teams nhận thẻ "sự cố hệ thống"; webhook bị dừng không tự báo cho chính nó.
    expect(su(`SET ROLE postgres; SELECT count(*) FROM integration.outbox o JOIN integration.deliveries d USING (event_id) WHERE o.event_type = 'system.alert' AND d.endpoint_id = '${ids['teams']}'`)).toBe('1');
    expect(su(`SET ROLE postgres; SELECT count(*) FROM integration.outbox o JOIN integration.deliveries d USING (event_id) WHERE o.event_type = 'system.alert' AND d.endpoint_id = '${ids['hook']}'`)).toBe('0');
    sent.length = 0;
    await disp.tick();
    const alert = sent.find((s) => s.body.includes('bị tự tạm dừng'));
    expect(alert && JSON.parse(alert.body).attachments[0].content.body[1].text).toContain('Đối tác BI');
    // Kết nối tạm dừng: bộ giao bỏ qua.
    expect(sent.some((s) => s.url === HOOK)).toBe(false);
    // Bật lại sau 2 ngày: lượt tồn đọng > 24 giờ bị huỷ; bộ đếm lỗi về 0.
    replies.delete('partner.example.vn');
    offsetMs += 48 * 3600_000;
    const r = await svc.setEndpointStatus(ids['hook']!, 'active', hook.version, C.admin);
    expect(r.cancelledStale).toBeGreaterThan(0);
    expect(r.endpoint).toMatchObject({ status: 'active', pausedReason: null, consecutiveFailures: 0 });
    const h = await svc.endpointHistory(ids['hook']!, C.exec);
    expect(h.map((x) => [x.status, x.pausedReason])).toEqual([['active', null], ['paused', 'auto_failures'], ['active', null]]);
  });

  it('gửi thử; sửa URL / đổi bí mật có lịch sử; xoá mềm; Teams P1 không nhận P2', async () => {
    sent.length = 0;
    const t = await svc.testEndpoint(ids['teams']!, C.admin);
    expect(t).toMatchObject({ outcome: 'success', statusCode: 202 });
    const card = JSON.parse(sent[0]!.body);
    expect(card.attachments[0].content.body[0].text).toContain('TEST');
    expect(card.attachments[0].content.body[1].text).toContain('Kênh trực ban');
    expect(await outcome(svc.testEndpoint(ids['teams']!, C.exec))).toBe('FORBIDDEN');
    const ep = (await svc.listEndpoints(OA, C.admin)).find((e) => e.endpointId === ids['hook'])!;
    const u = await svc.updateEndpoint(ids['hook']!, { name: 'Đối tác BI', url: 'https://partner2.example.vn/h', eventTypes: ['decision.event'], maxPriority: 2, rotateSecret: true }, ep.version, C.admin);
    expect(u.signingSecret).toMatch(/^whsec_/);
    expect(u.signingSecret).not.toBe(hookSecret);
    expect(u.endpoint).toMatchObject({ urlHint: 'partner2.example.vn/…evnh', eventTypes: ['decision.event'], maxPriority: 2 });
    expect((await svc.endpointHistory(ids['hook']!, C.admin))[0]).toMatchObject({ urlChanged: true, secretRotated: true });
    expect(await outcome(svc.updateEndpoint(ids['hook']!, { name: 'x y z', eventTypes: ['decision.event'], maxPriority: 2 }, ep.version, C.admin))).toBe('CONFLICT:VERSION_CONFLICT');
    await svc.setEndpointStatus(ids['hook']!, 'retired', u.endpoint.version, C.admin);
    expect((await svc.listEndpoints(OA, C.admin)).map((e) => e.endpointId)).toEqual([ids['teams']]);
    expect(await outcome(svc.testEndpoint(ids['hook']!, C.admin))).toBe('CONFLICT:ENDPOINT_RETIRED');
    // Sự kiện P2 / P3 không tới Teams (max P1); P1 thì tới.
    const uow = new PgIntegrationUnitOfWork(psqlPool({ database: DB }));
    const at = clock();
    const r2 = await uow.run(C.admin, (repo) => enqueueOutbox(repo.scopedDb, repo.tenant, { organizationId: OA, type: 'decision.event', priority: 2, at, payload: { title: 'P2' } }));
    expect(r2).toEqual({ eventId: null, deliveryIds: [] });
    const r3 = await uow.run(C.admin, (repo) => enqueueOutbox(repo.scopedDb, repo.tenant, { organizationId: OA, type: 'decision.event', priority: 1, at, payload: { title: 'P1' } }));
    expect(r3.deliveryIds).toHaveLength(1);
    // Cơ sở khác không nhận.
    expect((await uow.run(C.admin, (repo) => enqueueOutbox(repo.scopedDb, repo.tenant, { organizationId: OB, type: 'decision.event', priority: 1, at, payload: {} }))).deliveryIds).toEqual([]);
  });

  it('tầng CSDL: outbox / nhật ký gửi / lịch sử chỉ thêm; lượt giao xong không đổi được; RLS', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      expect(await code(`UPDATE integration.outbox SET priority = 1`)).toBe('42501');
      expect(await code(`DELETE FROM integration.outbox`)).toBe('42501');
      expect(await code(`UPDATE integration.delivery_attempts SET outcome = 'success'`)).toBe('42501');
      expect(await code(`UPDATE integration.endpoint_history SET name = 'x'`)).toBe('42501');
      expect(await code(`DELETE FROM integration.endpoints`)).toBe('42501');
      expect(await code(`UPDATE integration.endpoints SET kind = CASE kind WHEN 'webhook' THEN 'teams_workflow' ELSE 'webhook' END`)).toBe('42501');
      expect(await code(`UPDATE integration.endpoint_health SET endpoint_id = gen_random_uuid()`)).toBe('42501');
      expect(await code(`DELETE FROM integration.endpoint_health`)).toBe('42501');
      expect(await code(`UPDATE integration.deliveries SET status = 'pending' WHERE status = 'succeeded'`)).toBe('55000');
      expect(await code(`INSERT INTO integration.endpoints(tenant_id,organization_id,kind,name,url_ciphertext,url_hint,event_types) VALUES ('${TA}','${OA}','teams_workflow','abc','https://plain.example/x','h','{decision.event}')`)).toBe('23514');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [uid(999)]);
      expect(await c.query('SELECT count(*) AS n FROM integration.deliveries').then((r) => (r.rows[0] as { n: string }).n)).toBe('0');
    } finally {
      c.close();
    }
  });

  it('thiếu khoá mã hoá => không tạo / gửi thử được, báo rõ', async () => {
    const off = new IntegrationService({ uow: new PgIntegrationUnitOfWork(psqlPool({ database: DB })), audit: { record: async () => {} }, box: null, transport: fake, clock });
    expect(off.catalog().enabled).toBe(false);
    expect(await outcome(off.createEndpoint({ organizationId: OA, kind: 'teams_workflow', name: 'abc', url: TEAMS, eventTypes: ['system.alert'], maxPriority: 1 }, C.admin))).toBe('CONFLICT:INTEGRATION_DISABLED');
    expect(await outcome(off.testEndpoint(ids['teams']!, C.admin))).toBe('CONFLICT:INTEGRATION_DISABLED');
    expect((await off.overview(OA, C.exec)).enabled).toBe(false);
  });
});
