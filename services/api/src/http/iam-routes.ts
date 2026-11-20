/**
 * HCOS-P0-ENG-001 | IAM | Route quản trị access policy (chỉ tenant_admin; quyết định nằm ở AccessPolicyService)
 *
 *   GET  /api/access-policies                      danh sách policy của tenant
 *   GET  /api/access-policies/catalog              danh mục action / điều kiện / trường (để dựng UI soạn luật)
 *   POST /api/access-policies/validate             kiểm định thử bộ luật, không ghi
 *   POST /api/access-policies                      tạo {name, description?, rules}
 *   GET  /api/access-policies/:id                  policy + lịch sử phiên bản + số membership đang dùng
 *   POST /api/access-policies/:id/revise           sửa {description?, rules?}         (If-Match bắt buộc)
 *   POST /api/access-policies/:id/retire           ngừng dùng (409 nếu còn membership)  (If-Match bắt buộc)
 *   POST /api/memberships/:id/access-policy        gắn {policyId} hoặc gỡ {policyId:null} (If-Match = version membership)
 *   GET  /api/memberships?organization=<uuid>      membership của organization (tenant_admin)
 *   GET  /api/me                                   người đang đăng nhập + vai trò từ DB (mọi user active; để UI dựng menu)
 */
import { asOrganizationId, isUuid, type AccessPolicyId, type MembershipId } from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, AccessPolicyValidationError } from '../../../../packages/security/src/access-policy';
import { ClinicalError } from '../clinical/encounter.service';
import type { AccessPolicyService } from '../iam/access-policy.service';
import { parseIfMatch, requireBody, type Route, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type AccessPolicyApi = Pick<
  AccessPolicyService,
  'listPolicies' | 'getPolicy' | 'createPolicy' | 'revisePolicy' | 'retirePolicy' | 'assignPolicy' | 'validateRules' | 'whoAmI' | 'listMemberships'
>;

const etag = (v: number): string => `W/"${v}"`;
const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult =>
  ({ status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}) });
const object = (b: unknown): Record<string, unknown> => b as Record<string, unknown>;
const bad = (msg: string): never => {
  throw new HttpError(422, 'invalid', msg);
};

function optDescription(o: Record<string, unknown>): string | null | undefined {
  const v = o['description'];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return bad('description must be a string or null');
  return v;
}

/** Lỗi kiểm định luật trả kèm đường dẫn để UI chỉ ra đúng chỗ sai. */
async function withValidationPath<T>(fn: () => Promise<T>): Promise<T | RouteResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ClinicalError && e.code === 'VALIDATION' && typeof e.details?.['path'] === 'string') {
      return json(422, { error: 'INVALID_RULES', path: e.details['path'], message: e.message });
    }
    if (e instanceof AccessPolicyValidationError) return json(422, { error: 'INVALID_RULES', path: e.path, message: e.message });
    throw e;
  }
}
const isRouteResult = (v: unknown): v is RouteResult =>
  v !== null && typeof v === 'object' && 'contentType' in (v as object) && 'status' in (v as object);

export function buildAccessPolicyRoutes(api: AccessPolicyApi): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: ['api', 'me'],
      handler: async (input) => json(200, await api.whoAmI(input.ctx)),
    },
    {
      method: 'GET',
      pattern: ['api', 'memberships'],
      handler: async (input) => {
        const org = input.url.searchParams.get('organization');
        if (!org || !isUuid(org)) throw new HttpError(400, 'required', "A valid 'organization' parameter is required");
        return json(200, { memberships: await api.listMemberships(asOrganizationId(org), input.ctx) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'access-policies'],
      handler: async (input) => json(200, { policies: await api.listPolicies(input.ctx) }),
    },
    {
      method: 'GET',
      pattern: ['api', 'access-policies', 'catalog'],
      handler: async (input) => {
        // Danh mục là thông tin cấu hình nhưng chỉ người quản trị cần: kiểm quyền bằng một thao tác đọc.
        await api.listPolicies(input.ctx);
        return json(200, { actions: ACCESS_POLICY_CATALOG });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'access-policies', 'validate'],
      handler: async (input) => {
        await api.listPolicies(input.ctx);
        const o = object(await requireBody(input));
        const r = await withValidationPath(async () => api.validateRules(o['rules']));
        return isRouteResult(r) ? r : json(200, { valid: true, rules: r });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'access-policies'],
      handler: async (input) => {
        const o = object(await requireBody(input));
        if (typeof o['name'] !== 'string') return bad('name is required');
        const description = optDescription(o);
        const r = await withValidationPath(() =>
          api.createPolicy({ name: o['name'] as string, ...(description !== undefined ? { description } : {}), rules: o['rules'] }, input.ctx),
        );
        if (isRouteResult(r)) return r;
        return json(201, r, { location: `/api/access-policies/${r.policyId}`, etag: etag(r.version) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'access-policies', ':id'],
      handler: async (input, [id]) => {
        const r = await api.getPolicy(id as AccessPolicyId, input.ctx);
        return json(200, r, { etag: etag(r.policy.version) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'access-policies', ':id', 'revise'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = object(await requireBody(input));
        const description = optDescription(o);
        const r = await withValidationPath(() =>
          api.revisePolicy(
            id as AccessPolicyId,
            { ...(description !== undefined ? { description } : {}), ...(o['rules'] !== undefined ? { rules: o['rules'] } : {}) },
            version,
            input.ctx,
          ),
        );
        if (isRouteResult(r)) return r;
        return json(200, r, { etag: etag(r.version) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'access-policies', ':id', 'retire'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        try {
          const r = await api.retirePolicy(id as AccessPolicyId, version, input.ctx);
          return json(200, r, { etag: etag(r.version) });
        } catch (e) {
          if (e instanceof ClinicalError && e.details?.['reason'] === 'POLICY_IN_USE') {
            return json(409, { error: 'POLICY_IN_USE', activeAssignments: e.details['activeAssignments'] });
          }
          throw e;
        }
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'memberships', ':id', 'access-policy'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = object(await requireBody(input));
        if (!('policyId' in o)) return bad('policyId is required (uuid or null)');
        const raw = o['policyId'];
        if (raw !== null && !isUuid(raw)) return bad('policyId must be a uuid or null');
        const m = await api.assignPolicy(id as MembershipId, raw === null ? null : (raw.toLowerCase() as AccessPolicyId), version, input.ctx);
        return json(200, m, { etag: etag(m.version) });
      },
    },
  ];
}
