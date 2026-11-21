/**
 * HCOS-F11 | Decision Engine có kiểm soát: Observe → Detect → Decide → Act.
 *
 *  Observe  — bộ phát hiện (catalog.ts) đọc dữ liệu nghiệp vụ hiện có (sinh hiệu, dự báo tải / tồn kho F10, ca thu ngân,
 *             phiếu huỷ, lịch hẹn, hồ sơ thanh toán, ICD-10, đơn thuốc, lượt khám) và tạo "ứng viên" gồm chỉ số + khoá đối tượng.
 *  Detect   — luật đang bật của cơ sở so điều kiện (AND) trên chỉ số; thiếu chỉ số => không khớp.
 *  Decide   — cooldown theo (luật, đối tượng): đã báo trong N phút gần nhất => bỏ qua (ghi số bị chặn vào lần chạy).
 *  Act      — CHỈ: ghi sự kiện + nhật ký, gửi thông báo vào hộp thư theo vai trò, kèm gợi ý (liên kết mở màn hình nghiệp vụ).
 *             Engine KHÔNG ghi gì vào dữ liệu lâm sàng / tài chính / kho; mọi thay đổi do người dùng làm trên màn hình đó,
 *             bằng quyền của chính họ.
 *
 * Mọi thứ chạy trong transaction gắn tenant (RLS), theo từng cơ sở; một lần chạy giữ advisory lock của cơ sở để hai lần
 * chạy (lịch + bấm tay) không chồng nhau. Mỗi bộ phát hiện chạy trong SAVEPOINT: một bộ lỗi không làm hỏng cả lần chạy.
 */
import { randomUUID } from 'node:crypto';

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
import { computeInventory, computeLoad, PgForecastRepository, vnDate, addDays, weekdayOf } from '../analytics/forecast.service';
import { ClinicalError } from '../clinical/encounter.service';
import { enqueueOutbox, organizationName, type OutboxInput } from '../integration/integration.service';
import { decisionPayload, systemPayload } from '../integration/payloads';
import {
  ACTIONS, DETECTOR_BY_ID, DETECTORS, matches, NOTIFY_ROLES, OPS, rolesSeeing, validateRule,
  type Condition, type DetectorSpec, type NotifyRole,
} from './catalog';
import { poissonZ, robustZ, round2 } from './stats';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export type RuleStatus = 'active' | 'paused' | 'retired';
export interface Rule {
  readonly ruleId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly detector: string;
  readonly conditions: Condition[];
  readonly priority: 1 | 2 | 3;
  readonly cooldownMinutes: number;
  readonly actions: string[];
  readonly status: RuleStatus;
  readonly version: number;
  readonly createdByName: string | null;
  readonly updatedByName: string | null;
  readonly updatedAt: string;
  readonly lastFiredAt: string | null;
  readonly events7d: number;
}
export interface RuleVersion {
  readonly version: number; readonly name: string; readonly conditions: Condition[]; readonly priority: number; readonly cooldownMinutes: number;
  readonly actions: string[]; readonly status: RuleStatus; readonly changedByName: string | null; readonly changedAt: string;
}
export interface RuleInput {
  readonly organizationId: string;
  readonly name: string;
  readonly detector: string;
  readonly conditions: Condition[];
  readonly priority: number;
  readonly cooldownMinutes: number;
  readonly actions: string[];
}
/** Ứng viên do bộ phát hiện tạo ra (chưa qua luật). */
export interface Candidate {
  readonly subjectKey: string;
  readonly metrics: Record<string, number | null>;
  readonly title: string;
  readonly detail: string | null;
  readonly link: string | null;
}
export interface EngineEvent {
  readonly eventId: string; readonly ruleId: string; readonly ruleName: string; readonly ruleVersion: number; readonly detector: string;
  readonly subjectKey: string; readonly priority: number; readonly title: string; readonly detail: string | null;
  readonly metrics: Record<string, number | null>; readonly link: string | null; readonly detectedAt: string;
  readonly notifications: Array<{ targetRole: NotifyRole; status: 'open' | 'handled'; suggestionStatus: 'pending' | 'applied' | 'dismissed' | null }>;
}
export interface ActionLogEntry {
  readonly actionId: number; readonly eventId: string; readonly eventTitle: string; readonly ruleName: string; readonly action: string;
  readonly actorType: 'engine' | 'user'; readonly actorName: string | null; readonly outcome: 'done' | 'skipped'; readonly note: string | null; readonly at: string;
}
export interface JobRun {
  readonly runId: string; readonly trigger: 'schedule' | 'manual'; readonly triggeredByName: string | null; readonly startedAt: string; readonly finishedAt: string;
  readonly durationMs: number; readonly status: 'success' | 'partial' | 'failed'; readonly rulesEvaluated: number; readonly candidates: number;
  readonly eventsCreated: number; readonly suppressed: number;
  readonly detail: Array<{ detector: string; ms: number; candidates: number; error: string | null }>; readonly errorCode: string | null;
}
export interface RunSummary extends Omit<JobRun, 'triggeredByName'> {
  readonly events: Array<{ eventId: string; ruleName: string; title: string; priority: number }>;
}
export interface Overview {
  readonly rules: { active: number; paused: number };
  readonly events24h: number;
  readonly eventsByPriority24h: { p1: number; p2: number; p3: number };
  readonly openNotifications: number;
  readonly pendingSuggestions: number;
  readonly lastRun: JobRun | null;
  readonly intervalMinutes: number | null;
}
export interface InboxItem {
  readonly notificationId: string; readonly eventId: string; readonly targetRole: NotifyRole; readonly detector: string; readonly ruleName: string;
  readonly priority: number; readonly title: string; readonly detail: string | null; readonly link: string | null; readonly detectedAt: string;
  readonly status: 'open' | 'handled'; readonly hasSuggestion: boolean; readonly suggestionStatus: 'pending' | 'applied' | 'dismissed' | null;
  readonly suggestionLabel: string | null; readonly handledByName: string | null; readonly handledAt: string | null; readonly handledNote: string | null;
  readonly version: number;
}
export interface Inbox {
  readonly items: InboxItem[];
  readonly openCount: number;
}
export type InboxAction = 'handle' | 'apply' | 'dismiss' | 'reopen';

// ---------------------------------------------------------------------------
// Hàm thuần
// ---------------------------------------------------------------------------
const TZ = 'Asia/Ho_Chi_Minh';
const vnd = (x: number): string => `${new Intl.NumberFormat('vi-VN').format(Math.round(x))} đ`;
const fmt = (x: number, digits = 1): string => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits }).format(x);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const n = (v: unknown): number => Number(v);
/** jsonb: driver pg trả object, psql (test) trả chuỗi. */
const j = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const bool = (v: unknown): boolean => v === true || v === 't';
/** Mảng tham số truyền dạng JSON rồi bung trong SQL (không phụ thuộc driver). */
const list = (xs: readonly string[]): string => JSON.stringify(xs);
const PERIOD_LABEL: Record<string, string> = { morning: 'sáng', afternoon: 'chiều' };
const ddmm = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const VITAL_CODES: Readonly<Record<string, { metric: string; label: string; unit: string }>> = {
  '59408-5': { metric: 'spo2_pct', label: 'SpO₂', unit: '%' },
  '8310-5': { metric: 'temperature_c', label: 'Nhiệt độ', unit: '°C' },
  '8867-4': { metric: 'pulse_bpm', label: 'Mạch', unit: 'lần/phút' },
  '8480-6': { metric: 'systolic_mmhg', label: 'HA tâm thu', unit: 'mmHg' },
  '8462-4': { metric: 'diastolic_mmhg', label: 'HA tâm trương', unit: 'mmHg' },
};

/** Lọc ứng viên theo luật + cooldown. `lastFired` = thời điểm báo gần nhất theo khoá đối tượng. */
export function decide(
  rule: { conditions: readonly Condition[]; cooldownMinutes: number },
  candidates: readonly Candidate[],
  lastFired: ReadonlyMap<string, number>,
  nowMs: number,
  cap = MAX_EVENTS_PER_RULE,
): { fire: Candidate[]; suppressed: number; capped: number } {
  const fire: Candidate[] = [];
  let suppressed = 0;
  let capped = 0;
  for (const c of candidates) {
    if (!matches(rule.conditions, c.metrics)) continue;
    const last = lastFired.get(c.subjectKey);
    if (last !== undefined && nowMs - last < rule.cooldownMinutes * 60_000) {
      suppressed++;
      continue;
    }
    if (fire.length >= cap) {
      capped++;
      continue;
    }
    fire.push(c);
  }
  return { fire, suppressed, capped };
}

