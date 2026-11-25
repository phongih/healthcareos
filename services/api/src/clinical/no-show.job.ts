/**
 * Job đánh dấu vắng lịch hẹn: lịch còn "Đã đặt" (booked) khi ngày khám đã QUA (theo giờ Việt Nam) => no_show.
 * - Chỉ xét ngày khám < hôm nay: lịch buổi chiều hôm nay vẫn để nguyên tới hết ngày (người bệnh có thể đến muộn).
 * - Mỗi tenant một transaction (RLS theo tenant), mỗi cơ sở một bản ghi audit chỉ có số lượng — không có id / tên / SĐT người đặt.
 * - Bộ đếm chỗ của buổi được trừ tương ứng (ràng buộc booked + checked_in = bộ đếm).
 * - Chuyển trạng thái do trigger CSDL kiểm (chỉ booked -> checked_in | cancelled | no_show); chạy lại không đổi gì thêm.
 * Bật / tắt: HCOS_NO_SHOW_INTERVAL_SEC (mặc định 3600, 0 = tắt).
 */
import { randomUUID } from 'node:crypto';

import { asOrganizationId, asTenantId, type AuditEventId, type CorrelationId, type TenantContext } from '../../../../packages/domain/src/s0-contracts';
import { withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { PgBookingRepository } from './booking.service';

type Log = (entry: Record<string, unknown>) => void;
export interface NoShowResult { readonly tenantId: string; readonly marked: number; readonly byOrganization: Readonly<Record<string, number>>; readonly before: string }

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD). */
export const vnToday = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);

export class NoShowJob {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly deps: { pool: PgPoolLike; intervalMs: number; clock?: () => Date; log?: Log }) {}

  start(): void {
    if (this.timer || this.deps.intervalMs <= 0) return;
    const first = setTimeout(() => void this.tick(), Math.min(60_000, this.deps.intervalMs));
    first.unref();
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Một lượt cho mọi tenant đang hoạt động. Lỗi một tenant không chặn tenant khác. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const client = await this.deps.pool.connect();
        let tenants: string[];
        try {
          tenants = ((await client.query('SELECT governance.active_tenants() AS t')).rows as Array<{ t: string }>).map((x) => x.t);
        } finally {
          client.release();
        }
        for (const t of tenants) {
          try {
            const r = await this.runTenant(t);
            if (r.marked > 0) this.deps.log?.({ level: 'info', msg: 'no-show marked', marked: r.marked, before: r.before });
          } catch {
            this.deps.log?.({ level: 'warn', msg: 'no-show run failed' });
          }
        }
      } catch {
        this.deps.log?.({ level: 'warn', msg: 'no-show tick failed' });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async runTenant(tenantId: string): Promise<NoShowResult> {
    const before = vnToday((this.deps.clock ?? (() => new Date()))());
    const ctx: TenantContext = Object.freeze({
      tenantId: asTenantId(tenantId), userSubject: 'service:no-show', userId: null, personId: null, activeOrganizationId: null,
      allowedOrganizationIds: Object.freeze([]), roles: Object.freeze([]), tokenId: null, correlationId: randomUUID() as CorrelationId,
    });
    return withTenantTransaction(
      this.deps.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        const r = await db.query(
          // Bộ đếm chỗ = số lịch booked + checked_in của buổi (kiểm cuối transaction) => trừ phần vừa chuyển sang no_show.
          `WITH m AS (
             UPDATE clinical.bookings SET status = 'no_show'
              WHERE tenant_id = $1 AND status = 'booked' AND visit_date < $2::date
              RETURNING organization_id, service_point_id, visit_date, period
           ), c AS (
             UPDATE clinical.booking_counters bc SET booked = bc.booked - x.n
               FROM (SELECT service_point_id, visit_date, period, count(*)::int AS n FROM m GROUP BY 1, 2, 3) x
              WHERE bc.tenant_id = $1 AND bc.service_point_id = x.service_point_id AND bc.visit_date = x.visit_date AND bc.period = x.period
              RETURNING 1
           )
           SELECT organization_id, (SELECT count(*) FROM c) AS counters FROM m`,
          [tenantId, before],
        );
        const byOrganization: Record<string, number> = {};
        for (const row of r.rows as Array<{ organization_id: string }>) byOrganization[row.organization_id] = (byOrganization[row.organization_id] ?? 0) + 1;
        const repo = new PgBookingRepository(db);
        for (const [org, count] of Object.entries(byOrganization)) {
          await repo.appendAudit({
            eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'service', id: 'no-show' }, organizationId: asOrganizationId(org),
            action: 'booking.no_show', resourceType: 'Booking', resourceId: null, personId: null, patientId: null, outcome: 'success',
            correlationId: ctx.correlationId, sourceIp: null, userAgent: null, payload: { count, before },
          });
        }
        return { tenantId, marked: r.rows.length, byOrganization, before };
      },
      ctx,
    );
  }
}
