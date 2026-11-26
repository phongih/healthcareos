/**
 * Đăng nhập OIDC Authorization Code + PKCE (S256) với Keycloak, cùng origin (Caddy chuyển /auth/* tới Keycloak).
 *
 * - Token CHỈ giữ trong bộ nhớ (không localStorage/sessionStorage) để giảm hậu quả nếu có XSS.
 *   Tải lại trang => chuyển sang Keycloak; nếu phiên SSO còn thì quay lại ngay, không phải nhập lại.
 * - sessionStorage chỉ giữ verifier + state trong lúc chuyển hướng (xoá ngay khi đổi code lấy token).
 * - Làm mới token bằng refresh_token trước khi hết hạn; thất bại => đăng nhập lại.
 */
const OIDC = '/auth/realms/hcos/protocol/openid-connect';
const CLIENT_ID = 'hcos-web';
const PKCE_KEY = 'hcos.pkce';

const redirectUri = (): string => `${location.origin}/app/callback`;

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number; // ms epoch
}

let tokens: Tokens | null = null;
let refreshing: Promise<Tokens | null> | null = null;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(n: number): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function challengeFor(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

export interface Claims {
  readonly sub: string;
  readonly tenant_id?: string;
  readonly org_ids?: string[];
  readonly preferred_username?: string;
  readonly name?: string;
  readonly exp: number;
}

export function claims(): Claims | null {
  if (!tokens) return null;
  const p = tokens.accessToken.split('.')[1];
  if (!p) return null;
  const json = atob(p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Claims;
}

/** reauth: bắt IdP hỏi lại thông tin đăng nhập + OTP (không dùng lại phiên SSO cũ) — dùng khi API báo thiếu MFA. */
export async function login(opts: { reauth?: boolean } = {}): Promise<never> {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, returnTo: location.hash || '#/' }));
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri(),
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    ...(opts.reauth ? { prompt: 'login', max_age: '0' } : {}),
  });
  location.assign(`${OIDC}/auth?${q.toString()}`);
  return new Promise<never>(() => {});
}

function store(r: { access_token: string; refresh_token?: string; id_token?: string; expires_in: number }): Tokens {
  tokens = {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    idToken: r.id_token ?? tokens?.idToken ?? null,
    expiresAt: Date.now() + r.expires_in * 1000,
  };
  return tokens;
}

async function tokenRequest(body: URLSearchParams): Promise<Tokens> {
  const res = await fetch(`${OIDC}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`Đổi token thất bại (${res.status})`);
  return store(await res.json());
}

/** Gọi khi tải trang. true = đã có token; false = cần đăng nhập. Ném lỗi nếu callback không hợp lệ. */
export async function initAuth(): Promise<boolean> {
  if (location.pathname.endsWith('/callback')) {
    const q = new URLSearchParams(location.search);
    const saved = sessionStorage.getItem(PKCE_KEY);
    sessionStorage.removeItem(PKCE_KEY);
    const pkce = saved ? (JSON.parse(saved) as { verifier: string; state: string; returnTo: string }) : null;
    if (q.get('error')) throw new Error(`Đăng nhập bị từ chối: ${q.get('error_description') ?? q.get('error')}`);
    const code = q.get('code');
    if (!pkce || !code || q.get('state') !== pkce.state) {
      history.replaceState(null, '', '/app/');
      throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.');
    }
    await tokenRequest(
      new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: redirectUri(), code_verifier: pkce.verifier }),
    );
    history.replaceState(null, '', `/app/${pkce.returnTo}`);
    return true;
  }
  return tokens !== null;
}

/** Access token còn hạn (tự làm mới khi còn < 30 giây). null = phải đăng nhập lại. */
export async function accessToken(): Promise<string | null> {
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 30_000) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  refreshing ??= tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tokens.refreshToken }))
    .catch(() => {
      tokens = null;
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  const t = await refreshing;
  return t?.accessToken ?? null;
}

export function logout(): void {
  const idToken = tokens?.idToken;
  tokens = null;
  const q = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: `${location.origin}/app/` });
  if (idToken) q.set('id_token_hint', idToken);
  location.assign(`${OIDC}/logout?${q.toString()}`);
}
