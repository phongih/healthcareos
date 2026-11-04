/**
 * HCOS-P0-ENG-001 | Slice S0 | Tenant Isolation Middleware
 *
 * Nguyên tắc:
 *  1. tenant_id CHỈ lấy từ JWT đã xác thực chữ ký. Header/body/query/path không bao giờ quyết định tenant;
 *     nếu client gửi `x-tenant-id` khác claim => từ chối (TENANT_HEADER_CONFLICT).
 *  2. Fail-closed: thiếu/sai claim, tenant bị suspended, hoặc không có context => 401/403.
 *  3. Phòng thủ nhiều lớp: (a) middleware, (b) `assertSameTenant` ở tầng service,
 *     (c) `withTenantTransaction` set `app.tenant_id` để RLS ở PostgreSQL chặn cuối cùng.
 *
 * Phụ thuộc: `jose` (xác thực JWT). Framework-agnostic: dùng với Express/Fastify/Nest qua adapter bên dưới.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { errors as joseErrors, jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';

import {
  asOrganizationId,
  asPersonId,
  asTenantId,
  isUuid,
  TenantIsolationError,
  type AuditSink,
  type CorrelationId,
  type HcosJwtClaims,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantId,
  type TenantScopedDb,
  type UserId,
} from '../../domain/src/s0-contracts';

// ---------------------------------------------------------------------------
// Context store
// ---------------------------------------------------------------------------
const storage = new AsyncLocalStorage<TenantContext>();

export const runWithTenantContext = <T>(ctx: TenantContext, fn: () => T): T => storage.run(ctx, fn);

export const getTenantContext = (): TenantContext | undefined => storage.getStore();

/** Bắt buộc phải có context; ném lỗi nếu không (fail-closed). */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantIsolationError('TENANT_CONTEXT_MISSING', 'No tenant context bound to this execution', 403);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Options & ports
// ---------------------------------------------------------------------------
export interface TenantStatusLookup {
  /** Trả về trạng thái tenant, hoặc null nếu không tồn tại. */
  getStatus(tenantId: TenantId): Promise<'provisioning' | 'active' | 'suspended' | 'closed' | null>;
}

export interface TenantContextOptions {
  readonly issuer: string | string[];
  readonly audience: string | string[];
  /** Khoá cố định hoặc JWKS resolver (createRemoteJWKSet). */
  readonly key: KeyLike | Uint8Array | JWTVerifyGetKey;
  /** Chỉ cho phép các thuật toán này (mặc định RS256/ES256; không bao giờ 'none'). */
  readonly algorithms?: string[];
  readonly clockToleranceSeconds?: number;
  readonly tenantStatus?: TenantStatusLookup;
  readonly audit?: AuditSink;
  /** Tên header tenant client có thể gửi (chỉ để so khớp, không để tin tưởng). */
  readonly tenantHeaderName?: string;
}

export interface RequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const headerValue = (h: string | string[] | undefined): string | undefined =>
  Array.isArray(h) ? h[0] : h;

const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>([
  'doctor', 'pharmacist', 'patient', 'clinic_staff', 'cashier',
  'clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin', 'system',
]);

export function extractBearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new TenantIsolationError('AUTH_MISSING_TOKEN', 'Missing Authorization header', 401);
  }
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/.exec(authorization.trim());
  if (!m || !m[1]) {
    throw new TenantIsolationError('AUTH_INVALID_TOKEN', 'Malformed bearer token', 401);
  }
  return m[1];
}

function parseTenantClaim(raw: unknown): TenantId {
  if (raw === undefined || raw === null || raw === '') {
    throw new TenantIsolationError('TENANT_CLAIM_MISSING', 'Token has no tenant_id claim', 403);
  }
  if (typeof raw !== 'string' || !isUuid(raw)) {
    throw new TenantIsolationError('TENANT_CLAIM_INVALID', 'tenant_id claim is not a valid uuid', 403);
  }
  return asTenantId(raw);
}

