/**
 * HCOS-P0-ENG-001 | Person Registry service
 *
 * Chức năng: tạo person (kèm định danh) có phát hiện trùng, thêm/ngừng định danh, tìm trùng, đọc person (theo dõi chuyển hướng
 * khi đã merge), và merge hai person trong cùng tenant (atomic, có lịch sử).
 *
 * Phân quyền (vai trò lấy từ iam.memberships còn hiệu lực, giới hạn trong org của token; tenant_admin/system không bị giới hạn org):
 *   person:create / person:identifier : clinic_staff, clinic_admin, doctor
 *   person:search                     : + pharmacist     (người dùng cũng được đọc chính person của mình)
 *   person:merge                      : clinic_admin, tenant_admin   (một thao tác thay đổi liên kết hồ sơ => chỉ quản trị đăng ký)
 * Audit: payload chỉ chứa ID/đếm/loại; KHÔNG chứa họ tên, ngày sinh, SĐT hay giá trị định danh.
 */
import { randomUUID } from 'node:crypto';

import {
  asPersonId,
  TenantIsolationError,
  VersionConflictError,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Identifier,
  type IdentifierId,
  type Membership,
  type NewAuditEvent,
  type Patient,
  type PatientId,
  type Person,
  type PersonId,
  type Role,
  type Sex,
  type TenantContext,
  type TenantId,
  type TenantScopedDb,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import {
  RegistryValidationError,
  cleanName,
  identifierKey,
  nameKey as buildNameKey,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  scoreMatch,
  validateBirthDate,
  type CreatePersonResult,
  type DuplicateCandidate,
  type DuplicateSearchInput,
  type MatchProfile,
  type MergePersonsInput,
  type MergeResult,
  type NewIdentifierInput,
  type NewPersonInput,
  type NormalizedIdentifier,
  type PersonMergeRecord,
} from '../../../../packages/domain/src/person-registry';
import {
  ClinicalError,
  IDENTIFIER_COLS,
  MEMBERSHIP_COLS,
  PATIENT_COLS,
  PERSON_COLS,
  USER_COLS,
  mapIdentifier,
  mapMembership,
  mapPatient,
  mapPerson,
  mapUser,
  type OutboxDraft,
} from '../clinical/encounter.service';
import {
  assertSameTenant,
  requireTenantContext,
  withTenantTransaction,
  type PgPoolLike,
} from '../../../../packages/security/src/tenant-context';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
export interface PersonKeys {
  readonly nameKey: string;
  readonly phoneKey: string | null;
}
export interface CandidateQuery {
  readonly birthDate: string | null;
  readonly phoneKey: string | null;
  readonly nameKey: string | null;
}
export interface IdentifierMatch {
  readonly personId: PersonId;
  readonly system: string;
  readonly value: string;
}
export interface SurvivorPatch {
  readonly birthDate: string | null;
  readonly sex: Sex | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly phoneKey: string | null;
}

/** Mọi method tự lọc theo tenant (và bị RLS bảo vệ) trong transaction hiện tại. */
export interface RegistryRepository {
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  findPerson(personId: PersonId): Promise<Person | null>;
  insertPerson(p: Person, keys: PersonKeys): Promise<void>;
  findCandidates(q: CandidateQuery): Promise<Person[]>;
  findIdentifierMatches(keys: ReadonlyArray<{ system: string; value: string }>): Promise<IdentifierMatch[]>;
  listIdentifiers(personId: PersonId): Promise<Identifier[]>;
  insertIdentifier(i: Identifier): Promise<void>;
  findIdentifier(id: string): Promise<Identifier | null>;
  updateIdentifierStatus(id: string, status: 'inactive' | 'entered_in_error', expectedVersion: number): Promise<Identifier | null>;
  listPatientsByPerson(personId: PersonId): Promise<Patient[]>;
  /** null nếu version không khớp / không còn active. */
  markPersonMerged(sourceId: PersonId, targetId: PersonId, expectedVersion: number): Promise<Person | null>;
  /** Luôn bump version (kiểm tra đồng thời) và chỉ điền các trường đang NULL. */
  patchSurvivor(targetId: PersonId, patch: SurvivorPatch, expectedVersion: number): Promise<Person | null>;
  movePatients(sourceId: PersonId, targetId: PersonId): Promise<PatientId[]>;
  moveIdentifier(id: string, toPersonId: PersonId, expectedVersion: number): Promise<boolean>;
  repointUsers(sourceId: PersonId, targetId: PersonId): Promise<UserId[]>;
  insertMergeRecord(r: PersonMergeRecord): Promise<void>;
  enqueueOutbox(tenantId: TenantId, ev: OutboxDraft): Promise<void>;
  appendAudit(ev: NewAuditEvent): Promise<void>;
}

export interface RegistryUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: RegistryRepository) => Promise<T>): Promise<T>;
}

