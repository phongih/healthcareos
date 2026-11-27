/**
 * HCOS | HTTP duyệt tổ chức (JWT; quyền người vận hành kiểm tra trong DB).
 *   GET  /api/platform/tenants/pending                 => [{ tenantId, name, slug, businessLicenseNo, contactPhone, adminName, adminEmail, createdAt }]
 *   POST /api/platform/tenants/:id/decision            { decision: 'approve' | 'reject', note? } => 200 { status: 'OK' } | 409 NOT_PENDING
 * Lý do từ chối bắt buộc (>= 5 ký tự). Không trả mã, mật khẩu hay token.
 */
import type { PlatformReviewService } from '../platform/review.service';
import { ReviewError } from '../platform/review.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type PlatformReviewApi = Pick<PlatformReviewService, 'listPending' | 'decide'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });

const STATUS: Readonly<Record<string, number>> = {
  NOT_OPERATOR: 403,
  INVALID_DECISION: 400,
  NOTE_REQUIRED: 400,
  INVALID_INPUT: 400,
};

export function buildPlatformRoutes(api: PlatformReviewApi | undefined): readonly Route[] {
  if (!api) return [];
  return [
    {
      method: 'GET', pattern: ['api', 'platform', 'tenants', 'pending'],
      handler: async (input: RouteInput) => {
        try {
          return json(200, await api.listPending(input.ctx.userSubject));
        } catch (e) {
          if (e instanceof ReviewError) return json(STATUS[e.code] ?? 400, { error: e.code });
          throw e;
        }
      },
    },
    {
      method: 'POST', pattern: ['api', 'platform', 'tenants', ':id', 'decision'],
      handler: async (input: RouteInput, [id]) => {
        const b = await requireBody(input);
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
        const o = b as Record<string, unknown>;
        for (const k of Object.keys(o)) if (!['decision', 'note'].includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
        const decision = typeof o['decision'] === 'string' ? o['decision'] : '';
        const note = typeof o['note'] === 'string' ? o['note'].trim() : null;
        try {
          const status = await api.decide(input.ctx.userSubject, id!, decision, note);
          if (status === 'NOT_PENDING') return json(409, { error: 'NOT_PENDING' });
          return json(200, { status: 'OK' });
        } catch (e) {
          if (e instanceof ReviewError) return json(STATUS[e.code] ?? 400, { error: e.code });
          throw e;
        }
      },
    },
  ];
}
