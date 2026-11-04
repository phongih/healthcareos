/**
 * HCOS-P0-ENG-001 | S2 | Route lâm sàng: REST nội bộ + FHIR R4.
 *
 *   POST /api/patients                     đăng ký hồ sơ bệnh nhân (person_id -> patient_id tại organization)
 *   GET  /fhir/Patient/:id
 *   POST /fhir/Encounter                   tạo đợt khám (practitioner = người gọi, status do server)
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
import type { ClinicalEncounterService } from '../clinical/encounter.service';
import { FHIR_JSON, HttpError, PLAIN_JSON } from './http-kernel';

export type ClinicalApi = Pick<
  ClinicalEncounterService,
  'registerPatient' | 'getPatient' | 'createEncounter' | 'addCondition' | 'recordObservation' | 'closeEncounter' | 'getEncounterChart'
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
  readonly pattern: readonly string[]; // ':id' = uuid
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

const bundle = (type: 'searchset' | 'collection', resources: ReadonlyArray<{ resourceType: string; id?: string }>) => ({
  resourceType: 'Bundle',
  type,
  total: resources.length,
  entry: resources.map((r) => ({ fullUrl: `/fhir/${r.resourceType}/${r.id ?? ''}`, resource: r })),
});

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
        if (typeof mrn !== 'string') throw new HttpError(422, 'invalid', 'mrn must be a string');
        const patient = await api.registerPatient(
          { personId: asPersonId(personId), organizationId: asOrganizationId(organizationId), mrn },
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
      pattern: ['fhir', 'Patient', ':id'],
      handler: async (input, [id]) => {
        const { person, patient, identifiers } = await api.getPatient(asPatientId(id!), input.ctx);
        return fhir(200, toFhirPatient(person, patient, identifiers), { etag: etag(patient.version) });
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
      pattern: ['fhir', 'Encounter', ':id'],
      handler: async (input, [id]) => {
        const { encounter } = await api.getEncounterChart(asEncounterId(id!), input.ctx);
        return fhir(200, toFhirEncounter(encounter), { etag: etag(encounter.version) });
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Encounter', ':id', '$everything'],
      handler: async (input, [id]) => {
        const { encounter, conditions, observations } = await api.getEncounterChart(asEncounterId(id!), input.ctx);
        return fhir(200, bundle('collection', [
          toFhirEncounter(encounter),
          ...conditions.map(toFhirCondition),
          ...observations.map(toFhirObservation),
        ]));
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
        const { conditions } = await api.getEncounterChart(requireEncounterParam(input.url), input.ctx);
        return fhir(200, bundle('searchset', conditions.map(toFhirCondition)));
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
        const { observations } = await api.getEncounterChart(requireEncounterParam(input.url), input.ctx);
        return fhir(200, bundle('searchset', observations.map(toFhirObservation)));
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
      } else if (p !== s) { ok = false; break; }
    }
    if (!ok) continue;
    if (r.method === method) return { kind: 'match', route: r, ids };
    allow.add(r.method);
  }
  return allow.size > 0 ? { kind: 'method-not-allowed', allow: [...allow].sort() } : { kind: 'not-found' };
}
