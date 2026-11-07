/**
 * HCOS-P0-ENG-001 | Person Registry | Domain contracts + logic thuần (chuẩn hoá, validate định danh, chấm điểm trùng lặp)
 *
 * Không có I/O. Mọi hàm ở đây tất định và được kiểm thử độc lập.
 */
import type {
  Identifier,
  IdentifierType,
  ISODate,
  ISODateTime,
  OrganizationId,
  PatientId,
  Person,
  PersonId,
  Sex,
  UserId,
} from './s0-contracts';

// ---------------------------------------------------------------------------
// Lỗi validate (tầng service chuyển thành ClinicalError('VALIDATION'))
// ---------------------------------------------------------------------------
export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryValidationError';
  }
}

// ---------------------------------------------------------------------------
// Chuẩn hoá
// ---------------------------------------------------------------------------
/** Bỏ dấu tiếng Việt/Latin (NFD + đ→d), chữ thường, chỉ giữ chữ-số. */
export function foldText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Khoá tên không phụ thuộc dấu và thứ tự (họ/tên đảo vị trí vẫn khớp): token sắp xếp. */
export function nameKey(givenName: string, familyName: string): string {
  return foldText(`${familyName} ${givenName}`).split(' ').filter(Boolean).sort().join(' ');
}

/** Số điện thoại VN: chỉ chữ số, +84/84 -> 0. Trả null nếu không hợp lệ. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  d = d.replace(/\D/g, '');
  if (d.startsWith('84') && d.length >= 11 && d.length <= 12) d = `0${d.slice(2)}`;
  return /^0\d{8,10}$/.test(d) ? d : null;
}

export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new RegistryValidationError('Invalid email');
  return e;
}

export function cleanName(raw: string, label: string): string {
  const v = raw.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (v.length < 1 || v.length > 100 || /[\u0000-\u001f\u007f<>]/.test(v)) throw new RegistryValidationError(`Invalid ${label}`);
  return v;
}

export function validateBirthDate(raw: string, now: Date): ISODate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) throw new RegistryValidationError('birthDate must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new RegistryValidationError('birthDate is not a real date');
  }
  if (y < 1900 || dt.getTime() > now.getTime()) throw new RegistryValidationError('birthDate out of range');
  return raw;
}

const SYSTEM_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]{1,190}$/;

export interface NewIdentifierInput {
  readonly type: Exclude<IdentifierType, 'mrn'>;
  readonly system: string;
  readonly value: string;
  readonly periodStart?: ISODate | null;
  readonly periodEnd?: ISODate | null;
}

export interface NormalizedIdentifier {
  readonly type: Exclude<IdentifierType, 'mrn'>;
  readonly system: string;
  readonly value: string;
  readonly periodStart: ISODate | null;
  readonly periodEnd: ISODate | null;
}

const ID_TYPES: readonly string[] = ['national_id', 'health_insurance', 'passport', 'phone', 'external'];

/**
 * Chuẩn hoá + kiểm tra định danh. MRN không được tạo ở đây (MRN thuộc patient, tạo bởi registerPatient).
 *  - national_id (CMND 9 số / CCCD 12 số), health_insurance (BHYT: 2 chữ + 13 số), phone (VN), passport (6–9 ký tự chữ-số).
 */
export function normalizeIdentifier(input: NewIdentifierInput): NormalizedIdentifier {
  if (!ID_TYPES.includes(input.type)) throw new RegistryValidationError('Unsupported identifier type');
  if (!SYSTEM_RE.test(input.system) || input.system.length > 200) throw new RegistryValidationError('Invalid identifier system');
  const raw = input.value.trim();
  let value: string;
  switch (input.type) {
    case 'national_id':
      value = raw.replace(/[\s.-]/g, '');
      if (!/^(\d{9}|\d{12})$/.test(value)) throw new RegistryValidationError('national_id must be 9 or 12 digits');
      break;
    case 'health_insurance':
      value = raw.replace(/[\s-]/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{13}$/.test(value)) throw new RegistryValidationError('health_insurance must be 2 letters + 13 digits');
      break;
    case 'phone': {
      const p = normalizePhone(raw);
      if (!p) throw new RegistryValidationError('Invalid phone identifier');
      value = p;
      break;
    }
    case 'passport':
      value = raw.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z0-9]{6,9}$/.test(value)) throw new RegistryValidationError('Invalid passport number');
      break;
    default:
      value = raw;
      if (value.length < 1 || value.length > 128 || /\s/.test(value)) throw new RegistryValidationError('Invalid external identifier');
  }
  const ps = input.periodStart ?? null;
  const pe = input.periodEnd ?? null;
  for (const [label, v] of [['periodStart', ps], ['periodEnd', pe]] as const) {
    if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new RegistryValidationError(`${label} must be YYYY-MM-DD`);
  }
  if (ps !== null && pe !== null && pe < ps) throw new RegistryValidationError('periodEnd before periodStart');
  return { type: input.type, system: input.system, value, periodStart: ps, periodEnd: pe };
}

