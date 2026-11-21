/**
 * HCOS-P0-ENG-001 | S2 | HTTP server (node:http).
 *
 * Thứ tự xử lý mỗi request (fail-closed):
 *   1. /healthz (liveness) và /readyz (readiness): không cần xác thực, không chạm dữ liệu tenant.
 *   2. Làm sạch correlation-id.
 *   3. Xác thực + gắn tenant TỪ JWT (buildTenantContext). Thất bại => 401/403 + audit từ chối; KHÔNG lộ route nào tồn tại.
 *   4. Khớp route (404/405) -> chạy handler trong AsyncLocalStorage tenant context.
 *   5. Mọi lỗi -> OperationOutcome an toàn; lỗi lạ -> 500 chung và ghi log kèm correlation-id.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { TenantIsolationError } from '../../../../packages/domain/src/s0-contracts';
import {
  auditDenied,
  buildTenantContext,
  runWithTenantContext,
  type TenantContextOptions,
} from '../../../../packages/security/src/tenant-context';
import type { ReadinessProbe } from '../../../../packages/security/src/pg-readiness';
import { buildBookingRoutes, handlePublicBooking, RateLimiter, type BookingApi, type PublicBookingApi } from './booking-routes';
import { buildFinanceRoutes, type FinanceApi } from './finance-routes';
import { buildDecisionRoutes, type DecisionApi } from './decision-routes';
import { buildIntegrationRoutes, type IntegrationApi } from './integration-routes';
import { buildMrnRoutes, type MrnApi } from './mrn-routes';
import { buildForecastRoutes, type ForecastApi } from './forecast-routes';
import { buildClinicalRoutes, matchRoute, type ClinicalApi, type Route } from './clinical-routes';
import { buildAccessPolicyRoutes, type AccessPolicyApi } from './iam-routes';
import { buildPharmacyRoutes, type PharmacyApi } from './pharmacy-routes';
import { buildPrescriptionRoutes, type PrescriptionApi } from './prescription-routes';
import { buildQueueRoutes, type QueueApi } from './queue-routes';
import { buildHandoverRoutes, type HandoverApi } from './handover-routes';
import { buildGovernanceRoutes, type GovernanceApi } from './governance-routes';
import { buildPiiRoutes, type PiiApi } from './pii-routes';
import { buildRegistryRoutes, type RegistryApi } from './registry-routes';
import {
  FHIR_JSON,
  HttpError,
  PLAIN_JSON,
  mapError,
  operationOutcome,
  readJsonBody,
  sanitizeCorrelationId,
  sendJson,
} from './http-kernel';

export interface ApiLogger {
  error(message: string, meta: Readonly<Record<string, unknown>>): void;
}

export interface ApiDeps {
  readonly tenant: TenantContextOptions;
  readonly clinical: ClinicalApi;
  /** Tuỳ chọn: bật các route Person Registry (/api/persons*). */
  readonly registry?: RegistryApi;
  /** Tuỳ chọn: bật các route quản trị access policy (/api/access-policies*, /api/memberships/:id/access-policy). */
  readonly accessPolicies?: AccessPolicyApi;
  /** Tuỳ chọn: bật các route dược (/api/pharmacy/*, /fhir/Medication/:id). */
  readonly pharmacy?: PharmacyApi;
  /** Tuỳ chọn: bật các route đơn thuốc (/api/prescriptions*). */
  readonly prescriptions?: PrescriptionApi;
  /** Tuỳ chọn: bật các route hàng đợi khám (/api/service-points*, /api/queue*). */
  readonly queue?: QueueApi;
  /** Tuỳ chọn: màn hình gọi số công khai GET /api/public/queue-board (header X-Display-Key), KHÔNG cần đăng nhập. */
  readonly queueBoard?: { read(key: string): Promise<unknown | null> };
  /** Tuỳ chọn: route lịch hẹn cho nhân viên (/api/bookings*, /api/booking-portal*, sức chứa phòng). */
  readonly bookings?: BookingApi;
  /** Tuỳ chọn: cổng đặt lịch công khai /api/public/booking/<slug>/*, KHÔNG cần đăng nhập (giới hạn tần suất theo IP). */
  readonly publicBooking?: PublicBookingApi;
  /** Tuỳ chọn: thu ngân (/api/finance/*). */
  readonly finance?: FinanceApi;
  /** Tuỳ chọn: dự báo kinh doanh (/api/forecast/*). */
  readonly forecast?: ForecastApi;
  /** Tuỳ chọn: Decision Engine + hộp thông báo (/api/decision/*, /api/notifications*). */
  readonly decision?: DecisionApi;
  /** Tuỳ chọn: tích hợp (/api/integrations/*). */
  readonly integrations?: IntegrationApi;
  /** Tuỳ chọn: cài đặt mã bệnh nhân (/api/patient-mrn/*). */
  readonly mrn?: MrnApi;
  /** Tuỳ chọn: quầy trả thuốc / giấy tờ / tiền (/api/handover*). */
  readonly handover?: HandoverApi;
  /** Tuỳ chọn: quản trị dữ liệu (/api/governance/*). */
  readonly governance?: GovernanceApi;
  /** Tuỳ chọn: hiện dữ liệu mã hoá + quản lý khoá (/api/pii/*, /api/keys*). */
  readonly pii?: PiiApi;
  /** Bộ giới hạn tần suất cho cổng công khai (mặc định: một bộ trong bộ nhớ cho handler này). */
  readonly rateLimiter?: RateLimiter;
  /** Probe cho GET /readyz. Không cấu hình => /readyz luôn 503 (fail-closed). */
  readonly readiness?: ReadinessProbe;
  readonly logger?: ApiLogger;
  /** Mặc định 1 MiB. */
  readonly maxBodyBytes?: number;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createApiHandler(deps: ApiDeps): ApiHandler {
  const routes: readonly Route[] = [
    ...buildClinicalRoutes(deps.clinical),
    ...(deps.registry ? buildRegistryRoutes(deps.registry) : []),
    ...(deps.accessPolicies ? buildAccessPolicyRoutes(deps.accessPolicies) : []),
    ...(deps.pharmacy ? buildPharmacyRoutes(deps.pharmacy) : []),
    ...(deps.prescriptions ? buildPrescriptionRoutes(deps.prescriptions) : []),
    ...(deps.queue ? buildQueueRoutes(deps.queue) : []),
    ...(deps.bookings ? buildBookingRoutes(deps.bookings) : []),
    ...(deps.finance ? buildFinanceRoutes(deps.finance) : []),
    ...(deps.forecast ? buildForecastRoutes(deps.forecast) : []),
    ...(deps.decision ? buildDecisionRoutes(deps.decision) : []),
    ...(deps.integrations ? buildIntegrationRoutes(deps.integrations) : []),
    ...(deps.mrn ? buildMrnRoutes(deps.mrn) : []),
    ...(deps.handover ? buildHandoverRoutes(deps.handover) : []),
    ...(deps.governance ? buildGovernanceRoutes(deps.governance) : []),
    ...(deps.pii ? buildPiiRoutes(deps.pii) : []),
  ];
  const limiter = deps.rateLimiter ?? new RateLimiter();
  const maxBody = deps.maxBodyBytes ?? 1_048_576;
  const logger: ApiLogger = deps.logger ?? { error: (m, meta) => console.error(m, JSON.stringify(meta)) };

  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const correlationId = sanitizeCorrelationId(req.headers['x-correlation-id'], randomUUID);
    const baseHeaders = { 'x-correlation-id': correlationId };

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, operationOutcome('invalid', 'Malformed request URL'), FHIR_JSON, baseHeaders);
      return;
    }

    // Liveness: chỉ cho biết tiến trình còn sống; KHÔNG phụ thuộc DB.
    if (url.pathname === '/healthz' && method === 'GET') {
      sendJson(res, 200, { status: 'ok' }, PLAIN_JSON, { ...baseHeaders, 'cache-control': 'no-store' });
      return;
    }
    // Readiness: phụ thuộc DB (có timeout trong probe). Body cố định, không lộ chi tiết nội bộ.
    if (url.pathname === '/readyz' && method === 'GET') {
      const ready = deps.readiness ? await deps.readiness.check().catch(() => false) : false;
      sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' }, PLAIN_JSON, { ...baseHeaders, 'cache-control': 'no-store' });
      return;
    }

    // Màn hình gọi số công khai: chỉ số thứ tự + phòng (không có dữ liệu bệnh nhân), xác thực bằng khoá hiển thị.
    if (url.pathname === '/api/public/queue-board' && method === 'GET' && deps.queueBoard) {
      const raw = req.headers['x-display-key'];
      const key = Array.isArray(raw) ? raw[0] : raw;
      const noStore = { ...baseHeaders, 'cache-control': 'no-store' };
      try {
        const board = key ? await deps.queueBoard.read(key) : null;
        if (!board) sendJson(res, 404, operationOutcome('not-found', 'Display not found'), FHIR_JSON, noStore);
        else sendJson(res, 200, board, PLAIN_JSON, noStore);
      } catch (e) {
        logger.error('queue board failed', { correlationId, error: e instanceof Error ? e.name : 'unknown' });
        sendJson(res, 503, operationOutcome('transient', 'Temporarily unavailable'), FHIR_JSON, noStore);
      }
      return;
    }

    // Cổng đặt lịch công khai (không đăng nhập): chỉ ghi lịch hẹn, không bao giờ trả hồ sơ bệnh nhân.
    if (deps.publicBooking && url.pathname.startsWith('/api/public/booking/')) {
      await handlePublicBooking(req, res, url, {
        api: deps.publicBooking, limiter, baseHeaders,
        onError: (e) => logger.error('public booking failed', { correlationId, error: e instanceof Error ? e.name : 'unknown' }),
      });
      return;
    }

    try {
      const reqLike = {
        headers: { ...req.headers, 'x-correlation-id': correlationId },
        ip: req.socket?.remoteAddress,
      };

      let ctx;
      try {
        ctx = await buildTenantContext(reqLike, deps.tenant);
      } catch (e) {
        if (e instanceof TenantIsolationError) await auditDenied(deps.tenant, reqLike, e);
        throw e;
      }

      const match = matchRoute(routes, method, url.pathname);
      if (match.kind === 'not-found') throw new HttpError(404, 'not-found', 'Resource not found');
      if (match.kind === 'method-not-allowed') {
        throw new HttpError(405, 'not-supported', 'Method not allowed', { allow: match.allow.join(', ') });
      }

      const result = await runWithTenantContext(ctx, () =>
        match.route.handler(
          { req, url, ctx, readBody: () => readJsonBody(req, maxBody) },
          match.ids,
        ),
      );
      sendJson(res, result.status, result.body, result.contentType, { ...baseHeaders, ...(result.headers ?? {}) });
    } catch (e) {
      const m = mapError(e);
      if (m.status >= 500) {
        logger.error('unhandled error', {
          correlationId,
          method,
          path: url.pathname,
          error: e instanceof Error ? e.name : typeof e,
        });
      }
      sendJson(res, m.status, operationOutcome(m.fhirCode, m.message, m.detail), FHIR_JSON, { ...baseHeaders, ...m.headers });
      if (m.headers['connection'] === 'close') res.once('finish', () => req.destroy());
    }
  };
}

export function createApiServer(deps: ApiDeps): Server {
  const handler = createApiHandler(deps);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': PLAIN_JSON });
      res.end();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
