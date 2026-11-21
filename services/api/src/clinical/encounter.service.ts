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
 *     - Access policy (migration 007) gắn trên membership chỉ THU HẸP các quyền trên: điều kiện theo đợt khám / mã,
 *       che trường khi đọc, khoá trường khi ghi (packages/security/src/access-policy.ts).
 *  4. Audit: thành công ghi trong cùng transaction (atomic); từ chối/lỗi ghi qua AuditSink ngoài transaction.
 *     Payload audit chỉ chứa ID/metadata, không chứa PHI.
 */
import { randomUUID } from 'node:crypto';

import { LEGACY_MRN_RE, MrnError, normalizeMrnQuery, resolveMrn } from '../registry/mrn';
import { TenantPii } from '../../../../packages/security/src/pii';

import {
  asPatientId,
  isUuid,
  type AccessPolicyId,
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
import { nameKey as buildNameKey, type PatientSearchInput } from '../../../../packages/domain/src/person-registry';
import {
  ACCESS_POLICY_CATALOG,
  buildGrants,
  decideAccess,
  type AccessDecision,
  type AccessFacts,
  type AccessGrant,
  type AccessPolicy,
  type PolicyAction,
  validateAccessRules,
} from '../../../../packages/security/src/access-policy';
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
export interface PatientSearchQuery {
  readonly organizationId: OrganizationId;
  readonly mrn: string | null;
  /** Khoá tên đã chuẩn hoá (đi cùng birthDate). */
  readonly nameKey: string | null;
  readonly birthDate: string | null;
  readonly identifier: { readonly system: string; readonly values: readonly string[] } | null;
  readonly limit: number;
}

export interface ClinicalRepository {
  findPerson(personId: PersonId): Promise<Person | null>;
  findPatient(patientId: PatientId): Promise<Patient | null>;
  listIdentifiers(personId: PersonId): Promise<Identifier[]>;
  /** Tìm patient TRONG một organization; mọi điều kiện cho trước đều phải khớp (AND). Sắp theo registered_at, patient_id. */
  searchPatients(q: PatientSearchQuery): Promise<Patient[]>;
  /** Ném ClinicalError('CONFLICT', ..., { reason }) khi vi phạm unique. */
  insertPatient(patient: Patient): Promise<void>;
  /** HCOS-F13: MRN cho hồ sơ mới (tự sinh hoặc mã cũ khi cơ sở cho phép). */
  resolveMrn(organizationId: OrganizationId, raw: string | null | undefined, at: Date): Promise<{ mrn: string; generated: boolean }>;
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  /** Tải các policy theo id (trong tenant hiện tại). Id không tìm thấy thì không có trong kết quả. */
  findAccessPolicies(ids: readonly AccessPolicyId[]): Promise<AccessPolicy[]>;
  insertEncounter(e: Encounter): Promise<void>;
  findEncounter(id: EncounterId): Promise<Encounter | null>;
  /** Đợt khám của một patient, mới nhất trước. */
  listEncountersByPatient(patientId: PatientId, limit: number): Promise<Encounter[]>;
  /** Đợt khám đang mở (in_progress) của một organization, cũ nhất trước, kèm MRN/tên bệnh nhân và tên bác sĩ phụ trách. */
  listOpenEncounterSummaries(organizationId: OrganizationId, limit: number): Promise<OpenEncounterRow[]>;
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
  /** Mỗi membership hợp lệ tại organization = một con đường có quyền (kèm policy nếu có). */
  readonly grants: readonly AccessGrant[];
}

type AllowedDecision = Extract<AccessDecision, { allowed: true }>;

/** Phần dữ kiện mà service bổ sung (người gọi và encounter do service tự điền). */
type ExtraFacts = Omit<AccessFacts, 'callerUserId' | 'encounter'>;

/** Kết quả đọc có thể bị che bớt theo policy; `redacted` liệt kê trường đã che (rỗng = đầy đủ). */
export interface Redaction {
  readonly redacted?: readonly string[];
}

interface AuditMeta {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly patientId?: PatientId;
  readonly organizationId?: OrganizationId;
}

export interface OpenEncounterRow {
  readonly encounter: Encounter;
  readonly mrn: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly practitionerName: string | null;
}

/** Một dòng trong danh sách đang khám (worklist). Không chứa định danh / liên lạc của bệnh nhân. */
export interface WorklistItem {
  readonly encounterId: EncounterId;
  readonly patientId: PatientId;
  readonly mrn: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly encounterClass: Encounter['encounterClass'];
  readonly periodStart: string;
  /** null khi không có hoặc bị policy che (xem reasonRedacted). */
  readonly reasonText: string | null;
  readonly reasonRedacted: boolean;
  readonly practitionerUserId: UserId;
  readonly practitionerName: string | null;
}

const WORKLIST_LIMIT = 200;

export interface EncounterChart extends Redaction {
  readonly encounter: Encounter;
  readonly conditions: readonly Condition[];
  readonly observations: readonly Observation[];
}

export interface PatientView extends Redaction {
  readonly person: Person;
  readonly patient: Patient;
  readonly identifiers: Identifier[];
}

export interface RegisterPatientInput {
  readonly personId: PersonId;
  readonly organizationId: OrganizationId;
  /** Bỏ trống => CSDL cấp mã tự sinh (HCOS-F13); có giá trị => mã cũ, chỉ khi cơ sở cho phép. */
  readonly mrn?: string | null;
}

/** MrnError (module mrn.ts) => ClinicalError. */
async function mrnCall<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MrnError) throw new ClinicalError(e.kind, e.message, { reason: e.reason });
    throw e;
  }
}

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
      if (input.mrn !== undefined && input.mrn !== null && input.mrn.trim() !== '' && !LEGACY_MRN_RE.test(input.mrn.trim())) {
        throw new ClinicalError('VALIDATION', 'Invalid MRN format');
      }
      assertOrganizationAllowed(input.organizationId, ctx);
      const principal = await this.principal(repo, ctx, input.organizationId);
      const decision = this.decide(principal, 'patient:register', {});

      const person = await repo.findPerson(input.personId);
      if (!person) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(person, ctx);
      if (person.status !== 'active') {
        throw new ClinicalError('INVALID_STATE', 'Person is not active (merged/deceased/inactive)');
      }

      const now = this.now();
      const assigned = await mrnCall(() => repo.resolveMrn(input.organizationId, input.mrn, new Date(now)));
      const patient: Patient = {
        tenantId: ctx.tenantId,
        patientId: asPatientId(this.newId()),
        personId: person.personId,
        organizationId: input.organizationId,
        mrn: assigned.mrn,
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
          ...policyAudit(decision),
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
      const decision = this.decide(principal, 'encounter:create', { encounterClass: input.encounterClass });
      assertWritable(decision, 'periodStart', input.periodStart !== undefined);

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
        this.event(ctx, { ...meta, resourceId: encounter.encounterId }, 'success', principal.user, policyAudit(decision)),
      );
      return encounter;
    });
  }

  async addCondition(input: NewConditionInput, ctx: TenantContext = requireTenantContext()): Promise<Condition> {
    const meta: AuditMeta = { action: 'condition.create', resourceType: 'Condition', resourceId: undefined };
    return this.tx(ctx, meta, async (repo) => {
      this.validateCoded(input.code, 'code');
      const onset = input.onsetAt ? this.parseTime(input.onsetAt, 'onsetAt') : null;

      const { encounter, principal, decision } = await this.loadOpenEncounter(repo, ctx, input.encounterId, 'condition:write', {
        code: input.code,
      });
      this.assertSubject(encounter, input.expectedPatientId);
      this.requireResponsiblePractitioner(encounter, principal);
      assertWritable(decision, 'category', input.category !== undefined && input.category !== 'encounter_diagnosis');
      assertWritable(decision, 'clinicalStatus', input.clinicalStatus !== undefined && input.clinicalStatus !== 'active');
      assertWritable(decision, 'verificationStatus', input.verificationStatus !== undefined && input.verificationStatus !== 'confirmed');
      assertWritable(decision, 'onsetAt', input.onsetAt !== undefined && input.onsetAt !== null);

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
          { encounterId: encounter.encounterId, codeSystem: input.code.system, ...policyAudit(decision) },
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

      const { encounter, principal, decision } = await this.loadOpenEncounter(repo, ctx, input.encounterId, 'observation:write', {
        code: input.code,
      });
      this.assertSubject(encounter, input.expectedPatientId);
      assertWritable(decision, 'status', input.status !== undefined && input.status !== 'final');
      assertWritable(decision, 'effectiveAt', input.effectiveAt !== undefined);
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
          { encounterId: encounter.encounterId, codeSystem: input.code.system, ...policyAudit(decision) },
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
      const { encounter, principal, decision } = await this.loadOpenEncounter(repo, ctx, encounterId, 'encounter:close', {});
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
          { fromVersion: expectedVersion, toVersion: saved.version, ...policyAudit(decision) },
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
      let decision: AllowedDecision | null = null;
      if (!isSelf) {
        assertOrganizationAllowed(encounter.organizationId, ctx);
        const principal = await this.principalFor(repo, user, encounter.organizationId);
        decision = this.decide(principal, 'encounter:read', {}, encounter);
      }
      const hidden = decision?.hiddenFields ?? new Set<string>();

      const [allConditions, allObservations] = await Promise.all([
        hidden.has('conditions') ? Promise.resolve([] as Condition[]) : repo.listConditions(encounterId),
        hidden.has('observations') ? Promise.resolve([] as Observation[]) : repo.listObservations(encounterId),
      ]);
      for (const c of allConditions) assertSameTenant(c, ctx);
      for (const o of allObservations) assertSameTenant(o, ctx);
      const redacted = [...hidden].sort();
      const visibleEncounter: Encounter = hidden.has('encounter.reasonText') ? { ...encounter, reasonText: null } : encounter;

      await repo.appendAudit(
        this.event(
          ctx,
          { ...meta, patientId: encounter.patientId, organizationId: encounter.organizationId },
          'success',
          user,
          { self: isSelf, ...(decision ? policyAudit(decision) : {}) },
        ),
      );
      return { encounter: visibleEncounter, conditions: allConditions, observations: allObservations, redacted };
    });
  }

  /**
   * Các đợt khám của một bệnh nhân (mới nhất trước, tối đa 50). Cần quyền đọc hồ sơ tại organization của patient;
   * từng đợt khám còn phải qua `encounter:read` — đợt nào policy không cho xem thì bị LỌC BỎ (không lộ là có tồn tại),
   * `filtered` cho biết số bị lọc. Lý do khám bị che nếu policy che.
   */
  async listEncountersForPatient(
    patientId: PatientId,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ encounters: Encounter[]; filtered: number; redactedEncounterIds: string[] }> {
    const meta: AuditMeta = { action: 'patient.encounters.list', resourceType: 'Encounter', patientId };
    return this.tx(ctx, meta, async (repo) => {
      const patient = await repo.findPatient(patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);
      const user = await this.activeUser(repo, ctx);
      const isSelf = user.personId !== null && user.personId === patient.personId;
      let principal: Principal | null = null;
      if (!isSelf) {
        assertOrganizationAllowed(patient.organizationId, ctx);
        principal = await this.principalFor(repo, user, patient.organizationId);
        this.decide(principal, 'patient:read', {});
      }
      const all = await repo.listEncountersByPatient(patientId, 50);
      const out: Encounter[] = [];
      const redacted: string[] = [];
      let filtered = 0;
      for (const e of all) {
        assertSameTenant(e, ctx);
        if (e.patientId !== patientId) continue;
        if (!principal) {
          out.push(e);
          continue;
        }
        let d: AllowedDecision;
        try {
          d = this.decide(principal, 'encounter:read', {}, e);
        } catch (err) {
          if (err instanceof ClinicalError && err.code === 'FORBIDDEN') {
            filtered++;
            continue;
          }
          throw err;
        }
        if (d.hiddenFields.has('encounter.reasonText')) {
          redacted.push(e.encounterId);
          out.push({ ...e, reasonText: null });
        } else out.push(e);
      }
      await repo.appendAudit(
        this.event(ctx, { ...meta, organizationId: patient.organizationId }, 'success', user, { self: isSelf, count: out.length, filtered }),
      );
      return { encounters: out, filtered, redactedEncounterIds: redacted };
    });
  }

  /**
   * Danh sách đang khám của một organization (tối đa 200 đợt in_progress, cũ nhất trước) để bác sĩ / điều dưỡng bắt đầu ca
   * mà không phải nhớ MRN. Cần quyền đọc hồ sơ tại organization; từng đợt khám còn phải qua `encounter:read`
   * (đợt nào policy không cho xem thì bị lọc bỏ, `filtered` cho biết số bị lọc). Lý do khám bị che nếu policy che.
   * Chỉ trả MRN + họ tên (không trả CCCD, ngày sinh, liên lạc).
   */
  async listOpenEncounters(
    organizationId: string,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<{ items: WorklistItem[]; filtered: number }> {
    const meta: AuditMeta = { action: 'encounter.worklist', resourceType: 'Encounter' };
    return this.tx(ctx, meta, async (repo) => {
      if (!isUuid(organizationId)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
      const org = organizationId.toLowerCase() as OrganizationId;
      assertOrganizationAllowed(org, ctx);
      const principal = await this.principal(repo, ctx, org);
      const decision = this.decide(principal, 'patient:read', {});
      const rows = await repo.listOpenEncounterSummaries(org, WORKLIST_LIMIT);
      const items: WorklistItem[] = [];
      let filtered = 0;
      for (const r of rows) {
        const e = r.encounter;
        assertSameTenant(e, ctx);
        if (e.organizationId !== org || e.status !== 'in_progress') continue; // phòng thủ chiều sâu
        let d: AllowedDecision;
        try {
          d = this.decide(principal, 'encounter:read', {}, e);
        } catch (err) {
          if (err instanceof ClinicalError && err.code === 'FORBIDDEN') {
            filtered++;
            continue;
          }
          throw err;
        }
        const hideReason = d.hiddenFields.has('encounter.reasonText');
        items.push({
          encounterId: e.encounterId,
          patientId: e.patientId,
          mrn: r.mrn,
          familyName: r.familyName,
          givenName: r.givenName,
          encounterClass: e.encounterClass,
          periodStart: e.periodStart,
          reasonText: hideReason ? null : e.reasonText,
          reasonRedacted: hideReason,
          practitionerUserId: e.practitionerUserId,
          practitionerName: r.practitionerName,
        });
      }
      await repo.appendAudit(
        this.event(ctx, { ...meta, organizationId: org }, 'success', principal.user, { count: items.length, filtered, ...policyAudit(decision) }),
      );
      return { items, filtered };
    });
  }

  /** Đọc hồ sơ bệnh nhân (person + patient + identifiers) với kiểm soát truy cập như bệnh án. */
  async getPatient(
    patientId: PatientId,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<PatientView> {
    const meta: AuditMeta = { action: 'patient.read', resourceType: 'Patient', resourceId: patientId, patientId };
    return this.tx(ctx, meta, async (repo) => {
      const patient = await repo.findPatient(patientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);

      const user = await this.activeUser(repo, ctx);
      const isSelf = user.personId !== null && user.personId === patient.personId;
      let decision: AllowedDecision | null = null;
      if (!isSelf) {
        assertOrganizationAllowed(patient.organizationId, ctx);
        decision = this.decide(await this.principalFor(repo, user, patient.organizationId), 'patient:read', {});
      }

      const person = await repo.findPerson(patient.personId);
      if (!person) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(person, ctx);
      const identifiers = await repo.listIdentifiers(person.personId);
      for (const i of identifiers) assertSameTenant(i, ctx);

      await repo.appendAudit(
        this.event(ctx, { ...meta, organizationId: patient.organizationId }, 'success', user, {
          self: isSelf,
          ...(decision ? policyAudit(decision) : {}),
        }),
      );
      return redactPatient({ person, patient, identifiers }, decision?.hiddenFields ?? new Set());
    });
  }

  /**
   * Tìm bệnh nhân trong MỘT organization (bắt buộc), cần quyền đọc bệnh án tại organization đó.
   * Chống dò quét: phải có tiêu chí chọn lọc — `identifier` (system|value), `mrn`, hoặc `tên + ngày sinh` — không có "liệt kê tất cả";
   * tối đa 20 kết quả. Tìm theo tên dựa trên name_key (dòng legacy chưa có khoá sẽ không được tìm bằng tên).
   * Audit chỉ ghi LOẠI tiêu chí và số kết quả, không ghi giá trị tìm kiếm.
   */
  async searchPatients(
    input: PatientSearchInput,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<PatientView[]> {
    const meta: AuditMeta = { action: 'patient.search', resourceType: 'Patient', organizationId: input.organizationId };
    return this.tx(ctx, meta, async (repo) => {
      assertOrganizationAllowed(input.organizationId, ctx);
      const principal = await this.principal(repo, ctx, input.organizationId);
      const decision = this.decide(principal, 'patient:read', {});
      // Không cho tìm theo trường bị che: tìm theo CCCD/ngày sinh sẽ thành "máy xác nhận" giá trị bị che.
      if (input.identifier !== undefined && decision.hiddenFields.has('identifiers')) {
        throw new ClinicalError('FORBIDDEN', 'Search by identifier is not permitted', { reason: 'ACCESS_POLICY' });
      }
      if (input.birthDate !== undefined && decision.hiddenFields.has('person.birthDate')) {
        throw new ClinicalError('FORBIDDEN', 'Search by birthdate is not permitted', { reason: 'ACCESS_POLICY' });
      }

      const criteria: string[] = [];
      let mrn: string | null = null;
      if (input.mrn !== undefined) {
        const raw = input.mrn;
        mrn = await mrnCall(() => normalizeMrnQuery(raw));
        criteria.push('mrn');
      }
      let identifier: PatientSearchQuery['identifier'] = null;
      if (input.identifier !== undefined) {
        const system = input.identifier.system;
        const raw = input.identifier.value.trim();
        if (system.length < 3 || system.length > 200 || raw.length < 1 || raw.length > 128) {
          throw new ClinicalError('VALIDATION', 'identifier must be system|value');
        }
        const stripped = raw.replace(/[\s.-]/g, '');
        identifier = { system, values: [...new Set([raw, stripped, stripped.toUpperCase()])] };
        criteria.push('identifier');
      }
      let nameKeyValue: string | null = null;
      let birthDate: string | null = null;
      const hasName = input.givenName !== undefined || input.familyName !== undefined;
      if (hasName || input.birthDate !== undefined) {
        if (!input.givenName || !input.familyName || !input.birthDate) {
          throw new ClinicalError('VALIDATION', 'Name search requires given, family and birthdate together');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) throw new ClinicalError('VALIDATION', 'Invalid birthdate');
        nameKeyValue = buildNameKey(input.givenName, input.familyName);
        if (nameKeyValue === '') throw new ClinicalError('VALIDATION', 'Invalid name');
        birthDate = input.birthDate;
        criteria.push('name+birthdate');
      }
      if (criteria.length === 0) {
        throw new ClinicalError('VALIDATION', 'Search requires identifier, mrn, or given+family+birthdate');
      }
      const count = input.count ?? 20;
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new ClinicalError('VALIDATION', '_count must be between 1 and 20');

      const patients = await repo.searchPatients({ organizationId: input.organizationId, mrn, nameKey: nameKeyValue, birthDate, identifier, limit: count });
      const out: PatientView[] = [];
      for (const patient of patients) {
        assertSameTenant(patient, ctx);
        if (patient.organizationId !== input.organizationId) continue; // phòng thủ chiều sâu: repo lỗi không được trả org khác
        const person = await repo.findPerson(patient.personId);
        if (!person) continue;
        assertSameTenant(person, ctx);
        const identifiers = await repo.listIdentifiers(person.personId);
        for (const i of identifiers) assertSameTenant(i, ctx);
        out.push(redactPatient({ person, patient, identifiers }, decision.hiddenFields));
      }
      await repo.appendAudit(
        this.event(ctx, meta, 'success', principal.user, { criteria, resultCount: out.length, ...policyAudit(decision) }),
      );
      return out;
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
    const valid = memberships.filter(
      (m) =>
        m.organizationId === organizationId &&
        m.status === 'active' &&
        Date.parse(m.validFrom) <= now &&
        (m.validTo === null || Date.parse(m.validTo) > now),
    );
    const grants: AccessGrant[] = await buildGrants(valid, user.tenantId, (ids) => repo.findAccessPolicies(ids));
    return { user, roles: new Set(valid.map((m) => m.role)), grants };
  }

  private async principal(repo: ClinicalRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    return this.principalFor(repo, await this.activeUser(repo, ctx), organizationId);
  }

  /** Quyết định truy cập: vai trò (bảng PERMISSIONS) rồi access policy của từng membership. Từ chối => FORBIDDEN. */
  private decide(p: Principal, action: PolicyAction, extra: ExtraFacts, encounter?: Encounter): AllowedDecision {
    const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
    const facts: AccessFacts = {
      ...extra,
      callerUserId: p.user.userId,
      ...(encounter
        ? { encounter: { practitionerUserId: encounter.practitionerUserId, encounterClass: encounter.encounterClass, status: encounter.status } }
        : {}),
    };
    const d = decideAccess(p.grants, action, PERMISSIONS[perm], facts);
    if (!d.allowed) {
      if (d.reason === 'ROLE') throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
      throw new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
    }
    return d;
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
    action: PolicyAction,
    extra: ExtraFacts,
  ): Promise<{ encounter: Encounter; principal: Principal; decision: AllowedDecision }> {
    const encounter = await repo.findEncounter(id);
    if (!encounter) throw new ClinicalError('NOT_FOUND', 'Encounter not found');
    assertSameTenant(encounter, ctx);
    assertOrganizationAllowed(encounter.organizationId, ctx);
    const principal = await this.principal(repo, ctx, encounter.organizationId);
    const decision = this.decide(principal, action, extra, encounter);
    if (encounter.status !== 'in_progress') {
      throw new ClinicalError('INVALID_STATE', `Encounter is not in progress (status=${encounter.status})`);
    }
    return { encounter, principal, decision };
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
    const reason = e instanceof ClinicalError && typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
    try {
      await this.audit.record(this.event(ctx, meta, outcome, null, { code, ...(reason ? { reason } : {}) }));
    } catch {
      /* audit lỗi không được thay đổi kết quả từ chối */
    }
  }
}

// ---------------------------------------------------------------------------
// Access-policy helpers
// ---------------------------------------------------------------------------
/** Ghi lỗi nếu người gọi đặt giá trị khác mặc định cho một trường bị policy khoá. */
function assertWritable(d: AllowedDecision, field: string, provided: boolean): void {
  if (provided && d.readonlyFields.has(field)) {
    throw new ClinicalError('FORBIDDEN', `Field ${field} is read-only under the caller's access policy`, {
      reason: 'ACCESS_POLICY',
      field,
    });
  }
}

/** Metadata policy cho audit: id policy đã quyết định + trường bị che (không chứa PHI). */
function policyAudit(d: AllowedDecision): Record<string, unknown> {
  if (d.policyIds.length === 0) return {};
  return { accessPolicyIds: d.policyIds, ...(d.hiddenFields.size > 0 ? { redacted: [...d.hiddenFields].sort() } : {}) };
}

function redactPatient(v: { person: Person; patient: Patient; identifiers: Identifier[] }, hidden: ReadonlySet<string>): PatientView {
  if (hidden.size === 0) return { ...v, redacted: [] };
  const person: Person = {
    ...v.person,
    ...(hidden.has('person.phone') ? { phone: null } : {}),
    ...(hidden.has('person.email') ? { email: null } : {}),
    ...(hidden.has('person.birthDate') ? { birthDate: null } : {}),
  };
  return {
    person,
    patient: v.patient,
    identifiers: hidden.has('identifiers') ? [] : v.identifiers,
    redacted: [...hidden].sort(),
  };
}

// ===========================================================================
// PostgreSQL adapter
// ===========================================================================
const UNIQUE_REASONS: Readonly<Record<string, string>> = {
  patients_org_mrn_uk: 'MRN_TAKEN',
  patients_person_org_uk: 'PERSON_ALREADY_REGISTERED',
  patients_pkey: 'ID_COLLISION',
  conditions_encounter_code_uk: 'DUPLICATE_CONDITION',
  prescription_items_medication_uk: 'DUPLICATE_MEDICATION',
  queue_tickets_one_active_uk: 'PATIENT_ALREADY_QUEUED',
  service_points_code_uk: 'SERVICE_POINT_CODE_TAKEN',
  bookings_one_per_phone_day_uk: 'PHONE_ALREADY_BOOKED',
  bookings_one_per_phone_bidx_day_uk: 'PHONE_ALREADY_BOOKED',
  bookings_code_uk: 'CODE_COLLISION',
  booking_portals_slug_uk: 'SLUG_TAKEN',
  booking_portals_org_uk: 'PORTAL_EXISTS',
  price_items_code_uk: 'PRICE_CODE_TAKEN',
  shifts_one_open_per_user_uk: 'SHIFT_ALREADY_OPEN',
  cases_one_open_per_patient_uk: 'CASE_ALREADY_OPEN',
  handover_desks_code_uk: 'DESK_CODE_TAKEN',
  handover_tickets_one_called_per_desk_uk: 'DESK_BUSY',
};

export function translatePgError(e: unknown): never {
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

// HCOS-F16: SĐT / email đọc ra là dạng che; dòng chưa backfill (còn bản rõ) được che bằng hàm SQL cùng quy tắc.
export const PERSON_COLS =
  'person_id, tenant_id, given_name, family_name, birth_date::text AS birth_date, sex, ' +
  'COALESCE(phone_hint, keyvault.mask_phone(phone)) AS phone, COALESCE(email_hint, keyvault.mask_email(email)) AS email, phone_bidx, ' +
  'status, merged_into_person_id, created_at, updated_at, version';
export const PATIENT_COLS = 'patient_id, tenant_id, person_id, organization_id, mrn, status, registered_at, created_at, updated_at, version';
export const USER_COLS =
  'user_id, tenant_id, external_subject, email, display_name, person_id, status, last_login_at, created_at, updated_at, version';
export const MEMBERSHIP_COLS =
  'membership_id, tenant_id, user_id, organization_id, role, status, valid_from, valid_to, access_policy_id, created_at, updated_at, version';
const ENCOUNTER_COLS =
  'encounter_id, tenant_id, patient_id, organization_id, practitioner_user_id, status, encounter_class, reason_text, period_start, period_end, created_at, updated_at, version';
const CONDITION_COLS =
  'condition_id, tenant_id, patient_id, encounter_id, category, code_system, code, display, clinical_status, verification_status, onset_at, abated_at, recorded_by_user_id, recorded_at, created_at, updated_at, version';
const OBSERVATION_COLS =
  'observation_id, tenant_id, patient_id, encounter_id, status, code_system, code, display, value_numeric, value_unit, value_ucum_code, value_string, effective_at, supersedes_observation_id, recorded_by_user_id, recorded_at, created_at, updated_at, version';

export const IDENTIFIER_COLS =
  'identifier_id, tenant_id, person_id, patient_id, type, system, COALESCE(value_hint, keyvault.mask_identifier(value)) AS value, value_bidx, ' +
  'status, period_start::text AS period_start, period_end::text AS period_end, created_at, updated_at, version';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const mapPerson = (r: any): Person => ({
  tenantId: r.tenant_id, personId: r.person_id, givenName: r.given_name, familyName: r.family_name,
  birthDate: r.birth_date ?? null, sex: r.sex, phone: r.phone ?? null, email: r.email ?? null, phoneIndex: r.phone_bidx ?? null, status: r.status,
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
  accessPolicyId: r.access_policy_id ?? null,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
export const ACCESS_POLICY_COLS =
  'policy_id, tenant_id, name, description, status, rules, created_by, created_at, updated_at, version';
/**
 * Luật đọc từ DB vẫn đi qua validateAccessRules: dòng bị sửa tay sai định dạng => policy 'unavailable' (từ chối),
 * không bao giờ là "không giới hạn".
 */
export const mapAccessPolicy = (r: any): AccessPolicy | null => {
  let rules;
  try {
    rules = validateAccessRules(typeof r.rules === 'string' ? JSON.parse(r.rules) : r.rules);
  } catch {
    return null;
  }
  return {
    tenantId: r.tenant_id, policyId: r.policy_id, name: r.name, description: r.description ?? null, status: r.status,
    rules, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
  };
};
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
  type: r.type, system: r.system, value: r.value, valueIndex: r.value_bidx ?? null, status: r.status,
  periodStart: r.period_start ?? null, periodEnd: r.period_end ?? null,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), version: num(r.version),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgClinicalRepository implements ClinicalRepository {
  private piiCodec: TenantPii | null = null;
  constructor(protected readonly db: TenantScopedDb) {}

  /** HCOS-F16: mã hoá / blind index của tenant hiện tại (khoá tải lười trong transaction). */
  protected get pii(): TenantPii {
    return (this.piiCodec ??= new TenantPii(this.db));
  }

  protected get t(): string {
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

  async searchPatients(q: PatientSearchQuery): Promise<Patient[]> {
    const r = await this.db.query(
      `SELECT ${PATIENT_COLS} FROM patient.patients
        WHERE tenant_id = $1 AND organization_id = $2
          AND ($3::text IS NULL OR mrn = $3::text)
          AND ($4::text IS NULL OR EXISTS (
                SELECT 1 FROM patient.persons p
                 WHERE p.tenant_id = patients.tenant_id AND p.person_id = patients.person_id
                   AND p.name_key = $4::text AND p.birth_date = $5::date))
          AND ($6::text IS NULL OR EXISTS (
                SELECT 1 FROM patient.identifiers i
                 WHERE i.tenant_id = patients.tenant_id AND i.person_id = patients.person_id
                   AND i.status = 'active' AND i.system = $6::text AND i.value_bidx = ANY($7::text[])))
        ORDER BY registered_at, patient_id
        LIMIT $8`,
      [
        this.t, q.organizationId, q.mrn, q.nameKey, q.birthDate,
        q.identifier ? q.identifier.system : null,
        q.identifier ? `{${(await Promise.all(q.identifier.values.map((v) => this.pii.index('identifier', v)))).join(',')}}` : null,
        q.limit,
      ],
    );
    return r.rows.map(mapPatient);
  }

  resolveMrn(organizationId: OrganizationId, raw: string | null | undefined, at: Date): Promise<{ mrn: string; generated: boolean }> {
    return resolveMrn(this.db, this.t, organizationId, raw, at);
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

  async findAccessPolicies(ids: readonly AccessPolicyId[]): Promise<AccessPolicy[]> {
    if (ids.length === 0) return [];
    const r = await this.db.query(
      `SELECT ${ACCESS_POLICY_COLS} FROM iam.access_policies WHERE tenant_id = $1 AND policy_id = ANY($2::uuid[])`,
      [this.t, `{${ids.join(',')}}`],
    );
    return r.rows.map(mapAccessPolicy).filter((p): p is AccessPolicy => p !== null);
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

  async listEncountersByPatient(patientId: PatientId, limit: number): Promise<Encounter[]> {
    const r = await this.db.query(
      `SELECT ${ENCOUNTER_COLS} FROM clinical.encounters WHERE tenant_id = $1 AND patient_id = $2
        ORDER BY period_start DESC, encounter_id LIMIT $3`,
      [this.t, patientId, limit],
    );
    return r.rows.map(mapEncounter);
  }

  async listOpenEncounterSummaries(organizationId: OrganizationId, limit: number): Promise<OpenEncounterRow[]> {
    const cols = ENCOUNTER_COLS.split(', ').map((c) => `e.${c}`).join(', ');
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${cols}, pt.mrn, ps.family_name, ps.given_name, u.display_name AS practitioner_name
         FROM clinical.encounters e
         JOIN patient.patients pt ON pt.tenant_id = e.tenant_id AND pt.patient_id = e.patient_id
         JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
         LEFT JOIN iam.users u ON u.tenant_id = e.tenant_id AND u.user_id = e.practitioner_user_id
        WHERE e.tenant_id = $1 AND e.organization_id = $2 AND e.status = 'in_progress'
        ORDER BY e.period_start, e.encounter_id LIMIT $3`,
      [this.t, organizationId, limit],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      encounter: mapEncounter(x),
      mrn: x['mrn'] as string,
      familyName: x['family_name'] as string,
      givenName: x['given_name'] as string,
      practitionerName: (x['practitioner_name'] as string | null) ?? null,
    }));
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
