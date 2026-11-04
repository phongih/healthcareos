/**
 * HCOS-P0-ENG-001 | Person Registry | Unit tests (Vitest)
 *
 * Phần 1: logic thuần (chuẩn hoá, validate định danh, chấm điểm trùng).
 * Phần 2: PersonRegistryService trên repository in-memory mô phỏng ràng buộc DB (unique định danh active,
 *         unique person+org, kiểm tra version, merge guard) + rollback transaction.
 * Ràng buộc ở tầng PostgreSQL thật được kiểm ở tests/integration/registry-pg.integration.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  asOrganizationId, asPatientId, asPersonId, asTenantId, asUserId, VersionConflictError,
  type AuditSink, type CorrelationId, type Identifier, type Membership, type NewAuditEvent, type OrganizationId,
  type Patient, type Person, type PersonId, type Role, type TenantContext, type TenantId, type User, type UserId,
} from '../../packages/domain/src/s0-contracts';
import {
  RegistryValidationError, foldText, identifierKey, levenshtein, nameKey, normalizeIdentifier, normalizePhone, scoreMatch,
  type PersonMergeRecord,
} from '../../packages/domain/src/person-registry';
import { ClinicalError, type OutboxDraft } from '../../services/api/src/clinical/encounter.service';
import {
  PersonRegistryService,
  type CandidateQuery, type IdentifierMatch, type PersonKeys, type RegistryRepository, type RegistryUnitOfWork, type SurvivorPatch,
} from '../../services/api/src/registry/person-registry.service';

type Mut<T> = { -readonly [K in keyof T]: T[K] };

// ===========================================================================
// Phần 1 — logic thuần
// ===========================================================================
describe('registry / normalization', () => {
  it('folds Vietnamese diacritics (including đ/Đ) and is order-insensitive for name keys', () => {
    expect(foldText('Nguyễn Văn Đức')).toBe('nguyen van duc');
    expect(nameKey('Văn Đức', 'Nguyễn')).toBe('duc nguyen van');
    expect(nameKey('Đức Văn', 'Nguyễn')).toBe(nameKey('Văn Đức', 'Nguyễn'));
    expect(nameKey('Van Duc', 'Nguyen')).toBe(nameKey('Văn Đức', 'Nguyễn'));
  });

  it('normalizes Vietnamese phone numbers and rejects invalid ones', () => {
    expect(normalizePhone('+84 912 345 678')).toBe('0912345678');
    expect(normalizePhone('0912-345-678')).toBe('0912345678');
    expect(normalizePhone('84912345678')).toBe('0912345678');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('validates and normalizes identifiers by type', () => {
    const base = { system: 'https://moh.gov.vn/id' };
    expect(normalizeIdentifier({ ...base, type: 'national_id', value: '079 090 000 001' }).value).toBe('079090000001');
    expect(normalizeIdentifier({ ...base, type: 'national_id', value: '123456789' }).value).toBe('123456789');
    expect(normalizeIdentifier({ ...base, type: 'health_insurance', value: 'ab-1234567890123' }).value).toBe('AB1234567890123');
    expect(normalizeIdentifier({ ...base, type: 'passport', value: 'b 1234567' }).value).toBe('B1234567');
    expect(normalizeIdentifier({ ...base, type: 'phone', value: '+84912345678' }).value).toBe('0912345678');
    for (const bad of [
      { ...base, type: 'national_id' as const, value: '12345678901' },
      { ...base, type: 'health_insurance' as const, value: '123' },
      { ...base, type: 'national_id' as const, value: '079090000001', system: 'not a uri' },
      { ...base, type: 'mrn' as never, value: 'MRN-1' },
      { ...base, type: 'external' as const, value: 'has space' },
      { ...base, type: 'national_id' as const, value: '079090000001', periodStart: '2026-02-01', periodEnd: '2026-01-01' },
    ]) {
      expect(() => normalizeIdentifier(bad)).toThrow(RegistryValidationError);
    }
  });
});

describe('registry / match scoring', () => {
  const base = { nameKey: nameKey('Văn An', 'Nguyễn'), birthDate: '1990-05-17', phoneKey: '0912345678' };

  it('levenshtein basics', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('grades matches: identifier=definite, name+dob / dob+phone / name+phone=probable, fuzzy=possible, weak=none', () => {
    expect(scoreMatch(base, { ...base, nameKey: 'x', birthDate: null, phoneKey: null, sharesIdentifier: true })).toMatchObject({ score: 100, level: 'definite' });
    expect(scoreMatch(base, { ...base, phoneKey: null })).toMatchObject({ score: 90, level: 'probable', reasons: ['NAME_DOB_MATCH'] });
    expect(scoreMatch(base, { ...base, nameKey: 'khac hoan toan' })).toMatchObject({ score: 85, level: 'probable', reasons: ['DOB_PHONE_MATCH'] });
    expect(scoreMatch(base, { ...base, birthDate: '1991-01-01' })).toMatchObject({ score: 80, level: 'probable', reasons: ['NAME_PHONE_MATCH'] });
    // Sai chính tả nhẹ + cùng ngày sinh => possible
    const typo = { ...base, nameKey: nameKey('Văn Anh', 'Nguyễn'), phoneKey: null };
    expect(scoreMatch({ ...base, phoneKey: null }, typo)).toMatchObject({ score: 70, level: 'possible', reasons: ['FUZZY_NAME_DOB'] });
    // Chỉ trùng ngày sinh, hoặc trùng tên khác ngày sinh/SĐT => không phải ứng viên
    expect(scoreMatch(base, { nameKey: 'abc def', birthDate: '1990-05-17', phoneKey: null }).level).toBeNull();
    expect(scoreMatch(base, { ...base, birthDate: '1980-01-01', phoneKey: null }).level).toBeNull();
    expect(scoreMatch({ nameKey: '', birthDate: null, phoneKey: null }, { nameKey: '', birthDate: null, phoneKey: null }).level).toBeNull();
  });
});

// ===========================================================================
// Phần 2 — service
// ===========================================================================
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const TA = asTenantId(uid(1));
const TB = asTenantId(uid(2));
const OA = asOrganizationId(uid(11));
const OA2 = asOrganizationId(uid(12));
const OB = asOrganizationId(uid(13));
const U = {
  nurse: asUserId(uid(101)), doctor: asUserId(uid(102)), pharm: asUserId(uid(103)), clinicAdmin: asUserId(uid(104)),
  tenantAdmin: asUserId(uid(105)), patientUser: asUserId(uid(106)), disabled: asUserId(uid(107)), nurseB: asUserId(uid(201)),
};
const subject = (u: string) => `sub-${u}`;
const CCCD = { type: 'national_id' as const, system: 'https://moh.gov.vn/cccd', value: '079090000001' };
const BHYT = { type: 'health_insurance' as const, system: 'https://bhxh.gov.vn/bhyt', value: 'DN4797912345678' };
const AN = { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', sex: 'male' as const, phone: '0912345678' };

interface State {
  persons: Mut<Person>[]; keys: Record<string, PersonKeys>; identifiers: Mut<Identifier>[]; patients: Mut<Patient>[]; users: Mut<User>[];
  memberships: Membership[]; merges: PersonMergeRecord[]; outbox: Array<OutboxDraft & { tenantId: TenantId }>; audit: NewAuditEvent[];
}

class Store {
  state: State = { persons: [], keys: {}, identifiers: [], patients: [], users: [], memberships: [], merges: [], outbox: [], audit: [] };
  /** Gây lỗi giữa chừng để kiểm tra rollback. */
  failAt: string | null = null;
}

