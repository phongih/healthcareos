/**
 * HCOS-P0-ENG-001 | Gate G0 | Tenant isolation test suite (Vitest)
 *
 * Phạm vi:
 *  - Middleware: JWT, claim tenant, header conflict, tenant suspended, org scope, concurrency của context.
 *  - Service guards: assertSameTenant / assertOrganizationAllowed.
 *  - withTenantTransaction: luôn set app.tenant_id từ context, ROLLBACK khi lỗi.
 *  - Mô hình RLS in-memory: truy cập chéo tenant trả 0 dòng, ghi chéo tenant bị từ chối.
 *
 * Kiểm thử RLS thật trên PostgreSQL nằm ở integration suite (cần DB); suite này chạy hoàn toàn in-process.
 */
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  asOrganizationId,
  asTenantId,
  TenantIsolationError,
  type AuditSink,
  type NewAuditEvent,
  type TenantId,
} from '../../packages/domain/src/s0-contracts';
import {
  assertOrganizationAllowed,
  assertSameTenant,
  buildTenantContext,
  getTenantContext,
  requireTenantContext,
  runWithTenantContext,
  tenantContextMiddleware,
  withTenantTransaction,
  type PgPoolLike,
  type TenantContextOptions,
} from '../../packages/security/src/tenant-context';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TENANT_A = asTenantId('11111111-1111-4111-8111-111111111111');
const TENANT_B = asTenantId('22222222-2222-4222-8222-222222222222');
const ORG_A1 = asOrganizationId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const ORG_A2 = asOrganizationId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
const ISSUER = 'https://idp.healthcareos.test';
const AUDIENCE = 'healthcareos-api';

let privateKey: KeyLike;
let publicKey: KeyLike;
let otherPrivateKey: KeyLike;
let opts: TenantContextOptions;

const activeLookup = {
  getStatus: vi.fn(async (_t: TenantId) => 'active' as const),
};

interface TokenInput {
  tenant_id?: unknown;
  org_id?: string;
  org_ids?: string[];
  roles?: string[];
  sub?: string;
  exp?: string | number;
  issuer?: string;
  audience?: string;
  key?: KeyLike;
  alg?: string;
}

async function makeToken(i: TokenInput = {}): Promise<string> {
  const { tenant_id, org_id, org_ids, roles, sub, exp, issuer, audience, key, alg } = i;
  const claims: Record<string, unknown> = {};
  if ('tenant_id' in i) {
    if (tenant_id !== undefined) claims['tenant_id'] = tenant_id;
  } else {
    claims['tenant_id'] = TENANT_A;
  }
  if (org_id) claims['org_id'] = org_id;
  if (org_ids) claims['org_ids'] = org_ids;
  if (roles) claims['roles'] = roles;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: alg ?? 'RS256' })
    .setSubject(sub ?? 'user-a-1')
    .setIssuer(issuer ?? ISSUER)
    .setAudience(audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(exp ?? '5m')
    .sign(key ?? privateKey);
}

const req = (token: string | undefined, extra: Record<string, string> = {}) => ({
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  ip: '203.0.113.10',
});

async function expectDenied(p: Promise<unknown>, code: string, status?: 401 | 403) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TenantIsolationError);
    expect((e as TenantIsolationError).code).toBe(code);
    if (status) expect((e as TenantIsolationError).httpStatus).toBe(status);
    return;
  }
  throw new Error(`Expected TenantIsolationError(${code}) but call succeeded`);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
  opts = { issuer: ISSUER, audience: AUDIENCE, key: publicKey as any, tenantStatus: activeLookup };
});

