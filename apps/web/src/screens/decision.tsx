/**
 * Decision Engine (HCOS-F11) — quản lý phòng khám (ban giám đốc: chỉ xem).
 * Observe → Detect → Decide → Act. Luật chọn từ danh mục đóng; hành động chỉ là ghi nhật ký, thông báo theo vai trò, gợi ý.
 */
import { useMemo, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { PRIORITY_LABEL } from '../lib/notifications';
import { ROLE_LABEL, useSession, type Role } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

type Op = '<' | '<=' | '>' | '>=' | '=' | '!=';
interface Metric { id: string; label: string; unit: string }
interface Detector { id: string; group: 'clinical' | 'operations' | 'pharmacy' | 'finance'; label: string; description: string; method: string; metrics: Metric[]; targets: string[]; suggestion: string }
interface Catalog { detectors: Detector[]; actions: Array<{ id: string; label: string }>; ops: Op[]; notifyRoles: string[] }
interface Condition { metric: string; op: Op; value: number }
interface Rule {
  ruleId: string; name: string; detector: string; conditions: Condition[]; priority: 1 | 2 | 3; cooldownMinutes: number; actions: string[];
  status: 'active' | 'paused' | 'retired'; version: number; createdByName: string | null; updatedByName: string | null; updatedAt: string;
  lastFiredAt: string | null; events7d: number;
}
interface RuleVersion { version: number; name: string; conditions: Condition[]; priority: number; cooldownMinutes: number; actions: string[]; status: string; changedByName: string | null; changedAt: string }
interface EngineEvent {
  eventId: string; ruleName: string; ruleVersion: number; detector: string; priority: number; title: string; detail: string | null; metrics: Record<string, number | null>;
  link: string | null; detectedAt: string; notifications: Array<{ targetRole: string; status: 'open' | 'handled'; suggestionStatus: string | null }>;
}
interface ActionEntry { actionId: number; eventTitle: string; ruleName: string; action: string; actorType: 'engine' | 'user'; actorName: string | null; outcome: string; note: string | null; at: string }
interface JobRun {
  runId: string; trigger: 'schedule' | 'manual'; triggeredByName: string | null; startedAt: string; finishedAt: string; durationMs: number; status: 'success' | 'partial' | 'failed';
  rulesEvaluated: number; candidates: number; eventsCreated: number; suppressed: number; detail: Array<{ detector: string; ms: number; candidates: number; error: string | null }>; errorCode: string | null;
}
interface Overview {
  rules: { active: number; paused: number }; events24h: number; eventsByPriority24h: { p1: number; p2: number; p3: number };
  openNotifications: number; pendingSuggestions: number; lastRun: JobRun | null; intervalMinutes: number | null;
}
interface Preview { candidates: number; matched: number; suppressed: number; sample: Array<{ title: string; metrics: Record<string, number | null>; link: string | null; inCooldown: boolean }> }

const GROUP: Record<Detector['group'], string> = { clinical: 'Lâm sàng', operations: 'Vận hành', pharmacy: 'Dược', finance: 'Tài chính' };
const ACTION_TEXT: Record<string, string> = {
  log_only: 'Chỉ ghi nhật ký', suggest: 'Gợi ý', human_handled: 'Đánh dấu đã xử lý', human_applied: 'Áp dụng gợi ý', human_dismissed: 'Bỏ qua gợi ý', human_reopened: 'Mở lại',
};
const actionText = (a: string) => ACTION_TEXT[a] ?? (a.startsWith('notify_') ? `Báo ${ROLE_LABEL[a.slice(7) as Role]?.toLowerCase() ?? a.slice(7)}` : a);
const RUN_STATUS: Record<JobRun['status'], string> = { success: 'Thành công', partial: 'Một phần', failed: 'Lỗi' };
const cooldownText = (m: number) => (m === 0 ? 'không chờ' : m % 1440 === 0 ? `chờ ${m / 1440} ngày` : m % 60 === 0 ? `chờ ${m / 60} giờ` : `chờ ${m} phút`);
/** "39,5" / "39.5" => 39,5; "10.000" / "10.000,5" => nghìn có dấu chấm. */
export function parseNum(raw: string): number {
  const t = raw.trim().replace(/\s/g, '');
  if (!t) return NaN;
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''));
  return Number(t);
}
const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