export interface RegistryServiceDeps {
  readonly uow: RegistryUnitOfWork;
  readonly audit: AuditSink;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
type Permission = 'person:create' | 'person:identifier' | 'person:search' | 'person:merge';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'person:create': ['clinic_staff', 'clinic_admin', 'doctor'],
  'person:identifier': ['clinic_staff', 'clinic_admin', 'doctor'],
  'person:search': ['clinic_staff', 'clinic_admin', 'doctor', 'pharmacist'],
  'person:merge': ['clinic_admin', 'tenant_admin'],
};

interface Principal {
  readonly user: User;
  readonly roles: ReadonlySet<Role>;
}

interface AuditMeta {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly personId?: PersonId;
}

interface Draft {
  readonly givenName: string;
  readonly familyName: string;
  readonly nameKey: string;
  readonly birthDate: string | null;
  readonly sex: Sex | null;
  readonly phone: string | null;
  readonly phoneKey: string | null;
  readonly email: string | null;
  readonly identifiers: NormalizedIdentifier[];
}

const SEXES: readonly string[] = ['male', 'female', 'other', 'unknown'];
const MAX_IDENTIFIERS = 10;
const MAX_CANDIDATES = 20;

export type PersonView = {
  readonly person: Person;
  readonly identifiers: readonly Identifier[];
  /** Có giá trị khi ID yêu cầu là person đã bị merge và kết quả là person đích. */
  readonly redirectedFrom: PersonId | null;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class PersonRegistryService {
  private readonly uow: RegistryUnitOfWork;
  private readonly audit: AuditSink;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(deps: RegistryServiceDeps) {
    this.uow = deps.uow;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  // ---- Create ------------------------------------------------------------
  async createPerson(input: NewPersonInput, ctx: TenantContext = requireTenantContext()): Promise<CreatePersonResult> {
    const meta: AuditMeta = { action: 'person.create', resourceType: 'Person' };
    return this.tx(ctx, meta, async (repo) => {
      const principal = await this.principal(repo, ctx);
      this.authorize(principal, 'person:create');

      const draft = this.prepare(input, true);
      const override = this.parseOverride(input);

      const ranked = await this.rank(repo, draft, ctx);
      if (ranked.some((c) => c.level === 'definite')) {
        throw new ClinicalError('CONFLICT', 'An identifier already belongs to another person', { reason: 'IDENTIFIER_TAKEN' });
      }
      const blocking = ranked.filter((c) => c.level === 'probable');
      if (blocking.length > 0 && !override) {
        throw new ClinicalError('CONFLICT', 'Possible duplicate person', { reason: 'DUPLICATE_CANDIDATES', candidates: blocking });
      }

      const now = this.now();
      const person: Person = {
        tenantId: ctx.tenantId,
        personId: asPersonId(this.newId()),
        givenName: draft.givenName,
        familyName: draft.familyName,
        birthDate: draft.birthDate,
        sex: draft.sex,
        phone: draft.phone,
        email: draft.email,
        status: 'active',
        mergedIntoPersonId: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repo.insertPerson(person, { nameKey: draft.nameKey, phoneKey: draft.phoneKey });

      const identifiers: Identifier[] = [];
      for (const n of draft.identifiers) {
        const identifier = this.toIdentifier(ctx.tenantId, person.personId, n, now);
        await repo.insertIdentifier(identifier);
        identifiers.push(identifier);
      }

      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'person',
        aggregateId: person.personId,
        eventType: 'patient.person.created',
        payload: { personId: person.personId, identifierCount: identifiers.length },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: person.personId, personId: person.personId }, 'success', principal.user, {
          identifierCount: identifiers.length,
          overrideUsed: Boolean(override && blocking.length > 0),
          overrideReason: override && blocking.length > 0 ? override : undefined,
          possibleDuplicates: ranked.filter((c) => c.level === 'possible').length,
        }),
      );
      return { person, identifiers, possibleDuplicates: ranked.filter((c) => c.level === 'possible') };
    });
  }

  // ---- Duplicate search ----------------------------------------------------
  async findDuplicates(input: DuplicateSearchInput, ctx: TenantContext = requireTenantContext()): Promise<DuplicateCandidate[]> {
    const meta: AuditMeta = { action: 'person.dedupe.search', resourceType: 'Person' };
    return this.tx(ctx, meta, async (repo) => {
      const principal = await this.principal(repo, ctx);
      this.authorize(principal, 'person:search');

      const draft = this.prepare(
        {
          givenName: input.givenName ?? '',
          familyName: input.familyName ?? '',
          birthDate: input.birthDate ?? null,
          phone: input.phone ?? null,
          identifiers: input.identifiers ?? [],
        },
        false,
      );
      if (draft.nameKey === '' && draft.birthDate === null && draft.phoneKey === null && draft.identifiers.length === 0) {
        throw new ClinicalError('VALIDATION', 'Provide at least one search field');
      }
      const ranked = await this.rank(repo, draft, ctx);
      await repo.appendAudit(
        this.event(ctx, meta, 'success', principal.user, {
          count: ranked.length,
          definite: ranked.filter((c) => c.level === 'definite').length,
          probable: ranked.filter((c) => c.level === 'probable').length,
        }),
      );
      return ranked;
    });
  }

  // ---- Identifiers ---------------------------------------------------------
  async addIdentifier(personId: PersonId, input: NewIdentifierInput, ctx: TenantContext = requireTenantContext()): Promise<Identifier> {
    const meta: AuditMeta = { action: 'identifier.add', resourceType: 'Identifier', personId };
    return this.tx(ctx, meta, async (repo) => {
      const principal = await this.principal(repo, ctx);
      this.authorize(principal, 'person:identifier');

      const person = await repo.findPerson(personId);
      if (!person) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(person, ctx);
      if (person.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Person is not active (merged/deceased/inactive)');

      const normalized = this.v(() => normalizeIdentifier(input));
      const identifier = this.toIdentifier(ctx.tenantId, personId, normalized, this.now());
      await repo.insertIdentifier(identifier); // CONFLICT: IDENTIFIER_TAKEN
      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'person',
        aggregateId: personId,
        eventType: 'patient.identifier.added',
        payload: { personId, identifierId: identifier.identifierId, type: identifier.type },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: identifier.identifierId }, 'success', principal.user, { type: identifier.type }),
      );
      return identifier;
    });
  }

  async retireIdentifier(
    identifierId: string,
    status: 'inactive' | 'entered_in_error',
    expectedVersion: number,
    ctx: TenantContext = requireTenantContext(),
  ): Promise<Identifier> {
    const meta: AuditMeta = { action: 'identifier.retire', resourceType: 'Identifier', resourceId: identifierId };
    return this.tx(ctx, meta, async (repo) => {
      const principal = await this.principal(repo, ctx);
      this.authorize(principal, 'person:identifier');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ClinicalError('VALIDATION', 'expectedVersion must be a positive integer');

      const current = await repo.findIdentifier(identifierId);
      if (!current) throw new ClinicalError('NOT_FOUND', 'Identifier not found');
      assertSameTenant(current, ctx);
      if (current.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Identifier is not active');
      const person = await repo.findPerson(current.personId);
      if (!person || person.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Person is not active');

      const updated = await repo.updateIdentifierStatus(identifierId, status, expectedVersion);
      if (!updated) throw new VersionConflictError('Identifier', identifierId, expectedVersion);
      await repo.appendAudit(
        this.event(ctx, { ...meta, personId: current.personId }, 'success', principal.user, { to: status }),
      );
      return updated;
    });
  }

  // ---- Read (theo dõi chuyển hướng sau merge) ----------------------------------
  async getPerson(personId: PersonId, ctx: TenantContext = requireTenantContext()): Promise<PersonView> {
    const meta: AuditMeta = { action: 'person.read', resourceType: 'Person', resourceId: personId, personId };
    return this.tx(ctx, meta, async (repo) => {
      const requested = await repo.findPerson(personId);
      if (!requested) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(requested, ctx);

      let canonical = requested;
      for (let hops = 0; canonical.status === 'merged' && canonical.mergedIntoPersonId && hops < 5; hops++) {
        const next = await repo.findPerson(canonical.mergedIntoPersonId);
        if (!next) throw new ClinicalError('NOT_FOUND', 'Person not found');
        assertSameTenant(next, ctx);
        canonical = next;
      }
      if (canonical.status === 'merged') throw new ClinicalError('INVALID_STATE', 'Merge chain too long');

      const principal = await this.principal(repo, ctx);
      const isSelf = principal.user.personId !== null && (principal.user.personId === canonical.personId || principal.user.personId === requested.personId);
      if (!isSelf) this.authorize(principal, 'person:search');

      const identifiers = (await repo.listIdentifiers(canonical.personId)).filter((i) => i.status !== 'entered_in_error');
      for (const i of identifiers) assertSameTenant(i, ctx);
      await repo.appendAudit(
        this.event(ctx, { ...meta, personId: canonical.personId }, 'success', principal.user, { self: isSelf, redirected: canonical.personId !== requested.personId }),
      );
      return { person: canonical, identifiers, redirectedFrom: canonical.personId !== requested.personId ? requested.personId : null };
    });
  }

  // ---- Merge ---------------------------------------------------------------
  async mergePersons(input: MergePersonsInput, ctx: TenantContext = requireTenantContext()): Promise<MergeResult> {
    const meta: AuditMeta = { action: 'person.merge', resourceType: 'Person', resourceId: input.sourcePersonId, personId: input.targetPersonId };
    return this.tx(ctx, meta, async (repo) => {
      const principal = await this.principal(repo, ctx);
      this.authorize(principal, 'person:merge');

      if (input.sourcePersonId === input.targetPersonId) throw new ClinicalError('VALIDATION', 'Cannot merge a person into itself');
      const reason = (input.reason ?? '').trim();
      if (reason.length < 5 || reason.length > 500) throw new ClinicalError('VALIDATION', 'reason must be 5-500 characters');
      for (const v of [input.expectedSourceVersion, input.expectedTargetVersion]) {
        if (!Number.isInteger(v) || v < 1) throw new ClinicalError('VALIDATION', 'expected versions must be positive integers');
      }

      const source = await repo.findPerson(input.sourcePersonId);
      const target = await repo.findPerson(input.targetPersonId);
      if (!source || !target) throw new ClinicalError('NOT_FOUND', 'Person not found');
      assertSameTenant(source, ctx);
      assertSameTenant(target, ctx);
      if (source.status !== 'active' || target.status !== 'active') {
        throw new ClinicalError('INVALID_STATE', 'Both persons must be active to merge');
      }
      if (source.version !== input.expectedSourceVersion) throw new VersionConflictError('Person', source.personId, input.expectedSourceVersion);
      if (target.version !== input.expectedTargetVersion) throw new VersionConflictError('Person', target.personId, input.expectedTargetVersion);

      // Hai hồ sơ bệnh nhân cùng organization cho cùng một người thật => cần xử lý thủ công (không tự gộp hồ sơ lâm sàng).
      const sourcePatients = await repo.listPatientsByPerson(source.personId);
      const targetPatients = await repo.listPatientsByPerson(target.personId);
      const targetOrgs = new Set(targetPatients.map((p) => p.organizationId));
      if (sourcePatients.some((p) => targetOrgs.has(p.organizationId))) {
        throw new ClinicalError('CONFLICT', 'Both persons already have a patient record at the same organization', { reason: 'PATIENT_ORG_CONFLICT' });
      }

      const sourceIds = (await repo.listIdentifiers(source.personId)).filter((i) => i.status === 'active');
      const targetKeys = new Set(
        (await repo.listIdentifiers(target.personId)).filter((i) => i.status === 'active').map((i) => identifierKey(i.system, i.value)),
      );

      // 1) Đánh dấu source đã merge (trigger DB bảo đảm target active cùng tenant).
      const marked = await repo.markPersonMerged(source.personId, target.personId, source.version);
      if (!marked) throw new VersionConflictError('Person', source.personId, source.version);

      // 2) Survivorship: target thắng; chỉ điền chỗ trống từ source. Luôn bump version để khoá đồng thời target.
      const patch: SurvivorPatch = {
        birthDate: target.birthDate === null ? source.birthDate : null,
        sex: target.sex === null ? source.sex : null,
        phone: target.phone === null ? source.phone : null,
        email: target.email === null ? source.email : null,
        phoneKey: target.phone === null && source.phone !== null ? normalizePhone(source.phone) : null,
      };
      const patchedTarget = await repo.patchSurvivor(target.personId, patch, target.version);
      if (!patchedTarget) throw new VersionConflictError('Person', target.personId, target.version);

      // 3) Chuyển hồ sơ bệnh nhân (patient_id giữ nguyên => dữ liệu lâm sàng không bị đụng).
      const movedPatientIds = await repo.movePatients(source.personId, target.personId);

      // 4) Định danh: trùng với target => ngừng; còn lại => chuyển sang target.
      const moved: string[] = [];
      const retired: string[] = [];
      for (const id of sourceIds) {
        if (targetKeys.has(identifierKey(id.system, id.value))) {
          const r = await repo.updateIdentifierStatus(id.identifierId, 'inactive', id.version);
          if (!r) throw new VersionConflictError('Identifier', id.identifierId, id.version);
          retired.push(id.identifierId);
        } else {
          if (!(await repo.moveIdentifier(id.identifierId, target.personId, id.version))) {
            throw new VersionConflictError('Identifier', id.identifierId, id.version);
          }
          moved.push(id.identifierId);
        }
      }

      // 5) Tài khoản người dùng (app bệnh nhân) trỏ về person đích.
      const repointedUserIds = await repo.repointUsers(source.personId, target.personId);

      // 6) Lịch sử merge (append-only).
      const mergeId = this.newId();
      await repo.insertMergeRecord({
        mergeId,
        tenantId: ctx.tenantId,
        sourcePersonId: source.personId,
        targetPersonId: target.personId,
        reason,
        mergedByUserId: principal.user.userId,
        sourceSnapshot: { ...source },
        movedPatientIds,
        movedIdentifierIds: moved,
        retiredIdentifierIds: retired,
        repointedUserIds,
        mergedAt: this.now(),
      });

      await repo.enqueueOutbox(ctx.tenantId, {
        aggregateType: 'person',
        aggregateId: target.personId,
        eventType: 'patient.person.merged',
        payload: { mergeId, sourcePersonId: source.personId, targetPersonId: target.personId, movedPatientIds },
      });
      await repo.appendAudit(
        this.event(ctx, { ...meta, resourceId: source.personId, personId: target.personId }, 'success', principal.user, {
          mergeId,
          movedPatients: movedPatientIds.length,
          movedIdentifiers: moved.length,
          retiredIdentifiers: retired.length,
          repointedUsers: repointedUserIds.length,
        }),
      );
      return {
        mergeId,
        sourcePersonId: source.personId,
        targetPersonId: target.personId,
        target: patchedTarget,
        movedPatientIds,
        movedIdentifierIds: moved,
        retiredIdentifierIds: retired,
        repointedUserIds,
      };
    });
  }

  // ---- Internals -----------------------------------------------------------
  private now(): string {
    return this.clock().toISOString();
  }

  /** Chuyển lỗi validate thuần của domain thành ClinicalError('VALIDATION'). */
  private v<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RegistryValidationError) throw new ClinicalError('VALIDATION', e.message);
      throw e;
    }
  }

  private prepare(input: NewPersonInput | DuplicateSearchInput | (Omit<NewPersonInput, 'givenName' | 'familyName'> & { givenName: string; familyName: string }), strict: boolean): Draft {
    return this.v(() => {
      const hasName = (input.givenName ?? '').trim() !== '' || (input.familyName ?? '').trim() !== '';
      const givenName = strict || hasName ? cleanName(input.givenName ?? '', 'givenName') : '';
      const familyName = strict || hasName ? cleanName(input.familyName ?? '', 'familyName') : '';
      const birthDate = input.birthDate ? validateBirthDate(input.birthDate, this.clock()) : null;
      let phone: string | null = null;
      if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
        phone = normalizePhone(input.phone);
        if (!phone) throw new RegistryValidationError('Invalid phone');
      }
      const sex = 'sex' in input && input.sex !== undefined && input.sex !== null ? input.sex : null;
      if (sex !== null && !SEXES.includes(sex)) throw new RegistryValidationError('Invalid sex');
      const email = 'email' in input && input.email ? normalizeEmail(input.email) : null;

      const ids = input.identifiers ?? [];
      if (ids.length > MAX_IDENTIFIERS) throw new RegistryValidationError('Too many identifiers');
      const identifiers = ids.map(normalizeIdentifier);
      const seen = new Set<string>();
      for (const i of identifiers) {
        const k = identifierKey(i.system, i.value);
        if (seen.has(k)) throw new RegistryValidationError('Duplicate identifier in request');
        seen.add(k);
      }
      return {
        givenName,
        familyName,
        nameKey: hasName ? buildNameKey(givenName, familyName) : '',
        birthDate,
        sex,
        phone,
        phoneKey: phone,
        email,
        identifiers,
      };
    });
  }

  private parseOverride(input: NewPersonInput): string | null {
    if (!input.duplicateOverride) return null;
    const r = (input.duplicateOverride.reason ?? '').trim();
    if (r.length < 5 || r.length > 500) throw new ClinicalError('VALIDATION', 'duplicateOverride.reason must be 5-500 characters');
    return r;
  }

  private toIdentifier(tenantId: TenantId, personId: PersonId, n: NormalizedIdentifier, now: string): Identifier {
    return {
      tenantId,
      identifierId: this.newId() as IdentifierId,
      personId,
      patientId: null,
      type: n.type,
      system: n.system,
      value: n.value,
      status: 'active',
      periodStart: n.periodStart,
      periodEnd: n.periodEnd,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }

  /** Lấy ứng viên (theo ngày sinh / SĐT / khoá tên / định danh) rồi chấm điểm trong bộ nhớ. */
  private async rank(repo: RegistryRepository, draft: Draft, ctx: TenantContext): Promise<DuplicateCandidate[]> {
    const [found, idMatches] = await Promise.all([
      repo.findCandidates({ birthDate: draft.birthDate, phoneKey: draft.phoneKey, nameKey: draft.nameKey || null }),
      draft.identifiers.length > 0
        ? repo.findIdentifierMatches(draft.identifiers.map((i) => ({ system: i.system, value: i.value })))
        : Promise.resolve([] as IdentifierMatch[]),
    ]);

    const byId = new Map<string, Person>();
    for (const p of found) byId.set(p.personId, p);
    const idMatched = new Set<string>(idMatches.map((m) => m.personId));
    for (const pid of idMatched) {
      if (!byId.has(pid)) {
        const p = await repo.findPerson(pid as PersonId);
        if (p && p.status === 'active') byId.set(pid, p);
      }
    }

    const self: MatchProfile = { nameKey: draft.nameKey, birthDate: draft.birthDate, phoneKey: draft.phoneKey };
    const out: DuplicateCandidate[] = [];
    for (const cand of byId.values()) {
      assertSameTenant(cand, ctx);
      if (cand.status !== 'active') continue;
      const profile: MatchProfile = {
        nameKey: buildNameKey(cand.givenName, cand.familyName),
        birthDate: cand.birthDate,
        phoneKey: normalizePhone(cand.phone),
        sharesIdentifier: idMatched.has(cand.personId),
      };
      const r = scoreMatch(self, profile);
      if (r.level !== null) out.push({ personId: cand.personId, score: r.score, level: r.level, reasons: r.reasons });
    }
    return out.sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1)).slice(0, MAX_CANDIDATES);
  }

  private async principal(repo: RegistryRepository, ctx: TenantContext): Promise<Principal> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const roles = new Set<Role>();
    for (const m of await repo.listMemberships(user.userId)) {
      const valid = m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now);
      if (!valid) continue;
      const orgOk = m.role === 'tenant_admin' || m.role === 'system' || ctx.allowedOrganizationIds.includes(m.organizationId);
      if (orgOk) roles.add(m.role);
    }
    return { user, roles };
  }

  private authorize(p: Principal, perm: Permission): void {
    if (!PERMISSIONS[perm].some((r) => p.roles.has(r))) throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
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
      organizationId: null,
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId ?? null,
      personId: meta.personId ?? null,
      patientId: null,
      outcome,
      correlationId: ctx.correlationId as CorrelationId,
      sourceIp: null,
      userAgent: null,
      payload,
    };
  }

  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: RegistryRepository) => Promise<T>): Promise<T> {
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
      } else if (e instanceof VersionConflictError) {
        code = 'VERSION_CONFLICT';
      }
      try {
        await this.audit.record(this.event(ctx, meta, outcome, null, { code }));
      } catch {
        /* audit lỗi không được đổi kết quả */
      }
      throw e;
    }
  }
}