// ---------------------------------------------------------------------------
// 1. Xác thực & claim tenant
// ---------------------------------------------------------------------------
describe('G0 / JWT & tenant claim', () => {
  it('binds tenant from a valid token', async () => {
    const ctx = await buildTenantContext(req(await makeToken({ roles: ['doctor'], org_id: ORG_A1 })), opts);
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(ctx.activeOrganizationId).toBe(ORG_A1);
    expect(ctx.roles).toEqual(['doctor']);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('rejects missing Authorization header (401)', async () => {
    await expectDenied(buildTenantContext(req(undefined), opts), 'AUTH_MISSING_TOKEN', 401);
  });

  it('rejects malformed bearer token (401)', async () => {
    await expectDenied(
      buildTenantContext({ headers: { authorization: 'Basic abc' } }, opts),
      'AUTH_INVALID_TOKEN',
      401,
    );
  });

  it('rejects token signed by an unknown key (401)', async () => {
    const t = await makeToken({ key: otherPrivateKey });
    await expectDenied(buildTenantContext(req(t), opts), 'AUTH_INVALID_TOKEN', 401);
  });

  it('rejects expired token (401)', async () => {
    const t = await makeToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await expectDenied(buildTenantContext(req(t), opts), 'AUTH_EXPIRED_TOKEN', 401);
  });

  it('rejects wrong audience and wrong issuer (401)', async () => {
    await expectDenied(buildTenantContext(req(await makeToken({ audience: 'other-api' })), opts), 'AUTH_INVALID_TOKEN', 401);
    await expectDenied(buildTenantContext(req(await makeToken({ issuer: 'https://evil.test' })), opts), 'AUTH_INVALID_TOKEN', 401);
  });

  it('rejects an unsigned (alg=none) token (401)', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: 'x', iss: ISSUER, aud: AUDIENCE, tenant_id: TENANT_B, exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    await expectDenied(buildTenantContext(req(unsigned), opts), 'AUTH_INVALID_TOKEN', 401);
  });

  it('rejects token without tenant_id claim (403)', async () => {
    await expectDenied(buildTenantContext(req(await makeToken({ tenant_id: undefined })), opts), 'TENANT_CLAIM_MISSING', 403);
  });

  it('rejects non-uuid / non-string tenant_id claim (403)', async () => {
    await expectDenied(buildTenantContext(req(await makeToken({ tenant_id: 'tenant-a' })), opts), 'TENANT_CLAIM_INVALID', 403);
    await expectDenied(buildTenantContext(req(await makeToken({ tenant_id: 12345 })), opts), 'TENANT_CLAIM_INVALID', 403);
    await expectDenied(
      buildTenantContext(req(await makeToken({ tenant_id: `${TENANT_A}' OR '1'='1` })), opts),
      'TENANT_CLAIM_INVALID',
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-tenant tại ranh giới request
// ---------------------------------------------------------------------------
describe('G0 / cross-tenant at request boundary', () => {
  it('rejects x-tenant-id header that differs from token tenant (403)', async () => {
    const t = await makeToken({ tenant_id: TENANT_A });
    await expectDenied(buildTenantContext(req(t, { 'x-tenant-id': TENANT_B }), opts), 'TENANT_HEADER_CONFLICT', 403);
  });

  it('accepts x-tenant-id header only when it equals token tenant (case-insensitive)', async () => {
    const t = await makeToken({ tenant_id: TENANT_A });
    const ctx = await buildTenantContext(req(t, { 'x-tenant-id': TENANT_A.toUpperCase() }), opts);
    expect(ctx.tenantId).toBe(TENANT_A);
  });

  it('rejects suspended / closed / unknown tenants (403)', async () => {
    for (const status of ['suspended', 'closed', null] as const) {
      const o: TenantContextOptions = { ...opts, tenantStatus: { getStatus: async () => status } };
      await expectDenied(buildTenantContext(req(await makeToken()), o), 'TENANT_SUSPENDED', 403);
    }
  });

  it('rejects org_id outside org_ids (403)', async () => {
    const t = await makeToken({ org_id: ORG_A2, org_ids: [ORG_A1] });
    await expectDenied(buildTenantContext(req(t), opts), 'ORG_NOT_ALLOWED', 403);
  });

  it('middleware returns 403 with generic code and does not call next()', async () => {
    const mw = tenantContextMiddleware(opts);
    const next = vi.fn();
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json } as any;
    const t = await makeToken({ tenant_id: TENANT_A });
    await mw({ ...req(t, { 'x-tenant-id': TENANT_B }) }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'TENANT_HEADER_CONFLICT' });
  });

  it('middleware audits denied cross-tenant attempt under the token tenant', async () => {
    const events: NewAuditEvent[] = [];
    const audit: AuditSink = { record: async (e) => void events.push(e) };
    const mw = tenantContextMiddleware({ ...opts, audit });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await mw(req(await makeToken({ tenant_id: TENANT_A }), { 'x-tenant-id': TENANT_B }), res, vi.fn());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: TENANT_A, action: 'auth.denied', outcome: 'denied' });
  });

  it('middleware binds context for downstream handlers and clears it afterwards', async () => {
    const mw = tenantContextMiddleware(opts);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    let seen: TenantId | undefined;
    await mw(req(await makeToken()), res, () => {
      seen = getTenantContext()?.tenantId;
    });
    expect(seen).toBe(TENANT_A);
    expect(getTenantContext()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Cách ly giữa các request đồng thời
// ---------------------------------------------------------------------------
describe('G0 / concurrent request isolation', () => {
  it('does not leak tenant context between interleaved async requests', async () => {
    const [ctxA, ctxB] = await Promise.all([
      buildTenantContext(req(await makeToken({ tenant_id: TENANT_A })), opts),
      buildTenantContext(req(await makeToken({ tenant_id: TENANT_B, sub: 'user-b-1' })), opts),
    ]);
    const observed: TenantId[] = [];
    const work = (ctx: typeof ctxA, delayMs: number) =>
      runWithTenantContext(ctx, async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        observed.push(requireTenantContext().tenantId);
        await Promise.resolve();
        return requireTenantContext().tenantId;
      });
    const [a, b] = await Promise.all([work(ctxA, 15), work(ctxB, 1)]);
    expect(a).toBe(TENANT_A);
    expect(b).toBe(TENANT_B);
    expect(observed.sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it('requireTenantContext fails closed when no context is bound', () => {
    expect(() => requireTenantContext()).toThrowError(TenantIsolationError);
    try {
      requireTenantContext();
    } catch (e) {
      expect((e as TenantIsolationError).code).toBe('TENANT_CONTEXT_MISSING');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Service-layer guards
// ---------------------------------------------------------------------------
describe('G0 / service guards', () => {
  it('assertSameTenant blocks a resource from another tenant', async () => {
    const ctxA = await buildTenantContext(req(await makeToken({ tenant_id: TENANT_A })), opts);
    expect(() => assertSameTenant({ tenantId: TENANT_A }, ctxA)).not.toThrow();
    expect(() => assertSameTenant({ tenantId: TENANT_B }, ctxA)).toThrowError(/different tenant/);
  });

  it('assertOrganizationAllowed enforces org scope, with tenant_admin override inside own tenant', async () => {
    const doctor = await buildTenantContext(req(await makeToken({ roles: ['doctor'], org_ids: [ORG_A1] })), opts);
    expect(() => assertOrganizationAllowed(ORG_A1, doctor)).not.toThrow();
    expect(() => assertOrganizationAllowed(ORG_A2, doctor)).toThrowError(/outside the caller scope/);

    const admin = await buildTenantContext(req(await makeToken({ roles: ['tenant_admin'] })), opts);
    expect(() => assertOrganizationAllowed(ORG_A2, admin)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. withTenantTransaction
// ---------------------------------------------------------------------------
function fakePool() {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  const pool: PgPoolLike = { connect: async () => client as any };
  return { pool, calls, release, client };
}

describe('G0 / withTenantTransaction', () => {
  it('sets app.tenant_id from context (parameterized) before running queries', async () => {
    const ctx = await buildTenantContext(req(await makeToken({ tenant_id: TENANT_A })), opts);
    const { pool, calls, release } = fakePool();
    await withTenantTransaction(pool, (db) => db.query('SELECT 1'), ctx);

    expect(calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      "SELECT set_config('app.tenant_id', $1, true)",
      'SELECT 1',
      'COMMIT',
    ]);
    expect(calls[1]!.params).toEqual([TENANT_A]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases connection when the callback throws', async () => {
    const ctx = await buildTenantContext(req(await makeToken()), opts);
    const { pool, calls, release } = fakePool();
    await expect(
      withTenantTransaction(pool, async () => {
        throw new Error('boom');
      }, ctx),
    ).rejects.toThrow('boom');
    expect(calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed (no DB access) when no tenant context exists', async () => {
    const { pool, client } = fakePool();
    await expect(withTenantTransaction(pool, async () => 1)).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
    expect(client.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Mô hình RLS in-memory: bằng chứng hành vi cross-tenant read/write
//    (mô phỏng policy: USING / WITH CHECK tenant_id = app.tenant_id)
// ---------------------------------------------------------------------------
interface Row {
  id: string;
  tenantId: string;
  version: number;
  name: string;
}

class RlsTable {
  private rows: Row[] = [];
  seed(r: Row) {
    this.rows.push(r);
  }
  select(currentTenant: string | undefined, id?: string): Row[] {
    if (!currentTenant) return []; // fail-closed
    return this.rows.filter((r) => r.tenantId === currentTenant && (id === undefined || r.id === id));
  }
  insert(currentTenant: string | undefined, r: Row): void {
    if (!currentTenant || r.tenantId !== currentTenant) {
      throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    }
    this.rows.push(r);
  }
  update(currentTenant: string | undefined, id: string, version: number, name: string): number {
    const target = this.select(currentTenant, id)[0];
    if (!target || target.version !== version) return 0;
    target.name = name;
    target.version += 1;
    return 1;
  }
}

describe('G0 / RLS semantics (cross-tenant data cannot be read or written)', () => {
  const table = new RlsTable();
  const patientA: Row = { id: 'p-1', tenantId: TENANT_A, version: 1, name: 'Nguyen Van A' };
  const patientB: Row = { id: 'p-2', tenantId: TENANT_B, version: 1, name: 'Tran Thi B' };

  beforeAll(() => {
    table.seed(patientA);
    table.seed(patientB);
  });

  it('tenant A cannot read tenant B rows (by id or by scan)', () => {
    expect(table.select(TENANT_A, 'p-2')).toEqual([]);
    expect(table.select(TENANT_A).map((r) => r.id)).toEqual(['p-1']);
  });

  it('tenant B cannot read tenant A rows', () => {
    expect(table.select(TENANT_B, 'p-1')).toEqual([]);
  });

  it('no tenant context => zero rows (fail-closed)', () => {
    expect(table.select(undefined)).toEqual([]);
  });

  it('tenant A cannot insert a row labelled with tenant B (WITH CHECK)', () => {
    expect(() => table.insert(TENANT_A, { id: 'x', tenantId: TENANT_B, version: 1, name: 'forged' })).toThrowError(
      /row-level security/,
    );
  });

  it('tenant A cannot update tenant B row (0 rows affected, data unchanged)', () => {
    expect(table.update(TENANT_A, 'p-2', 1, 'hacked')).toBe(0);
    expect(patientB.name).toBe('Tran Thi B');
    expect(patientB.version).toBe(1);
  });

  it('optimistic concurrency: stale version updates nothing, fresh version succeeds', () => {
    expect(table.update(TENANT_A, 'p-1', 99, 'stale')).toBe(0);
    expect(table.update(TENANT_A, 'p-1', 1, 'Nguyen Van A2')).toBe(1);
    expect(patientA.version).toBe(2);
  });
});