const MAX_EVENTS_PER_RULE = 50;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
export class PgDecisionRepository extends PgForecastRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }
  get tenant(): string {
    return this.t;
  }

  /** HCOS-F12: ghi sự kiện ra outbox tích hợp (cùng transaction). */
  enqueueIntegration(e: OutboxInput): Promise<{ eventId: string | null; deliveryIds: string[] }> {
    return enqueueOutbox(this.db, this.t, e);
  }
  orgName(org: OrganizationId): Promise<string> {
    return organizationName(this.db, this.t, org);
  }

  /** Khoá theo cơ sở cho cả transaction; false = đang có lần chạy khác. */
  async tryLock(org: OrganizationId): Promise<boolean> {
    const r = await this.db.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended('hcos.decision:' || $1 || ':' || $2, 0)) AS ok`, [this.t, org]);
    return bool(r.rows[0]?.ok);
  }
  async savepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.db.query(`SAVEPOINT ${name}`);
    try {
      const v = await fn();
      await this.db.query(`RELEASE SAVEPOINT ${name}`);
      return v;
    } catch (e) {
      await this.db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    }
  }

  // ---- luật ----
  private ruleRow(x: Record<string, unknown>): Rule {
    return {
      ruleId: x['rule_id'] as string, organizationId: x['organization_id'] as string, name: x['name'] as string, detector: x['detector'] as string,
      conditions: j<Condition[]>(x['conditions']), priority: n(x['priority']) as 1 | 2 | 3, cooldownMinutes: n(x['cooldown_minutes']),
      actions: j<string[]>(x['actions']), status: x['status'] as RuleStatus, version: n(x['version']),
      createdByName: (x['created_by_name'] as string | null) ?? null, updatedByName: (x['updated_by_name'] as string | null) ?? null,
      updatedAt: iso(x['updated_at']), lastFiredAt: x['last_fired_at'] ? iso(x['last_fired_at']) : null, events7d: n(x['events_7d'] ?? 0),
    };
  }
  private readonly ruleSelect = `
    SELECT r.rule_id, r.organization_id, r.name, r.detector, r.conditions, r.priority, r.cooldown_minutes, to_jsonb(r.actions) AS actions, r.status, r.version, r.updated_at,
           cu.display_name AS created_by_name, uu.display_name AS updated_by_name,
           (SELECT max(e.detected_at) FROM decision.events e WHERE e.tenant_id = r.tenant_id AND e.rule_id = r.rule_id) AS last_fired_at,
           (SELECT count(*) FROM decision.events e WHERE e.tenant_id = r.tenant_id AND e.rule_id = r.rule_id AND e.detected_at > $3::timestamptz - interval '7 days') AS events_7d
      FROM decision.rules r
      LEFT JOIN iam.users cu ON cu.tenant_id = r.tenant_id AND cu.user_id = r.created_by
      LEFT JOIN iam.users uu ON uu.tenant_id = r.tenant_id AND uu.user_id = r.updated_by`;
  async listRules(org: OrganizationId, now: Date): Promise<Rule[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `${this.ruleSelect} WHERE r.tenant_id = $1 AND r.organization_id = $2 AND r.status <> 'retired'
        ORDER BY (r.status = 'active') DESC, r.priority, r.name`,
      [this.t, org, now.toISOString()],
    );
    return r.rows.map((x) => this.ruleRow(x));
  }
  async getRule(id: string, now: Date): Promise<Rule | null> {
    const r = await this.db.query<Record<string, unknown>>(`${this.ruleSelect} WHERE r.tenant_id = $1 AND r.rule_id = $2`, [this.t, id, now.toISOString()]);
    return r.rows[0] ? this.ruleRow(r.rows[0]) : null;
  }
  async activeRules(org: OrganizationId): Promise<Array<Pick<Rule, 'ruleId' | 'name' | 'detector' | 'conditions' | 'priority' | 'cooldownMinutes' | 'actions' | 'version'>>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT rule_id, name, detector, conditions, priority, cooldown_minutes, to_jsonb(actions) AS actions, version FROM decision.rules
        WHERE tenant_id = $1 AND organization_id = $2 AND status = 'active' ORDER BY priority, name`,
      [this.t, org],
    );
    return r.rows.map((x) => ({
      ruleId: x['rule_id'] as string, name: x['name'] as string, detector: x['detector'] as string, conditions: j<Condition[]>(x['conditions']),
      priority: n(x['priority']) as 1 | 2 | 3, cooldownMinutes: n(x['cooldown_minutes']), actions: j<string[]>(x['actions']), version: n(x['version']),
    }));
  }
  async insertRule(org: OrganizationId, i: RuleInput, by: string): Promise<string> {
    const r = await this.db.query<{ rule_id: string }>(
      `INSERT INTO decision.rules (tenant_id, organization_id, name, detector, conditions, priority, cooldown_minutes, actions, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, ARRAY(SELECT jsonb_array_elements_text($8::jsonb)), $9, $9) RETURNING rule_id`,
      [this.t, org, i.name.trim(), i.detector, JSON.stringify(i.conditions), i.priority, i.cooldownMinutes, list(i.actions), by],
    );
    return r.rows[0]!.rule_id;
  }
  async updateRule(id: string, i: Omit<RuleInput, 'organizationId' | 'detector'>, by: string, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE decision.rules SET name = $3, conditions = $4::jsonb, priority = $5, cooldown_minutes = $6, actions = ARRAY(SELECT jsonb_array_elements_text($7::jsonb)), updated_by = $8
        WHERE tenant_id = $1 AND rule_id = $2 AND version = $9 AND status <> 'retired' RETURNING 1`,
      [this.t, id, i.name.trim(), JSON.stringify(i.conditions), i.priority, i.cooldownMinutes, list(i.actions), by, expectedVersion],
    );
    return r.rows.length > 0;
  }
  async setRuleStatus(id: string, status: RuleStatus, by: string, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE decision.rules SET status = $3, updated_by = $4 WHERE tenant_id = $1 AND rule_id = $2 AND version = $5 AND status <> 'retired' RETURNING 1`,
      [this.t, id, status, by, expectedVersion],
    );
    return r.rows.length > 0;
  }
  async ruleVersions(id: string): Promise<RuleVersion[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT v.version, v.name, v.conditions, v.priority, v.cooldown_minutes, to_jsonb(v.actions) AS actions, v.status, u.display_name, v.changed_at
         FROM decision.rule_versions v LEFT JOIN iam.users u ON u.tenant_id = v.tenant_id AND u.user_id = v.changed_by
        WHERE v.tenant_id = $1 AND v.rule_id = $2 ORDER BY v.version DESC LIMIT 100`,
      [this.t, id],
    );
    return r.rows.map((x) => ({
      version: n(x['version']), name: x['name'] as string, conditions: j<Condition[]>(x['conditions']), priority: n(x['priority']),
      cooldownMinutes: n(x['cooldown_minutes']), actions: j<string[]>(x['actions']), status: x['status'] as RuleStatus,
      changedByName: (x['display_name'] as string | null) ?? null, changedAt: iso(x['changed_at']),
    }));
  }

  // ---- sự kiện / hành động / thông báo / lần chạy ----
  async lastFired(ruleId: string, keys: readonly string[]): Promise<Map<string, number>> {
    if (keys.length === 0) return new Map();
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT subject_key, max(detected_at) AS at FROM decision.events WHERE tenant_id = $1 AND rule_id = $2 AND subject_key IN (SELECT jsonb_array_elements_text($3::jsonb)) GROUP BY 1`,
      [this.t, ruleId, list(keys)],
    );
    return new Map(r.rows.map((x) => [x['subject_key'] as string, Date.parse(iso(x['at']))]));
  }
  async insertEvent(e: { org: OrganizationId; ruleId: string; ruleVersion: number; runId: string; detector: string; priority: number; c: Candidate; at: Date }): Promise<string> {
    const r = await this.db.query<{ event_id: string }>(
      `INSERT INTO decision.events (tenant_id, organization_id, rule_id, rule_version, run_id, detector, subject_key, priority, title, detail, metrics, link, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13) RETURNING event_id`,
      [this.t, e.org, e.ruleId, e.ruleVersion, e.runId, e.detector, e.c.subjectKey, e.priority, e.c.title.slice(0, 200), e.c.detail?.slice(0, 1000) ?? null,
        JSON.stringify(e.c.metrics), e.c.link, e.at.toISOString()],
    );
    return r.rows[0]!.event_id;
  }
  async insertAction(org: OrganizationId, eventId: string, action: string, actor: { userId: string } | null, outcome: 'done' | 'skipped', note: string | null, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO decision.action_log (tenant_id, organization_id, event_id, action, actor_type, actor_user_id, outcome, note, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [this.t, org, eventId, action, actor ? 'user' : 'engine', actor?.userId ?? null, outcome, note, at.toISOString()],
    );
  }
  async insertNotification(org: OrganizationId, eventId: string, role: NotifyRole, suggestion: boolean, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO decision.notifications (tenant_id, organization_id, event_id, target_role, has_suggestion, suggestion_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [this.t, org, eventId, role, suggestion, suggestion ? 'pending' : null, at.toISOString()],
    );
  }
  async insertRun(org: OrganizationId, r: Omit<JobRun, 'triggeredByName' | 'durationMs'> & { triggeredBy: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO decision.job_runs (run_id, tenant_id, organization_id, trigger, triggered_by, started_at, finished_at, status, rules_evaluated, candidates, events_created, suppressed, detail, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
      [r.runId, this.t, org, r.trigger, r.triggeredBy, r.startedAt, r.finishedAt, r.status, r.rulesEvaluated, r.candidates, r.eventsCreated, r.suppressed, JSON.stringify(r.detail), r.errorCode],
    );
  }
  async events(org: OrganizationId, q: { limit: number; detector?: string; priority?: number }): Promise<EngineEvent[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT e.event_id, e.rule_id, r.name AS rule_name, e.rule_version, e.detector, e.subject_key, e.priority, e.title, e.detail, e.metrics, e.link, e.detected_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('targetRole', x.target_role, 'status', x.status, 'suggestionStatus', x.suggestion_status) ORDER BY x.target_role)
                          FROM decision.notifications x WHERE x.tenant_id = e.tenant_id AND x.event_id = e.event_id), '[]'::jsonb) AS notifications
         FROM decision.events e JOIN decision.rules r ON r.tenant_id = e.tenant_id AND r.rule_id = e.rule_id
        WHERE e.tenant_id = $1 AND e.organization_id = $2 AND ($4::text IS NULL OR e.detector = $4) AND ($5::int IS NULL OR e.priority = $5)
        ORDER BY e.detected_at DESC, e.priority LIMIT $3`,
      [this.t, org, q.limit, q.detector ?? null, q.priority ?? null],
    );
    return r.rows.map((x) => ({
      eventId: x['event_id'] as string, ruleId: x['rule_id'] as string, ruleName: x['rule_name'] as string, ruleVersion: n(x['rule_version']),
      detector: x['detector'] as string, subjectKey: x['subject_key'] as string, priority: n(x['priority']), title: x['title'] as string,
      detail: (x['detail'] as string | null) ?? null, metrics: j<Record<string, number | null>>(x['metrics']), link: (x['link'] as string | null) ?? null,
      detectedAt: iso(x['detected_at']), notifications: j<EngineEvent['notifications']>(x['notifications']),
    }));
  }
  async actionLog(org: OrganizationId, limit: number): Promise<ActionLogEntry[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT a.action_id, a.event_id, e.title, r.name AS rule_name, a.action, a.actor_type, u.display_name, a.outcome, a.note, a.at
         FROM decision.action_log a
         JOIN decision.events e ON e.tenant_id = a.tenant_id AND e.event_id = a.event_id
         JOIN decision.rules r ON r.tenant_id = e.tenant_id AND r.rule_id = e.rule_id
         LEFT JOIN iam.users u ON u.tenant_id = a.tenant_id AND u.user_id = a.actor_user_id
        WHERE a.tenant_id = $1 AND a.organization_id = $2 ORDER BY a.at DESC, a.action_id DESC LIMIT $3`,
      [this.t, org, limit],
    );
    return r.rows.map((x) => ({
      actionId: n(x['action_id']), eventId: x['event_id'] as string, eventTitle: x['title'] as string, ruleName: x['rule_name'] as string,
      action: x['action'] as string, actorType: x['actor_type'] as 'engine' | 'user', actorName: (x['display_name'] as string | null) ?? null,
      outcome: x['outcome'] as 'done' | 'skipped', note: (x['note'] as string | null) ?? null, at: iso(x['at']),
    }));
  }
  private runRow(x: Record<string, unknown>): JobRun {
    return {
      runId: x['run_id'] as string, trigger: x['trigger'] as JobRun['trigger'], triggeredByName: (x['display_name'] as string | null) ?? null,
      startedAt: iso(x['started_at']), finishedAt: iso(x['finished_at']), durationMs: Date.parse(iso(x['finished_at'])) - Date.parse(iso(x['started_at'])),
      status: x['status'] as JobRun['status'], rulesEvaluated: n(x['rules_evaluated']), candidates: n(x['candidates']), eventsCreated: n(x['events_created']),
      suppressed: n(x['suppressed']), detail: j<JobRun['detail']>(x['detail']), errorCode: (x['error_code'] as string | null) ?? null,
    };
  }
  async runs(org: OrganizationId, limit: number): Promise<JobRun[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT j.*, u.display_name FROM decision.job_runs j LEFT JOIN iam.users u ON u.tenant_id = j.tenant_id AND u.user_id = j.triggered_by
        WHERE j.tenant_id = $1 AND j.organization_id = $2 ORDER BY j.started_at DESC LIMIT $3`,
      [this.t, org, limit],
    );
    return r.rows.map((x) => this.runRow(x));
  }
  async overviewCounts(org: OrganizationId, now: Date): Promise<Omit<Overview, 'lastRun' | 'intervalMinutes'>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT (SELECT count(*) FROM decision.rules WHERE tenant_id = $1 AND organization_id = $2 AND status = 'active') AS active,
              (SELECT count(*) FROM decision.rules WHERE tenant_id = $1 AND organization_id = $2 AND status = 'paused') AS paused,
              (SELECT count(*) FILTER (WHERE priority = 1) FROM decision.events WHERE tenant_id = $1 AND organization_id = $2 AND detected_at > $3::timestamptz - interval '24 hours') AS p1,
              (SELECT count(*) FILTER (WHERE priority = 2) FROM decision.events WHERE tenant_id = $1 AND organization_id = $2 AND detected_at > $3::timestamptz - interval '24 hours') AS p2,
              (SELECT count(*) FILTER (WHERE priority = 3) FROM decision.events WHERE tenant_id = $1 AND organization_id = $2 AND detected_at > $3::timestamptz - interval '24 hours') AS p3,
              (SELECT count(DISTINCT event_id) FROM decision.notifications WHERE tenant_id = $1 AND organization_id = $2 AND status = 'open') AS open_n,
              (SELECT count(DISTINCT event_id) FROM decision.notifications WHERE tenant_id = $1 AND organization_id = $2 AND suggestion_status = 'pending') AS pending_s`,
      [this.t, org, now.toISOString()],
    );
    const x = r.rows[0]!;
    const p1 = n(x['p1']), p2 = n(x['p2']), p3 = n(x['p3']);
    return {
      rules: { active: n(x['active']), paused: n(x['paused']) }, events24h: p1 + p2 + p3, eventsByPriority24h: { p1, p2, p3 },
      openNotifications: n(x['open_n']), pendingSuggestions: n(x['pending_s']),
    };
  }
  async inbox(org: OrganizationId, targets: readonly NotifyRole[], all: boolean): Promise<Array<Omit<InboxItem, 'suggestionLabel'>>> {
    if (targets.length === 0) return [];
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT n.notification_id, n.event_id, n.target_role, n.has_suggestion, n.status, n.suggestion_status, n.handled_at, n.handled_note, n.version,
              hu.display_name AS handled_by_name, e.detector, e.priority, e.title, e.detail, e.link, e.detected_at, r.name AS rule_name
         FROM decision.notifications n
         JOIN decision.events e ON e.tenant_id = n.tenant_id AND e.event_id = n.event_id
         JOIN decision.rules r ON r.tenant_id = e.tenant_id AND r.rule_id = e.rule_id
         LEFT JOIN iam.users hu ON hu.tenant_id = n.tenant_id AND hu.user_id = n.handled_by
        WHERE n.tenant_id = $1 AND n.organization_id = $2 AND n.target_role IN (SELECT jsonb_array_elements_text($3::jsonb))
          AND (n.status = 'open' OR ($4 AND n.updated_at > now() - interval '7 days'))
        ORDER BY (n.status = 'open') DESC, e.priority, e.detected_at DESC LIMIT 200`,
      [this.t, org, list(targets), all],
    );
    return r.rows.map((x) => ({
      notificationId: x['notification_id'] as string, eventId: x['event_id'] as string, targetRole: x['target_role'] as NotifyRole,
      detector: x['detector'] as string, ruleName: x['rule_name'] as string, priority: n(x['priority']), title: x['title'] as string,
      detail: (x['detail'] as string | null) ?? null, link: (x['link'] as string | null) ?? null, detectedAt: iso(x['detected_at']),
      status: x['status'] as 'open' | 'handled', hasSuggestion: bool(x['has_suggestion']), suggestionStatus: (x['suggestion_status'] as InboxItem['suggestionStatus']) ?? null,
      handledByName: (x['handled_by_name'] as string | null) ?? null, handledAt: x['handled_at'] ? iso(x['handled_at']) : null,
      handledNote: (x['handled_note'] as string | null) ?? null, version: n(x['version']),
    }));
  }
  async findNotification(id: string): Promise<{ organizationId: OrganizationId; eventId: string; targetRole: NotifyRole; status: 'open' | 'handled'; hasSuggestion: boolean; suggestionStatus: string | null; version: number; link: string | null; detector: string } | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT n.organization_id, n.event_id, n.target_role, n.status, n.has_suggestion, n.suggestion_status, n.version, e.link, e.detector
         FROM decision.notifications n JOIN decision.events e ON e.tenant_id = n.tenant_id AND e.event_id = n.event_id
        WHERE n.tenant_id = $1 AND n.notification_id = $2`,
      [this.t, id],
    );
    const x = r.rows[0];
    return x
      ? {
          organizationId: x['organization_id'] as OrganizationId, eventId: x['event_id'] as string, targetRole: x['target_role'] as NotifyRole,
          status: x['status'] as 'open' | 'handled', hasSuggestion: bool(x['has_suggestion']), suggestionStatus: (x['suggestion_status'] as string | null) ?? null,
          version: n(x['version']), link: (x['link'] as string | null) ?? null, detector: x['detector'] as string,
        }
      : null;
  }
  /** Cập nhật thông báo đã bấm (khớp version) và các thông báo cùng sự kiện gửi tới vai trò khác của chính người dùng. */
  async updateNotifications(
    id: string, eventId: string, targets: readonly NotifyRole[], expectedVersion: number,
    s: { status: 'open' | 'handled'; suggestion: 'keep' | 'pending' | 'applied' | 'dismissed'; by: string | null; note: string | null; at: Date },
  ): Promise<boolean> {
    const set = `status = $3, handled_by = $4, handled_at = CASE WHEN $3 = 'handled' THEN $5::timestamptz END, handled_note = $6,
                 suggestion_status = CASE WHEN NOT has_suggestion THEN NULL WHEN $7 = 'keep' THEN suggestion_status ELSE $7 END`;
    const p = [this.t, id, s.status, s.by, s.at.toISOString(), s.note, s.suggestion];
    const r = await this.db.query(`UPDATE decision.notifications SET ${set} WHERE tenant_id = $1 AND notification_id = $2 AND version = $8 RETURNING 1`, [...p, expectedVersion]);
    if (r.rows.length === 0) return false;
    await this.db.query(
      `UPDATE decision.notifications SET ${set} WHERE tenant_id = $1 AND event_id = $8 AND notification_id <> $2 AND target_role IN (SELECT jsonb_array_elements_text($9::jsonb))`,
      [...p, eventId, list(targets)],
    );
    return true;
  }

  // ---- bộ phát hiện: chỉ ĐỌC dữ liệu nghiệp vụ ----
  async latestVitals(org: OrganizationId, now: Date): Promise<Array<{ encounterId: string; code: string; value: number; effectiveAt: string }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (o.encounter_id, o.code) o.encounter_id, o.code, o.value_numeric, o.effective_at
         FROM clinical.observations o JOIN clinical.encounters e ON e.tenant_id = o.tenant_id AND e.encounter_id = o.encounter_id
        WHERE o.tenant_id = $1 AND e.organization_id = $2 AND e.status = 'in_progress' AND o.code_system = 'http://loinc.org'
          AND o.code IN (SELECT jsonb_array_elements_text($3::jsonb)) AND o.status IN ('final', 'amended', 'corrected') AND o.value_numeric IS NOT NULL
          AND o.effective_at > $4::timestamptz - interval '24 hours' AND o.effective_at <= $4::timestamptz
          AND NOT EXISTS (SELECT 1 FROM clinical.observations s WHERE s.tenant_id = o.tenant_id AND s.supersedes_observation_id = o.observation_id
                            AND s.status <> 'entered_in_error')
        ORDER BY o.encounter_id, o.code, o.effective_at DESC`,
      [this.t, org, list(Object.keys(VITAL_CODES)), now.toISOString()],
    );
    return r.rows.map((x) => ({ encounterId: x['encounter_id'] as string, code: x['code'] as string, value: n(x['value_numeric']), effectiveAt: iso(x['effective_at']) }));
  }
  async closedShifts(org: OrganizationId, now: Date): Promise<Array<{ shiftId: string; difference: number; closedAt: string; cashier: string | null }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT s.shift_id, s.cash_difference, s.closed_at, u.display_name FROM finance.cashier_shifts s
         LEFT JOIN iam.users u ON u.tenant_id = s.tenant_id AND u.user_id = s.user_id
        WHERE s.tenant_id = $1 AND s.organization_id = $2 AND s.status = 'closed'
          AND s.closed_at > $3::timestamptz - interval '7 days' AND s.closed_at <= $3::timestamptz`,
      [this.t, org, now.toISOString()],
    );
    return r.rows.map((x) => ({ shiftId: x['shift_id'] as string, difference: n(x['cash_difference']), closedAt: iso(x['closed_at']), cashier: (x['display_name'] as string | null) ?? null }));
  }
  async receiptsByCashier(org: OrganizationId, now: Date): Promise<Array<{ userId: string; name: string | null; total: number; cancelled: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT r.created_by, u.display_name, count(*) AS total, count(*) FILTER (WHERE r.status = 'cancelled') AS cancelled
         FROM finance.receipts r LEFT JOIN iam.users u ON u.tenant_id = r.tenant_id AND u.user_id = r.created_by
        WHERE r.tenant_id = $1 AND r.organization_id = $2 AND r.created_at > $3::timestamptz - interval '7 days' AND r.created_at <= $3::timestamptz
        GROUP BY 1, 2`,
      [this.t, org, now.toISOString()],
    );
    return r.rows.map((x) => ({ userId: x['created_by'] as string, name: (x['display_name'] as string | null) ?? null, total: n(x['total']), cancelled: n(x['cancelled']) }));
  }
  /** HCOS-F19: chế độ kiểm định của thiết bị chưa thanh lý. */
  async deviceRegimes(org: OrganizationId): Promise<Array<{ deviceId: string; assetCode: string; name: string; room: string | null; regime: string; mandatory: boolean; state: string; validUntil: string | null; today: string }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT d.device_id, d.asset_code, d.name, sp.code AS room, s.regime, s.mandatory, s.state, s.valid_until::text AS valid_until, (now() AT TIME ZONE '${TZ}')::date::text AS today
         FROM equipment.regime_status s JOIN equipment.devices d ON d.tenant_id = s.tenant_id AND d.device_id = s.device_id
         LEFT JOIN clinical.service_points sp ON sp.tenant_id = d.tenant_id AND sp.service_point_id = d.service_point_id
        WHERE s.tenant_id = $1 AND d.organization_id = $2 AND d.status <> 'retired'`,
      [this.t, org],
    );
    return r.rows.map((x) => ({
      deviceId: x['device_id'] as string, assetCode: x['asset_code'] as string, name: x['name'] as string, room: (x['room'] as string | null) ?? null, regime: x['regime'] as string,
      mandatory: x['mandatory'] === true || x['mandatory'] === 't', state: x['state'] as string, validUntil: x['valid_until'] ? String(x['valid_until']).slice(0, 10) : null,
      today: String(x['today']).slice(0, 10),
    }));
  }
  async devicesOutOfService(org: OrganizationId): Promise<Array<{ deviceId: string; assetCode: string; name: string; room: string | null; status: string; since: string }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT d.device_id, d.asset_code, d.name, sp.code AS room, d.status, d.status_since
         FROM equipment.devices d LEFT JOIN clinical.service_points sp ON sp.tenant_id = d.tenant_id AND sp.service_point_id = d.service_point_id
        WHERE d.tenant_id = $1 AND d.organization_id = $2 AND d.status IN ('broken', 'maintenance')`,
      [this.t, org],
    );
    return r.rows.map((x) => ({
      deviceId: x['device_id'] as string, assetCode: x['asset_code'] as string, name: x['name'] as string, room: (x['room'] as string | null) ?? null,
      status: x['status'] as string, since: iso(x['status_since']),
    }));
  }
  async openShortfalls(org: OrganizationId, now: Date): Promise<Array<{ medicationId: string; name: string; unit: string; qty: number; lines: number; oldest: string }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT c.medication_id, m.brand_name, m.unit_of_measure, sum(c.quantity) AS qty, count(*) AS lines, min(c.created_at) AS oldest
         FROM equipment.supply_consumptions c JOIN pharmacy.medications m ON m.tenant_id = c.tenant_id AND m.medication_id = c.medication_id
        WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.source = 'shortfall' AND c.created_at > $3::timestamptz - interval '30 days'
          AND NOT EXISTS (SELECT 1 FROM equipment.supply_shortfall_resolutions r WHERE r.tenant_id = c.tenant_id AND r.consumption_id = c.consumption_id)
        GROUP BY 1, 2, 3`,
      [this.t, org, now.toISOString()],
    );
    return r.rows.map((x) => ({ medicationId: x['medication_id'] as string, name: x['brand_name'] as string, unit: x['unit_of_measure'] as string, qty: n(x['qty']), lines: n(x['lines']), oldest: iso(x['oldest']) }));
  }
  /** Lịch hẹn theo tuần lùi: tuần 0 = 7 ngày trước hôm nay, 1..8 = các tuần trước đó. */
  async bookingWeeks(org: OrganizationId, today: string): Promise<Array<{ week: number; total: number; noShow: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT (($3::date - visit_date) - 1) / 7 AS wk, count(*) FILTER (WHERE status <> 'cancelled') AS total,
              count(*) FILTER (WHERE status IN ('no_show', 'booked')) AS no_show
         FROM clinical.bookings WHERE tenant_id = $1 AND organization_id = $2 AND visit_date BETWEEN $3::date - 63 AND $3::date - 1 GROUP BY 1`,
      [this.t, org, today],
    );
    return r.rows.map((x) => ({ week: n(x['wk']), total: n(x['total']), noShow: n(x['no_show']) }));
  }
  async openCases(org: OrganizationId): Promise<Array<{ caseId: string; openedAt: string; held: number; charges: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT c.case_id, c.opened_at,
              COALESCE((SELECT sum(CASE WHEN r.kind = 'refund' THEN -r.amount ELSE r.amount END) FROM finance.receipts r
                         WHERE r.tenant_id = c.tenant_id AND r.case_id = c.case_id AND r.status = 'valid'), 0) AS held,
              COALESCE((SELECT sum(ch.amount) FROM finance.charges ch WHERE ch.tenant_id = c.tenant_id AND ch.case_id = c.case_id AND ch.status = 'active'), 0) AS charges
         FROM finance.billing_cases c WHERE c.tenant_id = $1 AND c.organization_id = $2 AND c.status = 'open'`,
      [this.t, org],
    );
    return r.rows.map((x) => ({ caseId: x['case_id'] as string, openedAt: iso(x['opened_at']), held: n(x['held']), charges: n(x['charges']) }));
  }
  async undispensed(org: OrganizationId, now: Date): Promise<Array<{ prescriptionId: string; prescribedAt: string; items: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT p.prescription_id, p.prescribed_at, count(*) FILTER (WHERE i.quantity_dispensed < i.quantity_prescribed) AS items
         FROM clinical.prescriptions p JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
        WHERE p.tenant_id = $1 AND p.organization_id = $2 AND p.status = 'active'
          AND p.prescribed_at > $3::timestamptz - interval '30 days' AND p.prescribed_at <= $3::timestamptz
        GROUP BY 1, 2 HAVING count(*) FILTER (WHERE i.quantity_dispensed < i.quantity_prescribed) > 0`,
      [this.t, org, now.toISOString()],
    );
    return r.rows.map((x) => ({ prescriptionId: x['prescription_id'] as string, prescribedAt: iso(x['prescribed_at']), items: n(x['items']) }));
  }
  async visitsOn(org: OrganizationId, dates: readonly string[]): Promise<{ counts: Map<string, number>; first: string | null }> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT (period_start AT TIME ZONE '${TZ}')::date::text AS d, count(*) AS c FROM clinical.encounters
        WHERE tenant_id = $1 AND organization_id = $2 AND encounter_class IN ('ambulatory', 'emergency') AND status NOT IN ('cancelled', 'entered_in_error')
          AND (period_start AT TIME ZONE '${TZ}')::date IN (SELECT jsonb_array_elements_text($3::jsonb)::date) GROUP BY 1`,
      [this.t, org, list(dates)],
    );
    const f = await this.db.query<Record<string, unknown>>(
      `SELECT min((period_start AT TIME ZONE '${TZ}')::date)::text AS d FROM clinical.encounters
        WHERE tenant_id = $1 AND organization_id = $2 AND encounter_class IN ('ambulatory', 'emergency') AND status NOT IN ('cancelled', 'entered_in_error')`,
      [this.t, org],
    );
    return { counts: new Map(r.rows.map((x) => [x['d'] as string, n(x['c'])])), first: (f.rows[0]?.['d'] as string | null) ?? null };
  }
}

