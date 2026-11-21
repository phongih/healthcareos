/**
 * HCOS-F16 | Mã hoá theo trường (envelope encryption) + blind index + quản lý khoá.
 *
 *   KEK (key-encryption key)  nằm NGOÀI CSDL: biến môi trường / file trên máy chủ ứng dụng (KeyProvider; sau này: Cloud KMS).
 *                             Không bao giờ ghi vào CSDL, log, API hay bản sao lưu CSDL.
 *   DEK (data key)            mỗi tenant một khoá AES-256 cho mỗi mục đích ('data' mã hoá, 'index' blind index), có phiên bản.
 *                             Lưu trong keyvault.tenant_keys dưới dạng ĐÃ BỌC bằng KEK (AES-256-GCM, AAD gắn tenant + mục đích + phiên bản).
 *   Bản mã                    `e1.<phiên bản DEK>.<base64url(iv ‖ ciphertext ‖ tag)>`, AES-256-GCM, AAD = tenant + MIỀN dữ liệu
 *                             (phone / email / identifier): sao chép được giữa các bảng cùng miền (lịch hẹn → hồ sơ) mà không giải mã,
 *                             nhưng không ghép được sang tenant khác hay miền khác.
 *   Blind index               HMAC-SHA256(khoá 'index' của tenant, miền ‖ giá trị chuẩn hoá), 128 bit hex. Khoá index TÁCH khỏi khoá mã hoá:
 *                             lộ khoá index không giải mã được dữ liệu; lộ DEK không suy ra index. Dùng cho tìm kiếm bằng nhau / unique.
 *   Gợi ý (hint)              dạng che sẵn (091****678) để hiển thị danh sách mà không cần giải mã.
 *
 * Người chỉ có quyền đọc CSDL (DBA, bản sao lưu bị lộ, SQL injection) thấy bản mã + DEK đã bọc — không có KEK nên không giải mã được.
 * Giải mã chỉ diễn ra trong tiến trình ứng dụng; hiển thị bản rõ cho người dùng đi qua quyền `pii:reveal` + audit (PiiService).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { TenantScopedDb } from '../../domain/src/s0-contracts';

// ---------------------------------------------------------------------------
// KEK
// ---------------------------------------------------------------------------
export interface KeyProvider {
  /** KEK dùng để bọc khoá mới / bọc lại. */
  readonly activeKekId: string;
  /** Các KEK còn dùng được để mở (gồm KEK cũ trong lúc xoay). */
  kekIds(): readonly string[];
  wrap(key: Buffer, aad: string): { kekId: string; wrapped: Buffer };
  unwrap(kekId: string, wrapped: Buffer, aad: string): Buffer;
}

export class PiiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiiConfigError';
  }
}
export class PiiCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiiCryptoError';
  }
}

const KEK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function gcmSeal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}
function gcmOpen(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < 12 + 16) throw new PiiCryptoError('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(blob.subarray(blob.length - 16));
  try {
    return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
  } catch {
    throw new PiiCryptoError('authentication failed');
  }
}

