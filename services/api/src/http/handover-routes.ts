/**
 * HCOS-F14 | HTTP: quầy trả (JSON thường).
 *
 *   GET  /api/handover/desks?organization=<uuid>                 các quầy trả
 *   POST /api/handover/desks                                     { organizationId, code, name }        (handover:manage)
 *   POST /api/handover/desks/:id/active                          { isActive } + If-Match               (handover:manage)
 *   POST /api/handover/desks/:id/call-next                       gọi số tiếp theo ra quầy; { handover: null } nếu hết (handover:serve)
 *   GET  /api/handover?organization=<uuid>[&includeDone=1]       phiếu trả hôm nay (kèm thuốc + số dư thanh toán)
 *   GET  /api/handover/:id
 *   POST /api/handover/:id/prepared                              { note? } dược sĩ soạn xong        (handover:prepare)
 *   POST /api/handover/:id/(recall|skip|release|requeue)         (handover:serve)
 *   POST /api/handover/:id/cancel                                { note }
 *   POST /api/handover/:id/complete                              { checklist: { medication, documents }, note? }
 */
import type { HandoverService } from '../clinical/handover.service';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type HandoverApi = Pick<
  HandoverService,
  'listDesks' | 'createDesk' | 'setDeskActive' | 'listToday' | 'get' | 'markPrepared' | 'callNext' | 'recall' | 'skip' | 'release' | 'requeue' | 'cancel' | 'complete'
>;

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({ status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}) });

async function optObj(input: RouteInput, allowed: readonly string[], required = false): Promise<Record<string, unknown>> {
  const b = required ? await requireBody(input) : await input.readBody();
  if (b === undefined) return {};
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
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const note = (v: unknown): string | null => {
  if (v !== undefined && v !== null && typeof v !== 'string') throw new HttpError(400, 'invalid', 'note must be a string or null');
  return (v as string | null | undefined) ?? null;
};

export function buildHandoverRoutes(api: HandoverApi): readonly Route[] {
  const simple = (action: 'recall' | 'skip' | 'release' | 'requeue'): Route => ({
    method: 'POST',
    pattern: ['api', 'handover', ':id', action],
    handler: async (input, [id]) => json(200, await api[action].call(api, id!, input.ctx)),
  });
  return [
    {
      method: 'GET',
      pattern: ['api', 'handover', 'desks'],
      handler: async (input) => json(200, { desks: await api.listDesks(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'handover', 'desks'],
      handler: async (input) => {
        const o = await optObj(input, ['organizationId', 'code', 'name'], true);
        const d = await api.createDesk({ organizationId: s(o['organizationId']), code: s(o['code']), name: s(o['name']) }, input.ctx);
        return json(201, d, { etag: `W/"${d.version}"` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'handover', 'desks', ':id', 'active'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await optObj(input, ['isActive'], true);
        const d = await api.setDeskActive(id!, o['isActive'] as boolean, version, input.ctx);
        return json(200, d, { etag: `W/"${d.version}"` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'handover', 'desks', ':id', 'call-next'],
      handler: async (input, [id]) => json(200, { handover: await api.callNext(id!, input.ctx) }),
    },
    {
      method: 'GET',
      pattern: ['api', 'handover'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'includeDone']);
        const inc = p.get('includeDone');
        if (inc !== null && inc !== '0' && inc !== '1') throw new HttpError(400, 'invalid', "includeDone must be '0' or '1'");
        return json(200, { handovers: await api.listToday({ organizationId: required(p, 'organization'), includeDone: inc === '1' }, input.ctx) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'handover', ':id'],
      handler: async (input, [id]) => json(200, await api.get(id!, input.ctx)),
    },
    {
      method: 'POST',
      pattern: ['api', 'handover', ':id', 'prepared'],
      handler: async (input, [id]) => {
        const o = await optObj(input, ['note']);
        return json(200, await api.markPrepared(id!, { note: note(o['note']) }, input.ctx));
      },
    },
    simple('recall'),
    simple('skip'),
    simple('release'),
    simple('requeue'),
    {
      method: 'POST',
      pattern: ['api', 'handover', ':id', 'cancel'],
      handler: async (input, [id]) => {
        const o = await optObj(input, ['note'], true);
        return json(200, await api.cancel(id!, { note: note(o['note']) }, input.ctx));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'handover', ':id', 'complete'],
      handler: async (input, [id]) => {
        const o = await optObj(input, ['checklist', 'note'], true);
        return json(200, await api.complete(id!, { checklist: o['checklist'], note: note(o['note']) }, input.ctx));
      },
    },
  ];
}
