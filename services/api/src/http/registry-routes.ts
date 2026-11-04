/**
 * HCOS-P0-ENG-001 | Person Registry | Route REST
 *
 *   POST /api/persons                       tạo person (+ định danh); 409 {error:'DUPLICATE_CANDIDATES', candidates} nếu nghi trùng
 *   POST /api/persons/search-duplicates     tìm trùng (POST để PII không nằm trong URL/log)
 *   GET  /api/persons/:id                   đọc person (id đã merge => trả person đích + header Content-Location)
 *   POST /api/persons/:id/identifiers       thêm định danh
 *   POST /api/identifiers/:id/retire        ngừng/đánh dấu nhập nhầm (If-Match bắt buộc)
 *   POST /api/persons/:id/merge             merge :id (source) vào targetPersonId
 *
 * Body chỉ lấy các khoá đã biết (khoá lạ bị bỏ qua), kiểu sai => 422. Quyết định truy cập nằm ở PersonRegistryService.
 */
import { asPersonId, isUuid, type Sex } from '../../../../packages/domain/src/s0-contracts';
import type { NewIdentifierInput, NewPersonInput } from '../../../../packages/domain/src/person-registry';
import { ClinicalError } from '../clinical/encounter.service';
import type { PersonRegistryService } from '../registry/person-registry.service';
import { parseIfMatch, requireBody, type Route, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type RegistryApi = Pick<
  PersonRegistryService,
  'createPerson' | 'findDuplicates' | 'getPerson' | 'addIdentifier' | 'retireIdentifier' | 'mergePersons'
>;

const etag = (v: number): string => `W/"${v}"`;
const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult =>
  ({ status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}) });

const bad = (msg: string): never => {
  throw new HttpError(422, 'invalid', msg);
};

function optStr(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) return bad(`${key} must be a string (max ${max})`);
  return v;
}
function reqStr(o: Record<string, unknown>, key: string, max: number): string {
  const v = optStr(o, key, max);
  if (v === undefined) return bad(`${key} is required`);
  return v as string;
}

function parseIdentifiers(raw: unknown): NewIdentifierInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > 10) return bad('identifiers must be an array (max 10)');
  return raw.map((x) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return bad('identifier must be an object');
    return parseIdentifier(x as Record<string, unknown>);
  });
}

function parseIdentifier(o: Record<string, unknown>): NewIdentifierInput {
  return {
    type: reqStr(o, 'type', 32) as NewIdentifierInput['type'],
    system: reqStr(o, 'system', 200),
    value: reqStr(o, 'value', 128),
    periodStart: optStr(o, 'periodStart', 10) ?? null,
    periodEnd: optStr(o, 'periodEnd', 10) ?? null,
  };
}

const object = (b: unknown): Record<string, unknown> => b as Record<string, unknown>;

function parsePersonId(v: string) {
  return asPersonId(v);
}

export function buildRegistryRoutes(api: RegistryApi): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: ['api', 'persons'],
      handler: async (input) => {
        const o = object(await requireBody(input));
        const override = o['duplicateOverride'];
        let duplicateOverride: NewPersonInput['duplicateOverride'];
        if (override !== undefined && override !== null) {
          if (typeof override !== 'object' || Array.isArray(override)) return bad('duplicateOverride must be an object');
          duplicateOverride = { reason: reqStr(override as Record<string, unknown>, 'reason', 500) };
        }
        const sex = optStr(o, 'sex', 16);
        const identifiers = parseIdentifiers(o['identifiers']);
        const payload: NewPersonInput = {
          givenName: reqStr(o, 'givenName', 100),
          familyName: reqStr(o, 'familyName', 100),
          birthDate: optStr(o, 'birthDate', 10) ?? null,
          sex: (sex as Sex | undefined) ?? null,
          phone: optStr(o, 'phone', 32) ?? null,
          email: optStr(o, 'email', 254) ?? null,
          ...(identifiers ? { identifiers } : {}),
          ...(duplicateOverride ? { duplicateOverride } : {}),
        };
        try {
          const r = await api.createPerson(payload, input.ctx);
          return json(201, r, { location: `/api/persons/${r.person.personId}`, etag: etag(r.person.version) });
        } catch (e) {
          if (e instanceof ClinicalError && e.details?.['reason'] === 'DUPLICATE_CANDIDATES') {
            return json(409, { error: 'DUPLICATE_CANDIDATES', candidates: e.details['candidates'] });
          }
          throw e;
        }
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'persons', 'search-duplicates'],
      handler: async (input) => {
        const o = object(await requireBody(input));
        const identifiers = parseIdentifiers(o['identifiers']);
        const candidates = await api.findDuplicates(
          {
            givenName: optStr(o, 'givenName', 100),
            familyName: optStr(o, 'familyName', 100),
            birthDate: optStr(o, 'birthDate', 10) ?? null,
            phone: optStr(o, 'phone', 32) ?? null,
            ...(identifiers ? { identifiers } : {}),
          },
          input.ctx,
        );
        return json(200, { candidates });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'persons', ':id'],
      handler: async (input, [id]) => {
        const view = await api.getPerson(parsePersonId(id!), input.ctx);
        return json(200, view, {
          etag: etag(view.person.version),
          ...(view.redirectedFrom ? { 'content-location': `/api/persons/${view.person.personId}` } : {}),
        });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'persons', ':id', 'identifiers'],
      handler: async (input, [id]) => {
        const identifier = await api.addIdentifier(parsePersonId(id!), parseIdentifier(object(await requireBody(input))), input.ctx);
        return json(201, identifier, { etag: etag(identifier.version) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'identifiers', ':id', 'retire'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const status = reqStr(object(await requireBody(input)), 'status', 32);
        if (status !== 'inactive' && status !== 'entered_in_error') return bad("status must be 'inactive' or 'entered_in_error'");
        const updated = await api.retireIdentifier(id!, status, version, input.ctx);
        return json(200, updated, { etag: etag(updated.version) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'persons', ':id', 'merge'],
      handler: async (input, [id]) => {
        const o = object(await requireBody(input));
        const target = reqStr(o, 'targetPersonId', 36);
        if (!isUuid(target)) return bad('targetPersonId must be a uuid');
        const es = o['expectedSourceVersion'];
        const et = o['expectedTargetVersion'];
        if (typeof es !== 'number' || typeof et !== 'number') return bad('expectedSourceVersion and expectedTargetVersion must be numbers');
        const r = await api.mergePersons(
          {
            sourcePersonId: parsePersonId(id!),
            targetPersonId: parsePersonId(target),
            reason: reqStr(o, 'reason', 500),
            expectedSourceVersion: es,
            expectedTargetVersion: et,
          },
          input.ctx,
        );
        return json(200, r, { etag: etag(r.target.version) });
      },
    },
  ];
}
