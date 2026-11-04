#!/usr/bin/env node
/**
 * Áp dụng migration theo thứ tự tên file, mỗi file đúng 1 lần (ghi vào platform_migrations.schema_migrations).
 * Dùng psql (kết nối theo biến PG*). Mỗi file tự chứa BEGIN/COMMIT nên lỗi sẽ rollback file đó.
 *
 *   PGHOST=... PGUSER=... PGDATABASE=hcos node scripts/migrate.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../infrastructure/database/migrations/', import.meta.url));
const psql = (...args) => execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });

psql('-c', `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

const applied = new Map(
  psql('-c', 'SELECT filename, sha256 FROM public.schema_migrations')
    .split('\n').filter(Boolean).map((l) => l.split('|')),
);

for (const f of readdirSync(dir).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
  const sha = createHash('sha256').update(readFileSync(dir + f)).digest('hex');
  if (applied.has(f)) {
    if (applied.get(f) !== sha) {
      console.error(`migration ${f} was modified after being applied (checksum mismatch)`);
      process.exit(1);
    }
    console.log(`skip   ${f}`);
    continue;
  }
  console.log(`apply  ${f}`);
  psql('-f', dir + f);
  psql('-c', `INSERT INTO public.schema_migrations(filename, sha256) VALUES ('${f}', '${sha}')`);
}
console.log('migrations up to date');
