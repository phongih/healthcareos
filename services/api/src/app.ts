/**
 * HCOS-P0-ENG-001 | Lắp ráp ứng dụng (tách khỏi main.ts để test được).
 * pg.Pool (role hcos_app) -> kiểm tra role an toàn -> PgTenantStatusLookup + PgAuditSink -> services -> HTTP server.
 */
import type { Server } from 'node:http';
import { createRemoteJWKSet } from 'jose';
import pg from 'pg';

import { PgAuditSink } from '../../../packages/security/src/pg-audit-sink';
import { assertSafeDatabaseRole, PgReadinessProbe } from '../../../packages/security/src/pg-readiness';
import { PgTenantStatusLookup } from '../../../packages/security/src/pg-tenant-status';
import type { PgPoolLike } from '../../../packages/security/src/tenant-context';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from './clinical/encounter.service';
import { loadConfig } from './config';
import { createApiServer } from './http/server';
import { PersonRegistryService, PgRegistryUnitOfWork } from './registry/person-registry.service';

export interface RunningApp {
  readonly server: Server;
  readonly port: number;
  /** Ngừng nhận kết nối mới, chờ request đang chạy, đóng pool. Idempotent. */
  stop(): Promise<void>;
}

export type LogFn = (record: Readonly<Record<string, unknown>>) => void;
export const jsonLog: LogFn = (r) => console.log(JSON.stringify(r));

export async function startApp(env: Readonly<Record<string, string | undefined>>, log: LogFn = jsonLog): Promise<RunningApp> {
  const cfg = loadConfig(env);

  const pgPool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'hcos-api',
  });
  pgPool.on('error', (e: Error) => log({ level: 'error', msg: 'pg pool error', error: e.name }));
  const pool = pgPool as unknown as PgPoolLike;

  try {
    await assertSafeDatabaseRole(pool);

    const audit = new PgAuditSink(pool);
    const server = createApiServer({
      tenant: {
        issuer: cfg.issuer,
        audience: cfg.audience,
        key: createRemoteJWKSet(new URL(cfg.jwksUrl)),
        tenantStatus: new PgTenantStatusLookup(pool),
        audit,
      },
      clinical: new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit }),
      registry: new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit }),
      readiness: new PgReadinessProbe(pool, {
        timeoutMs: cfg.readyTimeoutMs,
        onError: (name) => log({ level: 'warn', msg: 'readiness check failed', error: name }),
      }),
      logger: { error: (message, meta) => log({ level: 'error', msg: message, ...meta }) },
      maxBodyBytes: cfg.maxBodyBytes,
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, resolve);
    });
    const addr = server.address() as { port: number } | null;
    const port = addr?.port ?? cfg.port;

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
      (stopping ??= new Promise<void>((resolve) => {
        server.close(() => {
          pgPool.end().then(() => resolve(), () => resolve());
        });
        server.closeIdleConnections();
      }));

    log({ level: 'info', msg: 'hcos-api listening', port });
    return { server, port, stop };
  } catch (e) {
    await pgPool.end().catch(() => undefined);
    throw e;
  }
}
