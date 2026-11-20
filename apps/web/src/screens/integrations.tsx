/**
 * Tích hợp (HCOS-F12) — kết nối Microsoft Teams (Workflows) và webhook đối tác; lịch sử giao, gửi thử / gửi lại.
 * Quản lý phòng khám / quản trị: quản lý; ban giám đốc: chỉ xem.
 */
import { useState } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { PRIORITY_LABEL } from '../lib/notifications';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

type Kind = 'teams_workflow' | 'webhook';
interface Catalog {
  kinds: Array<{ id: Kind; label: string; description: string }>;
  eventTypes: Array<{ id: string; label: string; description: string }>;
  enabled: boolean; maxAttempts: number; autoPauseAfter: number;
}
interface Overview { enabled: boolean; publicBaseUrl: string | null; endpoints: { active: number; paused: number }; last24h: { succeeded: number; dead: number; pending: number } }
interface Endpoint {
  endpointId: string; kind: Kind; name: string; urlHint: string; eventTypes: string[]; maxPriority: number; status: 'active' | 'paused' | 'retired';
  pausedReason: 'manual' | 'auto_failures' | null; consecutiveFailures: number; lastSuccessAt: string | null; lastFailureAt: string | null; version: number;
  createdByName: string | null; updatedAt: string; delivered7d: number; failed7d: number; pending: number;
}
interface History { version: number; name: string; urlHint: string; urlChanged: boolean; secretRotated: boolean; eventTypes: string[]; maxPriority: number; status: string; pausedReason: string | null; changedByName: string | null; changedAt: string }
interface Delivery {
  deliveryId: string; endpointId: string; endpointName: string; eventType: string; priority: number; title: string | null; status: 'pending' | 'sending' | 'succeeded' | 'dead' | 'cancelled';
  attempts: number; nextAttemptAt: string | null; lastStatusCode: number | null; lastError: string | null; deliveredAt: string | null; createdAt: string;
}
interface Attempt { attemptNo: number; startedAt: string; durationMs: number; statusCode: number | null; outcome: 'success' | 'retry' | 'dead'; errorCode: string | null; trigger: 'dispatcher' | 'manual'; actorName: string | null }
interface SendResult { outcome: 'success' | 'retry' | 'dead' | 'skipped'; statusCode: number | null; error: string | null; durationMs: number }

const KIND_LABEL: Record<Kind, string> = { teams_workflow: 'Microsoft Teams', webhook: 'Webhook đối tác' };
const EVENT_LABEL: Record<string, string> = { 'decision.event': 'Sự kiện Decision Engine', 'system.alert': 'Sự cố hệ thống', 'integration.test': 'Gửi thử' };
const STATUS_LABEL: Record<Delivery['status'], string> = { pending: 'Chờ gửi / thử lại', sending: 'Đang gửi', succeeded: 'Đã giao', dead: 'Thất bại', cancelled: 'Đã huỷ (tin cũ)' };
const ERROR_TEXT: Record<string, string> = {
  HTTP_404: 'Không tìm thấy URL (workflow đã bị xoá?)', HTTP_401: 'Bị từ chối xác thực', HTTP_403: 'Bị từ chối', HTTP_400: 'Phía nhận không chấp nhận nội dung',
  HTTP_429: 'Phía nhận báo quá tải (429)', TIMEOUT: 'Hết giờ chờ (10 giây)', DNS: 'Không phân giải được tên miền', CONNECT_REFUSED: 'Không kết nối được', TLS: 'Lỗi chứng chỉ TLS',
  BLOCKED_ADDRESS: 'Địa chỉ nội bộ bị chặn', REDIRECT_NOT_FOLLOWED: 'Phía nhận chuyển hướng (không theo)', DECRYPT_FAILED: 'Không giải mã được URL (đổi khoá?) — nhập lại URL',
  INTEGRATION_DISABLED: 'Chưa cấu hình khoá mã hoá', STALE_ON_RESUME: 'Tin quá 24 giờ, huỷ khi bật lại', NETWORK: 'Lỗi mạng',
};
const errText = (e: string | null, code: number | null) => (e ? (ERROR_TEXT[e] ?? (e.startsWith('HTTP_5') ? `Lỗi phía nhận (${e.slice(5)})` : e)) : code ? `HTTP ${code}` : '');
const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

