/**
 * HCOS-P0-ENG-001 | Slice S1 | Clinical Encounter Service
 *
 * Vòng đời: registerPatient -> createEncounter -> addCondition / recordObservation -> closeEncounter
 * + getEncounterChart (đọc bệnh án, có kiểm soát truy cập).
 *
 * Kiểm soát truy cập (từng lớp, fail-closed):
 *  1. Tenant: TenantContext (từ JWT) + repository bị RLS + assertSameTenant trên mọi thực thể đọc được.
 *  2. Organization: token phải có org trong phạm vi (assertOrganizationAllowed).
 *  3. Practitioner: vai trò lấy từ iam.memberships còn hiệu lực TẠI organization (không tin riêng JWT roles).
 *     - condition / close: chỉ bác sĩ phụ trách đợt khám.
 *     - observation: bác sĩ phụ trách hoặc clinic_staff cùng organization.
 *     - chart read: doctor / clinic_staff / pharmacist cùng organization, hoặc chính bệnh nhân (user.personId).
 *     - tenant_admin / clinic_admin / executive KHÔNG có quyền lâm sàng (tách quyền quản trị và dữ liệu y tế).
 *  4. Audit: thành công ghi trong cùng transaction (atomic); từ chối/lỗi ghi qua AuditSink ngoài transaction.
 *     Payload audit chỉ chứa ID/metadata, không chứa PHI.
 */
import { randomUUID } from 'node:crypto';

