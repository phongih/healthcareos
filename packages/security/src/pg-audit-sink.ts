/**
 * HCOS-P0-ENG-001 | AuditSink trên PostgreSQL.
 *
 * Dùng cho sự kiện từ chối/lỗi: chúng xảy ra SAU khi transaction nghiệp vụ đã rollback nên phải ghi bằng transaction riêng
 * (sự kiện thành công được service ghi trong cùng transaction với thay đổi dữ liệu). Mỗi sự kiện chạy trong
 * withTenantTransaction => RLS áp dụng, hash-chain theo tenant do trigger của DB tính.
 * Lỗi ghi audit được ném lên; caller (service) chủ động nuốt để không đổi kết quả của request.
 */
import type { AuditSink, NewAuditEvent, TenantContext } from '../../domain/src/s0-contracts';
import { withTenantTransaction, type PgPoolLike } from './tenant-context';

export class PgAuditSink implements AuditSink {
  constructor(private readonly pool: PgPoolLike) {}

  async record(ev: NewAuditEvent): Promise<void> {
    // withTenantTransaction chỉ dùng tenantId từ ctx.
    const ctx = { tenantId: ev.tenantId } as unknown as TenantContext;
    await withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query(
          `INSERT INTO platform.audit_events
             (tenant_id, actor_type, actor_id, organization_id, action, resource_type, resource_id,
              person_id, patient_id, outcome, correlation_id, source_ip, user_agent, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
          [ev.tenantId, ev.actor.type, ev.actor.id, ev.organizationId, ev.action, ev.resourceType, ev.resourceId,
           ev.personId, ev.patientId, ev.outcome, ev.correlationId, ev.sourceIp, ev.userAgent, JSON.stringify(ev.payload)],
        );
      },
      ctx,
    );
  }
}
