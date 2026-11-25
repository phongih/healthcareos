/**
 * HCOS-F20 | Phía nhân viên của cổng bệnh nhân:
 *  - PortalPanel (trang bệnh nhân): liên kết người giám hộ (xác minh giấy tờ TẠI QUẦY rồi mới tạo), số phiên đang mở + đăng xuất mọi thiết bị,
 *    yêu cầu đính chính của hồ sơ này;
 *  - PortalRequestsCard (tab Lịch hẹn): yêu cầu đính chính đang chờ của cơ sở, xử lý / từ chối có ghi chú.
 */
import { useState, type FormEvent } from 'react';

import { api } from '../lib/api';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

const RELATION: Record<string, string> = {
  parent: 'Cha / mẹ', legal_guardian: 'Người giám hộ hợp pháp', child: 'Con (đã thành niên)', spouse: 'Vợ / chồng', sibling: 'Anh / chị / em', other: 'Khác',
};
const LINK_STATUS: Record<string, string> = { active: 'Đang hiệu lực', expired: 'Hết hạn', revoked: 'Đã thu hồi' };
const REQ_STATUS: Record<string, string> = { open: 'Đang chờ', resolved: 'Đã xử lý', rejected: 'Từ chối' };

interface Link {
  linkId: string; role: 'guardian' | 'dependent'; relationship: string; validUntil: string; status: string; note: string | null;
  other: { name: string; mrn: string | null }; verifiedAt: string; verifiedByName: string | null; revokedAt: string | null; revokeReason: string | null;
}
interface Req { requestId: string; message: string; status: string; resolutionNote: string | null; createdAt: string; resolvedAt: string | null }
interface Panel { personId: string; links: Link[]; activeSessions: number; requests: Req[]; canResolve: boolean }

const fmtDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' }).format(new Date(iso.length === 10 ? `${iso}T00:00:00+07:00` : iso)) : '—');
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function PortalPanel({ patientId }: { patientId: string }) {
  const { roles } = useSession();
  const panel = useLoad(() => api<Panel>('GET', `/api/portal-admin/patients/${patientId}`).then((r) => r.data), [patientId]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const revokeAll = useAction(async () => {
    if (!confirm('Đăng xuất người bệnh khỏi mọi thiết bị đang đăng nhập cổng?')) return;
    const r = await api<{ revoked: number }>('POST', `/api/portal-admin/patients/${patientId}/revoke-sessions`, { body: {} });
    setMsg(`Đã đăng xuất ${r.data.revoked} phiên.`);
    panel.reload();
  });
  const revokeLink = useAction(async (id: string) => {
    const reason = prompt('Lý do thu hồi liên kết (bắt buộc):');
    if (!reason) return;
    await api('POST', `/api/portal-admin/guardians/${id}/revoke`, { body: { reason } });
    setMsg('Đã thu hồi liên kết.');
    panel.reload();
  });
  if (!can.portalManage(roles)) return null;
  const p = panel.data;
  return (
    <Card
      title="Cổng bệnh nhân"
      actions={p && p.activeSessions > 0 ? <button className="secondary" disabled={revokeAll.busy} onClick={() => void revokeAll.run()}>Đăng xuất mọi thiết bị ({p.activeSessions})</button> : undefined}
    >
      <ErrorBox error={panel.error ?? revokeAll.error ?? revokeLink.error} />
      {msg && <Notice kind="ok">{msg}</Notice>}
      {p && (
        <>
          <p className="muted">
            Người bệnh đăng nhập cổng bằng SĐT trong hồ sơ hoặc mã BN + ngày sinh (mã OTP gửi tới SĐT). Đang mở: {p.activeSessions} phiên.
          </p>
          <h4>Người giám hộ / người được giám hộ</h4>
          {p.links.length === 0 ? <p className="muted">Chưa có liên kết.</p> : (
            <table>
              <thead><tr><th>Vai</th><th>Người kia</th><th>Quan hệ</th><th>Hiệu lực</th><th>Trạng thái</th><th>Xác minh</th><th /></tr></thead>
              <tbody>
                {p.links.map((l) => (
                  <tr key={l.linkId}>
                    <td>{l.role === 'guardian' ? 'Giám hộ cho' : 'Được giám hộ bởi'}</td>
                    <td>{l.other.name} <span className="muted">{l.other.mrn ?? ''}</span></td>
                    <td>{RELATION[l.relationship] ?? l.relationship}</td>
                    <td>đến hết {fmtDate(dayBefore(l.validUntil))}</td>
                    <td>{LINK_STATUS[l.status] ?? l.status}{l.revokeReason ? <div className="muted">{l.revokeReason}</div> : null}</td>
                    <td>{l.verifiedByName ?? '—'} <span className="muted">{fmtDate(l.verifiedAt)}</span></td>
                    <td>{l.status === 'active' && <button className="link danger" disabled={revokeLink.busy} onClick={() => void revokeLink.run(l.linkId)}>Thu hồi</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!adding ? (
            <button className="secondary" onClick={() => { setAdding(true); setMsg(null); }}>+ Thêm người giám hộ</button>
          ) : (
            <LinkForm patientId={patientId} onDone={(ok) => { setAdding(false); if (ok) { setMsg('Đã tạo liên kết.'); panel.reload(); } }} />
          )}
          {p.requests.length > 0 && (
            <>
              <h4>Yêu cầu đính chính gửi qua cổng</h4>
              <ul className="plain">
                {p.requests.map((r) => (
                  <li key={r.requestId}>
                    <strong>{fmtDate(r.createdAt)}</strong> · {REQ_STATUS[r.status] ?? r.status}: {r.message}
                    {r.resolutionNote && <div className="muted">→ {r.resolutionNote}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

function LinkForm({ patientId, onDone }: { patientId: string; onDone: (ok: boolean) => void }) {
  const [mrn, setMrn] = useState('');
  const [rel, setRel] = useState('parent');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [verified, setVerified] = useState(false);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await api('POST', '/api/portal-admin/guardians', {
      body: { dependentPatientId: patientId, guardianMrn: mrn, relationship: rel, verified, ...(until ? { validUntil: until } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
    });
    onDone(true);
  });
  return (
    <form className="card inset" onSubmit={(e) => void save.run(e)}>
      <p className="muted">
        Người giám hộ phải là bệnh nhân đã có hồ sơ tại cơ sở. Với trẻ em, liên kết <strong>tự hết khi trẻ đủ 18 tuổi</strong>; với người đã thành niên cần nhập ngày hết hạn
        (vd. theo quyết định giám hộ / giấy uỷ quyền).
      </p>
      <div className="row wrap">
        <Field label="Mã BN người giám hộ *" hint="người giám hộ phải có hồ sơ tại cơ sở">
          <input required autoCapitalize="characters" spellCheck={false} maxLength={64} value={mrn} onChange={(e) => setMrn(e.target.value)} placeholder="BN26-000123-5" />
        </Field>
        <Field label="Quan hệ (người giám hộ là … của người bệnh)">
          <select value={rel} onChange={(e) => setRel(e.target.value)}>
            {Object.entries(RELATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Hết hạn" hint="trẻ em: bỏ trống = đến sinh nhật 18"><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
      </div>
      <Field label="Ghi chú (số giấy tờ đã xem, không ghi thông tin sức khoẻ)"><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <label className="check">
        <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> Tôi đã đối chiếu giấy tờ tuỳ thân và giấy tờ chứng minh quan hệ (khai sinh / quyết định giám hộ) tại quầy
      </label>
      <ErrorBox error={save.error} />
      <div className="row">
        <button disabled={save.busy || !verified || !mrn}>Tạo liên kết</button>
        <button type="button" className="link" onClick={() => onDone(false)}>Huỷ</button>
      </div>
    </form>
  );
}

interface ListReq extends Req { patientId: string | null; mrn: string | null; name: string; byGuardian: boolean; resolvedByName: string | null }

export function PortalRequestsCard() {
  const { orgId, roles } = useSession();
  const [all, setAll] = useState(false);
  const list = useLoad(
    () => api<{ requests: ListReq[]; canResolve: boolean }>('GET', `/api/portal-admin/requests?organization=${orgId}${all ? '&status=all' : ''}`).then((r) => r.data),
    [orgId, all],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const resolve = useAction(async (id: string, status: 'resolved' | 'rejected') => {
    await api('POST', `/api/portal-admin/requests/${id}/resolve`, { body: { status, note } });
    setOpen(null);
    setNote('');
    list.reload();
  });
  if (!can.portalManage(roles)) return null;
  const rows = list.data?.requests ?? [];
  return (
    <Card
      title={`Yêu cầu đính chính từ cổng bệnh nhân${list.data && !all ? ` (${rows.length} đang chờ)` : ''}`}
      actions={<label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Cả đã xử lý</label>}
    >
      <ErrorBox error={list.error ?? resolve.error} />
      {list.data && rows.length === 0 && <p className="muted">Không có yêu cầu{all ? '' : ' đang chờ'}.</p>}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>Ngày</th><th>Bệnh nhân</th><th>Nội dung</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.requestId}>
                <td>{fmtDate(r.createdAt)}</td>
                <td>{r.patientId ? <a href={`#/patients/${r.patientId}`}>{r.name}</a> : r.name} <span className="muted">{r.mrn ?? ''}</span>{r.byGuardian && <div className="muted">do người giám hộ gửi</div>}</td>
                <td>{r.message}</td>
                <td>{REQ_STATUS[r.status] ?? r.status}{r.resolutionNote && <div className="muted">{r.resolutionNote}{r.resolvedByName ? ` — ${r.resolvedByName}` : ''}</div>}</td>
                <td>
                  {r.status === 'open' && list.data?.canResolve && (open === r.requestId ? (
                    <div className="stack">
                      <input placeholder="Ghi chú phản hồi (người bệnh sẽ thấy) *" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                      <div className="row">
                        <button disabled={resolve.busy || note.trim().length < 5} onClick={() => void resolve.run(r.requestId, 'resolved')}>Đã xử lý</button>
                        <button className="secondary" disabled={resolve.busy || note.trim().length < 5} onClick={() => void resolve.run(r.requestId, 'rejected')}>Từ chối</button>
                        <button className="link" onClick={() => setOpen(null)}>Huỷ</button>
                      </div>
                    </div>
                  ) : (
                    <button className="link" onClick={() => { setOpen(r.requestId); setNote(''); }}>Xử lý</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">Sửa hồ sơ hành chính ở trang bệnh nhân sau khi đối chiếu giấy tờ; bệnh án sửa bằng đính chính có kiểm soát (không xoá).</p>
    </Card>
  );
}
