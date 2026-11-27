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
import { GovernanceService } from './governance/governance.service';
import { RetentionScheduler, RetentionService } from './governance/retention.service';
import { NoShowJob } from './clinical/no-show.job';
import { KeycloakAdminClient, NOT_CONFIGURED } from './iam/keycloak-admin';
import { StaffAdminService } from './iam/staff-admin.service';
import { asTenantId } from '../../../packages/domain/src/s0-contracts';
import { PgOrgScopeLookup } from '../../../packages/security/src/pg-org-scope';
import { ExportService } from './governance/export.service';
import { VendorService } from './governance/vendor.service';
import { EquipmentService } from './equipment/equipment.service';
import { otpSenderFor } from './portal/otp-sender';
import { NO_SIGNUP_OTP_CHANNEL, SignupService } from './signup/signup.service';
import { PlatformReviewService } from './platform/review.service';
import { smtpSignupOtp } from './signup/smtp-otp-sender';
import { PortalAdminService } from './portal/portal-admin.service';
import { PortalService } from './portal/portal.service';
import { PiiService } from './security/pii.service';
import { configureKeyProvider } from '../../../packages/security/src/pii';
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
  // HCOS-F16: KEK chỉ nằm trong bộ nhớ tiến trình (từ biến môi trường), không bao giờ ghi vào CSDL.
  configureKeyProvider(cfg.keyProvider);

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
    const registry = new PersonRegistryService({ uow: new PgRegistryUnitOfWork(pool), audit, trainingEnv: cfg.trainingEnv });
    const decision = new DecisionEngineService({
      uow: new PgDecisionUnitOfWork(pool), audit, intervalMinutes: cfg.decisionIntervalSec > 0 ? Math.round(cfg.decisionIntervalSec / 60) : null,
    });
    const scheduler = new DecisionScheduler({ pool, engine: decision, intervalMs: cfg.decisionIntervalSec * 1000, log });
    const integrations = new IntegrationService({
      uow: new PgIntegrationUnitOfWork(pool), audit, box: cfg.integrationKey ? new SecretBox(cfg.integrationKey) : null, transport: httpTransport(), publicBaseUrl: cfg.publicBaseUrl,
    });
    // Không có khoá => không giải mã được URL => không chạy bộ giao.
    const dispatcher = new IntegrationDispatcher({ pool, service: integrations, intervalMs: cfg.integrationKey ? cfg.integrationDispatchSec * 1000 : 0, log });
    const retention = new RetentionService({ pool, audit, backupHorizonDays: cfg.backupHorizonDays });
    const governance = new GovernanceService({ pool, audit });
    const finance = new FinanceService({ uow: new PgFinanceUnitOfWork(pool), audit });
    const equipment = new EquipmentService({ pool, audit });
    const publicBooking = new PublicBookingService({ pool, audit });
    // HCOS-F20: cổng bệnh nhân (tắt mặc định; HCOS_PORTAL_OTP=training|webhook để bật đăng nhập).
    const portal = new PortalService({ pool, audit, sender: otpSenderFor(cfg.portalOtp, httpTransport()), publicBooking, retention });
    // Đăng ký khách: tắt nếu chưa có khoá OTP. Kênh gửi OTP chưa cấu hình => mọi lần gửi trả OTP_UNAVAILABLE (fail-closed).
    const keycloakIdp = cfg.keycloakAdmin ? new KeycloakAdminClient(cfg.keycloakAdmin) : NOT_CONFIGURED;
    // Kênh OTP: SMTP nếu đã cấu hình (vẫn phải được duyệt trong platform.signup_vendors), không thì NO_SIGNUP_OTP_CHANNEL.
    const publicSignup = cfg.signupOtpKey
      ? new SignupService({
          pool,
          sender: cfg.signupSmtp ? smtpSignupOtp(cfg.signupSmtp) : NO_SIGNUP_OTP_CHANNEL,
          otpKey: cfg.signupOtpKey,
          idp: keycloakIdp,
        })
      : null;
    const orgScope = new PgOrgScopeLookup(pool);
    // HCOS-F21: quản trị nhân sự & cơ sở (tài khoản Keycloak qua client service-account riêng).
    const staffAdmin = new StaffAdminService({
      pool, audit, idp: keycloakIdp,
      onAccessChanged: (t) => orgScope.invalidate(asTenantId(t)),
    });
    const noShow = new NoShowJob({ pool, intervalMs: cfg.noShowIntervalSec * 1000, log });
    const retentionScheduler = new RetentionScheduler({ pool, service: retention, intervalMs: cfg.retentionIntervalSec * 1000, log });
    const server = createApiServer({
      tenant: {
        issuer: cfg.issuer,
        audience: cfg.audience,
        key: createRemoteJWKSet(new URL(cfg.jwksUrl)),
        tenantStatus: new PgTenantStatusLookup(pool),
        // Cơ sở được phép theo membership trong DB của từng user (không tin claim org_ids cố định của IdP).
        orgScope,
        requireAmr: cfg.requireAmr,
        audit,
      },
      clinical: new ClinicalEncounterService({ uow: new PgClinicalUnitOfWork(pool), audit, trainingEnv: cfg.trainingEnv }),
      registry,
      accessPolicies: new AccessPolicyService({ uow: new PgAccessPolicyUnitOfWork(pool), audit }),
      pharmacy: new PharmacyInventoryService({ uow: new PgPharmacyUnitOfWork(pool), audit }),
      prescriptions: new PrescriptionService({ uow: new PgPrescriptionUnitOfWork(pool), audit }),
      queue: new QueueService({ uow: new PgQueueUnitOfWork(pool), audit }),
      queueBoard: new PgQueueBoard(pool),
      bookings: new BookingService({ uow: new PgBookingUnitOfWork(pool), audit, registrar: (input, ctx) => registry.registerPersonAndPatient(input as never, ctx) }),
      publicBooking,
      ...(publicSignup ? { publicSignup } : {}),
      finance,
      forecast: new ForecastService({ uow: new PgForecastUnitOfWork(pool), audit }),
      decision,
      integrations,
      mrn: new MrnSettingsService({ pool, audit }),
      handover: new HandoverService({ pool, audit }),
      governance,
      vendors: new VendorService({ pool, audit }),
      exports: new ExportService({ pool, audit, finance, governance, retention, equipment }),
      equipment,
      portal,
      portalAdmin: new PortalAdminService({ pool, audit }),
      staffAdmin,
      platformReview: new PlatformReviewService({ pool }),
      pii: new PiiService({ pool, audit }),
      retention,
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
    retentionScheduler.start();
    noShow.start();

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
      (stopping ??= new Promise<void>((resolve) => {
        server.close(() => {
          Promise.all([scheduler.stop(), dispatcher.stop(), retentionScheduler.stop(), noShow.stop()])
            .catch(() => undefined)
            .then(() => pgPool.end())
            .then(() => resolve(), () => resolve());
        });
        server.closeIdleConnections();
      }));

    log({ level: 'info', msg: 'hcos-api listening', port, decisionIntervalSec: cfg.decisionIntervalSec, integrations: cfg.integrationKey ? 'enabled' : 'disabled (HCOS_INTEGRATION_KEY not set)', mfa: cfg.requireAmr.length ? cfg.requireAmr.join(',') : 'not enforced at API', staffAdmin: cfg.keycloakAdmin ? 'keycloak' : 'disabled (HCOS_KC_ADMIN_CLIENT_SECRET not set)' });
    return { server, port, stop };
  } catch (e) {
    await pgPool.end().catch(() => undefined);
    throw e;
  }
}