// ---------------------------------------------------------------------------
// Bộ phát hiện (Observe): mỗi bộ trả danh sách ứng viên. Tiêu đề không chứa tên / định danh bệnh nhân.
// ---------------------------------------------------------------------------
type Collector = (repo: PgDecisionRepository, org: OrganizationId, now: Date) => Promise<Candidate[]>;
const COLLECTORS: Readonly<Record<string, Collector>> = {
  async vital_abnormal(repo, org, now) {
    return (await repo.latestVitals(org, now)).map((v) => {
      const spec = VITAL_CODES[v.code]!;
      const age = Math.max(0, Math.round((now.getTime() - Date.parse(v.effectiveAt)) / 60_000));
      return {
        subjectKey: `encounter:${v.encounterId}:${v.code}`,
        metrics: { [spec.metric]: v.value, age_minutes: age },
        title: `${spec.label} ${fmt(v.value)} ${spec.unit} — đợt khám đang mở`,
        detail: `Đo cách đây ${age} phút. Mở hồ sơ để xem bệnh nhân (truy cập hồ sơ được ghi nhật ký).`,
        link: `#/encounters/${v.encounterId}`,
      };
    });
  },
  async room_overload(repo, org, now) {
    const load = await computeLoad(repo, org, 7, now);
    const today = vnDate(now);
    const code = new Map(load.rooms.map((r) => [r.servicePointId, r.code]));
    const out: Candidate[] = [];
    for (const d of load.days)
      for (const p of ['morning', 'afternoon'] as const)
        for (const c of d.periods[p]) {
          if (!c.capacity || !c.servicePointId) continue;
          const pct = Math.round((c.total / c.capacity) * 100);
          out.push({
            subjectKey: `room:${c.servicePointId}:${d.date}:${p}`,
            metrics: { utilization_pct: pct, forecast_visits: c.total, capacity: c.capacity, days_ahead: daysBetween(today, d.date) },
            title: `Phòng ${code.get(c.servicePointId) ?? '—'} buổi ${PERIOD_LABEL[p]} ${ddmm(d.date)}: dự báo ${fmt(c.total)}/${c.capacity} lượt (${pct}%)`,
            detail: `Vãng lai ${fmt(c.walkIn)} + đặt lịch ${fmt(c.booked)} + tái khám ${fmt(c.followUp)}. Cân nhắc mở thêm bàn khám hoặc giãn lịch hẹn.`,
            link: '#/forecast',
          });
        }
    return out;
  },
  async stock_low(repo, org, now) {
    const inv = await computeInventory(repo, org, now);
    return inv.lines
      .filter((l) => l.status !== 'no_demand')
      .map((l) => ({
        subjectKey: `med:${l.medicationId}`,
        metrics: {
          below_reorder_point: l.status === 'ok' ? 0 : 1, days_of_cover: l.daysOfCover, available_qty: l.available, reorder_point: l.reorderPoint,
          suggested_order: l.suggestedOrder, trend_factor: l.trendFactor,
        },
        title: `${l.name}: còn ${fmt(l.available, 0)} ${l.unit}${l.daysOfCover !== null ? ` (~${fmt(l.daysOfCover)} ngày)` : ''}, điểm đặt hàng ${l.reorderPoint}`,
        detail: l.suggestedOrder > 0 ? `Gợi ý đặt ${fmt(l.suggestedOrder, 0)} ${l.unit}${l.estimatedOrderValue ? ` (~${vnd(l.estimatedOrderValue)})` : ''}.` : null,
        link: '#/forecast',
      }));
  },
  async stock_expiry(repo, org, now) {
    const inv = await computeInventory(repo, org, now);
    const today = vnDate(now);
    return inv.lines
      .filter((l) => l.earliestExpiry)
      .map((l) => {
        const days = daysBetween(today, l.earliestExpiry!);
        return {
          subjectKey: `med:${l.medicationId}`,
          metrics: { days_to_expiry: days, expiry_risk_qty: l.expiryRiskQty, available_qty: l.available },
          title: `${l.name}: lô gần nhất hết hạn ${ddmm(l.earliestExpiry!)}/${l.earliestExpiry!.slice(0, 4)} (còn ${days} ngày)`,
          detail: l.expiryRiskQty > 0 ? `Khoảng ${fmt(l.expiryRiskQty, 0)} ${l.unit} có thể hết hạn trước khi dùng hết.` : null,
          link: '#/forecast',
        };
      });
  },
  async cash_difference(repo, org, now) {
    return (await repo.closedShifts(org, now)).map((s) => ({
      subjectKey: `shift:${s.shiftId}`,
      metrics: { difference_vnd: s.difference, abs_difference_vnd: Math.abs(s.difference), hours_since_close: round2((now.getTime() - Date.parse(s.closedAt)) / 3_600_000) },
      title: `Ca thu ngân ${s.cashier ?? ''} lệch quỹ ${s.difference > 0 ? '+' : ''}${vnd(s.difference)}`.replace(/\s+/g, ' '),
      detail: s.difference > 0 ? 'Tiền đếm thừa so với sổ.' : s.difference < 0 ? 'Tiền đếm thiếu so với sổ.' : null,
      link: `#/finance/shifts/${s.shiftId}`,
    }));
  },
  async receipt_cancellations(repo, org, now) {
    const rows = await repo.receiptsByCashier(org, now);
    const pct = rows.map((r) => (r.total ? (r.cancelled / r.total) * 100 : 0));
    return rows.map((r, i) => {
      const others = pct.filter((_, j) => j !== i);
      const z = others.length >= 2 ? robustZ(pct[i]!, others, 2) : null;
      return {
        subjectKey: `cashier:${r.userId}`,
        metrics: { cancel_count: r.cancelled, receipt_count: r.total, cancel_pct: round2(pct[i]!), robust_z: z },
        title: `${r.name ?? 'Thu ngân'}: huỷ ${r.cancelled}/${r.total} phiếu trong 7 ngày (${fmt(pct[i]!)}%)`,
        detail: z !== null ? `Điểm bất thường so với ${others.length} thu ngân khác: z = ${fmt(z, 2)}.` : 'Chưa đủ thu ngân để so sánh (cần ≥ 3).',
        link: '#/reports',
      };
    });
  },
  async booking_no_show(repo, org, now) {
    const weeks = await repo.bookingWeeks(org, vnDate(now));
    const w0 = weeks.find((w) => w.week === 0);
    if (!w0 || w0.total === 0) return [];
    const prior = weeks.filter((w) => w.week >= 1 && w.week <= 8 && w.total > 0);
    const pt = prior.reduce((a, w) => a + w.total, 0);
    const pn = prior.reduce((a, w) => a + w.noShow, 0);
    const p0 = (w0.noShow / w0.total) * 100;
    const z = robustZ(p0, prior.map((w) => (w.noShow / w.total) * 100), 4);
    return [{
      subjectKey: 'org:no_show',
      metrics: { no_show_pct: round2(p0), no_show_count: w0.noShow, booked_count: w0.total, baseline_pct: pt ? round2((pn / pt) * 100) : null, robust_z: z },
      title: `Lịch hẹn 7 ngày qua: vắng ${w0.noShow}/${w0.total} (${fmt(p0)}%)${pt ? `, 8 tuần trước ${fmt((pn / pt) * 100)}%` : ''}`,
      detail: 'Cân nhắc nhắc lịch trước 1 ngày hoặc giảm số chỗ đặt mỗi buổi.',
      link: '#/bookings',
    }];
  },
  async deposit_aging(repo, org, now) {
    return (await repo.openCases(org))
      .filter((c) => c.held > 0)
      .map((c) => {
        const age = Math.floor((now.getTime() - Date.parse(c.openedAt)) / 86_400_000);
        return {
          subjectKey: `case:${c.caseId}`,
          metrics: { age_days: age, held_vnd: c.held, balance_due_vnd: Math.max(0, c.charges - c.held) },
          title: `Hồ sơ thanh toán mở ${age} ngày, đang giữ ${vnd(c.held)}`,
          detail: c.charges < c.held ? `Cần hoàn ${vnd(c.held - c.charges)} khi đóng hồ sơ.` : null,
          link: `#/finance/cases/${c.caseId}`,
        };
      });
  },
  async icd_spike(repo, org, now) {
    return (await repo.icdCounts(org, vnDate(now))).map((c) => {
      const avg = c.prior21 / 3;
      return {
        subjectKey: `icd:${c.code}`,
        metrics: { last7_count: c.last7, prior_weekly_avg: round2(avg), ratio: round2((c.last7 + 1) / (avg + 1)), poisson_z: poissonZ(c.last7, avg) },
        title: `${c.code}${c.display ? ` ${c.display}` : ''}: ${c.last7} ca / 7 ngày (trung bình ${fmt(avg)} ca/tuần trước đó)`,
        detail: 'Tín hiệu sớm — cần bác sĩ đánh giá, không phải kết luận dịch tễ.',
        link: '#/forecast',
      };
    });
  },
  async rx_not_dispensed(repo, org, now) {
    return (await repo.undispensed(org, now)).map((p) => {
      const h = round2((now.getTime() - Date.parse(p.prescribedAt)) / 3_600_000);
      return {
        subjectKey: `rx:${p.prescriptionId}`,
        metrics: { age_hours: h, undispensed_items: p.items },
        title: `Đơn thuốc kê ${fmt(h, 0)} giờ trước còn ${p.items} dòng chưa phát đủ`,
        detail: null,
        link: '#/pharmacy',
      };
    });
  },
  async visit_volume(repo, org, now) {
    const y = addDays(vnDate(now), -1);
    const hist = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => addDays(y, -7 * k));
    const { counts, first } = await repo.visitsOn(org, [y, ...hist]);
    if (!first || first > y) return [];
    const h = hist.filter((d) => d >= first).map((d) => counts.get(d) ?? 0);
    const x = counts.get(y) ?? 0;
    const z = robustZ(x, h, 4);
    const sorted = [...h].sort((a, b) => a - b);
    const med = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
    const wd = ['Chủ nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'][weekdayOf(y)];
    return [{
      subjectKey: `day:${y}`,
      metrics: { visits: x, baseline_median: med, robust_z: z, abs_robust_z: z === null ? null : Math.abs(z) },
      title: `Hôm qua (${wd} ${ddmm(y)}): ${x} lượt khám, trung vị cùng thứ ${med === null ? '—' : fmt(med)}`,
      detail: z === null ? 'Chưa đủ 4 tuần lịch sử.' : `Điểm bất thường z = ${fmt(z, 2)}.`,
      link: '#/reports',
    }];
  },
  async device_inspection(repo, org) {
    return (await repo.deviceRegimes(org)).map((r) => {
      const overdue = ['overdue', 'failed', 'missing', 'reinspect'].includes(r.state);
      const days = r.validUntil ? daysBetween(r.today, r.validUntil) : null;
      const what = REGIME_LABEL[r.regime] ?? r.regime;
      const why = r.state === 'missing' ? 'chưa kiểm định lần nào' : r.state === 'failed' ? 'lần gần nhất KHÔNG ĐẠT' : r.state === 'reinspect' ? 'đã sửa chữa lớn, chưa kiểm định lại'
        : r.state === 'overdue' ? `hết hạn ${ddmm(r.validUntil!)}/${r.validUntil!.slice(0, 4)}` : `hết hạn ${ddmm(r.validUntil!)}/${r.validUntil!.slice(0, 4)} (còn ${days} ngày)`;
      return {
        subjectKey: `device:${r.deviceId}:${r.regime}`,
        metrics: { days_to_due: overdue && r.state !== 'overdue' ? -1 : days, overdue: overdue ? 1 : 0, mandatory: r.mandatory ? 1 : 0 },
        title: `${r.assetCode} ${r.name}${r.room ? ` (${r.room})` : ''}: ${what.toLowerCase()} ${why}`,
        detail: overdue && r.mandatory ? 'Máy đang bị chặn chỉ định cho tới khi ghi kết quả kiểm định đạt.' : null,
        link: `#/tb/${r.assetCode}`,
      };
    });
  },
  async device_out_of_service(repo, org, now) {
    return (await repo.devicesOutOfService(org)).map((d) => ({
      subjectKey: `device:${d.deviceId}:${d.status}:${d.since}`,
      metrics: { out_of_service: 1, broken: d.status === 'broken' ? 1 : 0, hours_out: round2((now.getTime() - Date.parse(d.since)) / 3_600_000) },
      title: `${d.assetCode} ${d.name}${d.room ? ` (${d.room})` : ''}: ${d.status === 'broken' ? 'HỎNG' : 'đang bảo trì'} — không chỉ định dịch vụ dùng máy này`,
      // Mô tả lỗi là văn bản tự do của nhân viên: KHÔNG đưa vào sự kiện (sự kiện P1–P2 có thể được gửi ra Teams / đối tác).
      detail: 'Xem mô tả lỗi và nhật ký trên trang thiết bị trong HealthcareOS.',
      link: `#/tb/${d.assetCode}`,
    }));
  },
  async supply_shortfall(repo, org, now) {
    return (await repo.openShortfalls(org, now)).map((s) => ({
      subjectKey: `supply:${s.medicationId}`,
      metrics: { shortfall_qty: s.qty, lines: s.lines, oldest_hours: round2((now.getTime() - Date.parse(s.oldest)) / 3_600_000) },
      title: `${s.name}: thiếu ${fmt(s.qty, 0)} ${s.unit} khi tất toán (${s.lines} dòng chờ đối soát)`,
      detail: 'Kiểm tra nhập kho / chuyển kho vào tủ vật tư, rồi đối soát ở tab Thiết bị & vật tư.',
      link: '#/equipment',
    }));
  },
};
const REGIME_LABEL: Readonly<Record<string, string>> = {
  atkt: 'Kiểm định an toàn & tính năng kỹ thuật', do_luong: 'Kiểm định phương tiện đo', buc_xa: 'Kiểm định an toàn bức xạ', ap_luc: 'Kiểm định thiết bị áp lực', hieu_chuan: 'Hiệu chuẩn',
};
// Mọi detector trong danh mục phải có bộ thu thập.
for (const d of DETECTORS) if (!COLLECTORS[d.id]) throw new Error(`Detector ${d.id} has no collector`);

