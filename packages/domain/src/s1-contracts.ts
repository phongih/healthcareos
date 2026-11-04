/**
 * HCOS-P0-ENG-001 | Slice S1 | Clinical domain contracts & FHIR R4 mappings
 * Encounter, Condition, Observation + chuyển đổi Internal Canonical <-> FHIR (Patient, Encounter, Condition, Observation).
 *
 * Quy ước:
 *  - FHIR `Patient.id` = patient_id (hồ sơ tại organization). person_id đi kèm qua extension.
 *  - Trạng thái vòng đời do server quản lý: các hàm fromFhir* KHÔNG nhận status từ client.
 *  - Tham chiếu FHIR dạng `Type/<uuid>`; sai định dạng => FhirMappingError.
 */
import {
  asOrganizationId,
  asPatientId,
  asPersonId,
  asUserId,
  isUuid,
  type Brand,
  type Identifier,
  type ISODate,
  type ISODateTime,
  type OrganizationId,
  type Patient,
  type PatientId,
  type Person,
  type Sex,
  type TenantScoped,
  type Timestamped,
  type UserId,
  type Versioned,
} from './s0-contracts';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
export type EncounterId = Brand<string, 'EncounterId'>;
export type ConditionId = Brand<string, 'ConditionId'>;
export type ObservationId = Brand<string, 'ObservationId'>;
export type ClinicalDocumentId = Brand<string, 'ClinicalDocumentId'>;

const mk = <T extends string>(label: string) => (v: string): T => {
  if (!isUuid(v)) throw new TypeError(`Invalid ${label} (uuid expected)`);
  return v.toLowerCase() as T;
};
export const asEncounterId = mk<EncounterId>('EncounterId');
export const asConditionId = mk<ConditionId>('ConditionId');
export const asObservationId = mk<ObservationId>('ObservationId');
export const asClinicalDocumentId = mk<ClinicalDocumentId>('ClinicalDocumentId');

// ---------------------------------------------------------------------------
// Internal canonical entities
// ---------------------------------------------------------------------------
export interface CodedConcept {
  readonly system: string;
  readonly code: string;
  readonly display: string | null;
}

export type EncounterStatus = 'planned' | 'in_progress' | 'finished' | 'cancelled' | 'entered_in_error';
export type EncounterClass = 'ambulatory' | 'inpatient' | 'emergency' | 'virtual';

export interface Encounter extends TenantScoped, Versioned, Timestamped {
  readonly encounterId: EncounterId;
  readonly patientId: PatientId;
  readonly organizationId: OrganizationId;
  /** Bác sĩ chịu trách nhiệm (user_id trong iam.users). */
  readonly practitionerUserId: UserId;
  readonly status: EncounterStatus;
  readonly encounterClass: EncounterClass;
  readonly reasonText: string | null;
  readonly periodStart: ISODateTime;
  readonly periodEnd: ISODateTime | null;
}

export type ConditionCategory = 'encounter_diagnosis' | 'problem_list_item';
export type ConditionClinicalStatus = 'active' | 'recurrence' | 'relapse' | 'inactive' | 'remission' | 'resolved';
export type ConditionVerificationStatus =
  | 'unconfirmed'
  | 'provisional'
  | 'differential'
  | 'confirmed'
  | 'refuted'
  | 'entered_in_error';

export interface Condition extends TenantScoped, Versioned, Timestamped {
  readonly conditionId: ConditionId;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  readonly category: ConditionCategory;
  readonly code: CodedConcept;
  readonly clinicalStatus: ConditionClinicalStatus;
  readonly verificationStatus: ConditionVerificationStatus;
  readonly onsetAt: ISODateTime | null;
  readonly abatedAt: ISODateTime | null;
  readonly recordedByUserId: UserId;
  readonly recordedAt: ISODateTime;
}

export type ObservationStatus =
  | 'registered'
  | 'preliminary'
  | 'final'
  | 'amended'
  | 'corrected'
  | 'cancelled'
  | 'entered_in_error'
  | 'unknown';

export type ObservationValue =
  | { readonly kind: 'quantity'; readonly value: number; readonly unit: string; readonly ucumCode: string | null }
  | { readonly kind: 'string'; readonly value: string };

export interface Observation extends TenantScoped, Versioned, Timestamped {
  readonly observationId: ObservationId;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  readonly status: ObservationStatus;
  readonly code: CodedConcept;
  readonly value: ObservationValue;
  readonly effectiveAt: ISODateTime;
  readonly supersedesObservationId: ObservationId | null;
  readonly recordedByUserId: UserId;
  readonly recordedAt: ISODateTime;
}

