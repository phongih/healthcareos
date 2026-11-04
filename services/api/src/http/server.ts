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
import { buildClinicalRoutes, matchRoute, type ClinicalApi, type Route } from './clinical-routes';
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
  ];
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
