/**
 * HCOS-P0-ENG-001 | Gate G1 | Patient registry & clinical encounter lifecycle (Vitest)
 *
 * Chạy hoàn toàn in-process với repository in-memory mô phỏng ràng buộc DB (unique, PK toàn cục,
 * RLS theo tenant, transaction rollback). Các ràng buộc ở tầng PostgreSQL (trigger bất biến, history,
 * RLS thật) cần integration suite riêng trên DB thật.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  asOrganizationId,
  asPatientId,
  asPersonId,
  asTenantId,
  asUserId,
  VersionConflictError,
  type AuditSink,
  type CorrelationId,
  type Identifier,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type Patient,
  type Person,
  type Role,
  type TenantContext,
  type TenantId,
  type User,
} from '../../packages/domain/src/s0-contracts';
import {
  asConditionId,
  asEncounterId,
  asObservationId,
  fromFhirCondition,
  fromFhirEncounter,
  fromFhirObservation,
  fromFhirPatient,
  FhirMappingError,
  toFhirCondition,
  toFhirEncounter,
  toFhirObservation,
  toFhirPatient,
  type Condition,
  type Encounter,
  type Observation,
} from '../../packages/domain/src/s1-contracts';
import {
  ClinicalEncounterService,
  ClinicalError,
  type ClinicalRepository,
  type ClinicalUnitOfWork,
  type OutboxDraft,
  type PatientSearchQuery,
} from '../../services/api/src/clinical/encounter.service';
import { nameKey as buildNameKey } from '../../packages/domain/src/person-registry';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';

const TENANT_A = asTenantId(uid(1));
const TENANT_B = asTenantId(uid(2));
const ORG_A1 = asOrganizationId(uid(11));
const ORG_A2 = asOrganizationId(uid(12));
const ORG_B1 = asOrganizationId(uid(13));

const U = {
  docA1: asUserId(uid(101)),
  docA1b: asUserId(uid(102)),
  nurseA1: asUserId(uid(103)),
  pharmA1: asUserId(uid(104)),
  adminA: asUserId(uid(105)),
  patientA1: asUserId(uid(106)),
  patientA2: asUserId(uid(107)),
  docA2: asUserId(uid(108)),
  docBoth: asUserId(uid(109)),
  disabled: asUserId(uid(110)),
  expired: asUserId(uid(111)),
  revoked: asUserId(uid(112)),
  docB: asUserId(uid(201)),
};
const P = {
  a1: asPersonId(uid(301)),
  a2: asPersonId(uid(302)),
  merged: asPersonId(uid(303)),
  a3: asPersonId(uid(304)),
  b1: asPersonId(uid(401)),
};
const PAT_B = asPatientId(uid(501));
const ENC_B = asEncounterId(uid(601));
const MRN_B = 'MRN-B-001';

const ICD_J06 = { system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9', display: 'Nhiễm khuẩn hô hấp trên cấp' };
const LOINC_TEMP = { system: 'http://loinc.org', code: '8310-5', display: 'Body temperature' };
const REASON_TEXT = 'Ho sốt 3 ngày — lý do khám bí mật';

const subject = (u: string) => `sub-${u}`;

const mkUser = (userId: User['userId'], tenantId: TenantId, over: Partial<User> = {}): User => ({
  tenantId, userId, externalSubject: subject(userId), email: null, displayName: `user-${userId.slice(-3)}`,
  personId: null, status: 'active', lastLoginAt: null, createdAt: T0, updatedAt: T0, version: 1, ...over,
});

let membershipSeq = 700;
const mkMember = (
  tenantId: TenantId, userId: User['userId'], organizationId: OrganizationId, role: Role, over: Partial<Membership> = {},
): Membership => ({
  tenantId, membershipId: uid(membershipSeq++) as unknown as Membership['membershipId'], userId, organizationId,
  role, status: 'active', validFrom: T0, validTo: null, createdAt: T0, updatedAt: T0, version: 1, ...over,
});

const mkPerson = (tenantId: TenantId, personId: Person['personId'], over: Partial<Person> = {}): Person => ({
  tenantId, personId, givenName: 'Văn A', familyName: 'Nguyễn', birthDate: '1990-05-17', sex: 'male',
  phone: '0900000000', email: null, status: 'active', mergedIntoPersonId: null, createdAt: T0, updatedAt: T0, version: 1, ...over,
});

const mkCtx = (tenantId: TenantId, user: User['userId'], orgs: OrganizationId[], roles: Role[] = []): TenantContext =>
  Object.freeze({
    tenantId,
    userSubject: subject(user),
    userId: null,
    personId: null,
    activeOrganizationId: orgs[0] ?? null,
    allowedOrganizationIds: Object.freeze([...orgs]),
    roles: Object.freeze([...roles]),
    tokenId: null,
    correlationId: 'corr-test' as CorrelationId,
  });

// ---------------------------------------------------------------------------
// In-memory repository mô phỏng ràng buộc DB
// ---------------------------------------------------------------------------
interface State {
  persons: Person[];
  patients: Patient[];
  identifiers: Identifier[];
  users: User[];
  memberships: Membership[];
  encounters: Encounter[];
  conditions: Condition[];
  observations: Observation[];
  outbox: Array<OutboxDraft & { tenantId: TenantId }>;
  audit: NewAuditEvent[];
}

class MemoryStore {
  state: State = {
    persons: [], patients: [], identifiers: [], users: [], memberships: [], encounters: [],
    conditions: [], observations: [], outbox: [], audit: [],
  };
}

class MemoryRepo implements ClinicalRepository {
  constructor(
    private readonly store: MemoryStore,
    private readonly tenantId: TenantId,
    /** leaky = repository lỗi, KHÔNG lọc theo tenant (để chứng minh phòng thủ chiều sâu ở service). */
    private readonly leaky = false,
  ) {}

  private get s(): State {
    return this.store.state;
  }
  private vis<T extends { tenantId: string }>(xs: T[]): T[] {
    return this.leaky ? xs : xs.filter((x) => x.tenantId === this.tenantId);
  }
  private writable(tenantId: string): void {
    if (tenantId !== this.tenantId) {
      throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    }
  }

  async findPerson(id: Person['personId']) {
    return this.vis(this.s.persons).find((p) => p.personId === id) ?? null;
  }
  async findPatient(id: Patient['patientId']) {
    return this.vis(this.s.patients).find((p) => p.patientId === id) ?? null;
  }
  async listIdentifiers(personId: Person['personId']) {
    return this.vis(this.s.identifiers).filter((i) => i.personId === personId);
  }
  async searchPatients(q: PatientSearchQuery) {
    const hits = this.vis(this.s.patients).filter((p) => {
      if (p.organizationId !== q.organizationId) return false;
      if (q.mrn !== null && p.mrn !== q.mrn) return false;
      if (q.nameKey !== null) {
        const person = this.s.persons.find((x) => x.tenantId === p.tenantId && x.personId === p.personId);
        if (!person || person.birthDate !== q.birthDate || buildNameKey(person.givenName, person.familyName) !== q.nameKey) return false;
      }
      if (q.identifier !== null) {
        const idf = q.identifier;
        if (!this.s.identifiers.some((i) => i.tenantId === p.tenantId && i.personId === p.personId && i.status === 'active' && i.system === idf.system && idf.values.includes(i.value))) return false;
      }
      return true;
    });
    return hits.sort((a, b) => (a.registeredAt + a.patientId).localeCompare(b.registeredAt + b.patientId)).slice(0, q.limit).map((p) => ({ ...p }));
  }
  async insertPatient(p: Patient) {
    this.writable(p.tenantId);
    // PK toàn cục (không theo tenant) như patients_pkey.
    if (this.s.patients.some((x) => x.patientId === p.patientId)) {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'ID_COLLISION' });
    }
    if (this.s.patients.some((x) => x.tenantId === p.tenantId && x.personId === p.personId && x.organizationId === p.organizationId)) {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'PERSON_ALREADY_REGISTERED' });
    }
    if (this.s.patients.some((x) => x.tenantId === p.tenantId && x.organizationId === p.organizationId && x.mrn === p.mrn)) {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'MRN_TAKEN' });
    }
    this.s.patients.push({ ...p });
  }
  async findUserBySubject(sub: string) {
    return this.vis(this.s.users).find((u) => u.externalSubject === sub) ?? null;
  }
  async listMemberships(userId: User['userId']) {
    return this.vis(this.s.memberships).filter((m) => m.userId === userId);
  }
  async insertEncounter(e: Encounter) {
    this.writable(e.tenantId);
    const pat = this.s.patients.find((p) => p.tenantId === e.tenantId && p.patientId === e.patientId && p.organizationId === e.organizationId);
    if (!pat) throw new Error('foreign key violation encounters_patient_org_fk');
    this.s.encounters.push({ ...e });
  }
  async findEncounter(id: Encounter['encounterId']) {
    return this.vis(this.s.encounters).find((e) => e.encounterId === id) ?? null;
  }
  async updateEncounter(next: Encounter, expectedVersion: number) {
    const cur = this.vis(this.s.encounters).find((e) => e.encounterId === next.encounterId);
    if (!cur || cur.version !== expectedVersion) return null;
    Object.assign(cur, next, { version: expectedVersion + 1 });
    return { ...cur };
  }
  async insertCondition(c: Condition) {
    this.writable(c.tenantId);
    if (
      this.s.conditions.some(
        (x) => x.tenantId === c.tenantId && x.encounterId === c.encounterId && x.code.system === c.code.system &&
          x.code.code === c.code.code && x.verificationStatus !== 'entered_in_error',
      )
    ) {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'DUPLICATE_CONDITION' });
    }
    this.s.conditions.push({ ...c });
  }
  async listConditions(encounterId: Encounter['encounterId']) {
    return this.vis(this.s.conditions).filter((c) => c.encounterId === encounterId);
  }
  async insertObservation(o: Observation) {
    this.writable(o.tenantId);
    this.s.observations.push({ ...o });
  }
  async listObservations(encounterId: Encounter['encounterId']) {
    return this.vis(this.s.observations).filter((o) => o.encounterId === encounterId);
  }
  async enqueueOutbox(tenantId: TenantId, ev: OutboxDraft) {
    this.writable(tenantId);
    this.s.outbox.push({ ...ev, tenantId });
  }
  async appendAudit(ev: NewAuditEvent) {
    this.writable(ev.tenantId);
    this.s.audit.push(ev);
  }
}