class MemRepo implements RegistryRepository {
  constructor(private readonly st: Store, private readonly tenantId: TenantId) {}
  private get s() { return this.st.state; }
  private vis<T extends { tenantId: string }>(xs: T[]): T[] { return xs.filter((x) => x.tenantId === this.tenantId); }
  private maybeFail(point: string) { if (this.st.failAt === point) throw new Error(`injected failure at ${point}`); }

  async findUserBySubject(sub: string) { return this.vis(this.s.users).find((u) => u.externalSubject === sub) ?? null; }
  async listMemberships(userId: UserId) { return this.vis(this.s.memberships).filter((m) => m.userId === userId); }
  async findPerson(id: PersonId) { const p = this.vis(this.s.persons).find((x) => x.personId === id); return p ? { ...p } : null; }
  async insertPerson(p: Person, keys: PersonKeys) {
    if (p.tenantId !== this.tenantId) throw Object.assign(new Error('rls'), { code: '42501' });
    this.s.persons.push({ ...p }); this.s.keys[p.personId] = keys;
  }
  async findCandidates(q: CandidateQuery) {
    return this.vis(this.s.persons).filter((p) => p.status === 'active' && (
      (q.birthDate !== null && p.birthDate === q.birthDate) ||
      (q.phoneKey !== null && this.s.keys[p.personId]?.phoneKey === q.phoneKey) ||
      (q.nameKey !== null && this.s.keys[p.personId]?.nameKey === q.nameKey))).map((p) => ({ ...p }));
  }
  async findIdentifierMatches(keys: ReadonlyArray<{ system: string; value: string }>): Promise<IdentifierMatch[]> {
    const wanted = new Set(keys.map((k) => identifierKey(k.system, k.value)));
    return this.vis(this.s.identifiers)
      .filter((i) => i.status === 'active' && wanted.has(identifierKey(i.system, i.value)))
      .map((i) => ({ personId: i.personId, system: i.system, value: i.value }));
  }
  async listIdentifiers(personId: PersonId) { return this.vis(this.s.identifiers).filter((i) => i.personId === personId).map((i) => ({ ...i })); }
  async insertIdentifier(i: Identifier) {
    if (i.tenantId !== this.tenantId) throw Object.assign(new Error('rls'), { code: '42501' });
    if (i.status === 'active' && this.s.identifiers.some((x) => x.tenantId === i.tenantId && x.status === 'active' && x.system === i.system && x.value === i.value)) {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'IDENTIFIER_TAKEN' });
    }
    this.s.identifiers.push({ ...i });
  }
  async findIdentifier(id: string) { const i = this.vis(this.s.identifiers).find((x) => x.identifierId === id); return i ? { ...i } : null; }
  async updateIdentifierStatus(id: string, status: 'inactive' | 'entered_in_error', v: number) {
    const i = this.vis(this.s.identifiers).find((x) => x.identifierId === id);
    if (!i || i.version !== v) return null;
    Object.assign(i, { status, version: v + 1 });
    return { ...i };
  }
  async listPatientsByPerson(personId: PersonId) { return this.vis(this.s.patients).filter((p) => p.personId === personId).map((p) => ({ ...p })); }
  async markPersonMerged(sourceId: PersonId, targetId: PersonId, v: number) {
    const src = this.vis(this.s.persons).find((p) => p.personId === sourceId);
    if (!src || src.status !== 'active' || src.version !== v) return null;
    const tgt = this.vis(this.s.persons).find((p) => p.personId === targetId);
    if (!tgt || tgt.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Operation not allowed in current state');
    Object.assign(src, { status: 'merged', mergedIntoPersonId: targetId, version: v + 1 });
    return { ...src };
  }
  async patchSurvivor(targetId: PersonId, p: SurvivorPatch, v: number) {
    const t = this.vis(this.s.persons).find((x) => x.personId === targetId);
    if (!t || t.status !== 'active' || t.version !== v) return null;
    t.birthDate = t.birthDate ?? p.birthDate; t.sex = t.sex ?? p.sex; t.phone = t.phone ?? p.phone; t.email = t.email ?? p.email;
    const k = this.s.keys[targetId]; if (k && k.phoneKey === null && p.phoneKey !== null) this.s.keys[targetId] = { ...k, phoneKey: p.phoneKey };
    t.version = v + 1;
    return { ...t };
  }
  async movePatients(sourceId: PersonId, targetId: PersonId) {
    this.maybeFail('movePatients');
    const moved: Patient['patientId'][] = [];
    for (const p of this.vis(this.s.patients).filter((x) => x.personId === sourceId)) {
      if (this.s.patients.some((x) => x.tenantId === p.tenantId && x.personId === targetId && x.organizationId === p.organizationId)) {
        throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'UNIQUE_VIOLATION' });
      }
      p.personId = targetId; moved.push(p.patientId);
    }
    return moved.sort();
  }
  async moveIdentifier(id: string, toPersonId: PersonId, v: number) {
    this.maybeFail('moveIdentifier');
    const i = this.vis(this.s.identifiers).find((x) => x.identifierId === id);
    if (!i || i.version !== v) return false;
    i.personId = toPersonId; i.version = v + 1;
    return true;
  }
  async repointUsers(sourceId: PersonId, targetId: PersonId) {
    const hit = this.vis(this.s.users).filter((u) => u.personId === sourceId);
    hit.forEach((u) => { u.personId = targetId; });
    return hit.map((u) => u.userId).sort();
  }
  async insertMergeRecord(r: PersonMergeRecord) {
    if (this.s.merges.some((m) => m.tenantId === r.tenantId && m.sourcePersonId === r.sourcePersonId)) {
      throw new ClinicalError('CONFLICT', 'Conflicting record', { reason: 'ALREADY_MERGED' });
    }
    this.s.merges.push(r);
  }
  async enqueueOutbox(tenantId: TenantId, ev: OutboxDraft) { this.s.outbox.push({ ...ev, tenantId }); }
  async appendAudit(ev: NewAuditEvent) { this.s.audit.push(ev); }
}

