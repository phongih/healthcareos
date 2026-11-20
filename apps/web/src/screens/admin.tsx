/** Quản trị (tenant_admin): access policy — xem, tạo, sửa, ngừng; gắn policy cho từng membership. */
import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { ROLE_LABEL, useSession, type Role } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

interface Policy { policyId: string; name: string; description: string | null; status: 'active' | 'retired'; rules: unknown[]; version: number; updatedAt: string }
interface PolicyDetail { policy: Policy; versions: Array<{ version: number; status: string; changedBy: string; changedAt: string }>; activeAssignments: number }
interface MembershipItem {
  membership: { membershipId: string; role: Role; status: string; accessPolicyId: string | null; version: number };
  user: { userId: string; displayName: string | null; email: string | null; status: string };
}

const EXAMPLE = JSON.stringify(
  [
    { action: 'patient:read', hiddenFields: ['identifiers'] },
    { action: 'encounter:read', criteria: { encounterStatus: ['in_progress'] }, hiddenFields: ['conditions'] },
    { action: 'observation:write', criteria: { codes: ['http://loinc.org|8310-5', 'http://loinc.org|59408-5'] }, readonlyFields: ['effectiveAt'] },
  ],
  null,
  2,
);

function parseRules(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Luật phải là JSON hợp lệ (một mảng các luật).');
  }
}

const rulesError = (e: unknown): string | null =>
  e instanceof ApiError && e.status === 422 && (e.body as { path?: string } | undefined)?.path
    ? `Luật không hợp lệ — ${(e.body as { message?: string }).message ?? (e.body as { path: string }).path}`
    : null;

