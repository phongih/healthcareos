/**
 * HCOS-P0-ENG-001 | S2 | Route lâm sàng: REST nội bộ + FHIR R4.
 *
 *   POST /api/patients                     đăng ký hồ sơ bệnh nhân (person_id -> patient_id tại organization)
 *   GET  /fhir/Patient/:id
 *   GET  /fhir/Patient?organization=<uuid>&(identifier=system|value | mrn=… | given=…&family=…&birthdate=…)&_count=1..20
 *   POST /fhir/Encounter                   tạo đợt khám (practitioner = người gọi, status do server)
 *   GET  /fhir/Encounter?patient=<id>      đợt khám của bệnh nhân (mới nhất trước, ≤ 50; đợt policy không cho xem bị lọc)
 *   GET  /fhir/Encounter/:id               (ETag = W/"<version>")
 *   GET  /fhir/Encounter/:id/$everything   Bundle(Encounter + Condition + Observation)
 *   POST /fhir/Encounter/:id/$close        bắt buộc If-Match (optimistic concurrency)
 *   POST /fhir/Condition                   GET /fhir/Condition?encounter=<id>
 *   POST /fhir/Observation                 GET /fhir/Observation?encounter=<id>
 *
 * Mọi quyết định truy cập nằm ở ClinicalEncounterService; tầng này chỉ: parse, validate hình dạng, map FHIR, gắn header.
 * Không có tìm kiếm không giới hạn theo tenant: search luôn bắt buộc `encounter`.
 */
import type { IncomingMessage } from 'node:http';

import {
  isUuid,
  asOrganizationId,
  asPersonId,
  type TenantContext,
} from '../../../../packages/domain/src/s0-contracts';
import {
  asEncounterId,
  fromFhirCondition,
  fromFhirEncounter,
  fromFhirObservation,
  FhirMappingError,
  toFhirCondition,
  toFhirEncounter,
  toFhirObservation,
  toFhirPatient,
  type FhirCondition,
  type FhirEncounter,
  type FhirObservation,
} from '../../../../packages/domain/src/s1-contracts';
import { asPatientId } from '../../../../packages/domain/src/s0-contracts';
import { REDACTED_SECURITY_LABEL } from '../../../../packages/security/src/access-policy';
import type { ClinicalEncounterService } from '../clinical/encounter.service';
import { FHIR_JSON, HttpError, PLAIN_JSON } from './http-kernel';

export type ClinicalApi = Pick<
  ClinicalEncounterService,
  'registerPatient' | 'getPatient' | 'searchPatients' | 'createEncounter' | 'addCondition' | 'recordObservation' | 'closeEncounter' | 'getEncounterChart'
  | 'listEncountersForPatient'
  | 'listOpenEncounters'
>;

export interface RouteInput {
  readonly req: IncomingMessage;
  readonly url: URL;
  readonly ctx: TenantContext;
  /** Đọc body JSON (lười, có giới hạn). */
  readBody(): Promise<unknown | undefined>;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  readonly contentType: string;
  readonly headers?: Readonly<Record<string, string>>;
}

type Handler = (input: RouteInput, ids: readonly string[]) => Promise<RouteResult>;

export interface Route {
  readonly method: 'GET' | 'POST';
  readonly pattern: readonly string[]; // ':id' = uuid; ':ref' = uuid hoặc mã nghiệp vụ (A-Z 0-9 -, ≤ 64 ký tự, vd. mã tài sản TB26-0001-3)
  readonly handler: Handler;
}

const etag = (version: number): string => `W/"${version}"`;

export function parseIfMatch(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined) throw new HttpError(428, 'conflict', 'If-Match header is required');
  const m = /^(?:W\/)?"(\d{1,12})"$/.exec(v.trim());
  if (!m || !m[1]) throw new HttpError(400, 'invalid', 'If-Match must be a version ETag such as W/"3"');
  return Number(m[1]);
}

export async function requireBody(input: RouteInput): Promise<unknown> {
  const b = await input.readBody();
  if (b === undefined) throw new HttpError(400, 'required', 'Request body is required');
  return b;
}

/** Mọi lỗi ngoài ý muốn khi map (vd: kiểu dữ liệu sai) -> 422 thay vì 500. */
function mapInput<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof FhirMappingError) throw e;
    throw new FhirMappingError('Malformed FHIR resource');
  }
}

function requireEncounterParam(url: URL) {
  const v = url.searchParams.get('encounter');
  if (!v || !isUuid(v)) throw new HttpError(400, 'required', "Search requires a valid 'encounter' parameter");
  return asEncounterId(v);
}

const fhir = (status: number, body: unknown, headers?: Record<string, string>): RouteResult =>
  ({ status, body, contentType: FHIR_JSON, ...(headers ? { headers } : {}) });

const bundle = (
  type: 'searchset' | 'collection',
  resources: ReadonlyArray<{ resourceType: string; id?: string }>,
  redacted: readonly string[] = [],
) => ({
  resourceType: 'Bundle',
  ...(redacted.length > 0 ? { meta: { security: [REDACTED_SECURITY_LABEL] } } : {}),
  type,
  total: resources.length,
  entry: resources.map((r) => ({ fullUrl: `/fhir/${r.resourceType}/${r.id ?? ''}`, resource: r })),
});