// ---------------------------------------------------------------------------
// Unit of work
// ---------------------------------------------------------------------------
export interface DecisionUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PgDecisionRepository) => Promise<T>): Promise<T>;
}
export class PgDecisionUnitOfWork implements DecisionUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}
  run<T>(ctx: TenantContext, fn: (repo: PgDecisionRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgDecisionRepository(db));
      },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
type Permission = 'decision:read' | 'decision:manage' | 'notification:read';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'decision:read': ['clinic_admin', 'executive', 'tenant_admin'],
  'decision:manage': ['clinic_admin', 'tenant_admin'],
  'notification:read': ['doctor', 'pharmacist', 'clinic_staff', 'cashier', 'clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin'],
};
interface Principal { readonly user: User; readonly grants: readonly AccessGrant[]; readonly roles: ReadonlySet<Role> }
const SYSTEM_SUBJECT = 'system:decision-engine';

export function systemContext(tenantId: string, organizationId: string, correlationId: string = randomUUID()): TenantContext {
  return Object.freeze({
    tenantId: tenantId as TenantId, userSubject: SYSTEM_SUBJECT, userId: null, personId: null,
    activeOrganizationId: organizationId as OrganizationId, allowedOrganizationIds: Object.freeze([organizationId as OrganizationId]),
    roles: Object.freeze(['system'] as Role[]), tokenId: null, correlationId: correlationId as CorrelationId,
  });
}