// ===========================================================================
// PostgreSQL adapter
// ===========================================================================
const UNIQUE_REASONS: Readonly<Record<string, string>> = {
  identifiers_active_system_value_uk: 'IDENTIFIER_TAKEN',
  persons_pkey: 'ID_COLLISION',
  person_merges_source_uk: 'ALREADY_MERGED',
};

function translatePgError(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err && typeof err === 'object') {
    if (err.code === '23505') {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: UNIQUE_REASONS[err.constraint ?? ''] ?? 'UNIQUE_VIOLATION' });
    }
    if (err.code === '23503') throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'REFERENCE_VIOLATION' });
    if (err.code === '55000') throw new ClinicalError('INVALID_STATE', 'Operation not allowed in current state');
    if (err.code === '42501') throw new ClinicalError('FORBIDDEN', 'Operation rejected by data-layer policy');
  }
  throw e;
}

const pgUuidArray = (ids: readonly string[]): string => `{${ids.join(',')}}`;
const CAND_LIMIT = 200;

export class PgRegistryRepository implements RegistryRepository {
  constructor(private readonly db: TenantScopedDb) {}

  private get t(): string {
    return this.db.tenantId;
  }

  async findUserBySubject(subject: string): Promise<User | null> {
    const r = await this.db.query(`SELECT ${USER_COLS} FROM iam.users WHERE tenant_id = $1 AND external_subject = $2`, [this.t, subject]);
    return r.rows[0] ? mapUser(r.rows[0]) : null;
  }

