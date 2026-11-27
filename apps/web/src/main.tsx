import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './lib/api';
import { claims, initAuth, login, logout } from './lib/auth';
import { can, organizationsOf, ROLE_LABEL, rolesAt, SessionContext, type Me, type Session } from './lib/session';
import { InboxScreen, NotificationBell } from './lib/notifications';
import { ErrorBox } from './lib/ui';
import { Icon } from './lib/icons';
import { allowedApps, BottomBar, Launcher, SideNav, usePins } from './lib/nav';
import { AdminScreen } from './screens/admin';
import { StaffScreen } from './screens/staff';
import { TodayScreen } from './screens/today';
import { BookingsScreen, PublicBookingScreen, PublicLookupScreen } from './screens/booking';
import { EncounterScreen } from './screens/encounter';
import { DecisionScreen } from './screens/decision';
import { IntegrationsScreen } from './screens/integrations';
import { CaseScreen, FinanceScreen, ShiftScreen } from './screens/finance';
import { ReportsScreen } from './screens/reports';
import { ForecastScreen } from './screens/forecast';
import { PatientDetail, PatientsScreen } from './screens/patients';
import { PharmacyScreen } from './screens/pharmacy';
import { HandoverScreen } from './screens/handover';
import { GovernanceScreen } from './screens/governance';
import { DeviceScreen, EquipmentScreen } from './screens/equipment';
import { BoardScreen, QueueScreen } from './screens/queue';

declare const __HCOS_ENV_LABEL__: string;
const ENV_LABEL = __HCOS_ENV_LABEL__;

type Route =
  | { name: 'patients' }
  | { name: 'patient'; id: string }
  | { name: 'encounter'; id: string }
  | { name: 'pharmacy' }
  | { name: 'handover' }
  | { name: 'governance' }
  | { name: 'queue' }
  | { name: 'bookings' }
  | { name: 'finance' }
  | { name: 'reports' }
  | { name: 'forecast' }
  | { name: 'decision' }
  | { name: 'integrations' }
  | { name: 'inbox' }
  | { name: 'financeCase'; id: string }
  | { name: 'financeShift'; id: string }
  | { name: 'admin' }
  | { name: 'staff' }
  | { name: 'today' }
  | { name: 'equipment' }
  | { name: 'device'; code: string; qr: boolean }
  | { name: 'home' };

