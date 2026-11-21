/**
 * HCOS-F15 | HTTP: quản trị dữ liệu (JSON thường).
 *
 *   GET  /api/governance/catalog       danh mục + cấp độ hệ thống + quy mô + lần đánh giá gần nhất   (governance:read)
 *   GET  /api/governance/assessments   lịch sử hồ sơ tự đánh giá                                       (governance:read)
 *   POST /api/governance/assessments   { declaredLevel, rationale }                                    (governance:assess)
 *   GET  /api/governance/dossier       { markdown } hồ sơ tự đánh giá                                   (governance:read)
 */
import type { GovernanceService } from '../governance/governance.service';
import { requireBody, type Route, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type GovernanceApi = Pick<GovernanceService, 'catalog' | 'listAssessments' | 'assess' | 'dossier'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });

export function buildGovernanceRoutes(api: GovernanceApi): readonly Route[] {
  return [
    { method: 'GET', pattern: ['api', 'governance', 'catalog'], handler: async (input) => json(200, await api.catalog(input.ctx)) },
    { method: 'GET', pattern: ['api', 'governance', 'assessments'], handler: async (input) => json(200, { assessments: await api.listAssessments(input.ctx) }) },
    {
      method: 'POST',
      pattern: ['api', 'governance', 'assessments'],
      handler: async (input) => {
        const b = await requireBody(input);
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
        const o = b as Record<string, unknown>;
        for (const k of Object.keys(o)) if (k !== 'declaredLevel' && k !== 'rationale') throw new HttpError(400, 'invalid', `Unknown field ${k}`);
        return json(201, await api.assess({ declaredLevel: o['declaredLevel'], rationale: o['rationale'] }, input.ctx));
      },
    },
    { method: 'GET', pattern: ['api', 'governance', 'dossier'], handler: async (input) => json(200, { markdown: await api.dossier(input.ctx) }) },
  ];
}
