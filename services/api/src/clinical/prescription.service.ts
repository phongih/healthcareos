/**
 * HCOS-F5 | Kê đơn thuốc (đơn ngoại trú)
 *
 *   createPrescription      bác sĩ phụ trách, đợt khám đang mở           (prescription:write)
 *   cancelPrescription      bác sĩ đã kê, đơn chưa cấp gì, có If-Match    (prescription:write)
 *   listForEncounter        bác sĩ / dược sĩ cùng organization, hoặc chính bệnh nhân (prescription:read)
 *   listForOrganization     hàng đợi đơn của dược sĩ                       (prescription:read)
 *
 * Cấp phát theo đơn nằm ở PharmacyInventoryService (dispense có prescriptionItemId) để trừ kho và cộng "đã cấp"
 * trong CÙNG một transaction; DB kiểm số đã cấp khớp sổ cái (migration 009).
 *
 * Kiểm soát truy cập giống phần lâm sàng: vai trò lấy từ iam.memberships tại organization của đợt khám, access policy
 * chỉ thu hẹp, audit thành công ghi trong transaction, từ chối/lỗi ghi qua AuditSink. Payload audit không chứa PHI.
 */
import { randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  VersionConflictError,
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
import { asEncounterId, type Encounter, type EncounterId } from '../../../../packages/domain/src/s1-contracts';
import { asMedicationId, type MedicationId } from '../../../../packages/domain/src/s3-pharmacy-contracts';
import {
  asPrescriptionId,
  asPrescriptionItemId,
  PRESCRIPTION_LIMITS as L,
  PRESCRIPTION_STATUSES,
  type NewPrescriptionInput,
  type PrescribedMedication,
  type Prescription,
  type PrescriptionId,
  type PrescriptionItem,
  type PrescriptionStatus,
  type PrescriptionView,
} from '../../../../packages/domain/src/prescription-contracts';
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
import { ClinicalError, iso, num, PgClinicalRepository, translatePgError, type OutboxDraft } from './encounter.service';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
export interface MedicationForPrescribing extends PrescribedMedication {
  readonly tenantId: string;
  readonly isActive: boolean;
}

export interface PatientSummary {
  readonly patientId: PatientId;
  readonly mrn: string;
  readonly familyName: string;
  readonly givenName: string;
}

export interface PrescriptionRepository {
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  findAccessPolicies(ids: readonly AccessPolicyId[]): Promise<AccessPolicy[]>;
  findEncounter(id: EncounterId): Promise<Encounter | null>;
  findPatient(id: PatientId): Promise<Patient | null>;
  findMedicationsForPrescribing(ids: readonly MedicationId[]): Promise<MedicationForPrescribing[]>;
  insertPrescription(p: Prescription): Promise<void>;
  insertPrescriptionItem(i: PrescriptionItem): Promise<void>;
  findPrescription(id: PrescriptionId): Promise<Prescription | null>;
  listPrescriptionsByEncounter(encounterId: EncounterId): Promise<Prescription[]>;
  /** status = active: cũ nhất trước (hàng đợi); trạng thái khác: mới nhất trước. */
  listPrescriptionsByOrganization(organizationId: OrganizationId, status: PrescriptionStatus, limit: number): Promise<Prescription[]>;
  listItems(prescriptionIds: readonly PrescriptionId[]): Promise<PrescriptionItem[]>;
  /** Cập nhật có điều kiện version; null nếu version không khớp. */
  updatePrescriptionStatus(id: PrescriptionId, status: PrescriptionStatus, expectedVersion: number): Promise<Prescription | null>;
  findUserNames(ids: readonly UserId[]): Promise<Array<{ userId: UserId; displayName: string | null }>>;
  findPatientSummaries(ids: readonly PatientId[]): Promise<PatientSummary[]>;
  enqueueOutbox(tenantId: TenantContext['tenantId'], ev: OutboxDraft): Promise<void>;
  appendAudit(ev: NewAuditEvent): Promise<void>;
}

export interface PrescriptionUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PrescriptionRepository) => Promise<T>): Promise<T>;
}

