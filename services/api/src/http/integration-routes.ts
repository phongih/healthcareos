/**
 * HCOS-F12 | HTTP: kết nối tích hợp.
 *   GET  /api/integrations/catalog                                   loại kết nối, loại sự kiện, bật / tắt
 *   GET  /api/integrations/overview?organization=                    (integration:read)
 *   GET  /api/integrations/endpoints?organization=                   (integration:read)
 *   POST /api/integrations/endpoints                                 tạo (integration:manage) — webhook trả signingSecret một lần
 *   POST /api/integrations/endpoints/:id            + If-Match       sửa tên / sự kiện / mức ưu tiên / URL (tuỳ chọn) / đổi bí mật
 *   POST /api/integrations/endpoints/:id/status     + If-Match       { status: active | paused | retired }
 *   POST /api/integrations/endpoints/:id/test                        gửi thẻ kiểm tra ngay
 *   GET  /api/integrations/endpoints/:id/history
 *   GET  /api/integrations/deliveries?organization=&endpoint=&status=&limit=
 *   GET  /api/integrations/deliveries/:id/attempts
 *   POST /api/integrations/deliveries/:id/retry                      gửi lại ngay
 */
import type { EndpointKind } from '../integration/targets';
import type { EndpointStatus, IntegrationService } from '../integration/integration.service';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type IntegrationApi = Pick<
  IntegrationService,
  'catalog' | 'overview' | 'listEndpoints' | 'createEndpoint' | 'updateEndpoint' | 'setEndpointStatus' | 'testEndpoint' | 'endpointHistory' | 'deliveries' | 'deliveryAttempts' | 'retryDelivery'
>;

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({ status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}) });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
function params(url: URL, allowed: readonly string[]): URLSearchParams {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
  for (const k of allowed) if (url.searchParams.getAll(k).length > 1) throw new HttpError(400, 'invalid', `Parameter '${k}' repeated`);
  return url.searchParams;
}
const required = (p: URLSearchParams, k: string): string => {
  const v = p.get(k);
  if (!v) throw new HttpError(400, 'required', `Parameter '${k}' is required`);
  return v;
};
const str = (o: Record<string, unknown>, k: string): string => {
  if (typeof o[k] !== 'string') throw new HttpError(400, 'invalid', `${k} must be a string`);
  return o[k] as string;
};
const num = (o: Record<string, unknown>, k: string): number => {
  if (typeof o[k] !== 'number') throw new HttpError(400, 'invalid', `${k} must be a number`);
  return o[k] as number;
};
const arr = (o: Record<string, unknown>, k: string): string[] => {
  if (!Array.isArray(o[k])) throw new HttpError(400, 'invalid', `${k} must be an array`);
  return o[k] as string[];
};
const etag = (v: number) => ({ etag: `W/"${v}"` });
// Bí mật ký chỉ trả một lần: không được cache ở bất kỳ đâu.
const noStore = { 'cache-control': 'no-store' };

export function buildIntegrationRoutes(api: IntegrationApi): readonly Route[] {
  return [
    { method: 'GET', pattern: ['api', 'integrations', 'catalog'], handler: async () => json(200, api.catalog()) },
    {
      method: 'GET',
      pattern: ['api', 'integrations', 'overview'],
      handler: async (input) => json(200, await api.overview(required(params(input.url, ['organization']), 'organization'), input.ctx)),
    },
    {
      method: 'GET',
      pattern: ['api', 'integrations', 'endpoints'],
      handler: async (input) => json(200, { endpoints: await api.listEndpoints(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'integrations', 'endpoints'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'kind', 'name', 'url', 'eventTypes', 'maxPriority']);
        const r = await api.createEndpoint(
          { organizationId: str(o, 'organizationId'), kind: str(o, 'kind') as EndpointKind, name: str(o, 'name'), url: str(o, 'url'), eventTypes: arr(o, 'eventTypes'), maxPriority: num(o, 'maxPriority') },
          input.ctx,
        );
        return json(201, r, { ...etag(r.endpoint.version), ...noStore });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'integrations', 'endpoints', ':id'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['name', 'url', 'eventTypes', 'maxPriority', 'rotateSecret']);
        if (o['rotateSecret'] !== undefined && typeof o['rotateSecret'] !== 'boolean') throw new HttpError(400, 'invalid', 'rotateSecret must be a boolean');
        const r = await api.updateEndpoint(
          id!,
          {
            name: str(o, 'name'), eventTypes: arr(o, 'eventTypes'), maxPriority: num(o, 'maxPriority'),
            ...(o['url'] !== undefined && o['url'] !== null ? { url: str(o, 'url') } : {}), ...(o['rotateSecret'] === true ? { rotateSecret: true } : {}),
          },
          version,
          input.ctx,
        );
        return json(200, r, { ...etag(r.endpoint.version), ...noStore });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'integrations', 'endpoints', ':id', 'status'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['status']);
        const r = await api.setEndpointStatus(id!, str(o, 'status') as EndpointStatus, version, input.ctx);
        return json(200, r, etag(r.endpoint.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'integrations', 'endpoints', ':id', 'test'],
      handler: async (input, [id]) => json(200, await api.testEndpoint(id!, input.ctx)),
    },
    {
      method: 'GET',
      pattern: ['api', 'integrations', 'endpoints', ':id', 'history'],
      handler: async (input, [id]) => {
        params(input.url, []);
        return json(200, { history: await api.endpointHistory(id!, input.ctx) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'integrations', 'deliveries'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'endpoint', 'status', 'limit']);
        const l = p.get('limit');
        if (l !== null && !/^\d{1,4}$/.test(l)) throw new HttpError(400, 'invalid', 'limit must be a number');
        const endpoint = p.get('endpoint');
        const status = p.get('status');
        return json(200, {
          deliveries: await api.deliveries(
            { organizationId: required(p, 'organization'), ...(l ? { limit: Number(l) } : {}), ...(endpoint ? { endpointId: endpoint } : {}), ...(status ? { status } : {}) },
            input.ctx,
          ),
        });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'integrations', 'deliveries', ':id', 'attempts'],
      handler: async (input, [id]) => {
        params(input.url, []);
        return json(200, { attempts: await api.deliveryAttempts(id!, input.ctx) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'integrations', 'deliveries', ':id', 'retry'],
      handler: async (input, [id]) => json(200, await api.retryDelivery(id!, input.ctx)),
    },
  ];
}
