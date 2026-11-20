/**
 * HCOS-F8 | HTTP: thu ngân (JSON thường). Tiền là số nguyên VND.
 *
 *   GET  /api/finance/settings?organization=                      cài đặt (tạm ứng mặc định, tài khoản VietQR)
 *   POST /api/finance/settings  { organizationId, depositDefault, bank|null } + If-Match (W/"0" khi chưa có)   (finance:manage)
 *   GET  /api/finance/price-items?organization=
 *   POST /api/finance/price-items  { organizationId, code, name, category, unitPrice }                          (finance:manage)
 *   POST /api/finance/price-items/:id  { name, category, unitPrice, isActive } + If-Match                      (finance:manage)
 *   GET  /api/finance/shifts/mine?organization=                   => { shift: … | null }
 *   GET  /api/finance/shifts?organization=&from=&to=              báo cáo ca (quản lý / ban giám đốc)
 *   GET  /api/finance/shifts/:id                                  ca + danh sách phiếu
 *   POST /api/finance/shifts  { organizationId, openingFloat }
 *   POST /api/finance/shifts/:id/close  { countedCash, note? } + If-Match
 *   GET  /api/finance/cases?organization=&status=open|closed&patient=
 *   POST /api/finance/cases  { organizationId, patientId }        hồ sơ đang mở của bệnh nhân (chưa có thì mở)
 *   GET  /api/finance/cases/:id
 *   POST /api/finance/cases/:id/charges  { itemId, quantity }
 *   POST /api/finance/cases/:id/close  + If-Match
 *   POST /api/finance/charges/:id/void  { reason }
 *   POST /api/finance/receipts  { organizationId, caseId|patientId, kind, method, amount, reference?, payerName? }
 *        + Idempotency-Key (bắt buộc; thiếu => 428). Gửi lại => 201 + Idempotent-Replayed: true, không thu lần hai.
 *   POST /api/finance/receipts/:id/cancel  { reason }
 */
import type { FinanceService } from '../finance/finance.service';
import { parseIfMatch, requireBody, type Route, type RouteInput, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type FinanceApi = Pick<
  FinanceService,
  | 'getSettings' | 'updateSettings' | 'listPriceItems' | 'createPriceItem' | 'updatePriceItem' | 'myShift' | 'openShift' | 'closeShift' | 'getShift'
  | 'listShifts' | 'listCases' | 'openCase' | 'getCase' | 'addCharge' | 'voidCharge' | 'closeCase' | 'createReceipt' | 'cancelReceipt'
>;

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({
  status, body, contentType: PLAIN_JSON, ...(headers ? { headers } : {}),
});
const etag = (v: number) => ({ etag: `W/"${v}"` });
async function obj(input: RouteInput, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const b = await requireBody(input);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
  return o;
}
function params(url: URL, allowed: readonly string[]): URLSearchParams {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new HttpError(400, 'not-supported', `Unsupported parameter '${k}'`);
  return url.searchParams;
}
const required = (p: URLSearchParams, k: string): string => {
  const v = p.get(k);
  if (!v || p.getAll(k).length > 1) throw new HttpError(400, 'required', `Parameter '${k}' is required`);
  return v;
};
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Số tiền / số lượng phải là number trong JSON (không nhận chuỗi "500000"). */
const numField = (o: Record<string, unknown>, k: string): number => {
  if (typeof o[k] !== 'number') throw new HttpError(400, 'invalid', `${k} must be a number`);
  return o[k] as number;
};
const optStr = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'invalid', `${k} must be a string or null`);
  return v;
};

