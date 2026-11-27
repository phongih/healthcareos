/**
 * Client Keycloak Admin REST API cho quản trị nhân sự (F21).
 * - Xác thực bằng client_credentials của một client riêng (vd. `hcos-admin-api`) có service account
 *   chỉ mang quyền realm-management: manage-users, view-users, query-users — KHÔNG dùng tài khoản admin master.
 * - Chỉ thao tác trong realm cấu hình (mặc định `hcos`). Không bao giờ log mật khẩu / token.
 */
export interface KeycloakAdminConfig {
  readonly baseUrl: string;       // vd. http://127.0.0.1:8081/auth
  readonly realm: string;         // hcos
  readonly clientId: string;
  readonly clientSecret: string;
}
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export interface IdpUser { readonly id: string; readonly username: string; readonly enabled: boolean; readonly firstName?: string; readonly lastName?: string; readonly email?: string; readonly requiredActions?: string[] }

/** Cổng IdP mà service nhân sự cần (thay được bằng bản giả trong test). */
export interface IdentityProviderAdmin {
  findByUsername(username: string): Promise<IdpUser | null>;
  getUser(id: string): Promise<IdpUser | null>;
  /** Tạo user, mật khẩu tạm + bắt đổi mật khẩu và cài OTP ở lần đăng nhập đầu. Trả id (= sub). */
  createUser(input: { username: string; firstName: string; lastName: string; email: string | null; temporaryPassword: string }): Promise<string>;
  /** Đăng ký khách: mật khẩu do chính người dùng đặt (không tạm thời), chỉ bắt cài OTP ở lần đăng nhập đầu. Trả sub. */
  createSelfUser(input: { username: string; firstName: string; email: string; password: string }): Promise<string>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Đăng xuất mọi phiên của user (token đã cấp vẫn sống tới hạn — tối đa 15 phút). */
  logout(id: string): Promise<void>;
  /** Mật khẩu tạm mới + xoá OTP cũ + bắt cài lại OTP. */
  resetCredentials(id: string, temporaryPassword: string): Promise<void>;
}

export class IdpError extends Error {
  constructor(readonly reason: 'IDP_NOT_CONFIGURED' | 'IDP_UNAVAILABLE' | 'IDP_CONFLICT' | 'IDP_REJECTED', message: string) {
    super(message);
    this.name = 'IdpError';
  }
}

export const NOT_CONFIGURED: IdentityProviderAdmin = new Proxy({} as IdentityProviderAdmin, {
  get: () => async () => { throw new IdpError('IDP_NOT_CONFIGURED', 'Keycloak admin client is not configured'); },
});

export class KeycloakAdminClient implements IdentityProviderAdmin {
  private token: { value: string; until: number } | null = null;
  constructor(private readonly cfg: KeycloakAdminConfig, private readonly fetchFn: Fetch = fetch as unknown as Fetch, private readonly timeoutMs = 8000) {}

