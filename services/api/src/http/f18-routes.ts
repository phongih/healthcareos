/**
 * HCOS-F18 | HTTP: sổ nhà cung cấp + xuất dữ liệu qua máy chủ (JSON thường).
 *
 *   GET  /api/vendors                       sổ nhà cung cấp + trạng thái đánh giá                    (vendor:read)
 *   POST /api/vendors                       { name, kind, role, services, contact? }                  (vendor:manage)
 *   GET  /api/vendors/:id/assessments       lịch sử đánh giá                                          (vendor:read)
 *   POST /api/vendors/:id/assessments       { decision, dpaReference?, dataCategories, dataLocation, crossBorder, measures, rationale, validFrom, validUntil }
 *   POST /api/vendors/:id/status            { status, note?, version }                                (vendor:manage)
 *   POST /api/exports                       { dataset, params?, purpose? } => file (base64) + ghi sổ xuất (quyền theo bộ dữ liệu)
 *   GET  /api/exports?sha256=               nhật ký xuất / tra cứu file theo SHA-256                  (export:audit)
 */
import type { ExportService } from '../governance/export.service';
import type { VendorService } from '../governance/vendor.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type VendorApi = Pick<VendorService, 'list' | 'create' | 'assessments' | 'assess' | 'setStatus'>;
export type ExportApi = Pick<ExportService, 'create' | 'list'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}

export function buildF18Routes(vendors: VendorApi | undefined, exportsApi: ExportApi | undefined): readonly Route[] {
  const r: Route[] = [];
  if (vendors) {
    r.push(
      { method: 'GET', pattern: ['api', 'vendors'], handler: async (input) => json(200, await vendors.list(input.ctx)) },
      {
        method: 'POST', pattern: ['api', 'vendors'],
        handler: async (input) => {
          const o = await obj(input, ['name', 'kind', 'role', 'services', 'contact']);
          return json(201, await vendors.create({ name: o['name'], kind: o['kind'], role: o['role'], services: o['services'], contact: o['contact'] }, input.ctx));
        },
      },
      { method: 'GET', pattern: ['api', 'vendors', ':id', 'assessments'], handler: async (input, [id]) => json(200, { assessments: await vendors.assessments(id!, input.ctx) }) },
      {
        method: 'POST', pattern: ['api', 'vendors', ':id', 'assessments'],
        handler: async (input, [id]) => {
          const o = await obj(input, ['decision', 'dpaReference', 'dataCategories', 'dataLocation', 'crossBorder', 'measures', 'rationale', 'validFrom', 'validUntil']);
          return json(201, await vendors.assess(id!, o as never, input.ctx));
        },
      },
      {
        method: 'POST', pattern: ['api', 'vendors', ':id', 'status'],
        handler: async (input, [id]) => {
          const o = await obj(input, ['status', 'note', 'version']);
          return json(200, await vendors.setStatus(id!, { status: o['status'], note: o['note'], version: o['version'] }, input.ctx));
        },
      },
    );
  }
  if (exportsApi) {
    r.push(
      {
        method: 'POST', pattern: ['api', 'exports'],
        handler: async (input) => {
          const o = await obj(input, ['dataset', 'params', 'purpose']);
          return json(201, await exportsApi.create({ dataset: o['dataset'], params: o['params'], purpose: o['purpose'] }, input.ctx));
        },
      },
      {
        method: 'GET', pattern: ['api', 'exports'],
        handler: async (input) => {
          for (const k of input.url.searchParams.keys()) if (k !== 'sha256') throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
          return json(200, { exports: await exportsApi.list({ sha256: input.url.searchParams.get('sha256') ?? undefined }, input.ctx) });
        },
      },
    );
  }
  return r;
}
