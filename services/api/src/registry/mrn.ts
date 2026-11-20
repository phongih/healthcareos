/**
 * HCOS-F13 | Mã bệnh nhân (MRN) tự sinh: <TIỀN TỐ><YY>-<NNNNNN>-<C> (vd. BN26-000123-5), C = số kiểm tra Luhn của YYNNNNNN.
 * Số do CSDL cấp (patient.next_mrn, migration 016). File này: kiểm tra định dạng / số kiểm tra, chuẩn hoá khi tìm,
 * quyết định dùng mã tự sinh hay mã cũ khi đăng ký.
 */
import type { TenantScopedDb } from '../../../../packages/domain/src/s0-contracts';

/** Dạng mã tự sinh (chuẩn, có gạch). */
export const AUTO_MRN_RE = /^[A-Z]{1,4}\d{2}-\d{6}-\d$/;
/** Dạng "giống mã tự sinh" khi người dùng gõ / quét: chữ thường, thiếu gạch. */
const AUTO_SHAPE_RE = /^([A-Za-z]{1,4})(\d{2})-?(\d{6})-?(\d)$/;
/** Mã cũ hợp lệ (giữ như trước F13). */
export const LEGACY_MRN_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export class MrnError extends Error {
  constructor(readonly kind: 'VALIDATION' | 'CONFLICT', readonly reason: string, message: string) {
    super(message);
  }
}

export function luhnDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error('luhnDigit needs digits');
  let s = 0;
  let dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    s += d;
    dbl = !dbl;
  }
  return (10 - (s % 10)) % 10;
}

export function formatAutoMrn(prefix: string, year2: number, n: number): string {
  const yy = String(year2).padStart(2, '0');
  const nn = String(n).padStart(6, '0');
  return `${prefix}${yy}-${nn}-${luhnDigit(yy + nn)}`;
}

/**
 * Chuẩn hoá giá trị tìm theo MRN. Giá trị có dạng mã tự sinh (kể cả chữ thường / thiếu gạch, vd. quét mã vạch "BN260001235")
 * được đưa về dạng chuẩn và kiểm số kiểm tra; sai số kiểm tra => lỗi rõ ràng thay vì "không tìm thấy" (hoặc mở nhầm hồ sơ).
 */
export function normalizeMrnQuery(raw: string): string {
  const v = raw.trim();
  const m = AUTO_SHAPE_RE.exec(v);
  if (!m) {
    if (!LEGACY_MRN_RE.test(v)) throw new MrnError('VALIDATION', 'INVALID_MRN', 'Invalid MRN format');
    return v;
  }
  const [, p, yy, nn, c] = m as unknown as [string, string, string, string, string];
  if (luhnDigit(yy + nn) !== Number(c)) throw new MrnError('VALIDATION', 'MRN_CHECK_DIGIT', 'MRN check digit does not match (mistyped?)');
  return `${p.toUpperCase()}${yy}-${nn}-${c}`;
}

export interface MrnSettings {
  readonly prefix: string;
  readonly allowLegacy: boolean;
  readonly version: number;
}

export async function readMrnSettings(db: TenantScopedDb, tenantId: string, org: string): Promise<MrnSettings> {
  const r = await db.query<Record<string, unknown>>('SELECT prefix, allow_legacy, version FROM patient.mrn_settings WHERE tenant_id = $1 AND organization_id = $2', [tenantId, org]);
  const x = r.rows[0];
  return x ? { prefix: x['prefix'] as string, allowLegacy: x['allow_legacy'] === true || x['allow_legacy'] === 't', version: Number(x['version']) } : { prefix: 'BN', allowLegacy: false, version: 0 };
}

/**
 * MRN cho hồ sơ mới: không nhập => CSDL cấp mã tự sinh; có nhập => chỉ khi cơ sở bật "cho nhập mã cũ", và mã cũ không được
 * có dạng mã tự sinh (tránh đụng số sẽ cấp sau này).
 */
export async function resolveMrn(db: TenantScopedDb, tenantId: string, org: string, raw: string | null | undefined, at: Date): Promise<{ mrn: string; generated: boolean }> {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') {
    const r = await db.query<{ mrn: string }>('SELECT patient.next_mrn($1, $2, $3) AS mrn', [tenantId, org, at.toISOString()]);
    return { mrn: r.rows[0]!.mrn, generated: true };
  }
  if (!LEGACY_MRN_RE.test(v)) throw new MrnError('VALIDATION', 'INVALID_MRN', 'Invalid MRN format');
  if (AUTO_SHAPE_RE.test(v)) throw new MrnError('VALIDATION', 'MRN_RESERVED_FORMAT', 'Legacy MRN must not look like an auto-generated MRN');
  const s = await readMrnSettings(db, tenantId, org);
  if (!s.allowLegacy) throw new MrnError('CONFLICT', 'LEGACY_MRN_DISABLED', 'Manual MRN entry is disabled for this organization; leave MRN empty to auto-generate');
  return { mrn: v, generated: false };
}
