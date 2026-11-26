/**
 * Giao diện đợt 2 | Điều hướng theo vai trò.
 *  - Desktop (≥ 1024px): thanh bên trái, các ứng dụng chia theo nhóm công việc.
 *  - Điện thoại / máy tính bảng dọc: thanh dưới đáy = tối đa 4 ứng dụng ghim + nút "Ứng dụng" mở lưới
 *    (có nhóm + ô tìm, không phân biệt dấu). Người dùng tự ghim / bỏ ghim; mặc định theo vai trò.
 *  - Chỉ hiện ứng dụng vai trò được phép (máy chủ vẫn kiểm tra quyền ở từng API).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Icon } from './icons';
import type { Role } from './roles';
import { allowedApps, defaultPins, GROUPS, matchApps, MAX_PINS, type AppDef, type AppKey } from './nav-model';

export { allowedApps, APPS, defaultPins, fold, GROUPS, matchApps, MAX_PINS, type AppDef, type AppKey } from './nav-model';

/** Ghim của người dùng: lưu theo người + trình duyệt (localStorage, có thể không dùng được => mặc định theo vai trò). */
export function usePins(userId: string, roles: ReadonlySet<Role>): { pins: AppKey[]; toggle: (k: AppKey) => void; reset: () => void; custom: boolean } {
  const storeKey = `hcos.nav.pins.v1.${userId}`;
  const allowed = useMemo(() => new Set(allowedApps(roles).map((a) => a.key)), [roles]);
  const fallback = useMemo(() => defaultPins(roles), [roles]);
  const [saved, setSaved] = useState<AppKey[] | null>(() => {
    try {
      const raw = localStorage.getItem(storeKey);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as AppKey[]) : null;
    } catch {
      return null;
    }
  });
  const pins = saved ? saved.filter((k) => allowed.has(k)).slice(0, MAX_PINS) : fallback;
  const persist = useCallback(
    (v: AppKey[] | null) => {
      setSaved(v);
      try {
        if (v) localStorage.setItem(storeKey, JSON.stringify(v));
        else localStorage.removeItem(storeKey);
      } catch {
        /* trình duyệt chặn lưu: chỉ giữ trong phiên */
      }
    },
    [storeKey],
  );
  const toggle = (k: AppKey) => {
    const cur = pins;
    if (cur.includes(k)) persist(cur.filter((x) => x !== k));
    else if (cur.length < MAX_PINS) persist([...cur, k]);
  };
  return { pins, toggle, reset: () => persist(null), custom: saved !== null };
}

export function SideNav({ apps, routeName, footer }: { apps: readonly AppDef[]; routeName: string; footer: ReactNode }) {
  return (
    <aside className="sidenav" aria-label="Điều hướng">
      <a className="sidenav-brand" href={apps[0]?.hash ?? '#/'}>
        <span className="logo" aria-hidden="true">H</span>
        <span>HealthcareOS</span>
      </a>
      <nav className="sidenav-groups">
        {GROUPS.map((g) => {
          const items = apps.filter((a) => a.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="sidenav-group">
              <span className="sidenav-label">{g}</span>
              {items.map((a) => {
                const on = a.routes.includes(routeName);
                return (
                  <a key={a.key} href={a.hash} data-app={a.key} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
                    <Icon name={a.icon} size={19} />
                    <span>{a.label}</span>
                  </a>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="sidenav-foot">{footer}</div>
    </aside>
  );
}

export function BottomBar({ apps, pins, routeName, launcherOpen, onLauncher }: { apps: readonly AppDef[]; pins: AppKey[]; routeName: string; launcherOpen: boolean; onLauncher: () => void }) {
  const pinned = pins.map((k) => apps.find((a) => a.key === k)).filter((a): a is AppDef => Boolean(a));
  const onPinned = pinned.some((a) => a.routes.includes(routeName));
  return (
    <nav className="bottombar" aria-label="Điều hướng chính">
      {pinned.map((a) => {
        const on = !launcherOpen && a.routes.includes(routeName);
        return (
          <a key={a.key} href={a.hash} data-app={a.key} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
            <span className="bb-icon"><Icon name={a.icon} size={22} /></span>
            <span className="bb-label">{a.label}</span>
          </a>
        );
      })}
      <button type="button" className={launcherOpen || !onPinned ? 'active' : ''} onClick={onLauncher} aria-haspopup="dialog" aria-expanded={launcherOpen}>
        <span className="bb-icon"><Icon name="grid" size={22} /></span>
        <span className="bb-label">Ứng dụng</span>
      </button>
    </nav>
  );
}

export function Launcher({ apps, pins, onToggle, onReset, custom, onClose, footer }: {
  apps: readonly AppDef[]; pins: AppKey[]; onToggle: (k: AppKey) => void; onReset: () => void; custom: boolean; onClose: () => void; footer: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const sheet = useRef<HTMLDivElement | null>(null);
  const found = useMemo(() => matchApps(apps, q), [apps, q]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', k);
    sheet.current?.focus();
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  const full = pins.length >= MAX_PINS;
  return (
    <div className="launcher" role="dialog" aria-modal="true" aria-label="Ứng dụng">
      <button type="button" className="launcher-backdrop" aria-label="Đóng" onClick={onClose} tabIndex={-1} />
      <div className="launcher-sheet" ref={sheet} tabIndex={-1}>
        <span className="launcher-grip" aria-hidden="true" />
        <div className="launcher-head">
          <h2>Ứng dụng</h2>
          <button type="button" className="secondary small-btn" onClick={() => setEditing((x) => !x)} aria-pressed={editing}>
            <Icon name={editing ? 'check' : 'pin'} size={16} /> {editing ? 'Xong' : 'Sửa ghim'}
          </button>
          <button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <label className="launcher-search">
          <Icon name="search" size={19} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm ứng dụng… (vd. thu ngân, kho)" aria-label="Tìm ứng dụng" />
        </label>
        {editing && (
          <p className="launcher-hint">
            Chạm để ghim / bỏ ghim vào thanh dưới ({pins.length}/{MAX_PINS}).{' '}
            {custom && <button type="button" className="link" onClick={onReset}>Về mặc định theo vai trò</button>}
          </p>
        )}
        <div className="launcher-body">
          {found.length === 0 && <p className="muted">Không có ứng dụng nào khớp “{q}”.</p>}
          {GROUPS.map((g) => {
            const items = found.filter((a) => a.group === g);
            if (!items.length) return null;
            return (
              <section key={g} className="launcher-group">
                <h3>{g}</h3>
                <div className="launcher-grid">
                  {items.map((a) => {
                    const pinned = pins.includes(a.key);
                    const inner = (
                      <>
                        <span className="tile-icon">
                          <Icon name={a.icon} size={24} />
                          {pinned && <span className="tile-pin" aria-hidden="true"><Icon name="pin" size={11} strokeWidth={2.4} /></span>}
                        </span>
                        <span className="tile-label">{a.label}</span>
                      </>
                    );
                    return editing ? (
                      <button key={a.key} type="button" className="tile" aria-pressed={pinned} disabled={!pinned && full} onClick={() => onToggle(a.key)}
                        aria-label={`${pinned ? 'Bỏ ghim' : 'Ghim'} ${a.label}`}>
                        {inner}
                      </button>
                    ) : (
                      <a key={a.key} className="tile" href={a.hash} data-app={a.key} onClick={onClose}>
                        {inner}
                      </a>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        <div className="launcher-foot">{footer}</div>
      </div>
    </div>
  );
}
