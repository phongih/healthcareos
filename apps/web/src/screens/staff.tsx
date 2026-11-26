/**
 * HCOS-F21 | Nhân sự & cơ sở.
 *  - Nhân viên trong phạm vi người dùng (quản lý cơ sở: cơ sở mình; quản trị hệ thống: mọi cơ sở): vai trò theo cơ sở, trạng thái.
 *  - Thêm nhân viên => tài khoản Keycloak mới với MẬT KHẨU TẠM hiện MỘT lần (bắt đổi mật khẩu + cài OTP ở lần đầu đăng nhập).
 *  - Cấp vai trò, thu hồi (bắt buộc lý do), khoá / mở khoá, đặt lại mật khẩu + OTP.
 *  - Cơ sở (quản trị hệ thống): tạo cơ sở mới, tuỳ chọn sao chép cấu hình; ngừng / mở lại.
 */
import { useState, type FormEvent } from 'react';

import { api } from '../lib/api';
import { ROLE_LABEL, useSession, type Role } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

interface Membership {
  membershipId: string; organizationId: string; organizationName: string; role: Role; status: string; validFrom: string; validTo: string | null;
  grantedByName: string | null; revokedAt: string | null; revokedByName: string | null; revokeReason: string | null; revocable: boolean;
}
interface Staff { userId: string; displayName: string; username: string | null; email: string | null; status: string; memberships: Membership[]; manageable: boolean; self: boolean }
interface StaffList { staff: Staff[]; grantableRoles: Role[]; tenantAdmin: boolean; managedOrganizationIds: string[] | null }
interface Org { organizationId: string; code: string; name: string; status: string; staff: number; rooms: number; prices: number }

const STATUS: Record<string, string> = { active: 'Đang hoạt động', locked: 'Đã khoá', invited: 'Chờ kích hoạt', disabled: 'Vô hiệu' };
const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' }).format(new Date(iso)) : '—');

/** Mật khẩu tạm: hiện một lần, có nút chép; nhắc giao qua kênh riêng. */
function TempPassword({ who, password, onClose }: { who: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card inset" role="alert">
      <strong>Mật khẩu tạm của {who}</strong>
      <p>
        <code className="select-all big">{password}</code>{' '}
        <button className="secondary" onClick={() => void navigator.clipboard?.writeText(password).then(() => setCopied(true), () => undefined)}>{copied ? 'Đã chép' : 'Chép'}</button>
      </p>
      <p className="muted">
        Chỉ hiện <strong>một lần</strong> — hệ thống không lưu. Giao trực tiếp hoặc qua kênh riêng (không dán vào nhóm chat chung). Lần đầu đăng nhập nhân viên phải
        đổi mật khẩu và cài ứng dụng OTP.
      </p>
      <button onClick={onClose}>Tôi đã giao mật khẩu</button>
    </div>
  );
}

