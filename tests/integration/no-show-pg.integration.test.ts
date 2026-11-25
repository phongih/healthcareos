/**
 * Job đánh dấu vắng lịch hẹn trên PostgreSQL thật (role ứng dụng, RLS):
 * lịch "Đã đặt" của ngày đã qua (giờ VN) => no_show; lịch hôm nay / đã huỷ / đã check-in giữ nguyên;
 * mọi tenant đang hoạt động; audit theo cơ sở chỉ có số lượng; chạy lại không đổi thêm.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NoShowJob, vnToday } from '../../services/api/src/clinical/no-show.job';
import { psqlPool } from './psql-pool';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_noshow_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [TA, TB, OA, OB, NA, NB] = [uid(1), uid(2), uid(11), uid(13), uid(21), uid(23)];
const su = (sql: string, db = DB) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

// 23:30 giờ VN ngày D => "hôm nay" là D (không phải D+1 theo UTC... và không phải D-1).
const NOW = new Date('2026-11-25T16:30:00Z'); // = 23:30 ngày 25/11 giờ VN
const TODAY = '2026-11-25';
const Y = addDays(TODAY, -1);

run('Job vắng lịch hẹn / PostgreSQL', () => {
  beforeAll(() => {
    su(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    const bk = (id: number, t: string, o: string, sp: string, day: string, period: string, extra = '') =>
      `INSERT INTO clinical.bookings(booking_id,tenant_id,organization_id,service_point_id,visit_date,period,code_hash,family_name,given_name,birth_date,sex,phone_enc,phone_bidx,phone_hint,consent_version,consent_at${extra ? ',status,cancelled_by,cancelled_at' : ''})
        VALUES ('${uid(id)}','${t}','${o}','${sp}','${day}','${period}',sha256(convert_to('C${id}','UTF8')),'T','K','1990-01-01','male','e1.1.' || repeat('A', 40), md5('p${id}'), '090****0${id % 10}','2026-11',now()${extra});`;
    su(`
      INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('${TA}','ta','A'),('${TB}','tb','B');
      INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','PK A'),('${OB}','${TB}','clinic','c3','PK B');
      INSERT INTO clinical.service_points(service_point_id,tenant_id,organization_id,code,name) VALUES ('${NA}','${TA}','${OA}','N1','Nội 1'),('${NB}','${TB}','${OB}','N1','Nội 1');
      BEGIN;
      INSERT INTO clinical.booking_counters(tenant_id,service_point_id,visit_date,period,booked) VALUES
        ('${TA}','${NA}','${Y}','morning',2),('${TA}','${NA}','${Y}','afternoon',1),('${TA}','${NA}','${TODAY}','morning',1),('${TB}','${NB}','${addDays(TODAY, -10)}','morning',1);
      ${bk(101, TA, OA, NA, Y, 'morning')}
      ${bk(102, TA, OA, NA, Y, 'morning')}
      ${bk(103, TA, OA, NA, Y, 'afternoon')}
      ${bk(104, TA, OA, NA, TODAY, 'morning')}
      ${bk(105, TA, OA, NA, Y, 'morning', ",'cancelled','patient',now()")}
      ${bk(201, TB, OB, NB, addDays(TODAY, -10), 'morning')}
      COMMIT;
    `);
  });
  afterAll(() => {
    try { su(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
  });

  it('ngày theo giờ VN', () => {
    expect(vnToday(NOW)).toBe(TODAY);
    expect(vnToday(new Date('2026-11-25T17:00:00Z'))).toBe('2026-11-26');
  });

  it('đánh dấu lịch đã qua của mọi tenant; giữ lịch hôm nay / đã huỷ; audit chỉ số lượng; chạy lại không đổi', async () => {
    const job = new NoShowJob({ pool: psqlPool({ database: DB }), intervalMs: 0, clock: () => NOW });
    const a = await job.runTenant(TA);
    expect(a).toEqual({ tenantId: TA, marked: 3, byOrganization: { [OA]: 3 }, before: TODAY });
    expect(su(`SELECT string_agg(right(booking_id::text, 3) || ':' || status, ',' ORDER BY booking_id) FROM clinical.bookings WHERE tenant_id = '${TA}'`))
      .toBe('065:no_show,066:no_show,067:no_show,068:booked,069:cancelled');
    expect(su(`SELECT actor_type || '|' || actor_id || '|' || payload::text FROM platform.audit_events WHERE action = 'booking.no_show'`))
      .toBe(`service|no-show|{"count": 3, "before": "${TODAY}"}`);
    expect(su(`SELECT string_agg(visit_date || ' ' || period || '=' || booked, ',' ORDER BY visit_date, period) FROM clinical.booking_counters WHERE tenant_id = '${TA}'`))
      .toBe(`${Y} afternoon=0,${Y} morning=0,${TODAY} morning=1`);
    expect((await job.runTenant(TA)).marked).toBe(0);
    // tick: mọi tenant đang hoạt động (tenant B).
    await job.tick();
    expect(su(`SELECT status FROM clinical.bookings WHERE tenant_id = '${TB}'`)).toBe('no_show');
    expect(su(`SELECT count(*) FROM platform.audit_events WHERE action = 'booking.no_show'`)).toBe('2');
    // Đã vắng thì không check-in / huỷ được nữa (trigger CSDL).
    expect(() => su(`UPDATE clinical.bookings SET status = 'booked' WHERE booking_id = '${uid(101)}'`)).toThrow();
  });
});
