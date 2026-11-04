/**
 * HCOS-R1 | /healthz (liveness) và /readyz (readiness) + PgReadinessProbe + assertSafeDatabaseRole.
 * Server node:http thật trên cổng ngẫu nhiên; pool/probe giả (kiểm DB thật nằm ở tests/integration/startup.integration.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertSafeDatabaseRole, PgReadinessProbe, UnsafeDatabaseRoleError, type ReadinessProbe,
} from '../../packages/security/src/pg-readiness';
import type { PgPoolLike } from '../../packages/security/src/tenant-context';
import { createApiServer } from '../../services/api/src/http/server';

const SECRET_MARK = 'postgres://hcos_app:s3cr3t@db.internal/hcos';

let probe: ReadinessProbe;
let server: ReturnType<typeof createApiServer>;
let base = '';
const calls = { probe: 0, clinical: 0 };

const never = new Proxy({}, { get: () => () => { calls.clinical++; throw new Error('must not be reached'); } }) as any;

beforeAll(async () => {
  probe = { check: async () => { calls.probe++; return true; } };
  server = createApiServer({
    // key không bao giờ được dùng: các endpoint health đứng trước xác thực.
    tenant: { issuer: 'i', audience: 'a', key: (async () => { throw new Error('no key'); }) as any },
    clinical: never,
    readiness: { check: () => probe.check() },
    logger: { error: () => undefined },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('GET /healthz and /readyz', () => {
  it('liveness is 200 even when the readiness dependency is down (no DB dependency)', async () => {
    probe = { check: async () => { throw new Error(`connect ECONNREFUSED ${SECRET_MARK}`); } };
    const before = calls.probe;
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(calls.probe).toBe(before);
  });

  it('readiness is 200 when the probe passes', async () => {
    probe = { check: async () => true };
    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ready' });
  });

  it('readiness is 503 with a fixed body when the probe fails or throws (no internals leaked)', async () => {
    for (const p of [
      { check: async () => false },
      { check: async () => { throw new Error(`password authentication failed ${SECRET_MARK} SELECT 1 FROM iam.tenants`); } },
    ] as ReadinessProbe[]) {
      probe = p;
      const r = await fetch(`${base}/readyz`);
      const text = await r.text();
      expect(r.status).toBe(503);
      expect(text).toBe(JSON.stringify({ status: 'unavailable' }));
      expect(text.includes('s3cr3t')).toBe(false);
      expect(text.includes('iam.tenants')).toBe(false);
    }
  });

  it('readiness is fail-closed (503) when no probe is configured; both endpoints are unauthenticated GET only', async () => {
    const s2 = createApiServer({ tenant: { issuer: 'i', audience: 'a', key: (async () => { throw new Error(); }) as any }, clinical: never });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    try {
      const b2 = `http://127.0.0.1:${(s2.address() as any).port}`;
      expect((await fetch(`${b2}/readyz`)).status).toBe(503);
      expect((await fetch(`${b2}/healthz`)).status).toBe(200);
    } finally { await new Promise<void>((r) => s2.close(() => r())); }
    // POST /readyz không phải health: đi vào xác thực => 401 (không lộ route).
    const post = await fetch(`${base}/readyz`, { method: 'POST' });
    expect(post.status).toBe(401);
    expect(calls.clinical).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('PgReadinessProbe', () => {
  const okPool = (log: string[]): PgPoolLike => ({
    async connect() {
      log.push('connect');
      return { query: async (sql: string) => { log.push(sql); return { rows: [], rowCount: 0 }; }, release: () => { log.push('release'); } } as any;
    },
  });

  it('passes when the pool works and always releases the client', async () => {
    const log: string[] = [];
    expect(await new PgReadinessProbe(okPool(log)).check()).toBe(true);
    expect(log).toEqual(['connect', 'SELECT 1 FROM iam.tenants LIMIT 0', 'release']);
  });

  it('returns false on query error, releases the client and reports only the error NAME', async () => {
    const log: string[] = []; const names: string[] = [];
    const pool: PgPoolLike = { async connect() {
      return { query: async () => { throw Object.assign(new Error(SECRET_MARK), { name: 'PgError' }); }, release: () => { log.push('release'); } } as any;
    } };
    expect(await new PgReadinessProbe(pool, { onError: (n) => names.push(n) }).check()).toBe(false);
    expect(log).toEqual(['release']);
    expect(names).toEqual(['PgError']);
  });

  it('returns false on connect failure', async () => {
    const pool: PgPoolLike = { connect: async () => { throw new Error('ECONNREFUSED'); } };
    expect(await new PgReadinessProbe(pool).check()).toBe(false);
  });

  it('has a hard timeout when connect() hangs, and releases a client that arrives late', async () => {
    const log: string[] = []; const names: string[] = [];
    let arrive!: () => void;
    const pool: PgPoolLike = { connect: () => new Promise((res) => { arrive = () => res({ query: async () => ({ rows: [], rowCount: 0 }), release: () => { log.push('release'); } } as any); }) };
    const t0 = Date.now();
    expect(await new PgReadinessProbe(pool, { timeoutMs: 80, onError: (n) => names.push(n) }).check()).toBe(false);
    expect(Date.now() - t0 < 1500).toBe(true);
    expect(names).toEqual(['ReadinessTimeout']);
    arrive();
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['release']);
  });
});

// ---------------------------------------------------------------------------
describe('assertSafeDatabaseRole', () => {
  const poolWith = (unsafe: unknown, released: string[]): PgPoolLike => ({
    async connect() { return { query: async () => ({ rows: [{ unsafe }], rowCount: 1 }), release: () => { released.push('r'); } } as any; },
  });

  it('accepts a restricted role', async () => {
    const rel: string[] = [];
    await assertSafeDatabaseRole(poolWith(false, rel));
    await assertSafeDatabaseRole(poolWith('f', rel));
    expect(rel).toHaveLength(2);
  });

  it('refuses superuser/BYPASSRLS sessions and any unreadable answer (fail-closed); still releases', async () => {
    for (const v of [true, 't', null, undefined]) {
      const rel: string[] = [];
      let err: unknown;
      try { await assertSafeDatabaseRole(poolWith(v, rel)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(UnsafeDatabaseRoleError);
      expect(rel).toHaveLength(1);
    }
  });
});
