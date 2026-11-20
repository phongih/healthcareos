/**
 * HCOS-F6 | Hàng đợi khám theo số thứ tự (theo phòng khám) + màn hình gọi số.
 *
 *   Lễ tân (queue:issue)   cấp số cho bệnh nhân vào một phòng, có ưu tiên theo khoản 2 Điều 3 Luật KCB 2023;
 *                          đưa số "vắng mặt" trở lại hàng chờ; huỷ số.
 *   Bác sĩ (queue:call)    gọi số tiếp theo (ưu tiên trước, rồi theo số), gọi lại, đánh dấu vắng mặt,
 *                          bắt đầu khám => tạo đợt khám (encounter:create) và gắn vào phiếu trong CÙNG transaction.
 *   Xem (queue:read)       hàng đợi hôm nay của cơ sở / một phòng (có MRN, họ tên — chỉ cho người đã đăng nhập).
 *   Quản lý (queue:manage) phòng khám, màn hình gọi số (khoá hiển thị chỉ hiện một lần, DB chỉ lưu SHA-256).
 *
 * Màn hình công khai đọc qua PgQueueBoard -> hàm DB clinical.queue_board(key): chỉ số thứ tự + phòng, không có dữ liệu bệnh nhân.
 * "Hôm nay" theo giờ Việt Nam, tính trong DB (clinical.queue_today()).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
  type Patient,
  type PatientId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import { asEncounterId, type Encounter, type EncounterClass } from '../../../../packages/domain/src/s1-contracts';

const ENCOUNTER_CLASSES: readonly EncounterClass[] = ['ambulatory', 'inpatient', 'emergency', 'virtual'];
import {
  ACCESS_POLICY_CATALOG,
  buildGrants,
  decideAccess,
  type AccessDecision,
  type AccessGrant,
  type AccessPolicy,
  type PolicyAction,
} from '../../../../packages/security/src/access-policy';
import {
  assertOrganizationAllowed,
  assertSameTenant,
  requireTenantContext,
  withTenantTransaction,
  type PgPoolLike,
} from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, isoOrNull, num, PgClinicalRepository, translatePgError, type OutboxDraft } from './encounter.service';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export const PRIORITY_REASONS = ['emergency', 'child_under_6', 'pregnant', 'severe_disability', 'elderly_75', 'revolutionary_merit'] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];
export type TicketStatus = 'waiting' | 'called' | 'in_service' | 'skipped' | 'cancelled';

export interface ServicePoint {
  readonly tenantId: string;
  readonly servicePointId: string;
  readonly organizationId: OrganizationId;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface QueueTicket {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly organizationId: OrganizationId;
  readonly servicePointId: string;
  readonly patientId: PatientId;
  readonly queueDate: string;
  readonly ticketNo: number;
  readonly priorityReason: PriorityReason | null;
  readonly priorityRank: number;
  readonly status: TicketStatus;
  readonly calledCount: number;
  readonly calledAt: string | null;
  readonly calledByUserId: UserId | null;
  readonly encounterId: string | null;
  readonly issuedByUserId: UserId;
  readonly issuedAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Phiếu kèm thông tin hiển thị cho nhân viên (đã đăng nhập). */
export interface TicketView extends QueueTicket {
  /** vd. "N1-007" */
  readonly displayNo: string;
  readonly servicePointCode: string;
  readonly servicePointName: string;
  readonly patient: { readonly mrn: string; readonly familyName: string; readonly givenName: string; readonly birthDate: string | null };
  readonly calledByName: string | null;
}

export interface QueueDisplay {
  readonly displayId: string;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: string;
}

export interface BoardRow {
  readonly kind: 'called' | 'waiting';
  readonly servicePointCode: string;
  readonly servicePointName: string;
  readonly ticketNo: number;
  readonly displayNo: string;
  readonly priority: 'emergency' | 'priority' | null;
  readonly calledCount: number;
  readonly calledAt: string | null;
}
export interface QueueBoard {
  readonly displayName: string;
  readonly organizationName: string | null;
  readonly called: readonly BoardRow[];
  readonly waiting: readonly BoardRow[];
}

export const displayNo = (code: string, no: number): string => `${code}-${String(no).padStart(3, '0')}`;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
export interface QueueRepository {
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  findAccessPolicies(ids: readonly AccessPolicyId[]): Promise<AccessPolicy[]>;
  findPatient(id: PatientId): Promise<Patient | null>;
  insertEncounter(e: Encounter): Promise<void>;
  enqueueOutbox(tenantId: TenantContext['tenantId'], ev: OutboxDraft): Promise<void>;
  appendAudit(ev: NewAuditEvent): Promise<void>;

