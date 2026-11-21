/**
 * HCOS-F19 | HTTP: thiết bị & vật tư y khoa (JSON thường).
 *
 *   GET  /api/equipment?organization=                    sổ thiết bị + loại + phòng + dịch vụ cần máy        (equipment:read)
 *   GET  /api/equipment/devices/:ref                     trang thiết bị (ref = mã tài sản TByy-nnnn-c hoặc id; QR) (equipment:read)
 *   POST /api/equipment/devices                          đăng ký thiết bị (mã tài sản tự sinh)               (equipment:manage)
 *   POST /api/equipment/devices/:ref                     sửa thông tin { …, version }                         (equipment:manage)
 *   POST /api/equipment/devices/:ref/events              { kind, note?, majorRepair?, toServicePointId?, via? } (use / manage theo loại)
 *   POST /api/equipment/devices/:ref/regimes             { regime, cycleMonths, mandatory, active?, version? } (equipment:manage)
 *   POST /api/equipment/devices/:ref/inspections         { regime, performedOn, result, validUntil?, provider, certificateNo?, note? }
 *   POST /api/equipment/types                            { code, name }                                        (equipment:manage)
 *   POST /api/equipment/requirements                     { organizationId, itemId, typeId, active? }           (equipment:manage)
 *   GET  /api/supplies?organization=                     định mức, kho trừ, dòng thiếu, giá vốn 30 ngày        (supply:read)
 *   POST /api/supplies/settings                          { organizationId, locationId, version }               (supply:manage)
 *   POST /api/supplies/norms                             { organizationId, itemId, medicationId, quantity }    (supply:manage)
 *   GET  /api/supplies/lots?organization=&patient=       lô đã ghi cho hồ sơ đang mở                           (supply:record | supply:read)
 *   POST /api/supplies/lots                              { organizationId, patientId, batchNumber, medicationId?, quantity } (supply:record)
 *   POST /api/supplies/lots/:id/cancel                   { reason }                                            (supply:record)
 *   POST /api/supplies/shortfalls/:id/resolve            { note }                                              (supply:manage)
 *   GET  /api/supplies/cases/:id                         vật tư đã trừ + giá vốn của hồ sơ thanh toán           (supply:read)
 *   POST /api/supplies/recall                            { organizationId, batchNumber, medicationId?, reason } (supply:recall)
 */
