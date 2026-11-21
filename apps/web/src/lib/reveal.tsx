/**
 * HCOS-F16 | SĐT / email / CCCD luôn hiện dạng che (091****678). Bấm "Hiện" → nhập lý do → server kiểm tra
 * pii:reveal tại cơ sở của bản ghi, giải mã và ghi nhật ký (không ghi giá trị). Bản rõ chỉ nằm trong bộ nhớ
 * của component và tự ẩn sau 60 giây.
 */
import { useEffect, useState } from 'react';

import { api, ApiError } from './api';

export type RevealTarget =
  | { kind: 'patient'; id: string; field: 'phone' | 'email' | 'nationalId' }
  | { kind: 'booking'; id: string; field: 'phone' | 'nationalId' };

const HIDE_AFTER_MS = 60_000;

export function Reveal({ masked, target, allowed }: { masked: string | null | undefined; target: RevealTarget; allowed: boolean }) {
  const [plain, setPlain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (plain === null) return undefined;
    const t = setTimeout(() => setPlain(null), HIDE_AFTER_MS);
    return () => clearTimeout(t);
  }, [plain]);
  useEffect(() => setPlain(null), [target.kind, target.id, target.field]);
  if (!masked) return <span>—</span>;
  const show = async () => {
    const reason = prompt('Lý do xem thông tin đầy đủ? (tối thiểu 5 ký tự — được ghi nhật ký)');
    if (reason === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ value: string | null }>('POST', '/api/pii/reveal', { body: { ...target, reason } });
      setPlain(r.data.value ?? '');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Không xem được');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="reveal">
      <span className={plain === null ? 'masked' : 'plain'} data-pii={target.field}>
        {plain ?? masked}
      </span>
      {allowed && (plain === null ? (
        <button type="button" className="linkish" disabled={busy} onClick={() => void show()} title="Xem đầy đủ (ghi nhật ký)">
          {busy ? '…' : 'Hiện'}
        </button>
      ) : (
        <button type="button" className="linkish" onClick={() => setPlain(null)}>
          Ẩn
        </button>
      ))}
      {err && <span className="err small"> {err}</span>}
    </span>
  );
}
