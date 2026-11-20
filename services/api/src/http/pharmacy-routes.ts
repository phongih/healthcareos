/**
 * HCOS-P0-ENG-001 | S3 | Route dược (quyết định truy cập nằm ở PharmacyInventoryService)
 *
 *   GET  /api/pharmacy/medications?active=true|false&_count=1..200   danh mục thuốc
 *   POST /api/pharmacy/medications                                  thêm biệt dược
 *   POST /api/pharmacy/substances                                   thêm hoạt chất
 *   GET  /fhir/Medication/:id                                       FHIR Medication
 *   GET  /api/pharmacy/locations?organization=<uuid>                vị trí kho của organization
 *   POST /api/pharmacy/locations                                    tạo kho / quầy / tủ trực
 *   GET  /api/pharmacy/locations/:id/stock                          tồn kho theo lô
 *   POST /api/pharmacy/receipts                                     nhập kho theo lô         (Idempotency-Key bắt buộc)
 *   POST /api/pharmacy/dispenses                                    cấp phát FEFO cho đợt khám (Idempotency-Key bắt buộc)
 *   GET  /api/pharmacy/dispenses?encounter=<uuid>                   các lần cấp phát của đợt khám
 *
 * Body chỉ lấy khoá đã biết; sai kiểu => 422 trước khi vào service.
 *
 * Idempotency (nhập / cấp phát): thiếu header => 428. Gửi lại cùng khoá + cùng body => trả lại đúng kết quả cũ
 * (cùng status) kèm `Idempotent-Replayed: true`, không đụng tới kho. Cùng khoá, body khác => 422 IDEMPOTENCY_KEY_REUSED.
 * Lần gửi trước bị lỗi thì khoá không được lưu: gửi lại sẽ thực hiện lại.
 */
import { isUuid } from '../../../../packages/domain/src/s0-contracts';
import { toFhirMedication } from '../../../../packages/domain/src/s3-pharmacy-contracts';
import type {
  CreateMedicationInput,
  CreateStockLocationInput,
  PharmacyInventoryService,
} from '../pharmacy/inventory.service';
import { requireBody, type Route, type RouteResult } from './clinical-routes';
import { FHIR_JSON, HttpError, PLAIN_JSON } from './http-kernel';

export type PharmacyApi = Pick<
  PharmacyInventoryService,
  | 'listMedications' | 'getMedication' | 'createMedication' | 'createSubstance' | 'listStockLocations' | 'createStockLocation'
  | 'getStock' | 'receiveStockOnce' | 'dispenseMedicationOnce' | 'listDispensesByEncounter'
>;

function idempotencyKey(input: Parameters<Route['handler']>[0]): string {
  const raw = input.req.headers['idempotency-key'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === '') throw new HttpError(428, 'required', 'Idempotency-Key header is required for this operation');
  return v;
}
const replayHeaders = (replayed: boolean): Record<string, string> => (replayed ? { 'idempotent-replayed': 'true' } : {});

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult =>
  ({ status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}) });
const bad = (msg: string): never => {
  throw new HttpError(422, 'invalid', msg);
};
const obj = async (input: Parameters<Route['handler']>[0]): Promise<Record<string, unknown>> =>
  (await requireBody(input)) as Record<string, unknown>;

