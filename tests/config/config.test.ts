/** HCOS-P0-ENG-001 | Cấu hình: fail-fast, không mặc định ngầm cho giá trị bảo mật. */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../services/api/src/config';

const OK = {
  HCOS_DATABASE_URL: 'postgres://hcos_app:secret@db.internal:5432/hcos',
  HCOS_JWT_ISSUER: 'https://idp.example.vn/',
  HCOS_JWT_AUDIENCE: 'hcos-api',
  HCOS_JWKS_URL: 'https://idp.example.vn/.well-known/jwks.json',
};
const problems = (env: Record<string, string | undefined>): string[] => {
  try { loadConfig(env); } catch (e) { if (e instanceof ConfigError) return [...e.problems]; throw e; }
  return [];
};

describe('loadConfig', () => {
  it('loads a valid environment with defaults', () => {
    const c = loadConfig(OK);
    expect(c.port).toBe(8080);
    expect(c.maxBodyBytes).toBe(1_048_576);
    expect(c.dbPoolMax).toBe(10);
    expect(c.readyTimeoutMs).toBe(2000);
    expect(c.issuer).toEqual(['https://idp.example.vn/']);
  });

  it('splits multiple issuers/audiences and honours overrides', () => {
    const c = loadConfig({ ...OK, HCOS_JWT_ISSUER: 'https://a/, https://b/', HCOS_JWT_AUDIENCE: 'x,y', HCOS_PORT: '9000', HCOS_DB_POOL_MAX: '25' });
    expect(c.issuer).toEqual(['https://a/', 'https://b/']);
    expect(c.audience).toEqual(['x', 'y']);
    expect(c.port).toBe(9000);
    expect(c.dbPoolMax).toBe(25);
  });

  it('reports ALL missing security settings at once (no silent defaults)', () => {
    const p = problems({});
    expect(p).toHaveLength(4);
    expect(p.some((x) => x.startsWith('HCOS_JWT_ISSUER'))).toBe(true);
  });

  it('refuses superuser/provisioner database roles', () => {
    expect(problems({ ...OK, HCOS_DATABASE_URL: 'postgres://postgres:x@h/db' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_DATABASE_URL: 'postgres://hcos_provisioner:x@h/db' })).toHaveLength(1);
  });

  it('rejects non-postgres URLs and non-https JWKS (except localhost)', () => {
    expect(problems({ ...OK, HCOS_DATABASE_URL: 'mysql://hcos_app@h/db' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_JWKS_URL: 'http://idp.example.vn/jwks' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_JWKS_URL: 'http://localhost:9000/jwks' })).toHaveLength(0);
  });

  it('HCOS_HOST: optional IP literal; hostnames and garbage are rejected', () => {
    expect(loadConfig(OK).host).toBeUndefined();
    expect(loadConfig({ ...OK, HCOS_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
    expect(loadConfig({ ...OK, HCOS_HOST: '::1' }).host).toBe('::1');
    expect(loadConfig({ ...OK, HCOS_HOST: '  ' }).host).toBeUndefined();
    expect(problems({ ...OK, HCOS_HOST: 'localhost' })).toEqual(['HCOS_HOST must be an IPv4 or IPv6 address']);
    expect(problems({ ...OK, HCOS_HOST: '0.0.0.0/0' })).toHaveLength(1);
  });

  it('rejects bad numbers and never echoes secrets in the error', () => {
    expect(problems({ ...OK, HCOS_PORT: '70000' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_PORT: 'abc' })).toHaveLength(1);
    expect(problems({ ...OK, HCOS_READY_TIMEOUT_MS: '5' })).toHaveLength(1);
    try {
      loadConfig({ ...OK, HCOS_DATABASE_URL: 'postgres://postgres:topsecret@h/db' });
    } catch (e) {
      expect(String((e as Error).message).includes('topsecret')).toBe(false);
    }
  });
});