export class DecisionEngineService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { uow: DecisionUnitOfWork; audit: AuditSink; clock?: () => Date; intervalMinutes?: number | null }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  catalog(): { detectors: readonly DetectorSpec[]; actions: typeof ACTIONS; ops: typeof OPS; notifyRoles: typeof NOTIFY_ROLES } {
    return { detectors: DETECTORS, actions: ACTIONS, ops: OPS, notifyRoles: NOTIFY_ROLES };
  }

  async overview(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<Overview> {
    return this.tx(ctx, 'decision.overview', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'decision:read');
      const counts = await repo.overviewCounts(org, this.clock());
      return { ...counts, lastRun: (await repo.runs(org, 1))[0] ?? null, intervalMinutes: this.deps.intervalMinutes ?? null };
    });
  }

  async listRules(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<Rule[]> {
    return this.tx(ctx, 'decision.rules.read', async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'decision:read');
      return repo.listRules(org, this.clock());
    });
  }

  async ruleVersions(ruleId: string, ctx: TenantContext = requireTenantContext()): Promise<RuleVersion[]> {
    return this.tx(ctx, 'decision.rules.history', async (repo) => {
      const rule = await this.ruleOf(repo, ruleId, ctx);
      this.decideAccess(await this.principal(repo, ctx, rule.organizationId as OrganizationId), 'decision:read');
      return repo.ruleVersions(rule.ruleId);
    });
  }

  async createRule(input: RuleInput, ctx: TenantContext = requireTenantContext()): Promise<Rule> {
    return this.tx(ctx, 'decision.rules.create', async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'decision:manage');
      const clean = this.validate(input);
      const id = await nameTaken(() => repo.insertRule(org, clean, p.user.userId));
      await repo.appendAudit(this.event(ctx, 'decision.rules.create', org, 'success', p.user, id, { detector: clean.detector, name: clean.name }));
      return (await repo.getRule(id, this.clock()))!;
    });
  }

  async updateRule(ruleId: string, input: Omit<RuleInput, 'organizationId' | 'detector'>, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<Rule> {
    return this.tx(ctx, 'decision.rules.update', async (repo) => {
      const rule = await this.ruleOf(repo, ruleId, ctx);
      const org = rule.organizationId as OrganizationId;
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'decision:manage');
      const clean = this.validate({ ...input, organizationId: org, detector: rule.detector });
      this.version(expectedVersion);
      if (!(await nameTaken(() => repo.updateRule(rule.ruleId, clean, p.user.userId, expectedVersion)))) {
        throw new ClinicalError('CONFLICT', 'Rule version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, 'decision.rules.update', org, 'success', p.user, rule.ruleId, { fromVersion: expectedVersion }));
      return (await repo.getRule(rule.ruleId, this.clock()))!;
    });
  }

  async setRuleStatus(ruleId: string, status: RuleStatus, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<Rule> {
    return this.tx(ctx, 'decision.rules.status', async (repo) => {
      if (!['active', 'paused', 'retired'].includes(status)) throw new ClinicalError('VALIDATION', 'status must be active, paused or retired', { reason: 'INVALID_RULE' });
      const rule = await this.ruleOf(repo, ruleId, ctx);
      const org = rule.organizationId as OrganizationId;
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'decision:manage');
      this.version(expectedVersion);
      if (rule.status === 'retired') throw new ClinicalError('CONFLICT', 'Rule is retired', { reason: 'RULE_RETIRED' });
      if (!(await repo.setRuleStatus(rule.ruleId, status, p.user.userId, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Rule version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, 'decision.rules.status', org, 'success', p.user, rule.ruleId, { status }));
      return (await repo.getRule(rule.ruleId, this.clock()))!;
    });
  }

  /** Thử luật trên dữ liệu hiện tại: KHÔNG ghi sự kiện / thông báo. */
  async preview(
    input: { organizationId: string; detector: string; conditions: Condition[]; cooldownMinutes?: number; ruleId?: string },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ candidates: number; matched: number; suppressed: number; sample: Array<Pick<Candidate, 'title' | 'metrics' | 'link'> & { inCooldown: boolean }> }> {
    return this.tx(ctx, 'decision.rules.preview', async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'decision:manage');
      const errs = validateRule({ detector: input.detector, conditions: input.conditions, actions: ['log_only'], priority: 3, cooldownMinutes: input.cooldownMinutes ?? 0, name: 'preview' });
      if (errs.length) throw new ClinicalError('VALIDATION', errs.join('; '), { reason: 'INVALID_RULE' });
      const now = this.clock();
      const cands = await COLLECTORS[input.detector]!(repo, org, now);
      const hit = cands.filter((c) => matches(input.conditions, c.metrics));
      let last = new Map<string, number>();
      if (input.ruleId && isUuid(input.ruleId)) {
        const rule = await repo.getRule(input.ruleId.toLowerCase(), now);
        if (rule && rule.organizationId === org) last = await repo.lastFired(rule.ruleId, hit.map((c) => c.subjectKey));
      }
      const cd = (input.cooldownMinutes ?? 0) * 60_000;
      const inCd = (c: Candidate) => last.has(c.subjectKey) && now.getTime() - last.get(c.subjectKey)! < cd;
      await repo.appendAudit(this.event(ctx, 'decision.rules.preview', org, 'success', p.user, null, { detector: input.detector, matched: hit.length }));
      return {
        candidates: cands.length, matched: hit.length, suppressed: hit.filter(inCd).length,
        sample: hit.slice(0, 20).map((c) => ({ title: c.title, metrics: c.metrics, link: c.link, inCooldown: inCd(c) })),
      };
    });
  }

  async events(q: { organizationId: string; limit?: number; detector?: string; priority?: number }, ctx: TenantContext = requireTenantContext()): Promise<EngineEvent[]> {
    return this.tx(ctx, 'decision.events.read', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'decision:read');
      if (q.detector !== undefined && !DETECTOR_BY_ID.has(q.detector)) throw new ClinicalError('VALIDATION', 'Unknown detector');
      if (q.priority !== undefined && ![1, 2, 3].includes(q.priority)) throw new ClinicalError('VALIDATION', 'priority must be 1..3');
      return repo.events(org, { limit: this.limit(q.limit), ...(q.detector ? { detector: q.detector } : {}), ...(q.priority ? { priority: q.priority } : {}) });
    });
  }

  async actionLog(q: { organizationId: string; limit?: number }, ctx: TenantContext = requireTenantContext()): Promise<ActionLogEntry[]> {
    return this.tx(ctx, 'decision.actions.read', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'decision:read');
      return repo.actionLog(org, this.limit(q.limit));
    });
  }

  async runs(q: { organizationId: string; limit?: number }, ctx: TenantContext = requireTenantContext()): Promise<JobRun[]> {
    return this.tx(ctx, 'decision.runs.read', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      this.decideAccess(await this.principal(repo, ctx, org), 'decision:read');
      return repo.runs(org, this.limit(q.limit));
    });
  }

  /** Bấm "Chạy ngay". */
  async runNow(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<RunSummary> {
    const org = this.orgOf(organizationId, ctx);
    let user: User | null = null;
    await this.tx(ctx, 'decision.run', async (repo) => {
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'decision:manage');
      user = p.user;
    });
    return this.execute(ctx, org, 'manual', user!);
  }

  /** Bộ lập lịch gọi (không có người dùng). */
  async runScheduled(tenantId: string, organizationId: string): Promise<RunSummary | null> {
    const ctx = systemContext(tenantId, organizationId);
    try {
      return await this.execute(ctx, organizationId as OrganizationId, 'schedule', null);
    } catch (e) {
      if (e instanceof ClinicalError && e.details?.['reason'] === 'RUN_IN_PROGRESS') return null;
      throw e;
    }
  }

  // ---- hộp thông báo ----
  async inbox(q: { organizationId: string; all?: boolean }, ctx: TenantContext = requireTenantContext()): Promise<Inbox> {
    return this.tx(ctx, 'decision.inbox.read', async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decideAccess(p, 'notification:read');
      const rows = await repo.inbox(org, this.targetsOf(p), q.all === true);
      // Một người có nhiều vai trò: mỗi sự kiện hiện một lần (ưu tiên bản còn mở).
      const seen = new Set<string>();
      const items: InboxItem[] = [];
      for (const r of rows) {
        if (seen.has(r.eventId)) continue;
        seen.add(r.eventId);
        items.push({ ...r, suggestionLabel: r.hasSuggestion ? DETECTOR_BY_ID.get(r.detector)?.suggestion ?? 'Mở' : null });
      }
      return { items, openCount: items.filter((i) => i.status === 'open').length };
    });
  }

  async actOnNotification(id: string, action: InboxAction, note: string | null, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<{ link: string | null; item: InboxItem | null }> {
    return this.tx(ctx, `decision.inbox.${action}`, async (repo) => {
      if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'notification id must be a UUID');
      if (!['handle', 'apply', 'dismiss', 'reopen'].includes(action)) throw new ClinicalError('VALIDATION', 'Unknown action', { reason: 'INVALID_ACTION' });
      if (note !== null && (typeof note !== 'string' || note.length > 300)) throw new ClinicalError('VALIDATION', 'note must be ≤ 300 characters');
      this.version(expectedVersion);
      const x = await repo.findNotification(id.toLowerCase());
      if (!x) throw new ClinicalError('NOT_FOUND', 'Notification not found');
      assertOrganizationAllowed(x.organizationId, ctx);
      const p = await this.principal(repo, ctx, x.organizationId);
      this.decideAccess(p, 'notification:read');
      const targets = this.targetsOf(p);
      // Không thuộc vai trò nhận => coi như không tồn tại (không lộ thông báo của vai trò khác).
      if (!targets.includes(x.targetRole)) throw new ClinicalError('NOT_FOUND', 'Notification not found');
      if ((action === 'apply' || action === 'dismiss') && !(x.hasSuggestion && x.suggestionStatus === 'pending')) {
        throw new ClinicalError('CONFLICT', 'No pending suggestion', { reason: 'NO_PENDING_SUGGESTION' });
      }
      if (action === 'handle' && x.status === 'handled') throw new ClinicalError('CONFLICT', 'Already handled', { reason: 'ALREADY_HANDLED' });
      if (action === 'reopen' && x.status === 'open') throw new ClinicalError('CONFLICT', 'Already open', { reason: 'ALREADY_OPEN' });
      const now = this.clock();
      const cleanNote = note?.trim() ? note.trim() : null;
      const s =
        action === 'reopen'
          ? { status: 'open' as const, suggestion: 'pending' as const, by: null, note: null, at: now }
          : { status: 'handled' as const, suggestion: action === 'apply' ? ('applied' as const) : action === 'dismiss' ? ('dismissed' as const) : ('keep' as const), by: p.user.userId, note: cleanNote, at: now };
      if (!(await repo.updateNotifications(id.toLowerCase(), x.eventId, targets, expectedVersion, s))) {
        throw new ClinicalError('CONFLICT', 'Notification version does not match', { reason: 'VERSION_CONFLICT' });
      }
      const logAction = { handle: 'human_handled', apply: 'human_applied', dismiss: 'human_dismissed', reopen: 'human_reopened' }[action];
      await repo.insertAction(x.organizationId, x.eventId, logAction, { userId: p.user.userId }, 'done', cleanNote, now);
      await repo.appendAudit(this.event(ctx, `decision.inbox.${action}`, x.organizationId, 'success', p.user, id.toLowerCase(), { eventId: x.eventId }));
      const after = (await repo.inbox(x.organizationId, targets, true)).find((r) => r.notificationId === id.toLowerCase()) ?? null;
      return {
        link: action === 'apply' ? x.link : null,
        item: after ? { ...after, suggestionLabel: after.hasSuggestion ? DETECTOR_BY_ID.get(after.detector)?.suggestion ?? 'Mở' : null } : null,
      };
    });
  }

  // ---- lõi engine ----
  private async execute(ctx: TenantContext, org: OrganizationId, trigger: 'schedule' | 'manual', user: User | null): Promise<RunSummary> {
    const started = this.clock();
    const runId = randomUUID();
    try {
      return await this.deps.uow.run(ctx, async (repo) => {
        if (!(await repo.tryLock(org))) throw new ClinicalError('CONFLICT', 'Another run is in progress', { reason: 'RUN_IN_PROGRESS' });
        const now = this.clock();
        const rules = await repo.activeRules(org);
        const byDetector = new Map<string, typeof rules>();
        for (const r of rules) {
          if (!DETECTOR_BY_ID.has(r.detector)) continue;
          byDetector.set(r.detector, [...(byDetector.get(r.detector) ?? []), r]);
        }
        const detail: JobRun['detail'] = [];
        const created: RunSummary['events'] = [];
        let candidates = 0;
        let suppressed = 0;
        let failed = 0;
        let k = 0;
        let orgName: string | undefined;
        for (const [detector, rs] of byDetector) {
          const t0 = Date.now();
          let cands: Candidate[];
          try {
            cands = await repo.savepoint(`d${k++}`, () => COLLECTORS[detector]!(repo, org, now));
          } catch (e) {
            failed++;
            detail.push({ detector, ms: Date.now() - t0, candidates: 0, error: errorCode(e) });
            continue;
          }
          candidates += cands.length;
          for (const rule of rs) {
            const hit = cands.filter((c) => matches(rule.conditions, c.metrics));
            const last = await repo.lastFired(rule.ruleId, hit.map((c) => c.subjectKey));
            const d = decide(rule, hit, last, now.getTime());
            suppressed += d.suppressed;
            for (const c of d.fire) {
              const eventId = await repo.insertEvent({ org, ruleId: rule.ruleId, ruleVersion: rule.version, runId, detector, priority: rule.priority, c, at: now });
              const suggest = rule.actions.includes('suggest');
              for (const a of rule.actions) {
                if (a.startsWith('notify_')) await repo.insertNotification(org, eventId, a.slice('notify_'.length) as NotifyRole, suggest, now);
                await repo.insertAction(org, eventId, a, null, 'done', null, now);
              }
              created.push({ eventId, ruleName: rule.name, title: c.title, priority: rule.priority });
              orgName ??= await repo.orgName(org);
              await repo.enqueueIntegration({
                organizationId: org, type: 'decision.event', priority: rule.priority, at: now, sourceId: eventId,
                payload: decisionPayload({
                  title: c.title, detail: c.detail, ruleName: rule.name, detector, detectorLabel: DETECTOR_BY_ID.get(detector)?.label ?? detector,
                  link: c.link, detectedAt: now.toISOString(), organizationName: orgName, metrics: c.metrics,
                }),
              });
            }
            if (d.capped > 0) detail.push({ detector, ms: 0, candidates: 0, error: `CAPPED:${rule.ruleId}:${d.capped}` });
          }
          detail.push({ detector, ms: Date.now() - t0, candidates: cands.length, error: null });
        }
        const finished = this.clock();
        const status: JobRun['status'] = failed === 0 ? 'success' : failed < byDetector.size ? 'partial' : 'failed';
        const run = {
          runId, trigger, triggeredBy: user?.userId ?? null, startedAt: started.toISOString(), finishedAt: (finished < started ? started : finished).toISOString(),
          status, rulesEvaluated: rules.length, candidates, eventsCreated: created.length, suppressed, detail, errorCode: failed ? 'DETECTOR_FAILED' : null,
        };
        await repo.insertRun(org, run);
        if (failed > 0) {
          await repo.enqueueIntegration({
            organizationId: org, type: 'system.alert', priority: status === 'failed' ? 1 : 2, at: finished, sourceId: runId,
            payload: systemPayload({
              code: status === 'failed' ? 'DECISION_RUN_FAILED' : 'DECISION_RUN_PARTIAL',
              title: status === 'failed' ? 'Decision Engine chạy lỗi: không bộ phát hiện nào chạy được' : `Decision Engine chạy một phần: ${failed} bộ phát hiện lỗi`,
              detail: detail.filter((x) => x.error && !x.error.startsWith('CAPPED')).map((x) => `${x.detector}: ${x.error}`).join(', ').slice(0, 400) || null,
              link: '#/decision', organizationName: orgName ?? (await repo.orgName(org)),
            }),
          });
        }
        // Lịch chạy mỗi vài phút: chỉ ghi audit khi có sự kiện hoặc lỗi, để không làm phình chuỗi audit.
        if (trigger === 'manual' || created.length > 0 || failed > 0) {
          await repo.appendAudit({
            ...this.event(ctx, 'decision.run', org, status === 'failed' ? 'failure' : 'success', user, runId, { trigger, events: created.length, suppressed, failed }),
            ...(user ? {} : { actor: { type: 'system', id: SYSTEM_SUBJECT } }),
          });
        }
        return { ...run, durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt), events: created };
      });
    } catch (e) {
      if (e instanceof ClinicalError && e.details?.['reason'] === 'RUN_IN_PROGRESS') throw e;
      // Ghi lần chạy lỗi trong transaction riêng (transaction chính đã rollback).
      const code = errorCode(e);
      try {
        await this.deps.uow.run(ctx, async (repo) => {
          const fin = new Date(Math.max(this.clock().getTime(), started.getTime()));
          await repo.insertRun(org, {
            runId, trigger, triggeredBy: user?.userId ?? null, startedAt: started.toISOString(), finishedAt: fin.toISOString(),
            status: 'failed', rulesEvaluated: 0, candidates: 0, eventsCreated: 0, suppressed: 0, detail: [], errorCode: code,
          });
          await repo.enqueueIntegration({
            organizationId: org, type: 'system.alert', priority: 1, at: fin, sourceId: runId,
            payload: systemPayload({ code: 'DECISION_RUN_FAILED', title: 'Decision Engine chạy lỗi', detail: `Mã lỗi: ${code}`, link: '#/decision', organizationName: await repo.orgName(org) }),
          });
        });
      } catch {
        /* bỏ qua */
      }
      try {
        await this.deps.audit.record({ ...this.event(ctx, 'decision.run', org, 'failure', user, runId, { code }), ...(user ? {} : { actor: { type: 'system', id: SYSTEM_SUBJECT } }) });
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }

  // ---- nội bộ ----
  private validate(i: RuleInput): RuleInput {
    const errs = validateRule(i);
    if (errs.length) throw new ClinicalError('VALIDATION', errs.join('; '), { reason: 'INVALID_RULE' });
    return {
      organizationId: i.organizationId, name: i.name.trim(), detector: i.detector,
      conditions: i.conditions.map((c) => ({ metric: c.metric, op: c.op, value: c.value })), priority: i.priority, cooldownMinutes: i.cooldownMinutes,
      // Thứ tự cố định để so sánh lịch sử dễ đọc.
      actions: ACTIONS.map((a) => a.id).filter((a) => i.actions.includes(a)),
    };
  }
  private version(v: number): void {
    if (!Number.isInteger(v) || v < 1) throw new ClinicalError('VALIDATION', 'Invalid version');
  }
  private limit(l: number | undefined): number {
    const x = l ?? 100;
    if (!Number.isInteger(x) || x < 1 || x > 500) throw new ClinicalError('VALIDATION', 'limit must be 1..500');
    return x;
  }
  private async ruleOf(repo: PgDecisionRepository, ruleId: string, ctx: TenantContext): Promise<Rule> {
    if (typeof ruleId !== 'string' || !isUuid(ruleId)) throw new ClinicalError('VALIDATION', 'rule id must be a UUID');
    const rule = await repo.getRule(ruleId.toLowerCase(), this.clock());
    if (!rule) throw new ClinicalError('NOT_FOUND', 'Rule not found');
    assertOrganizationAllowed(rule.organizationId as OrganizationId, ctx);
    return rule;
  }
  private targetsOf(p: Principal): NotifyRole[] {
    return NOTIFY_ROLES.filter((t) => rolesSeeing(t).some((r) => p.roles.has(r)));
  }
  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  private async principal(repo: PgDecisionRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) =>
        (m.organizationId === organizationId || m.role === 'tenant_admin') && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return {
      user,
      grants: await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>),
      roles: new Set(valid.map((m) => m.role)),
    };
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
      organizationId: org, action, resourceType: 'DecisionEngine', resourceId, personId: null, patientId: null, outcome,
      correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async tx<T>(ctx: TenantContext, action: string, fn: (repo: PgDecisionRepository) => Promise<T>): Promise<T> {
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

/** Trùng tên luật (chỉ mục duy nhất không phân biệt hoa thường) => 409 thay vì lỗi CSDL thô. */
async function nameTaken<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const x = e as { code?: string; constraint?: string };
    if (x?.code === '23505') throw new ClinicalError('CONFLICT', 'A rule with this name already exists', { reason: 'RULE_NAME_TAKEN' });
    throw e;
  }
}