class MemUow implements RegistryUnitOfWork {
  constructor(private readonly st: Store) {}
  async run<T>(ctx: TenantContext, fn: (r: RegistryRepository) => Promise<T>): Promise<T> {
    const snap = structuredClone(this.st.state);
    try { return await fn(new MemRepo(this.st, ctx.tenantId)); }
    catch (e) { Object.assign(this.st.state, snap); throw e; } // khôi phục TẠI CHỖ để mọi tham chiếu `w.s` vẫn hợp lệ
  }
}

class Sink implements AuditSink { events: NewAuditEvent[] = []; async record(e: NewAuditEvent) { this.events.push(e); } }

const mkUser = (userId: UserId, tenantId: TenantId, over: Partial<User> = {}): User => ({
  tenantId, userId, externalSubject: subject(userId), email: null, displayName: 'u', personId: null, status: 'active',
  lastLoginAt: null, createdAt: T0, updatedAt: T0, version: 1, ...over,
});
let mseq = 900;
const mkMember = (tenantId: TenantId, userId: UserId, organizationId: OrganizationId, role: Role): Membership => ({
  tenantId, membershipId: uid(mseq++) as unknown as Membership['membershipId'], userId, organizationId, role,
  status: 'active', validFrom: T0, validTo: null, createdAt: T0, updatedAt: T0, version: 1,
});
const mkCtx = (tenantId: TenantId, user: UserId, orgs: OrganizationId[]): TenantContext => Object.freeze({
  tenantId, userSubject: subject(user), userId: null, personId: null, activeOrganizationId: orgs[0] ?? null,
  allowedOrganizationIds: Object.freeze([...orgs]), roles: Object.freeze([]), tokenId: null, correlationId: 'corr' as CorrelationId,
});

