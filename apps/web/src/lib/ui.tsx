/** Thành phần giao diện dùng chung + hook gọi API có trạng thái loading/lỗi. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiError, newIdempotencyKey } from './api';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as Error;
  const detail = error instanceof ApiError && error.detail ? ` (${error.detail})` : '';
  return (
    <div className="alert error" role="alert">
      {e.message}
      {detail}
    </div>
  );
}

export function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'ok' | 'warn' }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function RedactedBadge({ show, what }: { show: boolean; what?: string }) {
  if (!show) return null;
  return (
    <span className="badge redacted" title="Một số trường bị che theo access policy của bạn">
      Đã che{what ? `: ${what}` : ''}
    </span>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Card({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Tải dữ liệu khi deps đổi; trả { data, error, loading, reload }. Bỏ kết quả của lần gọi cũ (tránh race). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => {
        if (my === seq.current) {
          setData(d);
          setLoading(false);
        }
      },
      (e: unknown) => {
        if (my === seq.current) {
          setError(e);
          setLoading(false);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Bọc một thao tác ghi: chống bấm hai lần, giữ lỗi để hiển thị. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      setError(null);
      try {
        return await fn(...a);
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy, fn],
  );
  return { run, busy, error, setError };
}

export const navigate = (hash: string): void => {
  location.hash = hash;
};

/** Khoá idempotency gắn với nội dung form: đổi nội dung => khoá mới; giữ nguyên => dùng lại khi thử lại. */
export function useIntentKey(deps: unknown[]): [string, () => void] {
  const [key, setKey] = useState(newIdempotencyKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setKey(newIdempotencyKey()), deps);
  return [key, () => setKey(newIdempotencyKey())];
}