export function IntegrationsScreen() {
  const { orgId, roles } = useSession();
  const canManage = roles.has('clinic_admin') || roles.has('tenant_admin');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const catalog = useLoad(() => api<Catalog>('GET', '/api/integrations/catalog').then((r) => r.data), []);
  const ov = useLoad(() => api<Overview>('GET', `/api/integrations/overview?organization=${orgId}`).then((r) => r.data), [orgId, tick]);
  const eps = useLoad(() => api<{ endpoints: Endpoint[] }>('GET', `/api/integrations/endpoints?organization=${orgId}`).then((r) => r.data.endpoints), [orgId, tick]);
  const [editing, setEditing] = useState<Endpoint | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);

  if (forbidden(ov.error)) return <Notice kind="warn">Màn Tích hợp dành cho quản lý phòng khám / ban giám đốc.</Notice>;
  const o = ov.data;
  return (
    <div className="stack">
      <Notice>
        Tin gửi ra ngoài (Teams, đối tác) <strong>không chứa tên hay mã bệnh nhân</strong> — chỉ cảnh báo, chỉ số và nút mở HealthcareOS (phải đăng nhập). URL kết nối được mã hoá khi lưu
        và chỉ hiện dạng che. Gửi lỗi được thử lại 1 phút → 5 → 15 → 1 giờ → 6 giờ → 24 giờ; lỗi liên tiếp {catalog.data?.autoPauseAfter ?? 10} lần thì kết nối tự tạm dừng và báo qua kết nối khác.
      </Notice>
      <ErrorBox error={ov.error ?? eps.error ?? catalog.error} />
      {o && !o.enabled && (
        <Notice kind="warn">
          Tích hợp đang tắt: máy chủ chưa có <code>HCOS_INTEGRATION_KEY</code> (khoá mã hoá URL). Quản trị hệ thống cần đặt khoá rồi khởi động lại API.
        </Notice>
      )}
      {o && o.enabled && !o.publicBaseUrl && (
        <Notice kind="warn">
          Chưa đặt <code>HCOS_PUBLIC_BASE_URL</code>: thẻ Teams sẽ không có nút “Mở trong HealthcareOS”.
        </Notice>
      )}
      {o && (
        <div className="flow">
          <div>
            <span>Kết nối</span>
            <strong>{o.endpoints.active}</strong>
            <small>đang bật{o.endpoints.paused ? ` · ${o.endpoints.paused} tạm dừng` : ''}</small>
          </div>
          <div>
            <span>Đã giao 24h</span>
            <strong>{o.last24h.succeeded}</strong>
            <small>lượt giao thành công</small>
          </div>
          <div>
            <span>Thất bại 24h</span>
            <strong>{o.last24h.dead}</strong>
            <small>hết lượt thử lại / lỗi vĩnh viễn</small>
          </div>
          <div>
            <span>Đang chờ</span>
            <strong>{o.last24h.pending}</strong>
            <small>chờ gửi / chờ thử lại</small>
          </div>
        </div>
      )}
      {secret && (
        <Notice kind="warn">
          <strong>Bí mật ký của “{secret.name}” — chỉ hiện MỘT lần.</strong> Gửi cho đối tác qua kênh an toàn; họ dùng nó để kiểm chữ ký <code>X-HCOS-Signature</code>.
          <div className="row wrap secret-row">
            <code className="secret">{secret.value}</code>
            <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(secret.value)}>
              Sao chép
            </button>
            <button type="button" className="link" onClick={() => setSecret(null)}>
              Tôi đã lưu, ẩn đi
            </button>
          </div>
        </Notice>
      )}
      {canManage && o?.enabled && !editing && (
        <div>
          <button type="button" onClick={() => setEditing('new')}>
            + Kết nối mới
          </button>
        </div>
      )}
      {editing && catalog.data && (
        <EndpointForm
          catalog={catalog.data}
          endpoint={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(name, s) => {
            setEditing(null);
            if (s) setSecret({ name, value: s });
            refresh();
          }}
        />
      )}
      {eps.data?.length === 0 && <p className="muted">Chưa có kết nối nào.</p>}
      {eps.data?.map((e) => (
        <EndpointCard key={e.endpointId} ep={e} canManage={canManage} enabled={!!o?.enabled} onEdit={() => setEditing(e)} onChanged={refresh} />
      ))}
      {!!eps.data?.length && <Deliveries endpoints={eps.data} canManage={canManage} tick={tick} onChanged={refresh} />}
    </div>
  );
}

