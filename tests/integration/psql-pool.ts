/**
 * Test helper: PgPoolLike chạy trên tiến trình `psql` (không cần driver `pg`).
 * Chỉ dùng cho integration test. Production dùng `pg.Pool` (cùng giao diện PgPoolLike).
 *
 * - Mỗi connect() mở 1 phiên psql riêng, tự `SET ROLE hcos_app` (để RLS có hiệu lực, không chạy bằng superuser).
 * - Tham số $n được thay bằng literal đã escape phía client (chỉ phục vụ test).
 * - Lỗi SQL được ném với `code` (SQLSTATE) và `constraint`, giống driver pg.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { PgPoolLike } from '../../packages/security/src/tenant-context';

const MARK = '@@END@@';
const NULL_TOKEN = '__NULL__';
const FS = '\u001f';
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\+00$/;

export interface PsqlConnConfig {
  readonly database: string;
  readonly role?: string; // mặc định hcos_app
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class PgError extends Error {
  constructor(message: string, public readonly code: string, public readonly constraint?: string) {
    super(message);
    this.name = 'PgError';
  }
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inline(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`missing param $${n}`);
    return literal(params[i]);
  });
}

function cell(v: string): unknown {
  if (v === NULL_TOKEN) return null;
  if (TS_RE.test(v)) return new Date(v.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return v;
}

export class PsqlClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private out = '';
  private err = '';
  private waiter: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(cfg: PsqlConnConfig) {
    this.proc = spawn(
      'psql',
      ['-X', '-q', '-A', '-F', FS, '-P', 'footer=off', '-P', `null=${NULL_TOKEN}`, '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=verbose', cfg.database],
      { env: { ...process.env, ...cfg.env } as NodeJS.ProcessEnv },
    );
    this.proc.stdout.setEncoding('utf8').on('data', (d: string) => { this.out += d; this.poke(); });
    this.proc.stderr.setEncoding('utf8').on('data', (d: string) => { this.err += d; this.poke(); });
    this.proc.stdin.write("SET datestyle = ISO; SET timezone = 'UTC';\n");
    this.chain = this.raw(`SET ROLE ${cfg.role ?? 'hcos_app'}`).then(() => undefined);
  }

  private poke(): void {
    if (this.waiter && this.out.includes(MARK + '\n') && this.err.includes(MARK + '\n')) this.waiter();
  }

  private raw(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    return new Promise((resolve, reject) => {
      this.out = '';
      this.err = '';
      this.waiter = () => {
        this.waiter = null;
        const errLines = this.err.split('\n').filter((l) => l.startsWith('ERROR:'));
        if (errLines.length > 0) {
          const m = /^ERROR:\s+([0-9A-Z]{5}):\s+(.*)$/.exec(errLines[0]!);
          const code = m?.[1] ?? 'XX000';
          const msg = m?.[2] ?? errLines[0]!;
          const con = /constraint "([^"]+)"/.exec(msg)?.[1];
          reject(new PgError(msg, code, con));
          return;
        }
        const lines = this.out.split('\n').filter((l) => l !== '' && l !== MARK);
        if (lines.length === 0) return resolve({ rows: [], rowCount: 0 });
        const cols = lines[0]!.split(FS);
        const rows = lines.slice(1).map((l) => {
          const vals = l.split(FS);
          const o: Record<string, unknown> = {};
          cols.forEach((c, i) => { o[c] = cell(vals[i] ?? ''); });
          return o;
        });
        resolve({ rows, rowCount: rows.length });
      };
      const body = sql.trim().replace(/;+\s*$/, '');
      this.proc.stdin.write(`${body};\n\\echo ${MARK}\n\\warn ${MARK}\n`);
    });
  }

  query(sql: string, params: readonly unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const run = this.chain.then(() => this.raw(inline(sql, params)));
    this.chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

export function psqlPool(cfg: PsqlConnConfig): PgPoolLike {
  return {
    async connect() {
      const c = new PsqlClient(cfg);
      return {
        query: (sql: string, params?: readonly unknown[]) => c.query(sql, params),
        release: () => c.close(),
      };
    },
  };
}
