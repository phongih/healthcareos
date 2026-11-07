/**
 * HCOS-S0-R1 | Runtime: khởi động tiến trình `main.ts` thật (child process) với PostgreSQL thật.
 *
 * Kiểm: lỗi cấu hình => thoát 1 và không lộ bí mật; role superuser bị từ chối; /healthz & /readyz; /readyz = 503 khi DB biến mất
 * trong khi /healthz vẫn 200; SIGTERM/SIGINT tắt êm (exit 0); log không chứa mật khẩu.
 *
 * Chạy: HCOS_IT=1 PGHOST=… PGPORT=… PGUSER=<superuser> [PGPASSWORD=…] vitest run tests/integration
 * Cần lệnh `tsx` trong PATH (npm run đã thêm node_modules/.bin). Tự tạo 2 DB + 2 role đăng nhập tạm, dọn khi xong.
 * Dữ liệu: chỉ fixture tổng hợp (không có dữ liệu bệnh nhân).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env['HCOS_IT'] === '1';
const MAIN = fileURLToPath(new URL('../../services/api/src/main.ts', import.meta.url));
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const SFX = String(process.pid);
const DB1 = `hcos_rt1_${SFX}`;
const DB2 = `hcos_rt2_${SFX}`;
const APP_ROLE = `hcos_api_${SFX}`; // đăng nhập, thành viên hcos_app, KHÔNG superuser
const SU_ROLE = `hcos_su_${SFX}`; // đăng nhập, superuser (phải bị từ chối)
const APP_PW = `pw-app-${SFX}-Zq9`;
const SU_PW = `pw-su-${SFX}-Zq9`;

const psql = (db: string, args: string[]) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], { encoding: 'utf8' });
const sql = (q: string, db = 'postgres') => psql(db, ['-c', q]);

function dbUrl(user: string, pw: string, db: string): string {
  const host = process.env['PGHOST'] ?? 'localhost';
  const port = process.env['PGPORT'] ?? '5432';
  return host.startsWith('/')
    ? `postgres://${user}:${pw}@/${db}?host=${encodeURIComponent(host)}&port=${port}`
    : `postgres://${user}:${pw}@${host}:${port}/${db}`;
}

const freePort = (n: number) => 21000 + ((Number(SFX) + n * 97) % 20000);
const baseEnv = (url: string, port: number): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HCOS_DATABASE_URL: url,
  HCOS_JWT_ISSUER: 'https://idp.hcos.test/',
  HCOS_JWT_AUDIENCE: 'hcos-api',
  HCOS_JWKS_URL: 'http://127.0.0.1:9/jwks', // không dùng trong test này (không xác thực JWT thật)
  HCOS_PORT: String(port),
  HCOS_READY_TIMEOUT_MS: '1500',
});

interface Proc { child: ChildProcess; out: () => string; exited: Promise<{ code: number | null; signal: string | null }> }
function launch(env: Record<string, string>): Proc {
  const child = spawn('tsx', [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => { buf += d; });
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { buf += d; });
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => child.on('exit', (code: number | null, signal: string | null) => res({ code, signal })));
  return { child, out: () => buf, exited };
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

const get = async (port: number, path: string, host = '127.0.0.1') => {
  const r = await fetch(`http://${host}:${port}${path}`);
  return { status: r.status as number, text: await r.text() };
};

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;
const live: Proc[] = [];

run('Runtime: main.ts + PostgreSQL', () => {
  beforeAll(() => {
    for (const db of [DB1, DB2]) {
      sql(`CREATE DATABASE ${db}`);
      for (const f of ['001_s0_init.sql', '002_s1_clinical_init.sql', '003_person_registry.sql']) psql(db, ['-f', `${MIG}/${f}`]);
      sql(`GRANT CONNECT ON DATABASE ${db} TO PUBLIC`);
    }
    sql(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}' IN ROLE hcos_app`);
    sql(`CREATE ROLE ${SU_ROLE} LOGIN SUPERUSER PASSWORD '${SU_PW}'`);
  });

  afterAll(() => {
    for (const p of live) { try { p.child.kill('SIGKILL'); } catch { /* already gone */ } }
    for (const db of [DB1, DB2]) { try { sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch { /* best effort */ } }
    for (const r of [APP_ROLE, SU_ROLE]) { try { sql(`DROP ROLE IF EXISTS ${r}`); } catch { /* best effort */ } }
  });

  it('invalid configuration exits 1, lists the problems and never prints secrets', async () => {
    const p = launch({ PATH: process.env['PATH'] ?? '', HCOS_DATABASE_URL: `postgres://postgres:TOPSECRET-${SFX}@h/db`, HCOS_PORT: '99999' });
    live.push(p);
    const r = await withTimeout(p.exited, 30_000, 'exit');
    expect(r.code).toBe(1);
    const out = p.out();
    expect(out.includes('HCOS_JWT_ISSUER is required')).toBe(true);
    expect(out.includes('HCOS_PORT')).toBe(true);
    expect(out.includes(`TOPSECRET-${SFX}`)).toBe(false);
    expect(out.includes('listening')).toBe(false);
  });

  it('refuses to start when the database role is a superuser (RLS would be bypassed)', async () => {
    const p = launch(baseEnv(dbUrl(SU_ROLE, SU_PW, DB1), freePort(0)));
    live.push(p);
    const r = await withTimeout(p.exited, 30_000, 'exit');
    expect(r.code).toBe(1);
    const out = p.out();
    expect(out.includes('UnsafeDatabaseRoleError')).toBe(true);
    expect(out.includes('listening')).toBe(false);
    expect(out.includes(SU_PW)).toBe(false);
  });

  it('boots with the restricted role; /healthz and /readyz are 200; SIGINT shuts down gracefully (exit 0)', async () => {
    const port = freePort(1);
    const p = launch(baseEnv(dbUrl(APP_ROLE, APP_PW, DB1), port));
    live.push(p);
    await waitFor(() => p.out().includes('hcos-api listening'), 30_000, 'startup');
    expect((await get(port, '/healthz'))).toEqual({ status: 200, text: JSON.stringify({ status: 'ok' }) });
    expect((await get(port, '/readyz'))).toEqual({ status: 200, text: JSON.stringify({ status: 'ready' }) });
    // Mọi route khác vẫn yêu cầu xác thực.
    expect((await get(port, '/api/persons/00000000-0000-4000-8000-000000000001')).status).toBe(401);

    p.child.kill('SIGINT');
    const r = await withTimeout(p.exited, 15_000, 'graceful exit');
    expect(r.code).toBe(0);
    expect(p.out().includes('shutting down')).toBe(true);
    expect(p.out().includes('"msg":"stopped"')).toBe(true);
    expect(p.out().includes(APP_PW)).toBe(false);
  });

  it('HCOS_HOST binds ONLY the requested address (reachable there, refused on another loopback address)', async () => {
    const port = freePort(5);
    const p = launch({ ...baseEnv(dbUrl(APP_ROLE, APP_PW, DB1), port), HCOS_HOST: '127.0.0.2' });
    live.push(p);
    await waitFor(() => p.out().includes('hcos-api listening'), 30_000, 'startup');
    expect((await get(port, '/healthz', '127.0.0.2')).status).toBe(200);
    let refused = false;
    try { await get(port, '/healthz', '127.0.0.1'); } catch { refused = true; }
    expect(refused).toBe(true);
    p.child.kill('SIGINT');
    expect((await withTimeout(p.exited, 15_000, 'graceful exit')).code).toBe(0);
  });

  it('/readyz turns 503 when the database disappears while /healthz stays 200; SIGTERM still exits 0; no leaks', async () => {
    const port = freePort(2);
    const p = launch(baseEnv(dbUrl(APP_ROLE, APP_PW, DB2), port));
    live.push(p);
    await waitFor(() => p.out().includes('hcos-api listening'), 30_000, 'startup');
    expect((await get(port, '/readyz')).status).toBe(200);

    sql(`DROP DATABASE ${DB2} WITH (FORCE)`); // DB không còn: kết nối hiện có bị ngắt, kết nối mới thất bại

    await waitFor(async () => (await get(port, '/readyz')).status === 503, 20_000, 'readiness 503');
    const down = await get(port, '/readyz');
    expect(down.text).toBe(JSON.stringify({ status: 'unavailable' }));
    expect(down.text.includes(DB2)).toBe(false);
    expect((await get(port, '/healthz')).status).toBe(200);

    p.child.kill('SIGTERM');
    const r = await withTimeout(p.exited, 15_000, 'graceful exit');
    expect(r.code).toBe(0);
    const out = p.out();
    expect(out.includes('shutting down')).toBe(true);
    expect(out.includes('readiness check failed')).toBe(true);
    for (const secret of [APP_PW, SU_PW]) expect(out.includes(secret)).toBe(false);
  });
});