export interface PrescriptionServiceDeps {
  readonly uow: PrescriptionUnitOfWork;
  readonly audit: AuditSink;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Quyền
// ---------------------------------------------------------------------------
type Permission = 'prescription:write' | 'prescription:read';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'prescription:write': ['doctor'],
  'prescription:read': ['doctor', 'pharmacist'],
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

const LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class PrescriptionService {
  private readonly uow: PrescriptionUnitOfWork;
  private readonly audit: AuditSink;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(deps: PrescriptionServiceDeps) {
    this.uow = deps.uow;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async createPrescription(input: NewPrescriptionInput, ctx: TenantContext = requireTenantContext()): Promise<PrescriptionView> {
    const meta: AuditMeta = { action: 'prescription.create', resourceType: 'Prescription' };
    return this.tx(ctx, meta, async (repo) => {
      const encounterId = this.encounterIdOf(input.encounterId);
      const note = optText(input.note, L.noteMax, 'note');
      const lines = validateItems(input.items);

      const encounter = await this.loadEncounter(repo, ctx, encounterId);
      const principal = await this.principal(repo, ctx, encounter.organizationId);
      const decision = this.decide(principal, 'prescription:write', encounter);
      if (encounter.status !== 'in_progress') {
        throw new ClinicalError('INVALID_STATE', `Encounter is not in progress (status=${encounter.status})`, { reason: 'ENCOUNTER_NOT_OPEN' });
      }
      if (encounter.practitionerUserId !== principal.user.userId) {
        throw new ClinicalError('FORBIDDEN', 'Only the responsible practitioner may prescribe');
      }

      const meds = await repo.findMedicationsForPrescribing(lines.map((l) => l.medicationId));
      const medById = new Map(meds.map((m) => [m.medicationId, m]));
      for (const l of lines) {
        const m = medById.get(l.medicationId);
        if (!m) throw new ClinicalError('VALIDATION', `Medication ${l.medicationId} not found`, { reason: 'MEDICATION_NOT_FOUND' });
        assertSameTenant(m as never, ctx);
        if (!m.isActive) throw new ClinicalError('VALIDATION', `Medication ${m.brandName} is inactive`, { reason: 'INACTIVE_MEDICATION' });
      }

      const now = this.clock().toISOString();
      const prescription: Prescription = {
        tenantId: ctx.tenantId,
        prescriptionId: asPrescriptionId(this.newId()),
        organizationId: encounter.organizationId,
        encounterId: encounter.encounterId,
        patientId: encounter.patientId,
        prescriberUserId: principal.user.userId,
        status: 'active',
        note,
        prescribedAt: now,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repo.insertPrescription(prescription);
      const items: PrescriptionItem[] = [];
      for (const [i, l] of lines.entries()) {
        const item: PrescriptionItem = {
          tenantId: ctx.tenantId,
          itemId: asPrescriptionItemId(this.newId()),
          prescriptionId: prescription.prescriptionId,
          lineNo: i + 1,
          medicationId: l.medicationId,
          doseQuantity: l.doseQuantity,
          doseUnit: l.doseUnit,
          frequencyPerDay: l.frequencyPerDay,
          durationDays: l.durationDays,
          instructions: l.instructions,
          quantityPrescribed: l.quantity,
          quantityDispensed: 0,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        await repo.insertPrescriptionItem(item);
        items.push(item);
      }
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter',
        aggregateId: encounter.encounterId,
        eventType: 'clinical.prescription.created',
        payload: { prescriptionId: prescription.prescriptionId, encounterId: encounter.encounterId, patientId: encounter.patientId, itemCount: items.length },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: prescription.prescriptionId, patientId: encounter.patientId, organizationId: encounter.organizationId },
          'success', principal.user, { encounterId: encounter.encounterId, itemCount: items.length, ...policyAudit(decision) }),
      );
      return {
        prescription,
        items: items.map((it) => ({ ...it, medication: publicMedication(medById.get(it.medicationId)!) })),
        prescriber: { userId: principal.user.userId, displayName: principal.user.displayName },
      };
    });
  }

  async cancelPrescription(id: string, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<Prescription> {
    const meta: AuditMeta = { action: 'prescription.cancel', resourceType: 'Prescription', resourceId: id };
    return this.tx(ctx, meta, async (repo) => {
      if (!isUuid(id)) throw new ClinicalError('VALIDATION', 'prescription id must be a UUID');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ClinicalError('VALIDATION', 'expectedVersion must be a positive integer');
      const p = await repo.findPrescription(asPrescriptionId(id));
      if (!p) throw new ClinicalError('NOT_FOUND', 'Prescription not found');
      assertSameTenant(p, ctx);
      const encounter = await this.loadEncounter(repo, ctx, p.encounterId);
      const principal = await this.principal(repo, ctx, p.organizationId);
      const decision = this.decide(principal, 'prescription:write', encounter);
      if (p.prescriberUserId !== principal.user.userId) {
        throw new ClinicalError('FORBIDDEN', 'Only the prescriber may cancel this prescription');
      }
      if (p.status !== 'active') {
        throw new ClinicalError('INVALID_STATE', `Prescription is ${p.status}`, { reason: 'PRESCRIPTION_NOT_ACTIVE' });
      }
      const items = await repo.listItems([p.prescriptionId]);
      if (items.some((i) => i.quantityDispensed > 0)) {
        throw new ClinicalError('CONFLICT', 'Prescription already has dispensed items', { reason: 'ALREADY_DISPENSED' });
      }
      const saved = await repo.updatePrescriptionStatus(p.prescriptionId, 'cancelled', expectedVersion);
      if (!saved) throw new VersionConflictError('Prescription', p.prescriptionId, expectedVersion);
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter',
        aggregateId: p.encounterId,
        eventType: 'clinical.prescription.cancelled',
        payload: { prescriptionId: p.prescriptionId, encounterId: p.encounterId },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, patientId: p.patientId, organizationId: p.organizationId }, 'success', principal.user, {
          encounterId: p.encounterId,
          ...policyAudit(decision),
        }),
      );
      return saved;
    });
  }

  async listForEncounter(encounterId: string, ctx: TenantContext = requireTenantContext()): Promise<PrescriptionView[]> {
    const meta: AuditMeta = { action: 'prescription.list', resourceType: 'Prescription' };
    return this.tx(ctx, meta, async (repo) => {
      const encounter = await this.loadEncounter(repo, ctx, this.encounterIdOf(encounterId));
      const user = await this.activeUser(repo, ctx);
      const patient = await repo.findPatient(encounter.patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);
      const isSelf = user.personId !== null && user.personId === patient.personId;
      let decision: AllowedDecision | null = null;
      if (!isSelf) decision = this.decide(await this.principalFor(repo, user, encounter.organizationId), 'prescription:read', encounter);

      const list = await repo.listPrescriptionsByEncounter(encounter.encounterId);
      const views = await this.views(repo, ctx, list.filter((p) => p.encounterId === encounter.encounterId), false);
      await repo.appendAudit(
        this.event(ctx, { ...meta, patientId: encounter.patientId, organizationId: encounter.organizationId }, 'success', user, {
          encounterId: encounter.encounterId,
          count: views.length,
          self: isSelf,
          ...(decision ? policyAudit(decision) : {}),
        }),
      );
      return views;
    });
  }

  async listForOrganization(
    q: { organizationId: string; status?: string },
    ctx: TenantContext = requireTenantContext(),
  ): Promise<PrescriptionView[]> {
    const meta: AuditMeta = { action: 'prescription.queue', resourceType: 'Prescription' };
    return this.tx(ctx, meta, async (repo) => {
      if (!isUuid(q.organizationId)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
      const status = (q.status ?? 'active') as PrescriptionStatus;
      if (!PRESCRIPTION_STATUSES.includes(status)) throw new ClinicalError('VALIDATION', 'Unknown prescription status');
      const organizationId = q.organizationId.toLowerCase() as OrganizationId;
      assertOrganizationAllowed(organizationId, ctx);
      const principal = await this.principal(repo, ctx, organizationId);
      const decision = this.decide(principal, 'prescription:read');

      const list = await repo.listPrescriptionsByOrganization(organizationId, status, LIST_LIMIT);
      const views = await this.views(repo, ctx, list.filter((p) => p.organizationId === organizationId && p.status === status), true);
      await repo.appendAudit(
        this.event(ctx, { ...meta, organizationId }, 'success', principal.user, { status, count: views.length, ...policyAudit(decision) }),
      );
      return views;
    });
  }

  // ---- Internals ---------------------------------------------------------
  private async views(repo: PrescriptionRepository, ctx: TenantContext, list: Prescription[], withPatient: boolean): Promise<PrescriptionView[]> {
    if (list.length === 0) return [];
    for (const p of list) assertSameTenant(p, ctx);
    const items = await repo.listItems(list.map((p) => p.prescriptionId));
    for (const i of items) assertSameTenant(i, ctx);
    const meds = await repo.findMedicationsForPrescribing([...new Set(items.map((i) => i.medicationId))]);
    const medById = new Map(meds.map((m) => [m.medicationId, m]));
    const names = new Map((await repo.findUserNames([...new Set(list.map((p) => p.prescriberUserId))])).map((u) => [u.userId, u.displayName]));
    const patients = withPatient
      ? new Map((await repo.findPatientSummaries([...new Set(list.map((p) => p.patientId))])).map((s) => [s.patientId, s]))
      : null;
    return list.map((p) => ({
      prescription: p,
      items: items
        .filter((i) => i.prescriptionId === p.prescriptionId)
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((i) => {
          const m = medById.get(i.medicationId);
          if (!m) throw new ClinicalError('NOT_FOUND', 'Medication of prescription item not found');
          return { ...i, medication: publicMedication(m) };
        }),
      prescriber: { userId: p.prescriberUserId, displayName: names.get(p.prescriberUserId) ?? null },
      ...(patients && patients.get(p.patientId) ? { patient: patients.get(p.patientId)! } : {}),
    }));
  }

  private encounterIdOf(raw: string): EncounterId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'encounterId must be a UUID');
    return asEncounterId(raw);
  }

  private async loadEncounter(repo: PrescriptionRepository, ctx: TenantContext, id: EncounterId): Promise<Encounter> {
    const e = await repo.findEncounter(id);
    if (!e) throw new ClinicalError('NOT_FOUND', 'Encounter not found');
    assertSameTenant(e, ctx);
    assertOrganizationAllowed(e.organizationId, ctx);
    return e;
  }

  private async activeUser(repo: PrescriptionRepository, ctx: TenantContext): Promise<User> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    return user;
  }

  private async principalFor(repo: PrescriptionRepository, user: User, organizationId: OrganizationId): Promise<Principal> {
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m) =>
        m.organizationId === organizationId &&
        m.status === 'active' &&
        Date.parse(m.validFrom) <= now &&
        (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return { user, grants: await buildGrants(valid, user.tenantId, (ids) => repo.findAccessPolicies(ids)) };
  }

  private async principal(repo: PrescriptionRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    return this.principalFor(repo, await this.activeUser(repo, ctx), organizationId);
  }

  private decide(p: Principal, action: PolicyAction, encounter?: Encounter): AllowedDecision {
    const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
    const d = decideAccess(p.grants, action, PERMISSIONS[perm], {
      callerUserId: p.user.userId,
      ...(encounter
        ? { encounter: { practitionerUserId: encounter.practitionerUserId, encounterClass: encounter.encounterClass, status: encounter.status } }
        : {}),
    });
    if (!d.allowed) {
      if (d.reason === 'ROLE') throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
      throw new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
    }
    return d;
  }

  private event(ctx: TenantContext, meta: AuditMeta, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: this.newId() as AuditEventId,
      tenantId: ctx.tenantId,
      actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: meta.organizationId ?? null,
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      personId: null,
      patientId: meta.patientId ?? null,
      outcome,
      correlationId: ctx.correlationId as CorrelationId,
      sourceIp: null,
      userAgent: null,
      payload,
    };
  }

  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: PrescriptionRepository) => Promise<T>): Promise<T> {
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
      } else if (e instanceof VersionConflictError) code = 'VERSION_CONFLICT';
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
interface ValidLine {
  readonly medicationId: MedicationId;
  readonly doseQuantity: number;
  readonly doseUnit: string;
  readonly frequencyPerDay: number;
  readonly durationDays: number;
  readonly quantity: number;
  readonly instructions: string | null;
}

