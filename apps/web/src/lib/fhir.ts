/** Kiểu FHIR tối thiểu mà API HealthcareOS trả về + tiện ích hiển thị. */
export const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
export const LOINC = 'http://loinc.org';
export const UCUM = 'http://unitsofmeasure.org';
export const CCCD_SYSTEM = 'https://moh.gov.vn/cccd';
export const REDACTED = 'REDACTED';

export interface Coding { system?: string; code?: string; display?: string }
export interface CodeableConcept { coding?: Coding[]; text?: string }
export interface Meta { versionId?: string; lastUpdated?: string; security?: Coding[] }
export interface Reference { reference?: string }

export interface FhirPatient {
  resourceType: 'Patient';
  id?: string;
  meta?: Meta;
  identifier?: Array<{ system?: string; value?: string; type?: { text?: string } }>;
  active?: boolean;
  name?: Array<{ family?: string; given?: string[] }>;
  telecom?: Array<{ system?: string; value?: string }>;
  gender?: string;
  birthDate?: string;
  managingOrganization?: Reference;
}

export interface FhirEncounter {
  resourceType: 'Encounter';
  id?: string;
  meta?: Meta;
  status?: string;
  class?: Coding;
  subject?: Reference;
  participant?: Array<{ individual?: Reference }>;
  period?: { start?: string; end?: string };
  reasonCode?: CodeableConcept[];
  serviceProvider?: Reference;
}

export interface FhirCondition {
  resourceType: 'Condition';
  id?: string;
  code?: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  recordedDate?: string;
}

export interface FhirObservation {
  resourceType: 'Observation';
  id?: string;
  status?: string;
  code?: CodeableConcept;
  valueQuantity?: { value?: number; unit?: string };
  valueString?: string;
  effectiveDateTime?: string;
}

export interface Bundle<T> {
  resourceType: 'Bundle';
  meta?: Meta;
  type: string;
  total?: number;
  entry?: Array<{ resource: T }>;
}

export const entries = <T,>(b: Bundle<T> | undefined): T[] => (b?.entry ?? []).map((e) => e.resource);

export const isRedacted = (m: { meta?: Meta } | undefined): boolean => !!m?.meta?.security?.some((s) => s.code === REDACTED);

export const idOf = (ref: Reference | undefined): string => ref?.reference?.split('/')[1] ?? '';

export const patientName = (p: FhirPatient): string => {
  const n = p.name?.[0];
  return [n?.family, ...(n?.given ?? [])].filter(Boolean).join(' ') || '(không tên)';
};

export const mrnOf = (p: FhirPatient): string => p.identifier?.find((i) => i.type?.text === 'mrn')?.value ?? '';
export const cccdOf = (p: FhirPatient): string => p.identifier?.find((i) => i.type?.text === 'national_id')?.value ?? '';
export const phoneOf = (p: FhirPatient): string => p.telecom?.find((t) => t.system === 'phone')?.value ?? '';

export const conceptText = (c: CodeableConcept | undefined): string => {
  const x = c?.coding?.[0];
  return [x?.code, x?.display ?? c?.text].filter(Boolean).join(' — ');
};

export const ENCOUNTER_CLASSES = [
  { value: 'AMB', label: 'Ngoại trú' },
  { value: 'EMER', label: 'Cấp cứu' },
  { value: 'IMP', label: 'Nội trú' },
  { value: 'VR', label: 'Từ xa' },
] as const;

export const classLabel = (code: string | undefined): string => ENCOUNTER_CLASSES.find((c) => c.value === code)?.label ?? code ?? '';

export const STATUS_LABEL: Record<string, string> = {
  'in-progress': 'Đang khám',
  finished: 'Đã kết thúc',
  planned: 'Đã hẹn',
  cancelled: 'Đã huỷ',
  'entered-in-error': 'Nhập nhầm',
};

/** Chỉ số sinh tồn thường dùng (LOINC + đơn vị UCUM). */
export const VITALS = [
  { code: '8310-5', display: 'Nhiệt độ', unit: 'Cel', label: '°C' },
  { code: '59408-5', display: 'SpO₂', unit: '%', label: '%' },
  { code: '8867-4', display: 'Mạch', unit: '/min', label: 'lần/phút' },
  { code: '8480-6', display: 'Huyết áp tâm thu', unit: 'mm[Hg]', label: 'mmHg' },
  { code: '8462-4', display: 'Huyết áp tâm trương', unit: 'mm[Hg]', label: 'mmHg' },
  { code: '29463-7', display: 'Cân nặng', unit: 'kg', label: 'kg' },
] as const;

export const fmtDateTime = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString('vi-VN') : '');
export const fmtDate = (iso: string | undefined): string => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('vi-VN') : '');