/**
 * KEK cục bộ: `HCOS_KEKS="k2:<base64 32 byte>,k1:<base64 32 byte>"` — khoá ĐẦU TIÊN là khoá đang dùng.
 * Xoay KEK: thêm khoá mới lên đầu, khởi động lại, bấm "Bọc lại khoá" (rewrap), rồi mới bỏ khoá cũ khỏi danh sách.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKekId: string;

  constructor(entries: ReadonlyArray<readonly [string, Buffer]>) {
    if (entries.length === 0) throw new PiiConfigError('At least one KEK is required');
    const m = new Map<string, Buffer>();
    for (const [id, k] of entries) {
      if (!KEK_ID_RE.test(id)) throw new PiiConfigError(`Invalid KEK id '${id}'`);
      if (k.length !== 32) throw new PiiConfigError(`KEK '${id}' must be 32 bytes`);
      if (m.has(id)) throw new PiiConfigError(`Duplicate KEK id '${id}'`);
      m.set(id, Buffer.from(k));
    }
    this.keys = m;
    this.activeKekId = entries[0]![0];
  }

  static parse(spec: string): LocalKeyProvider {
    const entries = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(':');
        if (i < 1) throw new PiiConfigError('HCOS_KEKS must be "id:base64[,id:base64…]"');
        return [s.slice(0, i), Buffer.from(s.slice(i + 1), 'base64')] as const;
      });
    return new LocalKeyProvider(entries);
  }

  /** Chỉ cho test / devstack: KEK ngẫu nhiên trong bộ nhớ (mất khi tắt tiến trình). */
  static ephemeral(id = 'test'): LocalKeyProvider {
    return new LocalKeyProvider([[id, randomBytes(32)]]);
  }

  kekIds(): readonly string[] {
    return [...this.keys.keys()];
  }
  wrap(key: Buffer, aad: string): { kekId: string; wrapped: Buffer } {
    return { kekId: this.activeKekId, wrapped: gcmSeal(this.keys.get(this.activeKekId)!, key, aad) };
  }
  unwrap(kekId: string, wrapped: Buffer, aad: string): Buffer {
    const k = this.keys.get(kekId);
    if (!k) throw new PiiConfigError(`KEK '${kekId}' is not configured on this server`);
    return gcmOpen(k, wrapped, aad);
  }
}

let provider: KeyProvider | null = null;
export function configureKeyProvider(p: KeyProvider | null): void {
  if (provider) keyCaches.delete(provider);
  provider = p;
}
export function keyProvider(): KeyProvider {
  if (!provider) throw new PiiConfigError('Field encryption is not configured (HCOS_KEKS)');
  return provider;
}
export function hasKeyProvider(): boolean {
  return provider !== null;
}

// ---------------------------------------------------------------------------
// Chuẩn hoá + gợi ý che
// ---------------------------------------------------------------------------
export type PiiDomain = 'phone' | 'email' | 'identifier';

/** SĐT VN: bỏ khoảng trắng / dấu chấm / gạch; +84 / 84 => 0. Không hợp lệ => null. */
export function normalizePhoneVn(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[\s.\-()]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (/^84\d{9}$/.test(s)) s = '0' + s.slice(2);
  return /^0\d{9}$/.test(s) ? s : null;
}
export const normalizeForIndex = (domain: PiiDomain, v: string): string =>
  domain === 'phone' ? (normalizePhoneVn(v) ?? v.replace(/\s/g, '')) : domain === 'email' ? v.trim().toLowerCase() : v.replace(/\s/g, '').toUpperCase();

export function maskPhone(v: string): string {
  const s = v.replace(/\s/g, '');
  return s.length <= 6 ? '*'.repeat(s.length) : `${s.slice(0, 3)}${'*'.repeat(s.length - 6)}${s.slice(-3)}`;
}
export function maskEmail(v: string): string {
  const [local = '', domain = ''] = v.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
export function maskIdentifier(v: string): string {
  const s = v.replace(/\s/g, '');
  return s.length <= 4 ? '*'.repeat(s.length) : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}
export const maskFor = (domain: PiiDomain, v: string): string => (domain === 'phone' ? maskPhone(v) : domain === 'email' ? maskEmail(v) : maskIdentifier(v));

// ---------------------------------------------------------------------------
// Bản mã
// ---------------------------------------------------------------------------
const TOKEN_RE = /^e1\.(\d{1,6})\.([A-Za-z0-9_-]{38,})$/;
export const isSealed = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v);
export const tokenVersion = (t: string): number => {
  const m = TOKEN_RE.exec(t);
  if (!m) throw new PiiCryptoError('not a sealed value');
  return Number(m[1]);
};
const dataAad = (tenant: string, domain: PiiDomain) => `hcos-pii|${tenant}|${domain}`;
export const wrapAad = (tenant: string, purpose: KeyPurpose, version: number) => `hcos-dek|${tenant}|${purpose}|${version}`;

