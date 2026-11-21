/**
 * HCOS-F17 | HTTP: lưu giữ & xoá dữ liệu (JSON thường).
 *
 *   GET  /api/retention                         chính sách, lần chạy, biên nhận, yêu cầu xoá          (retention:read)
 *   POST /api/retention/settings                { ruleId, days }  (không thấp hơn sàn pháp lý)         (retention:manage)
 *   POST /api/retention/run                     chạy ngay job ẩn danh / xoá                             (retention:manage)
 *   GET  /api/erasure-assessment?patient=       hạn giữ + phạm vi dự kiến                               (erasure:request tại cơ sở)
 *   GET  /api/erasure-requests?patient=         yêu cầu xoá của người bệnh                              (erasure:request tại cơ sở)
 *   POST /api/erasure-requests                  { patientId, channel, note?, receivedAt? }              (erasure:request tại cơ sở)
 *   POST /api/erasure-requests/:id/decision     { decision: approve|reject, note? } — người KHÁC người lập (erasure:approve)
 *   GET  /api/erasure-requests/:id/letter       { markdown } văn bản trả lời người yêu cầu
 */
import type { RetentionService } from '../governance/retention.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type RetentionApi = Pick<RetentionService, 'overview' | 'setDays' | 'runNow' | 'assess' | 'listForPatient' | 'createRequest' | 'decide' | 'letter'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
function patientParam(url: URL): string {
  for (const k of url.searchParams.keys()) if (k !== 'patient') throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
  const v = url.searchParams.get('patient');
  if (!v) throw new HttpError(400, 'invalid', 'patient is required');
  return v;
}

export function buildRetentionRoutes(api: RetentionApi): readonly Route[] {
  return [
    { method: 'GET', pattern: ['api', 'retention'], handler: async (input) => json(200, await api.overview(input.ctx)) },
    {
      method: 'POST',
      pattern: ['api', 'retention', 'settings'],
      handler: async (input) => {
        const o = await obj(input, ['ruleId', 'days']);
        return json(200, await api.setDays({ ruleId: o['ruleId'], days: o['days'] }, input.ctx));
      },
    },
    { method: 'POST', pattern: ['api', 'retention', 'run'], handler: async (input) => json(200, await api.runNow(input.ctx)) },
    { method: 'GET', pattern: ['api', 'erasure-assessment'], handler: async (input) => json(200, await api.assess(patientParam(input.url), input.ctx)) },
    { method: 'GET', pattern: ['api', 'erasure-requests'], handler: async (input) => json(200, { requests: await api.listForPatient(patientParam(input.url), input.ctx) }) },
    {
      method: 'POST',
      pattern: ['api', 'erasure-requests'],
      handler: async (input) => {
        const o = await obj(input, ['patientId', 'channel', 'note', 'receivedAt']);
        return json(201, await api.createRequest({ patientId: o['patientId'], channel: o['channel'], note: o['note'], receivedAt: o['receivedAt'] }, input.ctx));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'erasure-requests', ':id', 'decision'],
      handler: async (input, [id]) => {
        const o = await obj(input, ['decision', 'note']);
        return json(200, await api.decide(id!, { decision: o['decision'], note: o['note'] }, input.ctx));
      },
    },
    { method: 'GET', pattern: ['api', 'erasure-requests', ':id', 'letter'], handler: async (input, [id]) => json(200, { markdown: await api.letter(id!, input.ctx) }) },
  ];
}