  listServicePoints(organizationId: OrganizationId): Promise<ServicePoint[]>;
  findServicePoint(id: string): Promise<ServicePoint | null>;
  insertServicePoint(sp: ServicePoint): Promise<void>;
  setServicePointActive(id: string, isActive: boolean, expectedVersion: number): Promise<ServicePoint | null>;

  /** Tăng bộ đếm (phòng, hôm nay) nguyên tử; trả số mới và ngày hàng đợi. */
  nextTicketNumber(servicePointId: string): Promise<{ ticketNo: number; queueDate: string }>;
  insertTicket(t: QueueTicket): Promise<void>;
  findTicket(id: string): Promise<QueueTicket | null>;
  /** Phiếu hôm nay (không gồm đã huỷ) của cơ sở, có thể lọc theo phòng; kèm thông tin hiển thị. */
  listTodayTickets(organizationId: OrganizationId, servicePointId: string | null, limit: number): Promise<TicketView[]>;
  /** Gọi phiếu chờ tiếp theo của phòng (ưu tiên trước, rồi theo số); khoá SKIP LOCKED. null nếu hết. */
  callNext(servicePointId: string, callerUserId: UserId): Promise<QueueTicket | null>;
  /** Cập nhật trạng thái có điều kiện (trạng thái hiện tại + người gọi nếu có). null nếu không khớp. */
  transition(
    id: string,
    from: readonly TicketStatus[],
    to: TicketStatus,
    opts: { readonly bumpCall?: boolean; readonly calledBy?: UserId; readonly requireCaller?: UserId; readonly encounterId?: string },
  ): Promise<QueueTicket | null>;

  insertDisplay(d: QueueDisplay & { tenantId: string; keyHash: Buffer; createdByUserId: UserId }): Promise<void>;
  listDisplays(organizationId: OrganizationId): Promise<QueueDisplay[]>;
  revokeDisplay(id: string): Promise<QueueDisplay | null>;
}

export interface QueueUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: QueueRepository) => Promise<T>): Promise<T>;
}

export interface QueueServiceDeps {
  readonly uow: QueueUnitOfWork;
  readonly audit: AuditSink;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Quyền
// ---------------------------------------------------------------------------
type Permission = 'queue:read' | 'queue:issue' | 'queue:call' | 'queue:manage' | 'encounter:create';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'queue:read': ['doctor', 'clinic_staff', 'clinic_admin'],
  'queue:issue': ['clinic_staff', 'clinic_admin'],
  'queue:call': ['doctor'],
  'queue:manage': ['clinic_admin', 'tenant_admin'],
  'encounter:create': ['doctor'],
};

type AllowedDecision = Extract<AccessDecision, { allowed: true }>;
interface Principal {
  readonly user: User;
  readonly grants: readonly AccessGrant[];
}
interface AuditMeta {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly patientId?: PatientId;
  readonly organizationId?: OrganizationId;
}

