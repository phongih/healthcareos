/**
 * HCOS-F18 | Tab Quản trị dữ liệu: sổ nhà cung cấp (đánh giá, thu hồi, tạm ngừng), nhật ký xuất dữ liệu, sổ nguồn dữ liệu AI.
 * Server quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useState } from 'react';

import { api } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

type Standing = 'approved' | 'expiring' | 'expired' | 'rejected' | 'not_assessed' | 'inactive';
interface Assessment {
  assessmentId: string; decision: 'approved' | 'rejected'; dpaReference: string | null; dataCategories: string[]; dataLocation: string; crossBorder: boolean;
  measures: string; rationale: string; validFrom: string; validUntil: string; assessedByName: string | null; assessedAt: string;
}
interface Vendor {
  vendorId: string; name: string; kind: string; role: string; services: string; contact: string | null; status: 'active' | 'suspended' | 'terminated';
  statusNote: string | null; version: number; latest: Assessment | null; clearedOperational: boolean; standing: Standing; endpoints: number;
}
interface ExportRecord {
  exportId: string; dataset: string; params: Record<string, unknown>; rowCount: number; containsPersonal: boolean; purpose: string | null; fileName: string;
  byteSize: number; sha256: string; exportedByName: string | null; exportedAt: string;
}
export interface AiComponent {
  id: string; name: string; kind: string; version: string; sha256: string; files: string[]; source: string; owner: string;
  validation: 'unvalidated' | 'internal_review' | 'validated'; validationNote: string; permittedUse: string; prohibitedUse: string; runsAt: 'browser' | 'server'; changeNote: string;
}

const KIND: Record<string, string> = {
  cloud_hosting: 'Hạ tầng đám mây / sao lưu', messaging: 'Nhắn tin (Teams…)', webhook_partner: 'Đối tác nhận webhook', ai_service: 'Dịch vụ AI', software: 'Phần mềm', other: 'Khác',
};
const ROLE: Record<string, string> = { processor: 'Bên xử lý', sub_processor: 'Bên xử lý phụ', third_party: 'Bên thứ ba' };
const CAT: Record<string, string> = { operational: 'Vận hành (không định danh)', backup_encrypted: 'Bản sao lưu đã mã hoá', personal: 'Cá nhân cơ bản', health: 'Sức khoẻ' };
const STANDING: Record<Standing, [string, string]> = {
  approved: ['Đã duyệt', 'ok'], expiring: ['Sắp hết hạn', 'warn'], expired: ['Hết hạn — chặn gửi', 'err'], rejected: ['Bị từ chối / thu hồi — chặn gửi', 'err'],
  not_assessed: ['Chưa đánh giá — chặn gửi', 'err'], inactive: ['Tạm ngừng / chấm dứt — chặn gửi', 'err'],
};
const DATASET: Record<string, string> = { finance_report: 'Báo cáo tài chính', governance_dossier: 'Hồ sơ tự đánh giá', erasure_letter: 'Trả lời yêu cầu xoá' };
const VALID: Record<AiComponent['validation'], string> = { unvalidated: 'Chưa kiểm định', internal_review: 'Đã rà soát nội bộ', validated: 'Đã kiểm định' };
const today = () => new Date().toISOString().slice(0, 10);
const plusYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
export function VendorsCard() {
  const v = useLoad(() => api<{ vendors: Vendor[]; canManage: boolean }>('GET', '/api/vendors').then((r) => r.data), []);
  const [adding, setAdding] = useState(false);
  const [assessing, setAssessing] = useState<Vendor | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (v.error) return <ErrorBox error={v.error} />;
  if (!v.data) return null;
  const { vendors, canManage } = v.data;
  return (
    <Card title={`Nhà cung cấp / bên thứ ba (${vendors.length})`} actions={canManage && !adding ? <button className="link" onClick={() => setAdding(true)}>+ Nhà cung cấp</button> : undefined}>
      <p className="muted small">
        Bên nhận / xử lý dữ liệu cho cơ sở (hạ tầng, sao lưu, Teams, đối tác webhook…). Kết nối ngoài <strong>chỉ gửi</strong> khi nhà cung cấp có đánh giá còn hiệu lực
        (thoả thuận xử lý dữ liệu, nơi lưu, loại dữ liệu được nhận; tối đa 3 năm). Thu hồi = ghi đánh giá "Từ chối" mới. Dịch vụ AI không bao giờ được nhận dữ liệu cá nhân / sức khoẻ.
        Chủ quản vẫn chịu trách nhiệm — sổ này là bằng chứng đã đánh giá.
      </p>
      {adding && <VendorForm onDone={() => { setAdding(false); v.reload(); }} onCancel={() => setAdding(false)} />}
      {assessing && <AssessForm vendor={assessing} onDone={() => { setAssessing(null); v.reload(); }} onCancel={() => setAssessing(null)} />}
      {vendors.length === 0 ? <p className="muted">Chưa đăng ký nhà cung cấp nào.</p> : (
        <table>
          <thead><tr><th>Nhà cung cấp</th><th>Đánh giá</th><th>Dữ liệu được nhận</th><th>Nơi lưu</th><th>Hiệu lực đến</th><th>Kết nối</th><th /></tr></thead>
          <tbody>
            {vendors.flatMap((x) => {
              const [label, tone] = STANDING[x.standing];
              const rows = [
                <tr key={x.vendorId} className={x.status === 'terminated' ? 'muted-row' : ''}>
                  <td><strong>{x.name}</strong><div className="muted small">{KIND[x.kind]} · {ROLE[x.role]} · {x.services}</div></td>
                  <td><span className={`badge ${tone}`}>{label}</span>{x.statusNote && <div className="muted small">{x.statusNote}</div>}</td>
                  <td className="small">{x.latest ? x.latest.dataCategories.map((c) => CAT[c] ?? c).join(', ') : '—'}</td>
                  <td className="small">{x.latest ? `${x.latest.dataLocation}${x.latest.crossBorder ? ' (ra nước ngoài)' : ''}` : '—'}</td>
                  <td>{x.latest?.decision === 'approved' ? new Date(x.latest.validUntil).toLocaleDateString('vi-VN') : '—'}</td>
                  <td>{x.endpoints}</td>
                  <td className="actions">
                    <button className="link" onClick={() => setOpen(open === x.vendorId ? null : x.vendorId)}>Lịch sử</button>
                    {canManage && x.status !== 'terminated' && (
                      <>
                        <button className="link" onClick={() => setAssessing(x)}>Đánh giá</button>
                        <StatusButtons vendor={x} onChanged={v.reload} />
                      </>
                    )}
                  </td>
                </tr>,
              ];
              if (open === x.vendorId) rows.push(<tr key={`${x.vendorId}-h`}><td colSpan={7}><History vendorId={x.vendorId} /></td></tr>);
              return rows;
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function StatusButtons({ vendor, onChanged }: { vendor: Vendor; onChanged: () => void }) {
  const set = useAction(async (status: 'active' | 'suspended' | 'terminated') => {
    let note: string | null = null;
    if (status !== 'active') {
      note = prompt(status === 'suspended' ? `Lý do tạm ngừng gửi dữ liệu cho "${vendor.name}"?` : `Lý do chấm dứt "${vendor.name}" (không bật lại được)?`);
      if (note === null) return;
    }
    await api('POST', `/api/vendors/${vendor.vendorId}/status`, { body: { status, version: vendor.version, ...(note ? { note } : {}) } });
    onChanged();
  });
  return (
    <>
      {vendor.status === 'active' ? <button className="link danger" disabled={set.busy} onClick={() => void set.run('suspended')}>Tạm ngừng</button>
        : <button className="link" disabled={set.busy} onClick={() => void set.run('active')}>Hoạt động lại</button>}
      <button className="link danger" disabled={set.busy} onClick={() => void set.run('terminated')}>Chấm dứt</button>
      <ErrorBox error={set.error} />
    </>
  );
}

function History({ vendorId }: { vendorId: string }) {
  const h = useLoad(() => api<{ assessments: Assessment[] }>('GET', `/api/vendors/${vendorId}/assessments`).then((r) => r.data.assessments), [vendorId]);
  if (h.error) return <ErrorBox error={h.error} />;
  if (!h.data) return null;
  if (h.data.length === 0) return <p className="muted small">Chưa có đánh giá.</p>;
  return (
    <ul className="small">
      {h.data.map((a) => (
        <li key={a.assessmentId}>
          <strong>{a.decision === 'approved' ? 'Duyệt' : 'Từ chối / thu hồi'}</strong> · {fmtDateTime(a.assessedAt)} · {a.assessedByName ?? '—'} · hiệu lực {a.validFrom} → {a.validUntil}
          {a.dpaReference && <> · thoả thuận {a.dpaReference}</>} — {a.rationale}
          <div className="muted">Biện pháp: {a.measures}</div>
        </li>
      ))}
    </ul>
  );
}

function VendorForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', kind: 'messaging', role: 'processor', services: '', contact: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(async () => {
    await api('POST', '/api/vendors', { body: { ...f, contact: f.contact.trim() || null } });
    onDone();
  });
  return (
    <form className="stack small-gap" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <div className="row wrap">
        <Field label="Tên nhà cung cấp *"><input required minLength={2} value={f.name} onChange={set('name')} placeholder="vd. Microsoft (Teams)" /></Field>
        <Field label="Loại"><select value={f.kind} onChange={set('kind')}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Vai trò"><select value={f.role} onChange={set('role')}>{Object.entries(ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <div className="row wrap">
        <Field label="Dịch vụ cung cấp *"><input required minLength={3} value={f.services} onChange={set('services')} placeholder="vd. Nhận thông báo vận hành vào kênh Teams" /></Field>
        <Field label="Đầu mối liên hệ"><input value={f.contact} onChange={set('contact')} /></Field>
      </div>
      <div className="row"><button disabled={save.busy}>Thêm</button><button type="button" className="link" onClick={onCancel}>Thôi</button></div>
      <ErrorBox error={save.error} />
    </form>
  );
}

function AssessForm({ vendor, onDone, onCancel }: { vendor: Vendor; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    decision: 'approved', dpaReference: '', dataLocation: vendor.latest?.dataLocation ?? '', crossBorder: vendor.latest?.crossBorder ?? false,
    measures: '', rationale: '', validFrom: today(), validUntil: plusYear(),
  });
  const [cats, setCats] = useState<Set<string>>(new Set(vendor.latest?.dataCategories ?? ['operational']));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(async () => {
    await api('POST', `/api/vendors/${vendor.vendorId}/assessments`, {
      body: { ...f, dpaReference: f.dpaReference.trim() || null, dataCategories: [...cats] },
    });
    onDone();
  });
  const ai = vendor.kind === 'ai_service';
  return (
    <form className="stack small-gap card" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <strong>Đánh giá: {vendor.name}</strong>
      <div className="row wrap">
        <Field label="Kết luận">
          <select value={f.decision} onChange={set('decision')}><option value="approved">Duyệt</option><option value="rejected">Từ chối / thu hồi</option></select>
        </Field>
        <Field label="Số thoả thuận xử lý dữ liệu" hint="Bắt buộc khi duyệt"><input value={f.dpaReference} onChange={set('dpaReference')} placeholder="vd. HĐ 12/2026 – Phụ lục DPA" /></Field>
        <Field label="Nơi lưu / xử lý *"><input required value={f.dataLocation} onChange={set('dataLocation')} placeholder="vd. Singapore (asia-southeast1)" /></Field>
        <Field label="Chuyển ra nước ngoài">
          <select value={f.crossBorder ? 'y' : 'n'} onChange={(e) => setF({ ...f, crossBorder: e.target.value === 'y' })}><option value="n">Không</option><option value="y">Có</option></select>
        </Field>
      </div>
      <div className="row wrap">
        <span className="muted small">Loại dữ liệu được nhận:</span>
        {Object.entries(CAT).map(([k, l]) => (
          <label key={k} className="check">
            <input type="checkbox" disabled={ai && (k === 'personal' || k === 'health')} checked={cats.has(k)}
              onChange={(e) => { const n = new Set(cats); if (e.target.checked) n.add(k); else n.delete(k); setCats(n); }} /> {l}
          </label>
        ))}
      </div>
      {ai && <Notice kind="warn">Dịch vụ AI: không được nhận dữ liệu cá nhân / sức khoẻ (hệ thống chặn).</Notice>}
      <Field label="Biện pháp bảo vệ đã kiểm tra * (≥ 20 ký tự)"><textarea rows={2} value={f.measures} onChange={set('measures')} /></Field>
      <Field label="Căn cứ / nhận xét * (≥ 10 ký tự)"><textarea rows={2} value={f.rationale} onChange={set('rationale')} /></Field>
      <div className="row wrap">
        <Field label="Hiệu lực từ"><input type="date" value={f.validFrom} onChange={set('validFrom')} /></Field>
        <Field label="Đến (tối đa 3 năm)"><input type="date" value={f.validUntil} onChange={set('validUntil')} /></Field>
      </div>
      <div className="row"><button disabled={save.busy}>Ghi đánh giá</button><button type="button" className="link" onClick={onCancel}>Thôi</button></div>
      <ErrorBox error={save.error} />
    </form>
  );
}

// ---------------------------------------------------------------------------
export function ExportLogCard() {
  const [sha, setSha] = useState('');
  const [q, setQ] = useState('');
  const log = useLoad(() => api<{ exports: ExportRecord[] }>('GET', `/api/exports${q ? `?sha256=${q}` : ''}`).then((r) => r.data.exports), [q]);
  return (
    <Card title="Nhật ký xuất dữ liệu">
      <p className="muted small">
        Mọi file (Excel báo cáo, hồ sơ, văn bản trả lời) do máy chủ tạo, có dấu người xuất và mã xuất trong file. File có dữ liệu cá nhân bắt buộc ghi mục đích.
        Gặp một file trôi nổi: tính SHA-256 của file (vd. <code>sha256sum tên-file</code>) rồi tra ở đây.
      </p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setQ(sha.trim().toLowerCase()); }}>
        <Field label="Tra theo SHA-256"><input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="64 ký tự hex" style={{ width: 420 }} /></Field>
        <button className="secondary">Tra</button>
        {q && <button type="button" className="link" onClick={() => { setSha(''); setQ(''); }}>Bỏ lọc</button>}
      </form>
      <ErrorBox error={log.error} />
      {log.data && (log.data.length === 0 ? <p className="muted">Không có.</p> : (
        <table>
          <thead><tr><th>Lúc</th><th>Người xuất</th><th>Dữ liệu</th><th>Số dòng</th><th>Cá nhân</th><th>Mục đích</th><th>SHA-256</th></tr></thead>
          <tbody>
            {log.data.map((x) => (
              <tr key={x.exportId}>
                <td>{fmtDateTime(x.exportedAt)}</td>
                <td>{x.exportedByName ?? '—'}</td>
                <td>{DATASET[x.dataset] ?? x.dataset}<div className="muted small">{x.fileName}</div></td>
                <td>{x.rowCount}</td>
                <td>{x.containsPersonal ? 'Có' : 'Không'}</td>
                <td className="small">{x.purpose ?? '—'}</td>
                <td><code title={x.sha256}>{x.sha256.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
export function AiRegistryCard({ ai }: { ai: AiComponent[] }) {
  return (
    <Card title={`Nguồn dữ liệu AI (${ai.length})`}>
      <p className="muted small">
        Mọi thành phần AI chạy cục bộ, không gửi dữ liệu người bệnh ra ngoài (trình duyệt chỉ kết nối tới máy chủ). Mỗi thành phần có phiên bản + SHA-256;
        CI chặn mọi thay đổi dữ liệu / luật AI chưa cập nhật sổ. Kết quả AI chỉ là gợi ý.
      </p>
      <table>
        <thead><tr><th>Thành phần</th><th>Phiên bản</th><th>Kiểm định</th><th>Chạy tại</th><th>Được dùng để</th><th>Không được dùng để</th></tr></thead>
        <tbody>
          {ai.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.name}</strong><div className="muted small">{c.source}</div><div className="muted small">Chịu trách nhiệm: {c.owner}</div></td>
              <td>{c.version}<div><code title={c.sha256}>{c.sha256.slice(0, 12)}…</code></div></td>
              <td><span className={`badge ${c.validation === 'validated' ? 'ok' : c.validation === 'internal_review' ? 'warn' : 'err'}`}>{VALID[c.validation]}</span>
                <div className="muted small">{c.validationNote}</div></td>
              <td>{c.runsAt === 'browser' ? 'Trình duyệt' : 'Máy chủ'}</td>
              <td className="small">{c.permittedUse}</td>
              <td className="small">{c.prohibitedUse}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
