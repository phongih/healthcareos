/**
 * HCOS-F17 | Lưu giữ & xoá dữ liệu.
 *  - RetentionSection (tab Quản trị dữ liệu): chính sách lưu giữ (sàn pháp lý), chạy job, yêu cầu xoá chờ duyệt, biên nhận xoá.
 *  - ErasurePanel (hồ sơ bệnh nhân): lập yêu cầu xoá theo đề nghị người bệnh — chưa xoá gì cho tới khi người THỨ HAI duyệt.
 * Server quyết định quyền và mọi thao tác xoá; giao diện chỉ ẩn nút.
 */
import { useState } from 'react';

import { api } from '../lib/api';
import { exportFile } from '../lib/download';
import { fmtDateTime } from '../lib/fhir';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

interface Rule {
  id: string; label: string; action: 'anonymize' | 'delete' | 'hold'; tables: string[]; from: string; floorDays: number; defaultDays: number; days: number;
  legalBasis: string; due: number | null;
}
interface Receipt {
  receiptId: string; kind: 'retention' | 'erasure'; ruleId: string | null; requestId: string | null; policyVersion: string; legalBasis: string;
  criteria: Record<string, unknown>; scope: Record<string, number>; keysShredded: number; outcome: 'completed' | 'partial'; startedAt: string; finishedAt: string;
  backupHorizonDays: number; irreversibleAfter: string; executedBy: string | null; approvedBy: string | null; ledger: { events: number; exported: number };
}
interface Assessment {
  medicalRecordUntil: string | null; medicalRecordCount: number; financialRecordUntil: string | null; financialRecordCount: number;
  persons: number; identifiers: number; bookings: number; holdUntil: string | null;
}
interface ErasureRequest {
  requestId: string; organizationId: string; patientId: string; mrn: string | null; personId: string; channel: string; note: string | null; receivedAt: string;
  requestedBy: string; requestedByName: string | null; requestedAt: string; assessment: Assessment; status: 'pending' | 'rejected' | 'completed' | 'deferred';
  decidedBy: string | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; deferredUntil: string | null;
  receiptId: string | null; finalReceiptId: string | null;
}
interface Overview {
  rules: Rule[]; policyVersion: string; backupHorizonDays: number;
  lastRun: { startedAt: string; trigger: string; status: string; detail: Record<string, number> } | null;
  ledgerPending: number; subjectKeys: { active: number; shredded: number }; receipts: Receipt[]; requests: ErasureRequest[]; canManage: boolean; canApprove: boolean;
}

const ACTION: Record<Rule['action'], string> = { anonymize: 'Ẩn danh (huỷ khoá)', delete: 'Xoá', hold: 'Giữ theo luật' };
const STATUS: Record<ErasureRequest['status'], string> = { pending: 'Chờ duyệt', rejected: 'Từ chối', completed: 'Đã xoá', deferred: 'Đã xoá một phần — chờ hết hạn giữ' };
const CHANNEL: Record<string, string> = { counter: 'Trực tiếp tại quầy', written: 'Văn bản', email: 'Email', phone: 'Điện thoại' };
const RULE_LABEL: Record<string, string> = { booking_contact: 'Lịch hẹn quá hạn', idempotency: 'Chống gửi trùng', outbox: 'Sự kiện chờ phát' };
const dDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('vi-VN') : '—');
const years = (d: number) => (d % 365 === 0 && d >= 365 ? `${d / 365} năm` : `${d} ngày`);
const scopeText = (s: Record<string, number>) => Object.entries(s).filter(([, n]) => n > 0).map(([t, n]) => `${t}: ${n}`).join(' · ') || '—';

