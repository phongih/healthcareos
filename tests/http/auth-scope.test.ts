/**
 * HTTP: thiếu MFA => 401 + WWW-Authenticate insufficient_user_authentication (RFC 9470) + lý do AUTH_MFA_REQUIRED;
 * tài khoản chưa được cấp => 403 USER_NOT_PROVISIONED; không gọi tới handler nào.
 */
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOrganizationId, asTenantId, asUserId } from '../../packages/domain/src/s0-contracts';
import type { ClinicalApi } from '../../services/api/src/http/clinical-routes';
import { createApiServer } from '../../services/api/src/http/server';

const T = asTenantId('00000000-0000-4000-8000-000000000001');
const O = asOrganizationId('00000000-0000-4000-8000-000000000011');
const ISS = 'https://idp.test/realms/hcos';
let priv: KeyLike;
let base: string;
let server: ReturnType<typeof createApiServer>;
let lookups = 0;

const token = (sub: string, amr?: string[]) =>
  new SignJWT(amr ? { amr } : {}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuer(ISS).setAudience('hcos-api').setIssuedAt().setExpirationTime('5m').sign(priv);

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  priv = kp.privateKey;
  server = createApiServer({
    tenant: {
      issuer: ISS, audience: 'hcos-api', key: kp.publicKey, algorithms: ['RS256'], requireAmr: ['otp'],
      orgScope: {
        tenantsFor: async (sub) => { lookups++; return sub === 'ghost' ? [] : [T]; },
        scopeFor: async (_t, sub) => (sub === 'no-membership' ? null : { userId: asUserId('00000000-0000-4000-8000-000000000101'), organizationIds: [O] }),
      },
    },
    clinical: {} as ClinicalApi,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function get(auth: string) {
  const r = await fetch(`${base}/api/me`, { headers: { authorization: auth } });
  const j = await r.json() as { issue?: Array<{ details?: { text?: string } }> };
  return { status: r.status, reason: j.issue?.[0]?.details?.text, www: r.headers.get('www-authenticate') };
}

describe('HTTP: MFA + phạm vi theo tài khoản', () => {
  it('thiếu otp => 401 AUTH_MFA_REQUIRED, header RFC 9470', async () => {
    expect(await get(`Bearer ${await token('kc-doc', ['pwd'])}`)).toEqual({
      status: 401, reason: 'AUTH_MFA_REQUIRED', www: 'Bearer error="insufficient_user_authentication", error_description="MFA required"',
    });
    expect((await get(`Bearer ${await token('kc-doc')}`)).reason).toBe('AUTH_MFA_REQUIRED');
  });

  it('chưa được cấp => 403 USER_NOT_PROVISIONED', async () => {
    expect(await get(`Bearer ${await token('ghost', ['otp'])}`)).toMatchObject({ status: 403, reason: 'USER_NOT_PROVISIONED' });
    expect(await get(`Bearer ${await token('no-membership', ['otp'])}`)).toMatchObject({ status: 403, reason: 'USER_NOT_PROVISIONED' });
    expect(lookups).toBeGreaterThan(0);
  });
});
