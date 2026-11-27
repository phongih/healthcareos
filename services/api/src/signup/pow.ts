/**
 * HCOS | CAPTCHA tự xây (proof-of-work) cho đăng ký khách. Không gọi dịch vụ ngoài.
 *
 *  - Máy chủ cấp thử thách: { token, bits, expiresAt }. token = base64url(JSON{id, exp}) + "." + HMAC-SHA256(khoá tiến trình).
 *  - Trình duyệt tìm nonce sao cho SHA-256(token + ":" + nonce) có ít nhất `bits` bit 0 đứng đầu.
 *  - Máy chủ kiểm tra chữ ký, hạn, lời giải, rồi đánh dấu id đã dùng (mỗi thử thách một lần).
 *
 * Khoá ngẫu nhiên mỗi lần khởi động: khởi động lại làm mất thử thách đang mở (khách tải lại là được).
 * Trạng thái "đã dùng" nằm trong bộ nhớ của một tiến trình; nhiều bản API cần lưu chung ở DB.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const POW_BITS = 17;
export const POW_TTL_MS = 5 * 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface PowChallenge {
  readonly token: string;
  readonly bits: number;
  readonly expiresAt: Date;
}

/** Số bit 0 đứng đầu của một digest. */
export function leadingZeroBits(digest: Uint8Array): number {
  let n = 0;
  for (const b of digest) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export class ProofOfWork {
  private readonly key = randomBytes(32);
  /** id => hạn; xoá khi hết hạn. */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly bits: number = POW_BITS,
  ) {}

  issue(): PowChallenge {
    const exp = this.now() + POW_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ id: randomBytes(16).toString('base64url'), exp })).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, bits: this.bits, expiresAt: new Date(exp) };
  }

  /** true chỉ khi thử thách còn hạn, chữ ký đúng, lời giải đạt độ khó, và chưa dùng. Dùng xong thì đánh dấu. */
  verify(token: string, nonce: string): boolean {
    this.prune();
    if (typeof token !== 'string' || typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return false;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.sign(payload);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

    let claim: { id?: unknown; exp?: unknown };
    try {
      claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { id?: unknown; exp?: unknown };
    } catch {
      return false;
    }
    if (typeof claim.id !== 'string' || typeof claim.exp !== 'number' || claim.exp <= this.now()) return false;
    if (this.used.has(claim.id)) return false;

    const digest = createHash('sha256').update(`${token}:${nonce}`).digest();
    if (leadingZeroBits(digest) < this.bits) return false;

    this.used.set(claim.id, claim.exp);
    return true;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  private prune(): void {
    const t = this.now();
    for (const [id, exp] of this.used) if (exp <= t) this.used.delete(id);
  }
}

/** Dùng trong test và công cụ: tìm nonce hợp lệ cho một thử thách. */
export function solvePow(token: string, bits: number): string {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (leadingZeroBits(createHash('sha256').update(`${token}:${nonce}`).digest()) >= bits) return nonce;
  }
}