  private get admin(): string {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/admin/realms/${encodeURIComponent(this.cfg.realm)}`;
  }

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<{ status: number; text: string; location: string | null }> {
    const token = await this.accessToken();
    let r;
    try {
      r = await this.fetchFn(`${this.admin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new IdpError('IDP_UNAVAILABLE', 'Keycloak is not reachable');
    }
    if (r.status === 401 && !retried) {
      this.token = null;
      return this.call(method, path, body, true);
    }
    const text = await r.text();
    if (r.status === 409) throw new IdpError('IDP_CONFLICT', 'Username or email already exists in Keycloak');
    if (r.status >= 500) throw new IdpError('IDP_UNAVAILABLE', `Keycloak error ${r.status}`);
    if (!r.ok && r.status !== 404) throw new IdpError('IDP_REJECTED', `Keycloak rejected the request (${r.status})`);
    return { status: r.status, text, location: r.headers.get('location') };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 10_000) return this.token.value;
    let r;
    try {
      r = await this.fetchFn(`${this.cfg.baseUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(this.cfg.realm)}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new IdpError('IDP_UNAVAILABLE', 'Keycloak is not reachable');
    }
    if (!r.ok) throw new IdpError(r.status >= 500 ? 'IDP_UNAVAILABLE' : 'IDP_REJECTED', `Keycloak token request failed (${r.status})`);
    const j = JSON.parse(await r.text()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new IdpError('IDP_REJECTED', 'Keycloak returned no token');
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 60) * 1000 };
    return j.access_token;
  }

  async findByUsername(username: string): Promise<IdpUser | null> {
    const r = await this.call('GET', `/users?exact=true&briefRepresentation=false&username=${encodeURIComponent(username)}`);
    const list = (r.text ? JSON.parse(r.text) : []) as IdpUser[];
    return list.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
  }

  async getUser(id: string): Promise<IdpUser | null> {
    const r = await this.call('GET', `/users/${encodeURIComponent(id)}`);
    return r.status === 404 ? null : (JSON.parse(r.text) as IdpUser);
  }

  async createUser(input: { username: string; firstName: string; lastName: string; email: string | null; temporaryPassword: string }): Promise<string> {
    const r = await this.call('POST', '/users', {
      username: input.username, firstName: input.firstName, lastName: input.lastName, enabled: true,
      ...(input.email ? { email: input.email, emailVerified: true } : {}),
      requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'],
      credentials: [{ type: 'password', value: input.temporaryPassword, temporary: true }],
    });
    const id = r.location?.split('/').pop();
    if (r.status !== 201 || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new IdpError('IDP_REJECTED', 'Keycloak did not return the new user id');
    return id;
  }

  async createSelfUser(input: { username: string; firstName: string; email: string; password: string }): Promise<string> {
    const r = await this.call('POST', '/users', {
      username: input.username, firstName: input.firstName, lastName: '', enabled: true,
      email: input.email, emailVerified: true,
      requiredActions: ['CONFIGURE_TOTP'],
      credentials: [{ type: 'password', value: input.password, temporary: false }],
    });
    if (r.status === 409) throw new IdpError('IDP_CONFLICT', 'Username already exists');
    const id = r.location?.split('/').pop();
    if (r.status !== 201 || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new IdpError('IDP_REJECTED', 'Keycloak did not return the new user id');
    return id;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const u = await this.getUser(id);
    if (!u) throw new IdpError('IDP_REJECTED', 'User not found in Keycloak');
    await this.call('PUT', `/users/${encodeURIComponent(id)}`, { ...u, enabled });
  }

  async logout(id: string): Promise<void> {
    await this.call('POST', `/users/${encodeURIComponent(id)}/logout`);
  }

  async resetCredentials(id: string, temporaryPassword: string): Promise<void> {
    await this.call('PUT', `/users/${encodeURIComponent(id)}/reset-password`, { type: 'password', value: temporaryPassword, temporary: true });
    const creds = JSON.parse((await this.call('GET', `/users/${encodeURIComponent(id)}/credentials`)).text || '[]') as Array<{ id: string; type: string }>;
    for (const c of creds) if (c.type === 'otp') await this.call('DELETE', `/users/${encodeURIComponent(id)}/credentials/${encodeURIComponent(c.id)}`);
    const u = await this.getUser(id);
    if (u) await this.call('PUT', `/users/${encodeURIComponent(id)}`, { ...u, requiredActions: [...new Set([...(u.requiredActions ?? []), 'CONFIGURE_TOTP', 'UPDATE_PASSWORD'])] });
    await this.logout(id);
  }
}

/** Mật khẩu tạm dễ đọc qua điện thoại: 4 nhóm × 4 ký tự (không có 0/O/1/l/I), ~78 bit. */
export function temporaryPassword(rand: (n: number) => Uint8Array): string {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out: string[] = [];
  while (out.length < 16) {
    for (const b of rand(32)) {
      if (b < 256 - (256 % A.length) && out.length < 16) out.push(A[b % A.length]!);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8, 12).join('')}-${out.slice(12).join('')}`;
}
