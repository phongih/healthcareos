/**
 * HCOS-F12 | Hạ tầng tích hợp: outbox → giao (Teams Workflows / webhook HMAC) → thử lại → nhật ký.
 *
 *  - enqueueOutbox(): gọi TRONG transaction nghiệp vụ (vd. lần chạy Decision Engine). Chỉ tạo bản ghi khi có kết nối nhận.
 *  - IntegrationDispatcher: định kỳ lấy lượt giao đến hạn (mọi tenant, qua hàm SECURITY DEFINER chỉ trả khoá), rồi với từng lượt:
 *      tx1 giữ chỗ (status = sending, locked_until) → gửi HTTP NGOÀI transaction → tx2 ghi kết quả.
 *    Tiến trình chết giữa chừng => quá locked_until lượt đó được nhận lại. Thử lại 1m → 5m → 15m → 1h → 6h → 24h (tối đa 7 lần).
 *  - Kết nối lỗi liên tiếp AUTO_PAUSE_AFTER lần => tự tạm dừng + báo "sự cố hệ thống" qua các kết nối khác.
 *  - URL / bí mật mã hoá AES-256-GCM (secrets.ts); không trả về API, chỉ trả gợi ý đã che. Bí mật ký chỉ hiện MỘT lần khi tạo / đổi.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantId,
  type TenantScopedDb,
  type User,
} from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import { assertOrganizationAllowed, assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, PgClinicalRepository } from '../clinical/encounter.service';
import { SUBSCRIBABLE, sign, systemPayload, teamsMessage, testPayload, webhookBody, type EventType } from './payloads';
import { aadOf, SecretBox } from './secrets';
import { validateTarget, type EndpointKind } from './targets';
import { classify, MAX_ATTEMPTS, type Transport } from './transport';

export const AUTO_PAUSE_AFTER = 10;
const SYSTEM_SUBJECT = 'system:integrations';

// ---------------------------------------------------------------------------
// Kiểu
// ---------------------------------------------------------------------------
export type EndpointStatus = 'active' | 'paused' | 'retired';
export interface Endpoint {
  readonly endpointId: string; readonly organizationId: string; readonly kind: EndpointKind; readonly name: string; readonly urlHint: string;
  readonly eventTypes: string[]; readonly maxPriority: number; readonly status: EndpointStatus; readonly pausedReason: 'manual' | 'auto_failures' | null;
  readonly consecutiveFailures: number; readonly lastSuccessAt: string | null; readonly lastFailureAt: string | null; readonly version: number;
  readonly createdByName: string | null; readonly updatedAt: string; readonly delivered7d: number; readonly failed7d: number; readonly pending: number;
}
export interface EndpointHistory {
  readonly version: number; readonly name: string; readonly urlHint: string; readonly urlChanged: boolean; readonly secretRotated: boolean;
  readonly eventTypes: string[]; readonly maxPriority: number; readonly status: string; readonly pausedReason: string | null; readonly changedByName: string | null; readonly changedAt: string;
}
export interface Delivery {
  readonly deliveryId: string; readonly endpointId: string; readonly endpointName: string; readonly eventId: string; readonly eventType: EventType; readonly priority: number;
  readonly title: string | null; readonly status: 'pending' | 'sending' | 'succeeded' | 'dead' | 'cancelled'; readonly attempts: number; readonly nextAttemptAt: string | null;
  readonly lastStatusCode: number | null; readonly lastError: string | null; readonly deliveredAt: string | null; readonly createdAt: string; readonly version: number;
}
export interface Attempt {
  readonly attemptNo: number; readonly startedAt: string; readonly durationMs: number; readonly statusCode: number | null; readonly outcome: 'success' | 'retry' | 'dead';
  readonly errorCode: string | null; readonly trigger: 'dispatcher' | 'manual'; readonly actorName: string | null;
}
export interface Overview {
  readonly enabled: boolean; readonly publicBaseUrl: string | null;
  readonly endpoints: { active: number; paused: number };
  readonly last24h: { succeeded: number; dead: number; pending: number };
}
export interface EndpointInput {
  readonly organizationId: string; readonly kind: EndpointKind; readonly name: string; readonly url: string; readonly eventTypes: string[]; readonly maxPriority: number;
}
export interface SendResult {
  readonly deliveryId: string; readonly outcome: 'success' | 'retry' | 'dead' | 'skipped'; readonly statusCode: number | null; readonly error: string | null; readonly durationMs: number;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const n = (v: unknown): number => Number(v);
const j = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const list = (xs: readonly string[]): string => JSON.stringify(xs);

// ---------------------------------------------------------------------------
// Outbox (gọi trong transaction nghiệp vụ)
// ---------------------------------------------------------------------------
export interface OutboxInput {
  readonly organizationId: string;
  readonly type: EventType;
  readonly priority: number;
  readonly payload: Record<string, unknown>;
  readonly sourceId?: string | null;
  readonly onlyEndpointId?: string | null;
  readonly excludeEndpointId?: string | null;
  readonly at: Date;
}
export async function enqueueOutbox(db: TenantScopedDb, tenantId: string, e: OutboxInput): Promise<{ eventId: string | null; deliveryIds: string[] }> {
  const r = await db.query<Record<string, unknown>>(
    `WITH targets AS (
       SELECT endpoint_id FROM integration.endpoints
        WHERE tenant_id = $1 AND organization_id = $2
          AND CASE WHEN $3 = 'integration.test' THEN endpoint_id = $7::uuid AND status IN ('active', 'paused')
                   ELSE status = 'active' AND $3 = ANY (event_types) AND ($3 <> 'decision.event' OR $4::smallint <= max_priority)
                        AND ($7::uuid IS NULL OR endpoint_id = $7::uuid) AND ($8::uuid IS NULL OR endpoint_id <> $8::uuid) END),
     ev AS (
       INSERT INTO integration.outbox (tenant_id, organization_id, event_type, priority, payload, source_id, occurred_at)
       SELECT $1, $2, $3, $4, $5::jsonb, $6::uuid, $9::timestamptz WHERE EXISTS (SELECT 1 FROM targets) RETURNING event_id),
     ins AS (
       INSERT INTO integration.deliveries (tenant_id, organization_id, endpoint_id, event_id, next_attempt_at, created_at, updated_at)
       SELECT $1, $2, t.endpoint_id, ev.event_id, $9::timestamptz, $9::timestamptz, $9::timestamptz FROM ev, targets t RETURNING delivery_id)
     SELECT (SELECT event_id FROM ev) AS event_id, COALESCE((SELECT json_agg(delivery_id) FROM ins), '[]'::json) AS ids`,
    [tenantId, e.organizationId, e.type, e.priority, JSON.stringify(e.payload), e.sourceId ?? null, e.onlyEndpointId ?? null, e.excludeEndpointId ?? null, e.at.toISOString()],
  );
  const x = r.rows[0]!;
  return { eventId: (x['event_id'] as string | null) ?? null, deliveryIds: j<string[]>(x['ids']) };
}

export async function organizationName(db: TenantScopedDb, tenantId: string, org: string): Promise<string> {
  const r = await db.query<{ name: string }>('SELECT name FROM iam.organizations WHERE tenant_id = $1 AND organization_id = $2', [tenantId, org]);
  return r.rows[0]?.name ?? '';
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
interface ClaimedDelivery {
  readonly deliveryId: string; readonly organizationId: OrganizationId; readonly attempt: number;
  readonly endpoint: { endpointId: string; kind: EndpointKind; urlCiphertext: string; secretCiphertext: string | null; status: EndpointStatus; name: string };
  readonly event: { eventId: string; type: EventType; priority: number; payload: Record<string, unknown>; occurredAt: string };
}

export class PgIntegrationRepository extends PgClinicalRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }
  get tenant(): string {
    return this.t;
  }
  get scopedDb(): TenantScopedDb {
    return this.db;
  }

  private endpointRow(x: Record<string, unknown>): Endpoint {
    return {
      endpointId: x['endpoint_id'] as string, organizationId: x['organization_id'] as string, kind: x['kind'] as EndpointKind, name: x['name'] as string,
      urlHint: x['url_hint'] as string, eventTypes: j<string[]>(x['event_types']), maxPriority: n(x['max_priority']), status: x['status'] as EndpointStatus,
      pausedReason: (x['paused_reason'] as Endpoint['pausedReason']) ?? null, consecutiveFailures: n(x['consecutive_failures']),
      lastSuccessAt: x['last_success_at'] ? iso(x['last_success_at']) : null, lastFailureAt: x['last_failure_at'] ? iso(x['last_failure_at']) : null,
      version: n(x['version']), createdByName: (x['created_by_name'] as string | null) ?? null, updatedAt: iso(x['updated_at']),
      delivered7d: n(x['delivered_7d'] ?? 0), failed7d: n(x['failed_7d'] ?? 0), pending: n(x['pending'] ?? 0),
    };
  }
  private readonly endpointSelect = `
    SELECT e.endpoint_id, e.organization_id, e.kind, e.name, e.url_hint, to_jsonb(e.event_types) AS event_types, e.max_priority, e.status, e.paused_reason,
           COALESCE(h.consecutive_failures, 0) AS consecutive_failures, h.last_success_at, h.last_failure_at, e.version, e.updated_at, u.display_name AS created_by_name,
           (SELECT count(*) FROM integration.deliveries d WHERE d.tenant_id = e.tenant_id AND d.endpoint_id = e.endpoint_id AND d.status = 'succeeded' AND d.created_at > $3::timestamptz - interval '7 days') AS delivered_7d,
           (SELECT count(*) FROM integration.deliveries d WHERE d.tenant_id = e.tenant_id AND d.endpoint_id = e.endpoint_id AND d.status = 'dead' AND d.created_at > $3::timestamptz - interval '7 days') AS failed_7d,
           (SELECT count(*) FROM integration.deliveries d WHERE d.tenant_id = e.tenant_id AND d.endpoint_id = e.endpoint_id AND d.status IN ('pending', 'sending')) AS pending
      FROM integration.endpoints e
      LEFT JOIN integration.endpoint_health h ON h.tenant_id = e.tenant_id AND h.endpoint_id = e.endpoint_id
      LEFT JOIN iam.users u ON u.tenant_id = e.tenant_id AND u.user_id = e.created_by`;
  async listEndpoints(org: OrganizationId, now: Date): Promise<Endpoint[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `${this.endpointSelect} WHERE e.tenant_id = $1 AND e.organization_id = $2 AND e.status <> 'retired' ORDER BY (e.status = 'active') DESC, e.name`,
      [this.t, org, now.toISOString()],
    );
    return r.rows.map((x) => this.endpointRow(x));
  }
  async getEndpoint(id: string, now: Date): Promise<Endpoint | null> {
    const r = await this.db.query<Record<string, unknown>>(`${this.endpointSelect} WHERE e.tenant_id = $1 AND e.endpoint_id = $2`, [this.t, id, now.toISOString()]);
    return r.rows[0] ? this.endpointRow(r.rows[0]) : null;
  }
  async insertEndpoint(x: { id: string; org: OrganizationId; kind: EndpointKind; name: string; urlCt: string; hint: string; secretCt: string | null; eventTypes: string[]; maxPriority: number; by: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO integration.endpoints (endpoint_id, tenant_id, organization_id, kind, name, url_ciphertext, url_hint, secret_ciphertext, event_types, max_priority, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), $10, $11, $11)`,
      [x.id, this.t, x.org, x.kind, x.name, x.urlCt, x.hint, x.secretCt, list(x.eventTypes), x.maxPriority, x.by],
    );
  }
  async updateEndpoint(id: string, x: { name: string; urlCt: string | null; hint: string | null; secretCt: string | null; eventTypes: string[]; maxPriority: number; by: string }, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE integration.endpoints SET name = $3, url_ciphertext = COALESCE($4, url_ciphertext), url_hint = COALESCE($5, url_hint),
              secret_ciphertext = COALESCE($6, secret_ciphertext), event_types = ARRAY(SELECT jsonb_array_elements_text($7::jsonb)), max_priority = $8, updated_by = $9
        WHERE tenant_id = $1 AND endpoint_id = $2 AND version = $10 AND status <> 'retired' RETURNING 1`,
      [this.t, id, x.name, x.urlCt, x.hint, x.secretCt, list(x.eventTypes), x.maxPriority, x.by, expectedVersion],
    );
    return r.rows.length > 0;
  }
  async setEndpointStatus(id: string, status: EndpointStatus, reason: 'manual' | 'auto_failures' | null, by: string | null, expectedVersion: number | null): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE integration.endpoints SET status = $3, paused_reason = $4, updated_by = COALESCE($5, updated_by)
        WHERE tenant_id = $1 AND endpoint_id = $2 AND status <> 'retired' AND ($6::bigint IS NULL OR version = $6::bigint) RETURNING 1`,
      [this.t, id, status, reason, by, expectedVersion],
    );
    if (r.rows.length > 0 && status === 'active') {
      await this.db.query('UPDATE integration.endpoint_health SET consecutive_failures = 0 WHERE tenant_id = $1 AND endpoint_id = $2', [this.t, id]);
    }
    return r.rows.length > 0;
  }
  /** Bật lại kết nối: huỷ các lượt giao tồn đọng quá 24 giờ (tin cũ không còn ý nghĩa). */
  async cancelStale(id: string, now: Date): Promise<number> {
    const r = await this.db.query(
      `UPDATE integration.deliveries SET status = 'cancelled', locked_until = NULL, last_error = 'STALE_ON_RESUME', updated_at = $3
        WHERE tenant_id = $1 AND endpoint_id = $2 AND status IN ('pending', 'sending') AND created_at < $3::timestamptz - interval '24 hours' RETURNING 1`,
      [this.t, id, now.toISOString()],
    );
    return r.rows.length;
  }
  async endpointSecrets(id: string): Promise<{ urlCiphertext: string; secretCiphertext: string | null; kind: EndpointKind } | null> {
    const r = await this.db.query<Record<string, unknown>>('SELECT url_ciphertext, secret_ciphertext, kind FROM integration.endpoints WHERE tenant_id = $1 AND endpoint_id = $2', [this.t, id]);
    const x = r.rows[0];
    return x ? { urlCiphertext: x['url_ciphertext'] as string, secretCiphertext: (x['secret_ciphertext'] as string | null) ?? null, kind: x['kind'] as EndpointKind } : null;
  }
  async history(id: string): Promise<EndpointHistory[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT h.version, h.name, h.url_hint, h.url_changed, h.secret_rotated, to_jsonb(h.event_types) AS event_types, h.max_priority, h.status, h.paused_reason, h.changed_at, u.display_name
         FROM integration.endpoint_history h LEFT JOIN iam.users u ON u.tenant_id = h.tenant_id AND u.user_id = h.changed_by
        WHERE h.tenant_id = $1 AND h.endpoint_id = $2 ORDER BY h.history_id DESC LIMIT 100`,
      [this.t, id],
    );
    const b = (v: unknown) => v === true || v === 't';
    return r.rows.map((x) => ({
      version: n(x['version']), name: x['name'] as string, urlHint: x['url_hint'] as string, urlChanged: b(x['url_changed']), secretRotated: b(x['secret_rotated']),
      eventTypes: j<string[]>(x['event_types']), maxPriority: n(x['max_priority']), status: x['status'] as string, pausedReason: (x['paused_reason'] as string | null) ?? null,
      changedByName: (x['display_name'] as string | null) ?? null, changedAt: iso(x['changed_at']),
    }));
  }
  async deliveries(org: OrganizationId, q: { limit: number; endpointId?: string; status?: string }): Promise<Delivery[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT d.delivery_id, d.endpoint_id, e.name AS endpoint_name, d.event_id, o.event_type, o.priority, o.payload->>'title' AS title, d.status, d.attempts,
              d.next_attempt_at, d.last_status_code, d.last_error, d.delivered_at, d.created_at, d.version
         FROM integration.deliveries d
         JOIN integration.endpoints e ON e.tenant_id = d.tenant_id AND e.endpoint_id = d.endpoint_id
         JOIN integration.outbox o ON o.tenant_id = d.tenant_id AND o.event_id = d.event_id
        WHERE d.tenant_id = $1 AND d.organization_id = $2 AND ($4::uuid IS NULL OR d.endpoint_id = $4::uuid) AND ($5::text IS NULL OR d.status = $5)
        ORDER BY d.created_at DESC, d.delivery_id LIMIT $3`,
      [this.t, org, q.limit, q.endpointId ?? null, q.status ?? null],
    );
    return r.rows.map((x) => ({
      deliveryId: x['delivery_id'] as string, endpointId: x['endpoint_id'] as string, endpointName: x['endpoint_name'] as string, eventId: x['event_id'] as string,
      eventType: x['event_type'] as EventType, priority: n(x['priority']), title: (x['title'] as string | null) ?? null, status: x['status'] as Delivery['status'],
      attempts: n(x['attempts']), nextAttemptAt: x['status'] === 'pending' && x['next_attempt_at'] ? iso(x['next_attempt_at']) : null,
      lastStatusCode: x['last_status_code'] === null || x['last_status_code'] === undefined ? null : n(x['last_status_code']), lastError: (x['last_error'] as string | null) ?? null,
      deliveredAt: x['delivered_at'] ? iso(x['delivered_at']) : null, createdAt: iso(x['created_at']), version: n(x['version']),
    }));
  }
  async deliveryOrg(id: string): Promise<{ organizationId: OrganizationId; status: string; endpointStatus: EndpointStatus } | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT d.organization_id, d.status, e.status AS endpoint_status FROM integration.deliveries d
         JOIN integration.endpoints e ON e.tenant_id = d.tenant_id AND e.endpoint_id = d.endpoint_id WHERE d.tenant_id = $1 AND d.delivery_id = $2`,
      [this.t, id],
    );
    const x = r.rows[0];
    return x ? { organizationId: x['organization_id'] as OrganizationId, status: x['status'] as string, endpointStatus: x['endpoint_status'] as EndpointStatus } : null;
  }
  async attempts(deliveryId: string): Promise<Attempt[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT a.attempt_no, a.started_at, a.duration_ms, a.status_code, a.outcome, a.error_code, a.trigger, u.display_name
         FROM integration.delivery_attempts a LEFT JOIN iam.users u ON u.tenant_id = a.tenant_id AND u.user_id = a.actor_user_id
        WHERE a.tenant_id = $1 AND a.delivery_id = $2 ORDER BY a.attempt_no`,
      [this.t, deliveryId],
    );
    return r.rows.map((x) => ({
      attemptNo: n(x['attempt_no']), startedAt: iso(x['started_at']), durationMs: n(x['duration_ms']),
      statusCode: x['status_code'] === null || x['status_code'] === undefined ? null : n(x['status_code']), outcome: x['outcome'] as Attempt['outcome'],
      errorCode: (x['error_code'] as string | null) ?? null, trigger: x['trigger'] as Attempt['trigger'], actorName: (x['display_name'] as string | null) ?? null,
    }));
  }
  async overview(org: OrganizationId, now: Date): Promise<Overview['endpoints'] & Overview['last24h']> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT (SELECT count(*) FROM integration.endpoints WHERE tenant_id = $1 AND organization_id = $2 AND status = 'active') AS active,
              (SELECT count(*) FROM integration.endpoints WHERE tenant_id = $1 AND organization_id = $2 AND status = 'paused') AS paused,
              (SELECT count(*) FROM integration.deliveries WHERE tenant_id = $1 AND organization_id = $2 AND status = 'succeeded' AND created_at > $3::timestamptz - interval '24 hours') AS succeeded,
              (SELECT count(*) FROM integration.deliveries WHERE tenant_id = $1 AND organization_id = $2 AND status = 'dead' AND created_at > $3::timestamptz - interval '24 hours') AS dead,
              (SELECT count(*) FROM integration.deliveries WHERE tenant_id = $1 AND organization_id = $2 AND status IN ('pending', 'sending')) AS pending`,
      [this.t, org, now.toISOString()],
    );
    const x = r.rows[0]!;
    return { active: n(x['active']), paused: n(x['paused']), succeeded: n(x['succeeded']), dead: n(x['dead']), pending: n(x['pending']) };
  }

  // ---- giao ----
  /** Giữ chỗ một lượt giao. manual = bấm Gửi thử / Gửi lại (nhận cả lượt "dead" và lượt chưa đến hạn). */
  async claim(deliveryId: string, now: Date, manual: boolean): Promise<ClaimedDelivery | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `UPDATE integration.deliveries d SET status = 'sending', locked_until = $3::timestamptz + interval '2 minutes', attempts = d.attempts + 1, updated_at = $3
        WHERE d.tenant_id = $1 AND d.delivery_id = $2 AND d.attempts < 20
          AND (CASE WHEN $4 THEN d.status IN ('pending', 'dead')
                    ELSE (d.status = 'pending' AND d.next_attempt_at <= $3::timestamptz) OR (d.status = 'sending' AND d.locked_until < $3::timestamptz) END)
        RETURNING d.organization_id, d.attempts, d.endpoint_id, d.event_id`,
      [this.t, deliveryId, now.toISOString(), manual],
    );
    const d = r.rows[0];
    if (!d) return null;
    const x = (
      await this.db.query<Record<string, unknown>>(
        `SELECT e.kind, e.url_ciphertext, e.secret_ciphertext, e.status, e.name, o.event_type, o.priority, o.payload, o.occurred_at
           FROM integration.endpoints e, integration.outbox o
          WHERE e.tenant_id = $1 AND e.endpoint_id = $2 AND o.tenant_id = $1 AND o.event_id = $3`,
        [this.t, d['endpoint_id'], d['event_id']],
      )
    ).rows[0]!;
    return {
      deliveryId, organizationId: d['organization_id'] as OrganizationId, attempt: n(d['attempts']),
      endpoint: {
        endpointId: d['endpoint_id'] as string, kind: x['kind'] as EndpointKind, urlCiphertext: x['url_ciphertext'] as string,
        secretCiphertext: (x['secret_ciphertext'] as string | null) ?? null, status: x['status'] as EndpointStatus, name: x['name'] as string,
      },
      event: { eventId: d['event_id'] as string, type: x['event_type'] as EventType, priority: n(x['priority']), payload: j<Record<string, unknown>>(x['payload']), occurredAt: iso(x['occurred_at']) },
    };
  }
  async record(x: {
    deliveryId: string; org: OrganizationId; attempt: number; startedAt: Date; durationMs: number; statusCode: number | null;
    outcome: 'success' | 'retry' | 'dead'; error: string | null; nextAt: Date | null; trigger: 'dispatcher' | 'manual'; actor: string | null; now: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO integration.delivery_attempts (tenant_id, organization_id, delivery_id, attempt_no, started_at, duration_ms, status_code, outcome, error_code, trigger, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [this.t, x.org, x.deliveryId, x.attempt, x.startedAt.toISOString(), x.durationMs, x.statusCode, x.outcome, x.error, x.trigger, x.actor],
    );
    await this.db.query(
      `UPDATE integration.deliveries SET locked_until = NULL, last_status_code = $3, last_error = $4, updated_at = $5,
              status = CASE $6 WHEN 'success' THEN 'succeeded' WHEN 'retry' THEN 'pending' ELSE 'dead' END,
              delivered_at = CASE WHEN $6 = 'success' THEN $5::timestamptz END,
              next_attempt_at = COALESCE($7::timestamptz, next_attempt_at)
        WHERE tenant_id = $1 AND delivery_id = $2`,
      [this.t, x.deliveryId, x.statusCode, x.error, x.now.toISOString(), x.outcome, x.nextAt?.toISOString() ?? null],
    );
  }
  /** Cập nhật sức khoẻ kết nối; trả số lỗi liên tiếp sau cập nhật và trạng thái hiện tại. */
  async endpointHealth(id: string, success: boolean, now: Date): Promise<{ failures: number; status: EndpointStatus }> {
    const r = await this.db.query<Record<string, unknown>>(
      `WITH up AS (
         INSERT INTO integration.endpoint_health AS h (tenant_id, endpoint_id, organization_id, consecutive_failures, last_success_at, last_failure_at)
         SELECT e.tenant_id, e.endpoint_id, e.organization_id, CASE WHEN $3 THEN 0 ELSE 1 END,
                CASE WHEN $3 THEN $4::timestamptz END, CASE WHEN $3 THEN NULL ELSE $4::timestamptz END
           FROM integration.endpoints e WHERE e.tenant_id = $1 AND e.endpoint_id = $2
         ON CONFLICT (tenant_id, endpoint_id) DO UPDATE SET
              consecutive_failures = CASE WHEN $3 THEN 0 ELSE h.consecutive_failures + 1 END,
              last_success_at = CASE WHEN $3 THEN $4::timestamptz ELSE h.last_success_at END,
              last_failure_at = CASE WHEN $3 THEN h.last_failure_at ELSE $4::timestamptz END
         RETURNING consecutive_failures)
       SELECT (SELECT consecutive_failures FROM up) AS consecutive_failures,
              (SELECT status FROM integration.endpoints WHERE tenant_id = $1 AND endpoint_id = $2) AS status`,
      [this.t, id, success, now.toISOString()],
    );
    const x = r.rows[0];
    return x && x['status'] ? { failures: n(x['consecutive_failures'] ?? 0), status: x['status'] as EndpointStatus } : { failures: 0, status: 'retired' };
  }
}

// ---------------------------------------------------------------------------
// Unit of work
// ---------------------------------------------------------------------------
export interface IntegrationUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PgIntegrationRepository) => Promise<T>): Promise<T>;
}
export class PgIntegrationUnitOfWork implements IntegrationUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}
  run<T>(ctx: TenantContext, fn: (repo: PgIntegrationRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgIntegrationRepository(db));
      },
      ctx,
    );
  }
}

export function integrationSystemContext(tenantId: string, organizationId: string): TenantContext {
  return Object.freeze({
    tenantId: tenantId as TenantId, userSubject: SYSTEM_SUBJECT, userId: null, personId: null,
    activeOrganizationId: organizationId as OrganizationId, allowedOrganizationIds: Object.freeze([organizationId as OrganizationId]),
    roles: Object.freeze(['system'] as Role[]), tokenId: null, correlationId: randomUUID() as CorrelationId,
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
type Permission = 'integration:read' | 'integration:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'integration:read': ['clinic_admin', 'executive', 'tenant_admin'],
  'integration:manage': ['clinic_admin', 'tenant_admin'],
};
interface Principal { readonly user: User; readonly grants: readonly AccessGrant[] }
const EVENT_IDS = new Set(SUBSCRIBABLE.map((x) => x.id));
const KINDS: readonly { id: EndpointKind; label: string; description: string }[] = [
  { id: 'teams_workflow', label: 'Microsoft Teams (Workflows)', description: 'URL webhook tạo bằng app Workflows trong kênh Teams ("Post to a channel when a webhook request is received"). Tin gửi dạng Adaptive Card.' },
  { id: 'webhook', label: 'Webhook (đối tác)', description: 'POST JSON tới URL https của đối tác, ký X-HCOS-Signature (HMAC-SHA256). Bí mật ký chỉ hiện một lần.' },
];

export interface IntegrationDeps {
  readonly uow: IntegrationUnitOfWork;
  readonly audit: AuditSink;
  readonly box: SecretBox | null;
  readonly transport: Transport;
  readonly clock?: () => Date;
  readonly publicBaseUrl?: string | null;
  /** Chỉ cho test / devstack: cho phép http:// và địa chỉ nội bộ. */
  readonly allowPrivate?: boolean;
}

export class IntegrationService {
  private readonly clock: () => Date;
  constructor(private readonly deps: IntegrationDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  catalog() {
    return { kinds: KINDS, eventTypes: SUBSCRIBABLE, enabled: this.deps.box !== null, maxAttempts: MAX_ATTEMPTS, autoPauseAfter: AUTO_PAUSE_AFTER };
  }

  async overview(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<Overview> {
    return this.tx(ctx, 'integration.overview', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'integration:read');
      const x = await repo.overview(org, this.clock());
      return {
        enabled: this.deps.box !== null, publicBaseUrl: this.deps.publicBaseUrl ?? null,
        endpoints: { active: x.active, paused: x.paused }, last24h: { succeeded: x.succeeded, dead: x.dead, pending: x.pending },
      };
    });
  }

  async listEndpoints(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<Endpoint[]> {
    return this.tx(ctx, 'integration.endpoints.read', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'integration:read');
      return repo.listEndpoints(org, this.clock());
    });
  }

  async endpointHistory(id: string, ctx: TenantContext = requireTenantContext()): Promise<EndpointHistory[]> {
    return this.tx(ctx, 'integration.endpoints.history', async (repo) => {
      const ep = await this.endpointOf(repo, id, ctx);
      this.decideAccess(await this.principal(repo, ctx, ep.organizationId as OrganizationId), 'integration:read');
      return repo.history(ep.endpointId);
    });
  }

  /** Tạo kết nối. Webhook trả `signingSecret` MỘT lần duy nhất. */
  async createEndpoint(input: EndpointInput, ctx: TenantContext = requireTenantContext()): Promise<{ endpoint: Endpoint; signingSecret: string | null }> {
    return this.tx(ctx, 'integration.endpoints.create', async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'integration:manage');
      const box = this.requireBox();
      if (!KINDS.some((k) => k.id === input.kind)) throw new ClinicalError('VALIDATION', 'kind must be teams_workflow or webhook', { reason: 'INVALID_ENDPOINT' });
      const base = this.validateCommon(input.name, input.eventTypes, input.maxPriority);
      const t = validateTarget(input.kind, input.url, { allowPrivate: this.deps.allowPrivate === true });
      if ('error' in t) throw new ClinicalError('VALIDATION', t.error, { reason: 'INVALID_URL' });
      const id = randomUUID();
      const secret = input.kind === 'webhook' ? `whsec_${randomBytes(24).toString('base64url')}` : null;
      await nameTaken(() =>
        repo.insertEndpoint({
          id, org, kind: input.kind, name: base.name, urlCt: box.seal(t.url, aadOf(repo.tenant, id, 'url')), hint: t.hint,
          secretCt: secret ? box.seal(secret, aadOf(repo.tenant, id, 'secret')) : null, eventTypes: base.eventTypes, maxPriority: base.maxPriority, by: p.user.userId,
        }),
      );
      await repo.appendAudit(this.event(ctx, 'integration.endpoints.create', org, 'success', p.user, id, { kind: input.kind, name: base.name, host: t.hint.split('/')[0] }));
      return { endpoint: (await repo.getEndpoint(id, this.clock()))!, signingSecret: secret };
    });
  }

  async updateEndpoint(
    id: string, input: { name: string; url?: string | null; eventTypes: string[]; maxPriority: number; rotateSecret?: boolean }, expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ endpoint: Endpoint; signingSecret: string | null }> {
    return this.tx(ctx, 'integration.endpoints.update', async (repo) => {
      const ep = await this.endpointOf(repo, id, ctx);
      const org = ep.organizationId as OrganizationId;
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'integration:manage');
      this.version(expectedVersion);
      const box = this.requireBox();
      const base = this.validateCommon(input.name, input.eventTypes, input.maxPriority);
      let urlCt: string | null = null;
      let hint: string | null = null;
      if (input.url !== undefined && input.url !== null && input.url !== '') {
        const t = validateTarget(ep.kind, input.url, { allowPrivate: this.deps.allowPrivate === true });
        if ('error' in t) throw new ClinicalError('VALIDATION', t.error, { reason: 'INVALID_URL' });
        urlCt = box.seal(t.url, aadOf(repo.tenant, ep.endpointId, 'url'));
        hint = t.hint;
      }
      if (input.rotateSecret && ep.kind !== 'webhook') throw new ClinicalError('VALIDATION', 'Only webhook endpoints have a signing secret', { reason: 'INVALID_ENDPOINT' });
      const secret = input.rotateSecret ? `whsec_${randomBytes(24).toString('base64url')}` : null;
      const ok = await nameTaken(() =>
        repo.updateEndpoint(
          ep.endpointId,
          { name: base.name, urlCt, hint, secretCt: secret ? box.seal(secret, aadOf(repo.tenant, ep.endpointId, 'secret')) : null, eventTypes: base.eventTypes, maxPriority: base.maxPriority, by: p.user.userId },
          expectedVersion,
        ),
      );
      if (!ok) throw new ClinicalError('CONFLICT', 'Endpoint version does not match', { reason: 'VERSION_CONFLICT' });
      await repo.appendAudit(this.event(ctx, 'integration.endpoints.update', org, 'success', p.user, ep.endpointId, { urlChanged: urlCt !== null, secretRotated: secret !== null }));
      return { endpoint: (await repo.getEndpoint(ep.endpointId, this.clock()))!, signingSecret: secret };
    });
  }

  async setEndpointStatus(id: string, status: EndpointStatus, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<{ endpoint: Endpoint; cancelledStale: number }> {
    return this.tx(ctx, 'integration.endpoints.status', async (repo) => {
      if (!['active', 'paused', 'retired'].includes(status)) throw new ClinicalError('VALIDATION', 'status must be active, paused or retired', { reason: 'INVALID_ENDPOINT' });
      const ep = await this.endpointOf(repo, id, ctx);
      const org = ep.organizationId as OrganizationId;
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'integration:manage');
      this.version(expectedVersion);
      if (ep.status === 'retired') throw new ClinicalError('CONFLICT', 'Endpoint is retired', { reason: 'ENDPOINT_RETIRED' });
      const ok = await repo.setEndpointStatus(ep.endpointId, status, status === 'paused' ? 'manual' : null, p.user.userId, expectedVersion);
      if (!ok) throw new ClinicalError('CONFLICT', 'Endpoint version does not match', { reason: 'VERSION_CONFLICT' });
      const cancelledStale = status === 'active' ? await repo.cancelStale(ep.endpointId, this.clock()) : 0;
      await repo.appendAudit(this.event(ctx, 'integration.endpoints.status', org, 'success', p.user, ep.endpointId, { status, cancelledStale }));
      return { endpoint: (await repo.getEndpoint(ep.endpointId, this.clock()))!, cancelledStale };
    });
  }

  /** Gửi thử ngay (đồng bộ) một thẻ kiểm tra tới kết nối — kể cả khi đang tạm dừng. */
  async testEndpoint(id: string, ctx: TenantContext = requireTenantContext()): Promise<SendResult> {
    let deliveryId = '';
    let actor = '';
    await this.tx(ctx, 'integration.endpoints.test', async (repo) => {
      const ep = await this.endpointOf(repo, id, ctx);
      const org = ep.organizationId as OrganizationId;
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'integration:manage');
      this.requireBox();
      if (ep.status === 'retired') throw new ClinicalError('CONFLICT', 'Endpoint is retired', { reason: 'ENDPOINT_RETIRED' });
      const name = await organizationName(repo.scopedDb, repo.tenant, org);
      const r = await enqueueOutbox(repo.scopedDb, repo.tenant, {
        organizationId: org, type: 'integration.test', priority: 3, at: this.clock(), onlyEndpointId: ep.endpointId,
        payload: testPayload({ title: `Kết nối "${ep.name}" hoạt động — HealthcareOS gửi thử`, organizationName: name, requestedBy: p.user.displayName }),
      });
      deliveryId = r.deliveryIds[0]!;
      actor = p.user.userId;
      await repo.appendAudit(this.event(ctx, 'integration.endpoints.test', org, 'success', p.user, ep.endpointId, { deliveryId }));
    });
    return this.process(ctx, deliveryId, 'manual', actor);
  }

  async deliveries(q: { organizationId: string; limit?: number; endpointId?: string; status?: string }, ctx: TenantContext = requireTenantContext()): Promise<Delivery[]> {
    return this.tx(ctx, 'integration.deliveries.read', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'integration:read');
      if (q.endpointId !== undefined && !isUuid(q.endpointId)) throw new ClinicalError('VALIDATION', 'endpoint must be a UUID');
      if (q.status !== undefined && !['pending', 'sending', 'succeeded', 'dead', 'cancelled'].includes(q.status)) throw new ClinicalError('VALIDATION', 'Unknown status');
      const limit = q.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ClinicalError('VALIDATION', 'limit must be 1..500');
      return repo.deliveries(org, { limit, ...(q.endpointId ? { endpointId: q.endpointId.toLowerCase() } : {}), ...(q.status ? { status: q.status } : {}) });
    });
  }

  async deliveryAttempts(id: string, ctx: TenantContext = requireTenantContext()): Promise<Attempt[]> {
    return this.tx(ctx, 'integration.deliveries.attempts', async (repo) => {
      const d = await this.deliveryOf(repo, id, ctx);
      this.decideAccess(await this.principal(repo, ctx, d.organizationId), 'integration:read');
      return repo.attempts(id.toLowerCase());
    });
  }

  /** Gửi lại ngay một lượt "dead" (hoặc đang chờ thử lại). */
  async retryDelivery(id: string, ctx: TenantContext = requireTenantContext()): Promise<SendResult> {
    let actor = '';
    await this.tx(ctx, 'integration.deliveries.retry', async (repo) => {
      const d = await this.deliveryOf(repo, id, ctx);
      const p = await this.principal(repo, ctx, d.organizationId);
      this.decideAccess(p, 'integration:manage');
      this.requireBox();
      if (!['dead', 'pending'].includes(d.status)) throw new ClinicalError('CONFLICT', 'Only dead or pending deliveries can be retried', { reason: 'NOT_RETRYABLE' });
      if (d.endpointStatus === 'retired') throw new ClinicalError('CONFLICT', 'Endpoint is retired', { reason: 'ENDPOINT_RETIRED' });
      actor = p.user.userId;
      await repo.appendAudit(this.event(ctx, 'integration.deliveries.retry', d.organizationId, 'success', p.user, id.toLowerCase(), {}));
    });
    return this.process(ctx, id.toLowerCase(), 'manual', actor);
  }

  /** Bộ giao gọi cho từng lượt đến hạn. */
  async dispatchOne(tenantId: string, organizationId: string, deliveryId: string): Promise<SendResult> {
    return this.process(integrationSystemContext(tenantId, organizationId), deliveryId, 'dispatcher', null);
  }

  // ---- lõi gửi ----
  private async process(ctx: TenantContext, deliveryId: string, trigger: 'dispatcher' | 'manual', actor: string | null): Promise<SendResult> {
    const box = this.deps.box;
    const claimed = await this.deps.uow.run(ctx, (repo) => repo.claim(deliveryId, this.clock(), trigger === 'manual'));
    if (!claimed) return { deliveryId, outcome: 'skipped', statusCode: null, error: null, durationMs: 0 };
    const started = this.clock();
    let result: { status: number | null; error: string | null; retryAfterSec: number | null; durationMs: number };
    try {
      if (!box) throw Object.assign(new Error('no key'), { hcos: 'INTEGRATION_DISABLED' });
      let url: string;
      let secret: string | null = null;
      try {
        url = box.open(claimed.endpoint.urlCiphertext, aadOf(ctx.tenantId, claimed.endpoint.endpointId, 'url'));
        if (claimed.endpoint.secretCiphertext) secret = box.open(claimed.endpoint.secretCiphertext, aadOf(ctx.tenantId, claimed.endpoint.endpointId, 'secret'));
      } catch {
        throw Object.assign(new Error('decrypt'), { hcos: 'DECRYPT_FAILED' });
      }
      // Kiểm tra lại đích lúc gửi (URL cũ có thể đã hợp lệ theo luật cũ).
      const t = validateTarget(claimed.endpoint.kind, url, { allowPrivate: this.deps.allowPrivate === true });
      if ('error' in t) throw Object.assign(new Error('target'), { hcos: 'TARGET_REJECTED' });
      const ev = { eventId: claimed.event.eventId, type: claimed.event.type, priority: claimed.event.priority, occurredAt: claimed.event.occurredAt, organizationId: claimed.organizationId, payload: claimed.event.payload };
      const headers: Record<string, string> = {};
      let body: string;
      if (claimed.endpoint.kind === 'teams_workflow') {
        body = JSON.stringify(teamsMessage(ev, this.deps.publicBaseUrl ?? null));
      } else {
        body = webhookBody(ev);
        const ts = Math.floor(this.clock().getTime() / 1000);
        headers['x-hcos-event'] = ev.type;
        headers['x-hcos-delivery'] = deliveryId;
        headers['x-hcos-timestamp'] = String(ts);
        headers['x-hcos-signature'] = sign(secret!, ts, body);
      }
      result = await this.deps.transport({ url: t.url, headers, body });
    } catch (e) {
      const code = (e as { hcos?: string }).hcos ?? 'INTERNAL';
      result = { status: null, error: code, retryAfterSec: null, durationMs: this.clock().getTime() - started.getTime() };
    }
    const permanentLocal = result.status === null && ['INTEGRATION_DISABLED', 'DECRYPT_FAILED', 'TARGET_REJECTED', 'INTERNAL'].includes(result.error ?? '');
    const v = permanentLocal ? { outcome: 'dead' as const, error: result.error! } : classify(result, claimed.attempt, trigger === 'dispatcher');
    const now = this.clock();
    const nextAt = v.outcome === 'retry' ? new Date(now.getTime() + v.afterSec * 1000) : null;
    await this.deps.uow.run(ctx, async (repo) => {
      await repo.record({
        deliveryId, org: claimed.organizationId, attempt: claimed.attempt, startedAt: started, durationMs: Math.max(0, result.durationMs), statusCode: result.status,
        outcome: v.outcome, error: v.outcome === 'success' ? null : v.error, nextAt, trigger, actor, now,
      });
      // Thẻ gửi thử không làm kết nối bị tính lỗi / tự tạm dừng; vẫn ghi nhận thành công.
      const isTest = claimed.event.type === 'integration.test';
      if (v.outcome === 'success' || !isTest) {
        const h = await repo.endpointHealth(claimed.endpoint.endpointId, v.outcome === 'success', now);
        if (v.outcome !== 'success' && h.status === 'active' && h.failures >= AUTO_PAUSE_AFTER) {
          await repo.setEndpointStatus(claimed.endpoint.endpointId, 'paused', 'auto_failures', null, null);
          const name = await organizationName(repo.scopedDb, repo.tenant, claimed.organizationId);
          await enqueueOutbox(repo.scopedDb, repo.tenant, {
            organizationId: claimed.organizationId, type: 'system.alert', priority: 1, at: now, excludeEndpointId: claimed.endpoint.endpointId,
            payload: systemPayload({
              code: 'ENDPOINT_AUTO_PAUSED', title: `Kết nối "${claimed.endpoint.name}" bị tự tạm dừng sau ${h.failures} lần gửi lỗi liên tiếp`,
              detail: `Lỗi gần nhất: ${v.error}. Kiểm tra URL / phía nhận rồi bật lại ở màn Tích hợp.`, link: '#/integrations', organizationName: name,
            }),
          });
          await repo.appendAudit({
            ...this.event(ctx, 'integration.endpoints.auto_pause', claimed.organizationId, 'success', null, claimed.endpoint.endpointId, { failures: h.failures, error: v.error }),
            actor: { type: 'system', id: SYSTEM_SUBJECT },
          });
        }
      }
    });
    return { deliveryId, outcome: v.outcome, statusCode: result.status, error: v.outcome === 'success' ? null : v.error, durationMs: result.durationMs };
  }

  // ---- nội bộ ----
  private requireBox(): SecretBox {
    if (!this.deps.box) throw new ClinicalError('CONFLICT', 'Integrations are disabled: HCOS_INTEGRATION_KEY is not configured', { reason: 'INTEGRATION_DISABLED' });
    return this.deps.box;
  }
  private validateCommon(name: unknown, eventTypes: unknown, maxPriority: unknown): { name: string; eventTypes: string[]; maxPriority: number } {
    const errs: string[] = [];
    if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 120) errs.push('name must be 3..120 characters');
    if (!Array.isArray(eventTypes) || eventTypes.length < 1 || eventTypes.some((x) => typeof x !== 'string' || !EVENT_IDS.has(x as never)) || new Set(eventTypes).size !== eventTypes.length) {
      errs.push(`eventTypes must be distinct values of ${[...EVENT_IDS].join(', ')}`);
    }
    if (!Number.isInteger(maxPriority) || (maxPriority as number) < 1 || (maxPriority as number) > 3) errs.push('maxPriority must be 1..3');
    if (errs.length) throw new ClinicalError('VALIDATION', errs.join('; '), { reason: 'INVALID_ENDPOINT' });
    return { name: (name as string).trim(), eventTypes: SUBSCRIBABLE.map((x) => x.id).filter((x) => (eventTypes as string[]).includes(x)), maxPriority: maxPriority as number };
  }
  private version(v: number): void {
    if (!Number.isInteger(v) || v < 1) throw new ClinicalError('VALIDATION', 'Invalid version');
  }
  private async endpointOf(repo: PgIntegrationRepository, id: string, ctx: TenantContext): Promise<Endpoint> {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'endpoint id must be a UUID');
    const ep = await repo.getEndpoint(id.toLowerCase(), this.clock());
    if (!ep) throw new ClinicalError('NOT_FOUND', 'Endpoint not found');
    assertOrganizationAllowed(ep.organizationId as OrganizationId, ctx);
    return ep;
  }
  private async deliveryOf(repo: PgIntegrationRepository, id: string, ctx: TenantContext) {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'delivery id must be a UUID');
    const d = await repo.deliveryOrg(id.toLowerCase());
    if (!d) throw new ClinicalError('NOT_FOUND', 'Delivery not found');
    assertOrganizationAllowed(d.organizationId, ctx);
    return d;
  }
  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  private async principal(repo: PgIntegrationRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) =>
        (m.organizationId === organizationId || m.role === 'tenant_admin') && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return { user, grants: await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>) };
  }
  private decideAccess(p: Principal, action: PolicyAction): void {
    const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
    const d = decideAccess(p.grants, action, PERMISSIONS[perm], { callerUserId: p.user.userId });
    if (d.allowed) return;
    throw d.reason === 'ROLE' ? new ClinicalError('FORBIDDEN', `Missing permission ${perm}`) : new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
  }
  private event(ctx: TenantContext, action: string, org: OrganizationId | null, outcome: NewAuditEvent['outcome'], user: User | null, resourceId: string | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: org, action, resourceType: 'Integration', resourceId, personId: null, patientId: null, outcome,
      correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async tx<T>(ctx: TenantContext, action: string, fn: (repo: PgIntegrationRepository) => Promise<T>): Promise<T> {
    try {
      return await this.deps.uow.run(ctx, fn);
    } catch (e) {
      let code = 'INTERNAL';
      let outcome: NewAuditEvent['outcome'] = 'failure';
      if (e instanceof ClinicalError) {
        code = e.code;
        if (e.code === 'FORBIDDEN') outcome = 'denied';
      } else if (e instanceof TenantIsolationError) {
        code = e.code;
        outcome = 'denied';
      }
      try {
        await this.deps.audit.record(this.event(ctx, action, null, outcome, null, null, { code }));
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }
}

async function nameTaken<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw new ClinicalError('CONFLICT', 'An endpoint with this name already exists', { reason: 'ENDPOINT_NAME_TAKEN' });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Bộ giao định kỳ (trong tiến trình API)
// ---------------------------------------------------------------------------
export class IntegrationDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(
    private readonly deps: { pool: PgPoolLike; service: Pick<IntegrationService, 'dispatchOne'>; intervalMs: number; clock?: () => Date; batch?: number; log?: (r: Readonly<Record<string, unknown>>) => void },
  ) {}
  start(): void {
    if (this.timer || this.deps.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const client = await this.deps.pool.connect();
        let due: Array<{ tenant_id: string; organization_id: string; delivery_id: string }>;
        try {
          due = (await client.query('SELECT tenant_id, organization_id, delivery_id FROM integration.due_deliveries($1, $2)', [
            (this.deps.clock?.() ?? new Date()).toISOString(), this.deps.batch ?? 50,
          ])).rows as typeof due;
        } finally {
          client.release();
        }
        let sent = 0;
        let failed = 0;
        for (const d of due) {
          try {
            const r = await this.deps.service.dispatchOne(d.tenant_id, d.organization_id, d.delivery_id);
            if (r.outcome === 'success') sent++;
            else if (r.outcome !== 'skipped') failed++;
          } catch {
            failed++;
          }
        }
        if (sent || failed) this.deps.log?.({ level: failed ? 'warn' : 'info', msg: 'integration dispatch', sent, failed });
      } catch (e) {
        this.deps.log?.({ level: 'warn', msg: 'integration dispatch tick failed', error: (e as { code?: string }).code ?? 'INTERNAL' });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