const UUID = '[0-9a-fA-F-]{36}';
function parseRoute(hash: string): Route {
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^#/patients/(${UUID})$`).exec(hash))) return { name: 'patient', id: m[1]! };
  if ((m = new RegExp(`^#/encounters/(${UUID})$`).exec(hash))) return { name: 'encounter', id: m[1]! };
  if (hash.startsWith('#/patients')) return { name: 'patients' };
  if (hash.startsWith('#/pharmacy')) return { name: 'pharmacy' };
  if (hash.startsWith('#/handover')) return { name: 'handover' };
  // F19: trang thiết bị theo mã tài sản (QR trên thân máy trỏ tới #/tb/<mã>/qr).
  if ((m = /^#\/tb\/([A-Za-z0-9-]{8,20})(\/qr)?$/.exec(hash))) return { name: 'device', code: m[1]!.toUpperCase(), qr: Boolean(m[2]) };
  if (hash.startsWith('#/equipment')) return { name: 'equipment' };
  if (hash.startsWith('#/governance')) return { name: 'governance' };
  if (hash.startsWith('#/queue')) return { name: 'queue' };
  if (hash.startsWith('#/bookings')) return { name: 'bookings' };
  if ((m = new RegExp(`^#/finance/cases/(${UUID})$`).exec(hash))) return { name: 'financeCase', id: m[1]! };
  if ((m = new RegExp(`^#/finance/shifts/(${UUID})$`).exec(hash))) return { name: 'financeShift', id: m[1]! };
  if (hash.startsWith('#/finance')) return { name: 'finance' };
  if (hash.startsWith('#/reports')) return { name: 'reports' };
  if (hash.startsWith('#/forecast')) return { name: 'forecast' };
  if (hash.startsWith('#/decision')) return { name: 'decision' };
  if (hash.startsWith('#/integrations')) return { name: 'integrations' };
  if (hash.startsWith('#/inbox')) return { name: 'inbox' };
  if (hash.startsWith('#/admin')) return { name: 'admin' };
  if (hash.startsWith('#/staff')) return { name: 'staff' };
  if (hash.startsWith('#/today')) return { name: 'today' };
  return { name: 'home' };
}

function useHash(): string {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => setH(location.hash);
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
}

function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  const pick = parts.length >= 2 ? [parts[parts.length - 2]!, parts[parts.length - 1]!] : parts;
  return pick.map((p) => p[0]!.toUpperCase()).join('').slice(0, 2) || '?';
}

function Shell({ me }: { me: Me }) {
  const orgs = organizationsOf(me);
  const [orgId, setOrgId] = useState(orgs[0]?.organizationId ?? '');
  const roles = useMemo(() => rolesAt(me, orgId), [me, orgId]);
  const restricted = me.memberships.some((m) => m.organization.organizationId === orgId && m.accessPolicyId);
  const session: Session = { me, orgId, setOrgId, roles, restricted };
  const route = parseRoute(useHash());

  // Giao diện đợt 2: ứng dụng theo vai trò; desktop = thanh bên, điện thoại = thanh dưới đáy + lưới ứng dụng.
  const apps = useMemo(() => allowedApps(roles), [roles]);
  const { pins, toggle, reset, custom } = usePins(me.user.userId, roles);
  const [launcher, setLauncher] = useState(false);
  const closeLauncher = useCallback(() => setLauncher(false), []);
  const current = apps.find((a) => a.routes.includes(route.name));

  const home = (apps.find((a) => a.key === pins[0]) ?? apps[0])?.hash;
  useEffect(() => {
    if (route.name === 'home' && home) location.replace(home);
  }, [route.name, home]);
  useEffect(() => setLauncher(false), [route.name]);

  const userName = me.user.displayName ?? me.user.email ?? 'Người dùng';
  const roleText = [...roles].map((r) => ROLE_LABEL[r]).join(', ');
  const userBlock = (
    <div className="user-block">
      <span className="avatar" aria-hidden="true">{initials(userName)}</span>
      <span className="user-text" title={`${userName} — ${roleText}`}>
        <span className="user-name">{userName}</span>
        <span className="user-roles">{roleText || 'Chưa có vai trò'}</span>
      </span>
      <button type="button" className="icon-btn" onClick={logout} aria-label="Đăng xuất" title="Đăng xuất">
        <Icon name="logout" size={18} />
      </button>
    </div>
  );

  return (
    <SessionContext.Provider value={session}>
      {ENV_LABEL && (
        <div className="env-banner" role="alert">
          {ENV_LABEL}
        </div>
      )}
      <div className="shell">
        <SideNav apps={apps} routeName={route.name} footer={userBlock} />
        <div className="shell-main">
          <header className="topbar">
            <span className="brand only-mobile">HealthcareOS</span>
            <span className="page-title only-desktop">{current?.label ?? ''}</span>
            <span className="spacer" />
            {orgs.length > 1 ? (
              <select aria-label="Cơ sở" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.organizationId} value={o.organizationId}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="org">{orgs[0]?.name ?? 'Chưa có cơ sở'}</span>
            )}
            {can.notifications(roles) && <NotificationBell key={orgId} />}
          </header>
          <main>
        {apps.length === 0 ? (
          <div className="alert warn">
            Tài khoản chưa được gán vai trò nào tại cơ sở này. Liên hệ quản trị để được cấp quyền.
          </div>
        ) : route.name === 'patients' ? (
          <PatientsScreen />
        ) : route.name === 'patient' ? (
          <PatientDetail id={route.id} />
        ) : route.name === 'encounter' ? (
          <EncounterScreen id={route.id} />
        ) : route.name === 'queue' ? (
          <QueueScreen />
        ) : route.name === 'bookings' ? (
          <BookingsScreen />
        ) : route.name === 'finance' ? (
          <FinanceScreen />
        ) : route.name === 'financeCase' ? (
          <CaseScreen id={route.id} />
        ) : route.name === 'financeShift' ? (
          <ShiftScreen id={route.id} />
        ) : route.name === 'reports' ? (
          <ReportsScreen />
        ) : route.name === 'forecast' ? (
          <ForecastScreen />
        ) : route.name === 'decision' ? (
          <DecisionScreen />
        ) : route.name === 'integrations' ? (
          <IntegrationsScreen />
        ) : route.name === 'inbox' ? (
          <InboxScreen />
        ) : route.name === 'pharmacy' ? (
          <PharmacyScreen />
        ) : route.name === 'handover' ? (
          <HandoverScreen />
        ) : route.name === 'equipment' ? (
          <EquipmentScreen />
        ) : route.name === 'device' ? (
          <DeviceScreen code={route.code} qr={route.qr} />
        ) : route.name === 'governance' ? (
          <GovernanceScreen />
        ) : route.name === 'admin' ? (
          <AdminScreen />
        ) : route.name === 'staff' ? (
          <StaffScreen />
        ) : route.name === 'today' ? (
          <TodayScreen />
        ) : null}
          </main>
        </div>
      </div>
      {apps.length > 0 && <BottomBar apps={apps} pins={pins} routeName={route.name} launcherOpen={launcher} onLauncher={() => setLauncher((x) => !x)} />}
      {launcher && <Launcher apps={apps} pins={pins} onToggle={toggle} onReset={reset} custom={custom} onClose={closeLauncher} footer={userBlock} />}
    </SessionContext.Provider>
  );
}