function parseOrgClaims(claims: Partial<HcosJwtClaims>): {
  active: OrganizationId | null;
  allowed: OrganizationId[];
} {
  const allowed: OrganizationId[] = [];
  for (const o of claims.org_ids ?? []) {
    if (!isUuid(o)) {
      throw new TenantIsolationError('TENANT_CLAIM_INVALID', 'org_ids contains invalid uuid', 403);
    }
    allowed.push(asOrganizationId(o));
  }
  let active: OrganizationId | null = null;
  if (claims.org_id !== undefined) {
    if (!isUuid(claims.org_id)) {
      throw new TenantIsolationError('TENANT_CLAIM_INVALID', 'org_id claim is invalid', 403);
    }
    active = asOrganizationId(claims.org_id);
    if (allowed.length > 0 && !allowed.includes(active)) {
      throw new TenantIsolationError('ORG_NOT_ALLOWED', 'org_id is not within org_ids', 403);
    }
    if (allowed.length === 0) allowed.push(active);
  }
  return { active, allowed };
}

// ---------------------------------------------------------------------------
// Core: build tenant context from a request
// ---------------------------------------------------------------------------
export async function buildTenantContext(
  req: RequestLike,
  opts: TenantContextOptions,
): Promise<TenantContext> {
  const token = extractBearerToken(headerValue(req.headers['authorization']));
  const correlationId = (headerValue(req.headers['x-correlation-id']) ?? randomUUID()) as CorrelationId;

  let claims: HcosJwtClaims;
  try {
    const { payload } = await jwtVerify(token, opts.key as JWTVerifyGetKey, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: opts.algorithms ?? ['RS256', 'ES256'],
      clockTolerance: opts.clockToleranceSeconds ?? 5,
      requiredClaims: ['sub', 'exp'],
    });
    claims = payload as unknown as HcosJwtClaims;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      throw new TenantIsolationError('AUTH_EXPIRED_TOKEN', 'Token expired', 401);
    }
    throw new TenantIsolationError('AUTH_INVALID_TOKEN', 'Token verification failed', 401);
  }

  const tenantId = parseTenantClaim(claims.tenant_id);

  // Client KHÔNG được chọn tenant khác với token.
  const headerName = (opts.tenantHeaderName ?? 'x-tenant-id').toLowerCase();
  const headerTenant = headerValue(req.headers[headerName]);
  if (headerTenant !== undefined && headerTenant.toLowerCase() !== tenantId) {
    throw new TenantIsolationError('TENANT_HEADER_CONFLICT', 'Tenant header does not match token tenant', 403, {
      claimTenant: tenantId,
    });
  }

  if (opts.tenantStatus) {
    const status = await opts.tenantStatus.getStatus(tenantId);
    if (status !== 'active') {
      throw new TenantIsolationError('TENANT_SUSPENDED', `Tenant is not active (${status ?? 'unknown'})`, 403);
    }
  }

  const { active, allowed } = parseOrgClaims(claims);
  const roles = (claims.roles ?? []).filter((r): r is Role => KNOWN_ROLES.has(r));

  return Object.freeze({
    tenantId,
    userSubject: claims.sub,
    userId: null as UserId | null,
    personId: claims.person_id && isUuid(claims.person_id) ? asPersonId(claims.person_id) : null,
    activeOrganizationId: active,
    allowedOrganizationIds: Object.freeze(allowed),
    roles: Object.freeze(roles),
    tokenId: claims.jti ?? null,
    correlationId,
  });
}

// ---------------------------------------------------------------------------
// Framework adapters
// ---------------------------------------------------------------------------
type Next = (err?: unknown) => void;

interface ExpressLikeRes {
  status(code: number): ExpressLikeRes;
  json(body: unknown): unknown;
}

