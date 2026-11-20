/**
 * HCOS-F11 | Chuông thông báo theo vai trò × cơ sở (hộp thư của Decision Engine).
 * Gợi ý có nút "Áp dụng": chỉ MỞ màn hình nghiệp vụ liên quan và đánh dấu đã áp dụng — mọi thay đổi do người dùng tự làm ở đó.
 */
import { useCallback, useEffect, useState } from 'react';

import { api } from './api';
import { fmtDateTime } from './fhir';
import { useSession } from './session';
import { ErrorBox, navigate } from './ui';

export interface InboxItem {
  notificationId: string; eventId: string; targetRole: string; detector: string; ruleName: string; priority: number; title: string; detail: string | null;
  link: string | null; detectedAt: string; status: 'open' | 'handled'; hasSuggestion: boolean; suggestionStatus: 'pending' | 'applied' | 'dismissed' | null;
  suggestionLabel: string | null; handledByName: string | null; handledAt: string | null; handledNote: string | null; version: number;
}
const POLL_MS = 60_000;
export const PRIORITY_LABEL: Record<number, string> = { 1: 'P1 khẩn', 2: 'P2 cao', 3: 'P3 theo dõi' };
const SUGGESTION_TEXT: Record<string, string> = { applied: 'đã áp dụng', dismissed: 'đã bỏ qua', pending: 'chờ' };

export function NotificationBell({ inline = false }: { inline?: boolean } = {}) {
  const { orgId } = useSession();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [open, setOpen] = useState(inline);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const r = await api<{ items: InboxItem[]; openCount: number }>('GET', `/api/notifications?organization=${orgId}${all ? '&all=1' : ''}`);
      setItems(r.data.items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [orgId, all]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const act = async (it: InboxItem, action: 'handle' | 'apply' | 'dismiss' | 'reopen') => {
    setBusy(it.notificationId);
    try {
      const r = await api<{ link: string | null }>('POST', `/api/notifications/${it.notificationId}`, { body: { action }, headers: { 'if-match': `W/"${it.version}"` } });
      await load();
      if (action === 'apply' && r.data.link) {
        if (!inline) setOpen(false);
        navigate(r.data.link);
      }
    } catch (e) {
      setError(e);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const openItems = items.filter((i) => i.status === 'open');
  const urgent = openItems.some((i) => i.priority === 1);
  const panel = (
        <div className={inline ? "bell-panel inline" : "bell-panel"} role={inline ? undefined : "dialog"} aria-label="Hộp thông báo">
          <div className="bell-head">
            <strong>Thông báo</strong>
            <label className="small">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> hiện cả đã xử lý (7 ngày)
            </label>
          </div>
          <ErrorBox error={error} />
          {items.length === 0 ? (
            <p className="muted bell-empty">Không có thông báo nào cho vai trò của bạn tại cơ sở này.</p>
          ) : (
            <ul className="bell-list">
              {items.map((it) => (
                <li key={it.notificationId} className={`p${it.priority} ${it.status}`}>
                  <div className="bell-meta">
                    <span className={`badge prio-${it.priority}`}>{PRIORITY_LABEL[it.priority]}</span>
                    <span className="muted small">{it.ruleName} · {fmtDateTime(it.detectedAt)}</span>
                  </div>
                  <div className="bell-title">{it.title}</div>
                  {it.detail && <div className="small muted">{it.detail}</div>}
                  {it.status === 'handled' ? (
                    <div className="small muted">
                      ✓ {it.handledByName ?? '—'} xử lý {it.handledAt ? fmtDateTime(it.handledAt) : ''}
                      {it.suggestionStatus && it.suggestionStatus !== 'pending' && ` · gợi ý ${SUGGESTION_TEXT[it.suggestionStatus]}`}
                      {it.handledNote && ` · “${it.handledNote}”`}
                      <button type="button" className="link small" disabled={busy === it.notificationId} onClick={() => void act(it, 'reopen')}>
                        mở lại
                      </button>
                    </div>
                  ) : (
                    <div className="row wrap bell-actions">
                      {it.hasSuggestion && it.suggestionStatus === 'pending' ? (
                        <>
                          <button type="button" disabled={busy === it.notificationId} onClick={() => void act(it, 'apply')} title="Mở màn hình liên quan để bạn tự thao tác">
                            Áp dụng: {it.suggestionLabel}
                          </button>
                          <button type="button" className="secondary" disabled={busy === it.notificationId} onClick={() => void act(it, 'dismiss')}>
                            Bỏ qua
                          </button>
                        </>
                      ) : (
                        it.link && (
                          <a href={it.link} className="small" onClick={() => setOpen(false)}>
                            Mở
                          </a>
                        )
                      )}
                      <button type="button" className="secondary" disabled={busy === it.notificationId} onClick={() => void act(it, 'handle')}>
                        Đã xử lý
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="small muted bell-foot">Engine chỉ báo và gợi ý; không tự sửa hồ sơ, tiền hay kho.</p>
        </div>
  );
  if (inline) return panel;
  return (
    <div className="bell">
      {/* Bấm ra ngoài => đóng. */}
      {open && <div className="bell-backdrop" onClick={() => setOpen(false)} />}
      <button
        type="button"
        className={`bell-btn${urgent ? ' urgent' : ''}`}
        aria-label={`Thông báo: ${openItems.length} chưa xử lý`}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3a1.5 1.5 0 0 0-3 0v1.16A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
        </svg>
        {openItems.length > 0 && <span className="bell-count">{openItems.length > 99 ? '99+' : openItems.length}</span>}
      </button>
      {open && panel}
    </div>
  );
}

/** Trang hộp thông báo (#/inbox) — đích của nút "Mở trong HealthcareOS" trên thẻ Teams. */
export function InboxScreen() {
  return (
    <div className="stack">
      <h2>Hộp thông báo</h2>
      <NotificationBell inline />
    </div>
  );
}