export const identifierKey = (system: string, value: string): string => `${system}\u0000${value}`;

// ---------------------------------------------------------------------------
// Đối sánh trùng lặp
// ---------------------------------------------------------------------------
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export const similarity = (a: string, b: string): number => {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
};

export type MatchLevel = 'definite' | 'probable' | 'possible';
export type MatchReason =
  | 'IDENTIFIER_MATCH'
  | 'NAME_DOB_MATCH'
  | 'DOB_PHONE_MATCH'
  | 'NAME_PHONE_MATCH'
  | 'FUZZY_NAME_DOB';

export const MATCH_THRESHOLDS = { definite: 100, probable: 80, possible: 60 } as const;
export const FUZZY_NAME_MIN_SIMILARITY = 0.85;

export interface MatchProfile {
  readonly nameKey: string;
  readonly birthDate: ISODate | null;
  readonly phoneKey: string | null;
  /** true nếu chia sẻ ít nhất 1 định danh active với đối tượng so sánh (do repository xác định). */
  readonly sharesIdentifier?: boolean;
}

export interface MatchResult {
  readonly score: number;
  readonly level: MatchLevel | null;
  readonly reasons: readonly MatchReason[];
}

/** Chấm điểm hai hồ sơ; lấy điểm cao nhất trong các luật khớp. Dưới ngưỡng 'possible' => level null. */
export function scoreMatch(a: MatchProfile, b: MatchProfile): MatchResult {
  const reasons: MatchReason[] = [];
  let score = 0;
  const hit = (s: number, r: MatchReason) => { reasons.push(r); score = Math.max(score, s); };

  const sameDob = a.birthDate !== null && a.birthDate === b.birthDate;
  const samePhone = a.phoneKey !== null && a.phoneKey === b.phoneKey;
  const sameName = a.nameKey.length > 0 && a.nameKey === b.nameKey;

  if (a.sharesIdentifier || b.sharesIdentifier) hit(100, 'IDENTIFIER_MATCH');
  if (sameName && sameDob) hit(90, 'NAME_DOB_MATCH');
  if (sameDob && samePhone) hit(85, 'DOB_PHONE_MATCH');
  if (sameName && samePhone) hit(80, 'NAME_PHONE_MATCH');
  if (sameDob && !sameName && a.nameKey.length > 0 && b.nameKey.length > 0 && similarity(a.nameKey, b.nameKey) >= FUZZY_NAME_MIN_SIMILARITY) {
    hit(70, 'FUZZY_NAME_DOB');
  }
  const level: MatchLevel | null =
    score >= MATCH_THRESHOLDS.definite ? 'definite'
    : score >= MATCH_THRESHOLDS.probable ? 'probable'
    : score >= MATCH_THRESHOLDS.possible ? 'possible'
    : null;
  return { score, level, reasons };
}

export interface DuplicateCandidate {
  readonly personId: PersonId;
  readonly score: number;
  readonly level: MatchLevel;
  readonly reasons: readonly MatchReason[];
}

// ---------------------------------------------------------------------------
// Contracts của service
// ---------------------------------------------------------------------------
export interface NewPersonInput {
  readonly givenName: string;
  readonly familyName: string;
  readonly birthDate?: ISODate | null;
  readonly sex?: Sex | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly identifiers?: readonly NewIdentifierInput[];
  /** Cho phép tạo dù có ứng viên trùng mức probable (cần lý do; KHÔNG vượt được trùng định danh). */
  readonly duplicateOverride?: { readonly reason: string };
}

export interface DuplicateSearchInput {
  readonly givenName?: string;
  readonly familyName?: string;
  readonly birthDate?: ISODate | null;
  readonly phone?: string | null;
  readonly identifiers?: readonly NewIdentifierInput[];
}

export interface CreatePersonResult {
  readonly person: Person;
  readonly identifiers: readonly Identifier[];
  /** Ứng viên mức 'possible' (không chặn) để nhân viên xem xét. */
  readonly possibleDuplicates: readonly DuplicateCandidate[];
}

