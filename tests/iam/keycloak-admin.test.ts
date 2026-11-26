/** Client Keycloak Admin (fetch giả): client_credentials + cache token, lấy id từ Location, 409 => IDP_CONFLICT, đặt lại xoá OTP. */
import { describe, expect, it } from 'vitest';

import { IdpError, KeycloakAdminClient, type Fetch } from '../../services/api/src/iam/keycloak-admin';

type Call = { method: string; url: string; body?: string };
function fake(handler: (c: Call) => { status: number; body?: unknown; location?: string }) {
  const calls: Call[] = [];
  const f: Fetch = async (url, init) => {
    const c = { method: init?.method ?? 'GET', url, body: init?.body };
    calls.push(c);
    const r = handler(c);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (n: string) => (n === 'location' ? r.location ?? null : null) }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { f, calls };
}
const CFG = { baseUrl: 'http://kc:8081/auth/', realm: 'hcos', clientId: 'hcos-admin-api', clientSecret: 's'.repeat(32) };
const ID = '11111111-2222-4333-8444-555555555555';

describe('KeycloakAdminClient', () => {
  it('tạo user: token client_credentials (cache), body đúng, id từ Location', async () => {
    const { f, calls } = fake((c) => {
      if (c.url.endsWith('/token')) return { status: 200, body: { access_token: 'tok', expires_in: 300 } };
      if (c.method === 'GET') return { status: 200, body: [] };
      return { status: 201, location: `http://kc:8081/auth/admin/realms/hcos/users/${ID}` };
    });
    const k = new KeycloakAdminClient(CFG, f);
    expect(await k.findByUsername('a.b')).toBeNull();
    expect(await k.createUser({ username: 'a.b', firstName: 'B', lastName: 'A', email: null, temporaryPassword: 'Abcd-Efgh-Jkmn-Pqrs' })).toBe(ID);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/admin/realms/hcos/users'))!;
    expect(JSON.parse(create.body!)).toMatchObject({ username: 'a.b', enabled: true, requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'], credentials: [{ type: 'password', temporary: true }] });
    expect(calls[1]!.url).toBe('http://kc:8081/auth/admin/realms/hcos/users?exact=true&briefRepresentation=false&username=a.b');
  });

  it('409 => IDP_CONFLICT; không kết nối => IDP_UNAVAILABLE; 401 => lấy token mới và thử lại 1 lần', async () => {
    let n = 0;
    const { f } = fake((c) => (c.url.endsWith('/token') ? { status: 200, body: { access_token: `t${++n}`, expires_in: 300 } } : { status: 409 }));
    await expect(new KeycloakAdminClient(CFG, f).createUser({ username: 'x', firstName: 'x', lastName: 'x', email: null, temporaryPassword: 'p' })).rejects.toMatchObject({ reason: 'IDP_CONFLICT' });
    const down: Fetch = async () => { throw new Error('ECONNREFUSED'); };
    await expect(new KeycloakAdminClient(CFG, down).getUser(ID)).rejects.toBeInstanceOf(IdpError);
    let first = true;
    const r = fake((c) => {
      if (c.url.endsWith('/token')) return { status: 200, body: { access_token: 'tok', expires_in: 300 } };
      if (first) { first = false; return { status: 401 }; }
      return { status: 200, body: { id: ID, username: 'a', enabled: true } };
    });
    expect((await new KeycloakAdminClient(CFG, r.f).getUser(ID))?.username).toBe('a');
    expect(r.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
  });

  it('đặt lại: mật khẩu tạm, xoá credential OTP, bắt cài lại OTP, đăng xuất', async () => {
    const { f, calls } = fake((c) => {
      if (c.url.endsWith('/token')) return { status: 200, body: { access_token: 'tok', expires_in: 300 } };
      if (c.method === 'GET' && c.url.endsWith('/credentials')) return { status: 200, body: [{ id: 'p1', type: 'password' }, { id: 'o1', type: 'otp' }] };
      if (c.method === 'GET') return { status: 200, body: { id: ID, username: 'a', enabled: true, requiredActions: [] } };
      return { status: 204 };
    });
    await new KeycloakAdminClient(CFG, f).resetCredentials(ID, 'Abcd-Efgh-Jkmn-Pqrs');
    const seq = calls.filter((c) => !c.url.endsWith('/token')).map((c) => `${c.method} ${c.url.replace(/^.*\/users\//, '')}`);
    expect(seq).toEqual([`PUT ${ID}/reset-password`, `GET ${ID}/credentials`, `DELETE ${ID}/credentials/o1`, `GET ${ID}`, `PUT ${ID}`, `POST ${ID}/logout`]);
    expect(JSON.parse(calls.find((c) => c.method === 'PUT' && c.url.endsWith(ID))!.body!).requiredActions).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
  });
});
