/**
 * HCOS-F16 | Mã hoá dữ liệu cũ còn bản rõ (chạy MỘT lần sau khi deploy migration 019 + API mới).
 *
 *   HCOS_DATABASE_URL=postgres://hcos_api:…  HCOS_KEKS=…  npx tsx scripts/pii-backfill.ts <tenant-uuid> [<tenant-uuid> …]
 *
 * Với từng tenant, lặp theo lô (mỗi lô một transaction):
 *   bản rõ -> bản mã + blind index + dạng che -> GIẢI MÃ LẠI so khớp -> xoá bản rõ;
 *   ảnh chụp gộp hồ sơ: phone/email -> khối contact đã mã hoá.
 * Cuối cùng in số bản rõ còn lại (phải bằng 0) — dán kết quả vào nhật ký deploy làm bằng chứng.
 * Chạy lại an toàn (idempotent). Dùng role ứng dụng (RLS vẫn áp dụng), không dùng superuser.
 */
import pg from 'pg';

import { isUuid } from '../packages/domain/src/s0-contracts';
import { configureKeyProvider, LocalKeyProvider } from '../packages/security/src/pii';
import type { PgPoolLike } from '../packages/security/src/tenant-context';
import { backfillTenant } from '../services/api/src/security/pii.service';

const url = process.env['HCOS_DATABASE_URL'];
const keks = process.env['HCOS_KEKS'];
const tenants = process.argv.slice(2);
if (!url || !keks || tenants.length === 0 || !tenants.every(isUuid)) {
  console.error('Cách dùng: HCOS_DATABASE_URL=… HCOS_KEKS=… npx tsx scripts/pii-backfill.ts <tenant-uuid> [...]');
  process.exit(2);
}
configureKeyProvider(LocalKeyProvider.parse(keks));
const pgPool = new pg.Pool({ connectionString: url, max: 2 });
const pool = pgPool as unknown as PgPoolLike;

try {
  for (const tenant of tenants) {
    const r = await backfillTenant(pool, tenant, (m) => console.log(m));
    console.log(`Tenant ${tenant}: đã mã hoá ${r.encrypted} giá trị. Bản rõ còn lại: ${r.remaining}`);
    console.log(`  chuyển sang khoá theo người: ${r.converted}. Bản mã dạng cũ còn lại: ${r.legacyRemaining}`);
    for (const c of r.stats.columns) console.log(`  ${c.column.padEnd(32)} ${c.rows}`);
    console.log(`  ${'ảnh chụp gộp hồ sơ'.padEnd(32)} ${r.stats.snapshots}`);
    if (r.remaining !== 0 || r.legacyRemaining !== 0) process.exitCode = 1;
  }
} catch (e) {
  console.error('LỖI:', e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
} finally {
  await pgPool.end();
}