const CODE_RE = /^[A-Z0-9]{1,6}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const LIST_LIMIT = 300;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class QueueService {
  private readonly uow: QueueUnitOfWork;
  private readonly audit: AuditSink;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(deps: QueueServiceDeps) {
    this.uow = deps.uow;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ---- Phòng khám ----------------------------------------------------------
  async listServicePoints(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<ServicePoint[]> {
    const meta: AuditMeta = { action: 'queue.service_point.list', resourceType: 'ServicePoint' };
    return this.tx(ctx, meta, async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decideAny(p, ['queue:read', 'queue:manage']);
      const list = (await repo.listServicePoints(org)).filter((s) => s.organizationId === org);
      for (const s of list) assertSameTenant(s as never, ctx);
      return list;
    });
  }

  async createServicePoint(input: { organizationId: string; code: string; name: string }, ctx: TenantContext = requireTenantContext()): Promise<ServicePoint> {
    const meta: AuditMeta = { action: 'queue.service_point.create', resourceType: 'ServicePoint' };
    return this.tx(ctx, meta, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!CODE_RE.test(code)) throw new ClinicalError('VALIDATION', 'code must be 1-6 characters A-Z / 0-9');
      if (name.length < 2 || name.length > 100) throw new ClinicalError('VALIDATION', 'name must be 2-100 characters');
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'queue:manage');
      const now = this.now();
      const sp: ServicePoint = {
        tenantId: ctx.tenantId, servicePointId: this.newId(), organizationId: org, code, name, isActive: true, createdAt: now, updatedAt: now, version: 1,
      };
      await repo.insertServicePoint(sp);
      await repo.appendAudit(this.event(ctx, { ...meta, resourceId: sp.servicePointId, organizationId: org }, 'success', p.user, { code }));
      return sp;
    });
  }

  async setServicePointActive(id: string, isActive: boolean, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<ServicePoint> {
    const meta: AuditMeta = { action: 'queue.service_point.update', resourceType: 'ServicePoint', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      const sp = await this.loadServicePoint(repo, ctx, id);
      if (typeof isActive !== 'boolean') throw new ClinicalError('VALIDATION', 'isActive must be boolean');
      const p = await this.principal(repo, ctx, sp.organizationId);
      this.decide(p, 'queue:manage');
      const saved = await repo.setServicePointActive(sp.servicePointId, isActive, expectedVersion);
      if (!saved) throw new ClinicalError('CONFLICT', 'Service point version does not match', { reason: 'VERSION_CONFLICT' });
      await repo.appendAudit(this.event(ctx, { ...meta, organizationId: sp.organizationId }, 'success', p.user, { isActive }));
      return saved;
    });
  }

  // ---- Lễ tân --------------------------------------------------------------
  async issueTicket(
    input: { servicePointId: string; patientId: string; priorityReason?: string | null },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<TicketView> {
    const meta: AuditMeta = { action: 'queue.ticket.issue', resourceType: 'QueueTicket' };
    return this.tx(ctx, meta, async (repo) => {
      const reason = input.priorityReason ?? null;
      if (reason !== null && !(PRIORITY_REASONS as readonly string[]).includes(reason)) {
        throw new ClinicalError('VALIDATION', 'Unknown priorityReason');
      }
      if (typeof input.patientId !== 'string' || !isUuid(input.patientId)) throw new ClinicalError('VALIDATION', 'patientId must be a UUID');
      const sp = await this.loadServicePoint(repo, ctx, input.servicePointId);
      if (!sp.isActive) throw new ClinicalError('INVALID_STATE', 'Service point is inactive', { reason: 'SERVICE_POINT_INACTIVE' });
      const p = await this.principal(repo, ctx, sp.organizationId);
      this.decide(p, 'queue:issue');
      const patient = await repo.findPatient(input.patientId.toLowerCase() as PatientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);
      if (patient.organizationId !== sp.organizationId) {
        throw new ClinicalError('VALIDATION', 'Patient is not registered at this organization', { reason: 'PATIENT_ORG_MISMATCH' });
      }
      if (patient.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Patient record is not active');

      const { ticketNo, queueDate } = await repo.nextTicketNumber(sp.servicePointId);
      const now = this.now();
      const ticket: QueueTicket = {
        tenantId: ctx.tenantId, ticketId: this.newId(), organizationId: sp.organizationId, servicePointId: sp.servicePointId,
        patientId: patient.patientId, queueDate, ticketNo, priorityReason: reason as PriorityReason | null,
        priorityRank: reason === 'emergency' ? 2 : reason ? 1 : 0, status: 'waiting', calledCount: 0, calledAt: null,
        calledByUserId: null, encounterId: null, issuedByUserId: p.user.userId, issuedAt: now, updatedAt: now, version: 1,
      };
      await repo.insertTicket(ticket); // CONFLICT: PATIENT_ALREADY_QUEUED
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: ticket.ticketId, patientId: patient.patientId, organizationId: sp.organizationId }, 'success', p.user, {
          servicePointId: sp.servicePointId, ticketNo, priority: reason !== null,
        }),
      );
      return this.view(repo, ctx, ticket.ticketId);
    });
  }

  async requeueTicket(id: string, ctx: TenantContext = requireTenantContext()): Promise<QueueTicket> {
    return this.staffTransition(id, ['skipped'], 'waiting', 'queue.ticket.requeue', ctx);
  }

  async cancelTicket(id: string, ctx: TenantContext = requireTenantContext()): Promise<QueueTicket> {
    return this.staffTransition(id, ['waiting', 'skipped'], 'cancelled', 'queue.ticket.cancel', ctx);
  }

  // ---- Xem ----------------------------------------------------------------
  async listToday(q: { organizationId: string; servicePointId?: string | null }, ctx: TenantContext = requireTenantContext()): Promise<TicketView[]> {
    const meta: AuditMeta = { action: 'queue.list', resourceType: 'QueueTicket' };
    return this.tx(ctx, meta, async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      let spId: string | null = null;
      if (q.servicePointId) {
        const sp = await this.loadServicePoint(repo, ctx, q.servicePointId);
        if (sp.organizationId !== org) throw new ClinicalError('VALIDATION', 'Service point belongs to another organization');
        spId = sp.servicePointId;
      }
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'queue:read');
      const list = (await repo.listTodayTickets(org, spId, LIST_LIMIT)).filter((t) => t.organizationId === org);
      for (const t of list) assertSameTenant(t as never, ctx);
      await repo.appendAudit(this.event(ctx, { ...meta, organizationId: org }, 'success', p.user, { count: list.length, servicePointId: spId }));
      return list;
    });
  }

  // ---- Bác sĩ -------------------------------------------------------------
  async callNext(servicePointId: string, ctx: TenantContext = requireTenantContext()): Promise<TicketView | null> {
    const meta: AuditMeta = { action: 'queue.ticket.call', resourceType: 'QueueTicket' };
    return this.tx(ctx, meta, async (repo) => {
      const sp = await this.loadServicePoint(repo, ctx, servicePointId);
      if (!sp.isActive) throw new ClinicalError('INVALID_STATE', 'Service point is inactive', { reason: 'SERVICE_POINT_INACTIVE' });
      const p = await this.principal(repo, ctx, sp.organizationId);
      this.decide(p, 'queue:call');
      const t = await repo.callNext(sp.servicePointId, p.user.userId);
      if (!t) return null;
      assertSameTenant(t as never, ctx);
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: t.ticketId, patientId: t.patientId, organizationId: t.organizationId }, 'success', p.user, {
          servicePointId: sp.servicePointId, ticketNo: t.ticketNo, calledCount: t.calledCount,
        }),
      );
      return this.view(repo, ctx, t.ticketId);
    });
  }

  async recallTicket(id: string, ctx: TenantContext = requireTenantContext()): Promise<QueueTicket> {
    return this.callerTransition(id, ['called'], 'called', 'queue.ticket.recall', ctx, { bumpCall: true });
  }

  async skipTicket(id: string, ctx: TenantContext = requireTenantContext()): Promise<QueueTicket> {
    return this.callerTransition(id, ['called'], 'skipped', 'queue.ticket.skip', ctx, {});
  }

  /** Bắt đầu khám số đã gọi: tạo đợt khám (bác sĩ phụ trách = người gọi) và gắn vào phiếu, trong cùng transaction. */
  async startTicket(
    id: string,
    input: { encounterClass?: string; reasonText?: string | null },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ ticket: QueueTicket; encounterId: string }> {
    const meta: AuditMeta = { action: 'queue.ticket.start', resourceType: 'QueueTicket', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      const t = await this.loadTicket(repo, ctx, id);
      const p = await this.principal(repo, ctx, t.organizationId);
      this.decide(p, 'queue:call');
      const cls = (input.encounterClass ?? 'ambulatory') as EncounterClass;
      if (!ENCOUNTER_CLASSES.includes(cls)) throw new ClinicalError('VALIDATION', 'Unknown encounterClass');
      const reasonText = input.reasonText === undefined || input.reasonText === null ? null : String(input.reasonText).trim() || null;
      if (reasonText !== null && reasonText.length > 1000) throw new ClinicalError('VALIDATION', 'reasonText too long');
      const enc = this.decide(p, 'encounter:create', cls);
      if (t.status !== 'called') throw new ClinicalError('INVALID_STATE', `Ticket is ${t.status}`, { reason: 'TICKET_NOT_CALLED' });
      if (t.calledByUserId !== p.user.userId) {
        throw new ClinicalError('INVALID_STATE', 'Ticket was called by another doctor', { reason: 'TICKET_CALLED_BY_OTHER' });
      }
      const patient = await repo.findPatient(t.patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);
      if (patient.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Patient record is not active');

      const now = this.now();
      const encounter: Encounter = {
        tenantId: ctx.tenantId, encounterId: asEncounterId(this.newId()), patientId: patient.patientId, organizationId: t.organizationId,
        practitionerUserId: p.user.userId, status: 'in_progress', encounterClass: cls, reasonText, periodStart: now, periodEnd: null,
        createdAt: now, updatedAt: now, version: 1,
      };
      await repo.insertEncounter(encounter);
      const saved = await repo.transition(t.ticketId, ['called'], 'in_service', { requireCaller: p.user.userId, encounterId: encounter.encounterId });
      if (!saved) throw new ClinicalError('CONFLICT', 'Ticket changed concurrently', { reason: 'TICKET_CHANGED' });
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter', aggregateId: encounter.encounterId, eventType: 'clinical.encounter.created',
        payload: { encounterId: encounter.encounterId, patientId: patient.patientId, organizationId: t.organizationId, ticketId: t.ticketId },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, patientId: t.patientId, organizationId: t.organizationId }, 'success', p.user, {
          encounterId: encounter.encounterId, ...(enc.policyIds.length ? { accessPolicyIds: enc.policyIds } : {}),
        }),
      );
      return { ticket: saved, encounterId: encounter.encounterId };
    });
  }

  // ---- Màn hình gọi số ----------------------------------------------------
  async createDisplay(input: { organizationId: string; name: string }, ctx: TenantContext = requireTenantContext()): Promise<{ display: QueueDisplay; key: string }> {
    const meta: AuditMeta = { action: 'queue.display.create', resourceType: 'QueueDisplay' };
    return this.tx(ctx, meta, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length < 2 || name.length > 100) throw new ClinicalError('VALIDATION', 'name must be 2-100 characters');
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'queue:manage');
      const key = randomBytes(32).toString('base64url');
      const display: QueueDisplay = { displayId: this.newId(), organizationId: org, name, isActive: true, createdAt: this.now() };
      await repo.insertDisplay({ ...display, tenantId: ctx.tenantId, keyHash: createHash('sha256').update(key, 'utf8').digest(), createdByUserId: p.user.userId });
      await repo.appendAudit(this.event(ctx, { ...meta, resourceId: display.displayId, organizationId: org }, 'success', p.user, {}));
      return { display, key };
    });
  }

  async listDisplays(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<QueueDisplay[]> {
    const meta: AuditMeta = { action: 'queue.display.list', resourceType: 'QueueDisplay' };
    return this.tx(ctx, meta, async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decide(await this.principal(repo, ctx, org), 'queue:manage');
      return (await repo.listDisplays(org)).filter((d) => d.organizationId === org);
    });
  }

  async revokeDisplay(id: string, organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<QueueDisplay> {
    const meta: AuditMeta = { action: 'queue.display.revoke', resourceType: 'QueueDisplay', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      if (!isUuid(id)) throw new ClinicalError('VALIDATION', 'display id must be a UUID');
      const org = this.orgOf(organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'queue:manage');
      const existing = (await repo.listDisplays(org)).find((d) => d.displayId === id.toLowerCase());
      if (!existing) throw new ClinicalError('NOT_FOUND', 'Display not found');
      const d = await repo.revokeDisplay(existing.displayId);
      if (!d) throw new ClinicalError('NOT_FOUND', 'Display not found');
      await repo.appendAudit(this.event(ctx, { ...meta, organizationId: org }, 'success', p.user, {}));
      return d;
    });
  }

  // ---- Nội bộ ---------------------------------------------------------------
  private async staffTransition(id: string, from: TicketStatus[], to: TicketStatus, action: string, ctx: TenantContext): Promise<QueueTicket> {
    const meta: AuditMeta = { action, resourceType: 'QueueTicket', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      const t = await this.loadTicket(repo, ctx, id);
      const p = await this.principal(repo, ctx, t.organizationId);
      this.decide(p, 'queue:issue');
      if (!from.includes(t.status)) throw new ClinicalError('INVALID_STATE', `Ticket is ${t.status}`, { reason: 'TICKET_STATE' });
      const saved = await repo.transition(t.ticketId, from, to, {});
      if (!saved) throw new ClinicalError('CONFLICT', 'Ticket changed concurrently', { reason: 'TICKET_CHANGED' });
      await repo.appendAudit(this.event(ctx, { ...meta, patientId: t.patientId, organizationId: t.organizationId }, 'success', p.user, { from: t.status, to }));
      return saved;
    });
  }

  private async callerTransition(
    id: string, from: TicketStatus[], to: TicketStatus, action: string, ctx: TenantContext, opts: { bumpCall?: boolean },
  ): Promise<QueueTicket> {
    const meta: AuditMeta = { action, resourceType: 'QueueTicket', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      const t = await this.loadTicket(repo, ctx, id);
      const p = await this.principal(repo, ctx, t.organizationId);
      this.decide(p, 'queue:call');
      if (!from.includes(t.status)) throw new ClinicalError('INVALID_STATE', `Ticket is ${t.status}`, { reason: 'TICKET_STATE' });
      if (t.calledByUserId !== p.user.userId) {
        throw new ClinicalError('INVALID_STATE', 'Ticket was called by another doctor', { reason: 'TICKET_CALLED_BY_OTHER' });
      }
      const saved = await repo.transition(t.ticketId, from, to, { ...opts, requireCaller: p.user.userId });
      if (!saved) throw new ClinicalError('CONFLICT', 'Ticket changed concurrently', { reason: 'TICKET_CHANGED' });
      await repo.appendAudit(this.event(ctx, { ...meta, patientId: t.patientId, organizationId: t.organizationId }, 'success', p.user, { calledCount: saved.calledCount }));
      return saved;
    });
  }

  private async view(repo: QueueRepository, ctx: TenantContext, ticketId: string): Promise<TicketView> {
    const t = await repo.findTicket(ticketId);
    if (!t) throw new ClinicalError('NOT_FOUND', 'Ticket not found');
    const v = (await repo.listTodayTickets(t.organizationId, t.servicePointId, LIST_LIMIT)).find((x) => x.ticketId === ticketId);
    if (!v) throw new ClinicalError('NOT_FOUND', 'Ticket not found');
    assertSameTenant(v as never, ctx);
    return v;
  }

  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }

  private async loadServicePoint(repo: QueueRepository, ctx: TenantContext, id: string): Promise<ServicePoint> {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'servicePointId must be a UUID');
    const sp = await repo.findServicePoint(id.toLowerCase());
    if (!sp) throw new ClinicalError('NOT_FOUND', 'Service point not found');
    assertSameTenant(sp as never, ctx);
    assertOrganizationAllowed(sp.organizationId, ctx);
    return sp;
  }

  private async loadTicket(repo: QueueRepository, ctx: TenantContext, id: string): Promise<QueueTicket> {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'ticket id must be a UUID');
    const t = await repo.findTicket(id.toLowerCase());
    if (!t) throw new ClinicalError('NOT_FOUND', 'Ticket not found');
    assertSameTenant(t as never, ctx);
    assertOrganizationAllowed(t.organizationId, ctx);
    return t;
  }

  private async principal(repo: QueueRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m) => m.organizationId === organizationId && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return { user, grants: await buildGrants(valid, user.tenantId, (ids) => repo.findAccessPolicies(ids)) };
  }

  private decide(p: Principal, action: PolicyAction, encounterClass?: string): AllowedDecision {
    const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
    const d = decideAccess(p.grants, action, PERMISSIONS[perm], { callerUserId: p.user.userId, ...(encounterClass ? { encounterClass } : {}) });
    if (!d.allowed) {
      if (d.reason === 'ROLE') throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
      throw new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
    }
    return d;
  }

  private decideAny(p: Principal, actions: PolicyAction[]): AllowedDecision {
    let last: unknown;
    for (const a of actions) {
      try {
        return this.decide(p, a);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private event(ctx: TenantContext, meta: AuditMeta, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: this.newId() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: meta.organizationId ?? null, action: meta.action, resourceType: meta.resourceType, resourceId: meta.resourceId ?? null,
      personId: null, patientId: meta.patientId ?? null, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }

  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: QueueRepository) => Promise<T>): Promise<T> {
    try {
      return await this.uow.run(ctx, fn);
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
      const reason = e instanceof ClinicalError && typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
      try {
        await this.audit.record(this.event(ctx, meta, outcome, null, { code, ...(reason ? { reason } : {}) }));
      } catch {
        /* audit lỗi không được thay đổi kết quả */
      }
      throw e;
    }
  }
}

