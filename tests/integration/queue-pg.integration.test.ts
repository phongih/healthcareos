/**
 * HCOS-F6 | Hàng đợi khám trên PostgreSQL thật (migration 010): cấp số nguyên tử, ưu tiên, gọi đồng thời,
 * gọi lại / vắng mặt / đưa lại hàng chờ, bắt đầu khám tạo đợt khám, màn hình công khai không lộ dữ liệu bệnh nhân,
 * ràng buộc DB khi đi vòng service, RLS.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGUSER=<superuser> vitest run tests/integration/queue-pg.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asTenantId, asUserId,
  type CorrelationId, type OrganizationId, type TenantContext, type TenantId, type UserId,
} from '../../packages/domain/src/s0-contracts';
import { PgQueueBoard, PgQueueUnitOfWork, QueueService } from '../../services/api/src/clinical/queue.service';
import { PsqlClient, psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_queue_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const U = { doc: asUserId(uid(101)), doc2: asUserId(uid(102)), staff: asUserId(uid(103)), admin: asUserId(uid(104)) };
const PAT = (i: number) => uid(1000 + i);
const N = 16;

const ctx = (t: TenantId, u: UserId, orgs: OrganizationId[]): TenantContext =>
  Object.freeze({
    tenantId: t, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'it-queue' as CorrelationId,
  });
const C = { doc: ctx(TA, U.doc, [OA]), doc2: ctx(TA, U.doc2, [OA]), staff: ctx(TA, U.staff, [OA]), admin: ctx(TA, U.admin, [OA]) };

const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const suFile = (f: string) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', f], { encoding: 'utf8' });

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','Phòng khám A');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${U.doc}','${TA}','sub-${U.doc}','BS Một'),('${U.doc2}','${TA}','sub-${U.doc2}','BS Hai'),
  ('${U.staff}','${TA}','sub-${U.staff}','Lễ tân'),('${U.admin}','${TA}','sub-${U.admin}','Quản lý');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${U.doc}','${OA}','doctor'),('${TA}','${U.doc2}','${OA}','doctor'),
  ('${TA}','${U.staff}','${OA}','clinic_staff'),('${TA}','${U.admin}','${OA}','clinic_admin');
INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${TA}', 'Bệnh nhân ' || g, 'Thử' FROM generate_series(1, ${N}) g;
INSERT INTO patient.patients(patient_id,tenant_id,person_id,organization_id,mrn)
  SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(1000 + g), 12, '0'))::uuid, '${TA}',
         ('00000000-0000-4000-8000-' || lpad(to_hex(2000 + g), 12, '0'))::uuid, '${OA}', 'Q' || lpad(g::text, 4, '0')
    FROM generate_series(1, ${N}) g;
`;

const outcome = (p: Promise<unknown>) =>
  p.then(() => 'OK', (e: { code?: string; details?: { reason?: string } }) => (e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? 'ERR'));

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('Hàng đợi khám / PostgreSQL', () => {
  let q: QueueService;
  let board: PgQueueBoard;
  let r1: string;
  let r2: string;

  beforeAll(async () => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) suFile(`${MIG}/${f}`);
    su(SEED);
    const pool = psqlPool({ database: DB });
    q = new QueueService({ uow: new PgQueueUnitOfWork(pool), audit: { record: async () => {} } });
    board = new PgQueueBoard(pool);
  });

  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('phòng khám: chỉ quản lý tạo được; mã trùng => CONFLICT', async () => {
    expect(await outcome(q.createServicePoint({ organizationId: OA, code: 'N1', name: 'Nội 1' }, C.doc))).toBe('FORBIDDEN');
    r1 = (await q.createServicePoint({ organizationId: OA, code: 'n1', name: 'Phòng Nội 1' }, C.admin)).servicePointId;
    r2 = (await q.createServicePoint({ organizationId: OA, code: 'N2', name: 'Phòng Nội 2' }, C.admin)).servicePointId;
    expect(await outcome(q.createServicePoint({ organizationId: OA, code: 'N1', name: 'Trùng' }, C.admin))).toBe('CONFLICT:SERVICE_POINT_CODE_TAKEN');
    expect((await q.listServicePoints(OA, C.doc)).map((s) => s.code)).toEqual(['N1', 'N2']);
  });

  it('cấp số: lễ tân cấp, bác sĩ không; số tăng theo phòng; một bệnh nhân một phiếu còn hiệu lực', async () => {
    expect(await outcome(q.issueTicket({ servicePointId: r1, patientId: PAT(1) }, C.doc))).toBe('FORBIDDEN');
    const a = await q.issueTicket({ servicePointId: r1, patientId: PAT(1) }, C.staff);
    const b = await q.issueTicket({ servicePointId: r1, patientId: PAT(2), priorityReason: 'elderly_75' }, C.staff);
    const c = await q.issueTicket({ servicePointId: r1, patientId: PAT(3), priorityReason: 'emergency' }, C.staff);
    const d = await q.issueTicket({ servicePointId: r2, patientId: PAT(4) }, C.staff);
    expect([a.displayNo, b.displayNo, c.displayNo, d.displayNo]).toEqual(['N1-001', 'N1-002', 'N1-003', 'N2-001']);
    expect(a.patient).toMatchObject({ mrn: 'Q0001', givenName: 'Bệnh nhân 1' });
    expect(await outcome(q.issueTicket({ servicePointId: r2, patientId: PAT(1) }, C.staff))).toBe('CONFLICT:PATIENT_ALREADY_QUEUED');
    expect(await outcome(q.issueTicket({ servicePointId: r1, patientId: PAT(5), priorityReason: 'vip' }, C.staff))).toBe('VALIDATION');
  });

  it('cấp số ĐỒNG THỜI: số không trùng, liên tiếp', async () => {
    const results = await Promise.all([6, 7, 8, 9, 10, 11].map((i) => q.issueTicket({ servicePointId: r2, patientId: PAT(i) }, C.staff)));
    expect(results.map((t) => t.ticketNo).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('gọi số: cấp cứu trước, rồi ưu tiên, rồi theo số; hai bác sĩ gọi đồng thời nhận hai số khác nhau', async () => {
    const first = await q.callNext(r1, C.doc);
    expect(first?.displayNo).toBe('N1-003');
    const [x, y] = await Promise.all([q.callNext(r1, C.doc), q.callNext(r1, C.doc2)]);
    expect(new Set([x?.displayNo, y?.displayNo])).toEqual(new Set(['N1-002', 'N1-001']));
    expect(await q.callNext(r1, C.doc)).toBeNull();
    expect(await outcome(q.callNext(r1, C.staff))).toBe('FORBIDDEN');
  });

  it('gọi lại / vắng mặt chỉ bởi người đã gọi; lễ tân đưa lại hàng chờ, huỷ', async () => {
    const mine = (await q.listToday({ organizationId: OA, servicePointId: r1 }, C.doc)).find((t) => t.status === 'called' && t.calledByUserId === U.doc && t.ticketNo !== 3)!;
    expect(await outcome(q.recallTicket(mine.ticketId, C.doc2))).toBe('INVALID_STATE:TICKET_CALLED_BY_OTHER');
    expect((await q.recallTicket(mine.ticketId, C.doc)).calledCount).toBe(2);
    expect((await q.skipTicket(mine.ticketId, C.doc)).status).toBe('skipped');
    expect(await outcome(q.requeueTicket(mine.ticketId, C.doc))).toBe('FORBIDDEN');
    expect((await q.requeueTicket(mine.ticketId, C.staff)).status).toBe('waiting');
    expect((await q.callNext(r1, C.doc2))?.ticketId).toBe(mine.ticketId);
    const w = await q.issueTicket({ servicePointId: r1, patientId: PAT(12) }, C.staff);
    expect((await q.cancelTicket(w.ticketId, C.staff)).status).toBe('cancelled');
    // Sau khi huỷ, bệnh nhân được cấp số mới.
    expect((await q.issueTicket({ servicePointId: r1, patientId: PAT(12) }, C.staff)).displayNo).toBe('N1-005');
  });

  it('bắt đầu khám: tạo đợt khám (bác sĩ phụ trách = người gọi), phiếu chuyển "đang khám" kèm đợt khám', async () => {
    const em = (await q.listToday({ organizationId: OA, servicePointId: r1 }, C.doc)).find((t) => t.ticketNo === 3)!;
    expect(await outcome(q.startTicket(em.ticketId, {}, C.doc2))).toBe('INVALID_STATE:TICKET_CALLED_BY_OTHER');
    const r = await q.startTicket(em.ticketId, { reasonText: 'Khó thở' }, C.doc);
    expect(r.ticket.status).toBe('in_service');
    expect(su(`SELECT status || '|' || practitioner_user_id || '|' || reason_text FROM clinical.encounters WHERE encounter_id='${r.encounterId}'`))
      .toBe(`in_progress|${U.doc}|Khó thở`);
    expect(await outcome(q.startTicket(em.ticketId, {}, C.doc))).toBe('INVALID_STATE:TICKET_NOT_CALLED');
  });

  it('màn hình công khai: khoá đúng => chỉ số + phòng (không tên, không MRN); khoá sai / đã thu hồi => null', async () => {
    expect(await outcome(q.createDisplay({ organizationId: OA, name: 'Sảnh' }, C.staff))).toBe('FORBIDDEN');
    const { display, key } = await q.createDisplay({ organizationId: OA, name: 'Sảnh chờ' }, C.admin);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(su(`SELECT count(*) FROM clinical.queue_displays WHERE key_hash = sha256(convert_to('${key}', 'UTF8'))`)).toBe('1');
    const b = await board.read(key);
    expect(b?.displayName).toBe('Sảnh chờ');
    expect(b?.organizationName).toBe('Phòng khám A');
    expect(b?.called.length).toBeGreaterThan(0);
    expect(b?.waiting.map((w) => w.displayNo)).toContain('N2-001');
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/Q000|Bệnh nhân|Thử/);
    expect(await board.read('x'.repeat(43))).toBeNull();
    await q.revokeDisplay(display.displayId, OA, C.admin);
    expect(await board.read(key)).toBeNull();
  });

  it('DB chặn khi đi vòng service: chuyển trạng thái sai, sửa nội dung, xoá; RLS theo tenant', async () => {
    const c = new PsqlClient({ database: DB });
    const code = (sql: string) => c.query(sql).then(() => 'OK', (e: { code?: string }) => e.code);
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
      const waiting = su(`SELECT ticket_id FROM clinical.queue_tickets WHERE status='waiting' LIMIT 1`);
      expect(await code(`UPDATE clinical.queue_tickets SET status='in_service' WHERE ticket_id='${waiting}'`)).toBe('55000');
      expect(await code(`UPDATE clinical.queue_tickets SET status='skipped' WHERE ticket_id='${waiting}'`)).toBe('55000');
      expect(await code(`UPDATE clinical.queue_tickets SET ticket_no = 99 WHERE ticket_id='${waiting}'`)).toBe('42501');
      expect(await code(`UPDATE clinical.queue_tickets SET priority_reason = 'emergency' WHERE ticket_id='${waiting}'`)).toBe('42501');
      expect(await code(`DELETE FROM clinical.queue_tickets WHERE ticket_id='${waiting}'`)).toBe('42501');
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [TB]);
      expect((await c.query(`SELECT 1 FROM clinical.queue_tickets`)).rows).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