export function buildFinanceRoutes(api: FinanceApi): readonly Route[] {
  return [
    // ---- cài đặt ----
    {
      method: 'GET',
      pattern: ['api', 'finance', 'settings'],
      handler: async (input) => {
        const st = await api.getSettings(required(params(input.url, ['organization']), 'organization'), input.ctx);
        return json(200, st, etag(st.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'settings'],
      handler: async (input) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['organizationId', 'depositDefault', 'bank']);
        const b = o['bank'];
        if (b !== null && (typeof b !== 'object' || Array.isArray(b))) throw new HttpError(400, 'invalid', 'bank must be an object or null');
        const bank = b ? { bin: s((b as Record<string, unknown>)['bin']), account: s((b as Record<string, unknown>)['account']), accountName: s((b as Record<string, unknown>)['accountName']) } : null;
        const st = await api.updateSettings({ organizationId: s(o['organizationId']), depositDefault: numField(o, 'depositDefault'), bank }, version, input.ctx);
        return json(200, st, etag(st.version));
      },
    },
    // ---- bảng giá ----
    {
      method: 'GET',
      pattern: ['api', 'finance', 'price-items'],
      handler: async (input) => json(200, { items: await api.listPriceItems(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'price-items'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'code', 'name', 'category', 'unitPrice']);
        const it = await api.createPriceItem(
          { organizationId: s(o['organizationId']), code: s(o['code']), name: s(o['name']), category: s(o['category']), unitPrice: numField(o, 'unitPrice') },
          input.ctx,
        );
        return json(201, it, etag(it.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'price-items', ':id'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['name', 'category', 'unitPrice', 'isActive']);
        if (typeof o['isActive'] !== 'boolean') throw new HttpError(400, 'invalid', 'isActive must be boolean');
        const it = await api.updatePriceItem(id!, { name: s(o['name']), category: s(o['category']), unitPrice: numField(o, 'unitPrice'), isActive: o['isActive'] }, version, input.ctx);
        return json(200, it, etag(it.version));
      },
    },
    // ---- ca ----
    {
      method: 'GET',
      pattern: ['api', 'finance', 'shifts', 'mine'],
      handler: async (input) => json(200, { shift: await api.myShift(required(params(input.url, ['organization']), 'organization'), input.ctx) }),
    },
    {
      method: 'GET',
      pattern: ['api', 'finance', 'shifts'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'from', 'to']);
        const from = p.get('from');
        const to = p.get('to');
        return json(200, { shifts: await api.listShifts({ organizationId: required(p, 'organization'), ...(from ? { from } : {}), ...(to ? { to } : {}) }, input.ctx) });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'finance', 'shifts', ':id'],
      handler: async (input, [id]) => {
        const sh = await api.getShift(id!, input.ctx);
        return json(200, sh, etag(sh.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'shifts'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'openingFloat']);
        const sh = await api.openShift({ organizationId: s(o['organizationId']), openingFloat: numField(o, 'openingFloat') }, input.ctx);
        return json(201, sh, etag(sh.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'shifts', ':id', 'close'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const o = await obj(input, ['countedCash', 'note']);
        const sh = await api.closeShift(id!, { countedCash: numField(o, 'countedCash'), note: optStr(o, 'note') }, version, input.ctx);
        return json(200, sh, etag(sh.version));
      },
    },
    // ---- hồ sơ ----
    {
      method: 'GET',
      pattern: ['api', 'finance', 'cases'],
      handler: async (input) => {
        const p = params(input.url, ['organization', 'status', 'patient']);
        const status = p.get('status');
        const patient = p.get('patient');
        return json(200, {
          cases: await api.listCases({ organizationId: required(p, 'organization'), ...(status ? { status } : {}), ...(patient ? { patientId: patient } : {}) }, input.ctx),
        });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'cases'],
      handler: async (input) => {
        const o = await obj(input, ['organizationId', 'patientId']);
        const c = await api.openCase({ organizationId: s(o['organizationId']), patientId: s(o['patientId']) }, input.ctx);
        return json(200, c, etag(c.version));
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'finance', 'cases', ':id'],
      handler: async (input, [id]) => {
        const c = await api.getCase(id!, input.ctx);
        return json(200, c, etag(c.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'cases', ':id', 'charges'],
      handler: async (input, [id]) => {
        const o = await obj(input, ['itemId', 'quantity']);
        const c = await api.addCharge(id!, { itemId: s(o['itemId']), quantity: numField(o, 'quantity') }, input.ctx);
        return json(201, c, etag(c.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'cases', ':id', 'close'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const c = await api.closeCase(id!, version, input.ctx);
        return json(200, c, etag(c.version));
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'charges', ':id', 'void'],
      handler: async (input, [id]) => {
        const o = await obj(input, ['reason']);
        const c = await api.voidCharge(id!, { reason: s(o['reason']) }, input.ctx);
        return json(200, c, etag(c.version));
      },
    },
    // ---- phiếu ----
    {
      method: 'POST',
      pattern: ['api', 'finance', 'receipts'],
      handler: async (input) => {
        const raw = input.req.headers['idempotency-key'];
        const key = Array.isArray(raw) ? raw[0] : raw;
        if (!key) throw new HttpError(428, 'required', 'Idempotency-Key header is required for this operation');
        const o = await obj(input, ['organizationId', 'caseId', 'patientId', 'kind', 'method', 'amount', 'reference', 'payerName']);
        const caseId = optStr(o, 'caseId');
        const patientId = optStr(o, 'patientId');
        const r = await api.createReceipt(
          {
            organizationId: s(o['organizationId']), ...(caseId ? { caseId } : {}), ...(patientId ? { patientId } : {}), kind: s(o['kind']), method: s(o['method']),
            amount: numField(o, 'amount'), reference: optStr(o, 'reference'), payerName: optStr(o, 'payerName'),
          },
          key,
          input.ctx,
        );
        return json(201, r.value, r.replayed ? { 'idempotent-replayed': 'true' } : undefined);
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'finance', 'receipts', ':id', 'cancel'],
      handler: async (input, [id]) => {
        const o = await obj(input, ['reason']);
        const c = await api.cancelReceipt(id!, { reason: s(o['reason']) }, input.ctx);
        return json(200, c, etag(c.version));
      },
    },
  ];
}
