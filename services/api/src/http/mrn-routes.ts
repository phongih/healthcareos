/**
 * HCOS-F13 | HTTP: cài đặt mã bệnh nhân.
 *   GET  /api/patient-mrn/settings?organization=            (patient:register)
 *   POST /api/patient-mrn/settings  + If-Match (W/"0" lần đầu)   { organizationId, prefix, allowLegacy }   (patient:configure)
 */
import type { MrnSettingsService } from '../registry/mrn-settings.service';
import { parseIfMatch, requireBody, type Route } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type MrnApi = Pick<MrnSettingsService, 'get' | 'update'>;

export function buildMrnRoutes(api: MrnApi): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: ['api', 'patient-mrn', 'settings'],
      handler: async (input) => {
        for (const k of input.url.searchParams.keys()) if (k !== 'organization') throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
        const org = input.url.searchParams.get('organization');
        if (!org) throw new HttpError(400, 'required', "Parameter 'organization' is required");
        const r = await api.get(org, input.ctx);
        return { status: 200, body: r, contentType: PLAIN_JSON, headers: { etag: `W/"${r.version}"` } };
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'patient-mrn', 'settings'],
      handler: async (input) => {
        const raw = input.req.headers['if-match'];
        const version = raw === 'W/"0"' || raw === '"0"' ? 0 : parseIfMatch(raw);
        const b = await requireBody(input);
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
        const o = b as Record<string, unknown>;
        for (const k of Object.keys(o)) if (!['organizationId', 'prefix', 'allowLegacy'].includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
        if (typeof o['organizationId'] !== 'string') throw new HttpError(400, 'invalid', 'organizationId must be a string');
        const r = await api.update(o['organizationId'], { prefix: o['prefix'], allowLegacy: o['allowLegacy'] }, version, input.ctx);
        return { status: 200, body: r, contentType: PLAIN_JSON, headers: { etag: `W/"${r.version}"` } };
      },
    },
  ];
}