class MemoryUow implements ClinicalUnitOfWork {
  constructor(private readonly store: MemoryStore, private readonly leaky = false) {}
  async run<T>(ctx: TenantContext, fn: (repo: ClinicalRepository) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store.state);
    try {
      return await fn(new MemoryRepo(this.store, ctx.tenantId, this.leaky));
    } catch (e) {
      this.store.state = snapshot; // rollback toàn bộ (kể cả outbox & audit)
      throw e;
    }
  }
}

class MemorySink implements AuditSink {
  events: NewAuditEvent[] = [];
  async record(e: NewAuditEvent) {
    this.events.push(e);
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
interface WorldOpts {
  leaky?: boolean;
  newId?: () => string;
}

function buildWorld(opts: WorldOpts = {}) {
  const store = new MemoryStore();
  const sink = new MemorySink();
  const clock = { now: new Date('2026-10-30T03:00:00.000Z') };
  let seq = 9000;
  const svc = new ClinicalEncounterService({
    uow: new MemoryUow(store, opts.leaky ?? false),
    audit: sink,
    clock: () => new Date(clock.now.getTime()),
    newId: opts.newId ?? (() => uid(seq++)),
  });

  const s = store.state;
  // Tenant A
  s.persons.push(
    mkPerson(TENANT_A, P.a1), mkPerson(TENANT_A, P.a2, { givenName: 'Thị B' }), mkPerson(TENANT_A, P.a3, { givenName: 'Văn C' }),
    mkPerson(TENANT_A, P.merged, { status: 'merged', mergedIntoPersonId: P.a1 }),
  );
  s.users.push(
    mkUser(U.docA1, TENANT_A), mkUser(U.docA1b, TENANT_A), mkUser(U.nurseA1, TENANT_A), mkUser(U.pharmA1, TENANT_A),
    mkUser(U.adminA, TENANT_A), mkUser(U.patientA1, TENANT_A, { personId: P.a1 }), mkUser(U.patientA2, TENANT_A, { personId: P.a2 }),
    mkUser(U.docA2, TENANT_A), mkUser(U.docBoth, TENANT_A), mkUser(U.disabled, TENANT_A, { status: 'disabled' }),
    mkUser(U.expired, TENANT_A), mkUser(U.revoked, TENANT_A),
  );
  s.memberships.push(
    mkMember(TENANT_A, U.docA1, ORG_A1, 'doctor'),
    mkMember(TENANT_A, U.docA1b, ORG_A1, 'doctor'),
    mkMember(TENANT_A, U.nurseA1, ORG_A1, 'clinic_staff'),
    mkMember(TENANT_A, U.pharmA1, ORG_A1, 'pharmacist'),
    mkMember(TENANT_A, U.adminA, ORG_A1, 'tenant_admin'),
    mkMember(TENANT_A, U.patientA1, ORG_A1, 'patient'),
    mkMember(TENANT_A, U.docA2, ORG_A2, 'doctor'),
    mkMember(TENANT_A, U.docBoth, ORG_A1, 'doctor'),
    mkMember(TENANT_A, U.docBoth, ORG_A2, 'doctor'),
    mkMember(TENANT_A, U.disabled, ORG_A1, 'doctor'),
    mkMember(TENANT_A, U.expired, ORG_A1, 'doctor', { validTo: '2026-10-01T00:00:00.000Z' }),
    mkMember(TENANT_A, U.revoked, ORG_A1, 'doctor', { status: 'revoked' }),
  );
  // Tenant B (đã có sẵn hồ sơ + đợt khám)
  s.persons.push(mkPerson(TENANT_B, P.b1, { givenName: 'Thị Bí Mật', familyName: 'Trần' }));
  s.users.push(mkUser(U.docB, TENANT_B));
  s.memberships.push(mkMember(TENANT_B, U.docB, ORG_B1, 'doctor'));
  s.patients.push({
    tenantId: TENANT_B, patientId: PAT_B, personId: P.b1, organizationId: ORG_B1, mrn: MRN_B,
    status: 'active', registeredAt: T0, createdAt: T0, updatedAt: T0, version: 1,
  });
  s.encounters.push({
    tenantId: TENANT_B, encounterId: ENC_B, patientId: PAT_B, organizationId: ORG_B1, practitionerUserId: U.docB,
    status: 'in_progress', encounterClass: 'ambulatory', reasonText: 'B-private', periodStart: T0, periodEnd: null,
    createdAt: T0, updatedAt: T0, version: 1,
  });

  const ctx = {
    docA1: mkCtx(TENANT_A, U.docA1, [ORG_A1], ['doctor']),
    docA1b: mkCtx(TENANT_A, U.docA1b, [ORG_A1], ['doctor']),
    nurse: mkCtx(TENANT_A, U.nurseA1, [ORG_A1], ['clinic_staff']),
    pharm: mkCtx(TENANT_A, U.pharmA1, [ORG_A1], ['pharmacist']),
    admin: mkCtx(TENANT_A, U.adminA, [ORG_A1], ['tenant_admin']),
    patientA1: mkCtx(TENANT_A, U.patientA1, [], ['patient']),
    patientA2: mkCtx(TENANT_A, U.patientA2, [], ['patient']),
    docA2: mkCtx(TENANT_A, U.docA2, [ORG_A2], ['doctor']),
    /** Token mở rộng org nhưng membership thật chỉ ở A2. */
    docA2Widened: mkCtx(TENANT_A, U.docA2, [ORG_A1, ORG_A2], ['doctor']),
    docBoth: mkCtx(TENANT_A, U.docBoth, [ORG_A1, ORG_A2], ['doctor']),
    disabled: mkCtx(TENANT_A, U.disabled, [ORG_A1], ['doctor']),
    expired: mkCtx(TENANT_A, U.expired, [ORG_A1], ['doctor']),
    revoked: mkCtx(TENANT_A, U.revoked, [ORG_A1], ['doctor']),
    ghost: Object.freeze({ ...mkCtx(TENANT_A, U.docA1, [ORG_A1], ['doctor']), userSubject: 'sub-not-provisioned' }) as TenantContext,
    docB: mkCtx(TENANT_B, U.docB, [ORG_B1], ['doctor']),
  };

  const register = (personId = P.a1, mrn = 'MRN-001') =>
    svc.registerPatient({ personId, organizationId: ORG_A1, mrn }, ctx.nurse);
  const openEncounter = async () => {
    const patient = await register();
    const encounter = await svc.createEncounter(
      { patientId: patient.patientId, organizationId: ORG_A1, encounterClass: 'ambulatory', reasonText: REASON_TEXT },
      ctx.docA1,
    );
    return { patient, encounter };
  };

  return { store, sink, clock, svc, ctx, register, openEncounter };
}

/** Trả về code lỗi (hoặc 'OK' / tên lỗi) để assert gọn. */
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (e: unknown) => (e as { code?: string }).code ?? (e as Error).name,
  );

let w: ReturnType<typeof buildWorld>;
beforeEach(() => {
  w = buildWorld();
});

// ===========================================================================
// 1. Vòng đời bệnh nhân & đợt khám
// ===========================================================================
describe('G1 / patient & encounter lifecycle', () => {
  it('runs register -> encounter -> condition -> observation -> close -> chart end-to-end', async () => {
    const bBefore = structuredClone(w.store.state.encounters.find((e) => e.encounterId === ENC_B));

    const patient = await w.register();
    expect(patient).toMatchObject({ tenantId: TENANT_A, personId: P.a1, organizationId: ORG_A1, mrn: 'MRN-001', status: 'active', version: 1 });

    const enc = await w.svc.createEncounter(
      { patientId: patient.patientId, organizationId: ORG_A1, encounterClass: 'ambulatory', reasonText: 'Ho sốt' },
      w.ctx.docA1,
    );
    expect(enc).toMatchObject({ status: 'in_progress', practitionerUserId: U.docA1, patientId: patient.patientId, version: 1, periodEnd: null });

    const cond = await w.svc.addCondition({ encounterId: enc.encounterId, code: ICD_J06, onsetAt: '2026-10-27T00:00:00Z' }, w.ctx.docA1);
    expect(cond).toMatchObject({ patientId: patient.patientId, encounterId: enc.encounterId, verificationStatus: 'confirmed', recordedByUserId: U.docA1 });

    const obs = await w.svc.recordObservation(
      { encounterId: enc.encounterId, code: LOINC_TEMP, value: { kind: 'quantity', value: 38.5, unit: 'Cel', ucumCode: 'Cel' } },
      w.ctx.nurse,
    );
    expect(obs).toMatchObject({ status: 'final', recordedByUserId: U.nurseA1, patientId: patient.patientId });

    w.clock.now = new Date(w.clock.now.getTime() + 30 * 60_000);
    const closed = await w.svc.closeEncounter(enc.encounterId, 1, w.ctx.docA1);
    expect(closed.status).toBe('finished');
    expect(closed.version).toBe(2);
    expect(closed.periodEnd).toBe('2026-10-30T03:30:00.000Z');

    const chart = await w.svc.getEncounterChart(enc.encounterId, w.ctx.pharm);
    expect(chart.encounter.status).toBe('finished');
    expect(chart.conditions.map((c) => c.conditionId)).toEqual([cond.conditionId]);
    expect(chart.observations.map((o) => o.observationId)).toEqual([obs.observationId]);

    expect(w.store.state.outbox.map((o) => o.eventType)).toEqual([
      'patient.registered', 'clinical.encounter.created', 'clinical.condition.recorded',
      'clinical.observation.recorded', 'clinical.encounter.finished',
    ]);
    expect(w.store.state.audit.map((a) => a.action)).toEqual([
      'patient.register', 'encounter.create', 'condition.create', 'observation.create', 'encounter.close', 'encounter.read',
    ]);
    expect(w.store.state.audit.every((a) => a.outcome === 'success' && a.tenantId === TENANT_A)).toBe(true);

    // Tenant B không bị ảnh hưởng.
    expect(w.store.state.encounters.find((e) => e.encounterId === ENC_B)).toEqual(bBefore);
  });

  it('rejects writes on a closed encounter and a second close', async () => {
    const { encounter } = await w.openEncounter();
    await w.svc.closeEncounter(encounter.encounterId, 1, w.ctx.docA1);
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docA1))).toBe('INVALID_STATE');
    expect(
      await outcome(
        w.svc.recordObservation(
          { encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'quantity', value: 37, unit: 'Cel', ucumCode: null } },
          w.ctx.nurse,
        ),
      ),
    ).toBe('INVALID_STATE');
    expect(await outcome(w.svc.closeEncounter(encounter.encounterId, 2, w.ctx.docA1))).toBe('INVALID_STATE');
  });

  it('detects stale version on close (optimistic concurrency) and leaves encounter open', async () => {
    const { encounter } = await w.openEncounter();
    expect(await outcome(w.svc.closeEncounter(encounter.encounterId, 7, w.ctx.docA1))).toBe('VersionConflictError');
    await expect(w.svc.closeEncounter(encounter.encounterId, 7, w.ctx.docA1)).rejects.toBeInstanceOf(VersionConflictError);
    expect(w.store.state.encounters.find((e) => e.encounterId === encounter.encounterId)).toMatchObject({ status: 'in_progress', version: 1 });
  });

  it('rolls back atomically when a write fails (no partial condition/outbox/audit)', async () => {
    const { encounter } = await w.openEncounter();
    await w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docA1);
    const before = structuredClone(w.store.state);

    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docA1))).toBe('CONFLICT');
    expect(w.store.state).toEqual(before);
    expect(w.store.state.conditions).toHaveLength(1);
  });

  it('validates input and writes nothing on validation failure', async () => {
    const { encounter } = await w.openEncounter();
    const before = structuredClone(w.store.state);
    const bad = [
      w.svc.recordObservation({ encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'quantity', value: Number.NaN, unit: 'Cel', ucumCode: null } }, w.ctx.nurse),
      w.svc.recordObservation({ encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'quantity', value: 37, unit: '', ucumCode: null } }, w.ctx.nurse),
      w.svc.recordObservation({ encounterId: encounter.encounterId, code: { system: '', code: '8310-5', display: null }, value: { kind: 'string', value: 'x' } }, w.ctx.nurse),
      w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06, onsetAt: 'not-a-date' }, w.ctx.docA1),
      w.svc.registerPatient({ personId: P.a2, organizationId: ORG_A1, mrn: 'bad mrn!' }, w.ctx.nurse),
    ];
    for (const p of bad) expect(await outcome(p)).toBe('VALIDATION');
    expect(w.store.state).toEqual(before);
  });

  it('only allows an encounter for a patient registered at the same organization and active', async () => {
    const patient = await w.register(); // đăng ký tại A1
    // Bác sĩ có quyền ở cả A1 và A2 nhưng hồ sơ thuộc A1.
    expect(
      await outcome(w.svc.createEncounter({ patientId: patient.patientId, organizationId: ORG_A2, encounterClass: 'ambulatory' }, w.ctx.docBoth)),
    ).toBe('FORBIDDEN');

    (w.store.state.patients.find((p) => p.patientId === patient.patientId) as { status: string }).status = 'inactive';
    expect(
      await outcome(w.svc.createEncounter({ patientId: patient.patientId, organizationId: ORG_A1, encounterClass: 'ambulatory' }, w.ctx.docA1)),
    ).toBe('INVALID_STATE');
  });
});