export function StaffScreen() {
  const { orgId } = useSession();
  const orgs = useLoad(() => api<{ organizations: Org[]; canManage: boolean }>('GET', '/api/admin/organizations').then((r) => r.data), []);
  const [filterOrg, setFilterOrg] = useState<string>(orgId);
  const [revoked, setRevoked] = useState(false);
  const list = useLoad(
    () => api<StaffList>('GET', `/api/admin/staff?${new URLSearchParams({ ...(filterOrg ? { organization: filterOrg } : {}), ...(revoked ? { revoked: 'true' } : {}) })}`).then((r) => r.data),
    [filterOrg, revoked],
  );
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const data = list.data;
  const managedOrgs = (orgs.data?.organizations ?? []).filter((o) => o.status === 'active' && (!data || data.tenantAdmin || data.managedOrganizationIds?.includes(o.organizationId)));
  return (
    <div className="stack">
      {secret && <TempPassword who={secret.who} password={secret.password} onClose={() => setSecret(null)} />}
      <Card
        title={`Nhân sự${data ? ` (${data.staff.length})` : ''}`}
        actions={
          <div className="row">
            <select aria-label="Lọc cơ sở" value={filterOrg} onChange={(e) => setFilterOrg(e.target.value)}>
              {data?.tenantAdmin && <option value="">Tất cả cơ sở</option>}
              {managedOrgs.map((o) => <option key={o.organizationId} value={o.organizationId}>{o.name}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={revoked} onChange={(e) => setRevoked(e.target.checked)} /> Cả vai trò đã thu hồi</label>
            {!adding && <button onClick={() => { setAdding(true); setMsg(null); }}>+ Thêm nhân viên</button>}
          </div>
        }
      >
        <ErrorBox error={list.error ?? orgs.error} />
        {msg && <Notice kind="ok">{msg}</Notice>}
        {adding && data && (
          <AddStaff
            orgs={managedOrgs} defaultOrg={filterOrg || orgId} roles={data.grantableRoles}
            onDone={(r) => {
              setAdding(false);
              if (r) {
                if (r.password) setSecret({ who: r.who, password: r.password });
                else setMsg(`Đã liên kết tài khoản Keycloak có sẵn cho ${r.who}.`);
                list.reload();
              }
            }}
          />
        )}
        {data && (
          <table>
            <thead><tr><th>Nhân viên</th><th>Vai trò tại cơ sở</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {data.staff.map((s) => (
                <StaffRow
                  key={s.userId} s={s} open={open === s.userId} onToggle={() => setOpen(open === s.userId ? null : s.userId)}
                  orgs={managedOrgs} roles={data.grantableRoles} defaultOrg={filterOrg || orgId}
                  onChanged={(m) => { setMsg(m); list.reload(); }} onSecret={(p) => setSecret({ who: s.displayName, password: p })}
                />
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">Thu hồi vai trò / khoá tài khoản có hiệu lực ngay ở API; phiên đăng nhập Keycloak của người bị khoá bị đăng xuất.</p>
      </Card>
      {orgs.data && <Organizations data={orgs.data} reload={orgs.reload} />}
    </div>
  );
}

function AddStaff({ orgs, defaultOrg, roles, onDone }: { orgs: Org[]; defaultOrg: string; roles: Role[]; onDone: (r: { who: string; password: string | null } | null) => void }) {
  const [displayName, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState(orgs.some((o) => o.organizationId === defaultOrg) ? defaultOrg : (orgs[0]?.organizationId ?? ''));
  const [picked, setPicked] = useState<Role[]>([]);
  const [validTo, setValidTo] = useState('');
  const [link, setLink] = useState(false);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ temporaryPassword: string | null }>('POST', '/api/admin/staff', {
      body: { displayName, username, organizationId: org, roles: picked, ...(email ? { email } : {}), ...(validTo ? { validTo } : {}), ...(link ? { linkExisting: true } : {}) },
    });
    onDone({ who: displayName, password: r.data.temporaryPassword });
  });
  return (
    <form className="card inset" onSubmit={(e) => void save.run(e)}>
      <div className="row wrap">
        <Field label="Họ tên *"><input required minLength={2} maxLength={120} value={displayName} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Tên đăng nhập *" hint="chữ thường, số, dấu chấm / gạch — vd. nguyen.lan">
          <input required pattern="[a-z0-9][a-z0-9._-]{2,63}" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </Field>
        <Field label="Email công việc" hint="nên có, để Keycloak không hỏi lại"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      </div>
      <div className="row wrap">
        <Field label="Cơ sở *">
          <select value={org} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o) => <option key={o.organizationId} value={o.organizationId}>{o.name}</option>)}</select>
        </Field>
        <Field label="Hết hạn" hint="để trống = không thời hạn (vd. thực tập sinh: đặt ngày)"><input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></Field>
      </div>
      <fieldset className="roles">
        <legend>Vai trò *</legend>
        {roles.map((r) => (
          <label key={r} className="check">
            <input type="checkbox" checked={picked.includes(r)} onChange={(e) => setPicked(e.target.checked ? [...picked, r] : picked.filter((x) => x !== r))} /> {ROLE_LABEL[r]}
          </label>
        ))}
      </fieldset>
      <label className="check"><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> Tài khoản đã có sẵn trên Keycloak — chỉ liên kết, không tạo mới</label>
      <ErrorBox error={save.error} />
      <div className="row">
        <button disabled={save.busy || !displayName || !username || !org || picked.length === 0}>{link ? 'Liên kết + cấp quyền' : 'Tạo tài khoản'}</button>
        <button type="button" className="link" onClick={() => onDone(null)}>Huỷ</button>
      </div>
    </form>
  );
}

function StaffRow({ s, open, onToggle, orgs, roles, defaultOrg, onChanged, onSecret }: {
  s: Staff; open: boolean; onToggle: () => void; orgs: Org[]; roles: Role[]; defaultOrg: string; onChanged: (m: string) => void; onSecret: (p: string) => void;
}) {
  const active = s.memberships.filter((m) => m.status === 'active');
  const ask = (q: string) => {
    const r = prompt(q);
    return r && r.trim().length >= 3 ? r.trim() : null;
  };
  const revoke = useAction(async (m: Membership) => {
    const reason = ask(`Lý do thu hồi "${ROLE_LABEL[m.role]}" tại ${m.organizationName} (bắt buộc):`);
    if (!reason) return;
    await api('POST', `/api/admin/memberships/${m.membershipId}/revoke`, { body: { reason } });
    onChanged(`Đã thu hồi ${ROLE_LABEL[m.role]} của ${s.displayName}.`);
  });
  const status = useAction(async () => {
    const next = s.status === 'active' ? 'locked' : 'active';
    const reason = ask(next === 'locked' ? `Lý do khoá tài khoản ${s.displayName} (bắt buộc):` : `Lý do mở khoá ${s.displayName}:`);
    if (!reason) return;
    await api('POST', `/api/admin/staff/${s.userId}/status`, { body: { status: next, reason } });
    onChanged(next === 'locked' ? `Đã khoá ${s.displayName} và đăng xuất mọi phiên.` : `Đã mở khoá ${s.displayName}.`);
  });
  const reset = useAction(async () => {
    const reason = ask(`Đặt lại mật khẩu + OTP cho ${s.displayName}. Lý do (vd. mất điện thoại):`);
    if (!reason) return;
    const r = await api<{ temporaryPassword: string }>('POST', `/api/admin/staff/${s.userId}/reset`, { body: { reason } });
    onSecret(r.data.temporaryPassword);
    onChanged(`Đã đặt lại mật khẩu + OTP cho ${s.displayName}.`);
  });
  return (
    <>
      <tr>
        <td>
          <strong>{s.displayName}</strong>{s.self && <span className="muted"> (bạn)</span>}
          <div className="muted">{s.username ?? '—'}{s.email ? ` · ${s.email}` : ''}</div>
        </td>
        <td>
          {active.length === 0 ? <span className="muted">Không còn vai trò</span> : active.map((m) => (
            <span key={m.membershipId} className="badge" title={m.organizationName}>{ROLE_LABEL[m.role]} · {m.organizationName}{m.validTo ? ` · đến ${fmt(m.validTo)}` : ''}</span>
          ))}
        </td>
        <td className="nowrap"><span className={`badge ${s.status === 'active' ? 'ok' : s.status === 'locked' ? 'danger' : ''}`}>{STATUS[s.status] ?? s.status}</span></td>
        <td>{(s.manageable || roles.length > 0) && !s.self && <button className="link" onClick={onToggle}>{open ? 'Đóng' : 'Quản lý'}</button>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4}>
            <ErrorBox error={revoke.error ?? status.error ?? reset.error} />
            <table>
              <thead><tr><th>Vai trò</th><th>Cơ sở</th><th>Hiệu lực</th><th>Cấp bởi</th><th>Trạng thái</th><th /></tr></thead>
              <tbody>
                {s.memberships.map((m) => (
                  <tr key={m.membershipId}>
                    <td>{ROLE_LABEL[m.role]}</td>
                    <td>{m.organizationName}</td>
                    <td>{fmt(m.validFrom)} – {m.validTo ? fmt(m.validTo) : 'không thời hạn'}</td>
                    <td>{m.grantedByName ?? '—'}</td>
                    <td>{m.status === 'revoked' ? <span title={m.revokeReason ?? ''}>Đã thu hồi {fmt(m.revokedAt)}{m.revokedByName ? ` (${m.revokedByName})` : ''}: {m.revokeReason}</span> : 'Đang hiệu lực'}</td>
                    <td>{m.revocable && <button className="link danger" disabled={revoke.busy} onClick={() => void revoke.run(m)}>Thu hồi</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.status === 'active' && <Grant s={s} orgs={orgs} roles={roles} defaultOrg={defaultOrg} onDone={onChanged} />}
            {s.manageable && (
              <div className="row">
                <button className="secondary" disabled={status.busy} onClick={() => void status.run()}>{s.status === 'active' ? 'Khoá tài khoản' : 'Mở khoá'}</button>
                {s.status === 'active' && <button className="secondary" disabled={reset.busy} onClick={() => void reset.run()}>Đặt lại mật khẩu + OTP</button>}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Grant({ s, orgs, roles, defaultOrg, onDone }: { s: Staff; orgs: Org[]; roles: Role[]; defaultOrg: string; onDone: (m: string) => void }) {
  const [org, setOrg] = useState(orgs.some((o) => o.organizationId === defaultOrg) ? defaultOrg : (orgs[0]?.organizationId ?? ''));
  const [role, setRole] = useState<Role | ''>('');
  const [validTo, setValidTo] = useState('');
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await api('POST', `/api/admin/staff/${s.userId}/roles`, { body: { organizationId: org, role, ...(validTo ? { validTo } : {}) } });
    onDone(`Đã cấp ${ROLE_LABEL[role as Role]} cho ${s.displayName}.`);
    setRole('');
  });
  return (
    <form className="row wrap" onSubmit={(e) => void save.run(e)}>
      <Field label="Cấp thêm vai trò">
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="">— Chọn —</option>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="Tại cơ sở"><select value={org} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o) => <option key={o.organizationId} value={o.organizationId}>{o.name}</option>)}</select></Field>
      <Field label="Hết hạn"><input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></Field>
      <button disabled={save.busy || !role || !org}>Cấp</button>
      <ErrorBox error={save.error} />
    </form>
  );
}

const COPY: Array<[string, string]> = [
  ['servicePoints', 'Phòng khám (+ số chỗ đặt lịch / sức khám)'], ['priceList', 'Bảng giá dịch vụ'], ['supplyNorms', 'Định mức vật tư theo dịch vụ'],
  ['deviceRequirements', 'Dịch vụ cần thiết bị'], ['financeSettings', 'Tạm ứng mặc định (KHÔNG chép tài khoản ngân hàng)'], ['forecastSettings', 'Thông số dự báo'],
  ['handoverDesks', 'Quầy trả'], ['decisionRules', 'Luật Decision Engine'], ['mrnSettings', 'Cài đặt mã bệnh nhân'],
];

function Organizations({ data, reload }: { data: { organizations: Org[]; canManage: boolean }; reload: () => void }) {
  const [form, setForm] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [from, setFrom] = useState(data.organizations.find((o) => o.status === 'active')?.organizationId ?? '');
  const [copy, setCopy] = useState<Record<string, boolean>>(Object.fromEntries(COPY.map(([k]) => [k, k !== 'decisionRules'])));
  const [msg, setMsg] = useState<string | null>(null);
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ copied: Record<string, number> }>('POST', '/api/admin/organizations', {
      body: { code, name, ...(prefix ? { mrnPrefix: prefix } : {}), ...(from ? { copyFrom: from, copy } : {}) },
    });
    const c = Object.entries(r.data.copied).filter(([, n]) => n > 0).map(([k, n]) => `${COPY.find(([x]) => x === k)?.[1].split(' (')[0] ?? k}: ${n}`);
    setMsg(`Đã tạo ${name}.${c.length ? ` Đã chép — ${c.join('; ')}.` : ''} Cấp vai trò quản lý cho người phụ trách ở bảng Nhân sự; cổng đặt lịch, kho, thiết bị, tài khoản ngân hàng cấu hình riêng.`);
    setForm(false); setCode(''); setName(''); setPrefix('');
    reload();
  });
  const toggle = useAction(async (o: Org) => {
    const next = o.status === 'active' ? 'inactive' : 'active';
    const reason = prompt(`${next === 'inactive' ? 'Ngừng' : 'Mở lại'} cơ sở ${o.name}. Lý do (bắt buộc):`);
    if (!reason || reason.trim().length < 3) return;
    await api('POST', `/api/admin/organizations/${o.organizationId}/status`, { body: { status: next, reason: reason.trim() } });
    reload();
  });
  return (
    <Card title={`Cơ sở (${data.organizations.length})`} actions={data.canManage && !form ? <button onClick={() => { setForm(true); setMsg(null); }}>+ Tạo cơ sở</button> : undefined}>
      <ErrorBox error={toggle.error} />
      {msg && <Notice kind="ok">{msg}</Notice>}
      {form && (
        <form className="card inset" onSubmit={(e) => void create.run(e)}>
          <div className="row wrap">
            <Field label="Tên cơ sở *"><input required minLength={3} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Mã *" hint="chữ thường, số, gạch — vd. pk-quan-7"><input required pattern="[a-z0-9][a-z0-9-]{1,39}" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} /></Field>
            <Field label="Tiền tố mã BN" hint="1–4 chữ in hoa, nên khác cơ sở khác (vd. Q7)"><input pattern="[A-Za-z]{1,4}" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} /></Field>
          </div>
          <Field label="Sao chép cấu hình từ">
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">— Không sao chép (cơ sở trống) —</option>
              {data.organizations.filter((o) => o.status === 'active').map((o) => <option key={o.organizationId} value={o.organizationId}>{o.name}</option>)}
            </select>
          </Field>
          {from && (
            <fieldset className="roles">
              <legend>Sao chép</legend>
              {COPY.map(([k, label]) => (
                <label key={k} className="check"><input type="checkbox" checked={!!copy[k]} onChange={(e) => setCopy({ ...copy, [k]: e.target.checked })} /> {label}</label>
              ))}
            </fieldset>
          )}
          <p className="muted">Không sao chép người bệnh, phiếu thu, ca, kho / lô thuốc, thiết bị, cổng đặt lịch, kết nối ngoài, tài khoản ngân hàng.</p>
          <ErrorBox error={create.error} />
          <div className="row">
            <button disabled={create.busy}>Tạo cơ sở</button>
            <button type="button" className="link" onClick={() => setForm(false)}>Huỷ</button>
          </div>
        </form>
      )}
      <table>
        <thead><tr><th>Cơ sở</th><th>Mã</th><th>Nhân viên</th><th>Phòng khám</th><th>Dịch vụ có giá</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>
          {data.organizations.map((o) => (
            <tr key={o.organizationId}>
              <td>{o.name}</td><td>{o.code}</td><td>{o.staff}</td><td>{o.rooms}</td><td>{o.prices}</td>
              <td className="nowrap">{o.status === 'active' ? <span className="badge ok">Đang hoạt động</span> : <span className="badge danger">Đã ngừng</span>}</td>
              <td>{data.canManage && <button className="link" disabled={toggle.busy} onClick={() => void toggle.run(o)}>{o.status === 'active' ? 'Ngừng' : 'Mở lại'}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