let seq = 5000;
function world() {
  const store = new Store();
  const sink = new Sink();
  seq = 5000;
  const svc = new PersonRegistryService({
    uow: new MemUow(store), audit: sink, clock: () => new Date('2026-10-30T03:00:00.000Z'), newId: () => uid(seq++),
  });
  const s = store.state;
  s.users.push(
    mkUser(U.nurse, TA), mkUser(U.doctor, TA), mkUser(U.pharm, TA), mkUser(U.clinicAdmin, TA), mkUser(U.tenantAdmin, TA),
    mkUser(U.patientUser, TA), mkUser(U.disabled, TA, { status: 'disabled' }), mkUser(U.nurseB, TB),
  );
  s.memberships.push(
    mkMember(TA, U.nurse, OA, 'clinic_staff'), mkMember(TA, U.doctor, OA, 'doctor'), mkMember(TA, U.pharm, OA, 'pharmacist'),
    mkMember(TA, U.clinicAdmin, OA, 'clinic_admin'), mkMember(TA, U.tenantAdmin, OA, 'tenant_admin'),
    mkMember(TA, U.patientUser, OA, 'patient'), mkMember(TA, U.disabled, OA, 'clinic_staff'), mkMember(TB, U.nurseB, OB, 'clinic_staff'),
  );
  const ctx = {
    nurse: mkCtx(TA, U.nurse, [OA]), doctor: mkCtx(TA, U.doctor, [OA]), pharm: mkCtx(TA, U.pharm, [OA]),
    clinicAdmin: mkCtx(TA, U.clinicAdmin, [OA]), tenantAdmin: mkCtx(TA, U.tenantAdmin, []), patientUser: mkCtx(TA, U.patientUser, []),
    disabled: mkCtx(TA, U.disabled, [OA]), nurseNoOrg: mkCtx(TA, U.nurse, []), nurseOtherOrg: mkCtx(TA, U.nurse, [OA2]),
    ghost: Object.freeze({ ...mkCtx(TA, U.nurse, [OA]), userSubject: 'sub-ghost' }) as TenantContext, nurseB: mkCtx(TB, U.nurseB, [OB]),
  };
  const addPatient = (personId: PersonId, org: OrganizationId, n: number): Patient => {
    const p: Patient = { tenantId: TA, patientId: asPatientId(uid(7000 + n)), personId, organizationId: org, mrn: `MRN-${n}`, status: 'active', registeredAt: T0, createdAt: T0, updatedAt: T0, version: 1 };
    s.patients.push(p); return p;
  };
  return { store, sink, svc, ctx, s, addPatient };
}

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'OK', (e: { code?: string; name?: string; details?: { reason?: string } }) =>
    e.details?.reason ? `${e.code}:${e.details.reason}` : e.code ?? e.name ?? 'ERR');

let w: ReturnType<typeof world>;
beforeEach(() => { w = world(); });

