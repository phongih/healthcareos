/**
 * HCOS-P0-ENG-001 | Slice S0 | Domain contracts
 * Tenant Isolation, Patient Identity (person_id vs patient_id), Audit Event Envelope.
 *
 * Quy ước:
 *  - Branded ID types ngăn nhầm lẫn PersonId / PatientId / TenantId ở compile-time.
 *  - Mọi aggregate persistent đều mang `tenantId` và `version` (optimistic concurrency).
 */

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type OrganizationId = Brand<string, 'OrganizationId'>;
export type UserId = Brand<string, 'UserId'>;
export type MembershipId = Brand<string, 'MembershipId'>;
/** Danh tính con người (1 người = 1 person trong tenant). */
export type PersonId = Brand<string, 'PersonId'>;
/** Hồ sơ bệnh nhân tại 1 organization (1 person có thể có nhiều patient). */
export type PatientId = Brand<string, 'PatientId'>;
export type IdentifierId = Brand<string, 'IdentifierId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const asTenantId = (v: string): TenantId => {
  if (!isUuid(v)) throw new TypeError('Invalid TenantId (uuid expected)');
  return v.toLowerCase() as TenantId;
};
export const asOrganizationId = (v: string): OrganizationId => {
  if (!isUuid(v)) throw new TypeError('Invalid OrganizationId (uuid expected)');
  return v.toLowerCase() as OrganizationId;
};
export const asUserId = (v: string): UserId => {
  if (!isUuid(v)) throw new TypeError('Invalid UserId (uuid expected)');
  return v.toLowerCase() as UserId;
};
export const asPersonId = (v: string): PersonId => {
  if (!isUuid(v)) throw new TypeError('Invalid PersonId (uuid expected)');
  return v.toLowerCase() as PersonId;
};
export const asPatientId = (v: string): PatientId => {
  if (!isUuid(v)) throw new TypeError('Invalid PatientId (uuid expected)');
  return v.toLowerCase() as PatientId;
};

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------
export type ISODateTime = string;
export type ISODate = string;

/** Trường chung cho mọi aggregate có tenant. */
export interface TenantScoped {
  readonly tenantId: TenantId;
}

/** Optimistic concurrency. */
export interface Versioned {
  readonly version: number;
}