export function sealWith(key: Buffer, version: number, tenant: string, domain: PiiDomain, plain: string): string {
  return `e1.${version}.${gcmSeal(key, Buffer.from(plain, 'utf8'), dataAad(tenant, domain)).toString('base64url')}`;
}
export function openWith(key: Buffer, tenant: string, domain: PiiDomain, token: string): string {
  const m = TOKEN_RE.exec(token);
  if (!m) throw new PiiCryptoError('not a sealed value');
  return gcmOpen(key, Buffer.from(m[2]!, 'base64url'), dataAad(tenant, domain)).toString('utf8');
}
export function indexWith(key: Buffer, domain: PiiDomain, value: string): string {
  return createHmac('sha256', key).update(`${domain}\u0000${normalizeForIndex(domain, value)}`).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Khoá theo tenant (keyvault.tenant_keys)
// ---------------------------------------------------------------------------
export type KeyPurpose = 'data' | 'index';
export interface TenantKeyRow {
  readonly purpose: KeyPurpose;
  readonly version: number;
  readonly kekId: string;
  readonly status: 'active' | 'retired';
  readonly createdAt: string;
  readonly wrapped: Buffer;
}

/**
 * Khoá đã mở, cache trong bộ nhớ tiến trình theo (KeyProvider, tenant, mục đích, phiên bản, băm bản bọc).
 * Gắn với đúng đối tượng KeyProvider: provider khác (dù cùng nhãn KEK) phải tự mở lại — không dùng chung khoá đã mở.
 */
const keyCaches = new WeakMap<KeyProvider, Map<string, Buffer>>();
const cacheFor = (kp: KeyProvider): Map<string, Buffer> => {
  let m = keyCaches.get(kp);
  if (!m) keyCaches.set(kp, (m = new Map()));
  return m;
};
const cacheKey = (tenant: string, r: TenantKeyRow) => `${tenant}|${r.purpose}|${r.version}|${r.kekId}|${createHash('sha256').update(r.wrapped).digest('hex')}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toBuf = (v: unknown): Buffer => {
  if (Buffer.isBuffer(v)) return v;
  const s = String(v);
  return Buffer.from(s.startsWith('\\x') ? s.slice(2) : s, 'hex');
};
export async function loadTenantKeys(db: TenantScopedDb): Promise<TenantKeyRow[]> {
  const r = await db.query<any>(
    `SELECT purpose, version, kek_id, status, created_at, encode(wrapped_key, 'hex') AS wrapped
       FROM keyvault.tenant_keys WHERE tenant_id = $1 ORDER BY purpose, version`,
    [db.tenantId],
  );
  return r.rows.map((x: any) => ({
    purpose: x.purpose, version: Number(x.version), kekId: x.kek_id, status: x.status,
    createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at), wrapped: toBuf(x.wrapped),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Bộ mã hoá cho MỘT tenant trong MỘT transaction. Tạo khoá lần đầu khi cần (idempotent, chịu được hai tiến trình tạo cùng lúc).
 */
export class TenantPii {
  private rows: TenantKeyRow[] | null = null;

  constructor(private readonly db: TenantScopedDb, private readonly kp: KeyProvider = keyProvider()) {}

  get tenant(): string {
    return this.db.tenantId;
  }

  async seal(domain: PiiDomain, plain: string): Promise<string> {
    const { version, key } = await this.active('data');
    return sealWith(key, version, this.tenant, domain, plain);
  }
  async open(domain: PiiDomain, token: string): Promise<string> {
    return openWith(await this.keyFor('data', tokenVersion(token)), this.tenant, domain, token);
  }
  async index(domain: PiiDomain, value: string): Promise<string> {
    const { key } = await this.active('index');
    return indexWith(key, domain, value);
  }
  /** seal + index + hint trong một lần (giá trị null => cả ba null). */
  async protect(domain: PiiDomain, plain: string | null): Promise<{ enc: string | null; bidx: string | null; hint: string | null }> {
    if (plain === null || plain === '') return { enc: null, bidx: null, hint: null };
    return { enc: await this.seal(domain, plain), bidx: await this.index(domain, plain), hint: maskFor(domain, plain) };
  }

  async activeVersion(purpose: KeyPurpose): Promise<number> {
    return (await this.active(purpose)).version;
  }
  async keyFor(purpose: KeyPurpose, version: number): Promise<Buffer> {
    const row = (await this.load()).find((r) => r.purpose === purpose && r.version === version);
    if (!row) throw new PiiCryptoError(`${purpose} key v${version} not found for tenant`);
    return this.unwrap(row);
  }

  // ---- quản lý khoá ----------------------------------------------------------
  async listKeys(): Promise<TenantKeyRow[]> {
    this.rows = null;
    return this.load();
  }
  /** Tạo phiên bản mới cho mục đích, phiên bản cũ chuyển 'retired' (vẫn mở được bản mã cũ). */
  async rotate(purpose: KeyPurpose): Promise<number> {
    await this.active(purpose);
    await this.db.query(`SELECT 1 FROM keyvault.tenant_keys WHERE tenant_id = $1 AND purpose = $2 FOR UPDATE`, [this.tenant, purpose]);
    const r = await this.db.query<{ v: string | number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS v FROM keyvault.tenant_keys WHERE tenant_id = $1 AND purpose = $2`,
      [this.tenant, purpose],
    );
    const version = Number(r.rows[0]!.v);
    await this.db.query(`UPDATE keyvault.tenant_keys SET status = 'retired', retired_at = now() WHERE tenant_id = $1 AND purpose = $2 AND status = 'active'`, [this.tenant, purpose]);
    await this.insertKey(purpose, version);
    this.rows = null;
    return version;
  }
  /** Bọc lại mọi khoá của tenant bằng KEK đang dùng. Trả số khoá đã bọc lại. */
  async rewrapAll(): Promise<number> {
    let n = 0;
    for (const row of await this.listKeys()) {
      if (row.kekId === this.kp.activeKekId) continue;
      const plain = this.unwrap(row);
      const { kekId, wrapped } = this.kp.wrap(plain, wrapAad(this.tenant, row.purpose, row.version));
      await this.db.query(
        `UPDATE keyvault.tenant_keys SET kek_id = $4, wrapped_key = decode($5, 'hex'), rewrapped_at = now()
          WHERE tenant_id = $1 AND purpose = $2 AND version = $3`,
        [this.tenant, row.purpose, row.version, kekId, wrapped.toString('hex')],
      );
      n++;
    }
    this.rows = null;
    return n;
  }

  // ---- nội bộ -------------------------------------------------------------------
  private async load(): Promise<TenantKeyRow[]> {
    if (!this.rows) this.rows = await loadTenantKeys(this.db);
    return this.rows;
  }
  private unwrap(row: TenantKeyRow): Buffer {
    const ck = cacheKey(this.tenant, row);
    const keyCache = cacheFor(this.kp);
    let k = keyCache.get(ck);
    if (!k) {
      k = this.kp.unwrap(row.kekId, row.wrapped, wrapAad(this.tenant, row.purpose, row.version));
      if (k.length !== 32) throw new PiiCryptoError('unwrapped key has wrong length');
      keyCache.set(ck, k);
    }
    return k;
  }
  private async insertKey(purpose: KeyPurpose, version: number): Promise<void> {
    const plain = randomBytes(32);
    const { kekId, wrapped } = this.kp.wrap(plain, wrapAad(this.tenant, purpose, version));
    await this.db.query(
      `INSERT INTO keyvault.tenant_keys (tenant_id, purpose, version, kek_id, wrapped_key, status)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'), 'active') ON CONFLICT DO NOTHING`,
      [this.tenant, purpose, version, kekId, wrapped.toString('hex')],
    );
  }
  private async active(purpose: KeyPurpose): Promise<{ version: number; key: Buffer }> {
    let row = (await this.load()).find((r) => r.purpose === purpose && r.status === 'active');
    if (!row) {
      await this.insertKey(purpose, 1);
      this.rows = null;
      row = (await this.load()).find((r) => r.purpose === purpose && r.status === 'active');
      if (!row) throw new PiiCryptoError(`could not create ${purpose} key`);
    }
    return { version: row.version, key: this.unwrap(row) };
  }
}

/** So sánh hằng thời gian cho blind index (tránh lộ qua thời gian so sánh). */
export function sameIndex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