import type { EquipmentService } from '../equipment/equipment.service';
import { requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type EquipmentApi = Pick<
  EquipmentService,
  | 'listDevices' | 'getDevice' | 'registerDevice' | 'updateDevice' | 'addEvent' | 'setRegime' | 'recordInspection' | 'createType' | 'setServiceRequirement'
  | 'supplyOverview' | 'setSupplyLocation' | 'setNorm' | 'patientLots' | 'recordLot' | 'cancelLot' | 'resolveShortfall' | 'caseSupplies' | 'recall'
>;

const json = (status: number, body: unknown): RouteResult => ({ status, body, contentType: PLAIN_JSON, headers: { 'cache-control': 'no-store' } });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
function params(input: RouteInput, allowed: readonly string[]): URLSearchParams {
  for (const k of input.url.searchParams.keys()) if (!allowed.includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
  return input.url.searchParams;
}
const DEVICE_FIELDS = ['typeId', 'name', 'manufacturer', 'model', 'serialNo', 'riskClass', 'registrationNo', 'warrantyUntil', 'acquiredOn', 'inServiceOn', 'cost', 'usefulLifeMonths'];

export function buildEquipmentRoutes(api: EquipmentApi | undefined): readonly Route[] {
  if (!api) return [];
  return [
    { method: 'GET', pattern: ['api', 'equipment'], handler: async (input) => json(200, await api.listDevices({ organizationId: params(input, ['organization']).get('organization') }, input.ctx)) },
    { method: 'GET', pattern: ['api', 'equipment', 'devices', ':ref'], handler: async (input, [ref]) => json(200, await api.getDevice(decodeURIComponent(ref!), input.ctx)) },
    {
      method: 'POST', pattern: ['api', 'equipment', 'devices'],
      handler: async (input) => json(201, await api.registerDevice(await obj(input, ['organizationId', 'servicePointId', 'regimes', ...DEVICE_FIELDS]), input.ctx)),
    },
    {
      method: 'POST', pattern: ['api', 'equipment', 'devices', ':ref'],
      handler: async (input, [ref]) => json(200, await api.updateDevice(decodeURIComponent(ref!), await obj(input, [...DEVICE_FIELDS, 'version']), input.ctx)),
    },
    {
      method: 'POST', pattern: ['api', 'equipment', 'devices', ':ref', 'events'],
      handler: async (input, [ref]) => json(201, await api.addEvent(decodeURIComponent(ref!), (await obj(input, ['kind', 'note', 'majorRepair', 'toServicePointId', 'via'])) as never, input.ctx)),
    },
    {
      method: 'POST', pattern: ['api', 'equipment', 'devices', ':ref', 'regimes'],
      handler: async (input, [ref]) => json(200, await api.setRegime(decodeURIComponent(ref!), (await obj(input, ['regime', 'cycleMonths', 'mandatory', 'active', 'version'])) as never, input.ctx)),
    },
    {
      method: 'POST', pattern: ['api', 'equipment', 'devices', ':ref', 'inspections'],
      handler: async (input, [ref]) =>
        json(201, await api.recordInspection(decodeURIComponent(ref!), (await obj(input, ['regime', 'performedOn', 'result', 'validUntil', 'provider', 'certificateNo', 'note'])) as never, input.ctx)),
    },
    { method: 'POST', pattern: ['api', 'equipment', 'types'], handler: async (input) => json(201, await api.createType((await obj(input, ['code', 'name'])) as never, input.ctx)) },
    {
      method: 'POST', pattern: ['api', 'equipment', 'requirements'],
      handler: async (input) => json(200, await api.setServiceRequirement((await obj(input, ['organizationId', 'itemId', 'typeId', 'active'])) as never, input.ctx)),
    },
    { method: 'GET', pattern: ['api', 'supplies'], handler: async (input) => json(200, await api.supplyOverview({ organizationId: params(input, ['organization']).get('organization') }, input.ctx)) },
    { method: 'POST', pattern: ['api', 'supplies', 'settings'], handler: async (input) => json(200, await api.setSupplyLocation((await obj(input, ['organizationId', 'locationId', 'version'])) as never, input.ctx)) },
    { method: 'POST', pattern: ['api', 'supplies', 'norms'], handler: async (input) => json(200, await api.setNorm((await obj(input, ['organizationId', 'itemId', 'medicationId', 'quantity'])) as never, input.ctx)) },
    {
      method: 'GET', pattern: ['api', 'supplies', 'lots'],
      handler: async (input) => {
        const q = params(input, ['organization', 'patient']);
        return json(200, await api.patientLots({ organizationId: q.get('organization'), patientId: q.get('patient') }, input.ctx));
      },
    },
    { method: 'POST', pattern: ['api', 'supplies', 'lots'], handler: async (input) => json(201, await api.recordLot((await obj(input, ['organizationId', 'patientId', 'batchNumber', 'medicationId', 'quantity'])) as never, input.ctx)) },
    { method: 'POST', pattern: ['api', 'supplies', 'lots', ':id', 'cancel'], handler: async (input, [id]) => json(200, await api.cancelLot(id!, (await obj(input, ['reason'])) as never, input.ctx)) },
    { method: 'POST', pattern: ['api', 'supplies', 'shortfalls', ':id', 'resolve'], handler: async (input, [id]) => json(200, await api.resolveShortfall(id!, (await obj(input, ['note'])) as never, input.ctx)) },
    { method: 'GET', pattern: ['api', 'supplies', 'cases', ':id'], handler: async (input, [id]) => json(200, await api.caseSupplies(id!, input.ctx)) },
    { method: 'POST', pattern: ['api', 'supplies', 'recall'], handler: async (input) => json(200, await api.recall((await obj(input, ['organizationId', 'batchNumber', 'medicationId', 'reason'])) as never, input.ctx)) },
  ];
}