export interface ClinicalDocument extends TenantScoped, Versioned, Timestamped {
  readonly documentId: ClinicalDocumentId;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  readonly docType: string;
  readonly title: string;
  readonly contentType: string;
  readonly storageUri: string;
  /** SHA-256 hex (64 ký tự). */
  readonly contentHashHex: string;
  readonly sizeBytes: number;
  readonly status: 'current' | 'superseded' | 'entered_in_error';
  readonly supersedesDocumentId: ClinicalDocumentId | null;
  readonly authorUserId: UserId;
  readonly authoredAt: ISODateTime;
}

/** Dữ liệu đầu vào (client-controlled) cho các thao tác ghi. Không chứa status/ID do server cấp. */
export interface NewEncounterInput {
  readonly patientId: PatientId;
  readonly organizationId: OrganizationId;
  readonly encounterClass: EncounterClass;
  readonly reasonText?: string | null;
  readonly periodStart?: ISODateTime;
}

export interface NewConditionInput {
  readonly encounterId: EncounterId;
  /** Nếu có: phải khớp patient của đợt khám (toàn vẹn `subject` khi nhận từ FHIR). */
  readonly expectedPatientId?: PatientId;
  readonly code: CodedConcept;
  readonly category?: ConditionCategory;
  readonly clinicalStatus?: ConditionClinicalStatus;
  readonly verificationStatus?: ConditionVerificationStatus;
  readonly onsetAt?: ISODateTime | null;
}

export interface NewObservationInput {
  readonly encounterId: EncounterId;
  /** Nếu có: phải khớp patient của đợt khám (toàn vẹn `subject` khi nhận từ FHIR). */
  readonly expectedPatientId?: PatientId;
  readonly code: CodedConcept;
  readonly value: ObservationValue;
  readonly status?: Extract<ObservationStatus, 'preliminary' | 'final'>;
  readonly effectiveAt?: ISODateTime;
}

// ---------------------------------------------------------------------------
// FHIR R4 minimal resource shapes
// ---------------------------------------------------------------------------
export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}
export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}
export interface FhirReference {
  reference?: string;
  display?: string;
}
export interface FhirMeta {
  versionId?: string;
  lastUpdated?: string;
}
export interface FhirIdentifier {
  use?: 'usual' | 'official' | 'secondary';
  type?: FhirCodeableConcept;
  system?: string;
  value?: string;
  period?: { start?: string; end?: string };
}
export interface FhirQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export interface FhirPatient {
  resourceType: 'Patient';
  id?: string;
  meta?: FhirMeta;
  extension?: Array<{ url: string; valueString?: string }>;
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: Array<{ use?: string; family?: string; given?: string[] }>;
  telecom?: Array<{ system?: 'phone' | 'email'; value?: string }>;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  managingOrganization?: FhirReference;
}

export interface FhirEncounter {
  resourceType: 'Encounter';
  id?: string;
  meta?: FhirMeta;
  status?: string;
  class?: FhirCoding;
  subject?: FhirReference;
  participant?: Array<{ individual?: FhirReference }>;
  period?: { start?: string; end?: string };
  reasonCode?: FhirCodeableConcept[];
  serviceProvider?: FhirReference;
}

export interface FhirCondition {
  resourceType: 'Condition';
  id?: string;
  meta?: FhirMeta;
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  code?: FhirCodeableConcept;
  subject?: FhirReference;
  encounter?: FhirReference;
  onsetDateTime?: string;
  recordedDate?: string;
  recorder?: FhirReference;
}

export interface FhirObservation {
  resourceType: 'Observation';
  id?: string;
  meta?: FhirMeta;
  status?: string;
  code?: FhirCodeableConcept;
  subject?: FhirReference;
  encounter?: FhirReference;
  effectiveDateTime?: string;
  performer?: FhirReference[];
  valueQuantity?: FhirQuantity;
  valueString?: string;
  derivedFrom?: FhirReference[];
}

export class FhirMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FhirMappingError';
  }
}

