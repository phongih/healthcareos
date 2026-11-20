/**
 * HCOS-F11 | HTTP: Decision Engine + hộp thông báo.
 *   GET  /api/decision/catalog                                 danh mục bộ phát hiện / chỉ số / hành động (tĩnh)
 *   GET  /api/decision/overview?organization=                  Observe → Detect → Decide → Act: số liệu tổng      (decision:read)
 *   GET  /api/decision/rules?organization=                     luật (trừ đã xoá)                                  (decision:read)
 *   POST /api/decision/rules                                   tạo luật                                           (decision:manage)
 *   POST /api/decision/rules/:id            + If-Match         sửa tên / điều kiện / ưu tiên / cooldown / hành động
 *   POST /api/decision/rules/:id/status     + If-Match         { status: active | paused | retired }
 *   GET  /api/decision/rules/:id/versions                      lịch sử phiên bản luật
 *   POST /api/decision/preview                                 thử luật trên dữ liệu hiện tại (không ghi gì)
 *   GET  /api/decision/events?organization=&limit=&detector=&priority=
 *   GET  /api/decision/actions?organization=&limit=
 *   GET  /api/decision/runs?organization=&limit=
 *   POST /api/decision/run                  { organizationId }  chạy ngay                                         (decision:manage)
 *   GET  /api/notifications?organization=&all=1                hộp thông báo theo vai trò của người gọi           (notification:read)
 *   POST /api/notifications/:id             + If-Match         { action: handle | apply | dismiss | reopen, note? }
 */
import type { DecisionEngineService, InboxAction, RuleStatus } from '../decision/decision.service';
import type { Condition } from '../decision/catalog';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type DecisionApi = Pick<
  DecisionEngineService,
  'catalog' | 'overview' | 'listRules' | 'createRule' | 'updateRule' | 'setRuleStatus' | 'ruleVersions' | 'preview' | 'events' | 'actionLog' | 'runs' | 'runNow' | 'inbox' | 'actOnNotification'
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
const intParam = (p: URLSearchParams, k: string): number | undefined => {
  const v = p.get(k);
  if (v === null) return undefined;
  if (!/^\d{1,4}$/.test(v)) throw new HttpError(400, 'invalid', `${k} must be a number`);
  return Number(v);
};
const str = (o: Record<string, unknown>, k: string): string => {
  if (typeof o[k] !== 'string') throw new HttpError(400, 'invalid', `${k} must be a string`);
  return o[k] as string;
};
const num = (o: Record<string, unknown>, k: string): number => {
  if (typeof o[k] !== 'number') throw new HttpError(400, 'invalid', `${k} must be a number`);
  return o[k] as number;
};
const arr = <T>(o: Record<string, unknown>, k: string): T[] => {
  if (!Array.isArray(o[k])) throw new HttpError(400, 'invalid', `${k} must be an array`);
  return o[k] as T[];
};
const ruleFields = (o: Record<string, unknown>) => ({
  name: str(o, 'name'), conditions: arr<Condition>(o, 'conditions'), priority: num(o, 'priority'), cooldownMinutes: num(o, 'cooldownMinutes'), actions: arr<string>(o, 'actions'),
});
const etag = (v: number) => ({ etag: `W/"${v}"` });

export function buildDecisionRoutes(api: DecisionApi): readonly Route[] {
  return [
    { method: 'GET', pattern: ['api', 'decision', 'catalog'], handler: async () => json(200, api.catalog()) },
    {
      method: 'GET',
      pattern: ['api', 'decision', 'overview'],
      handler: async (input) => json(200, await api.overview(required(params(input.url, ['organization']), 'organization'), input.ctx)),
    },
    {
      method: 'GET',
      pattern: ['api', 'decision', 'rules'],
      handler: async (input) => json(200, { rules: await api.listRules(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'decision', 'rules'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'name', 'detector', 'conditions', 'priority', 'cooldownMinutes', 'actions']);
        const r = await api.createRule({ organizationId: str(o, 'organizationId'), detector: str(o, 'detector'), ...ruleFields(o) }, input.ctx);
        return json(201, r, etag(r.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'decision', 'rules', ':id'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['name', 'conditions', 'priority', 'cooldownMinutes', 'actions']);
        const r = await api.updateRule(id!, ruleFields(o), version, input.ctx);
        return json(200, r, etag(r.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'decision', 'rules', ':id', 'status'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['status']);
        const r = await api.setRuleStatus(id!, str(o, 'status') as RuleStatus, version, input.ctx);
        return json(200, r, etag(r.version));
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'decision', 'rules', ':id', 'versions'],
      handler: async (input, [id]) => {
        params(input.url, []);
        return json(200, { versions: await api.ruleVersions(id!, input.ctx) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'decision', 'preview'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'detector', 'conditions', 'cooldownMinutes', 'ruleId']);
        return json(
          200,
          await api.preview(
            {
              organizationId: str(o, 'organizationId'), detector: str(o, 'detector'), conditions: arr<Condition>(o, 'conditions'),
              ...(o['cooldownMinutes'] !== undefined ? { cooldownMinutes: num(o, 'cooldownMinutes') } : {}),
              ...(o['ruleId'] !== undefined ? { ruleId: str(o, 'ruleId') } : {}),
            },
            input.ctx,
          ),
        );
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'decision', 'events'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'limit', 'detector', 'priority']);
        const limit = intParam(p, 'limit');
        const priority = intParam(p, 'priority');
        const detector = p.get('detector');
        return json(200, {
          events: await api.events(
            { organizationId: required(p, 'organization'), ...(limit !== undefined ? { limit } : {}), ...(priority !== undefined ? { priority } : {}), ...(detector ? { detector } : {}) },
            input.ctx,
          ),
        });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'decision', 'actions'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'limit']);
        const limit = intParam(p, 'limit');
        return json(200, { actions: await api.actionLog({ organizationId: required(p, 'organization'), ...(limit !== undefined ? { limit } : {}) }, input.ctx) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'decision', 'runs'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'limit']);
        const limit = intParam(p, 'limit');
        return json(200, { runs: await api.runs({ organizationId: required(p, 'organization'), ...(limit !== undefined ? { limit } : {}) }, input.ctx) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'decision', 'run'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId']);
        return json(200, await api.runNow(str(o, 'organizationId'), input.ctx));
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'notifications'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'all']);
        const all = p.get('all');
        if (all !== null && all !== '1' && all !== '0') throw new HttpError(400, 'invalid', 'all must be 0 or 1');
        return json(200, await api.inbox({ organizationId: required(p, 'organization'), all: all === '1' }, input.ctx));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'notifications', ':id'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['action', 'note']);
        const note = o['note'] === undefined || o['note'] === null ? null : str(o, 'note');
        const r = await api.actOnNotification(id!, str(o, 'action') as InboxAction, note, version, input.ctx);
        return json(200, r, r.item ? etag(r.item.version) : undefined);
      },
    },
  ];
}
