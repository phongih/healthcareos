/**
 * HCOS-F16 | HTTP: hiện dữ liệu đã mã hoá + quản lý khoá (JSON thường, không cache).
 *
 *   POST /api/pii/reveal      { kind: person|identifier|booking, id, field, reason } => { value }   (pii:reveal, có audit)
 *   GET  /api/keys            trạng thái khoá, số giá trị theo phiên bản DEK, bản rõ còn lại          (keys:manage)
 *   POST /api/keys/rotate     { purpose: data|index }
 *   POST /api/keys/reencrypt  { limit? }      mã hoá lại giá trị dùng DEK cũ
 *   POST /api/keys/rewrap                     bọc lại mọi DEK bằng KEK đang dùng
 *   POST /api/keys/backfill   { limit? }      mã hoá dữ liệu cũ còn bản rõ
 */
import type { PiiService } from '../security/pii.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type PiiApi = Pick<PiiService, 'reveal' | 'keys' | 'rotate' | 'reencrypt' | 'rewrap' | 'backfill'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });
async function obj(input: RouteInput, allowed: readonly string[], required: boolean): Promise<Record<string, unknown>> {
  const b = required ? await requireBody(input) : await input.readBody();
  if (b === undefined) return {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}

export function buildPiiRoutes(api: PiiApi): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: ['api', 'pii', 'reveal'],
      handler: async (input) => {
        const o = await obj(input, ['kind', 'id', 'field', 'reason'], true);
        return json(200, await api.reveal({ kind: o['kind'], id: o['id'], field: o['field'], reason: o['reason'] }, input.ctx));
      },
    },
    { method: 'GET', pattern: ['api', 'keys'], handler: async (input) => json(200, await api.keys(input.ctx)) },
    {
      method: 'POST',
      pattern: ['api', 'keys', 'rotate'],
      handler: async (input) => json(200, await api.rotate((await obj(input, ['purpose'], true))['purpose'], input.ctx)),
    },
    {
      method: 'POST',
      pattern: ['api', 'keys', 'reencrypt'],
      handler: async (input) => json(200, await api.reencrypt((await obj(input, ['limit'], false))['limit'], input.ctx)),
    },
    { method: 'POST', pattern: ['api', 'keys', 'rewrap'], handler: async (input) => json(200, await api.rewrap(input.ctx)) },
    {
      method: 'POST',
      pattern: ['api', 'keys', 'backfill'],
      handler: async (input) => json(200, await api.backfill((await obj(input, ['limit'], false))['limit'], input.ctx)),
    },
  ];
}