describe('registry / createPerson', () => {
  it('creates a person with normalized identifiers, outbox event and a PHI-free audit record', async () => {
    const r = await w.svc.createPerson({ ...AN, identifiers: [{ ...CCCD, value: '079 090 000 001' }, BHYT] }, w.ctx.nurse);
    expect(r.person).toMatchObject({ tenantId: TA, givenName: 'Văn An', familyName: 'Nguyễn', status: 'active', version: 1, phone: '0912345678' });
    expect(r.identifiers.map((i) => i.value)).toEqual(['079090000001', 'DN4797912345678']);
    expect(w.s.keys[r.person.personId]).toEqual({ nameKey: 'an nguyen van', phoneKey: '0912345678' });
    expect(w.s.outbox.map((o) => o.eventType)).toEqual(['patient.person.created']);
    const dump = JSON.stringify(w.s.audit);
    for (const phi of ['Nguyễn', 'Văn An', '079090000001', 'DN4797912345678', '0912345678', '1990-05-17']) expect(dump).not.toContain(phi);
    expect(w.s.audit[0]).toMatchObject({ action: 'person.create', outcome: 'success', personId: r.person.personId });
  });

  it('blocks probable duplicates (accent-insensitive, order-insensitive) and returns ranked candidates', async () => {
    const first = await w.svc.createPerson({ ...AN, phone: null }, w.ctx.nurse);
    const err = await w.svc.createPerson({ givenName: 'Van An', familyName: 'Nguyen', birthDate: '1990-05-17' }, w.ctx.nurse).catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { reason: 'DUPLICATE_CANDIDATES' } });
    expect(err.details.candidates).toEqual([{ personId: first.person.personId, score: 90, level: 'probable', reasons: ['NAME_DOB_MATCH'] }]);
    const swapped = await code(w.svc.createPerson({ givenName: 'Nguyễn', familyName: 'An Văn', birthDate: '1990-05-17' }, w.ctx.nurse));
    expect(swapped).toBe('CONFLICT:DUPLICATE_CANDIDATES');
    expect(w.s.persons).toHaveLength(1);
  });

  it('allows an explicit override with a reason (recorded in audit), but never overrides an identifier clash', async () => {
    await w.svc.createPerson({ ...AN, identifiers: [CCCD] }, w.ctx.nurse);
    const twin = { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17' };
    expect(await code(w.svc.createPerson({ ...twin, duplicateOverride: { reason: 'ok' } }, w.ctx.nurse))).toBe('VALIDATION');
    const ok = await w.svc.createPerson({ ...twin, duplicateOverride: { reason: 'Hai người khác nhau, đã đối chiếu CCCD' } }, w.ctx.nurse);
    expect(ok.person.personId).toBeTruthy();
    expect(w.s.audit.at(-1)!.payload).toMatchObject({ overrideUsed: true, overrideReason: 'Hai người khác nhau, đã đối chiếu CCCD' });

    const clash = await code(w.svc.createPerson({ givenName: 'Khác', familyName: 'Hẳn', identifiers: [CCCD], duplicateOverride: { reason: 'cố tình tạo trùng' } }, w.ctx.nurse));
    expect(clash).toBe('CONFLICT:IDENTIFIER_TAKEN');
  });

  it('reports possible (non-blocking) duplicates and creates the person', async () => {
    await w.svc.createPerson({ ...AN, phone: null }, w.ctx.nurse);
    const r = await w.svc.createPerson({ givenName: 'Văn Anh', familyName: 'Nguyễn', birthDate: '1990-05-17' }, w.ctx.nurse);
    expect(r.possibleDuplicates).toHaveLength(1);
    expect(r.possibleDuplicates[0]).toMatchObject({ level: 'possible', reasons: ['FUZZY_NAME_DOB'] });
  });

  it('does not see or collide with another tenant', async () => {
    await w.svc.createPerson({ ...AN, identifiers: [CCCD] }, w.ctx.nurse);
    const b = await w.svc.createPerson({ ...AN, identifiers: [CCCD] }, w.ctx.nurseB);
    expect(b.person.tenantId).toBe(TB);
    expect(b.possibleDuplicates).toEqual([]);
  });

  it('rejects invalid input and writes nothing', async () => {
    const before = structuredClone(w.store.state);
    const bad = [
      { ...AN, email: 'not-an-email' }, { ...AN, birthDate: '2999-01-01' }, { ...AN, birthDate: '1990-02-31' }, { ...AN, phone: '12' },
      { ...AN, givenName: '   ' }, { ...AN, givenName: 'a<b>' }, { ...AN, sex: 'x' as never },
      { ...AN, identifiers: [{ ...CCCD, value: '123' }] }, { ...AN, identifiers: [CCCD, CCCD] },
      { ...AN, identifiers: Array.from({ length: 11 }, (_, i) => ({ type: 'external' as const, system: 'urn:x', value: `v${i}` })) },
    ];
    for (const b of bad) expect(await code(w.svc.createPerson(b, w.ctx.nurse))).toBe('VALIDATION');
    expect(w.store.state.persons).toEqual(before.persons);
    expect(w.store.state.outbox).toEqual([]);
  });

  it('authorization: only create-capable roles with a valid membership inside the token org scope', async () => {
    expect(await code(w.svc.createPerson(AN, w.ctx.doctor))).toBe('OK');
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'B', birthDate: '1980-01-01' }, w.ctx.pharm))).toBe('FORBIDDEN');
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'C', birthDate: '1981-01-01' }, w.ctx.patientUser))).toBe('FORBIDDEN');
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'D', birthDate: '1982-01-01' }, w.ctx.tenantAdmin))).toBe('FORBIDDEN');
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'E', birthDate: '1983-01-01' }, w.ctx.disabled))).toBe('FORBIDDEN');
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'F', birthDate: '1984-01-01' }, w.ctx.ghost))).toBe('FORBIDDEN');
    // Token không chứa org của membership => không có vai trò hiệu lực.
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'G', birthDate: '1985-01-01' }, w.ctx.nurseNoOrg))).toBe('FORBIDDEN');
    expect(await code(w.svc.createPerson({ ...AN, givenName: 'H', birthDate: '1986-01-01' }, w.ctx.nurseOtherOrg))).toBe('FORBIDDEN');
    expect(w.sink.events.filter((e) => e.outcome === 'denied').length).toBe(7);
  });
});

describe('registry / findDuplicates', () => {
  it('finds by identifier, by name+dob, by dob+phone; pharmacist may search; requires a search field', async () => {
    const a = await w.svc.createPerson({ ...AN, identifiers: [CCCD] }, w.ctx.nurse);
    const byId = await w.svc.findDuplicates({ identifiers: [CCCD] }, w.ctx.pharm);
    expect(byId).toEqual([{ personId: a.person.personId, score: 100, level: 'definite', reasons: ['IDENTIFIER_MATCH'] }]);
    const byNameDob = await w.svc.findDuplicates({ givenName: 'An', familyName: 'Nguyen Van', birthDate: '1990-05-17' }, w.ctx.nurse);
    expect(byNameDob[0]).toMatchObject({ personId: a.person.personId, level: 'probable' });
    const byDobPhone = await w.svc.findDuplicates({ birthDate: '1990-05-17', phone: '+84 912 345 678' }, w.ctx.nurse);
    expect(byDobPhone[0]).toMatchObject({ reasons: ['DOB_PHONE_MATCH'] });
    expect(await code(w.svc.findDuplicates({}, w.ctx.nurse))).toBe('VALIDATION');
    expect(await code(w.svc.findDuplicates({ birthDate: '1990-05-17' }, w.ctx.patientUser))).toBe('FORBIDDEN');
    expect(await w.svc.findDuplicates({ identifiers: [CCCD] }, w.ctx.nurseB)).toEqual([]);
  });
});