import {
  asPatientId,
  isUuid,
  TenantIsolationError,
  VersionConflictError,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Identifier,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type Patient,
  type PatientId,
  type Person,
  type PersonId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import {
  asConditionId,
  asEncounterId,
  asObservationId,
  type CodedConcept,
  type Condition,
  type Encounter,
  type EncounterId,
  type NewConditionInput,
  type NewEncounterInput,
  type NewObservationInput,
  type Observation,
} from '../../../../packages/domain/src/s1-contracts';
import {
  assertOrganizationAllowed,
  assertSameTenant,
  requireTenantContext,
  withTenantTransaction,
  type PgPoolLike,
} from '../../../../packages/security/src/tenant-context';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export type ClinicalErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'INVALID_STATE';

export class ClinicalError extends Error {
  constructor(
    public readonly code: ClinicalErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ClinicalError';
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
export interface OutboxDraft {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Mọi method đều ngầm định tenant của transaction hiện tại (RLS) và PHẢI tự lọc theo tenant_id. */
export interface ClinicalRepository {
  findPerson(personId: PersonId): Promise<Person | null>;
  findPatient(patientId: PatientId): Promise<Patient | null>;
  listIdentifiers(personId: PersonId): Promise<Identifier[]>;
  /** Ném ClinicalError('CONFLICT', ..., { reason }) khi vi phạm unique. */
  insertPatient(patient: Patient): Promise<void>;
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  insertEncounter(e: Encounter): Promise<void>;
  findEncounter(id: EncounterId): Promise<Encounter | null>;
  /** Cập nhật có điều kiện version; trả null nếu version không khớp / không tìm thấy. */
  updateEncounter(next: Encounter, expectedVersion: number): Promise<Encounter | null>;
  insertCondition(c: Condition): Promise<void>;
  listConditions(encounterId: EncounterId): Promise<Condition[]>;
  insertObservation(o: Observation): Promise<void>;
  listObservations(encounterId: EncounterId): Promise<Observation[]>;
  enqueueOutbox(tenantId: TenantContext['tenantId'], ev: OutboxDraft): Promise<void>;
  appendAudit(ev: NewAuditEvent): Promise<void>;
}

export interface ClinicalUnitOfWork {
  /** Chạy fn trong 1 transaction gắn với tenant của ctx. Lỗi => rollback toàn bộ. */
  run<T>(ctx: TenantContext, fn: (repo: ClinicalRepository) => Promise<T>): Promise<T>;
}

export interface ClinicalServiceDeps {
  readonly uow: ClinicalUnitOfWork;
  /** Sink ngoài transaction, dùng cho audit từ chối/lỗi. */
  readonly audit: AuditSink;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Authorization model
// ---------------------------------------------------------------------------
type Permission =
  | 'patient:register'
  | 'encounter:create'
  | 'condition:write'
  | 'observation:write'
  | 'encounter:close'
  | 'chart:read';

const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'patient:register': ['clinic_staff', 'clinic_admin', 'doctor'],
  'encounter:create': ['doctor'],
  'condition:write': ['doctor'],
  'observation:write': ['doctor', 'clinic_staff'],
  'encounter:close': ['doctor'],
  'chart:read': ['doctor', 'clinic_staff', 'pharmacist'],
};

interface Principal {
  readonly user: User;
  readonly roles: ReadonlySet<Role>;
}

interface AuditMeta {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly patientId?: PatientId;
  readonly organizationId?: OrganizationId;
}

export interface EncounterChart {
  readonly encounter: Encounter;
  readonly conditions: readonly Condition[];
  readonly observations: readonly Observation[];
}

export interface RegisterPatientInput {
  readonly personId: PersonId;
  readonly organizationId: OrganizationId;
  readonly mrn: string;
}

const MRN_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class ClinicalEncounterService {
  private readonly uow: ClinicalUnitOfWork;
  private readonly audit: AuditSink;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(deps: ClinicalServiceDeps) {
    this.uow = deps.uow;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ---- Patient registry --------------------------------------------------
  async registerPatient(input: RegisterPatientInput, ctx: TenantContext = requireTenantContext()): Promise<Patient> {
    const meta: AuditMeta = { action: 'patient.register', resourceType: 'Patient', organizationId: input.organizationId };
    return this.tx(ctx, meta, async (repo) => {
      if (!MRN_RE.test(input.mrn)) throw new ClinicalError('VALIDATION', 'Invalid MRN format');
      assertOrganizationAllowed(input.organizationId, ctx);
      const principal = await this.principal(repo, ctx, input.organizationId);
      this.authorize(principal, 'patient:register');

      const person = await repo.findPerson(input.personId);
      if (!person) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(person, ctx);
      if (person.status !== 'active') {
        throw new ClinicalError('INVALID_STATE', 'Person is not active (merged/deceased/inactive)');
      }

      const now = this.now();
      const patient: Patient = {
        tenantId: ctx.tenantId,
        patientId: asPatientId(this.newId()),
        personId: person.personId,
        organizationId: input.organizationId,
        mrn: input.mrn,
        status: 'active',
        registeredAt: now,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repo.insertPatient(patient); // CONFLICT: MRN_TAKEN | PERSON_ALREADY_REGISTERED | ID_COLLISION
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'patient',
        aggregateId: patient.patientId,
        eventType: 'patient.registered',
        payload: { patientId: patient.patientId, personId: patient.personId, organizationId: patient.organizationId },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: patient.patientId, patientId: patient.patientId }, 'success', principal.user, {
          personId: patient.personId,
        }),
      );
      return patient;
    });
  }

  // ---- Encounter lifecycle ----------------------------------------------
  async createEncounter(input: NewEncounterInput, ctx: TenantContext = requireTenantContext()): Promise<Encounter> {
    const meta: AuditMeta = {
      action: 'encounter.create',
      resourceType: 'Encounter',
      patientId: input.patientId,
      organizationId: input.organizationId,
    };
    return this.tx(ctx, meta, async (repo) => {
      this.validateText(input.reasonText ?? null, 1000, 'reasonText');
      const start = input.periodStart ? this.parseTime(input.periodStart, 'periodStart') : this.now();
      assertOrganizationAllowed(input.organizationId, ctx);
      const principal = await this.principal(repo, ctx, input.organizationId);
      this.authorize(principal, 'encounter:create');

      const patient = await repo.findPatient(input.patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);
      if (patient.organizationId !== input.organizationId) {
        throw new ClinicalError('FORBIDDEN', 'Patient is not registered at this organization');
      }
      if (patient.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Patient record is not active');

      const now = this.now();
      const encounter: Encounter = {
        tenantId: ctx.tenantId,
        encounterId: asEncounterId(this.newId()),
        patientId: patient.patientId,
        organizationId: input.organizationId,
        practitionerUserId: principal.user.userId,
        status: 'in_progress',
        encounterClass: input.encounterClass,
        reasonText: input.reasonText ?? null,
        periodStart: start,
        periodEnd: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repo.insertEncounter(encounter);
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter',
        aggregateId: encounter.encounterId,
        eventType: 'clinical.encounter.created',
        payload: { encounterId: encounter.encounterId, patientId: patient.patientId, organizationId: input.organizationId },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: encounter.encounterId }, 'success', principal.user, {}),
      );
      return encounter;
    });
  }

  async addCondition(input: NewConditionInput, ctx: TenantContext = requireTenantContext()): Promise<Condition> {
    const meta: AuditMeta = { action: 'condition.create', resourceType: 'Condition', resourceId: undefined };
    return this.tx(ctx, meta, async (repo) => {
      this.validateCoded(input.code, 'code');
      const onset = input.onsetAt ? this.parseTime(input.onsetAt, 'onsetAt') : null;

      const { encounter, principal } = await this.loadOpenEncounter(repo, ctx, input.encounterId, 'condition:write');
      this.assertSubject(encounter, input.expectedPatientId);
      this.requireResponsiblePractitioner(encounter, principal);

      const now = this.now();
      const condition: Condition = {
        tenantId: ctx.tenantId,
        conditionId: asConditionId(this.newId()),
        patientId: encounter.patientId,
        encounterId: encounter.encounterId,
        category: input.category ?? 'encounter_diagnosis',
        code: input.code,
        clinicalStatus: input.clinicalStatus ?? 'active',
        verificationStatus: input.verificationStatus ?? 'confirmed',
        onsetAt: onset,
        abatedAt: null,
        recordedByUserId: principal.user.userId,
        recordedAt: now,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repo.insertCondition(condition); // CONFLICT: DUPLICATE_CONDITION
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter',
        aggregateId: encounter.encounterId,
        eventType: 'clinical.condition.recorded',
        payload: { conditionId: condition.conditionId, encounterId: encounter.encounterId, patientId: encounter.patientId },
      });
      await repo.appendAudit(
        this.event(
          ctx,
          {
            ...meta,
            resourceId: condition.conditionId,
            patientId: encounter.patientId,
            organizationId: encounter.organizationId,
          },
          'success',
          principal.user,
          { encounterId: encounter.encounterId, codeSystem: input.code.system },
        ),
      );
      return condition;
    });
  }

  async recordObservation(input: NewObservationInput, ctx: TenantContext = requireTenantContext()): Promise<Observation> {
    const meta: AuditMeta = { action: 'observation.create', resourceType: 'Observation' };
    return this.tx(ctx, meta, async (repo) => {
      this.validateCoded(input.code, 'code');
      this.validateValue(input);
      const effective = input.effectiveAt ? this.parseTime(input.effectiveAt, 'effectiveAt') : this.now();

      const { encounter, principal } = await this.loadOpenEncounter(repo, ctx, input.encounterId, 'observation:write');
      this.assertSubject(encounter, input.expectedPatientId);
      // clinic_staff (điều dưỡng/lễ tân) được ghi chỉ số; bác sĩ phải là bác sĩ phụ trách.
      if (principal.roles.has('doctor') && !principal.roles.has('clinic_staff')) {
        this.requireResponsiblePractitioner(encounter, principal);
      }

      const now = this.now();
      const observation: Observation = {
        tenantId: ctx.tenantId,
        observationId: asObservationId(this.newId()),
        patientId: encounter.patientId,
        encounterId: encounter.encounterId,
        status: input.status ?? 'final',
        code: input.code,
        value: input.value,
        effectiveAt: effective,
        supersedesObservationId: null,
        recordedByUserId: principal.user.userId,
        recordedAt: now,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repo.insertObservation(observation);
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter',
        aggregateId: encounter.encounterId,
        eventType: 'clinical.observation.recorded',
        payload: {
          observationId: observation.observationId,
          encounterId: encounter.encounterId,
          patientId: encounter.patientId,
          codeSystem: input.code.system,
          code: input.code.code,
        },
      });
      await repo.appendAudit(
        this.event(
          ctx,
          {
            ...meta,
            resourceId: observation.observationId,
            patientId: encounter.patientId,
            organizationId: encounter.organizationId,
          },
          'success',
          principal.user,
          { encounterId: encounter.encounterId, codeSystem: input.code.system },
        ),
      );
      return observation;
    });
  }

  async closeEncounter(
    encounterId: EncounterId,
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<Encounter> {
    const meta: AuditMeta = { action: 'encounter.close', resourceType: 'Encounter', resourceId: encounterId };
    return this.tx(ctx, meta, async (repo) => {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new ClinicalError('VALIDATION', 'expectedVersion must be a positive integer');
      }
      const { encounter, principal } = await this.loadOpenEncounter(repo, ctx, encounterId, 'encounter:close');
      this.requireResponsiblePractitioner(encounter, principal);

      const now = this.now();
      const closed: Encounter = {
        ...encounter,
        status: 'finished',
        periodEnd: now < encounter.periodStart ? encounter.periodStart : now,
        updatedAt: now,
        version: encounter.version + 1,
      };
      const saved = await repo.updateEncounter(closed, expectedVersion);
      if (!saved) throw new VersionConflictError('Encounter', encounterId, expectedVersion);

      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'encounter',
        aggregateId: encounterId,
        eventType: 'clinical.encounter.finished',
        payload: { encounterId, patientId: encounter.patientId, organizationId: encounter.organizationId },
      });
      await repo.appendAudit(
        this.event(
          ctx,
          { ...meta, patientId: encounter.patientId, organizationId: encounter.organizationId },
          'success',
          principal.user,
          { fromVersion: expectedVersion, toVersion: saved.version },
        ),
      );
      return saved;
    });
  }

  // ---- Read --------------------------------------------------------------
  async getEncounterChart(encounterId: EncounterId, ctx: TenantContext = requireTenantContext()): Promise<EncounterChart> {
    const meta: AuditMeta = { action: 'encounter.read', resourceType: 'Encounter', resourceId: encounterId };
    return this.tx(ctx, meta, async (repo) => {
      const encounter = await repo.findEncounter(encounterId);
      if (!encounter) throw new ClinicalError('NOT_FOUND', 'Encounter not found');
      assertSameTenant(encounter, ctx);

      const user = await this.activeUser(repo, ctx);
      const patient = await repo.findPatient(encounter.patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);

      const isSelf = user.personId !== null && user.personId === patient.personId;
      if (!isSelf) {
        assertOrganizationAllowed(encounter.organizationId, ctx);
        const principal = await this.principalFor(repo, user, encounter.organizationId);
        this.authorize(principal, 'chart:read');
      }

      const [conditions, observations] = await Promise.all([
        repo.listConditions(encounterId),
        repo.listObservations(encounterId),
      ]);
      for (const c of conditions) assertSameTenant(c, ctx);
      for (const o of observations) assertSameTenant(o, ctx);

      await repo.appendAudit(
        this.event(
          ctx,
          { ...meta, patientId: encounter.patientId, organizationId: encounter.organizationId },
          'success',
          user,
          { self: isSelf },
        ),
      );
      return { encounter, conditions, observations };
    });
  }

  /** Đọc hồ sơ bệnh nhân (person + patient + identifiers) với kiểm soát truy cập như bệnh án. */
  async getPatient(
    patientId: PatientId,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ person: Person; patient: Patient; identifiers: Identifier[] }> {
    const meta: AuditMeta = { action: 'patient.read', resourceType: 'Patient', resourceId: patientId, patientId };
    return this.tx(ctx, meta, async (repo) => {
      const patient = await repo.findPatient(patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);

      const user = await this.activeUser(repo, ctx);
      const isSelf = user.personId !== null && user.personId === patient.personId;
      if (!isSelf) {
        assertOrganizationAllowed(patient.organizationId, ctx);
        this.authorize(await this.principalFor(repo, user, patient.organizationId), 'chart:read');
      }

      const person = await repo.findPerson(patient.personId);
      if (!person) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(person, ctx);
      const identifiers = await repo.listIdentifiers(person.personId);
      for (const i of identifiers) assertSameTenant(i, ctx);

      await repo.appendAudit(
        this.event(ctx, { ...meta, organizationId: patient.organizationId }, 'success', user, { self: isSelf }),
      );
      return { person, patient, identifiers };
    });
  }

  // ---- Internals ---------------------------------------------------------
  private assertSubject(encounter: Encounter, expected: PatientId | undefined): void {
    if (expected !== undefined && expected !== encounter.patientId) {
      throw new ClinicalError('VALIDATION', 'Resource subject does not match the encounter patient');
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private parseTime(raw: string, label: string): string {
    const t = Date.parse(raw);
    if (Number.isNaN(t)) throw new ClinicalError('VALIDATION', `Invalid ${label}`);
    return new Date(t).toISOString();
  }

  private validateText(v: string | null, max: number, label: string): void {
    if (v !== null && v.length > max) throw new ClinicalError('VALIDATION', `${label} too long`);
  }

  private validateCoded(c: CodedConcept, label: string): void {
    if (!c || !c.system || c.system.length > 200 || !c.code || c.code.length > 64) {
      throw new ClinicalError('VALIDATION', `${label} requires system and code`);
    }
    this.validateText(c.display, 500, `${label}.display`);
  }

  private validateValue(input: NewObservationInput): void {
    const v = input.value;
    if (v.kind === 'quantity') {
      if (!Number.isFinite(v.value) || !v.unit || v.unit.length > 32) {
        throw new ClinicalError('VALIDATION', 'Observation quantity requires finite value and unit');
      }
    } else if (v.kind === 'string') {
      if (!v.value || v.value.length > 4000) throw new ClinicalError('VALIDATION', 'Observation string value invalid');
    } else {
      throw new ClinicalError('VALIDATION', 'Unsupported observation value');
    }
  }

  private async activeUser(repo: ClinicalRepository, ctx: TenantContext): Promise<User> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    return user;
  }

  private async principalFor(repo: ClinicalRepository, user: User, organizationId: OrganizationId): Promise<Principal> {
    const now = this.clock().getTime();
    const memberships = await repo.listMemberships(user.userId);
    const roles = new Set<Role>();
    for (const m of memberships) {
      const valid =
        m.organizationId === organizationId &&
        m.status === 'active' &&
        Date.parse(m.validFrom) <= now &&
        (m.validTo === null || Date.parse(m.validTo) > now);
      if (valid) roles.add(m.role);
    }
    return { user, roles };
  }

  private async principal(repo: ClinicalRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    return this.principalFor(repo, await this.activeUser(repo, ctx), organizationId);
  }

  private authorize(p: Principal, perm: Permission): void {
    if (!PERMISSIONS[perm].some((r) => p.roles.has(r))) {
      throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
    }
  }

  private requireResponsiblePractitioner(e: Encounter, p: Principal): void {
    if (e.practitionerUserId !== p.user.userId) {
      throw new ClinicalError('FORBIDDEN', 'Only the responsible practitioner may perform this action');
    }
  }

  private async loadOpenEncounter(
    repo: ClinicalRepository,
    ctx: TenantContext,
    id: EncounterId,
    perm: Permission,
  ): Promise<{ encounter: Encounter; principal: Principal }> {
    const encounter = await repo.findEncounter(id);
    if (!encounter) throw new ClinicalError('NOT_FOUND', 'Encounter not found');
    assertSameTenant(encounter, ctx);
    assertOrganizationAllowed(encounter.organizationId, ctx);
    const principal = await this.principal(repo, ctx, encounter.organizationId);
    this.authorize(principal, perm);
    if (encounter.status !== 'in_progress') {
      throw new ClinicalError('INVALID_STATE', `Encounter is not in progress (status=${encounter.status})`);
    }
    return { encounter, principal };
  }

  private event(
    ctx: TenantContext,
    meta: AuditMeta,
    outcome: NewAuditEvent['outcome'],
    user: User | null,
    payload: Record<string, unknown>,
  ): NewAuditEvent {
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

  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: ClinicalRepository) => Promise<T>): Promise<T> {
    try {
      return await this.uow.run(ctx, fn);
    } catch (e) {
      await this.auditFailure(ctx, meta, e);
      throw e;
    }
  }

  private async auditFailure(ctx: TenantContext, meta: AuditMeta, e: unknown): Promise<void> {
    let code = 'INTERNAL';
    let outcome: NewAuditEvent['outcome'] = 'failure';
    if (e instanceof ClinicalError) {
      code = e.code;
      if (e.code === 'FORBIDDEN') outcome = 'denied';
    } else if (e instanceof TenantIsolationError) {
      code = e.code;
      outcome = 'denied';
    } else if (e instanceof VersionConflictError) {
      code = 'VERSION_CONFLICT';
    }
    try {
      await this.audit.record(this.event(ctx, meta, outcome, null, { code }));
    } catch {
      /* audit lỗi không được thay đổi kết quả từ chối */
    }
  }
}