export interface MergePersonsInput {
  readonly sourcePersonId: PersonId;
  readonly targetPersonId: PersonId;
  readonly reason: string;
  readonly expectedSourceVersion: number;
  readonly expectedTargetVersion: number;
}

export interface PersonMergeRecord {
  readonly mergeId: string;
  readonly tenantId: Person['tenantId'];
  readonly sourcePersonId: PersonId;
  readonly targetPersonId: PersonId;
  readonly reason: string;
  readonly mergedByUserId: UserId;
  readonly sourceSnapshot: Readonly<Record<string, unknown>>;
  readonly movedPatientIds: readonly PatientId[];
  readonly movedIdentifierIds: readonly string[];
  readonly retiredIdentifierIds: readonly string[];
  readonly repointedUserIds: readonly UserId[];
  readonly mergedAt: ISODateTime;
  /** Trạng thái TARGET ngay trước merge (để unmerge hoàn nguyên phần "điền chỗ trống"). null = dòng merge cũ (trước migration 004). */
  readonly targetSnapshot: Readonly<Record<string, unknown>> | null;
  /** version của target ngay sau merge; unmerge chỉ chạy khi target chưa bị đổi kể từ đó. null = dòng merge cũ. */
  readonly targetVersionAfter: number | null;
}

export interface MergeResult {
  readonly mergeId: string;
  readonly sourcePersonId: PersonId;
  readonly targetPersonId: PersonId;
  readonly target: Person;
  readonly movedPatientIds: readonly PatientId[];
  readonly movedIdentifierIds: readonly string[];
  readonly retiredIdentifierIds: readonly string[];
  readonly repointedUserIds: readonly UserId[];
}

export interface PatientOrgRef {
  readonly patientId: PatientId;
  readonly organizationId: OrganizationId;
}

// ---------------------------------------------------------------------------
// Unmerge
// ---------------------------------------------------------------------------
export interface UnmergePersonInput {
  /** Person đã bị merge (id gốc, trạng thái `merged`). */
  readonly sourcePersonId: PersonId;
  readonly reason: string;
  readonly expectedSourceVersion: number;
  readonly expectedTargetVersion: number;
}

export type UnmergeBlocker =
  | 'MERGE_RECORD_LEGACY'
  | 'TARGET_NOT_ACTIVE'
  | 'TARGET_MODIFIED'
  | 'PATIENTS_CHANGED'
  | 'IDENTIFIERS_CHANGED'
  | 'USERS_CHANGED';

export interface PersonUnmergeRecord {
  readonly unmergeId: string;
  readonly tenantId: Person['tenantId'];
  readonly mergeId: string;
  readonly sourcePersonId: PersonId;
  readonly targetPersonId: PersonId;
  readonly reason: string;
  readonly unmergedByUserId: UserId;
  readonly restoredPatientIds: readonly PatientId[];
  readonly restoredIdentifierIds: readonly string[];
  readonly leftInactiveIdentifierIds: readonly string[];
  readonly restoredUserIds: readonly UserId[];
}

export interface UnmergeResult {
  readonly unmergeId: string;
  readonly mergeId: string;
  readonly source: Person;
  readonly target: Person;
  readonly restoredPatientIds: readonly PatientId[];
  readonly restoredIdentifierIds: readonly string[];
  /** Định danh trùng bị ngừng lúc merge: GIỮ inactive trên source (target đang giữ bản active), cần xử lý thủ công. */
  readonly leftInactiveIdentifierIds: readonly string[];
  readonly restoredUserIds: readonly UserId[];
}

// ---------------------------------------------------------------------------
// Đăng ký person + patient trong MỘT transaction (POST /fhir/Patient)
// ---------------------------------------------------------------------------
export interface RegisterPersonPatientInput {
  readonly person: NewPersonInput;
  readonly organizationId: OrganizationId;
  readonly mrn: string;
}

// ---------------------------------------------------------------------------
// Tìm kiếm bệnh nhân (trong MỘT organization)
// ---------------------------------------------------------------------------
export interface PatientSearchInput {
  readonly organizationId: OrganizationId;
  /** FHIR `identifier=system|value`. */
  readonly identifier?: { readonly system: string; readonly value: string };
  readonly mrn?: string;
  /** Tên + ngày sinh phải đi cùng nhau (không cho tìm chỉ theo tên). */
  readonly givenName?: string;
  readonly familyName?: string;
  readonly birthDate?: ISODate;
  /** 1..20 (mặc định 20). */
  readonly count?: number;
}
