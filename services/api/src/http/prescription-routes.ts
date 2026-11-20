/**
 * HCOS-F5 | HTTP: đơn thuốc (JSON thường, không phải FHIR).
 *
 *   POST /api/prescriptions                          kê đơn cho đợt khám đang mở (bác sĩ phụ trách)
 *   GET  /api/prescriptions?encounter=<uuid>         các đơn của một đợt khám
 *   GET  /api/prescriptions?organization=<uuid>[&status=active|completed|cancelled]
 *                                                    hàng đợi đơn của dược (mặc định active, cũ nhất trước)
 *   POST /api/prescriptions/:id/cancel               huỷ đơn chưa cấp gì (If-Match: W/"<version>")
 *
 * Cấp phát theo đơn: POST /api/pharmacy/dispenses kèm `prescriptionItemId`.
 */
import type { PrescriptionService } from '../clinical/prescription.service';
import { parseIfMatch, requireBody, type Route, type RouteResult } from './clinical-routes';
import { HttpError, PLAIN_JSON } from './http-kernel';

export type PrescriptionApi = Pick<PrescriptionService, 'createPrescription' | 'cancelPrescription' | 'listForEncounter' | 'listForOrganization'>;

const json = (status: number, body: unknown, headers?: Record<string, string>): RouteResult => ({
  status,
  body,
  contentType: PLAIN_JSON,
  ...(headers ? { headers } : {}),
});

export function buildPrescriptionRoutes(api: PrescriptionApi): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: ['api', 'prescriptions'],
      handler: async (input) => {
        const b = await requireBody(input);
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid', 'Body must be a JSON object');
        const o = b as Record<string, unknown>;
        for (const k of Object.keys(o)) {
          if (!['encounterId', 'note', 'items'].includes(k)) throw new HttpError(400, 'invalid', `Unknown field ${k}`);
        }
        const v = await api.createPrescription(
          {
            encounterId: o['encounterId'] as string,
            note: (o['note'] as string | null | undefined) ?? null,
            items: o['items'] as never,
          },
          input.ctx,
        );
        return json(201, v, { etag: `W/"${v.prescription.version}"` });
      },
    },
    {
      method: 'GET',
      pattern: ['api', 'prescriptions'],
      handler: async (input) => {
        const p = input.url.searchParams;
        for (const k of p.keys()) {
          if (!['encounter', 'organization', 'status'].includes(k)) throw new HttpError(400, 'invalid', `Unsupported parameter ${k}`);
        }
        const encounter = p.get('encounter');
        const organization = p.get('organization');
        if ((encounter === null) === (organization === null)) {
          throw new HttpError(400, 'invalid', 'Exactly one of encounter or organization is required');
        }
        if (encounter !== null) {
          if (p.has('status')) throw new HttpError(400, 'invalid', 'status is only supported with organization');
          return json(200, { prescriptions: await api.listForEncounter(encounter, input.ctx) });
        }
        return json(200, {
          prescriptions: await api.listForOrganization({ organizationId: organization!, ...(p.has('status') ? { status: p.get('status')! } : {}) }, input.ctx),
        });
      },
    },
    {
      method: 'POST',
      pattern: ['api', 'prescriptions', ':id', 'cancel'],
      handler: async (input, [id]) => {
        const version = parseIfMatch(input.req.headers['if-match']);
        const p = await api.cancelPrescription(id!, version, input.ctx);
        return json(200, p, { etag: `W/"${p.version}"` });
      },
    },
  ];
}