describe('registry / identifiers', () => {
  it('adds identifiers, rejects an identifier owned by another active person, and frees it after retirement', async () => {
    const p1 = (await w.svc.createPerson({ ...AN, identifiers: [CCCD] }, w.ctx.nurse)).person;
    const p2 = (await w.svc.createPerson({ givenName: 'Thị Bình', familyName: 'Trần', birthDate: '1985-03-03' }, w.ctx.nurse)).person;

    expect(await code(w.svc.addIdentifier(p2.personId, CCCD, w.ctx.nurse))).toBe('CONFLICT:IDENTIFIER_TAKEN');
    const added = await w.svc.addIdentifier(p2.personId, BHYT, w.ctx.nurse);
    expect(added).toMatchObject({ personId: p2.personId, patientId: null, type: 'health_insurance', status: 'active', version: 1 });
    expect(JSON.stringify(w.s.audit.at(-1))).not.toContain(BHYT.value);

    const cccdId = w.s.identifiers.find((i) => i.personId === p1.personId)!.identifierId;
    expect(await code(w.svc.retireIdentifier(cccdId, 'inactive', 9, w.ctx.nurse))).toBe('VersionConflictError');
    expect((await w.svc.retireIdentifier(cccdId, 'inactive', 1, w.ctx.nurse)).status).toBe('inactive');
    expect(await code(w.svc.retireIdentifier(cccdId, 'inactive', 2, w.ctx.nurse))).toBe('INVALID_STATE');
    expect(await code(w.svc.addIdentifier(p2.personId, CCCD, w.ctx.nurse))).toBe('OK');
  });

  it('guards: unknown/cross-tenant person, merged person, role', async () => {
    const p = (await w.svc.createPerson(AN, w.ctx.nurse)).person;
    expect(await code(w.svc.addIdentifier(asPersonId(uid(9999)), CCCD, w.ctx.nurse))).toBe('NOT_FOUND');
    expect(await code(w.svc.addIdentifier(p.personId, CCCD, w.ctx.nurseB))).toBe('NOT_FOUND');
    expect(await code(w.svc.addIdentifier(p.personId, CCCD, w.ctx.pharm))).toBe('FORBIDDEN');
    expect(await code(w.svc.addIdentifier(p.personId, { ...CCCD, value: '1' }, w.ctx.nurse))).toBe('VALIDATION');
    w.s.persons.find((x) => x.personId === p.personId)!.status = 'merged';
    expect(await code(w.svc.addIdentifier(p.personId, CCCD, w.ctx.nurse))).toBe('INVALID_STATE');
  });
});

