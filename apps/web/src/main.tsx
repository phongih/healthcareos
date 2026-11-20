import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './lib/api';
import { claims, initAuth, login, logout } from './lib/auth';
import { can, organizationsOf, ROLE_LABEL, rolesAt, SessionContext, type Me, type Session } from './lib/session';
import { ErrorBox } from './lib/ui';
import { AdminScreen } from './screens/admin';
import { EncounterScreen } from './screens/encounter';
import { PatientDetail, PatientsScreen } from './screens/patients';
import { PharmacyScreen } from './screens/pharmacy';

type Route =
  | { name: 'patients' }
  | { name: 'patient'; id: string }
  | { name: 'encounter'; id: string }
  | { name: 'pharmacy' }
  | { name: 'admin' }
  | { name: 'home' };

const UUID = '[0-9a-fA-F-]{36}';
function parseRoute(hash: string): Route {
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^#/patients/(${UUID})$`).exec(hash))) return { name: 'patient', id: m[1]! };
  if ((m = new RegExp(`^#/encounters/(${UUID})$`).exec(hash))) return { name: 'encounter', id: m[1]! };
  if (hash.startsWith('#/patients')) return { name: 'patients' };
  if (hash.startsWith('#/pharmacy')) return { name: 'pharmacy' };
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
    can.pharmacy(roles) && { hash: '#/pharmacy', label: 'Dược', active: route.name === 'pharmacy' },
    can.admin(roles) && { hash: '#/admin', label: 'Quản trị', active: route.name === 'admin' },
  ].filter(Boolean) as Array<{ hash: string; label: string; active: boolean }>;

  const firstTab = tabs[0]?.hash;
  useEffect(() => {
    if (route.name === 'home' && firstTab) location.replace(firstTab);
  }, [route.name, firstTab]);

  return (
    <SessionContext.Provider value={session}>
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
        ) : route.name === 'pharmacy' ? (
          <PharmacyScreen />
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
        <button onClick={() => void login()}>Đăng nhập lại</button>
      </main>
    );
  }
  if (!state.me) return <main className="loading">Đang đăng nhập…</main>;
  return <Shell me={state.me} />;
}

createRoot(document.getElementById('root')!).render(<App />);