// ===========================================================================
// PostgreSQL adapter
// ===========================================================================
const SP_COLS = 'service_point_id, tenant_id, organization_id, code, name, is_active, created_at, updated_at, version';
const T_COLS =
  'ticket_id, tenant_id, organization_id, service_point_id, patient_id, queue_date::text AS queue_date, ticket_no, priority_reason, priority_rank, status, ' +
  'called_count, called_at, called_by_user_id, encounter_id, issued_by_user_id, issued_at, updated_at, version';

/* eslint-disable @typescript-eslint/no-explicit-any */
const bool = (v: unknown): boolean => v === true || v === 't';
const mapSp = (r: any): ServicePoint => ({
  tenantId: r.tenant_id, servicePointId: r.service_point_id, organizationId: r.organization_id, code: r.code, name: r.name,
  isActive: bool(r.is_active), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
const mapTicket = (r: any): QueueTicket => ({
  tenantId: r.tenant_id, ticketId: r.ticket_id, organizationId: r.organization_id, servicePointId: r.service_point_id, patientId: r.patient_id,
  queueDate: String(r.queue_date), ticketNo: num(r.ticket_no), priorityReason: r.priority_reason ?? null, priorityRank: num(r.priority_rank),
  status: r.status, calledCount: num(r.called_count), calledAt: isoOrNull(r.called_at), calledByUserId: r.called_by_user_id ?? null,
  encounterId: r.encounter_id ?? null, issuedByUserId: r.issued_by_user_id, issuedAt: iso(r.issued_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
const mapDisplay = (r: any): QueueDisplay => ({
  displayId: r.display_id, organizationId: r.organization_id, name: r.name, isActive: bool(r.is_active), createdAt: iso(r.created_at),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgQueueRepository extends PgClinicalRepository implements QueueRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }

  async listServicePoints(organizationId: OrganizationId): Promise<ServicePoint[]> {
    const r = await this.db.query(`SELECT ${SP_COLS} FROM clinical.service_points WHERE tenant_id = $1 AND organization_id = $2 ORDER BY code`, [this.t, organizationId]);
    return r.rows.map(mapSp);
  }

  async findServicePoint(id: string): Promise<ServicePoint | null> {
    const r = await this.db.query(`SELECT ${SP_COLS} FROM clinical.service_points WHERE tenant_id = $1 AND service_point_id = $2`, [this.t, id]);
    return r.rows[0] ? mapSp(r.rows[0]) : null;
  }

  async insertServicePoint(sp: ServicePoint): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.service_points (service_point_id, tenant_id, organization_id, code, name, is_active) VALUES ($1, $2, $3, $4, $5, $6)`,
        [sp.servicePointId, sp.tenantId, sp.organizationId, sp.code, sp.name, sp.isActive],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async setServicePointActive(id: string, isActive: boolean, expectedVersion: number): Promise<ServicePoint | null> {
    const r = await this.db.query(
      `UPDATE clinical.service_points SET is_active = $1 WHERE tenant_id = $2 AND service_point_id = $3 AND version = $4 RETURNING ${SP_COLS}`,
      [isActive, this.t, id, expectedVersion],
    );
    return r.rows[0] ? mapSp(r.rows[0]) : null;
  }

  async nextTicketNumber(servicePointId: string): Promise<{ ticketNo: number; queueDate: string }> {
    try {
      const r = await this.db.query<{ last_no: number | string; queue_date: string }>(
        `INSERT INTO clinical.queue_counters (tenant_id, service_point_id, queue_date, last_no)
         VALUES ($1, $2, clinical.queue_today(), 1)
         ON CONFLICT (tenant_id, service_point_id, queue_date) DO UPDATE SET last_no = clinical.queue_counters.last_no + 1
         RETURNING last_no, queue_date::text AS queue_date`,
        [this.t, servicePointId],
      );
      return { ticketNo: Number(r.rows[0]!.last_no), queueDate: String(r.rows[0]!.queue_date) };
    } catch (e) {
      return translatePgError(e);
    }
  }

  async insertTicket(t: QueueTicket): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.queue_tickets
           (ticket_id, tenant_id, organization_id, service_point_id, patient_id, queue_date, ticket_no, priority_reason, status, issued_by_user_id, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting', $9, $10)`,
        [t.ticketId, t.tenantId, t.organizationId, t.servicePointId, t.patientId, t.queueDate, t.ticketNo, t.priorityReason, t.issuedByUserId, t.issuedAt],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async findTicket(id: string): Promise<QueueTicket | null> {
    const r = await this.db.query(`SELECT ${T_COLS} FROM clinical.queue_tickets WHERE tenant_id = $1 AND ticket_id = $2`, [this.t, id]);
    return r.rows[0] ? mapTicket(r.rows[0]) : null;
  }

  async listTodayTickets(organizationId: OrganizationId, servicePointId: string | null, limit: number): Promise<TicketView[]> {
    const cols = T_COLS.split(', ').map((c) => (c.includes('::') ? `t.${c}` : `t.${c}`)).join(', ');
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${cols}, sp.code AS sp_code, sp.name AS sp_name, pt.mrn, ps.family_name, ps.given_name, ps.birth_date::text AS birth_date,
              u.display_name AS called_by_name
         FROM clinical.queue_tickets t
         JOIN clinical.service_points sp ON sp.tenant_id = t.tenant_id AND sp.service_point_id = t.service_point_id
         JOIN patient.patients pt ON pt.tenant_id = t.tenant_id AND pt.patient_id = t.patient_id
         JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
         LEFT JOIN iam.users u ON u.tenant_id = t.tenant_id AND u.user_id = t.called_by_user_id
        WHERE t.tenant_id = $1 AND t.organization_id = $2 AND t.queue_date = clinical.queue_today() AND t.status <> 'cancelled'
          AND ($3::uuid IS NULL OR t.service_point_id = $3::uuid)
        ORDER BY CASE t.status WHEN 'called' THEN 0 WHEN 'waiting' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END,
                 t.priority_rank DESC, t.ticket_no, sp.code
        LIMIT $4`,
      [this.t, organizationId, servicePointId, limit],
    );
    return r.rows.map((x) => {
      const t = mapTicket(x);
      return {
        ...t,
        displayNo: displayNo(x['sp_code'] as string, t.ticketNo),
        servicePointCode: x['sp_code'] as string,
        servicePointName: x['sp_name'] as string,
        patient: { mrn: x['mrn'] as string, familyName: x['family_name'] as string, givenName: x['given_name'] as string, birthDate: (x['birth_date'] as string | null) ?? null },
        calledByName: (x['called_by_name'] as string | null) ?? null,
      };
    });
  }

  async callNext(servicePointId: string, callerUserId: UserId): Promise<QueueTicket | null> {
    try {
      const r = await this.db.query(
        `UPDATE clinical.queue_tickets t
            SET status = 'called', called_count = t.called_count + 1, called_at = now(), called_by_user_id = $3
          WHERE t.tenant_id = $1 AND t.ticket_id = (
                SELECT ticket_id FROM clinical.queue_tickets
                 WHERE tenant_id = $1 AND service_point_id = $2 AND queue_date = clinical.queue_today() AND status = 'waiting'
                 ORDER BY priority_rank DESC, ticket_no
                 LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING ${T_COLS}`,
        [this.t, servicePointId, callerUserId],
      );
      return r.rows[0] ? mapTicket(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async transition(
    id: string,
    from: readonly TicketStatus[],
    to: TicketStatus,
    opts: { readonly bumpCall?: boolean; readonly calledBy?: UserId; readonly requireCaller?: UserId; readonly encounterId?: string },
  ): Promise<QueueTicket | null> {
    const sets = ['status = $4'];
    const params: unknown[] = [this.t, id, `{${from.join(',')}}`, to];
    if (opts.bumpCall) sets.push('called_count = called_count + 1', 'called_at = now()');
    if (opts.encounterId) {
      params.push(opts.encounterId);
      sets.push(`encounter_id = $${params.length}`);
    }
    let callerCond = '';
    if (opts.requireCaller) {
      params.push(opts.requireCaller);
      callerCond = ` AND called_by_user_id = $${params.length}`;
    }
    try {
      const r = await this.db.query(
        `UPDATE clinical.queue_tickets SET ${sets.join(', ')}
          WHERE tenant_id = $1 AND ticket_id = $2 AND status = ANY($3::text[])${callerCond}
          RETURNING ${T_COLS}`,
        params,
      );
      return r.rows[0] ? mapTicket(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async insertDisplay(d: QueueDisplay & { tenantId: string; keyHash: Buffer; createdByUserId: UserId }): Promise<void> {
    await this.db.query(
      `INSERT INTO clinical.queue_displays (display_id, tenant_id, organization_id, name, key_hash, created_by_user_id)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6)`,
      [d.displayId, d.tenantId, d.organizationId, d.name, d.keyHash.toString('hex'), d.createdByUserId],
    );
  }

  async listDisplays(organizationId: OrganizationId): Promise<QueueDisplay[]> {
    const r = await this.db.query(
      `SELECT display_id, organization_id, name, is_active, created_at FROM clinical.queue_displays
        WHERE tenant_id = $1 AND organization_id = $2 ORDER BY created_at DESC`,
      [this.t, organizationId],
    );
    return r.rows.map(mapDisplay);
  }

  async revokeDisplay(id: string): Promise<QueueDisplay | null> {
    const r = await this.db.query(
      `UPDATE clinical.queue_displays SET is_active = false WHERE tenant_id = $1 AND display_id = $2
        RETURNING display_id, organization_id, name, is_active, created_at`,
      [this.t, id],
    );
    return r.rows[0] ? mapDisplay(r.rows[0]) : null;
  }
}

export class PgQueueUnitOfWork implements QueueUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  run<T>(ctx: TenantContext, fn: (repo: QueueRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgQueueRepository(db));
      },
      ctx,
    );
  }
}

/** Màn hình gọi số công khai: KHÔNG có tenant context; chỉ gọi hàm DB clinical.queue_board(key). */
export class PgQueueBoard {
  constructor(private readonly pool: PgPoolLike) {}

  async read(key: string): Promise<QueueBoard | null> {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    const c = await this.pool.connect();
    try {
      const r = (await c.query('SELECT * FROM clinical.queue_board($1)', [key])) as { rows: Array<Record<string, unknown>> };
      const meta = r.rows.find((x) => x['kind'] === 'meta');
      if (!meta) return null;
      const row = (x: Record<string, unknown>): BoardRow => {
        const rank = num(x['priority_rank']);
        return {
          kind: x['kind'] as 'called' | 'waiting',
          servicePointCode: x['service_point_code'] as string,
          servicePointName: x['service_point_name'] as string,
          ticketNo: num(x['ticket_no']),
          displayNo: displayNo(x['service_point_code'] as string, num(x['ticket_no'])),
          priority: rank === 2 ? 'emergency' : rank === 1 ? 'priority' : null,
          calledCount: num(x['called_count'] ?? 0),
          calledAt: isoOrNull(x['called_at']),
        };
      };
      return {
        displayName: meta['display_name'] as string,
        organizationName: (meta['organization_name'] as string | null) ?? null,
        called: r.rows.filter((x) => x['kind'] === 'called').map(row),
        waiting: r.rows.filter((x) => x['kind'] === 'waiting').map(row),
      };
    } finally {
      c.release();
    }
  }
}
