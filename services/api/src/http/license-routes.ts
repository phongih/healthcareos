/**
 * HCOS | HTTP giấy phép khám chữa bệnh (JWT; quyền kiểm tra trong DB).
 *   GET  /api/tenant/medical-license                      => { status, licenseNo, note, submittedAt }   (tenant_admin của tổ chức)
 *   POST /api/tenant/medical-license                      { licenseNo } => 200 { status: 'OK' }         (tenant_admin)
 *   GET  /api/platform/licenses/pending                   => [{ tenantId, name, slug, medicalLicenseNo, contactPhone, submittedAt }]
 *   POST /api/platform/licenses/:id/decision              { decision: 'approve' | 'reject', note? } => 200 { status: 'OK' } | 409 NOT_PENDING
 * Lý do từ chối bắt buộc (>= 5 ký tự). Không trả mã, mật khẩu hay token.
 */
import type { MedicalLicenseService } from '../platform/medical-license.service';
import { LicenseError } from '../platform/medical-license.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type MedicalLicenseApi = Pick<MedicalLicenseService, 'getState' | 'submit' | 'listPending' | 'decide'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });

const STATUS: Readonly<Record<string, number>> = {
  NOT_TENANT_ADMIN: 403,
  NOT_OPERATOR: 403,
  TENANT_NOT_ACTIVE: 409,
  ALREADY_APPROVED: 409,
  INVALID_LICENSE_NO: 400,
  INVALID_DECISION: 400,
  NOTE_REQUIRED: 400,
  INVALID_INPUT: 400,
};

async function objBody(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}

export function buildLicenseRoutes(api: MedicalLicenseApi | undefined): readonly Route[] {
  if (!api) return [];
  const guard = async <T>(fn: () => Promise<T>): Promise<RouteResult | T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LicenseError) return json(STATUS[e.code] ?? 400, { error: e.code });
      throw e;
    }
  };
  return [
    {
      method: 'GET', pattern: ['api', 'tenant', 'medical-license'],
      handler: async (input: RouteInput) => {
        const r = await guard(async () => {
          const s = await api.getState(input.ctx.userSubject, String(input.ctx.tenantId));
          return json(200, s);
        });
        return r as RouteResult;
      },
    },
    {
      method: 'POST', pattern: ['api', 'tenant', 'medical-license'],
      handler: async (input: RouteInput) => {
        const o = await objBody(input, ['licenseNo']);
        const licenseNo = typeof o['licenseNo'] === 'string' ? o['licenseNo'] : '';
        const r = await guard(async () => json(200, { status: await api.submit(input.ctx.userSubject, String(input.ctx.tenantId), licenseNo) }));
        return r as RouteResult;
      },
    },
    {
      method: 'GET', pattern: ['api', 'platform', 'licenses', 'pending'],
      handler: async (input: RouteInput) => {
        const r = await guard(async () => json(200, await api.listPending(input.ctx.userSubject)));
        return r as RouteResult;
      },
    },
    {
      method: 'POST', pattern: ['api', 'platform', 'licenses', ':id', 'decision'],
      handler: async (input: RouteInput, [id]) => {
        const o = await objBody(input, ['decision', 'note']);
        const decision = typeof o['decision'] === 'string' ? o['decision'] : '';
        const note = typeof o['note'] === 'string' ? o['note'].trim() : null;
        const r = await guard(async () => {
          const status = await api.decide(input.ctx.userSubject, id!, decision, note);
          return status === 'NOT_PENDING' ? json(409, { error: 'NOT_PENDING' }) : json(200, { status: 'OK' });
        });
        return r as RouteResult;
      },
    },
  ];
}
