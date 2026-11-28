/**
 * HCOS-F18 | Duyệt tổ chức đăng ký mới (chỉ người vận hành nền tảng).
 *  - Danh sách tổ chức đang chờ duyệt: tên, mã số GPKD, SĐT, người đại diện, ngày đăng ký.
 *  - Duyệt => tổ chức hoạt động. Từ chối => bắt buộc ghi lý do (>= 5 ký tự), tổ chức đóng.
 *  - Máy chủ kiểm tra quyền người vận hành; màn này chỉ hiển thị.
 */
import { useState } from 'react';

import { api } from '../lib/api';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

interface PendingTenant {
  tenantId: string;
  name: string;
  slug: string;
  businessLicenseNo: string;
  contactPhone: string;
  adminName: string;
  adminEmail: string;
  createdAt: string;
}

const fmt = (iso: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
const MIN_NOTE = 5;

function PendingRow({ t, onDone }: { t: PendingTenant; onDone: (msg: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const decide = useAction(async (decision: 'approve' | 'reject', reason: string | null) => {
    await api('POST', `/api/platform/tenants/${t.tenantId}/decision`, { body: { decision, ...(reason !== null ? { note: reason } : {}) } });
    onDone(decision === 'approve' ? `Đã duyệt "${t.name}".` : `Đã từ chối "${t.name}".`);
  });
  const noteOk = note.trim().length >= MIN_NOTE;

  return (
    <tr>
      <td>
        <strong>{t.name}</strong>
        <div className="muted">{t.slug}</div>
      </td>
      <td className="nowrap">{t.businessLicenseNo}</td>
      <td className="nowrap">{t.contactPhone}</td>
      <td>
        {t.adminName}
        <div className="muted">{t.adminEmail}</div>
      </td>
      <td className="nowrap">{fmt(t.createdAt)}</td>
      <td>
        {!rejecting ? (
          <div className="row wrap">
            <button disabled={decide.busy} onClick={() => void decide.run('approve', null)}>Duyệt</button>
            <button className="secondary danger" disabled={decide.busy} onClick={() => setRejecting(true)}>Từ chối…</button>
          </div>
        ) : (
          <div className="stack">
            <Field label="Lý do từ chối" hint={`Tối thiểu ${MIN_NOTE} ký tự. Lý do được lưu trong nhật ký.`}>
              <textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="row wrap">
              <button className="danger" disabled={decide.busy || !noteOk} onClick={() => void decide.run('reject', note.trim())}>Xác nhận từ chối</button>
              <button className="secondary" disabled={decide.busy} onClick={() => { setRejecting(false); setNote(''); }}>Huỷ</button>
            </div>
          </div>
        )}
        <ErrorBox error={decide.error} />
      </td>
    </tr>
  );
}

interface PendingLicense {
  tenantId: string;
  name: string;
  slug: string;
  medicalLicenseNo: string;
  contactPhone: string | null;
  submittedAt: string | null;
}

function LicenseRow({ t, onDone }: { t: PendingLicense; onDone: (msg: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const decide = useAction(async (decision: 'approve' | 'reject', reason: string | null) => {
    await api('POST', `/api/platform/licenses/${t.tenantId}/decision`, { body: { decision, ...(reason !== null ? { note: reason } : {}) } });
    onDone(decision === 'approve' ? `Đã duyệt giấy phép của "${t.name}".` : `Đã từ chối giấy phép của "${t.name}".`);
  });
  const noteOk = note.trim().length >= MIN_NOTE;

  return (
    <tr>
      <td>
        <strong>{t.name}</strong>
        <div className="muted">{t.slug}</div>
      </td>
      <td className="nowrap">{t.medicalLicenseNo}</td>
      <td className="nowrap">{t.contactPhone ?? '—'}</td>
      <td className="nowrap">{t.submittedAt ? fmt(t.submittedAt) : '—'}</td>
      <td>
        {!rejecting ? (
          <div className="row wrap">
            <button disabled={decide.busy} onClick={() => void decide.run('approve', null)}>Duyệt</button>
            <button className="secondary danger" disabled={decide.busy} onClick={() => setRejecting(true)}>Từ chối…</button>
          </div>
        ) : (
          <div className="stack">
            <Field label="Lý do từ chối" hint={`Tối thiểu ${MIN_NOTE} ký tự.`}>
              <textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="row wrap">
              <button className="danger" disabled={decide.busy || !noteOk} onClick={() => void decide.run('reject', note.trim())}>Xác nhận từ chối</button>
              <button className="secondary" disabled={decide.busy} onClick={() => { setRejecting(false); setNote(''); }}>Huỷ</button>
            </div>
          </div>
        )}
        <ErrorBox error={decide.error} />
      </td>
    </tr>
  );
}

function LicenseQueueCard() {
  const list = useLoad(() => api<PendingLicense[]>('GET', '/api/platform/licenses/pending').then((r) => r.data), []);
  const [msg, setMsg] = useState<string | null>(null);
  const done = (text: string) => {
    setMsg(text);
    list.reload();
  };

  return (
    <Card title="Giấy phép khám chữa bệnh chờ duyệt">
      <p className="muted">
        Đối chiếu số giấy phép do Sở Y tế cấp với tên tổ chức trước khi duyệt. Tổ chức đã duyệt giấy phép mới nhận bệnh nhân thật.
      </p>
      {msg && <Notice kind="ok">{msg}</Notice>}
      <ErrorBox error={list.error} />
      {list.loading && !list.data && <p className="muted">Đang tải…</p>}
      {list.data && list.data.length === 0 && <Notice>Không có giấy phép nào đang chờ duyệt.</Notice>}
      {list.data && list.data.length > 0 && (
        <table>
          <thead>
            <tr><th>Tổ chức</th><th>Số giấy phép KCB</th><th>SĐT</th><th>Nộp lúc</th><th /></tr>
          </thead>
          <tbody>
            {list.data.map((t) => <LicenseRow key={t.tenantId} t={t} onDone={done} />)}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function ReviewScreen() {
  const list = useLoad(() => api<PendingTenant[]>('GET', '/api/platform/tenants/pending').then((r) => r.data), []);
  const [msg, setMsg] = useState<string | null>(null);

  const done = (text: string) => {
    setMsg(text);
    list.reload();
  };

  return (
    <div className="stack">
      <Card title="Duyệt tổ chức đăng ký mới">
        <p className="muted">
          Kiểm tra mã số GPKD và thông tin người đại diện trước khi duyệt. Tổ chức được duyệt mới đăng nhập và dùng hệ thống; tổ chức bị từ chối không hoạt động.
        </p>
        {msg && <Notice kind="ok">{msg}</Notice>}
        <ErrorBox error={list.error} />
        {list.loading && !list.data && <p className="muted">Đang tải…</p>}
        {list.data && list.data.length === 0 && <Notice>Không có tổ chức nào đang chờ duyệt.</Notice>}
        {list.data && list.data.length > 0 && (
          <table>
            <thead>
              <tr><th>Tổ chức</th><th>Mã số GPKD</th><th>SĐT</th><th>Người đại diện</th><th>Đăng ký</th><th /></tr>
            </thead>
            <tbody>
              {list.data.map((t) => <PendingRow key={t.tenantId} t={t} onDone={done} />)}
            </tbody>
          </table>
        )}
      </Card>
      <LicenseQueueCard />
    </div>
  );
}
