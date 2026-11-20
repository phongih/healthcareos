/**
 * HCOS-P0-ENG-001 | IAM | Access policy theo dữ liệu (lấy ý tưởng từ AccessPolicy của Medplum, nhưng CHỈ THU HẸP).
 *
 * Một policy là danh sách luật. Mỗi luật nói: "với HÀNH ĐỘNG này, chỉ cho phép khi các ĐIỀU KIỆN khớp,
 * và (nếu là đọc) che các TRƯỜNG này / (nếu là ghi) không cho người gọi tự đặt các TRƯỜNG này".
 *
 *   { "action": "observation:write", "criteria": { "codes": ["http://loinc.org|8310-5", "http://loinc.org|8867-4"] },
 *     "readonlyFields": ["effectiveAt"] }
 *
 * "readonlyFields" ở thao tác ghi = người gọi không được đặt giá trị KHÁC mặc định của server cho trường đó
 * (vd. `effectiveAt` bị khoá => thời điểm đo luôn là lúc ghi; `status` bị khoá => chỉ ghi được 'final').
 *
 * Ngữ nghĩa (fail-closed, không leo thang quyền):
 *  1. Vai trò của membership phải có quyền nền của hành động (bảng quyền trong code). Policy KHÔNG cấp thêm quyền.
 *  2. Membership không gắn policy => được phép như cũ (tương thích ngược).
 *  3. Membership gắn policy => chỉ được phép nếu có ít nhất MỘT luật cùng action mà mọi điều kiện đều khớp.
 *     Điều kiện cần dữ kiện mà thao tác không có (vd. `practitioner` khi tìm bệnh nhân) => KHÔNG khớp.
 *  4. Policy không tải được / đã retired => membership đó không có quyền (không rơi về quyền mặc định).
 *  5. Nhiều membership/luật cùng cho phép => trường bị che / bị khoá là GIAO của chúng (luật rộng nhất thắng),
 *     vì đó là các con đường hợp lệ độc lập để có quyền.
 *  6. Bộ từ vựng (action, điều kiện, trường) là danh mục đóng; luật lạ bị từ chối khi lưu, không bị bỏ qua.
 */
import {
  TenantIsolationError,
  type AccessPolicyId,
  type ISODateTime,
  type Role,
  type TenantScoped,
  type Timestamped,
  type UserId,
  type Versioned,
} from '../../domain/src/s0-contracts';

// ---------------------------------------------------------------------------
// Danh mục
// ---------------------------------------------------------------------------
export type CriterionKey = 'practitioner' | 'encounterClass' | 'encounterStatus' | 'codes' | 'locationType';

export interface ActionSpec {
  /** Quyền nền trong bảng vai trò của service. */
  readonly basePermission: string;
  readonly description: string;
  readonly criteria: readonly CriterionKey[];
  readonly hiddenFields: readonly string[];
  readonly readonlyFields: readonly string[];
}

const ENCOUNTER_CLASSES = ['ambulatory', 'inpatient', 'emergency', 'virtual'] as const;
const ENCOUNTER_STATUSES = ['planned', 'in_progress', 'finished', 'cancelled', 'entered_in_error'] as const;
const LOCATION_TYPES = ['main_warehouse', 'dispensary_counter', 'ward_cabinet', 'quarantine'] as const;

