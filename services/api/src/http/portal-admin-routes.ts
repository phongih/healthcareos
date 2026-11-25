/**
 * HCOS-F20 | HTTP phía nhân viên của cổng bệnh nhân (JWT nhân viên như mọi route nội bộ).
 *   GET  /api/portal-admin/patients/:id                     liên kết giám hộ, số phiên đang mở, yêu cầu đính chính   (portal:manage)
 *   POST /api/portal-admin/patients/:id/revoke-sessions     đăng xuất mọi thiết bị của người bệnh                    (portal:manage)
 *   POST /api/portal-admin/guardians                        { dependentPatientId, guardianMrn, relationship, validUntil?, note?, verified: true }
 *   POST /api/portal-admin/guardians/:id/revoke             { reason }                                               (portal:manage)
 *   GET  /api/portal-admin/requests?organization=&status=   yêu cầu đính chính (mặc định đang mở; status=all)         (portal:requests)
 *   POST /api/portal-admin/requests/:id/resolve             { status: resolved | rejected, note }                    (portal:requests)
 */
import type { PortalAdminService } from '../portal/portal-admin.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type PortalAdminApi = Pick<PortalAdminService, 'patientPanel' | 'link' | 'revokeLink' | 'revokeSessions' | 'listRequests' | 'resolveRequest'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}

export function buildPortalAdminRoutes(api: PortalAdminApi | undefined): readonly Route[] {
  if (!api) return [];
  return [
    { method: 'GET', pattern: ['api', 'portal-admin', 'patients', ':id'], handler: async (input, [id]) => json(200, await api.patientPanel(id, input.ctx)) },
    { method: 'POST', pattern: ['api', 'portal-admin', 'patients', ':id', 'revoke-sessions'], handler: async (input, [id]) => json(200, await api.revokeSessions(id, input.ctx)) },
    {
      method: 'POST', pattern: ['api', 'portal-admin', 'guardians'],
      handler: async (input) => json(201, await api.link((await obj(input, ['dependentPatientId', 'guardianMrn', 'relationship', 'validUntil', 'note', 'verified'])) as never, input.ctx)),
    },
    { method: 'POST', pattern: ['api', 'portal-admin', 'guardians', ':id', 'revoke'], handler: async (input, [id]) => json(200, await api.revokeLink(id, (await obj(input, ['reason'])) as never, input.ctx)) },
    {
      method: 'GET', pattern: ['api', 'portal-admin', 'requests'],
      handler: async (input) => {
        for (const k of input.url.searchParams.keys()) if (!['organization', 'status'].includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
        return json(200, await api.listRequests({ organizationId: input.url.searchParams.get('organization'), status: input.url.searchParams.get('status') }, input.ctx));
      },
    },
    { method: 'POST', pattern: ['api', 'portal-admin', 'requests', ':id', 'resolve'], handler: async (input, [id]) => json(200, await api.resolveRequest(id, (await obj(input, ['status', 'note'])) as never, input.ctx)) },
  ];
}