function errorCode(e: unknown): string {
  if (e instanceof ClinicalError) return e.code;
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{1,20}$/.test(c) ? `PG_${c}` : 'INTERNAL';
}

// ---------------------------------------------------------------------------
// Bộ lập lịch (trong tiến trình API). Chỉ gọi engine; không giữ trạng thái nào ngoài cờ "đang chạy".
// ---------------------------------------------------------------------------
export interface SchedulerLog { (r: Readonly<Record<string, unknown>>): void }
export class DecisionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly deps: { pool: PgPoolLike; engine: Pick<DecisionEngineService, 'runScheduled'>; intervalMs: number; log?: SchedulerLog }) {}

  start(): void {
    if (this.timer || this.deps.intervalMs <= 0) return;
    // Lần đầu sau 30 giây (để API khởi động xong), sau đó đều đặn.
    const first = setTimeout(() => void this.tick(), Math.min(30_000, this.deps.intervalMs));
    first.unref();
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
        let due: Array<{ tenant_id: string; organization_id: string }>;
        try {
          due = (await client.query('SELECT tenant_id, organization_id FROM decision.due_organizations()')).rows as typeof due;
        } finally {
          client.release();
        }
        for (const d of due) {
          try {
            const r = await this.deps.engine.runScheduled(d.tenant_id, d.organization_id);
            if (r && r.eventsCreated > 0) this.deps.log?.({ level: 'info', msg: 'decision run', events: r.eventsCreated, status: r.status });
          } catch (e) {
            this.deps.log?.({ level: 'warn', msg: 'decision run failed', error: errorCode(e) });
          }
        }
      } catch (e) {
        this.deps.log?.({ level: 'warn', msg: 'decision scheduler tick failed', error: errorCode(e) });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
