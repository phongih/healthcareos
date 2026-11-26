/**
 * HCOS-F21 | HTTP quản trị nhân sự & cơ sở (JWT nhân viên).
 *   GET  /api/admin/staff?organization=&revoked=true          nhân viên trong phạm vi người gọi                  (staff:manage)
 *   POST /api/admin/staff                                     { displayName, username, email?, organizationId, roles[], validTo?, linkExisting? }
 *                                                             => { userId, temporaryPassword | null } — mật khẩu tạm chỉ trả MỘT lần
 *   POST /api/admin/staff/:id/roles                           { organizationId, role, validTo? }
 *   POST /api/admin/staff/:id/status                          { status: locked | active, reason }
 *   POST /api/admin/staff/:id/reset                           { reason } => { temporaryPassword }
 *   POST /api/admin/memberships/:id/revoke                    { reason }
 *   GET  /api/admin/organizations                             danh sách cơ sở                                    (staff:manage)
 *   POST /api/admin/organizations                             { code, name, mrnPrefix?, copyFrom?, copy{…} }      (org:manage)
 *   POST /api/admin/organizations/:id/status                  { status: active | inactive, reason }              (org:manage)
 */
import type { StaffAdminService } from '../iam/staff-admin.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type StaffAdminApi = Pick<StaffAdminService, 'listStaff' | 'createStaff' | 'grantRole' | 'revokeMembership' | 'setStatus' | 'resetCredentials' | 'listOrganizations' | 'createOrganization' | 'setOrganizationStatus'>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
const COPY_KEYS = ['servicePoints', 'priceList', 'financeSettings', 'forecastSettings', 'supplyNorms', 'deviceRequirements', 'decisionRules', 'handoverDesks', 'mrnSettings'];

export function buildStaffRoutes(api: StaffAdminApi | undefined): readonly Route[] {
  if (!api) return [];
  return [
    {
      method: 'GET', pattern: ['api', 'admin', 'staff'],
      handler: async (input) => {
        for (const k of input.url.searchParams.keys()) if (!['organization', 'revoked'].includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
        return json(200, await api.listStaff({ organizationId: input.url.searchParams.get('organization'), includeRevoked: input.url.searchParams.get('revoked') }, input.ctx));
      },
    },
    { method: 'POST', pattern: ['api', 'admin', 'staff'], handler: async (input) => json(201, await api.createStaff(await obj(input, ['displayName', 'username', 'email', 'organizationId', 'roles', 'validTo', 'linkExisting']), input.ctx)) },
    { method: 'POST', pattern: ['api', 'admin', 'staff', ':id', 'roles'], handler: async (input, [id]) => json(201, await api.grantRole(id!, await obj(input, ['organizationId', 'role', 'validTo']), input.ctx)) },
    { method: 'POST', pattern: ['api', 'admin', 'staff', ':id', 'status'], handler: async (input, [id]) => json(200, await api.setStatus(id!, await obj(input, ['status', 'reason']), input.ctx)) },
    { method: 'POST', pattern: ['api', 'admin', 'staff', ':id', 'reset'], handler: async (input, [id]) => json(200, await api.resetCredentials(id!, await obj(input, ['reason']), input.ctx)) },
    { method: 'POST', pattern: ['api', 'admin', 'memberships', ':id', 'revoke'], handler: async (input, [id]) => json(200, await api.revokeMembership(id!, await obj(input, ['reason']), input.ctx)) },
    { method: 'GET', pattern: ['api', 'admin', 'organizations'], handler: async (input) => json(200, await api.listOrganizations(input.ctx)) },
    {
      method: 'POST', pattern: ['api', 'admin', 'organizations'],
      handler: async (input) => {
        const b = await obj(input, ['code', 'name', 'mrnPrefix', 'copyFrom', 'copy']);
        if (b['copy'] !== undefined) {
          if (!b['copy'] || typeof b['copy'] !== 'object' || Array.isArray(b['copy'])) throw new HttpError(400, 'invalid', 'copy must be an object');
          for (const [k, v] of Object.entries(b['copy'] as Record<string, unknown>)) if (!COPY_KEYS.includes(k) || typeof v !== 'boolean') throw new HttpError(400, 'invalid', `Invalid copy option ${k}`);
        }
        return json(201, await api.createOrganization(b, input.ctx));
      },
    },
    { method: 'POST', pattern: ['api', 'admin', 'organizations', ':id', 'status'], handler: async (input, [id]) => json(200, await api.setOrganizationStatus(id!, await obj(input, ['status', 'reason']), input.ctx)) },
  ];
}
