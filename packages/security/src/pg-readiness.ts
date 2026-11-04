/**
 * HCOS-P0-ENG-001 | Readiness + kiểm tra role DB lúc khởi động.
 *
 * PgReadinessProbe: "sẵn sàng nhận traffic" = lấy được kết nối, role ứng dụng đọc được bảng nền tảng (migration đã áp dụng).
 *   - Có timeout cứng (kể cả khi connect() treo). Kết nối trả về sau timeout vẫn được release (không rò pool).
 *   - Chỉ trả boolean: không lộ lỗi SQL/chuỗi kết nối. Tên lỗi được đưa cho onError để log phía server.
 *   - KHÔNG thay thế test cô lập tenant: không đặt app.tenant_id, SELECT ... LIMIT 0 không đọc dòng dữ liệu nào.
 *
 * assertSafeDatabaseRole: từ chối khởi động nếu phiên DB chạy bằng superuser/BYPASSRLS (RLS sẽ bị vô hiệu im lặng).
 */
import type { PgPoolLike } from './tenant-context';

export interface ReadinessProbe {
  check(): Promise<boolean>;
}

export interface PgReadinessOptions {
  readonly timeoutMs?: number;
  readonly onError?: (errorName: string) => void;
}

export class PgReadinessProbe implements ReadinessProbe {
  private readonly timeoutMs: number;

  constructor(private readonly pool: PgPoolLike, private readonly opts: PgReadinessOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  async check(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async (): Promise<boolean> => {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1 FROM iam.tenants LIMIT 0');
        return true;
      } finally {
        client.release();
      }
    })().catch((e: unknown) => {
      this.opts.onError?.(e instanceof Error ? e.name : 'error');
      return false;
    });
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        this.opts.onError?.('ReadinessTimeout');
        resolve(false);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class UnsafeDatabaseRoleError extends Error {
  constructor() {
    super('Database session role can bypass row-level security (superuser or BYPASSRLS); refusing to start');
    this.name = 'UnsafeDatabaseRoleError';
  }
}

export async function assertSafeDatabaseRole(pool: PgPoolLike): Promise<void> {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT bool_or(rolsuper OR rolbypassrls) AS unsafe
         FROM pg_roles WHERE rolname IN (current_user, session_user)`,
    );
    const unsafe = r.rows[0]?.unsafe;
    if (unsafe !== true && unsafe !== false && unsafe !== 't' && unsafe !== 'f') throw new UnsafeDatabaseRoleError();
    if (unsafe === true || unsafe === 't') throw new UnsafeDatabaseRoleError();
  } finally {
    client.release();
  }
}