export async function auditDenied(
  opts: TenantContextOptions,
  req: RequestLike,
  err: TenantIsolationError,
): Promise<void> {
  const claimTenant = err.details?.['claimTenant'];
  if (!opts.audit || typeof claimTenant !== 'string' || !isUuid(claimTenant)) return;
  try {
    await opts.audit.record({
      tenantId: asTenantId(claimTenant),
      actor: { type: 'user', id: 'unknown' },
      organizationId: null,
      action: 'auth.denied',
      resourceType: 'tenant',
      resourceId: claimTenant,
      personId: null,
      patientId: null,
      outcome: 'denied',
      correlationId: (headerValue(req.headers['x-correlation-id']) ?? randomUUID()) as CorrelationId,
      sourceIp: req.ip ?? null,
      userAgent: headerValue(req.headers['user-agent']) ?? null,
      payload: { code: err.code },
    });
  } catch {
    /* Audit lỗi không được làm lộ thông tin hay đổi quyết định từ chối. */
  }
}

/** Express/Connect-style middleware. Gắn context vào AsyncLocalStorage cho toàn bộ request. */
export function tenantContextMiddleware(opts: TenantContextOptions) {
  return async (req: RequestLike & { tenantContext?: TenantContext }, res: ExpressLikeRes, next: Next) => {
    try {
      const ctx = await buildTenantContext(req, opts);
      req.tenantContext = ctx;
      runWithTenantContext(ctx, () => next());
    } catch (e) {
      if (e instanceof TenantIsolationError) {
        await auditDenied(opts, req, e);
        // Thông điệp chung, không lộ chi tiết nội bộ.
        res.status(e.httpStatus).json({ error: e.code });
        return;
      }
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
    }
  };
}

/** Bao handler (Fastify/Nest/Lambda...) trong tenant context. */
export function withTenantContext<TReq extends RequestLike, TRes>(
  opts: TenantContextOptions,
  handler: (req: TReq, ctx: TenantContext) => Promise<TRes>,
) {
  return async (req: TReq): Promise<TRes> => {
    const ctx = await buildTenantContext(req, opts);
    return runWithTenantContext(ctx, () => handler(req, ctx));
  };
}

// ---------------------------------------------------------------------------
// Guards cho tầng service/repository
// ---------------------------------------------------------------------------
/** Chặn đối tượng thuộc tenant khác (phòng thủ chiều sâu ngoài RLS). */
export function assertSameTenant(resource: { readonly tenantId: string }, ctx: TenantContext = requireTenantContext()): void {
  if (resource.tenantId !== ctx.tenantId) {
    throw new TenantIsolationError('RESOURCE_TENANT_MISMATCH', 'Resource belongs to a different tenant', 403);
  }
}

export function assertOrganizationAllowed(
  organizationId: OrganizationId,
  ctx: TenantContext = requireTenantContext(),
): void {
  // Tenant admin/system truy cập mọi organization trong tenant của mình.
  if (ctx.roles.includes('tenant_admin') || ctx.roles.includes('system')) return;
  if (!ctx.allowedOrganizationIds.includes(organizationId)) {
    throw new TenantIsolationError('ORG_NOT_ALLOWED', 'Organization is outside the caller scope', 403);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL: transaction gắn tenant cho RLS
// ---------------------------------------------------------------------------
export interface PgClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike & { release(): void }>;
}

/**
 * Chạy `fn` trong 1 transaction đã SET LOCAL app.tenant_id = <tenant của context>.
 * Chỉ nhận tenant từ context đã xác thực; caller không thể truyền tenant tuỳ ý.
 */
export async function withTenantTransaction<T>(
  pool: PgPoolLike,
  fn: (db: TenantScopedDb) => Promise<T>,
  ctx: TenantContext = requireTenantContext(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(..., true) = local cho transaction; tham số hoá, không nối chuỗi.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    const db: TenantScopedDb = {
      tenantId: ctx.tenantId,
      async query<R = unknown>(sql: string, params: readonly unknown[] = []) {
        const r = await client.query(sql, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
    };
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* bỏ qua lỗi rollback */
    }
    throw e;
  } finally {
    client.release();
  }
}