  async listMemberships(userId: UserId): Promise<Membership[]> {
    const r = await this.db.query(`SELECT ${MEMBERSHIP_COLS} FROM iam.memberships WHERE tenant_id = $1 AND user_id = $2`, [this.t, userId]);
    return r.rows.map(mapMembership);
  }

  async findPerson(personId: PersonId): Promise<Person | null> {
    const r = await this.db.query(`SELECT ${PERSON_COLS} FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [this.t, personId]);
    return r.rows[0] ? mapPerson(r.rows[0]) : null;
  }

  async insertPerson(p: Person, keys: PersonKeys): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO patient.persons
           (person_id, tenant_id, given_name, family_name, birth_date, sex, phone, email, status, name_key, phone_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [p.personId, p.tenantId, p.givenName, p.familyName, p.birthDate, p.sex, p.phone, p.email, p.status, keys.nameKey, keys.phoneKey],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async findCandidates(q: CandidateQuery): Promise<Person[]> {
    if (q.birthDate === null && q.phoneKey === null && q.nameKey === null) return [];
    const r = await this.db.query(
      `SELECT ${PERSON_COLS} FROM patient.persons
        WHERE tenant_id = $1 AND status = 'active'
          AND (   ($2::date IS NOT NULL AND birth_date = $2::date)
               OR ($3::text IS NOT NULL AND phone_key = $3::text)
               OR ($4::text IS NOT NULL AND name_key  = $4::text))
        LIMIT ${CAND_LIMIT}`,
      [this.t, q.birthDate, q.phoneKey, q.nameKey],
    );
    return r.rows.map(mapPerson);
  }

  async findIdentifierMatches(keys: ReadonlyArray<{ system: string; value: string }>): Promise<IdentifierMatch[]> {
    if (keys.length === 0) return [];
    const params: unknown[] = [this.t];
    const tuples = keys.map((k) => {
      params.push(k.system, k.value);
      return `($${params.length - 1}, $${params.length})`;
    });
    const r = await this.db.query<{ person_id: PersonId; system: string; value: string }>(
      `SELECT person_id, system, value FROM patient.identifiers
        WHERE tenant_id = $1 AND status = 'active' AND (system, value) IN (${tuples.join(', ')})`,
      params,
    );
    return r.rows.map((x) => ({ personId: x.person_id, system: x.system, value: x.value }));
  }

  async listIdentifiers(personId: PersonId): Promise<Identifier[]> {
    const r = await this.db.query(
      `SELECT ${IDENTIFIER_COLS} FROM patient.identifiers WHERE tenant_id = $1 AND person_id = $2 ORDER BY created_at, identifier_id`,
      [this.t, personId],
    );
    return r.rows.map(mapIdentifier);
  }

  async insertIdentifier(i: Identifier): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO patient.identifiers
           (identifier_id, tenant_id, person_id, patient_id, type, system, value, status, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [i.identifierId, i.tenantId, i.personId, i.patientId, i.type, i.system, i.value, i.status, i.periodStart, i.periodEnd],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async findIdentifier(id: string): Promise<Identifier | null> {
    const r = await this.db.query(`SELECT ${IDENTIFIER_COLS} FROM patient.identifiers WHERE tenant_id = $1 AND identifier_id = $2`, [this.t, id]);
    return r.rows[0] ? mapIdentifier(r.rows[0]) : null;
  }

  async updateIdentifierStatus(id: string, status: 'inactive' | 'entered_in_error', expectedVersion: number): Promise<Identifier | null> {
    try {
      const r = await this.db.query(
        `UPDATE patient.identifiers SET status = $3 WHERE tenant_id = $1 AND identifier_id = $2 AND version = $4 RETURNING ${IDENTIFIER_COLS}`,
        [this.t, id, status, expectedVersion],
      );
      return r.rows[0] ? mapIdentifier(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async listPatientsByPerson(personId: PersonId): Promise<Patient[]> {
    const r = await this.db.query(`SELECT ${PATIENT_COLS} FROM patient.patients WHERE tenant_id = $1 AND person_id = $2 ORDER BY patient_id`, [this.t, personId]);
    return r.rows.map(mapPatient);
  }

  async markPersonMerged(sourceId: PersonId, targetId: PersonId, expectedVersion: number): Promise<Person | null> {
    try {
      const r = await this.db.query(
        `UPDATE patient.persons SET status = 'merged', merged_into_person_id = $3
          WHERE tenant_id = $1 AND person_id = $2 AND version = $4 AND status = 'active' RETURNING ${PERSON_COLS}`,
        [this.t, sourceId, targetId, expectedVersion],
      );
      return r.rows[0] ? mapPerson(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async patchSurvivor(targetId: PersonId, p: SurvivorPatch, expectedVersion: number): Promise<Person | null> {
    try {
      const r = await this.db.query(
        `UPDATE patient.persons
            SET birth_date = COALESCE(birth_date, $3::date), sex = COALESCE(sex, $4::text), phone = COALESCE(phone, $5::text),
                email = COALESCE(email, $6::text), phone_key = COALESCE(phone_key, $7::text)
          WHERE tenant_id = $1 AND person_id = $2 AND version = $8 AND status = 'active' RETURNING ${PERSON_COLS}`,
        [this.t, targetId, p.birthDate, p.sex, p.phone, p.email, p.phoneKey, expectedVersion],
      );
      return r.rows[0] ? mapPerson(r.rows[0]) : null;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async movePatients(sourceId: PersonId, targetId: PersonId): Promise<PatientId[]> {
    try {
      const r = await this.db.query<{ patient_id: PatientId }>(
        `UPDATE patient.patients SET person_id = $3 WHERE tenant_id = $1 AND person_id = $2 RETURNING patient_id`,
        [this.t, sourceId, targetId],
      );
      return r.rows.map((x) => x.patient_id).sort();
    } catch (e) {
      return translatePgError(e);
    }
  }

  async moveIdentifier(id: string, toPersonId: PersonId, expectedVersion: number): Promise<boolean> {
    try {
      const r = await this.db.query(
        `UPDATE patient.identifiers SET person_id = $3 WHERE tenant_id = $1 AND identifier_id = $2 AND version = $4 RETURNING identifier_id`,
        [this.t, id, toPersonId, expectedVersion],
      );
      return r.rows.length === 1;
    } catch (e) {
      return translatePgError(e);
    }
  }

  async repointUsers(sourceId: PersonId, targetId: PersonId): Promise<UserId[]> {
    const r = await this.db.query<{ user_id: UserId }>(
      `UPDATE iam.users SET person_id = $3 WHERE tenant_id = $1 AND person_id = $2 RETURNING user_id`,
      [this.t, sourceId, targetId],
    );
    return r.rows.map((x) => x.user_id).sort();
  }

  async insertMergeRecord(m: PersonMergeRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO patient.person_merges
           (merge_id, tenant_id, source_person_id, target_person_id, reason, merged_by_user_id, source_snapshot,
            moved_patient_ids, moved_identifier_ids, retired_identifier_ids, repointed_user_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[], $9::uuid[], $10::uuid[], $11::uuid[])`,
        [m.mergeId, m.tenantId, m.sourcePersonId, m.targetPersonId, m.reason, m.mergedByUserId, JSON.stringify(m.sourceSnapshot),
         pgUuidArray(m.movedPatientIds), pgUuidArray(m.movedIdentifierIds), pgUuidArray(m.retiredIdentifierIds), pgUuidArray(m.repointedUserIds)],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async enqueueOutbox(tenantId: TenantId, ev: OutboxDraft): Promise<void> {
    await this.db.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
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

export class PgRegistryUnitOfWork implements RegistryUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  run<T>(ctx: TenantContext, fn: (repo: RegistryRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgRegistryRepository(db));
      },
      ctx,
    );
  }
}