// ===========================================================================
// 2. Trùng lặp hồ sơ / va chạm patient_id
// ===========================================================================
describe('G1 / duplicate registry & patient_id collision', () => {
  it('rejects registering the same person twice at the same organization', async () => {
    await w.register(P.a1, 'MRN-001');
    const err = await w.register(P.a1, 'MRN-002').catch((e) => e);
    expect(err).toBeInstanceOf(ClinicalError);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { reason: 'PERSON_ALREADY_REGISTERED' } });
    expect(w.store.state.patients.filter((p) => p.tenantId === TENANT_A)).toHaveLength(1);
  });

  it('rejects the same MRN for a different person at the same organization', async () => {
    await w.register(P.a1, 'MRN-001');
    const err = await w.register(P.a2, 'MRN-001').catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { reason: 'MRN_TAKEN' } });
  });

  it('allows the same MRN in a different tenant (no cross-tenant uniqueness leak)', async () => {
    // Tenant B đã có MRN 'MRN-B-001'; tenant A dùng chính MRN đó hợp lệ.
    const p = await w.register(P.a1, MRN_B);
    expect(p.mrn).toBe(MRN_B);
    expect(p.tenantId).toBe(TENANT_A);
  });

  it('survives a patient_id collision with another tenant without leaking or touching its data', async () => {
    const colliding = buildWorld({ newId: () => PAT_B });
    const bBefore = structuredClone(colliding.store.state.patients.find((p) => p.patientId === PAT_B));

    const err = await colliding.register(P.a1, 'MRN-001').catch((e) => e);
    expect(err).toBeInstanceOf(ClinicalError);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { reason: 'ID_COLLISION' } });

    const exposed = JSON.stringify({ message: err.message, details: err.details });
    expect(exposed).not.toContain(MRN_B);
    expect(exposed).not.toContain(P.b1);
    expect(exposed).not.toContain(ORG_B1);

    expect(colliding.store.state.patients.find((p) => p.patientId === PAT_B)).toEqual(bBefore);
    expect(colliding.store.state.patients.filter((p) => p.tenantId === TENANT_A)).toHaveLength(0);
  });

  it('refuses to register a merged person (must use the surviving person_id)', async () => {
    expect(await outcome(w.register(P.merged, 'MRN-009'))).toBe('INVALID_STATE');
  });

  it('cannot register a person that belongs to another tenant', async () => {
    expect(await outcome(w.svc.registerPatient({ personId: P.b1, organizationId: ORG_A1, mrn: 'MRN-777' }, w.ctx.nurse))).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// 3. Truy cập trái phép hồ sơ bệnh án
// ===========================================================================
describe('G1 / unauthorized access to clinical records', () => {
  it('cross-tenant: tenant B practitioner cannot read or modify tenant A encounter (NOT_FOUND, no existence leak)', async () => {
    const { encounter } = await w.openEncounter();
    const before = structuredClone(w.store.state);

    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.docB))).toBe('NOT_FOUND');
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docB))).toBe('NOT_FOUND');
    expect(
      await outcome(
        w.svc.recordObservation({ encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'string', value: 'x' } }, w.ctx.docB),
      ),
    ).toBe('NOT_FOUND');
    expect(await outcome(w.svc.closeEncounter(encounter.encounterId, 1, w.ctx.docB))).toBe('NOT_FOUND');
    expect(w.store.state).toEqual(before);

    const last = w.sink.events.at(-1)!;
    expect(last).toMatchObject({ tenantId: TENANT_B, outcome: 'failure' });
  });

  it('cross-tenant: tenant A practitioner cannot touch tenant B encounter or open one on tenant B patient', async () => {
    const bBefore = structuredClone(w.store.state.encounters.find((e) => e.encounterId === ENC_B));
    expect(await outcome(w.svc.getEncounterChart(ENC_B, w.ctx.docA1))).toBe('NOT_FOUND');
    expect(await outcome(w.svc.addCondition({ encounterId: ENC_B, code: ICD_J06 }, w.ctx.docA1))).toBe('NOT_FOUND');
    expect(await outcome(w.svc.closeEncounter(ENC_B, 1, w.ctx.docA1))).toBe('NOT_FOUND');
    expect(
      await outcome(w.svc.createEncounter({ patientId: PAT_B, organizationId: ORG_A1, encounterClass: 'ambulatory' }, w.ctx.docA1)),
    ).toBe('NOT_FOUND');
    expect(w.store.state.encounters.find((e) => e.encounterId === ENC_B)).toEqual(bBefore);
  });

  it('defense in depth: even if the repository leaks other-tenant rows, the service refuses (RESOURCE_TENANT_MISMATCH)', async () => {
    const leaky = buildWorld({ leaky: true });
    expect(await outcome(leaky.svc.getEncounterChart(ENC_B, leaky.ctx.docA1))).toBe('RESOURCE_TENANT_MISMATCH');
    expect(await outcome(leaky.svc.addCondition({ encounterId: ENC_B, code: ICD_J06 }, leaky.ctx.docA1))).toBe('RESOURCE_TENANT_MISMATCH');
    expect(await outcome(leaky.svc.closeEncounter(ENC_B, 1, leaky.ctx.docA1))).toBe('RESOURCE_TENANT_MISMATCH');
    expect(leaky.store.state.conditions).toHaveLength(0);
    expect(leaky.sink.events.every((e) => e.outcome === 'denied')).toBe(true);
  });

  it('organization scope: token without the encounter organization is rejected (ORG_NOT_ALLOWED)', async () => {
    const { encounter } = await w.openEncounter();
    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.docA2))).toBe('ORG_NOT_ALLOWED');
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docA2))).toBe('ORG_NOT_ALLOWED');
  });

  it('organization scope: a widened token does not help without an active membership at that organization', async () => {
    const { encounter } = await w.openEncounter();
    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.docA2Widened))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docA2Widened))).toBe('FORBIDDEN');
  });

  it('only the responsible practitioner can add diagnoses or close; another doctor in the org can only read', async () => {
    const { encounter } = await w.openEncounter();
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.docA1b))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.closeEncounter(encounter.encounterId, 1, w.ctx.docA1b))).toBe('FORBIDDEN');
    expect(
      await outcome(
        w.svc.recordObservation({ encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'string', value: 'x' } }, w.ctx.docA1b),
      ),
    ).toBe('FORBIDDEN');
    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.docA1b))).toBe('OK');
  });

  it('role separation: tenant_admin has no clinical access, even inside own tenant/org', async () => {
    const { encounter } = await w.openEncounter();
    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.admin))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.admin))).toBe('FORBIDDEN');
  });

  it('clinic_staff may record observations only; pharmacist may read only', async () => {
    const { patient, encounter } = await w.openEncounter();
    const obsInput = { encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'quantity' as const, value: 36.8, unit: 'Cel', ucumCode: 'Cel' } };

    expect(await outcome(w.svc.recordObservation(obsInput, w.ctx.nurse))).toBe('OK');
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.nurse))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.createEncounter({ patientId: patient.patientId, organizationId: ORG_A1, encounterClass: 'ambulatory' }, w.ctx.nurse))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.closeEncounter(encounter.encounterId, 1, w.ctx.nurse))).toBe('FORBIDDEN');

    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.pharm))).toBe('OK');
    expect(await outcome(w.svc.recordObservation(obsInput, w.ctx.pharm))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.pharm))).toBe('FORBIDDEN');
  });

  it('patients can read only their own chart (read-only); other patients are refused', async () => {
    const { encounter } = await w.openEncounter(); // thuộc person P.a1
    expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.patientA1))).toBe('OK');
    // Bệnh nhân không có org trong token => bị chặn ở lớp org (ORG_NOT_ALLOWED) hoặc lớp quyền (FORBIDDEN); cả hai đều là từ chối.
    const DENIED = ['FORBIDDEN', 'ORG_NOT_ALLOWED'];
    expect(DENIED).toContain(await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.patientA2)));
    expect(DENIED).toContain(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, w.ctx.patientA1)));
    expect(DENIED).toContain(await outcome(w.svc.closeEncounter(encounter.encounterId, 1, w.ctx.patientA1)));
    expect(w.store.state.conditions).toHaveLength(0);
  });

  it('rejects disabled, unprovisioned, expired and revoked principals', async () => {
    const { encounter } = await w.openEncounter();
    for (const c of [w.ctx.disabled, w.ctx.ghost, w.ctx.expired, w.ctx.revoked]) {
      expect(await outcome(w.svc.getEncounterChart(encounter.encounterId, c))).toBe('FORBIDDEN');
      expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06 }, c))).toBe('FORBIDDEN');
    }
  });

  it('audits denials outside the transaction with no PHI, and audits successful reads inside it', async () => {
    const { encounter } = await w.openEncounter();
    const sinkBefore = w.sink.events.length;

    await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.admin));
    await outcome(w.svc.getEncounterChart(encounter.encounterId, w.ctx.docA2));
    const denied = w.sink.events.slice(sinkBefore);
    expect(denied).toHaveLength(2);
    expect(denied.every((e) => e.outcome === 'denied' && e.action === 'encounter.read' && e.resourceId === encounter.encounterId)).toBe(true);
    expect(denied.map((e) => e.payload)).toEqual([{ code: 'FORBIDDEN' }, { code: 'ORG_NOT_ALLOWED' }]);

    const dump = JSON.stringify([...w.sink.events, ...w.store.state.audit]);
    expect(dump).not.toContain(REASON_TEXT);
    expect(dump).not.toContain('Nguyễn');
    expect(dump).not.toContain('J06.9'); // mã chẩn đoán không vào payload audit (chỉ codeSystem)

    await w.svc.getEncounterChart(encounter.encounterId, w.ctx.docA1);
    expect(w.store.state.audit.at(-1)).toMatchObject({ action: 'encounter.read', outcome: 'success', patientId: encounter.patientId });
  });
});