function EndpointCard({ ep, canManage, enabled, onEdit, onChanged }: { ep: Endpoint; canManage: boolean; enabled: boolean; onEdit: () => void; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState(false);
  const [test, setTest] = useState<SendResult | null>(null);
  const status = useAction(async (s: Endpoint['status']) => {
    await api('POST', `/api/integrations/endpoints/${ep.endpointId}/status`, { body: { status: s }, headers: { 'if-match': `W/"${ep.version}"` } });
    onChanged();
  });
  const send = useAction(async () => {
    const r = await api<SendResult>('POST', `/api/integrations/endpoints/${ep.endpointId}/test`);
    setTest(r.data);
    onChanged();
  });
  const hist = useLoad(
    () => (history ? api<{ history: History[] }>('GET', `/api/integrations/endpoints/${ep.endpointId}/history`).then((r) => r.data.history) : Promise.resolve([] as History[])),
    [history, ep.version],
  );
  const badge =
    ep.status === 'active' ? <span className="badge on">Đang bật</span> : ep.pausedReason === 'auto_failures' ? <span className="badge run-failed">Tự tạm dừng do lỗi</span> : <span className="badge off">Tạm dừng</span>;
  return (
    <div className={`card rule ${ep.status}`}>
      <div className="rule-head">
        <div>
          <strong>{ep.name}</strong> {badge}
          <div className="muted small">
            {KIND_LABEL[ep.kind]} · <span className="mono">{ep.urlHint}</span>
          </div>
        </div>
        {canManage && (
          <div className="row wrap">
            <button type="button" className="secondary" disabled={send.busy || !enabled} onClick={() => void send.run()}>
              {send.busy ? 'Đang gửi…' : 'Gửi thử'}
            </button>
            <button type="button" className="secondary" disabled={status.busy} onClick={() => void status.run(ep.status === 'active' ? 'paused' : 'active')}>
              {ep.status === 'active' ? 'Tạm dừng' : 'Bật lại'}
            </button>
            <button type="button" className="secondary" disabled={!enabled} onClick={onEdit}>
              Sửa
            </button>
            {confirm ? (
              <>
                <button type="button" className="danger" disabled={status.busy} onClick={() => void status.run('retired')}>
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
        <span className="muted small">Gửi</span>
        {ep.eventTypes.map((t) => (
          <span key={t} className="chip chip-act">
            {EVENT_LABEL[t] ?? t}
            {t === 'decision.event' ? ` (${ep.maxPriority === 1 ? 'chỉ P1' : ep.maxPriority === 2 ? 'P1–P2' : 'P1–P3'})` : ''}
          </span>
        ))}
      </div>
      <div className="muted small">
        7 ngày: {ep.delivered7d} đã giao · {ep.failed7d} thất bại · {ep.pending} đang chờ
        {ep.lastSuccessAt && ` · giao tốt gần nhất ${fmtDateTime(ep.lastSuccessAt)}`}
        {ep.consecutiveFailures > 0 && <span className="text-danger"> · {ep.consecutiveFailures} lần lỗi liên tiếp</span>}
        {' · '}
        <button type="button" className="link small" onClick={() => setHistory((h) => !h)}>
          {history ? 'ẩn lịch sử' : 'lịch sử'}
        </button>
      </div>
      {test && (
        <Notice kind={test.outcome === 'success' ? 'ok' : 'warn'}>
          {test.outcome === 'success'
            ? `Gửi thử thành công (HTTP ${test.statusCode}, ${test.durationMs} ms). Kiểm tra kênh nhận.`
            : `Gửi thử thất bại: ${errText(test.error, test.statusCode)}.`}
        </Notice>
      )}
      <ErrorBox error={status.error ?? send.error} />
      {history && hist.data && (
        <table className="small">
          <thead>
            <tr>
              <th>Phiên bản</th>
              <th>Lúc</th>
              <th>Người đổi</th>
              <th>Thay đổi</th>
            </tr>
          </thead>
          <tbody>
            {hist.data.map((h) => (
              <tr key={h.version}>
                <td>v{h.version}</td>
                <td>{fmtDateTime(h.changedAt)}</td>
                <td>{h.changedByName ?? (h.pausedReason === 'auto_failures' ? 'Hệ thống' : '—')}</td>
                <td>
                  {h.status === 'paused' ? (h.pausedReason === 'auto_failures' ? 'tự tạm dừng do lỗi' : 'tạm dừng') : h.status === 'retired' ? 'xoá' : 'đang bật'} · {h.name} ·{' '}
                  {h.eventTypes.map((t) => EVENT_LABEL[t] ?? t).join(', ')} · tối đa P{h.maxPriority}
                  {h.urlChanged && ' · đổi URL'}
                  {h.secretRotated && ' · đổi bí mật ký'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EndpointForm({ catalog, endpoint, onDone, onCancel }: { catalog: Catalog; endpoint: Endpoint | null; onDone: (name: string, secret: string | null) => void; onCancel: () => void }) {
  const { orgId } = useSession();
  const [kind, setKind] = useState<Kind>(endpoint?.kind ?? 'teams_workflow');
  const [name, setName] = useState(endpoint?.name ?? '');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<Set<string>>(new Set(endpoint?.eventTypes ?? ['decision.event', 'system.alert']));
  const [maxPriority, setMaxPriority] = useState(endpoint?.maxPriority ?? 2);
  const [rotate, setRotate] = useState(false);
  const save = useAction(async () => {
    if (events.size === 0) throw new Error('Chọn ít nhất một loại sự kiện');
    const body = { name: name.trim(), eventTypes: [...events], maxPriority };
    const r = endpoint
      ? await api<{ signingSecret: string | null }>('POST', `/api/integrations/endpoints/${endpoint.endpointId}`, {
          body: { ...body, ...(url.trim() ? { url: url.trim() } : {}), ...(rotate ? { rotateSecret: true } : {}) },
          headers: { 'if-match': `W/"${endpoint.version}"` },
        })
      : await api<{ signingSecret: string | null }>('POST', '/api/integrations/endpoints', { body: { ...body, organizationId: orgId, kind, url: url.trim() } });
    onDone(body.name, r.data.signingSecret);
  });
  return (
    <Card title={endpoint ? `Sửa kết nối: ${endpoint.name}` : 'Kết nối mới'}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <div className="row wrap">
          <Field label="Loại">
            <select value={kind} disabled={!!endpoint} onChange={(e) => setKind(e.target.value as Kind)}>
              {catalog.kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tên kết nối *">
            <input required minLength={3} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'teams_workflow' ? 'vd. Kênh trực ban' : 'vd. Đối tác BI'} />
          </Field>
        </div>
        {kind === 'teams_workflow' && !endpoint && (
          <ol className="small teams-steps">
            <li>Trong Teams, mở kênh cần nhận tin → <strong>…</strong> → <strong>Workflows</strong>.</li>
            <li>Chọn mẫu <strong>“Post to a channel when a webhook request is received”</strong> (Đăng lên kênh khi nhận yêu cầu webhook), chọn nhóm và kênh.</li>
            <li>Sao chép URL Teams tạo ra và dán vào ô bên dưới. URL này như mật khẩu — đừng dán vào chat / email.</li>
          </ol>
        )}
        <Field
          label={endpoint ? 'URL mới (để trống = giữ URL cũ)' : 'URL webhook *'}
          hint={endpoint ? `Hiện tại: ${endpoint.urlHint}` : kind === 'teams_workflow' ? 'https://…logic.azure.com/… hoặc https://…environment.api.powerplatform.com/…' : 'https://… của đối tác'}
        >
          <input type="url" required={!endpoint} autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} className="wide" />
        </Field>
        <fieldset className="rx-line">
          <legend>Gửi những gì</legend>
          <div className="chips">
            {catalog.eventTypes.map((t) => (
              <label key={t.id} className="chip-check" title={t.description}>
                <input
                  type="checkbox"
                  checked={events.has(t.id)}
                  onChange={() =>
                    setEvents((s) => {
                      const n = new Set(s);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      return n;
                    })
                  }
                />{' '}
                {t.label}
              </label>
            ))}
          </div>
          <Field label="Sự kiện Decision Engine từ mức">
            <select value={maxPriority} onChange={(e) => setMaxPriority(Number(e.target.value))}>
              <option value={1}>Chỉ {PRIORITY_LABEL[1]}</option>
              <option value={2}>P1 khẩn + P2 cao</option>
              <option value={3}>Tất cả (P1–P3)</option>
            </select>
          </Field>
        </fieldset>
        {endpoint?.kind === 'webhook' && (
          <label className="chip-check">
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} /> Đổi bí mật ký (bí mật cũ hết hiệu lực ngay)
          </label>
        )}
        <div className="row wrap">
          <button type="submit" disabled={save.busy}>
            {endpoint ? 'Lưu thay đổi' : 'Tạo kết nối'}
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Huỷ
          </button>
        </div>
        <ErrorBox error={save.error} />
      </form>
    </Card>
  );
}

function Deliveries({ endpoints, canManage, tick, onChanged }: { endpoints: Endpoint[]; canManage: boolean; tick: number; onChanged: () => void }) {
  const { orgId } = useSession();
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(
    () =>
      api<{ deliveries: Delivery[] }>('GET', `/api/integrations/deliveries?organization=${orgId}&limit=200${endpoint ? `&endpoint=${endpoint}` : ''}${status ? `&status=${status}` : ''}`).then(
        (r) => r.data.deliveries,
      ),
    [orgId, endpoint, status, tick],
  );
  const attempts = useLoad(
    () => (open ? api<{ attempts: Attempt[] }>('GET', `/api/integrations/deliveries/${open}/attempts`).then((r) => r.data.attempts) : Promise.resolve([] as Attempt[])),
    [open, tick],
  );
  const retry = useAction(async (id: string) => {
    await api('POST', `/api/integrations/deliveries/${id}/retry`);
    onChanged();
  });
  return (
    <Card
      title="Lịch sử giao"
      actions={
        <div className="row">
          <select aria-label="Lọc kết nối" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
            <option value="">Mọi kết nối</option>
            {endpoints.map((e) => (
              <option key={e.endpointId} value={e.endpointId}>
                {e.name}
              </option>
            ))}
          </select>
          <select aria-label="Lọc trạng thái" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Mọi trạng thái</option>
            {(Object.keys(STATUS_LABEL) as Array<Delivery['status']>).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={() => list.reload()}>
            Làm mới
          </button>
        </div>
      }
    >
      <ErrorBox error={list.error ?? retry.error} />
      {list.data?.length === 0 && <p className="muted">Chưa có lượt giao nào.</p>}
      {!!list.data?.length && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Kết nối</th>
                <th>Nội dung</th>
                <th>Trạng thái</th>
                <th>Lần gửi</th>
                <th>Kết quả gần nhất</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.flatMap((d) => [
                  <tr key={d.deliveryId}>
                    <td className="nowrap">{fmtDateTime(d.createdAt)}</td>
                    <td>{d.endpointName}</td>
                    <td>
                      {d.eventType === 'decision.event' && <span className={`badge prio-${d.priority}`}>P{d.priority}</span>} {d.title ?? EVENT_LABEL[d.eventType]}
                      <div className="muted small">{EVENT_LABEL[d.eventType] ?? d.eventType}</div>
                    </td>
                    <td>
                      <span className={`badge ${d.status === 'succeeded' ? 'run-success' : d.status === 'dead' ? 'run-failed' : d.status === 'pending' ? 'run-partial' : 'off'}`}>{STATUS_LABEL[d.status]}</span>
                      {d.status === 'pending' && d.nextAttemptAt && <div className="muted small">lần tới {fmtDateTime(d.nextAttemptAt)}</div>}
                    </td>
                    <td className="num">{d.attempts}</td>
                    <td className="small">{d.status === 'succeeded' ? `HTTP ${d.lastStatusCode ?? ''}` : errText(d.lastError, d.lastStatusCode)}</td>
                    <td className="nowrap">
                      <button type="button" className="link small" onClick={() => setOpen(open === d.deliveryId ? null : d.deliveryId)}>
                        {open === d.deliveryId ? 'ẩn' : 'chi tiết'}
                      </button>
                      {canManage && (d.status === 'dead' || d.status === 'pending') && (
                        <button type="button" className="secondary small" disabled={retry.busy} onClick={() => void retry.run(d.deliveryId)}>
                          Gửi lại
                        </button>
                      )}
                    </td>
                  </tr>,
                  ...(open === d.deliveryId && attempts.data ? [
                    <tr key={`${d.deliveryId}-a`} className="sub-row">
                      <td colSpan={7}>
                        <table className="small">
                          <thead>
                            <tr>
                              <th>Lần</th>
                              <th>Lúc</th>
                              <th>Thời gian</th>
                              <th>HTTP</th>
                              <th>Kết quả</th>
                              <th>Ai</th>
                            </tr>
                          </thead>
                          <tbody>
                            {attempts.data.map((a) => (
                              <tr key={a.attemptNo}>
                                <td>#{a.attemptNo}</td>
                                <td>{fmtDateTime(a.startedAt)}</td>
                                <td className="num">{a.durationMs} ms</td>
                                <td>{a.statusCode ?? '—'}</td>
                                <td>{a.outcome === 'success' ? 'Thành công' : a.outcome === 'retry' ? `Sẽ thử lại — ${errText(a.errorCode, a.statusCode)}` : `Dừng — ${errText(a.errorCode, a.statusCode)}`}</td>
                                <td>{a.trigger === 'manual' ? a.actorName ?? '—' : 'Bộ giao tự động'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>,
                  ] : []),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
