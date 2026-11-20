/**
 * HCOS-F6 | HTTP: hàng đợi khám theo số thứ tự (JSON thường).
 *
 *   GET  /api/service-points?organization=<uuid>              phòng khám của cơ sở
 *   POST /api/service-points                                   { organizationId, code, name }       (queue:manage)
 *   POST /api/service-points/:id/active                        { isActive } + If-Match              (queue:manage)
 *   GET  /api/queue?organization=<uuid>[&servicePoint=<uuid>]  phiếu hôm nay (trừ đã huỷ)
 *   POST /api/queue/tickets                                    { servicePointId, patientId, priorityReason? } (queue:issue)
 *   POST /api/queue/service-points/:id/call-next              gọi số tiếp theo; { ticket: null } nếu hết  (queue:call)
 *   POST /api/queue/tickets/:id/(recall|skip)                  (queue:call, chỉ người đã gọi)
 *   POST /api/queue/tickets/:id/(requeue|cancel)               (queue:issue)
 *   POST /api/queue/tickets/:id/start                          { encounterClass?, reasonText? } => tạo đợt khám
 *   GET  /api/queue/displays?organization=<uuid>               (queue:manage)
 *   POST /api/queue/displays                                   { organizationId, name } => { display, key } (key chỉ trả MỘT lần)
 *   POST /api/queue/displays/:id/revoke                        { organizationId }
 *
 * Màn hình công khai: GET /api/public/queue-board với header X-Display-Key (xử lý trong server.ts, trước xác thực).
 */
import type { QueueService } from '../clinical/queue.service';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type QueueApi = Pick<
  QueueService,
  | 'listServicePoints' | 'createServicePoint' | 'setServicePointActive' | 'issueTicket' | 'requeueTicket' | 'cancelTicket' | 'listToday'
  | 'callNext' | 'recallTicket' | 'skipTicket' | 'startTicket' | 'createDisplay' | 'listDisplays' | 'revokeDisplay'
>;

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({
  status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}),
});

async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
async function optObj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await input.readBody();
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

export function buildQueueRoutes(api: QueueApi): readonly Route[] {
  const ticketAction = (action: 'recall' | 'skip' | 'requeue' | 'cancel'): Route => ({
    method: 'POST',
    pattern: ['api', 'queue', 'tickets', ':id', action],
    handler: async (input, [id]) => {
      const fn = { recall: api.recallTicket, skip: api.skipTicket, requeue: api.requeueTicket, cancel: api.cancelTicket }[action];
      return json(200, await fn.call(api, id!, input.ctx));
    },
  });
  return [
    {
      method: 'GET',
      pattern: ['api', 'service-points'],
      handler: async (input) => json(200, { servicePoints: await api.listServicePoints(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'service-points'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'code', 'name']);
        const sp = await api.createServicePoint({ organizationId: s(o['organizationId']), code: s(o['code']), name: s(o['name']) }, input.ctx);
        return json(201, sp, { etag: `W/"${sp.version}"` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'service-points', ':id', 'active'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['isActive']);
        const sp = await api.setServicePointActive(id!, o['isActive'] as boolean, version, input.ctx);
        return json(200, sp, { etag: `W/"${sp.version}"` });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'queue'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'servicePoint']);
        const sp = p.get('servicePoint');
        return json(200, { tickets: await api.listToday({ organizationId: required(p, 'organization'), ...(sp ? { servicePointId: sp } : {}) }, input.ctx) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'queue', 'tickets'],
      handler: async (input) => {
        const o = await obj(input, ['servicePointId', 'patientId', 'priorityReason']);
        const pr = o['priorityReason'];
        if (pr !== undefined && pr !== null && typeof pr !== 'string') throw new HttpError(400, 'invalid', 'priorityReason must be a string or null');
        return json(201, await api.issueTicket({ servicePointId: s(o['servicePointId']), patientId: s(o['patientId']), priorityReason: (pr as string | null | undefined) ?? null }, input.ctx));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'queue', 'service-points', ':id', 'call-next'],
      handler: async (input, [id]) => json(200, { ticket: await api.callNext(id!, input.ctx) }),
    },
    ticketAction('recall'),
    ticketAction('skip'),
    ticketAction('requeue'),
    ticketAction('cancel'),
    {
      method: 'POST',
      pattern: ['api', 'queue', 'tickets', ':id', 'start'],
      handler: async (input, [id]) => {
        const o = await optObj(input, ['encounterClass', 'reasonText']);
        const ec = o['encounterClass'];
        const rt = o['reasonText'];
        if (ec !== undefined && typeof ec !== 'string') throw new HttpError(400, 'invalid', 'encounterClass must be a string');
        if (rt !== undefined && rt !== null && typeof rt !== 'string') throw new HttpError(400, 'invalid', 'reasonText must be a string or null');
        return json(200, await api.startTicket(id!, { ...(ec ? { encounterClass: ec } : {}), reasonText: (rt as string | null | undefined) ?? null }, input.ctx));
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'queue', 'displays'],
      handler: async (input) => json(200, { displays: await api.listDisplays(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'queue', 'displays'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'name']);
        return json(201, await api.createDisplay({ organizationId: s(o['organizationId']), name: s(o['name']) }, input.ctx), { 'cache-control': 'no-store' });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'queue', 'displays', ':id', 'revoke'],
      handler: async (input, [id]) => {
        const o = await obj(input, ['organizationId']);
        return json(200, await api.revokeDisplay(id!, s(o['organizationId']), input.ctx));
      },
    },
  ];
}