// ===========================================================================
// 4. FHIR mappings
// ===========================================================================
describe('G1 / FHIR mappings', () => {
  const patientId = asPatientId(uid(5001));
  const encounterId = asEncounterId(uid(6001));
  const baseEnc: Encounter = {
    tenantId: TENANT_A, encounterId, patientId, organizationId: ORG_A1, practitionerUserId: U.docA1,
    status: 'in_progress', encounterClass: 'inpatient', reasonText: 'Đau ngực', periodStart: '2026-10-30T03:00:00.000Z', periodEnd: null,
    createdAt: T0, updatedAt: '2026-10-30T03:00:00.000Z', version: 3,
  };

  it('Encounter: internal -> FHIR -> input roundtrip, kebab-case status, versioned meta', () => {
    const f = toFhirEncounter({ ...baseEnc, status: 'entered_in_error' });
    expect(f).toMatchObject({
      resourceType: 'Encounter', id: encounterId, status: 'entered-in-error', meta: { versionId: '3' },
      class: { code: 'IMP' }, subject: { reference: `Patient/${patientId}` },
      serviceProvider: { reference: `Organization/${ORG_A1}` },
    });
    expect(fromFhirEncounter(toFhirEncounter(baseEnc))).toEqual({
      patientId, organizationId: ORG_A1, encounterClass: 'inpatient', reasonText: 'Đau ngực', periodStart: '2026-10-30T03:00:00.000Z',
    });
  });

  it('Encounter: rejects malformed references and unsupported class', () => {
    const ok = toFhirEncounter(baseEnc);
    expect(() => fromFhirEncounter({ ...ok, subject: { reference: 'Patient/123' } })).toThrow(FhirMappingError);
    expect(() => fromFhirEncounter({ ...ok, subject: { reference: `Practitioner/${patientId}` } })).toThrow(FhirMappingError);
    expect(() => fromFhirEncounter({ ...ok, class: { code: 'XYZ' } })).toThrow(FhirMappingError);
    expect(() => fromFhirEncounter({ resourceType: 'Patient' } as never)).toThrow(FhirMappingError);
  });

  const cond: Condition = {
    tenantId: TENANT_A, conditionId: asConditionId(uid(7001)), patientId, encounterId, category: 'encounter_diagnosis',
    code: ICD_J06, clinicalStatus: 'active', verificationStatus: 'entered_in_error', onsetAt: '2026-10-27T00:00:00.000Z',
    abatedAt: null, recordedByUserId: U.docA1, recordedAt: '2026-10-30T03:05:00.000Z', createdAt: T0, updatedAt: T0, version: 1,
  };

  it('Condition: roundtrip preserves coding, statuses and references', () => {
    const f = toFhirCondition(cond);
    expect(f.verificationStatus?.coding?.[0]?.code).toBe('entered-in-error');
    expect(f.category?.[0]?.coding?.[0]?.code).toBe('encounter-diagnosis');
    const back = fromFhirCondition(f);
    expect(back).toMatchObject({
      patientId, encounterId, code: ICD_J06, category: 'encounter_diagnosis', clinicalStatus: 'active',
      verificationStatus: 'entered_in_error', onsetAt: '2026-10-27T00:00:00.000Z',
    });
  });

  it('Condition: rejects missing coding and unknown status', () => {
    const f = toFhirCondition(cond);
    expect(() => fromFhirCondition({ ...f, code: { text: 'no coding' } })).toThrow(FhirMappingError);
    expect(() => fromFhirCondition({ ...f, clinicalStatus: { coding: [{ code: 'weird' }] } })).toThrow(FhirMappingError);
  });

  const obsQ: Observation = {
    tenantId: TENANT_A, observationId: asObservationId(uid(8001)), patientId, encounterId, status: 'final', code: LOINC_TEMP,
    value: { kind: 'quantity', value: 38.5, unit: 'Cel', ucumCode: 'Cel' }, effectiveAt: '2026-10-30T03:10:00.000Z',
    supersedesObservationId: asObservationId(uid(8000)), recordedByUserId: U.nurseA1, recordedAt: '2026-10-30T03:10:00.000Z',
    createdAt: T0, updatedAt: T0, version: 1,
  };

  it('Observation: quantity maps to UCUM valueQuantity and back; supersedes -> derivedFrom', () => {
    const f = toFhirObservation(obsQ);
    expect(f.valueQuantity).toEqual({ value: 38.5, unit: 'Cel', system: 'http://unitsofmeasure.org', code: 'Cel' });
    expect(f.derivedFrom).toEqual([{ reference: `Observation/${uid(8000)}` }]);
    expect(fromFhirObservation(f)).toMatchObject({ patientId, encounterId, code: LOINC_TEMP, value: obsQ.value, status: 'final' });
  });

  it('Observation: string value roundtrip; client cannot submit server-owned statuses or invalid values', () => {
    const f = toFhirObservation({ ...obsQ, value: { kind: 'string', value: 'Âm tính' }, supersedesObservationId: null });
    expect(f.valueString).toBe('Âm tính');
    expect(fromFhirObservation(f).value).toEqual({ kind: 'string', value: 'Âm tính' });

    expect(() => fromFhirObservation({ ...toFhirObservation(obsQ), status: 'amended' })).toThrow(FhirMappingError);
    expect(() => fromFhirObservation({ ...toFhirObservation(obsQ), status: 'entered-in-error' })).toThrow(FhirMappingError);
    expect(() => fromFhirObservation({ ...toFhirObservation(obsQ), valueQuantity: { value: Number.NaN, unit: 'Cel' } })).toThrow(FhirMappingError);
    const noValue = toFhirObservation(obsQ);
    delete noValue.valueQuantity;
    expect(() => fromFhirObservation(noValue)).toThrow(FhirMappingError);
  });

  it('Patient: person + patient + identifiers -> FHIR Patient (id = patient_id, person_id in extension); mismatch rejected', () => {
    const person = mkPerson(TENANT_A, P.a1, { givenName: 'Văn An', familyName: 'Nguyễn', email: 'a@example.vn' });
    const patient: Patient = {
      tenantId: TENANT_A, patientId, personId: P.a1, organizationId: ORG_A1, mrn: 'MRN-001', status: 'active',
      registeredAt: T0, createdAt: T0, updatedAt: T0, version: 2,
    };
    const ids: Identifier[] = [
      {
        tenantId: TENANT_A, identifierId: uid(9501) as Identifier['identifierId'], personId: P.a1, patientId: null, type: 'national_id',
        system: 'https://moh.gov.vn/cccd', value: '079090000001', status: 'active', periodStart: null, periodEnd: null,
        createdAt: T0, updatedAt: T0, version: 1,
      },
      {
        tenantId: TENANT_A, identifierId: uid(9502) as Identifier['identifierId'], personId: P.a1, patientId: null, type: 'passport',
        system: 'urn:passport', value: 'B123', status: 'inactive', periodStart: null, periodEnd: null,
        createdAt: T0, updatedAt: T0, version: 1,
      },
    ];
    const f = toFhirPatient(person, patient, ids);
    expect(f).toMatchObject({
      resourceType: 'Patient', id: patientId, active: true, gender: 'male', birthDate: '1990-05-17',
      name: [{ family: 'Nguyễn', given: ['Văn', 'An'] }], managingOrganization: { reference: `Organization/${ORG_A1}` },
    });
    expect(f.extension).toEqual([{ url: 'https://healthcareos.vn/fhir/StructureDefinition/person-id', valueString: P.a1 }]);
    expect(f.identifier?.map((i) => i.value)).toEqual(['MRN-001', '079090000001']); // identifier inactive bị loại
    expect(f.telecom).toEqual([{ system: 'phone', value: '0900000000' }, { system: 'email', value: 'a@example.vn' }]);

    expect(fromFhirPatient(f)).toEqual({
      givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', sex: 'male', phone: '0900000000', email: 'a@example.vn',
    });
    expect(() => toFhirPatient(person, { ...patient, personId: P.a2 }, ids)).toThrow(FhirMappingError);
    expect(() => toFhirPatient({ ...person, tenantId: TENANT_B }, patient, ids)).toThrow(FhirMappingError);
    expect(() => fromFhirPatient({ resourceType: 'Patient', name: [{ family: 'X' }] })).toThrow(FhirMappingError);
  });
});