// ===========================================================================
// PostgreSQL adapter
// ===========================================================================
const UNIQUE_REASONS: Readonly<Record<string, string>> = {
  patients_org_mrn_uk: 'MRN_TAKEN',
  patients_person_org_uk: 'PERSON_ALREADY_REGISTERED',
  patients_pkey: 'ID_COLLISION',
  conditions_encounter_code_uk: 'DUPLICATE_CONDITION',
};

function translatePgError(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err && typeof err === 'object') {
    if (err.code === '23505') {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: UNIQUE_REASONS[err.constraint ?? ''] ?? 'UNIQUE_VIOLATION' });
    }
    if (err.code === '55000') throw new ClinicalError('INVALID_STATE', 'Operation not allowed in current state');
    if (err.code === '42501') throw new ClinicalError('FORBIDDEN', 'Operation rejected by data-layer policy');
  }
  throw e;
}

export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
export const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
export const num = (v: unknown): number => Number(v);

export const PERSON_COLS =
  'person_id, tenant_id, given_name, family_name, birth_date::text AS birth_date, sex, phone, email, status, merged_into_person_id, created_at, updated_at, version';
export const PATIENT_COLS = 'patient_id, tenant_id, person_id, organization_id, mrn, status, registered_at, created_at, updated_at, version';
export const USER_COLS =
  'user_id, tenant_id, external_subject, email, display_name, person_id, status, last_login_at, created_at, updated_at, version';