/** Access policy đã che trường => gắn nhãn REDACTED để client không hiểu nhầm "không có dữ liệu". */
function labelRedacted<T extends { meta?: { security?: Array<{ system: string; code: string; display?: string }> } }>(
  resource: T,
  redacted: readonly string[] | undefined,
): T {
  if (!redacted || redacted.length === 0) return resource;
  return { ...resource, meta: { ...(resource.meta ?? {}), security: [...(resource.meta?.security ?? []), { ...REDACTED_SECURITY_LABEL }] } };
}

export function buildClinicalRoutes(api: ClinicalApi): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: ['api', 'patients'],
      handler: async (input) => {
        const b = (await requireBody(input)) as Record<string, unknown>;
        const { personId, organizationId, mrn } = b;
        if (typeof personId !== 'string' || !isUuid(personId) || typeof organizationId !== 'string' || !isUuid(organizationId)) {
          throw new HttpError(422, 'invalid', 'personId and organizationId must be uuids');
        }
        if (mrn !== undefined && mrn !== null && typeof mrn !== 'string') throw new HttpError(422, 'invalid', 'mrn must be a string (omit to auto-generate)');
        const patient = await api.registerPatient(
          { personId: asPersonId(personId), organizationId: asOrganizationId(organizationId), ...(typeof mrn === 'string' ? { mrn } : {}) },
          input.ctx,
        );
        return {
          status: 201,
          body: patient,
          contentType: PLAIN_JSON,
          headers: { location: `/fhir/Patient/${patient.patientId}`, etag: etag(patient.version) },
        };
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Patient'],
      handler: async (input) => {
        const q = input.url.searchParams;
        const org = q.get('organization');
        if (!org || !isUuid(org)) throw new HttpError(400, 'required', "Search requires a valid 'organization' parameter");
        for (const k of q.keys()) {
          if (!['organization', 'identifier', 'mrn', 'given', 'family', 'birthdate', '_count'].includes(k)) {
            throw new HttpError(400, 'not-supported', `Unsupported search parameter '${k}'`);
          }
          if (q.getAll(k).length > 1) throw new HttpError(400, 'invalid', `Parameter '${k}' may appear only once`);
        }
        const idRaw = q.get('identifier');
        let identifier: { system: string; value: string } | undefined;
        if (idRaw !== null) {
          const bar = idRaw.indexOf('|');
          if (bar < 1 || bar === idRaw.length - 1) throw new HttpError(422, 'invalid', "identifier must be 'system|value'");
          identifier = { system: idRaw.slice(0, bar), value: idRaw.slice(bar + 1) };
        }
        const countRaw = q.get('_count');
        const count = countRaw === null ? undefined : /^\d{1,3}$/.test(countRaw) ? Number(countRaw) : NaN;
        const results = await api.searchPatients(
          {
            organizationId: asOrganizationId(org),
            ...(identifier ? { identifier } : {}),
            ...(q.get('mrn') !== null ? { mrn: q.get('mrn')! } : {}),
            ...(q.get('given') !== null ? { givenName: q.get('given')! } : {}),
            ...(q.get('family') !== null ? { familyName: q.get('family')! } : {}),
            ...(q.get('birthdate') !== null ? { birthDate: q.get('birthdate')! } : {}),
            ...(count !== undefined ? { count } : {}),
          },
          input.ctx,
        );
        return fhir(200, bundle('searchset', results.map((r) => labelRedacted(toFhirPatient(r.person, r.patient, r.identifiers), r.redacted))));
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Patient', ':id'],
      handler: async (input, [id]) => {
        const { person, patient, identifiers, redacted } = await api.getPatient(asPatientId(id!), input.ctx);
        return fhir(200, labelRedacted(toFhirPatient(person, patient, identifiers), redacted), { etag: etag(patient.version) });
      },
    },
    {
      method: 'POST',
      pattern: ['fhir', 'Encounter'],
      handler: async (input) => {
        const resource = (await requireBody(input)) as FhirEncounter;
        const encounter = await api.createEncounter(mapInput(() => fromFhirEncounter(resource)), input.ctx);
        return fhir(201, toFhirEncounter(encounter), {
          location: `/fhir/Encounter/${encounter.encounterId}`,
          etag: etag(encounter.version),
        });
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Encounter'],
      handler: async (input) => {
        const q = input.url.searchParams;
        for (const k of q.keys()) if (k !== 'patient') throw new HttpError(400, 'not-supported', `Unsupported search parameter '${k}'`);
        const p = q.get('patient');
        if (!p || !isUuid(p) || q.getAll('patient').length > 1) throw new HttpError(400, 'required', "Search requires a valid 'patient' parameter");
        const r = await api.listEncountersForPatient(asPatientId(p), input.ctx);
        const hidden = new Set(r.redactedEncounterIds);
        const resources = r.encounters.map((e) => labelRedacted(toFhirEncounter(e), hidden.has(e.encounterId) ? ['encounter.reasonText'] : []));
        return fhir(200, bundle('searchset', resources, hidden.size > 0 ? ['encounter.reasonText'] : []));
      },
    },
    {
      // Danh sách đang khám (worklist) của một cơ sở: JSON thường, không phải FHIR search (không có tham số tìm kiếm tự do).
      method: 'GET',
      pattern: ['api', 'worklist'],
      handler: async (input) => {
        const q = input.url.searchParams;
        for (const k of q.keys()) if (k !== 'organization') throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
        const org = q.get('organization');
        if (!org || !isUuid(org) || q.getAll('organization').length > 1) throw new HttpError(400, 'required', "Requires a valid 'organization' parameter");
        return { status: 200, body: await api.listOpenEncounters(org, input.ctx), contentType: PLAIN_JSON };
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Encounter', ':id'],
      handler: async (input, [id]) => {
        const { encounter, redacted } = await api.getEncounterChart(asEncounterId(id!), input.ctx);
        const encRedacted = redacted?.includes('encounter.reasonText') ? ['encounter.reasonText'] : [];
        return fhir(200, labelRedacted(toFhirEncounter(encounter), encRedacted), { etag: etag(encounter.version) });
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Encounter', ':id', '$everything'],
      handler: async (input, [id]) => {
        const { encounter, conditions, observations, redacted } = await api.getEncounterChart(asEncounterId(id!), input.ctx);
        const encRedacted = redacted?.includes('encounter.reasonText') ? ['encounter.reasonText'] : [];
        return fhir(200, bundle('collection', [
          labelRedacted(toFhirEncounter(encounter), encRedacted),
          ...conditions.map(toFhirCondition),
          ...observations.map(toFhirObservation),
        ], redacted));
      },
    },
    {
      method: 'POST',
      pattern: ['fhir', 'Encounter', ':id', '$close'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const closed = await api.closeEncounter(asEncounterId(id!), version, input.ctx);
        return fhir(200, toFhirEncounter(closed), { etag: etag(closed.version) });
      },
    },
    {
      method: 'POST',
      pattern: ['fhir', 'Condition'],
      handler: async (input) => {
        const resource = (await requireBody(input)) as FhirCondition;
        const m = mapInput(() => fromFhirCondition(resource));
        const condition = await api.addCondition(
          {
            encounterId: m.encounterId, code: m.code, category: m.category, clinicalStatus: m.clinicalStatus,
            verificationStatus: m.verificationStatus, onsetAt: m.onsetAt, expectedPatientId: m.patientId,
          },
          input.ctx,
        );
        return fhir(201, toFhirCondition(condition), {
          location: `/fhir/Condition/${condition.conditionId}`,
          etag: etag(condition.version),
        });
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Condition'],
      handler: async (input) => {
        const { conditions, redacted } = await api.getEncounterChart(requireEncounterParam(input.url), input.ctx);
        return fhir(200, bundle('searchset', conditions.map(toFhirCondition), redacted?.includes('conditions') ? ['conditions'] : []));
      },
    },
    {
      method: 'POST',
      pattern: ['fhir', 'Observation'],
      handler: async (input) => {
        const resource = (await requireBody(input)) as FhirObservation;
        const m = mapInput(() => fromFhirObservation(resource));
        const observation = await api.recordObservation(
          {
            encounterId: m.encounterId, code: m.code, value: m.value, status: m.status,
            effectiveAt: m.effectiveAt, expectedPatientId: m.patientId,
          },
          input.ctx,
        );
        return fhir(201, toFhirObservation(observation), {
          location: `/fhir/Observation/${observation.observationId}`,
          etag: etag(observation.version),
        });
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Observation'],
      handler: async (input) => {
        const { observations, redacted } = await api.getEncounterChart(requireEncounterParam(input.url), input.ctx);
        return fhir(200, bundle('searchset', observations.map(toFhirObservation), redacted?.includes('observations') ? ['observations'] : []));
      },
    },
  ];
}

export type RouteMatch =
  | { readonly kind: 'match'; readonly route: Route; readonly ids: string[] }
  | { readonly kind: 'method-not-allowed'; readonly allow: string[] }
  | { readonly kind: 'not-found' };

/** Khớp path theo segment; `:id` chỉ khớp uuid hợp lệ (id lạ => 404, không đi vào service). */
export function matchRoute(routes: readonly Route[], method: string, pathname: string): RouteMatch {
  const segs = pathname.split('/').filter((s) => s.length > 0);
  const allow = new Set<string>();
  for (const r of routes) {
    if (r.pattern.length !== segs.length) continue;
    const ids: string[] = [];
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const p = r.pattern[i]!;
      const s = segs[i]!;
      if (p === ':id') {
        if (!isUuid(s)) { ok = false; break; }
        ids.push(s.toLowerCase());
      } else if (p === ':ref') {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) { ok = false; break; }
        ids.push(s);
      } else if (p !== s) { ok = false; break; }
    }
    if (!ok) continue;
    if (r.method === method) return { kind: 'match', route: r, ids };
    allow.add(r.method);
  }
  return allow.size > 0 ? { kind: 'method-not-allowed', allow: [...allow].sort() } : { kind: 'not-found' };
}