function optText(v: unknown, max: number, label: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ClinicalError('VALIDATION', `${label} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new ClinicalError('VALIDATION', `${label} too long`);
  return t === '' ? null : t;
}

function intIn(v: unknown, min: number, max: number, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ClinicalError('VALIDATION', `${label} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function validateItems(raw: unknown): ValidLine[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > L.maxItems) {
    throw new ClinicalError('VALIDATION', `items must contain 1-${L.maxItems} lines`);
  }
  const seen = new Set<string>();
  return raw.map((r, idx) => {
    const at = `items[${idx}]`;
    if (!r || typeof r !== 'object') throw new ClinicalError('VALIDATION', `${at} must be an object`);
    const o = r as Record<string, unknown>;
    const mid = o['medicationId'];
    if (typeof mid !== 'string' || !isUuid(mid)) throw new ClinicalError('VALIDATION', `${at}.medicationId must be a UUID`);
    const medicationId = asMedicationId(mid);
    if (seen.has(medicationId)) {
      throw new ClinicalError('VALIDATION', `${at}: medication appears twice in one prescription`, { reason: 'DUPLICATE_MEDICATION' });
    }
    seen.add(medicationId);
    const dose = o['doseQuantity'];
    if (typeof dose !== 'number' || !Number.isFinite(dose) || dose <= 0 || dose > L.maxDose || Math.round(dose * 1000) !== dose * 1000) {
      throw new ClinicalError('VALIDATION', `${at}.doseQuantity must be > 0, at most ${L.maxDose}, max 3 decimals`);
    }
    const unit = optText(o['doseUnit'], L.doseUnitMax, `${at}.doseUnit`);
    if (!unit) throw new ClinicalError('VALIDATION', `${at}.doseUnit is required`);
    return {
      medicationId,
      doseQuantity: dose,
      doseUnit: unit,
      frequencyPerDay: intIn(o['frequencyPerDay'], 1, L.maxFrequencyPerDay, `${at}.frequencyPerDay`),
      durationDays: intIn(o['durationDays'], 1, L.maxDurationDays, `${at}.durationDays`),
      quantity: intIn(o['quantity'], 1, L.maxQuantity, `${at}.quantity`),
      instructions: optText(o['instructions'], L.instructionsMax, `${at}.instructions`),
    };
  });
}

const publicMedication = (m: MedicationForPrescribing): PrescribedMedication => ({
  medicationId: m.medicationId,
  brandName: m.brandName,
  genericName: m.genericName,
  strength: m.strength,
  form: m.form,
  unitOfMeasure: m.unitOfMeasure,
});

function policyAudit(d: AllowedDecision): Record<string, unknown> {
  return d.policyIds.length === 0 ? {} : { accessPolicyIds: d.policyIds };
}

// ===========================================================================
// PostgreSQL adapter
// ===========================================================================
const RX_COLS =
  'prescription_id, tenant_id, organization_id, encounter_id, patient_id, prescriber_user_id, status, note, prescribed_at, created_at, updated_at, version';
const ITEM_COLS =
  'item_id, tenant_id, prescription_id, line_no, medication_id, dose_quantity, dose_unit, frequency_per_day, duration_days, instructions, quantity_prescribed, quantity_dispensed, created_at, updated_at, version';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapRx = (r: any): Prescription => ({
  tenantId: r.tenant_id, prescriptionId: r.prescription_id, organizationId: r.organization_id, encounterId: r.encounter_id,
  patientId: r.patient_id, prescriberUserId: r.prescriber_user_id, status: r.status, note: r.note ?? null,
  prescribedAt: iso(r.prescribed_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
const mapItem = (r: any): PrescriptionItem => ({
  tenantId: r.tenant_id, itemId: r.item_id, prescriptionId: r.prescription_id, lineNo: num(r.line_no), medicationId: r.medication_id,
  doseQuantity: num(r.dose_quantity), doseUnit: r.dose_unit, frequencyPerDay: num(r.frequency_per_day), durationDays: num(r.duration_days),
  instructions: r.instructions ?? null, quantityPrescribed: num(r.quantity_prescribed), quantityDispensed: num(r.quantity_dispensed),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const uuidArray = (ids: readonly string[]): string => `{${ids.join(',')}}`;

export class PgPrescriptionRepository extends PgClinicalRepository implements PrescriptionRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }

  async findMedicationsForPrescribing(ids: readonly MedicationId[]): Promise<MedicationForPrescribing[]> {
    if (ids.length === 0) return [];
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT medication_id, tenant_id, brand_name, generic_name, strength, form, unit_of_measure, is_active
         FROM pharmacy.medications WHERE tenant_id = $1 AND medication_id = ANY($2::uuid[])`,
      [this.t, uuidArray(ids)],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      medicationId: x['medication_id'] as MedicationId,
      tenantId: x['tenant_id'] as string,
      brandName: x['brand_name'] as string,
      genericName: (x['generic_name'] as string | null) ?? null,
      strength: x['strength'] as string,
      form: x['form'] as string,
      unitOfMeasure: x['unit_of_measure'] as string,
      isActive: x['is_active'] === true || x['is_active'] === 't',
    }));
  }

  async insertPrescription(p: Prescription): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.prescriptions
           (prescription_id, tenant_id, organization_id, encounter_id, patient_id, prescriber_user_id, status, note, prescribed_at, created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.prescriptionId, p.tenantId, p.organizationId, p.encounterId, p.patientId, p.prescriberUserId, p.status, p.note,
         p.prescribedAt, p.createdAt, p.updatedAt, p.version],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async insertPrescriptionItem(i: PrescriptionItem): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.prescription_items
           (item_id, tenant_id, prescription_id, line_no, medication_id, dose_quantity, dose_unit, frequency_per_day, duration_days,
            instructions, quantity_prescribed, quantity_dispensed, created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [i.itemId, i.tenantId, i.prescriptionId, i.lineNo, i.medicationId, i.doseQuantity, i.doseUnit, i.frequencyPerDay, i.durationDays,
         i.instructions, i.quantityPrescribed, i.quantityDispensed, i.createdAt, i.updatedAt, i.version],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async findPrescription(id: PrescriptionId): Promise<Prescription | null> {
    const r = await this.db.query(`SELECT ${RX_COLS} FROM clinical.prescriptions WHERE tenant_id = $1 AND prescription_id = $2`, [this.t, id]);
    return r.rows[0] ? mapRx(r.rows[0]) : null;
  }

  async listPrescriptionsByEncounter(encounterId: EncounterId): Promise<Prescription[]> {
    const r = await this.db.query(
      `SELECT ${RX_COLS} FROM clinical.prescriptions WHERE tenant_id = $1 AND encounter_id = $2 ORDER BY prescribed_at, prescription_id`,
      [this.t, encounterId],
    );
    return r.rows.map(mapRx);
  }

  async listPrescriptionsByOrganization(organizationId: OrganizationId, status: PrescriptionStatus, limit: number): Promise<Prescription[]> {
    const order = status === 'active' ? 'ASC' : 'DESC';
    const r = await this.db.query(
      `SELECT ${RX_COLS} FROM clinical.prescriptions
        WHERE tenant_id = $1 AND organization_id = $2 AND status = $3
        ORDER BY prescribed_at ${order}, prescription_id LIMIT $4`,
      [this.t, organizationId, status, limit],
    );
    return r.rows.map(mapRx);
  }

  async listItems(prescriptionIds: readonly PrescriptionId[]): Promise<PrescriptionItem[]> {
    if (prescriptionIds.length === 0) return [];
    const r = await this.db.query(
      `SELECT ${ITEM_COLS} FROM clinical.prescription_items
        WHERE tenant_id = $1 AND prescription_id = ANY($2::uuid[]) ORDER BY prescription_id, line_no`,
      [this.t, uuidArray(prescriptionIds)],
    );
    return r.rows.map(mapItem);
  }

  async updatePrescriptionStatus(id: PrescriptionId, status: PrescriptionStatus, expectedVersion: number): Promise<Prescription | null> {
    try {
      const r = await this.db.query(
        `UPDATE clinical.prescriptions SET status = $1
          WHERE tenant_id = $2 AND prescription_id = $3 AND version = $4 RETURNING ${RX_COLS}`,
        [status, this.t, id, expectedVersion],
      );
      return r.rows[0] ? mapRx(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async findUserNames(ids: readonly UserId[]): Promise<Array<{ userId: UserId; displayName: string | null }>> {
    if (ids.length === 0) return [];
    const r = await this.db.query<Record<string, unknown>>(`SELECT user_id, display_name FROM iam.users WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`, [
      this.t,
      uuidArray(ids),
    ]);
    return r.rows.map((x: Record<string, unknown>) => ({ userId: x['user_id'] as UserId, displayName: (x['display_name'] as string | null) ?? null }));
  }

  async findPatientSummaries(ids: readonly PatientId[]): Promise<PatientSummary[]> {
    if (ids.length === 0) return [];
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT pt.patient_id, pt.mrn, ps.family_name, ps.given_name
         FROM patient.patients pt JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
        WHERE pt.tenant_id = $1 AND pt.patient_id = ANY($2::uuid[])`,
      [this.t, uuidArray(ids)],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      patientId: x['patient_id'] as PatientId,
      mrn: x['mrn'] as string,
      familyName: x['family_name'] as string,
      givenName: x['given_name'] as string,
    }));
  }
}

export class PgPrescriptionUnitOfWork implements PrescriptionUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  run<T>(ctx: TenantContext, fn: (repo: PrescriptionRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgPrescriptionRepository(db));
      },
      ctx,
    );
  }
}
