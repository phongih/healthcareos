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
import { BookingService, PgBookingUnitOfWork, PublicBookingService } from './clinical/booking.service';
import { ClinicalEncounterService, PgClinicalUnitOfWork } from './clinical/encounter.service';
import { loadConfig } from './config';
import { FinanceService, PgFinanceUnitOfWork } from './finance/finance.service';
import { ForecastService, PgForecastUnitOfWork } from './analytics/forecast.service';
import { DecisionEngineService, DecisionScheduler, PgDecisionUnitOfWork } from './decision/decision.service';
import { IntegrationDispatcher, IntegrationService, PgIntegrationUnitOfWork } from './integration/integration.service';
import { SecretBox } from './integration/secrets';
import { MrnSettingsService } from './registry/mrn-settings.service';
import { httpTransport } from './integration/transport';
import { createApiServer } from './http/server';
import { AccessPolicyService, PgAccessPolicyUnitOfWork } from './iam/access-policy.service';
import { PgPharmacyUnitOfWork, PharmacyInventoryService } from './pharmacy/inventory.service';
import { PgPrescriptionUnitOfWork, PrescriptionService } from './clinical/prescription.service';
import { PgQueueBoard, PgQueueUnitOfWork, QueueService } from './clinical/queue.service';
import { HandoverService } from './clinical/handover.service';
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
    const decision = new DecisionEngineService({
      uow: new PgDecisionUnitOfWork(pool), audit, intervalMinutes: cfg.decisionIntervalSec > 0 ? Math.round(cfg.decisionIntervalSec / 60) : null,
    });
    const scheduler = new DecisionScheduler({ pool, engine: decision, intervalMs: cfg.decisionIntervalSec * 1000, log });
    const integrations = new IntegrationService({
      uow: new PgIntegrationUnitOfWork(pool), audit, box: cfg.integrationKey ? new SecretBox(cfg.integrationKey) : null, transport: httpTransport(), publicBaseUrl: cfg.publicBaseUrl,
    });
    // Không có khoá => không giải mã được URL => không chạy bộ giao.
    const dispatcher = new IntegrationDispatcher({ pool, service: integrations, intervalMs: cfg.integrationKey ? cfg.integrationDispatchSec * 1000 : 0, log });
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
      accessPolicies: new AccessPolicyService({ uow: new PgAccessPolicyUnitOfWork(pool), audit }),
      pharmacy: new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(pool), audit }),
      prescriptions: new PrescriptionService({ uow: new PgPrescriptionUnitOfWork(pool), audit }),
      queue: new QueueService({ uow: new PgQueueUnitOfWork(pool), audit }),
      queueBoard: new PgQueueBoard(pool),
      bookings: new BookingService({ uow: new PgBookingUnitOfWork(pool), audit }),
      publicBooking: new PublicBookingService({ pool, audit }),
      finance: new FinanceService({ uow: new PgFinanceUnitOfWork(pool), audit }),
      forecast: new ForecastService({ uow: new PgForecastUnitOfWork(pool), audit }),
      decision,
      integrations,
      mrn: new MrnSettingsService({ pool, audit }),
      handover: new HandoverService({ pool, audit }),
      readiness: new PgReadinessProbe(pool, {
        timeoutMs: cfg.readyTimeoutMs,
        onError: (name) => log({ level: 'warn', msg: 'readiness check failed', error: name }),
      }),
      logger: { error: (message, meta) => log({ level: 'error', msg: message, ...meta }) },
      maxBodyBytes: cfg.maxBodyBytes,
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (cfg.host) server.listen(cfg.port, cfg.host, resolve);
      else server.listen(cfg.port, resolve);
    });
    const addr = server.address() as { port: number } | null;
    const port = addr?.port ?? cfg.port;
    scheduler.start();
    dispatcher.start();

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
      (stopping ??= new Promise<void>((resolve) => {
        server.close(() => {
          Promise.all([scheduler.stop(), dispatcher.stop()])
            .catch(() => undefined)
            .then(() => pgPool.end())
            .then(() => resolve(), () => resolve());
        });
        server.closeIdleConnections();
      }));

    log({ level: 'info', msg: 'hcos-api listening', port, decisionIntervalSec: cfg.decisionIntervalSec, integrations: cfg.integrationKey ? 'enabled' : 'disabled (HCOS_INTEGRATION_KEY not set)' });
    return { server, port, stop };
  } catch (e) {
    await pgPool.end().catch(() => undefined);
    throw e;
  }
}