export function DecisionScreen() {
  const { orgId, roles } = useSession();
  const canManage = roles.has('clinic_admin') || roles.has('tenant_admin');
  const [tab, setTab] = useState<'rules' | 'events' | 'actions' | 'runs'>('rules');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const catalog = useLoad(() => api<Catalog>('GET', '/api/decision/catalog').then((r) => r.data), []);
  const ov = useLoad(() => api<Overview>('GET', `/api/decision/overview?organization=${orgId}`).then((r) => r.data), [orgId, tick]);
  const run = useAction(async () => {
    const r = await api<JobRun & { events: Array<{ title: string }> }>('POST', '/api/decision/run', { body: { organizationId: orgId } });
    refresh();
    return r.data;
  });
  const [lastManual, setLastManual] = useState<(JobRun & { events: Array<{ title: string }> }) | null>(null);

  if (forbidden(ov.error)) return <Notice kind="warn">Decision Engine dành cho quản lý phòng khám / ban giám đốc.</Notice>;
  const o = ov.data;
  return (
    <div className="stack">
      <Notice>
        Decision Engine <strong>chỉ quan sát, báo và gợi ý</strong>: không tự sửa hồ sơ bệnh án, tiền hay kho. Gợi ý có nút “Áp dụng” mở đúng màn hình để người
        có quyền tự thao tác. Mọi lần chạy, sự kiện và thao tác đều được ghi nhật ký chỉ-thêm.
      </Notice>
      <ErrorBox error={ov.error ?? catalog.error} />
      {o && (
        <div className="flow">
          <div>
            <span>Observe</span>
            <strong>{catalog.data?.detectors.length ?? '…'}</strong>
            <small>bộ phát hiện · {o.rules.active} luật bật{o.rules.paused ? `, ${o.rules.paused} tạm dừng` : ''}</small>
          </div>
          <div>
            <span>Detect</span>
            <strong>{o.events24h}</strong>
            <small>sự kiện 24 giờ (P1 {o.eventsByPriority24h.p1} · P2 {o.eventsByPriority24h.p2} · P3 {o.eventsByPriority24h.p3})</small>
          </div>
          <div>
            <span>Decide</span>
            <strong>{o.lastRun?.suppressed ?? 0}</strong>
            <small>bị chặn bởi cooldown ở lần chạy gần nhất</small>
          </div>
          <div>
            <span>Act</span>
            <strong>{o.openNotifications}</strong>
            <small>thông báo chưa xử lý · {o.pendingSuggestions} gợi ý chờ</small>
          </div>
        </div>
      )}
      <div className="row wrap">
        {o && (
          <span className="muted small">
            {o.lastRun ? `Lần chạy gần nhất: ${fmtDateTime(o.lastRun.startedAt)} (${o.lastRun.trigger === 'schedule' ? 'theo lịch' : 'bấm tay'}, ${RUN_STATUS[o.lastRun.status].toLowerCase()})` : 'Chưa chạy lần nào.'}
            {' · '}
            {o.intervalMinutes ? `Tự chạy mỗi ${o.intervalMinutes} phút.` : 'Bộ lập lịch đang tắt.'}
          </span>
        )}
        {canManage && (
          <button
            type="button"
            disabled={run.busy}
            onClick={() =>
              void run.run().then((r) => {
                if (r) setLastManual(r);
              })
            }
          >
            {run.busy ? 'Đang chạy…' : 'Chạy ngay'}
          </button>
        )}
      </div>
      <ErrorBox error={run.error} />
      {lastManual && (
        <Notice kind={lastManual.eventsCreated ? 'warn' : 'ok'}>
          Vừa chạy {lastManual.rulesEvaluated} luật: {lastManual.eventsCreated} sự kiện mới, {lastManual.suppressed} bị chặn bởi cooldown ({lastManual.durationMs} ms).
          {lastManual.events.length > 0 && (
            <ul className="tight">
              {lastManual.events.slice(0, 5).map((e, i) => (
                <li key={i}>{e.title}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      <nav className="tabs" aria-label="Decision Engine">
        {(
          [
            ['rules', 'Luật'],
            ['events', 'Sự kiện'],
            ['actions', 'Nhật ký hành động'],
            ['runs', 'Lần chạy'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'active' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </nav>
      {catalog.data &&
        (tab === 'rules' ? (
          <RulesTab catalog={catalog.data} canManage={canManage} tick={tick} onChanged={refresh} />
        ) : tab === 'events' ? (
          <EventsTab catalog={catalog.data} tick={tick} />
        ) : tab === 'actions' ? (
          <ActionsTab tick={tick} />
        ) : (
          <RunsTab catalog={catalog.data} tick={tick} />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Luật
// ---------------------------------------------------------------------------
function RulesTab({ catalog, canManage, tick, onChanged }: { catalog: Catalog; canManage: boolean; tick: number; onChanged: () => void }) {
  const { orgId } = useSession();
  const rules = useLoad(() => api<{ rules: Rule[] }>('GET', `/api/decision/rules?organization=${orgId}`).then((r) => r.data.rules), [orgId, tick]);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const det = useMemo(() => new Map(catalog.detectors.map((d) => [d.id, d])), [catalog]);
  const done = () => {
    setEditing(null);
    rules.reload();
    onChanged();
  };
  return (
    <div className="stack">
      {canManage && !editing && (
        <div>
          <button type="button" onClick={() => setEditing('new')}>
            + Luật mới
          </button>
        </div>
      )}
      {editing && <RuleForm catalog={catalog} rule={editing === 'new' ? null : editing} onDone={done} onCancel={() => setEditing(null)} />}
      <ErrorBox error={rules.error} />
      {rules.data?.length === 0 && <p className="muted">Chưa có luật nào. Bấm “+ Luật mới” để tạo.</p>}
      {rules.data?.map((r) => (
        <RuleCard key={r.ruleId} rule={r} detector={det.get(r.detector)} canManage={canManage} onEdit={() => setEditing(r)} onChanged={() => { rules.reload(); onChanged(); }} />
      ))}
    </div>
  );
}

function condText(c: Condition, d: Detector | undefined): string {
  const m = d?.metrics.find((x) => x.id === c.metric);
  return `${m?.label ?? c.metric} ${c.op === '!=' ? '≠' : c.op === '<=' ? '≤' : c.op === '>=' ? '≥' : c.op} ${c.value.toLocaleString('vi-VN')}${m?.unit ? ` ${m.unit}` : ''}`;
}

function RuleCard({ rule, detector, canManage, onEdit, onChanged }: { rule: Rule; detector: Detector | undefined; canManage: boolean; onEdit: () => void; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState(false);
  const setStatus = useAction(async (status: Rule['status']) => {
    await api('POST', `/api/decision/rules/${rule.ruleId}/status`, { body: { status }, headers: { 'if-match': `W/"${rule.version}"` } });
    onChanged();
  });
  const versions = useLoad(
    () => (history ? api<{ versions: RuleVersion[] }>('GET', `/api/decision/rules/${rule.ruleId}/versions`).then((r) => r.data.versions) : Promise.resolve([] as RuleVersion[])),
    [history, rule.version],
  );
  return (
    <div className={`card rule ${rule.status}`}>
      <div className="rule-head">
        <div>
          <strong>{rule.name}</strong> <span className={`badge ${rule.status === 'active' ? 'on' : 'off'}`}>{rule.status === 'active' ? 'Đang bật' : 'Tạm dừng'}</span>
          <div className="muted small">
            {detector ? `${GROUP[detector.group]} · ${detector.label}` : rule.detector} · <span className={`badge prio-${rule.priority}`}>{PRIORITY_LABEL[rule.priority]}</span> · {cooldownText(rule.cooldownMinutes)}
          </div>
        </div>
        {canManage && (
          <div className="row wrap">
            <button type="button" className="secondary" disabled={setStatus.busy} onClick={() => void setStatus.run(rule.status === 'active' ? 'paused' : 'active')}>
              {rule.status === 'active' ? 'Tạm dừng' : 'Bật'}
            </button>
            <button type="button" className="secondary" onClick={onEdit}>
              Sửa
            </button>
            {confirm ? (
              <>
                <button type="button" className="danger" disabled={setStatus.busy} onClick={() => void setStatus.run('retired')}>
                  Xác nhận xoá
                </button>
                <button type="button" className="link" onClick={() => setConfirm(false)}>
                  huỷ
                </button>
              </>
            ) : (
              <button type="button" className="link" onClick={() => setConfirm(true)}>
                Xoá
              </button>
            )}
          </div>
        )}
      </div>
      <div className="chips">
        <span className="muted small">Khi</span>
        {rule.conditions.map((c, i) => (
          <span key={i} className="chip">
            {condText(c, detector)}
          </span>
        ))}
        <span className="muted small">thì</span>
        {rule.actions.map((a) => (
          <span key={a} className={`chip ${a === 'suggest' ? 'chip-suggest' : a === 'log_only' ? 'chip-neg' : 'chip-act'}`}>
            {actionText(a)}
          </span>
        ))}
      </div>
      <div className="muted small">
        {rule.lastFiredAt ? `Báo gần nhất ${fmtDateTime(rule.lastFiredAt)} · ${rule.events7d} sự kiện / 7 ngày` : 'Chưa báo lần nào'} · v{rule.version} bởi {rule.updatedByName ?? '—'}{' '}
        <button type="button" className="link small" onClick={() => setHistory((h) => !h)}>
          {history ? 'ẩn lịch sử' : 'lịch sử'}
        </button>
      </div>
      <ErrorBox error={setStatus.error} />
      {history && versions.data && (
        <table className="small">
          <thead>
            <tr>
              <th>Phiên bản</th>
              <th>Lúc</th>
              <th>Người sửa</th>
              <th>Trạng thái</th>
              <th>Nội dung</th>
            </tr>
          </thead>
          <tbody>
            {versions.data.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}</td>
                <td>{fmtDateTime(v.changedAt)}</td>
                <td>{v.changedByName ?? '—'}</td>
                <td>{v.status}</td>
                <td>
                  {v.name}: {v.conditions.map((c) => condText(c, detector)).join(' và ')} → {v.actions.map(actionText).join(', ')} · P{v.priority} · {cooldownText(v.cooldownMinutes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RuleForm({ catalog, rule, onDone, onCancel }: { catalog: Catalog; rule: Rule | null; onDone: () => void; onCancel: () => void }) {
  const { orgId } = useSession();
  const [detectorId, setDetectorId] = useState(rule?.detector ?? catalog.detectors[0]!.id);
  const d = catalog.detectors.find((x) => x.id === detectorId)!;
  const [name, setName] = useState(rule?.name ?? '');
  const [conds, setConds] = useState<Array<{ metric: string; op: Op; value: string }>>(
    rule?.conditions.map((c) => ({ metric: c.metric, op: c.op, value: String(c.value) })) ?? [{ metric: d.metrics[0]!.id, op: '>=', value: '' }],
  );
  const [priority, setPriority] = useState<number>(rule?.priority ?? 2);
  const [cooldown, setCooldown] = useState(String(rule?.cooldownMinutes ?? 60));
  const [actions, setActions] = useState<Set<string>>(new Set(rule?.actions ?? ['notify_clinic_admin']));
  const [preview, setPreview] = useState<Preview | null>(null);

  const changeDetector = (id: string) => {
    const nd = catalog.detectors.find((x) => x.id === id)!;
    setDetectorId(id);
    setConds([{ metric: nd.metrics[0]!.id, op: '>=', value: '' }]);
    setActions(new Set([nd.targets.includes('clinic_admin') ? 'notify_clinic_admin' : `notify_${nd.targets[0]}`]));
    setPreview(null);
  };
  const parsed = (): Condition[] =>
    conds.map((c, i) => {
      const v = parseNum(c.value);
      if (c.value.trim() === '' || !Number.isFinite(v)) throw new Error(`Điều kiện ${i + 1}: giá trị phải là số`);
      return { metric: c.metric, op: c.op, value: v };
    });
  const toggle = (a: string) =>
    setActions((s) => {
      const n = new Set(s);
      if (a === 'log_only') return n.has(a) ? new Set() : new Set([a]);
      n.delete('log_only');
      if (n.has(a)) n.delete(a);
      else n.add(a);
      if (![...n].some((x) => x.startsWith('notify_'))) n.delete('suggest');
      return n;
    });
  const test = useAction(async () => {
    const r = await api<Preview>('POST', '/api/decision/preview', {
      body: { organizationId: orgId, detector: detectorId, conditions: parsed(), cooldownMinutes: Number(cooldown) || 0, ...(rule ? { ruleId: rule.ruleId } : {}) },
    });
    setPreview(r.data);
  });
  const save = useAction(async () => {
    const body = { name: name.trim(), conditions: parsed(), priority, cooldownMinutes: Number(cooldown), actions: [...actions] };
    if (!Number.isInteger(body.cooldownMinutes) || body.cooldownMinutes < 0) throw new Error('Thời gian chờ phải là số phút ≥ 0');
    if (body.actions.length === 0) throw new Error('Chọn ít nhất một hành động');
    if (rule) await api('POST', `/api/decision/rules/${rule.ruleId}`, { body, headers: { 'if-match': `W/"${rule.version}"` } });
    else await api('POST', '/api/decision/rules', { body: { ...body, organizationId: orgId, detector: detectorId } });
    onDone();
  });
  const notifyOptions = catalog.actions.filter((a) => a.id.startsWith('notify_') && d.targets.includes(a.id.slice(7)));
  return (
    <Card title={rule ? `Sửa luật: ${rule.name}` : 'Luật mới'}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <div className="row wrap">
          <Field label="Tên luật *">
            <input required minLength={3} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="vd. SpO₂ thấp" />
          </Field>
          <Field label="Bộ phát hiện (Observe)" hint={rule ? 'không đổi được sau khi tạo' : undefined}>
            <select value={detectorId} disabled={!!rule} onChange={(e) => changeDetector(e.target.value)}>
              {(['clinical', 'operations', 'pharmacy', 'finance'] as const).map((g) => (
                <optgroup key={g} label={GROUP[g]}>
                  {catalog.detectors
                    .filter((x) => x.group === g)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
        </div>
        <p className="small muted">
          {d.description} <em>Cách tính: {d.method}</em>
        </p>
        <fieldset className="rx-line">
          <legend>Điều kiện (Detect) — tất cả phải đúng</legend>
          {conds.map((c, i) => {
            const m = d.metrics.find((x) => x.id === c.metric);
            return (
              <div key={i} className="row wrap">
                <Field label="Chỉ số">
                  <select value={c.metric} onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, metric: e.target.value } : x)))}>
                    {d.metrics.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                        {x.unit ? ` (${x.unit})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="So sánh">
                  <select className="short" value={c.op} onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value as Op } : x)))}>
                    {catalog.ops.map((o) => (
                      <option key={o} value={o}>
                        {o === '!=' ? '≠' : o === '<=' ? '≤' : o === '>=' ? '≥' : o}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Giá trị${m?.unit ? ` (${m.unit})` : ''}`}>
                  <input required inputMode="decimal" className="short" value={c.value} onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                </Field>
                {conds.length > 1 && (
                  <button type="button" className="link" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}>
                    bỏ
                  </button>
                )}
              </div>
            );
          })}
          {conds.length < 5 && (
            <button type="button" className="link" onClick={() => setConds((cs) => [...cs, { metric: d.metrics[0]!.id, op: '>=', value: '' }])}>
              + thêm điều kiện
            </button>
          )}
        </fieldset>
        <div className="row wrap">
          <Field label="Ưu tiên (Decide)">
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3].map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Thời gian chờ trước khi báo lại cùng đối tượng (phút)" hint="0 = báo mỗi lần chạy; 1440 = 1 ngày">
            <input required type="number" min={0} max={43200} className="short" value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
          </Field>
        </div>
        <fieldset className="rx-line">
          <legend>Hành động (Act)</legend>
          <div className="chips">
            <label className="chip-check">
              <input type="checkbox" checked={actions.has('log_only')} onChange={() => toggle('log_only')} /> Chỉ ghi nhật ký
            </label>
            {notifyOptions.map((a) => (
              <label key={a.id} className="chip-check">
                <input type="checkbox" checked={actions.has(a.id)} onChange={() => toggle(a.id)} /> {a.label}
              </label>
            ))}
            <label className="chip-check">
              <input type="checkbox" disabled={![...actions].some((x) => x.startsWith('notify_'))} checked={actions.has('suggest')} onChange={() => toggle('suggest')} /> Kèm gợi ý “{d.suggestion}”
            </label>
          </div>
          <p className="small muted">Chỉ hiện những vai trò được phép nhận loại cảnh báo này (vd. sinh hiệu không gửi cho thu ngân).</p>
        </fieldset>
        <div className="row wrap">
          <button type="button" className="secondary" disabled={test.busy} onClick={() => void test.run()}>
            {test.busy ? 'Đang thử…' : 'Thử luật trên dữ liệu hiện tại'}
          </button>
          <button type="submit" disabled={save.busy}>
            {rule ? 'Lưu thay đổi' : 'Tạo luật'}
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Huỷ
          </button>
        </div>
        <ErrorBox error={test.error ?? save.error} />
        {preview && (
          <div className="preview">
            <p className="small">
              Có <strong>{preview.candidates}</strong> đối tượng đang được theo dõi; <strong>{preview.matched}</strong> khớp điều kiện
              {preview.suppressed ? `, ${preview.suppressed} sẽ bị chặn bởi thời gian chờ` : ''}. (Thử luật không tạo sự kiện / thông báo.)
            </p>
            {preview.sample.length > 0 && (
              <ul className="tight small">
                {preview.sample.map((s, i) => (
                  <li key={i}>
                    {s.title}
                    {s.inCooldown && <span className="muted"> — đang trong thời gian chờ</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sự kiện / nhật ký / lần chạy
// ---------------------------------------------------------------------------
function EventsTab({ catalog, tick }: { catalog: Catalog; tick: number }) {
  const { orgId } = useSession();
  const [priority, setPriority] = useState('');
  const [detector, setDetector] = useState('');
  const events = useLoad(
    () =>
      api<{ events: EngineEvent[] }>('GET', `/api/decision/events?organization=${orgId}&limit=200${priority ? `&priority=${priority}` : ''}${detector ? `&detector=${detector}` : ''}`).then(
        (r) => r.data.events,
      ),
    [orgId, priority, detector, tick],
  );
  const det = new Map(catalog.detectors.map((d) => [d.id, d]));
  return (
    <Card
      title="Sự kiện đã phát hiện"
      actions={
        <div className="row">
          <select aria-label="Lọc ưu tiên" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Mọi mức</option>
            {[1, 2, 3].map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <select aria-label="Lọc bộ phát hiện" value={detector} onChange={(e) => setDetector(e.target.value)}>
            <option value="">Mọi bộ phát hiện</option>
            {catalog.detectors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <ErrorBox error={events.error} />
      {events.data?.length === 0 && <p className="muted">Chưa có sự kiện.</p>}
      {!!events.data?.length && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Mức</th>
                <th>Luật</th>
                <th>Nội dung</th>
                <th>Thông báo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.data.map((e) => (
                <tr key={e.eventId}>
                  <td className="nowrap">{fmtDateTime(e.detectedAt)}</td>
                  <td>
                    <span className={`badge prio-${e.priority}`}>P{e.priority}</span>
                  </td>
                  <td>
                    {e.ruleName} <span className="muted small">v{e.ruleVersion}</span>
                    <div className="muted small">{det.get(e.detector)?.label}</div>
                  </td>
                  <td>
                    {e.title}
                    {e.detail && <div className="muted small">{e.detail}</div>}
                  </td>
                  <td className="small">
                    {e.notifications.length === 0
                      ? 'chỉ ghi nhật ký'
                      : e.notifications.map((n) => (
                          <div key={n.targetRole}>
                            {ROLE_LABEL[n.targetRole as Role] ?? n.targetRole}: {n.status === 'open' ? 'chưa xử lý' : 'đã xử lý'}
                            {n.suggestionStatus && n.suggestionStatus !== 'pending' ? ` (gợi ý ${n.suggestionStatus === 'applied' ? 'đã áp dụng' : 'bỏ qua'})` : ''}
                          </div>
                        ))}
                  </td>
                  <td>{e.link && <a href={e.link}>Mở</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ActionsTab({ tick }: { tick: number }) {
  const { orgId } = useSession();
  const log = useLoad(() => api<{ actions: ActionEntry[] }>('GET', `/api/decision/actions?organization=${orgId}&limit=300`).then((r) => r.data.actions), [orgId, tick]);
  return (
    <Card title="Nhật ký hành động (chỉ thêm)">
      <ErrorBox error={log.error} />
      {log.data?.length === 0 && <p className="muted">Chưa có hành động.</p>}
      {!!log.data?.length && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Ai</th>
                <th>Hành động</th>
                <th>Sự kiện</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((a) => (
                <tr key={a.actionId}>
                  <td className="nowrap">{fmtDateTime(a.at)}</td>
                  <td>{a.actorType === 'engine' ? <span className="badge">Engine</span> : a.actorName ?? '—'}</td>
                  <td>{actionText(a.action)}</td>
                  <td>
                    {a.eventTitle}
                    <div className="muted small">{a.ruleName}</div>
                  </td>
                  <td>{a.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RunsTab({ catalog, tick }: { catalog: Catalog; tick: number }) {
  const { orgId } = useSession();
  const runs = useLoad(() => api<{ runs: JobRun[] }>('GET', `/api/decision/runs?organization=${orgId}&limit=100`).then((r) => r.data.runs), [orgId, tick]);
  const label = (id: string) => catalog.detectors.find((d) => d.id === id)?.label ?? id;
  return (
    <Card title="Lần chạy (Job Status)">
      <ErrorBox error={runs.error} />
      {runs.data?.length === 0 && <p className="muted">Chưa chạy lần nào.</p>}
      {!!runs.data?.length && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Bắt đầu</th>
                <th>Kiểu</th>
                <th>Thời gian</th>
                <th>Luật</th>
                <th>Đối tượng</th>
                <th>Sự kiện mới</th>
                <th>Bị chặn</th>
                <th>Trạng thái</th>
                <th>Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.runId}>
                  <td className="nowrap">{fmtDateTime(r.startedAt)}</td>
                  <td>{r.trigger === 'schedule' ? 'Theo lịch' : `Bấm tay (${r.triggeredByName ?? '—'})`}</td>
                  <td className="num">{r.durationMs} ms</td>
                  <td className="num">{r.rulesEvaluated}</td>
                  <td className="num">{r.candidates}</td>
                  <td className="num">{r.eventsCreated}</td>
                  <td className="num">{r.suppressed}</td>
                  <td>
                    <span className={`badge run-${r.status}`}>{RUN_STATUS[r.status]}</span>
                    {r.errorCode && <div className="muted small mono">{r.errorCode}</div>}
                  </td>
                  <td className="small">
                    {r.detail
                      .filter((x) => !x.error?.startsWith('CAPPED'))
                      .map((x) => `${label(x.detector)}: ${x.error ? `lỗi ${x.error}` : `${x.candidates} đối tượng, ${x.ms} ms`}`)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