function str(o: Record<string, unknown>, k: string, max: number, required: true): string;
function str(o: Record<string, unknown>, k: string, max: number, required?: false): string | undefined;
function str(o: Record<string, unknown>, k: string, max: number, required = false): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return required ? bad(`${k} is required`) : undefined;
  if (typeof v !== 'string' || v.length > max) return bad(`${k} must be a string (max ${max})`);
  return v;
}
function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number') return bad(`${k} must be a number`);
  return v;
}
function onlyParams(url: URL, allowed: readonly string[]): void {
  for (const k of url.searchParams.keys()) {
    if (!allowed.includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
    if (url.searchParams.getAll(k).length > 1) throw new HttpError(400, 'invalid', `Parameter '${k}' may appear only once`);
  }
}
function uuidParam(url: URL, k: string): string {
  const v = url.searchParams.get(k);
  if (!v || !isUuid(v)) throw new HttpError(400, 'required', `A valid '${k}' parameter is required`);
  return v;
}

const LOCATION_TYPES: readonly string[] = ['main_warehouse', 'dispensary_counter', 'ward_cabinet', 'quarantine'];

export function buildPharmacyRoutes(api: PharmacyApi): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: ['api', 'pharmacy', 'medications'],
      handler: async (input) => {
        onlyParams(input.url, ['active', '_count']);
        const active = input.url.searchParams.get('active');
        if (active !== null && active !== 'true' && active !== 'false') throw new HttpError(400, 'invalid', "active must be 'true' or 'false'");
        const c = input.url.searchParams.get('_count');
        const limit = c === null ? undefined : /^\d{1,3}$/.test(c) ? Number(c) : NaN;
        const meds = await api.listMedications({ ...(active !== null ? { activeOnly: active === 'true' } : {}), ...(limit !== undefined ? { limit } : {}) }, input.ctx);
        return json(200, { medications: meds });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'pharmacy', 'medications'],
      handler: async (input) => {
        const o = await obj(input);
        const payload: CreateMedicationInput = {
          brandName: str(o, 'brandName', 200, true),
          strength: str(o, 'strength', 64, true),
          form: str(o, 'form', 64, true),
          unitOfMeasure: str(o, 'unitOfMeasure', 32, true),
          ...optional(o, ['substanceId', 36], ['genericName', 200], ['route', 64], ['barcode', 64]),
        };
        const m = await api.createMedication(payload, input.ctx);
        return json(201, m, { location: `/fhir/Medication/${m.medicationId}` });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'pharmacy', 'substances'],
      handler: async (input) => {
        const o = await obj(input);
        return json(201, await api.createSubstance({ code: str(o, 'code', 64, true), name: str(o, 'name', 200, true) }, input.ctx));
      },
    },
    {
      method: 'GET',
      pattern: ['fhir', 'Medication', ':id'],
      handler: async (input, [id]) => ({ status: 200, body: toFhirMedication(await api.getMedication(id!, input.ctx)), contentType: FHIR_JSON }),
    },
    {
      method: 'GET',
      pattern: ['api', 'pharmacy', 'locations'],
      handler: async (input) => {
        onlyParams(input.url, ['organization']);
        return json(200, { locations: await api.listStockLocations(uuidParam(input.url, 'organization'), input.ctx) });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'pharmacy', 'locations'],
      handler: async (input) => {
        const o = await obj(input);
        const type = str(o, 'type', 32, true);
        if (!LOCATION_TYPES.includes(type)) return bad(`type must be one of: ${LOCATION_TYPES.join(', ')}`);
        const organizationId = str(o, 'organizationId', 36, true);
        if (!isUuid(organizationId)) return bad('organizationId must be a uuid');
        const loc = await api.createStockLocation(
          { organizationId, name: str(o, 'name', 200, true), type: type as CreateStockLocationInput['type'] },
          input.ctx,
        );
        return json(201, loc, { location: `/api/pharmacy/locations/${loc.locationId}/stock` });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'pharmacy', 'locations', ':id', 'stock'],
      handler: async (input, [id]) => json(200, await api.getStock(id!, input.ctx)),
    },
    {
      method: 'POST',
      pattern: ['api', 'pharmacy', 'receipts'],
      handler: async (input) => {
        const key = idempotencyKey(input);
        const o = await obj(input);
        const r = await api.receiveStockOnce(
          {
            medicationId: str(o, 'medicationId', 36, true),
            locationId: str(o, 'locationId', 36, true),
            batchNumber: str(o, 'batchNumber', 64, true),
            expiryDate: str(o, 'expiryDate', 10, true) as never,
            unitCost: num(o, 'unitCost'),
            quantity: num(o, 'quantity'),
            ...optional(o, ['manufacturingDate', 10], ['reason', 500]),
          },
          key,
          input.ctx,
        );
        return json(201, r.value, replayHeaders(r.replayed));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'pharmacy', 'dispenses'],
      handler: async (input) => {
        const key = idempotencyKey(input);
        const o = await obj(input);
        const plan = await api.dispenseMedicationOnce(
          {
            medicationId: str(o, 'medicationId', 36, true),
            locationId: str(o, 'locationId', 36, true),
            encounterId: str(o, 'encounterId', 36, true),
            quantity: num(o, 'quantity'),
            ...optional(o, ['reason', 500], ['prescriptionItemId', 36]),
          },
          key,
          input.ctx,
        );
        return json(201, plan.value, replayHeaders(plan.replayed));
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'pharmacy', 'dispenses'],
      handler: async (input) => {
        onlyParams(input.url, ['encounter']);
        return json(200, { dispenses: await api.listDispensesByEncounter(uuidParam(input.url, 'encounter'), input.ctx) });
      },
    },
  ];
}

/** Lấy các khoá tuỳ chọn kiểu string (có giới hạn độ dài); vắng/null => bỏ qua. */
function optional(o: Record<string, unknown>, ...keys: Array<[string, number]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, max] of keys) {
    const v = str(o, k, max);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
