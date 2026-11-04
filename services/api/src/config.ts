/**
 * HCOS-P0-ENG-001 | Cấu hình từ biến môi trường. Thuần, fail-fast: thiếu/sai => ném lỗi liệt kê MỌI vấn đề, không mặc định ngầm
 * cho các giá trị liên quan bảo mật (issuer, audience, JWKS, DB).
 *
 *   HCOS_DATABASE_URL   postgres://<login-role>:<pw>@host:5432/db  (TCP; URL dạng unix-socket không được hỗ trợ). Login-role phải là thành viên hcos_app,
 *                       KHÔNG superuser/BYPASSRLS (main.ts kiểm tra lúc khởi động và từ chối nếu vi phạm)
 *   HCOS_JWT_ISSUER     vd https://idp.example.vn/        (nhiều giá trị: phân tách bằng dấu phẩy)
 *   HCOS_JWT_AUDIENCE   vd hcos-api
 *   HCOS_JWKS_URL       https://idp.example.vn/.well-known/jwks.json (bắt buộc https, trừ localhost)
 *   HCOS_PORT           mặc định 8080
 *   HCOS_MAX_BODY_BYTES mặc định 1048576
 *   HCOS_DB_POOL_MAX    mặc định 10
 *   HCOS_READY_TIMEOUT_MS  timeout của /readyz, mặc định 2000
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly issuer: string[];
  readonly audience: string[];
  readonly jwksUrl: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly dbPoolMax: number;
  readonly readyTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const problems: string[] = [];
  const req = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) problems.push(`${k} is required`);
    return v ?? '';
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const raw = env[k]?.trim();
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${k} must be an integer in [${min}, ${max}]`);
      return def;
    }
    return n;
  };

  const databaseUrl = req('HCOS_DATABASE_URL');
  if (databaseUrl) {
    let u: URL | undefined;
    try { u = new URL(databaseUrl); } catch { problems.push('HCOS_DATABASE_URL is not a valid URL'); }
    if (u) {
      if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push('HCOS_DATABASE_URL must be a postgres:// URL');
      if (['postgres', 'hcos_provisioner'].includes(decodeURIComponent(u.username))) {
        problems.push('HCOS_DATABASE_URL must use the restricted hcos_app role, not a superuser/provisioner');
      }
    }
  }

  const issuer = list(req('HCOS_JWT_ISSUER'));
  const audience = list(req('HCOS_JWT_AUDIENCE'));

  const jwksUrl = req('HCOS_JWKS_URL');
  if (jwksUrl) {
    try {
      const u = new URL(jwksUrl);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) problems.push('HCOS_JWKS_URL must be https');
    } catch {
      problems.push('HCOS_JWKS_URL is not a valid URL');
    }
  }

  const cfg: AppConfig = {
    databaseUrl,
    issuer,
    audience,
    jwksUrl,
    port: int('HCOS_PORT', 8080, 1, 65535),
    maxBodyBytes: int('HCOS_MAX_BODY_BYTES', 1_048_576, 1024, 50 * 1_048_576),
    dbPoolMax: int('HCOS_DB_POOL_MAX', 10, 1, 200),
    readyTimeoutMs: int('HCOS_READY_TIMEOUT_MS', 2000, 100, 30_000),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