function HoldText({ a }: { a: Assessment }) {
  if (!a.holdUntil) return <span>Không còn nghĩa vụ lưu giữ — có thể <strong>xoá toàn bộ</strong>.</span>;
  return (
    <span>
      Còn nghĩa vụ lưu giữ đến <strong>{dDate(a.holdUntil)}</strong>
      {a.medicalRecordCount > 0 && <> (hồ sơ bệnh án: {a.medicalRecordCount} đợt khám, giữ đến {dDate(a.medicalRecordUntil)})</>}
      {a.financialRecordCount > 0 && <> (chứng từ thu/chi: {a.financialRecordCount}, giữ đến {dDate(a.financialRecordUntil)})</>}.
      Duyệt sẽ xoá phần không bị ràng buộc (lịch hẹn), <strong>hạn chế xử lý</strong> hồ sơ và tự xoá nốt khi hết hạn.
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab Quản trị dữ liệu
// ---------------------------------------------------------------------------
export function RetentionSection() {
  const ov = useLoad(() => api<Overview>('GET', '/api/retention').then((r) => r.data), []);
  const [msg, setMsg] = useState<string | null>(null);
  const run = useAction(async () => {
    if (!confirm('Chạy ngay job lưu giữ: ẩn danh lịch hẹn quá hạn, xoá dữ liệu kỹ thuật hết hạn, xoá nốt các yêu cầu đã hết hạn giữ. Không hoàn tác được. Tiếp tục?')) return;
    const r = await api<{ receipts: number; detail: Record<string, number> }>('POST', '/api/retention/run', {});
    const d = r.data.detail;
    setMsg(`Xong: ${r.data.receipts} biên nhận — lịch hẹn ẩn danh ${d['booking_contact'] ?? 0}, chống gửi trùng ${d['idempotency'] ?? 0}, sự kiện ${d['outbox'] ?? 0}, yêu cầu xoá hoàn tất ${d['deferredErasures'] ?? 0}.`);
    ov.reload();
  });
  if (ov.error) return <ErrorBox error={ov.error} />;
  const v = ov.data;
  if (!v) return null;
  return (
    <div className="stack">
      <Card title="Lưu giữ & xoá dữ liệu" actions={v.canManage ? <button className="link" disabled={run.busy} onClick={() => void run.run()}>Chạy ngay</button> : undefined}>
        <p className="muted small">
          Phân biệt: <strong>xoá</strong> dữ liệu kỹ thuật hết mục đích · <strong>ẩn danh</strong> (huỷ khoá riêng + bỏ trường định danh, giữ số liệu thống kê) ·
          <strong> giữ</strong> theo nghĩa vụ pháp lý (hồ sơ bệnh án, chứng từ). Thời hạn không đặt được thấp hơn sàn pháp lý (CSDL chặn). Job chạy mỗi ngày.
        </p>
        <table>
          <thead><tr><th>Dữ liệu</th><th>Hành động</th><th>Thời hạn</th><th>Sàn</th><th>Đến hạn</th><th>Căn cứ</th></tr></thead>
          <tbody>
            {v.rules.map((r) => <RuleRow key={r.id} r={r} canManage={v.canManage} onSaved={ov.reload} />)}
          </tbody>
        </table>
        <div className="muted small">
          {v.lastRun ? <>Lần chạy gần nhất: {fmtDateTime(v.lastRun.startedAt)} ({v.lastRun.trigger === 'manual' ? 'bấm tay' : 'tự động'}, {v.lastRun.status === 'succeeded' ? 'thành công' : 'lỗi'}). </> : 'Chưa chạy lần nào. '}
          Khoá theo người: {v.subjectKeys.active} đang dùng · {v.subjectKeys.shredded} đã huỷ. Phiên bản chính sách <code>{v.policyVersion.slice(0, 12)}</code>.
        </div>
        {v.ledgerPending > 0 ? (
          <Notice kind="warn">{v.ledgerPending} lần huỷ khoá chưa được đẩy ra sổ huỷ ngoài bản sao lưu (cron 15 phút). Chưa đẩy thì khôi phục bản sao lưu có thể làm dữ liệu đã xoá xuất hiện lại.</Notice>
        ) : (
          <Notice kind="ok">Mọi lần huỷ khoá đã có trong sổ huỷ ngoài bản sao lưu (phát lại khi khôi phục).</Notice>
        )}
        {msg && <Notice kind="ok">{msg}</Notice>}
        <ErrorBox error={run.error} />
      </Card>

      <ErasureQueue v={v} onChange={ov.reload} />

      <Card title={`Biên nhận xoá (${v.receipts.length})`}>
        <p className="muted small">
          Bằng chứng cho mỗi lần xoá: chính sách + phiên bản, căn cứ, phạm vi (số bản ghi), số khoá đã huỷ, thời điểm, kết quả. Không lưu dữ liệu đã xoá.
          Bản sao lưu cũ được tự xoá sau {v.backupHorizonDays} ngày: sau "Không thể khôi phục" không còn bản sao nào chứa dữ liệu đó.
        </p>
        {v.receipts.length === 0 ? <p className="muted">Chưa có.</p> : (
          <table>
            <thead><tr><th>Lúc</th><th>Loại</th><th>Phạm vi</th><th>Khoá huỷ</th><th>Sổ huỷ</th><th>Không thể khôi phục</th></tr></thead>
            <tbody>
              {v.receipts.map((r) => (
                <tr key={r.receiptId} title={r.legalBasis}>
                  <td>{fmtDateTime(r.finishedAt)}</td>
                  <td>{r.kind === 'erasure' ? `Yêu cầu xoá${r.outcome === 'partial' ? ' (một phần)' : ''}` : RULE_LABEL[r.ruleId ?? ''] ?? r.ruleId}</td>
                  <td className="small">{scopeText(r.scope)}</td>
                  <td>{r.keysShredded}</td>
                  <td>{r.ledger.events === 0 ? '—' : r.ledger.exported === r.ledger.events ? 'đã đẩy' : `${r.ledger.exported}/${r.ledger.events}`}</td>
                  <td>{dDate(r.irreversibleAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function RuleRow({ r, canManage, onSaved }: { r: Rule; canManage: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = useAction(async () => {
    await api('POST', '/api/retention/settings', { body: { ruleId: r.id, days: Number(edit) } });
    setEdit(null);
    onSaved();
  });
  return (
    <tr>
      <td>{r.label}<div className="muted small">{r.tables.join(', ')}</div></td>
      <td>{ACTION[r.action]}</td>
      <td>
        {edit === null ? (
          <>
            {years(r.days)} <span className="muted small">từ {r.from}</span>
            {canManage && <> <button className="linkish" onClick={() => setEdit(String(r.days))}>Đổi</button></>}
          </>
        ) : (
          <span className="row">
            <input type="number" min={r.floorDays} max={36500} value={edit} onChange={(e) => setEdit(e.target.value)} style={{ width: 90 }} aria-label={`Số ngày ${r.label}`} /> ngày
            <button className="small" disabled={save.busy} onClick={() => void save.run()}>Lưu</button>
            <button className="linkish" onClick={() => setEdit(null)}>Thôi</button>
          </span>
        )}
        <ErrorBox error={save.error} />
      </td>
      <td>{years(r.floorDays)}</td>
      <td>{r.due === null ? '—' : r.due}</td>
      <td className="small">{r.legalBasis}</td>
    </tr>
  );
}

function ErasureQueue({ v, onChange }: { v: Overview; onChange: () => void }) {
  const { me } = useSession();
  const [msg, setMsg] = useState<string | null>(null);
  const decide = useAction(async (r: ErasureRequest, decision: 'approve' | 'reject') => {
    setMsg(null);
    let note: string | null = null;
    if (decision === 'reject') {
      note = prompt('Lý do từ chối (gửi cho người yêu cầu, tối thiểu 5 ký tự):');
      if (note === null) return;
    } else if (!confirm(`Duyệt và THỰC THI xoá dữ liệu của hồ sơ ${r.mrn ?? ''}? Khoá riêng của người bệnh sẽ bị huỷ — KHÔNG hoàn tác được.`)) return;
    const res = await api<{ request: ErasureRequest }>('POST', `/api/erasure-requests/${r.requestId}/decision`, { body: { decision, ...(note ? { note } : {}) } });
    setMsg(decision === 'reject' ? 'Đã từ chối.' : `Đã xử lý: ${STATUS[res.data.request.status]}.`);
    onChange();
  });
  const letter = useAction(async (r: ErasureRequest) => {
    await exportFile('erasure_letter', { requestId: r.requestId }, 'Gửi người yêu cầu xoá dữ liệu');
  });
  return (
    <Card title={`Yêu cầu xoá dữ liệu của người bệnh (${v.requests.filter((r) => r.status === 'pending').length} chờ duyệt)`}>
      <p className="muted small">Lễ tân / quản lý lập yêu cầu ở trang hồ sơ bệnh nhân. Người duyệt phải là người KHÁC người lập; duyệt là thực thi ngay.</p>
      {v.requests.length === 0 ? <p className="muted">Chưa có yêu cầu.</p> : (
        <table>
          <thead><tr><th>Nhận</th><th>Hồ sơ</th><th>Người lập</th><th>Đánh giá</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {v.requests.map((r) => {
              const own = me.user.userId === r.requestedBy;
              return (
                <tr key={r.requestId}>
                  <td>{dDate(r.receivedAt)}<div className="muted small">{CHANNEL[r.channel] ?? r.channel}</div></td>
                  <td><a href={`#/patients/${r.patientId}`}>{r.mrn ?? '—'}</a>{r.note && <div className="muted small">{r.note}</div>}</td>
                  <td>{r.requestedByName ?? '—'}</td>
                  <td className="small"><HoldText a={r.assessment} /></td>
                  <td>
                    {STATUS[r.status]}
                    {r.decidedByName && <div className="muted small">{r.decidedByName} · {fmtDateTime(r.decidedAt ?? undefined)}</div>}
                    {r.status === 'deferred' && <div className="muted small">xoá nốt sau {dDate(r.deferredUntil)}</div>}
                    {r.decisionNote && <div className="muted small">{r.decisionNote}</div>}
                  </td>
                  <td className="actions">
                    {r.status === 'pending' && v.canApprove && (own ? <span className="muted small">Bạn là người lập — cần người khác duyệt</span> : (
                      <>
                        <button className="link danger" disabled={decide.busy} onClick={() => void decide.run(r, 'approve')}>Duyệt & xoá</button>
                        <button className="link" disabled={decide.busy} onClick={() => void decide.run(r, 'reject')}>Từ chối</button>
                      </>
                    ))}
                    <button className="link" disabled={letter.busy} onClick={() => void letter.run(r)}>Văn bản trả lời</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {msg && <Notice kind="ok">{msg}</Notice>}
      <ErrorBox error={decide.error ?? letter.error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Hồ sơ bệnh nhân
// ---------------------------------------------------------------------------
export function ErasurePanel({ patientId }: { patientId: string }) {
  const { roles } = useSession();
  const allowed = can.erasureRequest(roles) || can.retention(roles);
  const reqs = useLoad(() => (allowed ? api<{ requests: ErasureRequest[] }>('GET', `/api/erasure-requests?patient=${patientId}`).then((r) => r.data.requests) : Promise.resolve([])), [patientId, allowed]);
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  const list = reqs.data ?? [];
  const active = list.find((r) => r.status === 'pending' || r.status === 'deferred');
  const done = list.find((r) => r.status === 'completed');
  return (
    <Card
      title="Quyền xoá dữ liệu cá nhân"
      actions={!active && !done && can.erasureRequest(roles) && !open ? <button className="link" onClick={() => setOpen(true)}>Lập yêu cầu xoá…</button> : undefined}
    >
      {done && <Notice kind="warn">Dữ liệu định danh của người bệnh này đã bị xoá theo yêu cầu ngày {dDate(done.decidedAt)} (khoá riêng đã huỷ).</Notice>}
      {active?.status === 'deferred' && (
        <Notice kind="warn">Đang <strong>hạn chế xử lý</strong> theo yêu cầu xoá: phần còn nghĩa vụ lưu giữ sẽ tự xoá sau {dDate(active.deferredUntil)}. Chỉ dùng hồ sơ cho khám chữa bệnh / nghĩa vụ pháp lý.</Notice>
      )}
      {active?.status === 'pending' && <Notice kind="info">Có yêu cầu xoá đang chờ duyệt (lập bởi {active.requestedByName ?? '—'} ngày {dDate(active.requestedAt)}).</Notice>}
      {!active && !done && !open && <p className="muted small">Người bệnh có quyền yêu cầu xoá dữ liệu cá nhân (Luật Bảo vệ dữ liệu cá nhân 2025). Lập yêu cầu không xoá gì — cần người thứ hai duyệt.</p>}
      {open && <ErasureForm patientId={patientId} onDone={() => { setOpen(false); reqs.reload(); }} onCancel={() => setOpen(false)} />}
      <ErrorBox error={reqs.error} />
    </Card>
  );
}

function ErasureForm({ patientId, onDone, onCancel }: { patientId: string; onDone: () => void; onCancel: () => void }) {
  const a = useLoad(() => api<Assessment & { erased: boolean }>('GET', `/api/erasure-assessment?patient=${patientId}`).then((r) => r.data), [patientId]);
  const [channel, setChannel] = useState('counter');
  const [note, setNote] = useState('');
  const submit = useAction(async () => {
    await api('POST', '/api/erasure-requests', { body: { patientId, channel, ...(note.trim() ? { note: note.trim() } : {}) } });
    onDone();
  });
  return (
    <div className="stack small-gap">
      {a.data && (
        <Notice kind={a.data.holdUntil ? 'warn' : 'info'}>
          <HoldText a={a.data} /> Phạm vi: {a.data.persons} danh tính, {a.data.identifiers} giấy tờ, {a.data.bookings} lịch hẹn.
        </Notice>
      )}
      <ErrorBox error={a.error} />
      <div className="row wrap">
        <Field label="Hình thức nhận">
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {Object.entries(CHANNEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Ghi chú (không ghi họ tên / SĐT / bệnh)" hint="vd. số đơn, người tiếp nhận">
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <button disabled={submit.busy || !a.data} onClick={() => void submit.run()}>Lập yêu cầu xoá</button>
        <button className="link" onClick={onCancel}>Thôi</button>
      </div>
      <ErrorBox error={submit.error} />
    </div>
  );
}
