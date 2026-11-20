/**
 * HCOS-F10 | HTTP: dự báo kinh doanh.
 *   GET  /api/forecast/load?organization=&days=7..30      tải phòng khám theo ngày × buổi × phòng   (forecast:read)
 *   GET  /api/forecast/inventory?organization=            điểm đặt hàng lại thuốc                  (forecast:inventory)
 *   GET  /api/forecast/cashflow?organization=             cơ sở cho dòng tiền 30 ngày + What-If     (forecast:read)
 *   GET  /api/forecast/settings?organization=             thông số + lịch sử thay đổi
 *   POST /api/forecast/settings  { organizationId, fixedCostsMonthly, variableCostPct, leadTimeDays, serviceLevelPct } + If-Match (W/"0" lần đầu)
 *   POST /api/forecast/capacity/:servicePointId  { visitCapacity: number|null } + If-Match       (forecast:manage)
 */
import type { ForecastService } from '../analytics/forecast.service';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type ForecastApi = Pick<ForecastService, 'load' | 'inventory' | 'cashflowBase' | 'getSettings' | 'updateSettings' | 'setVisitCapacity'>;

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
  return url.searchParams;
}
const required = (p: URLSearchParams, k: string): string => {
  const v = p.get(k);
  if (!v || p.getAll(k).length > 1) throw new HttpError(400, 'required', `Parameter '${k}' is required`);
  return v;
};
const num = (o: Record<string, unknown>, k: string): number => {
  if (typeof o[k] !== 'number') throw new HttpError(400, 'invalid', `${k} must be a number`);
  return o[k] as number;
};

export function buildForecastRoutes(api: ForecastApi): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: ['api', 'forecast', 'load'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'days']);
        const d = p.get('days');
        if (d !== null && !/^\d{1,2}$/.test(d)) throw new HttpError(400, 'invalid', 'days must be a number');
        return json(200, await api.load({ organizationId: required(p, 'organization'), ...(d ? { days: Number(d) } : {}) }, input.ctx));
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'forecast', 'inventory'],
      handler: async (input) => json(200, await api.inventory(required(params(input.url, ['organization']), 'organization'), input.ctx)),
    },
    {
      method: 'GET',
      pattern: ['api', 'forecast', 'cashflow'],
      handler: async (input) => json(200, await api.cashflowBase(required(params(input.url, ['organization']), 'organization'), input.ctx)),
    },
    {
      method: 'GET',
      pattern: ['api', 'forecast', 'settings'],
      handler: async (input) => {
        const s = await api.getSettings(required(params(input.url, ['organization']), 'organization'), input.ctx);
        return json(200, s, { etag: `W/"${s.version}"` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'forecast', 'settings'],
      handler: async (input) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['organizationId', 'fixedCostsMonthly', 'variableCostPct', 'leadTimeDays', 'serviceLevelPct']);
        const s = await api.updateSettings(
          {
            organizationId: typeof o['organizationId'] === 'string' ? o['organizationId'] : '', fixedCostsMonthly: num(o, 'fixedCostsMonthly'),
            variableCostPct: num(o, 'variableCostPct'), leadTimeDays: num(o, 'leadTimeDays'), serviceLevelPct: num(o, 'serviceLevelPct'),
          },
          version,
          input.ctx,
        );
        return json(200, s, { etag: `W/"${s.version}"` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'forecast', 'capacity', ':id'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['visitCapacity']);
        const c = o['visitCapacity'];
        if (c !== null && typeof c !== 'number') throw new HttpError(400, 'invalid', 'visitCapacity must be a number or null');
        const r = await api.setVisitCapacity(id!, c as number | null, version, input.ctx);
        return json(200, r, { etag: `W/"${r.version}"` });
      },
    },
  ];
}
