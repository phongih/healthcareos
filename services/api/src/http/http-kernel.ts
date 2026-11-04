/**
 * HCOS-P0-ENG-001 | S2 | HTTP kernel: lỗi -> OperationOutcome, đọc body có giới hạn, gửi JSON an toàn.
 * Chỉ dùng node:http (không phụ thuộc framework).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { TenantIsolationError, VersionConflictError } from '../../../../packages/domain/src/s0-contracts';
import { FhirMappingError } from '../../../../packages/domain/src/s1-contracts';
import { ClinicalError } from '../clinical/encounter.service';

export const FHIR_JSON = 'application/fhir+json; charset=utf-8';
export const PLAIN_JSON = 'application/json; charset=utf-8';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly fhirCode: string,
    message: string,
    public readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface OperationOutcome {
  readonly resourceType: 'OperationOutcome';
  readonly issue: ReadonlyArray<{
    readonly severity: 'error';
    readonly code: string;
    readonly details?: { readonly text: string };
    readonly diagnostics: string;
  }>;
}

export const operationOutcome = (code: string, diagnostics: string, detailsText?: string): OperationOutcome => ({
  resourceType: 'OperationOutcome',
  issue: [{ severity: 'error', code, ...(detailsText ? { details: { text: detailsText } } : {}), diagnostics }],
});

export interface MappedError {
  readonly status: number;
  readonly fhirCode: string;
  readonly message: string;
  readonly detail?: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Chuyển mọi lỗi thành phản hồi an toàn. Lỗi không nhận diện được => 500 chung, không lộ nội dung. */
export function mapError(e: unknown): MappedError {
  if (e instanceof HttpError) return { status: e.status, fhirCode: e.fhirCode, message: e.message, headers: e.headers };
  if (e instanceof TenantIsolationError) {
    return e.httpStatus === 401
      ? { status: 401, fhirCode: 'login', message: 'Authentication required', detail: e.code, headers: { 'www-authenticate': 'Bearer' } }
      : { status: 403, fhirCode: 'forbidden', message: 'Access denied', detail: e.code, headers: {} };
  }
  if (e instanceof VersionConflictError) {
    return { status: 412, fhirCode: 'conflict', message: 'Resource version does not match If-Match', headers: {} };
  }
  if (e instanceof FhirMappingError) return { status: 422, fhirCode: 'invalid', message: e.message, headers: {} };
  if (e instanceof ClinicalError) {
    switch (e.code) {
      case 'NOT_FOUND': return { status: 404, fhirCode: 'not-found', message: e.message, headers: {} };
      case 'FORBIDDEN': return { status: 403, fhirCode: 'forbidden', message: 'Access denied', headers: {} };
      case 'CONFLICT': return { status: 409, fhirCode: 'conflict', message: e.message, headers: {} };
      case 'INVALID_STATE': return { status: 409, fhirCode: 'conflict', message: e.message, headers: {} };
      case 'VALIDATION': return { status: 422, fhirCode: 'invalid', message: e.message, headers: {} };
    }
  }
  return { status: 500, fhirCode: 'exception', message: 'Internal server error', headers: {} };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

const JSON_CT_RE = /^application\/(?:fhir\+)?json\s*(?:;|$)/i;

/**
 * Đọc body JSON có giới hạn kích thước. Trả undefined khi body rỗng.
 * Ném HttpError 413/415/400 khi vi phạm.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'too-costly', 'Payload too large', { connection: 'close' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > maxBytes) throw new HttpError(413, 'too-costly', 'Payload too large', { connection: 'close' });
    chunks.push(b);
  }
  if (size === 0) return undefined;

  const ct = req.headers['content-type'];
  if (typeof ct !== 'string' || !JSON_CT_RE.test(ct)) {
    throw new HttpError(415, 'not-supported', 'Content-Type must be application/json or application/fhir+json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'structure', 'Malformed JSON body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'structure', 'JSON body must be an object');
  }
  return parsed;
}

const CORRELATION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Chỉ chấp nhận correlation-id an toàn (chống header injection / log forging); nếu không hợp lệ, cấp mới. */
export function sanitizeCorrelationId(raw: string | string[] | undefined, fresh: () => string): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v !== undefined && CORRELATION_RE.test(v) ? v : fresh();
}