/** Tạo source+target với đủ dữ liệu liên quan để kiểm tra merge. */
async function mergeFixture() {
  const target = (await w.svc.createPerson({ givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', identifiers: [BHYT] }, w.ctx.nurse)).person;
  const source = (await w.svc.createPerson({
    givenName: 'Nguyen', familyName: 'Van An', birthDate: '1990-05-17', sex: 'male', phone: '0987654321', email: 'an@example.vn',
    identifiers: [CCCD, BHYT].map((i, k) => (k === 1 ? { ...i } : i)).slice(0, 1),
    duplicateOverride: { reason: 'Khai báo trùng khi tiếp nhận' },
  }, w.ctx.nurse)).person;
  // Source cũng có BHYT giống target: chèn trực tiếp (mô phỏng dữ liệu cũ trước khi có ràng buộc đối sánh).
  w.s.identifiers.push({
    tenantId: TA, identifierId: uid(8500) as Identifier['identifierId'], personId: source.personId, patientId: null, type: 'health_insurance',
    system: BHYT.system, value: BHYT.value, status: 'inactive', periodStart: null, periodEnd: null, createdAt: T0, updatedAt: T0, version: 1,
  });
  const dupe = w.s.identifiers.at(-1)!;
  dupe.status = 'active'; // mô phỏng định danh trùng giữa hai person (đã tồn tại do import cũ)
  w.s.users.find((u) => u.userId === U.patientUser)!.personId = source.personId;
  const patient = w.addPatient(source.personId, OA, 1);
  return { source, target, patient, dupe };
}

describe('registry / mergePersons', () => {
  it('merges atomically: patients, identifiers, users move; duplicates retire; survivor fills blanks; history is recorded', async () => {
    const { source, target, patient, dupe } = await mergeFixture();
    const cccdId = w.s.identifiers.find((i) => i.personId === source.personId && i.type === 'national_id')!.identifierId;

    const r = await w.svc.mergePersons(
      { sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'Cùng một người, đối chiếu CCCD', expectedSourceVersion: source.version, expectedTargetVersion: target.version },
      w.ctx.clinicAdmin,
    );
    expect(r).toMatchObject({ sourcePersonId: source.personId, targetPersonId: target.personId });
    expect(r.movedPatientIds).toEqual([patient.patientId]);
    expect(r.movedIdentifierIds).toEqual([cccdId]);
    expect(r.retiredIdentifierIds).toEqual([dupe.identifierId]);
    expect(r.repointedUserIds).toEqual([U.patientUser]);

    const s = w.s.persons.find((p) => p.personId === source.personId)!;
    const t = w.s.persons.find((p) => p.personId === target.personId)!;
    expect(s).toMatchObject({ status: 'merged', mergedIntoPersonId: target.personId });
    expect(t).toMatchObject({ status: 'active', version: target.version + 1, sex: 'male', phone: '0987654321', email: 'an@example.vn', givenName: 'Văn An' });
    expect(w.s.keys[target.personId]!.phoneKey).toBe('0987654321');
    expect(w.s.patients.find((p) => p.patientId === patient.patientId)!.personId).toBe(target.personId);
    expect(w.s.identifiers.find((i) => i.identifierId === cccdId)!.personId).toBe(target.personId);
    expect(w.s.identifiers.find((i) => i.identifierId === dupe.identifierId)).toMatchObject({ status: 'inactive', personId: source.personId });
    expect(w.s.users.find((u) => u.userId === U.patientUser)!.personId).toBe(target.personId);

    expect(w.s.merges).toHaveLength(1);
    expect(w.s.merges[0]).toMatchObject({ sourcePersonId: source.personId, targetPersonId: target.personId, mergedByUserId: U.clinicAdmin, reason: 'Cùng một người, đối chiếu CCCD' });
    expect(w.s.outbox.at(-1)).toMatchObject({ eventType: 'patient.person.merged' });
    const audit = w.s.audit.at(-1)!;
    expect(audit).toMatchObject({ action: 'person.merge', outcome: 'success', payload: { movedPatients: 1, movedIdentifiers: 1, retiredIdentifiers: 1, repointedUsers: 1 } });
    expect(JSON.stringify(audit)).not.toContain('079090000001');
  });

  it('after a merge the old person_id resolves to the survivor (also across chained merges)', async () => {
    const { source, target } = await mergeFixture();
    await w.svc.mergePersons({ sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'trùng hồ sơ', expectedSourceVersion: source.version, expectedTargetVersion: target.version }, w.ctx.tenantAdmin);
    const via = await w.svc.getPerson(source.personId, w.ctx.pharm);
    expect(via).toMatchObject({ redirectedFrom: source.personId });
    expect(via.person.personId).toBe(target.personId);

    const third = (await w.svc.createPerson({ givenName: 'Hoàn Toàn', familyName: 'Khác', birthDate: '1970-01-01' }, w.ctx.nurse)).person;
    const tNow = w.s.persons.find((p) => p.personId === target.personId)!;
    await w.svc.mergePersons({ sourcePersonId: target.personId, targetPersonId: third.personId, reason: 'gộp lần hai', expectedSourceVersion: tNow.version, expectedTargetVersion: third.version }, w.ctx.clinicAdmin);
    expect((await w.svc.getPerson(source.personId, w.ctx.pharm)).person.personId).toBe(third.personId);
    // Người dùng bệnh nhân được trỏ theo chuỗi merge: đọc được hồ sơ của chính mình.
    expect(await code(w.svc.getPerson(source.personId, w.ctx.patientUser))).toBe('OK');
  });

  it('rejects invalid merges without side effects', async () => {
    const { source, target } = await mergeFixture();
    const before = structuredClone(w.store.state);
    const base = { sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'Cùng một người', expectedSourceVersion: source.version, expectedTargetVersion: target.version };
    expect(await code(w.svc.mergePersons({ ...base, targetPersonId: source.personId }, w.ctx.clinicAdmin))).toBe('VALIDATION');
    expect(await code(w.svc.mergePersons({ ...base, reason: 'ngắn' }, w.ctx.clinicAdmin))).toBe('VALIDATION');
    expect(await code(w.svc.mergePersons({ ...base, expectedSourceVersion: 0 }, w.ctx.clinicAdmin))).toBe('VALIDATION');
    expect(await code(w.svc.mergePersons({ ...base, targetPersonId: asPersonId(uid(9999)) }, w.ctx.clinicAdmin))).toBe('NOT_FOUND');
    expect(await code(w.svc.mergePersons(base, w.ctx.nurseB))).toBe('FORBIDDEN'); // nurseB không có quyền merge
    expect(await code(w.svc.mergePersons({ ...base, expectedSourceVersion: 99 }, w.ctx.clinicAdmin))).toBe('VersionConflictError');
    expect(await code(w.svc.mergePersons({ ...base, expectedTargetVersion: 99 }, w.ctx.clinicAdmin))).toBe('VersionConflictError');
    expect(w.store.state).toEqual(before);
  });

  it('authorization: only clinic_admin / tenant_admin may merge', async () => {
    const { source, target } = await mergeFixture();
    const base = { sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'Cùng một người', expectedSourceVersion: source.version, expectedTargetVersion: target.version };
    for (const c of [w.ctx.nurse, w.ctx.doctor, w.ctx.pharm, w.ctx.patientUser, w.ctx.disabled]) {
      expect(await code(w.svc.mergePersons(base, c))).toBe('FORBIDDEN');
    }
    expect(w.s.merges).toHaveLength(0);
    expect(await code(w.svc.mergePersons(base, w.ctx.clinicAdmin))).toBe('OK');
  });

  it('cross-tenant merge is impossible (NOT_FOUND) and cannot be repeated or chained onto a merged person', async () => {
    const { source, target } = await mergeFixture();
    const other = (await w.svc.createPerson({ ...AN, givenName: 'Tenant B' }, w.ctx.nurseB)).person;
    const mk = (s: PersonId, t: PersonId, vs: number, vt: number) => ({ sourcePersonId: s, targetPersonId: t, reason: 'Cùng một người', expectedSourceVersion: vs, expectedTargetVersion: vt });
    expect(await code(w.svc.mergePersons(mk(source.personId, other.personId, source.version, other.version), w.ctx.clinicAdmin))).toBe('NOT_FOUND');
    expect(await code(w.svc.mergePersons(mk(other.personId, target.personId, other.version, target.version), w.ctx.clinicAdmin))).toBe('NOT_FOUND');

    await w.svc.mergePersons(mk(source.personId, target.personId, source.version, target.version), w.ctx.clinicAdmin);
    const sNow = w.s.persons.find((p) => p.personId === source.personId)!;
    const tNow = w.s.persons.find((p) => p.personId === target.personId)!;
    expect(await code(w.svc.mergePersons(mk(source.personId, target.personId, sNow.version, tNow.version), w.ctx.clinicAdmin))).toBe('INVALID_STATE');
    expect(await code(w.svc.mergePersons(mk(target.personId, source.personId, tNow.version, sNow.version), w.ctx.clinicAdmin))).toBe('INVALID_STATE');
  });

  it('refuses to merge when both persons already have a patient record at the same organization', async () => {
    const { source, target } = await mergeFixture();
    w.addPatient(target.personId, OA, 2); // cùng org OA với patient của source
    const before = structuredClone(w.store.state);
    const r = await code(w.svc.mergePersons({ sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'Cùng một người', expectedSourceVersion: source.version, expectedTargetVersion: target.version }, w.ctx.clinicAdmin));
    expect(r).toBe('CONFLICT:PATIENT_ORG_CONFLICT');
    expect(w.store.state).toEqual(before);
    // Khác org thì được phép.
    w.s.patients.find((p) => p.personId === target.personId)!.organizationId = OA2;
    expect(await code(w.svc.mergePersons({ sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'Cùng một người', expectedSourceVersion: source.version, expectedTargetVersion: target.version }, w.ctx.clinicAdmin))).toBe('OK');
  });

  it('rolls back everything (no half-merged state) when a step fails midway', async () => {
    const { source, target } = await mergeFixture();
    const input = { sourcePersonId: source.personId, targetPersonId: target.personId, reason: 'Cùng một người', expectedSourceVersion: source.version, expectedTargetVersion: target.version };
    for (const point of ['movePatients', 'moveIdentifier']) {
      const before = structuredClone(w.store.state);
      w.store.failAt = point;
      await expect(w.svc.mergePersons(input, w.ctx.clinicAdmin)).rejects.toThrow(`injected failure at ${point}`);
      w.store.failAt = null;
      expect(w.store.state).toEqual(before);
      expect(w.s.persons.find((p) => p.personId === source.personId)!.status).toBe('active');
    }
    expect(w.sink.events.at(-1)).toMatchObject({ action: 'person.merge', outcome: 'failure', payload: { code: 'INTERNAL' } });
    expect(await code(w.svc.mergePersons(input, w.ctx.clinicAdmin))).toBe('OK');
  });
});

describe('registry / getPerson', () => {
  it('allows staff and the person themself; refuses other patients and other tenants', async () => {
    const own = (await w.svc.createPerson({ ...AN, identifiers: [CCCD] }, w.ctx.nurse)).person;
    const other = (await w.svc.createPerson({ givenName: 'Thị Bình', familyName: 'Trần', birthDate: '1985-03-03' }, w.ctx.nurse)).person;
    w.s.users.find((u) => u.userId === U.patientUser)!.personId = own.personId;

    const v = await w.svc.getPerson(own.personId, w.ctx.pharm);
    expect(v.redirectedFrom).toBeNull();
    expect(v.identifiers.map((i) => i.type)).toEqual(['national_id']);
    expect(await code(w.svc.getPerson(own.personId, w.ctx.patientUser))).toBe('OK');
    expect(await code(w.svc.getPerson(other.personId, w.ctx.patientUser))).toBe('FORBIDDEN');
    expect(await code(w.svc.getPerson(own.personId, w.ctx.nurseB))).toBe('NOT_FOUND');
    expect(await code(w.svc.getPerson(asPersonId(uid(9999)), w.ctx.nurse))).toBe('NOT_FOUND');
    expect(await code(w.svc.getPerson(own.personId, w.ctx.tenantAdmin))).toBe('FORBIDDEN');
  });
});