export const MEMBERSHIP_COLS =
  'membership_id, tenant_id, user_id, organization_id, role, status, valid_from, valid_to, created_at, updated_at, version';
const ENCOUNTER_COLS =
  'encounter_id, tenant_id, patient_id, organization_id, practitioner_user_id, status, encounter_class, reason_text, period_start, period_end, created_at, updated_at, version';
const CONDITION_COLS =
  'condition_id, tenant_id, patient_id, encounter_id, category, code_system, code, display, clinical_status, verification_status, onset_at, abated_at, recorded_by_user_id, recorded_at, created_at, updated_at, version';
const OBSERVATION_COLS =
  'observation_id, tenant_id, patient_id, encounter_id, status, code_system, code, display, value_numeric, value_unit, value_ucum_code, value_string, effective_at, supersedes_observation_id, recorded_by_user_id, recorded_at, created_at, updated_at, version';

export const IDENTIFIER_COLS =
  'identifier_id, tenant_id, person_id, patient_id, type, system, value, status, period_start::text AS period_start, period_end::text AS period_end, created_at, updated_at, version';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const mapPerson = (r: any): Person => ({
  tenantId: r.tenant_id, personId: r.person_id, givenName: r.given_name, familyName: r.family_name,
  birthDate: r.birth_date ?? null, sex: r.sex, phone: r.phone, email: r.email, status: r.status,
  mergedIntoPersonId: r.merged_into_person_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
export const mapPatient = (r: any): Patient => ({
  tenantId: r.tenant_id, patientId: r.patient_id, personId: r.person_id, organizationId: r.organization_id,
  mrn: r.mrn, status: r.status, registeredAt: iso(r.registered_at),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
export const mapUser = (r: any): User => ({
  tenantId: r.tenant_id, userId: r.user_id, externalSubject: r.external_subject, email: r.email,
  displayName: r.display_name, personId: r.person_id, status: r.status, lastLoginAt: isoOrNull(r.last_login_at),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
export const mapMembership = (r: any): Membership => ({
  tenantId: r.tenant_id, membershipId: r.membership_id, userId: r.user_id, organizationId: r.organization_id,
  role: r.role, status: r.status, validFrom: iso(r.valid_from), validTo: isoOrNull(r.valid_to),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
const mapEncounter = (r: any): Encounter => ({
  tenantId: r.tenant_id, encounterId: r.encounter_id, patientId: r.patient_id, organizationId: r.organization_id,
  practitionerUserId: r.practitioner_user_id, status: r.status, encounterClass: r.encounter_class,
  reasonText: r.reason_text, periodStart: iso(r.period_start), periodEnd: isoOrNull(r.period_end),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
const mapCondition = (r: any): Condition => ({
  tenantId: r.tenant_id, conditionId: r.condition_id, patientId: r.patient_id, encounterId: r.encounter_id,
  category: r.category, code: { system: r.code_system, code: r.code, display: r.display },
  clinicalStatus: r.clinical_status, verificationStatus: r.verification_status,
  onsetAt: isoOrNull(r.onset_at), abatedAt: isoOrNull(r.abated_at),
  recordedByUserId: r.recorded_by_user_id, recordedAt: iso(r.recorded_at),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
const mapObservation = (r: any): Observation => ({
  tenantId: r.tenant_id, observationId: r.observation_id, patientId: r.patient_id, encounterId: r.encounter_id,
  status: r.status, code: { system: r.code_system, code: r.code, display: r.display },
  value:
    r.value_numeric !== null && r.value_numeric !== undefined
      ? { kind: 'quantity', value: num(r.value_numeric), unit: r.value_unit, ucumCode: r.value_ucum_code ?? null }
      : { kind: 'string', value: r.value_string },
  effectiveAt: iso(r.effective_at), supersedesObservationId: r.supersedes_observation_id,
  recordedByUserId: r.recorded_by_user_id, recordedAt: iso(r.recorded_at),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
export const mapIdentifier = (r: any): Identifier => ({
  tenantId: r.tenant_id, identifierId: r.identifier_id, personId: r.person_id, patientId: r.patient_id ?? null,
  type: r.type, system: r.system, value: r.value, status: r.status,
  periodStart: r.period_start ?? null, periodEnd: r.period_end ?? null,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgClinicalRepository implements ClinicalRepository {
  constructor(private readonly db: TenantScopedDb) {}

  private get t(): string {
    return this.db.tenantId;
  }

  async findPerson(personId: PersonId): Promise<Person | null> {
    const r = await this.db.query(`SELECT ${PERSON_COLS} FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [this.t, personId]);
    return r.rows[0] ? mapPerson(r.rows[0]) : null;
  }

  async findPatient(patientId: PatientId): Promise<Patient | null> {
    const r = await this.db.query(`SELECT ${PATIENT_COLS} FROM patient.patients WHERE tenant_id = $1 AND patient_id = $2`, [this.t, patientId]);
    return r.rows[0] ? mapPatient(r.rows[0]) : null;
  }

  async insertPatient(p: Patient): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO patient.patients (patient_id, tenant_id, person_id, organization_id, mrn, status, registered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [p.patientId, p.tenantId, p.personId, p.organizationId, p.mrn, p.status, p.registeredAt],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async findUserBySubject(subject: string): Promise<User | null> {
    const r = await this.db.query(`SELECT ${USER_COLS} FROM iam.users WHERE tenant_id = $1 AND external_subject = $2`, [this.t, subject]);
    return r.rows[0] ? mapUser(r.rows[0]) : null;
  }

  async listMemberships(userId: UserId): Promise<Membership[]> {
    const r = await this.db.query(`SELECT ${MEMBERSHIP_COLS} FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2`, [this.t, userId]);
    return r.rows.map(mapMembership);
  }

  async listIdentifiers(personId: PersonId): Promise<Identifier[]> {
    const r = await this.db.query(
      `SELECT ${IDENTIFIER_COLS} FROM patient.identifiers WHERE tenant_id = $1 AND person_id = $2 ORDER BY created_at, identifier_id`,
      [this.t, personId],
    );
    return r.rows.map(mapIdentifier);
  }

  async insertEncounter(e: Encounter): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.encounters
           (encounter_id, tenant_id, patient_id, organization_id, practitioner_user_id, status, encounter_class, reason_text, period_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [e.encounterId, e.tenantId, e.patientId, e.organizationId, e.practitionerUserId, e.status, e.encounterClass, e.reasonText, e.periodStart],
      );
    } catch (err) {
      translatePgError(err);
    }
  }

  async findEncounter(id: EncounterId): Promise<Encounter | null> {
    const r = await this.db.query(`SELECT ${ENCOUNTER_COLS} FROM clinical.encounters WHERE tenant_id = $1 AND encounter_id = $2`, [this.t, id]);
    return r.rows[0] ? mapEncounter(r.rows[0]) : null;
  }

  async updateEncounter(next: Encounter, expectedVersion: number): Promise<Encounter | null> {
    try {
      const r = await this.db.query(
        `UPDATE clinical.encounters SET status = $1, period_end = $2
          WHERE tenant_id = $3 AND encounter_id = $4 AND version = $5
          RETURNING ${ENCOUNTER_COLS}`,
        [next.status, next.periodEnd, this.t, next.encounterId, expectedVersion],
      );
      return r.rows[0] ? mapEncounter(r.rows[0]) : null;
    } catch (err) {
      return translatePgError(err);
    }
  }

  async insertCondition(c: Condition): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.conditions
           (condition_id, tenant_id, patient_id, encounter_id, category, code_system, code, display,
            clinical_status, verification_status, onset_at, abated_at, recorded_by_user_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [c.conditionId, c.tenantId, c.patientId, c.encounterId, c.category, c.code.system, c.code.code, c.code.display,
         c.clinicalStatus, c.verificationStatus, c.onsetAt, c.abatedAt, c.recordedByUserId, c.recordedAt],
      );
    } catch (err) {
      translatePgError(err);
    }
  }

  async listConditions(encounterId: EncounterId): Promise<Condition[]> {
    const r = await this.db.query(
      `SELECT ${CONDITION_COLS} FROM clinical.conditions WHERE tenant_id = $1 AND encounter_id = $2 ORDER BY recorded_at, condition_id`,
      [this.t, encounterId],
    );
    return r.rows.map(mapCondition);
  }

  async insertObservation(o: Observation): Promise<void> {
    const q = o.value.kind === 'quantity';
    try {
      await this.db.query(
        `INSERT INTO clinical.observations
           (observation_id, tenant_id, patient_id, encounter_id, status, code_system, code, display,
            value_numeric, value_unit, value_ucum_code, value_string, effective_at, supersedes_observation_id,
            recorded_by_user_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [o.observationId, o.tenantId, o.patientId, o.encounterId, o.status, o.code.system, o.code.code, o.code.display,
         q && o.value.kind === 'quantity' ? o.value.value : null,
         q && o.value.kind === 'quantity' ? o.value.unit : null,
         q && o.value.kind === 'quantity' ? o.value.ucumCode : null,
         o.value.kind === 'string' ? o.value.value : null,
         o.effectiveAt, o.supersedesObservationId, o.recordedByUserId, o.recordedAt],
      );
    } catch (err) {
      translatePgError(err);
    }
  }

  async listObservations(encounterId: EncounterId): Promise<Observation[]> {
    const r = await this.db.query(
      `SELECT ${OBSERVATION_COLS} FROM clinical.observations WHERE tenant_id = $1 AND encounter_id = $2 ORDER BY effective_at, observation_id`,
      [this.t, encounterId],
    );
    return r.rows.map(mapObservation);
  }

  async enqueueOutbox(tenantId: TenantContext['tenantId'], ev: OutboxDraft): Promise<void> {
    await this.db.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [tenantId, ev.aggregateType, ev.aggregateId, ev.eventType, JSON.stringify(ev.payload)],
    );
  }

  async appendAudit(ev: NewAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO platform.audit_events
         (tenant_id, actor_type, actor_id, organization_id, action, resource_type, resource_id,
          person_id, patient_id, outcome, correlation_id, source_ip, user_agent, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [ev.tenantId, ev.actor.type, ev.actor.id, ev.organizationId, ev.action, ev.resourceType, ev.resourceId,
       ev.personId, ev.patientId, ev.outcome, ev.correlationId, ev.sourceIp, ev.userAgent, JSON.stringify(ev.payload)],
    );
  }
}

export class PgClinicalUnitOfWork implements ClinicalUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  run<T>(ctx: TenantContext, fn: (repo: ClinicalRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        // Provenance: trigger snapshot_history đọc app.user_id.
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgClinicalRepository(db));
      },
      ctx,
    );
  }
}

export { isUuid };