export const ACCESS_POLICY_CATALOG = {
  'patient:read': {
    basePermission: 'chart:read',
    description: 'Đọc / tìm hồ sơ hành chính bệnh nhân (GET /fhir/Patient)',
    criteria: [],
    hiddenFields: ['person.phone', 'person.email', 'person.birthDate', 'identifiers'],
    readonlyFields: [],
  },
  'encounter:read': {
    basePermission: 'chart:read',
    description: 'Đọc bệnh án một đợt khám ($everything, Condition/Observation theo encounter)',
    criteria: ['practitioner', 'encounterClass', 'encounterStatus'],
    hiddenFields: ['encounter.reasonText', 'conditions', 'observations'],
    readonlyFields: [],
  },
  'patient:register': {
    basePermission: 'patient:register',
    description: 'Đăng ký hồ sơ bệnh nhân tại organization',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'encounter:create': {
    basePermission: 'encounter:create',
    description: 'Mở đợt khám',
    criteria: ['encounterClass'],
    hiddenFields: [],
    readonlyFields: ['periodStart'],
  },
  'condition:write': {
    basePermission: 'condition:write',
    description: 'Ghi chẩn đoán',
    criteria: ['codes'],
    hiddenFields: [],
    readonlyFields: ['category', 'clinicalStatus', 'verificationStatus', 'onsetAt'],
  },
  'observation:write': {
    basePermission: 'observation:write',
    description: 'Ghi chỉ số / kết quả quan sát',
    criteria: ['practitioner', 'codes'],
    hiddenFields: [],
    readonlyFields: ['status', 'effectiveAt'],
  },
  'encounter:close': {
    basePermission: 'encounter:close',
    description: 'Đóng đợt khám',
    criteria: ['encounterClass'],
    hiddenFields: [],
    readonlyFields: [],
  },
  'prescription:write': {
    basePermission: 'prescription:write',
    description: 'Kê đơn / huỷ đơn thuốc (bác sĩ phụ trách đợt khám)',
    criteria: ['encounterClass'],
    hiddenFields: [],
    readonlyFields: [],
  },
  'queue:read': {
    basePermission: 'queue:read',
    description: 'Xem hàng đợi khám (số thứ tự) và danh sách phòng khám',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'queue:issue': {
    basePermission: 'queue:issue',
    description: 'Cấp số thứ tự, đưa lại hàng chờ, huỷ số',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'queue:call': {
    basePermission: 'queue:call',
    description: 'Gọi số, gọi lại, đánh dấu vắng mặt, bắt đầu khám từ số đã gọi',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'queue:manage': {
    basePermission: 'queue:manage',
    description: 'Quản lý phòng khám và màn hình gọi số',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'prescription:read': {
    basePermission: 'prescription:read',
    description: 'Xem đơn thuốc theo đợt khám và hàng đợi đơn của dược',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },

  // ---- Person Registry ----------------------------------------------------
  'person:read': {
    basePermission: 'person:search',
    description: 'Đọc hồ sơ danh tính (GET /api/persons/:id)',
    criteria: [],
    hiddenFields: ['person.phone', 'person.email', 'person.birthDate', 'identifiers'],
    readonlyFields: [],
  },
  'person:search': {
    basePermission: 'person:search',
    description: 'Tìm hồ sơ trùng (POST /api/persons/search-duplicates)',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'person:create': {
    basePermission: 'person:create',
    description: 'Tạo hồ sơ danh tính (kể cả qua POST /fhir/Patient)',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'person:identifier': {
    basePermission: 'person:identifier',
    description: 'Thêm / ngừng định danh',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'person:merge': {
    basePermission: 'person:merge',
    description: 'Gộp hồ sơ trùng',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'person:unmerge': {
    basePermission: 'person:unmerge',
    description: 'Hoàn tác gộp hồ sơ',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },

  // ---- Dược ---------------------------------------------------------------
  'pharmacy:catalog:read': {
    basePermission: 'pharmacy:catalog:read',
    description: 'Xem danh mục thuốc',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'pharmacy:catalog:write': {
    basePermission: 'pharmacy:catalog:write',
    description: 'Thêm hoạt chất / biệt dược',
    criteria: [],
    hiddenFields: [],
    readonlyFields: [],
  },
  'pharmacy:location:write': {
    basePermission: 'pharmacy:location:write',
    description: 'Tạo kho / quầy / tủ trực',
    criteria: ['locationType'],
    hiddenFields: [],
    readonlyFields: [],
  },
  'pharmacy:stock:read': {
    basePermission: 'pharmacy:stock:read',
    description: 'Xem tồn kho của một vị trí',
    criteria: ['locationType'],
    hiddenFields: ['unitCost'],
    readonlyFields: [],
  },
  'pharmacy:stock:receive': {
    basePermission: 'pharmacy:stock:receive',
    description: 'Nhập kho theo lô',
    criteria: ['locationType'],
    hiddenFields: [],
    readonlyFields: [],
  },
  'pharmacy:stock:dispense': {
    basePermission: 'pharmacy:stock:dispense',
    description: 'Cấp phát thuốc theo FEFO cho một đợt khám',
    criteria: ['locationType'],
    hiddenFields: [],
    readonlyFields: [],
  },
} as const satisfies Readonly<Record<string, ActionSpec>>;

export type PolicyAction = keyof typeof ACCESS_POLICY_CATALOG;
export const POLICY_ACTIONS = Object.keys(ACCESS_POLICY_CATALOG) as PolicyAction[];

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export interface AccessCriteria {
  /** 'self' = người gọi là bác sĩ phụ trách đợt khám. */
  readonly practitioner?: 'self';
  readonly encounterClass?: readonly string[];
  readonly encounterStatus?: readonly string[];
  /** "system|code" hoặc "system|*" (mọi mã trong hệ mã). */
  readonly codes?: readonly string[];
  /** Loại vị trí kho (dược). */
  readonly locationType?: readonly string[];
}

export interface AccessRule {
  readonly action: PolicyAction;
  readonly criteria?: AccessCriteria;
  readonly hiddenFields?: readonly string[];
  readonly readonlyFields?: readonly string[];
}

export type AccessPolicyStatus = 'active' | 'retired';

export interface AccessPolicy extends TenantScoped, Versioned, Timestamped {
  readonly policyId: AccessPolicyId;
  readonly name: string;
  readonly description: string | null;
  readonly status: AccessPolicyStatus;
  readonly rules: readonly AccessRule[];
  readonly createdBy: UserId;
}

export interface AccessPolicyVersion {
  readonly policyId: AccessPolicyId;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly status: AccessPolicyStatus;
  readonly rules: readonly AccessRule[];
  readonly changedBy: string;
  readonly changedAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Kiểm định luật (khi lưu)
// ---------------------------------------------------------------------------
export class AccessPolicyValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'AccessPolicyValidationError';
  }
}

const MAX_RULES = 50;
const MAX_LIST = 200;
const CODE_TOKEN_RE = /^[^\s|]{3,200}\|(?:\*|[^\s|]{1,64})$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function stringList(raw: unknown, path: string, check: (s: string) => boolean, hint: string): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LIST) {
    throw new AccessPolicyValidationError(path, `must be a non-empty array (max ${MAX_LIST})`);
  }
  const out: string[] = [];
  raw.forEach((v, i) => {
    if (typeof v !== 'string' || !check(v)) throw new AccessPolicyValidationError(`${path}[${i}]`, hint);
    if (!out.includes(v)) out.push(v);
  });
  return out;
}

function fieldList(raw: unknown, path: string, allowed: readonly string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (allowed.length === 0) throw new AccessPolicyValidationError(path, 'is not supported for this action');
  return stringList(raw, path, (s) => allowed.includes(s), `must be one of: ${allowed.join(', ')}`);
}

/** Chuẩn hoá + kiểm định danh sách luật. Khoá lạ => lỗi (không lặng lẽ bỏ qua một giới hạn bảo mật). */
export function validateAccessRules(raw: unknown): AccessRule[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RULES) {
    throw new AccessPolicyValidationError('rules', `must be a non-empty array (max ${MAX_RULES})`);
  }
  return raw.map((r, i) => {
    const path = `rules[${i}]`;
    if (!isPlainObject(r)) throw new AccessPolicyValidationError(path, 'must be an object');
    for (const k of Object.keys(r)) {
      if (!['action', 'criteria', 'hiddenFields', 'readonlyFields'].includes(k)) {
        throw new AccessPolicyValidationError(`${path}.${k}`, 'unknown key');
      }
    }
    const action = r['action'];
    if (typeof action !== 'string' || !(action in ACCESS_POLICY_CATALOG)) {
      throw new AccessPolicyValidationError(`${path}.action`, `must be one of: ${POLICY_ACTIONS.join(', ')}`);
    }
    const spec: ActionSpec = ACCESS_POLICY_CATALOG[action as PolicyAction];

    let criteria: AccessCriteria | undefined;
    if (r['criteria'] !== undefined) {
      const c = r['criteria'];
      if (!isPlainObject(c) || Object.keys(c).length === 0) {
        throw new AccessPolicyValidationError(`${path}.criteria`, 'must be a non-empty object');
      }
      const out: { -readonly [K in keyof AccessCriteria]: AccessCriteria[K] } = {};
      for (const [k, v] of Object.entries(c)) {
        const cp = `${path}.criteria.${k}`;
        if (!(spec.criteria as readonly string[]).includes(k)) {
          throw new AccessPolicyValidationError(cp, `not applicable to ${action} (allowed: ${spec.criteria.join(', ') || 'none'})`);
        }
        switch (k as CriterionKey) {
          case 'practitioner':
            if (v !== 'self') throw new AccessPolicyValidationError(cp, "must be 'self'");
            out.practitioner = 'self';
            break;
          case 'encounterClass':
            out.encounterClass = stringList(v, cp, (s) => (ENCOUNTER_CLASSES as readonly string[]).includes(s), `must be one of: ${ENCOUNTER_CLASSES.join(', ')}`);
            break;
          case 'encounterStatus':
            out.encounterStatus = stringList(v, cp, (s) => (ENCOUNTER_STATUSES as readonly string[]).includes(s), `must be one of: ${ENCOUNTER_STATUSES.join(', ')}`);
            break;
          case 'codes':
            out.codes = stringList(v, cp, (s) => CODE_TOKEN_RE.test(s), "must be 'system|code' or 'system|*'");
            break;
          case 'locationType':
            out.locationType = stringList(v, cp, (s) => (LOCATION_TYPES as readonly string[]).includes(s), `must be one of: ${LOCATION_TYPES.join(', ')}`);
            break;
        }
      }
      criteria = out;
    }

    const hiddenFields = fieldList(r['hiddenFields'], `${path}.hiddenFields`, spec.hiddenFields);
    const readonlyFields = fieldList(r['readonlyFields'], `${path}.readonlyFields`, spec.readonlyFields);
    return {
      action: action as PolicyAction,
      ...(criteria ? { criteria } : {}),
      ...(hiddenFields ? { hiddenFields } : {}),
      ...(readonlyFields ? { readonlyFields } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Đánh giá (khi truy cập)
// ---------------------------------------------------------------------------
/** Một con đường có quyền: một membership còn hiệu lực tại organization đang thao tác. */
export interface AccessGrant {
  readonly role: Role;
  /** null = membership không gắn policy. 'unavailable' = có gắn nhưng không tải được / đã retired. */
  readonly policy: AccessPolicy | null | 'unavailable';
}

/** Dữ kiện của thao tác. Thiếu dữ kiện mà luật cần => luật không khớp. */
export interface AccessFacts {
  readonly callerUserId: UserId;
  readonly encounter?: {
    readonly practitionerUserId: string;
    readonly encounterClass: string;
    readonly status: string;
  };
  /** Dùng khi tạo đợt khám (chưa có encounter). */
  readonly encounterClass?: string;
  readonly code?: { readonly system: string; readonly code: string };
  readonly locationType?: string;
}

export type AccessDecision =
  | {
      readonly allowed: true;
      readonly hiddenFields: ReadonlySet<string>;
      readonly readonlyFields: ReadonlySet<string>;
      /** Policy đã quyết định (rỗng nếu có ít nhất một membership không bị policy giới hạn). */
      readonly policyIds: readonly AccessPolicyId[];
    }
  | { readonly allowed: false; readonly reason: 'ROLE' | 'ACCESS_POLICY' };

function criteriaMatch(c: AccessCriteria | undefined, f: AccessFacts): boolean {
  if (!c) return true;
  if (c.practitioner === 'self' && f.encounter?.practitionerUserId !== f.callerUserId) return false;
  if (c.encounterClass) {
    const cls = f.encounter?.encounterClass ?? f.encounterClass;
    if (cls === undefined || !c.encounterClass.includes(cls)) return false;
  }
  if (c.encounterStatus) {
    const st = f.encounter?.status;
    if (st === undefined || !c.encounterStatus.includes(st)) return false;
  }
  if (c.locationType) {
    if (f.locationType === undefined || !c.locationType.includes(f.locationType)) return false;
  }
  if (c.codes) {
    const code = f.code;
    if (!code) return false;
    if (!c.codes.includes(`${code.system}|${code.code}`) && !c.codes.includes(`${code.system}|*`)) return false;
  }
  return true;
}

function intersect(a: ReadonlySet<string> | null, b: readonly string[] | undefined): Set<string> {
  const next = new Set(b ?? []);
  if (a === null) return next;
  return new Set([...a].filter((x) => next.has(x)));
}

/**
 * @param rolesWithBasePermission vai trò có quyền nền của action (từ bảng quyền của service).
 */
export function decideAccess(
  grants: readonly AccessGrant[],
  action: PolicyAction,
  rolesWithBasePermission: readonly Role[],
  facts: AccessFacts,
): AccessDecision {
  const eligible = grants.filter((g) => rolesWithBasePermission.includes(g.role));
  if (eligible.length === 0) return { allowed: false, reason: 'ROLE' };

  let hidden: Set<string> | null = null;
  let readonly: Set<string> | null = null;
  const policyIds: AccessPolicyId[] = [];
  let allowed = false;

  for (const g of eligible) {
    if (g.policy === null) {
      // Con đường không bị giới hạn: thắng tuyệt đối.
      return { allowed: true, hiddenFields: new Set(), readonlyFields: new Set(), policyIds: [] };
    }
    if (g.policy === 'unavailable' || g.policy.status !== 'active') continue;
    for (const rule of g.policy.rules) {
      if (rule.action !== action || !criteriaMatch(rule.criteria, facts)) continue;
      allowed = true;
      hidden = intersect(hidden, rule.hiddenFields);
      readonly = intersect(readonly, rule.readonlyFields);
      if (!policyIds.includes(g.policy.policyId)) policyIds.push(g.policy.policyId);
    }
  }
  if (!allowed) return { allowed: false, reason: 'ACCESS_POLICY' };
  return { allowed: true, hiddenFields: hidden ?? new Set(), readonlyFields: readonly ?? new Set(), policyIds };
}

// ---------------------------------------------------------------------------
// Dựng grants từ membership (dùng chung cho mọi service)
// ---------------------------------------------------------------------------
export interface MembershipLike {
  readonly tenantId: string;
  readonly role: Role;
  readonly organizationId: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly accessPolicyId?: AccessPolicyId | null;
}

/** Membership còn hiệu lực tại thời điểm `nowMs`. */
export const isMembershipActive = (m: MembershipLike, nowMs: number): boolean =>
  m.status === 'active' && Date.parse(m.validFrom) <= nowMs && (m.validTo === null || Date.parse(m.validTo) > nowMs);

/**
 * Từ các membership đã lọc (còn hiệu lực, đúng phạm vi organization) => grants.
 * `load` chỉ được gọi khi có policy; policy khác tenant => lỗi (phòng thủ chiều sâu ngoài RLS).
 */
export async function buildGrants(
  memberships: readonly MembershipLike[],
  tenantId: string,
  load: (ids: readonly AccessPolicyId[]) => Promise<readonly AccessPolicy[]>,
): Promise<AccessGrant[]> {
  const ids = [...new Set(memberships.map((m) => m.accessPolicyId).filter((id): id is AccessPolicyId => !!id))];
  const byId = new Map<string, AccessPolicy>();
  if (ids.length > 0) {
    for (const p of await load(ids)) {
      if (p.tenantId !== tenantId) {
        throw new TenantIsolationError('RESOURCE_TENANT_MISMATCH', 'Resource belongs to a different tenant', 403);
      }
      byId.set(p.policyId, p);
    }
  }
  return memberships.map((m) => ({
    role: m.role,
    policy: m.accessPolicyId ? (byId.get(m.accessPolicyId) ?? 'unavailable') : null,
  }));
}

/** Dấu vân tay ổn định của bộ luật (ghi vào audit, không ghi nguyên văn). */
export function canonicalRulesJson(rules: readonly AccessRule[]): string {
  const sortObj = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortObj)
      : isPlainObject(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortObj(v[k])]))
        : v;
  return JSON.stringify(sortObj(rules));
}

export const REDACTED_SECURITY_LABEL = {
  system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue',
  code: 'REDACTED',
  display: 'redacted',
} as const;
