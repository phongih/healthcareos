/**
 * HCOS-S0-R2 | Đầu-cuối: JWT thật (RS256) xác thực qua JWKS cục bộ -> main.ts (tiến trình thật) -> PostgreSQL (role hcos_app, RLS).
 *
 * Chứng minh qua HTTP thật: chữ ký/hạn/audience/issuer được kiểm bằng JWKS; tenant lấy từ token; tenant B không thấy dữ liệu tenant A;
 * tenant bị tạm ngưng bị chặn (tra dưới RLS); từ chối RBAC được ghi audit; audit hash-chain nguyên vẹn; không lộ PHI/mật khẩu/JWT.
 * Chạy: HCOS_IT=1 PGHOST=127.0.0.1 PGPORT=… PGUSER=<superuser> [PGPASSWORD=…]  (cần `tsx` trong PATH; npm run đã thêm).
 * Chỉ fixture tổng hợp.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env['HCOS_IT'] === '1';
const MAIN = fileURLToPath(new URL('../../services/api/src/main.ts', import.meta.url));
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const SFX = String(process.pid);
const DB = `hcos_e2e_${SFX}`;
const APP_ROLE = `hcos_e2e_app_${SFX}`;
const APP_PW = `pw-e2e-${SFX}-Zq9`;
const ISSUER = 'https://idp.hcos.test/';
const AUDIENCE = 'hcos-api';
const API_PORT = 22000 + (Number(SFX) % 15000);

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TA = uid(1), TB = uid(2), TC = uid(3); // C = suspended
const OA = uid(11), OB = uid(12), OC = uid(13);

const psql = (db: string, args: string[]) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], { encoding: 'utf8' });
const sql = (q: string, db = DB) => psql(db, ['-c', q]);
const scalar = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();

const SEED = `
INSERT INTO iam.tenants(tenant_id,code,name,status) VALUES ('${TA}','ta','A','active'),('${TB}','tb','B','active'),('${TC}','tc','C','suspended');
INSERT INTO iam.organizations(organization_id,tenant_id,type,code,name) VALUES ('${OA}','${TA}','clinic','c1','C1'),('${OB}','${TB}','clinic','c1','C1'),('${OC}','${TC}','clinic','c1','C1');
INSERT INTO iam.users(user_id,tenant_id,external_subject,display_name) VALUES
  ('${uid(101)}','${TA}','sub-nurse-a','N'),('${uid(102)}','${TA}','sub-pharm-a','P'),('${uid(201)}','${TB}','sub-nurse-b','NB'),('${uid(301)}','${TC}','sub-nurse-c','NC');
INSERT INTO iam.memberships(tenant_id,user_id,organization_id,role) VALUES
  ('${TA}','${uid(101)}','${OA}','clinic_staff'),('${TA}','${uid(102)}','${OA}','pharmacist'),
  ('${TB}','${uid(201)}','${OB}','clinic_staff'),('${TC}','${uid(301)}','${OC}','clinic_staff');
`;

const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

run('E2E: JWT (JWKS) -> main.ts -> PostgreSQL', () => {
  let jwks: Server;
  let child: ChildProcess;
  let output = '';
  let exited: Promise<number | null>;
  let signKey: any;
  let otherKey: any;
  const base = `http://127.0.0.1:${API_PORT}`;
  const issued: string[] = [];

  async function tok(o: { sub: string; tenant: string; org: string; roles: string[]; key?: any; exp?: string; aud?: string; iss?: string }): Promise<string> {
    const t = await new SignJWT({ tenant_id: o.tenant, org_id: o.org, roles: o.roles })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(o.sub).setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? AUDIENCE)
      .setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? signKey);
    issued.push(t);
    return t;
  }
  const T = {
    nurseA: () => tok({ sub: 'sub-nurse-a', tenant: TA, org: OA, roles: ['clinic_staff'] }),
    pharmA: () => tok({ sub: 'sub-pharm-a', tenant: TA, org: OA, roles: ['pharmacist'] }),
    nurseB: () => tok({ sub: 'sub-nurse-b', tenant: TB, org: OB, roles: ['clinic_staff'] }),
    nurseC: () => tok({ sub: 'sub-nurse-c', tenant: TC, org: OC, roles: ['clinic_staff'] }),
  };
  async function http(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status as number, text, json: text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null };
  }
  const PERSON = { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17', identifiers: [{ type: 'national_id', system: 'https://moh.gov.vn/cccd', value: '079090000777' }] };
  let personId = '';

  beforeAll(async () => {
    sql(`CREATE DATABASE ${DB}`, 'postgres');
    for (const f of ['001_s0_init.sql', '002_s1_clinical_init.sql', '003_person_registry.sql']) psql(DB, ['-f', `${MIG}/${f}`]);
    sql(SEED);
    sql(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}' IN ROLE hcos_app`, 'postgres');

    const kp = await generateKeyPair('RS256');
    signKey = kp.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    jwks = createServer((req, res) => {
      if (req.url === '/jwks') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    const jwksPort = (jwks.address() as { port: number }).port;

    const host = process.env['PGHOST'] ?? '127.0.0.1';
    child = spawn('tsx', [MAIN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '',
        HCOS_DATABASE_URL: `postgres://${APP_ROLE}:${APP_PW}@${host}:${process.env['PGPORT'] ?? '5432'}/${DB}`,
        HCOS_JWT_ISSUER: ISSUER, HCOS_JWT_AUDIENCE: AUDIENCE, HCOS_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
        HCOS_PORT: String(API_PORT),
      },
    });
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { output += d; });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { output += d; });
    exited = new Promise((res) => child.on('exit', (code: number | null) => res(code)));
    const t0 = Date.now();
    while (!output.includes('hcos-api listening')) {
      if (Date.now() - t0 > 30_000) throw new Error('API did not start: ' + output.slice(0, 500));
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(async () => {
    try { child.kill('SIGTERM'); await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]); child.kill('SIGKILL'); } catch { /* gone */ }
    await new Promise<void>((r) => jwks.close(() => r()));
    try { sql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, 'postgres'); } catch { /* best effort */ }
    try { sql(`DROP ROLE IF EXISTS ${APP_ROLE}`, 'postgres'); } catch { /* best effort */ }
  });

  it('accepts a valid JWKS-signed token: tenant comes from the token; create + read work', async () => {
    const c = await http('POST', '/api/persons', await T.nurseA(), PERSON);
    expect(c.status).toBe(201);
    personId = c.json.person.personId;
    const g = await http('GET', `/api/persons/${personId}`, await T.nurseA());
    expect(g.status).toBe(200);
    expect(scalar(`SELECT tenant_id FROM patient.persons WHERE person_id='${personId}'`)).toBe(TA);
  });

  it('rejects missing, forged, expired, wrong-audience, wrong-issuer and unsigned tokens with 401 (and creates nothing)', async () => {
    const before = scalar('SELECT count(*) FROM patient.persons');
    const bad: Array<string | undefined> = [
      undefined,
      'garbage',
      await tok({ sub: 'sub-nurse-a', tenant: TA, org: OA, roles: ['clinic_staff'], key: otherKey }), // cùng kid, khoá khác
      await tok({ sub: 'sub-nurse-a', tenant: TA, org: OA, roles: ['clinic_staff'], exp: '-1m' as any }),
      await tok({ sub: 'sub-nurse-a', tenant: TA, org: OA, roles: ['clinic_staff'], aud: 'someone-else' }),
      await tok({ sub: 'sub-nurse-a', tenant: TA, org: OA, roles: ['clinic_staff'], iss: 'https://evil.test/' }),
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', tenant_id: TA, exp: 9999999999, iss: ISSUER, aud: AUDIENCE })).toString('base64url')}.`,
    ];
    for (const t of bad) {
      const r = await http('POST', '/api/persons', t, { ...PERSON, givenName: 'Forged' });
      expect(r.status).toBe(401);
    }
    expect(scalar('SELECT count(*) FROM patient.persons')).toBe(before);
  });

  it('tenant B cannot see tenant A data (404), a conflicting tenant header is refused, a suspended tenant is blocked', async () => {
    const b = await http('GET', `/api/persons/${personId}`, await T.nurseB());
    expect(b.status).toBe(404);
    const s = await http('POST', '/api/persons/search-duplicates', await T.nurseB(), { givenName: 'Văn An', familyName: 'Nguyễn', birthDate: '1990-05-17' });
    expect(s.status).toBe(200);
    expect(s.json.candidates).toEqual([]);

    const h = await http('GET', `/api/persons/${personId}`, await T.nurseA(), undefined, { 'x-tenant-id': TB });
    expect(h.status).toBe(403);

    const c = await http('POST', '/api/persons', await T.nurseC(), { ...PERSON, givenName: 'Suspended' });
    expect(c.status).toBe(403);
    expect(scalar(`SELECT count(*) FROM patient.persons WHERE tenant_id='${TC}'`)).toBe('0');
  });

  it('RBAC denial (pharmacist merge) is 403 and persists a denied audit event', async () => {
    const r = await http('POST', `/api/persons/${personId}/merge`, await T.pharmA(), {
      targetPersonId: uid(999), reason: 'should be denied', expectedSourceVersion: 1, expectedTargetVersion: 1,
    });
    expect(r.status).toBe(403);
    expect(Number(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND action='person.merge' AND outcome='denied'`))).toBe(1);
  });

  it('audit persisted via the real server: success events, hash-chain intact, no PHI / secrets / JWTs anywhere', async () => {
    expect(Number(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id='${TA}' AND action='person.create' AND outcome='success'`))).toBeGreaterThanOrEqual(1);
    expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE tenant_id IN ('${TB}','${TC}') AND action='person.create'`)).toBe('0');
    expect(scalar(`WITH o AS (SELECT prev_hash, lag(event_hash) OVER (ORDER BY occurred_at, event_id) e FROM platform.audit_events WHERE tenant_id='${TA}')
                   SELECT count(*) FROM o WHERE e IS NOT NULL AND prev_hash <> e`)).toBe('0');
    for (const phi of ['Nguyen', 'Nguyễn', '079090000777', '1990-05-17']) {
      expect(scalar(`SELECT count(*) FROM platform.audit_events WHERE payload::text ILIKE '%${phi}%'`)).toBe('0');
    }
    expect(output.includes(APP_PW)).toBe(false);
    for (const t of issued) expect(output.includes(t)).toBe(false);
  });

  it('graceful shutdown on SIGTERM after serving real traffic (exit 0)', async () => {
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 15_000))]);
    expect(code).toBe(0);
    expect(output.includes('"msg":"stopped"')).toBe(true);
  });
});