export function AdminScreen() {
  const list = useLoad(() => api<{ policies: Policy[] }>('GET', '/api/access-policies').then((r) => r.data.policies), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      <Card title="Access policy" actions={<button onClick={() => { setCreating(true); setSelected(null); }}>+ Policy mới</button>}>
        <p className="muted">
          Policy chỉ <strong>thu hẹp</strong> quyền của vai trò (không bao giờ cấp thêm). Gắn policy cho từng membership ở bảng bên dưới.
        </p>
        <ErrorBox error={list.error} />
        {list.data && list.data.length === 0 && <Notice>Chưa có policy nào.</Notice>}
        {list.data && list.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th>Trạng thái</th>
                <th>Số luật</th>
                <th>Phiên bản</th>
                <th>Cập nhật</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.policyId} className={`clickable ${selected === p.policyId ? 'selected' : ''}`} onClick={() => { setSelected(p.policyId); setCreating(false); }}>
                  <td>{p.name}</td>
                  <td>{p.status === 'active' ? 'Đang dùng' : 'Đã ngừng'}</td>
                  <td>{p.rules.length}</td>
                  <td>v{p.version}</td>
                  <td>{fmtDateTime(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && <CreatePolicy onDone={(id) => { setCreating(false); setSelected(id); list.reload(); }} />}
      {selected && <PolicyEditor key={selected} id={selected} onChanged={list.reload} />}
      {list.data && <Memberships policies={list.data} />}
      <Catalog />
    </div>
  );
}

function CreatePolicy({ onDone }: { onDone: (id: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState(EXAMPLE);
  const save = useAction(async () => {
    const r = await api<Policy>('POST', '/api/access-policies', { body: { name: name.trim(), description: description.trim() || null, rules: parseRules(rules) } });
    onDone(r.data.policyId);
  });
  return (
    <Card title="Policy mới">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <Field label="Tên *">
          <input required minLength={3} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Mô tả">
          <input maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <RulesEditor value={rules} onChange={setRules} />
        <button type="submit" disabled={save.busy}>
          Tạo policy
        </button>
      </form>
      {rulesError(save.error) ? <div className="alert error">{rulesError(save.error)}</div> : <ErrorBox error={save.error} />}
    </Card>
  );
}

function RulesEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [result, setResult] = useState<string | null>(null);
  const check = useAction(async () => {
    await api('POST', '/api/access-policies/validate', { body: { rules: parseRules(value) } });
    setResult('Luật hợp lệ.');
  });
  return (
    <div className="sub">
      <Field label="Luật (JSON)" hint="Xem danh mục action / điều kiện / trường ở cuối trang">
        <textarea rows={12} spellCheck={false} className="mono" value={value} onChange={(e) => { onChange(e.target.value); setResult(null); check.setError(null); }} />
      </Field>
      <button type="button" onClick={() => void check.run()} disabled={check.busy}>
        Kiểm tra luật
      </button>
      {result && <Notice kind="ok">{result}</Notice>}
      {rulesError(check.error) ? <div className="alert error">{rulesError(check.error)}</div> : <ErrorBox error={check.error} />}
    </div>
  );
}

function PolicyEditor({ id, onChanged }: { id: string; onChanged: () => void }) {
  const d = useLoad(() => api<PolicyDetail>('GET', `/api/access-policies/${id}`).then((r) => r.data), [id]);
  const [rules, setRules] = useState('');
  useEffect(() => {
    if (d.data) setRules(JSON.stringify(d.data.policy.rules, null, 2));
  }, [d.data]);
  const p = d.data?.policy;
  const revise = useAction(async () => {
    await api('POST', `/api/access-policies/${id}/revise`, { headers: { 'if-match': `W/"${p!.version}"` }, body: { rules: parseRules(rules) } });
    d.reload();
    onChanged();
  });
  const retire = useAction(async () => {
    if (!confirm(`Ngừng dùng policy "${p!.name}"? Không thể hoàn tác.`)) return;
    await api('POST', `/api/access-policies/${id}/retire`, { headers: { 'if-match': `W/"${p!.version}"` } });
    d.reload();
    onChanged();
  });
  const inUse = retire.error instanceof ApiError && (retire.error.body as { error?: string } | undefined)?.error === 'POLICY_IN_USE';
  return (
    <Card
      title={p ? `Policy: ${p.name}` : 'Policy'}
      actions={p?.status === 'active' ? <button className="danger" onClick={() => void retire.run()} disabled={retire.busy}>Ngừng dùng</button> : null}
    >
      <ErrorBox error={d.error} />
      {p && d.data && (
        <>
          <p className="muted">
            {p.description ?? 'Không có mô tả'} · v{p.version} · đang gắn cho {d.data.activeAssignments} membership
          </p>
          {p.status === 'active' ? (
            <>
              <RulesEditor value={rules} onChange={setRules} />
              <button onClick={() => void revise.run()} disabled={revise.busy}>
                Lưu phiên bản mới
              </button>
              {rulesError(revise.error) ? <div className="alert error">{rulesError(revise.error)}</div> : <ErrorBox error={revise.error} />}
            </>
          ) : (
            <pre className="mono">{rules}</pre>
          )}
          {inUse ? <div className="alert warn">Policy còn đang gắn cho membership — gỡ hết ở bảng bên dưới rồi mới ngừng dùng được.</div> : <ErrorBox error={retire.error} />}
          <details className="sub">
            <summary>Lịch sử phiên bản ({d.data.versions.length})</summary>
            <ul className="list">
              {d.data.versions.map((v) => (
                <li key={v.version}>
                  v{v.version} · {v.status} · {fmtDateTime(v.changedAt)}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Card>
  );
}

function Memberships({ policies }: { policies: Policy[] }) {
  const { orgId, me } = useSession();
  const list = useLoad(() => api<{ memberships: MembershipItem[] }>('GET', `/api/memberships?organization=${orgId}`).then((r) => r.data.memberships), [orgId]);
  const assign = useAction(async (m: MembershipItem, policyId: string) => {
    await api('POST', `/api/memberships/${m.membership.membershipId}/access-policy`, {
      headers: { 'if-match': `W/"${m.membership.version}"` },
      body: { policyId: policyId || null },
    });
    list.reload();
  });
  const active = policies.filter((p) => p.status === 'active');
  const name = (id: string | null) => (id ? (policies.find((p) => p.policyId === id)?.name ?? id.slice(0, 8)) : '— Không giới hạn —');
  return (
    <Card title="Nhân sự tại cơ sở">
      <ErrorBox error={list.error ?? assign.error} />
      {list.data && (
        <table>
          <thead>
            <tr>
              <th>Người dùng</th>
              <th>Vai trò</th>
              <th>Trạng thái</th>
              <th>Access policy</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((m) => {
              const self = m.user.userId === me.user.userId;
              return (
                <tr key={m.membership.membershipId}>
                  <td>{m.user.displayName ?? m.user.email ?? m.user.userId}</td>
                  <td>{ROLE_LABEL[m.membership.role] ?? m.membership.role}</td>
                  <td>{m.membership.status}</td>
                  <td>
                    {self ? (
                      <span className="muted" title="Không được tự đổi policy của chính mình">
                        {name(m.membership.accessPolicyId)} (của bạn)
                      </span>
                    ) : (
                      <select
                        aria-label={`Policy cho ${m.user.displayName ?? ''} ${m.membership.role}`}
                        value={m.membership.accessPolicyId ?? ''}
                        disabled={assign.busy || m.membership.status !== 'active'}
                        onChange={(e) => void assign.run(m, e.target.value)}
                      >
                        <option value="">— Không giới hạn —</option>
                        {active.map((p) => (
                          <option key={p.policyId} value={p.policyId}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Catalog() {
  const [open, setOpen] = useState(false);
  const cat = useLoad(
    () => (open ? api<{ actions: Record<string, { description: string; criteria: string[]; hiddenFields: string[]; readonlyFields: string[] }> }>('GET', '/api/access-policies/catalog').then((r) => r.data.actions) : Promise.resolve(null)),
    [open],
  );
  return (
    <details className="card" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Danh mục action / điều kiện / trường</summary>
      <ErrorBox error={cat.error} />
      {cat.data && (
        <table>
          <thead>
            <tr>
              <th>action</th>
              <th>Mô tả</th>
              <th>criteria</th>
              <th>hiddenFields</th>
              <th>readonlyFields</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(cat.data).map(([k, v]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td>{v.description}</td>
                <td className="mono">{v.criteria.join(', ')}</td>
                <td className="mono">{v.hiddenFields.join(', ')}</td>
                <td className="mono">{v.readonlyFields.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
