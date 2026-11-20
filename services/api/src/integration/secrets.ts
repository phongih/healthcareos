/**
 * HCOS-F12 | Mã hoá URL / bí mật tích hợp khi lưu (AES-256-GCM). Khoá nằm ngoài CSDL (HCOS_INTEGRATION_KEY).
 * AAD gắn bản mã với đúng tenant + kết nối + loại trường: chép bản mã sang dòng khác => giải mã thất bại.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }
  seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  }
  open(sealed: string, aad: string): string {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown secret format');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    if (raw.length < 29) throw new Error('Secret too short');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
}

export const aadOf = (tenantId: string, endpointId: string, field: 'url' | 'secret'): string => `${tenantId}:${endpointId}:${field}`;