export const FHIR_SYSTEMS = {
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  conditionVerification: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  conditionCategory: 'http://terminology.hl7.org/CodeSystem/condition-category',
  ucum: 'http://unitsofmeasure.org',
  personIdExtension: 'https://healthcareos.vn/fhir/StructureDefinition/person-id',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toKebab = (s: string): string => s.replace(/_/g, '-');
const fromKebab = (s: string): string => s.replace(/-/g, '_');

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], label: string): T {
  const v = raw === undefined ? undefined : fromKebab(raw);
  if (v === undefined || !(allowed as readonly string[]).includes(v)) {
    throw new FhirMappingError(`Unsupported ${label}: ${String(raw)}`);
  }
  return v as T;
}

function parseRef(ref: FhirReference | undefined, type: string): string {
  const m = ref?.reference ? new RegExp(`^${type}/([0-9a-fA-F-]{36})$`).exec(ref.reference) : null;
  const id = m?.[1];
  if (!id || !isUuid(id)) throw new FhirMappingError(`Invalid ${type} reference`);
  return id.toLowerCase();
}

function codingOf(cc: FhirCodeableConcept | undefined, label: string): CodedConcept {
  const c = cc?.coding?.find((x) => x.system && x.code);
  if (!c || !c.system || !c.code) throw new FhirMappingError(`${label} requires a coding with system and code`);
  return { system: c.system, code: c.code, display: c.display ?? cc?.text ?? null };
}

const toCodeableConcept = (c: CodedConcept): FhirCodeableConcept => ({
  coding: [{ system: c.system, code: c.code, ...(c.display ? { display: c.display } : {}) }],
  ...(c.display ? { text: c.display } : {}),
});

const meta = (version: number, updatedAt: ISODateTime): FhirMeta => ({
  versionId: String(version),
  lastUpdated: updatedAt,
});