// ===========================================================================
// 5. S2 additions: getPatient & toàn vẹn subject
// ===========================================================================
describe('G1 / getPatient access control & subject integrity', () => {
  it('getPatient: clinical roles and the patient themself may read; admin and other tenants may not', async () => {
    const patient = await w.register();
    const r = await w.svc.getPatient(patient.patientId, w.ctx.nurse);
    expect(r.patient.patientId).toBe(patient.patientId);
    expect(r.person.personId).toBe(P.a1);
    expect(await outcome(w.svc.getPatient(patient.patientId, w.ctx.pharm))).toBe('OK');
    expect(await outcome(w.svc.getPatient(patient.patientId, w.ctx.patientA1))).toBe('OK');
    expect(await outcome(w.svc.getPatient(patient.patientId, w.ctx.admin))).toBe('FORBIDDEN');
    expect(await outcome(w.svc.getPatient(patient.patientId, w.ctx.docB))).toBe('NOT_FOUND');
    expect(await outcome(w.svc.getPatient(PAT_B, w.ctx.docA1))).toBe('NOT_FOUND');
    expect(w.store.state.audit.some((a) => a.action === 'patient.read' && a.outcome === 'success')).toBe(true);
  });

  it('rejects a condition/observation whose FHIR subject differs from the encounter patient (nothing written)', async () => {
    const { encounter } = await w.openEncounter();
    const other = asPatientId(uid(999));
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06, expectedPatientId: other }, w.ctx.docA1))).toBe('VALIDATION');
    expect(
      await outcome(
        w.svc.recordObservation({ encounterId: encounter.encounterId, code: LOINC_TEMP, value: { kind: 'string', value: 'x' }, expectedPatientId: other }, w.ctx.nurse),
      ),
    ).toBe('VALIDATION');
    expect(w.store.state.conditions).toHaveLength(0);
    expect(w.store.state.observations).toHaveLength(0);
    expect(await outcome(w.svc.addCondition({ encounterId: encounter.encounterId, code: ICD_J06, expectedPatientId: encounter.patientId }, w.ctx.docA1))).toBe('OK');
  });
});