export interface Timestamped {
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// IAM
// ---------------------------------------------------------------------------
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'closed';

export interface Tenant extends Versioned, Timestamped {
  readonly tenantId: TenantId;
  readonly code: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly region: string;
}

export type OrganizationType =
  | 'hospital_group'
  | 'clinic'
  | 'pharmacy_chain'
  | 'pharmacy_store'
  | 'department'
  | 'headquarters';

export interface Organization extends TenantScoped, Versioned, Timestamped {
  readonly organizationId: OrganizationId;
  readonly parentOrganizationId: OrganizationId | null;
  readonly type: OrganizationType;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export type UserStatus = 'invited' | 'active' | 'locked' | 'disabled';

export interface User extends TenantScoped, Versioned, Timestamped {
  readonly userId: UserId;
  readonly externalSubject: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly personId: PersonId | null;
  readonly status: UserStatus;
  readonly lastLoginAt: ISODateTime | null;
}

export type Role =
  | 'doctor'
  | 'pharmacist'
  | 'patient'
  | 'clinic_staff'
  | 'cashier'
  | 'clinic_admin'
  | 'pharmacy_admin'
  | 'executive'
  | 'tenant_admin'
  | 'system';

export type MembershipStatus = 'active' | 'suspended' | 'revoked';

export interface Membership extends TenantScoped, Versioned, Timestamped {
  readonly membershipId: MembershipId;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly role: Role;
  readonly status: MembershipStatus;
  readonly validFrom: ISODateTime;
  readonly validTo: ISODateTime | null;
}

// ---------------------------------------------------------------------------
// Patient identity: person_id vs patient_id
// ---------------------------------------------------------------------------
export type Sex = 'male' | 'female' | 'other' | 'unknown';
export type PersonStatus = 'active' | 'merged' | 'deceased' | 'inactive';

/** Con người thật trong tenant. Là gốc để hợp nhất (merge) trùng lặp. */
export interface Person extends TenantScoped, Versioned, Timestamped {
  readonly personId: PersonId;
  readonly givenName: string;
  readonly familyName: string;
  readonly birthDate: ISODate | null;
  readonly sex: Sex | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: PersonStatus;
  /** Khác null khi status = 'merged'. */
  readonly mergedIntoPersonId: PersonId | null;
}

export type PatientStatus = 'active' | 'inactive' | 'deceased' | 'entered_in_error';

/** Hồ sơ bệnh nhân của 1 person tại 1 organization. Dữ liệu lâm sàng tham chiếu patient_id. */
export interface Patient extends TenantScoped, Versioned, Timestamped {
  readonly patientId: PatientId;
  readonly personId: PersonId;
  readonly organizationId: OrganizationId;
  readonly mrn: string;
  readonly status: PatientStatus;
  readonly registeredAt: ISODateTime;
}

export type IdentifierType =
  | 'national_id'
  | 'health_insurance'
  | 'passport'
  | 'mrn'
  | 'phone'
  | 'external';

export type IdentifierStatus = 'active' | 'inactive' | 'entered_in_error';

export interface Identifier extends TenantScoped, Versioned, Timestamped {
  readonly identifierId: IdentifierId;
  readonly personId: PersonId;
  /** null = định danh cấp person (CCCD, BHYT); có giá trị = định danh cấp patient (MRN). */
  readonly patientId: PatientId | null;
  readonly type: IdentifierType;
  readonly system: string;
  readonly value: string;
  readonly status: IdentifierStatus;
  readonly periodStart: ISODate | null;
  readonly periodEnd: ISODate | null;
}

/** Tham chiếu danh tính dùng trong audit & sự kiện: luôn tách rõ 2 loại ID. */
export interface PatientIdentityRef {
  readonly personId: PersonId;
  readonly patientId?: PatientId;
}

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------
/** Claims bắt buộc trong JWT access token. */
export interface HcosJwtClaims {
  readonly iss: string;
  readonly aud: string | string[];
  readonly sub: string;
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  /** Tenant của principal. Bắt buộc. */
  readonly tenant_id: string;
  /** Organization đang hoạt động (tuỳ chọn). */
  readonly org_id?: string;
  /** Tập organization được phép truy cập. */
  readonly org_ids?: string[];
  readonly roles?: Role[];
  readonly person_id?: string;
  readonly scope?: string;
}

export interface TenantContext {
  readonly tenantId: TenantId;
  readonly userSubject: string;
  readonly userId: UserId | null;
  readonly personId: PersonId | null;
  readonly activeOrganizationId: OrganizationId | null;
  readonly allowedOrganizationIds: readonly OrganizationId[];
  readonly roles: readonly Role[];
  readonly tokenId: string | null;
  readonly correlationId: CorrelationId;
}

export type TenantIsolationErrorCode =
  | 'AUTH_MISSING_TOKEN'
  | 'AUTH_INVALID_TOKEN'
  | 'AUTH_EXPIRED_TOKEN'
  | 'TENANT_CLAIM_MISSING'
  | 'TENANT_CLAIM_INVALID'
  | 'TENANT_MISMATCH'
  | 'TENANT_HEADER_CONFLICT'
  | 'TENANT_SUSPENDED'
  | 'TENANT_CONTEXT_MISSING'
  | 'ORG_NOT_ALLOWED'
  | 'RESOURCE_TENANT_MISMATCH';

export class TenantIsolationError extends Error {
  public readonly code: TenantIsolationErrorCode;
  public readonly httpStatus: 401 | 403;
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: TenantIsolationErrorCode,
    message: string,
    httpStatus: 401 | 403,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'TenantIsolationError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Audit event envelope
// ---------------------------------------------------------------------------
export type AuditActorType = 'user' | 'service' | 'system';
export type AuditOutcome = 'success' | 'denied' | 'failure';

export interface AuditActor {
  readonly type: AuditActorType;
  readonly id: string;
}

/** Envelope audit: schemaVersion cố định = 1 ở S0. */
export interface AuditEventEnvelope extends TenantScoped {
  readonly eventId: AuditEventId;
  readonly schemaVersion: 1;
  readonly occurredAt: ISODateTime;
  readonly actor: AuditActor;
  readonly organizationId: OrganizationId | null;
  /** Dạng `<resource>.<verb>`, vd: patient.read, auth.denied. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly personId: PersonId | null;
  readonly patientId: PatientId | null;
  readonly outcome: AuditOutcome;
  readonly correlationId: CorrelationId;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  /** Không được chứa PHI thô; chỉ metadata/ID. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Bản ghi đã lưu: thêm hash-chain do DB gán. */
export interface StoredAuditEvent extends AuditEventEnvelope {
  readonly prevHash: string;
  readonly eventHash: string;
}

export type NewAuditEvent = Omit<AuditEventEnvelope, 'eventId' | 'schemaVersion' | 'occurredAt'> & {
  readonly eventId?: AuditEventId;
  readonly occurredAt?: ISODateTime;
};

export interface AuditSink {
  record(event: NewAuditEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
export type OutboxStatus = 'pending' | 'published' | 'failed' | 'dead';

export interface OutboxEvent extends TenantScoped, Versioned {
  readonly outboxId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: ISODateTime;
  readonly publishedAt: ISODateTime | null;
}

// ---------------------------------------------------------------------------
// Persistence boundary
// ---------------------------------------------------------------------------
/** Query runner đã bị ràng buộc vào 1 tenant (RLS đã được set trong transaction). */
export interface TenantScopedDb {
  readonly tenantId: TenantId;
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

/** Lỗi xung đột phiên bản (optimistic concurrency). */
export class VersionConflictError extends Error {
  constructor(
    public readonly resource: string,
    public readonly id: string,
    public readonly expectedVersion: number,
  ) {
    super(`Version conflict on ${resource}:${id} (expected v${expectedVersion})`);
    this.name = 'VersionConflictError';
  }
}