function parseDateTime(raw: string | undefined, label: string): ISODateTime | undefined {
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new FhirMappingError(`Invalid ${label}`);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Encounter
// ---------------------------------------------------------------------------
const ENCOUNTER_STATUSES: readonly EncounterStatus[] = ['planned', 'in_progress', 'finished', 'cancelled', 'entered_in_error'];
const ENCOUNTER_CLASS_TO_FHIR: Readonly<Record<EncounterClass, string>> = {
  ambulatory: 'AMB',
  inpatient: 'IMP',
  emergency: 'EMER',
  virtual: 'VR',
};
const ENCOUNTER_CLASSES = Object.keys(ENCOUNTER_CLASS_TO_FHIR) as EncounterClass[];

export function toFhirEncounter(e: Encounter): FhirEncounter {
  return {
    resourceType: 'Encounter',
    id: e.encounterId,
    meta: meta(e.version, e.updatedAt),
    status: toKebab(e.status),
    class: { system: FHIR_SYSTEMS.actCode, code: ENCOUNTER_CLASS_TO_FHIR[e.encounterClass] },
    subject: { reference: `Patient/${e.patientId}` },
    participant: [{ individual: { reference: `Practitioner/${e.practitionerUserId}` } }],
    period: { start: e.periodStart, ...(e.periodEnd ? { end: e.periodEnd } : {}) },
    ...(e.reasonText ? { reasonCode: [{ text: e.reasonText }] } : {}),
    serviceProvider: { reference: `Organization/${e.organizationId}` },
  };
}

/** FHIR -> input tạo đợt khám. Practitioner & status do server quyết định (từ token / vòng đời). */
export function fromFhirEncounter(r: FhirEncounter): NewEncounterInput {
  if (r.resourceType !== 'Encounter') throw new FhirMappingError('Not an Encounter resource');
  const code = r.class?.code;
  const cls = (Object.entries(ENCOUNTER_CLASS_TO_FHIR).find(([, v]) => v === code)?.[0] ?? undefined) as
    | EncounterClass
    | undefined;
  if (!cls || !ENCOUNTER_CLASSES.includes(cls)) throw new FhirMappingError(`Unsupported Encounter.class: ${String(code)}`);
  const start = parseDateTime(r.period?.start, 'Encounter.period.start');
  return {
    patientId: asPatientId(parseRef(r.subject, 'Patient')),
    organizationId: asOrganizationId(parseRef(r.serviceProvider, 'Organization')),
    encounterClass: cls,
    reasonText: r.reasonCode?.[0]?.text ?? r.reasonCode?.[0]?.coding?.[0]?.display ?? null,
    ...(start ? { periodStart: start } : {}),
  };
}

/** Đọc trạng thái FHIR (chỉ dùng cho đối soát/đồng bộ, không để client set vòng đời). */
export const parseFhirEncounterStatus = (s: string | undefined): EncounterStatus =>
  parseEnum(s, ENCOUNTER_STATUSES, 'Encounter.status');

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------
const CLINICAL_STATUSES: readonly ConditionClinicalStatus[] = ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'];
const VERIFICATION_STATUSES: readonly ConditionVerificationStatus[] = [
  'unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered_in_error',
];

export function toFhirCondition(c: Condition): FhirCondition {
  return {
    resourceType: 'Condition',
    id: c.conditionId,
    meta: meta(c.version, c.updatedAt),
    clinicalStatus: { coding: [{ system: FHIR_SYSTEMS.conditionClinical, code: c.clinicalStatus }] },
    verificationStatus: {
      coding: [{ system: FHIR_SYSTEMS.conditionVerification, code: toKebab(c.verificationStatus) }],
    },
    category: [{ coding: [{ system: FHIR_SYSTEMS.conditionCategory, code: toKebab(c.category) }] }],
    code: toCodeableConcept(c.code),
    subject: { reference: `Patient/${c.patientId}` },
    encounter: { reference: `Encounter/${c.encounterId}` },
    ...(c.onsetAt ? { onsetDateTime: c.onsetAt } : {}),
    recordedDate: c.recordedAt,
    recorder: { reference: `Practitioner/${c.recordedByUserId}` },
  };
}

export function fromFhirCondition(r: FhirCondition): NewConditionInput & { readonly patientId: PatientId } {
  if (r.resourceType !== 'Condition') throw new FhirMappingError('Not a Condition resource');
  const category = parseEnum<ConditionCategory>(
    r.category?.[0]?.coding?.[0]?.code ?? 'encounter-diagnosis',
    ['encounter_diagnosis', 'problem_list_item'],
    'Condition.category',
  );
  const clinicalStatus = r.clinicalStatus?.coding?.[0]?.code
    ? parseEnum(r.clinicalStatus.coding[0].code, CLINICAL_STATUSES, 'Condition.clinicalStatus')
    : undefined;
  const verificationStatus = r.verificationStatus?.coding?.[0]?.code
    ? parseEnum(r.verificationStatus.coding[0].code, VERIFICATION_STATUSES, 'Condition.verificationStatus')
    : undefined;
  const onset = parseDateTime(r.onsetDateTime, 'Condition.onsetDateTime');
  return {
    patientId: asPatientId(parseRef(r.subject, 'Patient')),
    encounterId: asEncounterId(parseRef(r.encounter, 'Encounter')),
    code: codingOf(r.code, 'Condition.code'),
    category,
    ...(clinicalStatus ? { clinicalStatus } : {}),
    ...(verificationStatus ? { verificationStatus } : {}),
    ...(onset ? { onsetAt: onset } : {}),
  };
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------
const OBSERVATION_STATUSES: readonly ObservationStatus[] = [
  'registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered_in_error', 'unknown',
];

export function toFhirObservation(o: Observation): FhirObservation {
  return {
    resourceType: 'Observation',
    id: o.observationId,
    meta: meta(o.version, o.updatedAt),
    status: toKebab(o.status),
    code: toCodeableConcept(o.code),
    subject: { reference: `Patient/${o.patientId}` },
    encounter: { reference: `Encounter/${o.encounterId}` },
    effectiveDateTime: o.effectiveAt,
    performer: [{ reference: `Practitioner/${o.recordedByUserId}` }],
    ...(o.value.kind === 'quantity'
      ? {
          valueQuantity: {
            value: o.value.value,
            unit: o.value.unit,
            system: FHIR_SYSTEMS.ucum,
            ...(o.value.ucumCode ? { code: o.value.ucumCode } : {}),
          },
        }
      : { valueString: o.value.value }),
    ...(o.supersedesObservationId ? { derivedFrom: [{ reference: `Observation/${o.supersedesObservationId}` }] } : {}),
  };
}

export function fromFhirObservation(r: FhirObservation): NewObservationInput & { readonly patientId: PatientId } {
  if (r.resourceType !== 'Observation') throw new FhirMappingError('Not an Observation resource');
  let value: ObservationValue;
  if (r.valueQuantity) {
    const q = r.valueQuantity;
    if (typeof q.value !== 'number' || !Number.isFinite(q.value) || !q.unit) {
      throw new FhirMappingError('Observation.valueQuantity requires finite value and unit');
    }
    value = { kind: 'quantity', value: q.value, unit: q.unit, ucumCode: q.system === FHIR_SYSTEMS.ucum ? q.code ?? null : null };
  } else if (typeof r.valueString === 'string' && r.valueString.length > 0) {
    value = { kind: 'string', value: r.valueString };
  } else {
    throw new FhirMappingError('Observation requires valueQuantity or valueString');
  }
  const status = r.status ? parseEnum(r.status, OBSERVATION_STATUSES, 'Observation.status') : 'final';
  if (status !== 'preliminary' && status !== 'final') {
    throw new FhirMappingError(`Client may only submit preliminary/final observations (got ${status})`);
  }
  const eff = parseDateTime(r.effectiveDateTime, 'Observation.effectiveDateTime');
  return {
    patientId: asPatientId(parseRef(r.subject, 'Patient')),
    encounterId: asEncounterId(parseRef(r.encounter, 'Encounter')),
    code: codingOf(r.code, 'Observation.code'),
    value,
    status,
    ...(eff ? { effectiveAt: eff } : {}),
  };
}

// ---------------------------------------------------------------------------
// Patient (person + patient + identifiers)
// ---------------------------------------------------------------------------
const SEX_VALUES: readonly Sex[] = ['male', 'female', 'other', 'unknown'];

export function toFhirPatient(person: Person, patient: Patient, identifiers: readonly Identifier[]): FhirPatient {
  if (person.personId !== patient.personId || person.tenantId !== patient.tenantId) {
    throw new FhirMappingError('Person and Patient do not match');
  }
  return {
    resourceType: 'Patient',
    id: patient.patientId,
    meta: meta(patient.version, patient.updatedAt),
    extension: [{ url: FHIR_SYSTEMS.personIdExtension, valueString: person.personId }],
    identifier: [
      { use: 'usual', type: { text: 'mrn' }, system: `urn:hcos:mrn:${patient.organizationId}`, value: patient.mrn },
      ...identifiers
        .filter((i) => i.personId === person.personId && i.status === 'active')
        .map<FhirIdentifier>((i) => ({
          use: i.type === 'national_id' ? 'official' : 'secondary',
          type: { text: i.type },
          system: i.system,
          value: i.value,
          ...(i.periodStart || i.periodEnd
            ? { period: { ...(i.periodStart ? { start: i.periodStart } : {}), ...(i.periodEnd ? { end: i.periodEnd } : {}) } }
            : {}),
        })),
    ],
    active: patient.status === 'active' && person.status === 'active',
    name: [{ use: 'official', family: person.familyName, given: person.givenName.split(' ').filter(Boolean) }],
    telecom: [
      ...(person.phone ? [{ system: 'phone' as const, value: person.phone }] : []),
      ...(person.email ? [{ system: 'email' as const, value: person.email }] : []),
    ],
    gender: person.sex ?? 'unknown',
    ...(person.birthDate ? { birthDate: person.birthDate } : {}),
    managingOrganization: { reference: `Organization/${patient.organizationId}` },
  };
}

export interface PersonDraft {
  readonly givenName: string;
  readonly familyName: string;
  readonly birthDate: ISODate | null;
  readonly sex: Sex | null;
  readonly phone: string | null;
  readonly email: string | null;
}

export function fromFhirPatient(r: FhirPatient): PersonDraft {
  if (r.resourceType !== 'Patient') throw new FhirMappingError('Not a Patient resource');
  const n = r.name?.[0];
  if (!n?.family || !n.given || n.given.length === 0) throw new FhirMappingError('Patient.name requires family and given');
  if (r.gender !== undefined && !SEX_VALUES.includes(r.gender)) throw new FhirMappingError('Unsupported Patient.gender');
  if (r.birthDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(r.birthDate)) throw new FhirMappingError('Invalid Patient.birthDate');
  return {
    givenName: n.given.join(' '),
    familyName: n.family,
    birthDate: r.birthDate ?? null,
    sex: r.gender ?? null,
    phone: r.telecom?.find((t) => t.system === 'phone')?.value ?? null,
    email: r.telecom?.find((t) => t.system === 'email')?.value ?? null,
  };
}

/** Lấy person_id từ extension của FHIR Patient (nếu có). */
export function personIdFromFhirPatient(r: FhirPatient): ReturnType<typeof asPersonId> | null {
  const v = r.extension?.find((e) => e.url === FHIR_SYSTEMS.personIdExtension)?.valueString;
  return v && isUuid(v) ? asPersonId(v) : null;
}

export { asUserId };