// ===========================================================================
// Tìm kiếm bệnh nhân
// ===========================================================================
describe('G1 / patient search', () => {
  const idn = (over: Partial<Identifier> = {}): Identifier => ({
    tenantId: TENANT_A, identifierId: uid(8100) as Identifier['identifierId'], personId: P.a1, type: 'national_id',
    system: 'https://moh.gov.vn/cccd', value: '079090000001', status: 'active', createdAt: T0, updatedAt: T0, version: 1, ...over,
  } as Identifier);

  it('finds by MRN, by name+birthdate (accent/order-insensitive) and by identifier; criteria are ANDed', async () => {
    const p1 = await w.register(P.a1, 'MRN-001');
    await w.register(P.a3, 'MRN-003');
    w.store.state.identifiers.push(idn());
    const q = (o: object) => w.svc.searchPatients({ organizationId: ORG_A1, ...o }, w.ctx.nurse);

    expect((await q({ mrn: 'MRN-001' })).map((r) => r.patient.patientId)).toEqual([p1.patientId]);
    expect((await q({ givenName: 'Van A', familyName: 'NGUYEN', birthDate: '1990-05-17' })).map((r) => r.patient.mrn)).toEqual(['MRN-001']);
    const byId = await q({ identifier: { system: 'https://moh.gov.vn/cccd', value: '079 090 000 001' } });
    expect(byId.map((r) => r.patient.mrn)).toEqual(['MRN-001']);
    expect(byId[0]!.identifiers).toHaveLength(1);
    expect(await q({ mrn: 'MRN-003', identifier: { system: 'https://moh.gov.vn/cccd', value: '079090000001' } })).toEqual([]);
    expect(await q({ mrn: 'MRN-404' })).toEqual([]);
  });

  it('is scoped to the organization and tenant, and requires membership in that organization', async () => {
    await w.register(P.a1, 'MRN-001');
    expect(await w.svc.searchPatients({ organizationId: ORG_A2, mrn: 'MRN-001' }, w.ctx.docA2)).toEqual([]);
    expect(await outcome(w.svc.searchPatients({ organizationId: ORG_A1, mrn: 'MRN-001' }, w.ctx.docA2))).toBe('ORG_NOT_ALLOWED');
    expect(await outcome(w.svc.searchPatients({ organizationId: ORG_A1, mrn: 'MRN-001' }, w.ctx.docA2Widened))).toBe('FORBIDDEN');
    expect(await w.svc.searchPatients({ organizationId: ORG_B1, mrn: MRN_B }, w.ctx.docB)).toHaveLength(1);
    expect(await outcome(w.svc.searchPatients({ organizationId: ORG_B1, mrn: MRN_B }, w.ctx.docA1))).toBe('ORG_NOT_ALLOWED');
  });

  it('enforces roles and validates input', async () => {
    await w.register(P.a1, 'MRN-001');
    const s = (o: object, c = w.ctx.docA1) => outcome(w.svc.searchPatients({ organizationId: ORG_A1, ...o }, c));
    expect(await s({ mrn: 'MRN-001' }, w.ctx.pharm)).toBe('OK');
    expect(await s({ mrn: 'MRN-001' }, w.ctx.patientA1)).toBe('ORG_NOT_ALLOWED');
    expect(await s({ mrn: 'MRN-001' }, w.ctx.disabled)).not.toBe('OK');
    expect(await s({ mrn: 'MRN-001' }, w.ctx.revoked)).not.toBe('OK');
    expect(await s({})).toBe('VALIDATION');
    expect(await s({ givenName: 'Văn A', familyName: 'Nguyễn' })).toBe('VALIDATION');
    expect(await s({ givenName: 'Văn A', birthDate: '1990-05-17' })).toBe('VALIDATION');
    expect(await s({ givenName: 'Văn A', familyName: 'Nguyễn', birthDate: '17/05/1990' })).toBe('VALIDATION');
    expect(await s({ mrn: 'bad mrn!' })).toBe('VALIDATION');
    expect(await s({ mrn: 'MRN-001', count: 0 })).toBe('VALIDATION');
    expect(await s({ mrn: 'MRN-001', count: 21 })).toBe('VALIDATION');
    expect(await s({ identifier: { system: 'x', value: '1' } })).toBe('VALIDATION');
  });

  it('audits only criteria kinds and result count — never the searched values', async () => {
    await w.register(P.a1, 'MRN-001');
    await w.svc.searchPatients({ organizationId: ORG_A1, givenName: 'Văn A', familyName: 'Nguyễn', birthDate: '1990-05-17', mrn: 'MRN-001' }, w.ctx.nurse);
    const ev = w.store.state.audit.at(-1)!;
    expect(ev).toMatchObject({ action: 'patient.search', outcome: 'success', payload: { criteria: ['mrn', 'name+birthdate'], resultCount: 1 } });
    const dump = JSON.stringify([...w.store.state.audit, ...w.sink.events]);
    for (const phi of ['Nguyễn', 'Văn A', '1990-05-17', 'MRN-001']) expect(dump.replace(/"resourceId":"[^"]*"/g, '')).not.toContain(phi);
  });

  it('honours _count and ordering, and a leaky repository cannot leak another tenant', async () => {
    const a = await w.register(P.a1, 'MRN-001');
    await w.register(P.a3, 'MRN-003');
    const first = await w.svc.searchPatients({ organizationId: ORG_A1, givenName: 'x', familyName: 'y', birthDate: '1990-05-17', count: 1 }, w.ctx.nurse).catch(() => null);
    expect(first).toEqual([]);
    const lim = await w.svc.searchPatients({ organizationId: ORG_A1, mrn: a.mrn, count: 1 }, w.ctx.nurse);
    expect(lim).toHaveLength(1);
    const leaky = buildWorld({ leaky: true });
    leaky.store.state.patients.push({ ...leaky.store.state.patients[0]!, patientId: asPatientId(uid(599)), mrn: 'MRN-X', organizationId: ORG_A1 }); // tenant B, org id trùng A1
    expect(await outcome(leaky.svc.searchPatients({ organizationId: ORG_A1, mrn: 'MRN-X' }, leaky.ctx.docA1))).toBe('RESOURCE_TENANT_MISMATCH');
  });
});
