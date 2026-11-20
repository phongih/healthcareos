/**
 * HCOS-P0-ENG-001 | IAM × S1 | Access policy áp vào ClinicalEncounterService (repository in-memory).
 * RLS / trigger thật nằm ở tests/integration/access-policy-pg.integration.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  asOrganizationId,
  asPatientId,
  asPersonId,
  asTenantId,
  asUserId,
  type AccessPolicyId,
  type AuditSink,
  type CorrelationId,
  type Identifier,
  type Membership,
  type NewAuditEvent,
  type Patient,
  type Person,
  type Role,
  type TenantContext,
  type User,
  type UserId,
} from '../../packages/domain/src/s0-contracts';
import { type Condition, type Encounter, type EncounterId, type Observation } from '../../packages/domain/src/s1-contracts';
import { validateAccessRules, type AccessPolicy } from '../../packages/security/src/access-policy';
import {
  ClinicalEncounterService,
  ClinicalError,
  type ClinicalRepository,
  type ClinicalUnitOfWork,
  type PatientSearchQuery,
} from '../../services/api/src/clinical/encounter.service';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const TA = asTenantId(uid(1));
const ORG = asOrganizationId(uid(11));
const U = {
  doc: asUserId(uid(101)),
  doc2: asUserId(uid(102)),
  nurse: asUserId(uid(103)),
  hybrid: asUserId(uid(104)),
  broken: asUserId(uid(105)),
  plainDoc: asUserId(uid(106)),
  patient: asUserId(uid(107)),
};
const PERSON = asPersonId(uid(301));
const PAT = asPatientId(uid(401));
const ENC_DOC = uid(501) as EncounterId; // của U.doc, đang mở
const ENC_DOC2 = uid(502) as EncounterId; // của U.doc2, đang mở
const ENC_DONE = uid(503) as EncounterId; // của U.doc, đã đóng
const CCCD = 'https://moh.gov.vn/cccd';

const LOINC_TEMP = { system: 'http://loinc.org', code: '8310-5', display: 'Body temperature' };
const LOINC_HBA1C = { system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' };
const ICD_J06 = { system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9', display: 'URTI' };
const SNOMED = { system: 'http://snomed.info/sct', code: '386725007', display: 'Fever' };

const P_NURSE = uid(901) as AccessPolicyId;
const P_DOC_SELF = uid(902) as AccessPolicyId;
const P_MISSING = uid(903) as AccessPolicyId;

const mkPolicy = (policyId: AccessPolicyId, rules: unknown): AccessPolicy => ({
  tenantId: TA, policyId, name: `p-${policyId.slice(-3)}`, description: null, status: 'active',
  rules: validateAccessRules(rules), createdBy: U.plainDoc, createdAt: T0, updatedAt: T0, version: 1,
});

const NURSE_POLICY = mkPolicy(P_NURSE, [
  { action: 'patient:read', hiddenFields: ['identifiers', 'person.birthDate'] },
  { action: 'encounter:read', criteria: { encounterStatus: ['in_progress'] }, hiddenFields: ['conditions', 'encounter.reasonText'] },
  {
    action: 'observation:write',
    criteria: { codes: ['http://loinc.org|8310-5', 'http://loinc.org|8867-4'] },
    readonlyFields: ['effectiveAt', 'status'],
  },
]);
const DOC_SELF_POLICY = mkPolicy(P_DOC_SELF, [
  { action: 'patient:read' },
  { action: 'encounter:read', criteria: { practitioner: 'self' } },
  { action: 'encounter:create', criteria: { encounterClass: ['ambulatory', 'virtual'] }, readonlyFields: ['periodStart'] },
  { action: 'condition:write', criteria: { codes: ['http://hl7.org/fhir/sid/icd-10|*'] }, readonlyFields: ['verificationStatus'] },
  { action: 'encounter:close' },
]);

const mkUser = (userId: UserId, over: Partial<User> = {}): User => ({
  tenantId: TA, userId, externalSubject: `sub-${userId}`, email: null, displayName: 'u', personId: null, status: 'active',
  lastLoginAt: null, createdAt: T0, updatedAt: T0, version: 1, ...over,
});
let seq = 700;
const mkMember = (userId: UserId, role: Role, accessPolicyId: AccessPolicyId | null = null): Membership => ({
  tenantId: TA, membershipId: uid(seq++) as Membership['membershipId'], userId, organizationId: ORG, role, status: 'active',
  validFrom: T0, validTo: null, accessPolicyId, createdAt: T0, updatedAt: T0, version: 1,
});
const mkEnc = (encounterId: EncounterId, practitionerUserId: UserId, status: Encounter['status'] = 'in_progress'): Encounter => ({
  tenantId: TA, encounterId, patientId: PAT, organizationId: ORG, practitionerUserId, status, encounterClass: 'ambulatory',
  reasonText: 'Lý do khám nhạy cảm', periodStart: T0, periodEnd: status === 'finished' ? T0 : null, createdAt: T0, updatedAt: T0, version: 1,
});
const ctxFor = (u: UserId): TenantContext =>
  Object.freeze({
    tenantId: TA, userSubject: `sub-${u}`, userId: null, personId: null, activeOrganizationId: ORG,
    allowedOrganizationIds: Object.freeze([ORG]), roles: Object.freeze([] as Role[]), tokenId: null, correlationId: 'corr' as CorrelationId,
  });

interface State {
  users: User[]; memberships: Membership[]; policies: AccessPolicy[]; persons: Person[]; patients: Patient[];
  identifiers: Identifier[]; encounters: Encounter[]; conditions: Condition[]; observations: Observation[]; audit: NewAuditEvent[];
}

class Repo implements ClinicalRepository {
  constructor(private readonly s: State) {}
  async findPerson(id: Person['personId']) { return this.s.persons.find((p) => p.personId === id) ?? null; }
  async findPatient(id: Patient['patientId']) { return this.s.patients.find((p) => p.patientId === id) ?? null; }
  async listIdentifiers(personId: Person['personId']) { return this.s.identifiers.filter((i) => i.personId === personId); }
  async searchPatients(q: PatientSearchQuery) {
    return this.s.patients.filter((p) => p.organizationId === q.organizationId && (q.mrn === null || p.mrn === q.mrn));
  }
  async insertPatient(p: Patient) { this.s.patients.push(p); }
  async findUserBySubject(sub: string) { return this.s.users.find((u) => u.externalSubject === sub) ?? null; }
  async listMemberships(userId: UserId) { return this.s.memberships.filter((m) => m.userId === userId); }
  async findAccessPolicies(ids: readonly AccessPolicyId[]) { return this.s.policies.filter((p) => ids.includes(p.policyId)); }
  async insertEncounter(e: Encounter) { this.s.encounters.push(e); }
  async findEncounter(id: EncounterId) { return this.s.encounters.find((e) => e.encounterId === id) ?? null; }
  async listEncountersByPatient(patientId: Patient['patientId'], limit: number) { return this.s.encounters.filter((e) => e.patientId === patientId).slice(0, limit); }
  async updateEncounter(next: Encounter, v: number) {
    const cur = this.s.encounters.find((e) => e.encounterId === next.encounterId);
    if (!cur || cur.version !== v) return null;
    Object.assign(cur, next, { version: v + 1 });
    return { ...cur };
  }
  async insertCondition(c: Condition) { this.s.conditions.push(c); }
  async listConditions(id: EncounterId) { return this.s.conditions.filter((c) => c.encounterId === id); }
  async insertObservation(o: Observation) { this.s.observations.push(o); }
  async listObservations(id: EncounterId) { return this.s.observations.filter((o) => o.encounterId === id); }
  async enqueueOutbox() {}
  async appendAudit(ev: NewAuditEvent) { this.s.audit.push(ev); }
}

class Uow implements ClinicalUnitOfWork {
  constructor(public s: State) {}
  async run<T>(_ctx: TenantContext, fn: (r: ClinicalRepository) => Promise<T>): Promise<T> {
    const snap = structuredClone(this.s);
    try {
      return await fn(new Repo(this.s));
    } catch (e) {
      Object.assign(this.s, snap);
      throw e;
    }
  }
}

class Sink implements AuditSink {
  events: NewAuditEvent[] = [];
  async record(e: NewAuditEvent) { this.events.push(e); }
}

let state: State;
let sink: Sink;
let svc: ClinicalEncounterService;

beforeEach(() => {
  seq = 700;
  state = {
    users: [mkUser(U.doc), mkUser(U.doc2), mkUser(U.nurse), mkUser(U.hybrid), mkUser(U.broken), mkUser(U.plainDoc), mkUser(U.patient, { personId: PERSON })],
    memberships: [
      mkMember(U.doc, 'doctor', P_DOC_SELF),
      mkMember(U.doc2, 'doctor'),
      mkMember(U.nurse, 'clinic_staff', P_NURSE),
      mkMember(U.hybrid, 'clinic_staff', P_NURSE),
      mkMember(U.hybrid, 'pharmacist'),
      mkMember(U.broken, 'doctor', P_MISSING),
      mkMember(U.plainDoc, 'doctor'),
      mkMember(U.patient, 'patient', P_NURSE),
    ],
    policies: [NURSE_POLICY, DOC_SELF_POLICY],
    persons: [{
      tenantId: TA, personId: PERSON, givenName: 'Văn A', familyName: 'Nguyễn', birthDate: '1990-05-17', sex: 'male',
      phone: '0900000000', email: 'a@example.vn', status: 'active', mergedIntoPersonId: null, createdAt: T0, updatedAt: T0, version: 1,
    }],
    patients: [{ tenantId: TA, patientId: PAT, personId: PERSON, organizationId: ORG, mrn: 'MRN-1', status: 'active', registeredAt: T0, createdAt: T0, updatedAt: T0, version: 1 }],
    identifiers: [{
      tenantId: TA, identifierId: uid(601) as Identifier['identifierId'], personId: PERSON, patientId: null, type: 'national_id',
      system: CCCD, value: '079090000777', status: 'active', periodStart: null, periodEnd: null, createdAt: T0, updatedAt: T0, version: 1,
    }],
    encounters: [mkEnc(ENC_DOC, U.doc), mkEnc(ENC_DOC2, U.doc2), mkEnc(ENC_DONE, U.doc, 'finished')],
    conditions: [{
      tenantId: TA, conditionId: uid(701) as Condition['conditionId'], patientId: PAT, encounterId: ENC_DOC, category: 'encounter_diagnosis',
      code: ICD_J06, clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatedAt: null, recordedByUserId: U.doc,
      recordedAt: T0, createdAt: T0, updatedAt: T0, version: 1,
    }],
    observations: [],
    audit: [],
  };
  sink = new Sink();
  let n = 5000;
  svc = new ClinicalEncounterService({ uow: new Uow(state), audit: sink, clock: () => new Date('2026-10-30T03:00:00.000Z'), newId: () => uid(n++) });
});

const policyDenied = { code: 'FORBIDDEN', details: { reason: 'ACCESS_POLICY' } };
const temp = (encounterId: EncounterId, over: Record<string, unknown> = {}) => ({
  encounterId, code: LOINC_TEMP, value: { kind: 'quantity' as const, value: 38.5, unit: 'Cel', ucumCode: 'Cel' }, ...over,
});

describe('điều dưỡng bị giới hạn bởi policy', () => {
  it('ghi được chỉ số trong danh sách mã; audit ghi policy đã áp dụng', async () => {
    const o = await svc.recordObservation(temp(ENC_DOC2), ctxFor(U.nurse));
    expect(o.recordedByUserId).toBe(U.nurse);
    const ev = state.audit.find((e) => e.action === 'observation.create');
    expect(ev?.payload).toMatchObject({ accessPolicyIds: [P_NURSE] });
  });

  it('mã ngoài danh sách => 403 ACCESS_POLICY, audit denied có reason, không ghi gì', async () => {
    await expect(svc.recordObservation({ ...temp(ENC_DOC2), code: LOINC_HBA1C }, ctxFor(U.nurse))).rejects.toMatchObject(policyDenied);
    expect(state.observations).toHaveLength(0);
    expect(sink.events.at(-1)).toMatchObject({ outcome: 'denied', payload: { code: 'FORBIDDEN', reason: 'ACCESS_POLICY' } });
  });

  it('trường bị khoá: không tự đặt effectiveAt / status khác mặc định', async () => {
    await expect(svc.recordObservation(temp(ENC_DOC2, { effectiveAt: '2026-10-29T00:00:00.000Z' }), ctxFor(U.nurse)))
      .rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'ACCESS_POLICY', field: 'effectiveAt' } });
    await expect(svc.recordObservation(temp(ENC_DOC2, { status: 'preliminary' }), ctxFor(U.nurse)))
      .rejects.toMatchObject({ details: { field: 'status' } });
    // Giá trị bằng mặc định thì không coi là "tự đặt".
    await expect(svc.recordObservation(temp(ENC_DOC2, { status: 'final' }), ctxFor(U.nurse))).resolves.toMatchObject({ status: 'final' });
  });

  it('đọc bệnh án đợt khám đang mở: che chẩn đoán và lý do khám, có danh sách redacted', async () => {
    const chart = await svc.getEncounterChart(ENC_DOC, ctxFor(U.nurse));
    expect(chart.conditions).toHaveLength(0);
    expect(chart.encounter.reasonText).toBeNull();
    expect(chart.redacted).toEqual(['conditions', 'encounter.reasonText']);
    expect(state.audit.at(-1)?.payload).toMatchObject({ accessPolicyIds: [P_NURSE], redacted: ['conditions', 'encounter.reasonText'] });
  });

  it('đợt khám đã đóng => không khớp điều kiện encounterStatus => 403', async () => {
    await expect(svc.getEncounterChart(ENC_DONE, ctxFor(U.nurse))).rejects.toMatchObject(policyDenied);
  });

  it('hồ sơ hành chính: che CCCD và ngày sinh, giữ phần còn lại', async () => {
    const v = await svc.getPatient(PAT, ctxFor(U.nurse));
    expect(v.identifiers).toHaveLength(0);
    expect(v.person.birthDate).toBeNull();
    expect(v.person.phone).toBe('0900000000');
    expect(v.redacted).toEqual(['identifiers', 'person.birthDate']);
  });

  it('không cho tìm theo trường bị che (chống dò giá trị), vẫn tìm được theo MRN', async () => {
    await expect(svc.searchPatients({ organizationId: ORG, identifier: { system: CCCD, value: '079090000777' } }, ctxFor(U.nurse)))
      .rejects.toMatchObject(policyDenied);
    await expect(svc.searchPatients({ organizationId: ORG, givenName: 'Văn A', familyName: 'Nguyễn', birthDate: '1990-05-17' }, ctxFor(U.nurse)))
      .rejects.toMatchObject(policyDenied);
    const r = await svc.searchPatients({ organizationId: ORG, mrn: 'MRN-1' }, ctxFor(U.nurse));
    expect(r).toHaveLength(1);
    expect(r[0]!.identifiers).toHaveLength(0);
  });

  it('vai trò cho phép nhưng policy không có luật => 403 (policy chỉ thu hẹp)', async () => {
    await expect(svc.registerPatient({ personId: PERSON, organizationId: ORG, mrn: 'MRN-2' }, ctxFor(U.nurse))).rejects.toMatchObject(policyDenied);
  });

  it('policy không cấp quyền mà vai trò không có (clinic_staff không ghi chẩn đoán)', async () => {
    await expect(svc.addCondition({ encounterId: ENC_DOC2, code: ICD_J06 }, ctxFor(U.nurse)))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Missing permission condition:write' });
  });
});

describe('bác sĩ chỉ xem đợt khám của mình', () => {
  it('xem được đợt khám của mình, không xem được của đồng nghiệp', async () => {
    const own = await svc.getEncounterChart(ENC_DOC, ctxFor(U.doc));
    expect(own.conditions).toHaveLength(1);
    expect(own.redacted).toEqual([]);
    await expect(svc.getEncounterChart(ENC_DOC2, ctxFor(U.doc))).rejects.toMatchObject(policyDenied);
  });

  it('bác sĩ không có policy giữ nguyên quyền cũ', async () => {
    const chart = await svc.getEncounterChart(ENC_DOC, ctxFor(U.plainDoc));
    expect(chart.conditions).toHaveLength(1);
    expect(chart.redacted).toEqual([]);
    expect(state.audit.at(-1)?.payload).not.toHaveProperty('accessPolicyIds');
  });

  it('chẩn đoán: chỉ hệ mã ICD-10; không tự đặt verificationStatus', async () => {
    await expect(svc.addCondition({ encounterId: ENC_DOC, code: SNOMED }, ctxFor(U.doc))).rejects.toMatchObject(policyDenied);
    await expect(svc.addCondition({ encounterId: ENC_DOC, code: { ...ICD_J06, code: 'R50.9' }, verificationStatus: 'provisional' }, ctxFor(U.doc)))
      .rejects.toMatchObject({ details: { field: 'verificationStatus' } });
    const c = await svc.addCondition({ encounterId: ENC_DOC, code: { ...ICD_J06, code: 'R50.9' } }, ctxFor(U.doc));
    expect(c.verificationStatus).toBe('confirmed');
  });

  it('mở đợt khám: lọc theo loại khám, khoá periodStart', async () => {
    await expect(svc.createEncounter({ patientId: PAT, organizationId: ORG, encounterClass: 'inpatient' }, ctxFor(U.doc))).rejects.toMatchObject(policyDenied);
    await expect(svc.createEncounter({ patientId: PAT, organizationId: ORG, encounterClass: 'virtual', periodStart: '2026-10-01T00:00:00.000Z' }, ctxFor(U.doc)))
      .rejects.toMatchObject({ details: { field: 'periodStart' } });
    const e = await svc.createEncounter({ patientId: PAT, organizationId: ORG, encounterClass: 'virtual' }, ctxFor(U.doc));
    expect(e.periodStart).toBe('2026-10-30T03:00:00.000Z');
  });

  it('đóng đợt khám vẫn hoạt động khi policy cho phép', async () => {
    const closed = await svc.closeEncounter(ENC_DOC, 1, ctxFor(U.doc));
    expect(closed.status).toBe('finished');
  });
});

describe('kết hợp và fail-closed', () => {
  it('membership thứ hai không bị giới hạn thắng (giao rỗng => không che)', async () => {
    const v = await svc.getPatient(PAT, ctxFor(U.hybrid));
    expect(v.identifiers).toHaveLength(1);
    expect(v.redacted).toEqual([]);
  });

  it('policy được gắn nhưng không tải được => từ chối, không rơi về quyền mặc định', async () => {
    await expect(svc.getPatient(PAT, ctxFor(U.broken))).rejects.toMatchObject(policyDenied);
  });

  it('policy bị retire sau khi gắn => từ chối', async () => {
    state.policies = [{ ...DOC_SELF_POLICY, status: 'retired' }, NURSE_POLICY];
    await expect(svc.getEncounterChart(ENC_DOC, ctxFor(U.doc))).rejects.toMatchObject(policyDenied);
  });

  it('bệnh nhân xem hồ sơ của chính mình không bị policy che', async () => {
    const v = await svc.getPatient(PAT, ctxFor(U.patient));
    expect(v.identifiers).toHaveLength(1);
    expect(v.redacted).toEqual([]);
  });

  it('lỗi do policy là ClinicalError FORBIDDEN (HTTP 403, không lộ nội dung luật)', async () => {
    const e = await svc.getEncounterChart(ENC_DOC2, ctxFor(U.doc)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClinicalError);
    expect(JSON.stringify((e as ClinicalError).details)).not.toContain('practitioner');
  });
});

describe('danh sách đợt khám của bệnh nhân', () => {
  it('bác sĩ không policy thấy tất cả; bác sĩ chỉ-xem-của-mình chỉ thấy đợt của mình (đợt khác bị lọc, không báo lỗi)', async () => {
    const all = await svc.listEncountersForPatient(PAT, ctxFor(U.plainDoc));
    expect(all.encounters).toHaveLength(3);
    expect(all.filtered).toBe(0);
    const mine = await svc.listEncountersForPatient(PAT, ctxFor(U.doc));
    expect(mine.encounters.map((e) => e.encounterId).sort()).toEqual([ENC_DOC, ENC_DONE].sort());
    expect(mine.filtered).toBe(1);
    expect(state.audit.at(-1)?.payload).toMatchObject({ count: 2, filtered: 1 });
  });

  it('điều dưỡng: chỉ đợt đang mở, lý do khám bị che', async () => {
    const r = await svc.listEncountersForPatient(PAT, ctxFor(U.nurse));
    expect(r.encounters.map((e) => e.status)).toEqual(['in_progress', 'in_progress']);
    expect(r.encounters.every((e) => e.reasonText === null)).toBe(true);
    expect(r.redactedEncounterIds.sort()).toEqual([ENC_DOC, ENC_DOC2].sort());
  });

  it('không có quyền đọc hồ sơ => 403; bệnh nhân xem của chính mình thấy đủ', async () => {
    await expect(svc.listEncountersForPatient(PAT, ctxFor(U.broken))).rejects.toMatchObject(policyDenied);
    const self = await svc.listEncountersForPatient(PAT, ctxFor(U.patient));
    expect(self.encounters).toHaveLength(3);
  });
});

