/**
 * Đăng ký khách & đường dẫn tổ chức (migration 026) trên PostgreSQL thật:
 *  - slug đúng định dạng, không dùng từ cấm, duy nhất toàn hệ thống;
 *  - đổi slug => slug cũ chuyển hướng 90 ngày, tổ chức khác không lấy được trong thời gian đó; hết hạn thì lấy được;
 *  - iam.resolve_slug trả slug hiện tại hoặc chuyển hướng còn hạn, không trả gì cho slug lạ;
 *  - giấy phép khám chữa bệnh: mặc định 'none', 'pending' phải có số;
 *  - iam.signup_requests không đọc được bằng hcos_app (chỉ hcos_provisioner).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env['HCOS_IT'] === '1';
const DB = `hcos_it_slug_${process.pid}`;
const MIG = fileURLToPath(new URL('../../infrastructure/database/migrations', import.meta.url));
const TA = '00000000-0000-4000-8000-0000000000a1';
const TB = '00000000-0000-4000-8000-0000000000b1';
const run = ENABLED ? describe : (describe as unknown as { skip: typeof describe }).skip;

const psql = (sql: string, db = DB) =>
  execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
/** Trả true nếu câu lệnh bị DB từ chối. */
const rejects = (sql: string): boolean => {
  try {
    psql(sql);
    return false;
  } catch {
    return true;
  }
};

run('Đăng ký khách & đường dẫn tổ chức / PostgreSQL', () => {
  beforeAll(() => {
    psql('CREATE DATABASE ' + DB, 'postgres');
    for (const f of readdirSync(MIG).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${MIG}/${f}`]);
    }
    psql(`
      INSERT INTO iam.tenants (tenant_id, code, name) VALUES
        ('${TA}', 'ta', 'Phòng khám A'),
        ('${TB}', 'tb', 'Phòng khám B');
    `);
  });

  afterAll(() => {
    try {
      psql('DROP DATABASE IF EXISTS ' + DB, 'postgres');
    } catch {
      /* dọn dẹp best-effort */
    }
  });

  it('slug đúng định dạng được nhận; sai định dạng hoặc từ cấm bị từ chối', () => {
    psql(`UPDATE iam.tenants SET slug = 'pk1' WHERE tenant_id = '${TA}'`);
    expect(psql(`SELECT slug FROM iam.tenants WHERE tenant_id = '${TA}'`)).toBe('pk1');
    for (const bad of ['ab', 'Pk1', 'pk_1', '-pk1', 'pk1-', 'app', 'api', 'admin', 'a'.repeat(31)]) {
      expect(rejects(`UPDATE iam.tenants SET slug = '${bad}' WHERE tenant_id = '${TB}'`), bad).toBe(true);
    }
  });

  it('slug là duy nhất toàn hệ thống', () => {
    expect(rejects(`UPDATE iam.tenants SET slug = 'pk1' WHERE tenant_id = '${TB}'`)).toBe(true);
  });

  it('đổi slug: slug cũ chuyển hướng; tổ chức khác không lấy được trong 90 ngày', () => {
    psql(`UPDATE iam.tenants SET slug = 'pk2' WHERE tenant_id = '${TA}'`);
    expect(psql(`SELECT tenant_id, is_redirect FROM iam.resolve_slug('pk1')`)).toBe(`${TA}|t`);
    expect(psql(`SELECT tenant_id, is_redirect FROM iam.resolve_slug('pk2')`)).toBe(`${TA}|f`);
    expect(rejects(`UPDATE iam.tenants SET slug = 'pk1' WHERE tenant_id = '${TB}'`)).toBe(true);
  });

  it('sau khi hết hạn chuyển hướng thì slug được cấp lại; slug lạ không trả gì', () => {
    psql(`UPDATE iam.slug_redirects SET created_at = now() - interval '100 days', expires_at = now() - interval '10 days' WHERE old_slug = 'pk1'`);
    expect(psql(`SELECT count(*) FROM iam.resolve_slug('pk1')`)).toBe('0');
    expect(psql(`SELECT count(*) FROM iam.resolve_slug('khong-co')`)).toBe('0');
    psql(`UPDATE iam.tenants SET slug = 'pk1' WHERE tenant_id = '${TB}'`);
    expect(psql(`SELECT tenant_id, is_redirect FROM iam.resolve_slug('pk1')`)).toBe(`${TB}|f`);
  });

  it('giấy phép khám chữa bệnh: mặc định none; pending phải có số', () => {
    expect(psql(`SELECT medical_license_status FROM iam.tenants WHERE tenant_id = '${TA}'`)).toBe('none');
    expect(rejects(`UPDATE iam.tenants SET medical_license_status = 'pending' WHERE tenant_id = '${TA}'`)).toBe(true);
    psql(`UPDATE iam.tenants SET medical_license_no = 'KCB-0001', medical_license_status = 'pending' WHERE tenant_id = '${TA}'`);
    expect(psql(`SELECT medical_license_status FROM iam.tenants WHERE tenant_id = '${TA}'`)).toBe('pending');
  });

  it('iam.signup_requests không đọc được bằng hcos_app; hcos_provisioner đọc được', () => {
    expect(rejects(`SET ROLE hcos_app; SELECT count(*) FROM iam.signup_requests`)).toBe(true);
    expect(psql(`SET ROLE hcos_provisioner; SELECT count(*) FROM iam.signup_requests`)).toBe('0');
  });
});
