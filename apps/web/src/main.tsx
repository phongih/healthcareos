import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './lib/api';
import { claims, initAuth, login, logout } from './lib/auth';
import { can, organizationsOf, ROLE_LABEL, rolesAt, SessionContext, type Me, type Session } from './lib/session';
import { InboxScreen, NotificationBell } from './lib/notifications';
import { ErrorBox } from './lib/ui';
import { AdminScreen } from './screens/admin';
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

function Shell({ me }: { me: Me }) {
  const orgs = organizationsOf(me);
  const [orgId, setOrgId] = useState(orgs[0]?.organizationId ?? '');
  const roles = useMemo(() => rolesAt(me, orgId), [me, orgId]);
  const restricted = me.memberships.some((m) => m.organization.organizationId === orgId && m.accessPolicyId);
  const session: Session = { me, orgId, setOrgId, roles, restricted };
  const route = parseRoute(useHash());

  const tabs = [
    can.patients(roles) && { hash: '#/patients', label: 'Bệnh nhân', active: ['patients', 'patient', 'encounter'].includes(route.name) },
    can.queue(roles) && { hash: '#/queue', label: 'Hàng đợi', active: route.name === 'queue' },
    can.bookings(roles) && { hash: '#/bookings', label: 'Lịch hẹn', active: route.name === 'bookings' },
    can.finance(roles) && { hash: '#/finance', label: 'Thu ngân', active: route.name.startsWith('finance') },
    can.reports(roles) && { hash: '#/reports', label: 'Báo cáo', active: route.name === 'reports' },
    can.forecast(roles) && { hash: '#/forecast', label: 'Dự báo', active: route.name === 'forecast' },
    can.decision(roles) && { hash: '#/decision', label: 'Decision Engine', active: route.name === 'decision' },
    can.integrations(roles) && { hash: '#/integrations', label: 'Tích hợp', active: route.name === 'integrations' },
    can.pharmacy(roles) && { hash: '#/pharmacy', label: 'Dược', active: route.name === 'pharmacy' },
    can.handover(roles) && { hash: '#/handover', label: 'Quầy trả', active: route.name === 'handover' },
    can.equipment(roles) && { hash: '#/equipment', label: 'Thiết bị', active: route.name === 'equipment' || route.name === 'device' },
    can.governance(roles) && { hash: '#/governance', label: 'Quản trị dữ liệu', active: route.name === 'governance' },
    can.admin(roles) && { hash: '#/admin', label: 'Quản trị', active: route.name === 'admin' },
  ].filter(Boolean) as Array<{ hash: string; label: string; active: boolean }>;

  const firstTab = tabs[0]?.hash;
  useEffect(() => {
    if (route.name === 'home' && firstTab) location.replace(firstTab);
  }, [route.name, firstTab]);

  return (
    <SessionContext.Provider value={session}>
      {ENV_LABEL && (
        <div className="env-banner" role="alert">
          {ENV_LABEL}
        </div>
      )}
      <header className="topbar">
        <span className="brand">HealthcareOS</span>
        <nav>
          {tabs.map((t) => (
            <a key={t.hash} href={t.hash} className={t.active ? 'active' : ''}>
              {t.label}
            </a>
          ))}
        </nav>
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
        <span className="user" title={[...roles].map((r) => ROLE_LABEL[r]).join(', ')}>
          {me.user.displayName ?? me.user.email ?? 'Người dùng'}
        </span>
        <button className="link" onClick={logout}>
          Đăng xuất
        </button>
      </header>
      <main>
        {tabs.length === 0 ? (
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
        ) : null}
      </main>
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