function App() {
  const [state, setState] = useState<{ me?: Me; error?: unknown }>({});
  useEffect(() => {
    (async () => {
      const ok = await initAuth();
      if (!ok) return login();
      if (!claims()) return login();
      const r = await api<Me>('GET', '/api/me');
      setState({ me: r.data });
    })().catch((e: unknown) => setState({ error: e }));
  }, []);
  if (state.error) {
    return (
      <main>
        <ErrorBox error={state.error} />
        {(state.error as { detail?: string } | undefined)?.detail === 'AUTH_MFA_REQUIRED' ? (
          <button onClick={() => void login({ reauth: true })}>Đăng nhập lại có OTP</button>
        ) : (
          <button onClick={() => void login()}>Đăng nhập lại</button>
        )}
      </main>
    );
  }
  if (!state.me) return <main className="loading">Đang đăng nhập…</main>;
  return <Shell me={state.me} />;
}

/** Các trang KHÔNG đăng nhập: chọn theo hash trước khi khởi tạo đăng nhập (đổi hash giữa chừng => tải lại trang). */
function Root() {
  const hash = useHash();
  // Màn hình TV gọi số: khoá hiển thị nằm trong fragment (#) nên không bao giờ gửi lên máy chủ trong URL.
  const board = /^#\/board\/([A-Za-z0-9_-]{43})$/.exec(hash);
  if (board) return <BoardScreen displayKey={board[1]!} />;
  // Cổng đặt lịch khám online.
  const book = /^#\/book\/([a-z0-9][a-z0-9-]{2,39})(\/tra-cuu)?\/?$/.exec(hash);
  if (book) return book[2] ? <PublicLookupScreen slug={book[1]!} /> : <PublicBookingScreen slug={book[1]!} />;
  return <App />;
}
// HCOS-F20: cổng bệnh nhân / link chia sẻ chạy ở bundle riêng (portal.html) — chuyển trước khi khởi tạo đăng nhập nhân viên.
const TO_PORTAL = /^#\/(portal|s)\//.test(location.hash);
const PUBLIC_RE = /^#\/(board|book)\//;
const startedPublic = PUBLIC_RE.test(location.hash);
addEventListener('hashchange', () => {
  // Rời trang công khai sang ứng dụng (hoặc ngược lại) => tải lại để luồng đăng nhập chạy sạch.
  if (PUBLIC_RE.test(location.hash) !== startedPublic) location.reload();
});
if (TO_PORTAL) location.replace(`portal.html${location.hash}`);
else createRoot(document.getElementById('root')!).render(<Root />);
