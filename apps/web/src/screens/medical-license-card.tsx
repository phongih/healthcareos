/**
 * HCOS | Giấy phép khám chữa bệnh của tổ chức (chỉ tenant_admin nộp).
 *  - Chưa có số / bị từ chối: ô nhập số giấy phép và nút nộp.
 *  - Đang chờ duyệt: hiện số đã nộp, cho phép sửa và nộp lại.
 *  - Đã duyệt: chỉ hiện trạng thái, không cho sửa qua màn này.
 * Máy chủ kiểm tra quyền; người không phải tenant_admin sẽ không thấy card.
 */
import { useState } from 'react';

import { api } from '../lib/api';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

interface LicenseState {
  status: 'none' | 'pending' | 'approved' | 'rejected';
  licenseNo: string | null;
  note: string | null;
  submittedAt: string | null;
}

const LABEL: Record<LicenseState['status'], string> = {
  none: 'Chưa nộp',
  pending: 'Đang chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Bị từ chối',
};
const MIN = 5;
const MAX = 40;

export function MedicalLicenseCard() {
  const state = useLoad(() => api<LicenseState>('GET', '/api/tenant/medical-license').then((r) => r.data), []);
  const [licenseNo, setLicenseNo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = useAction(async () => {
    await api('POST', '/api/tenant/medical-license', { body: { licenseNo: licenseNo.trim() } });
    setMsg('Đã nộp số giấy phép. Vận hành sẽ đối chiếu và duyệt.');
    setLicenseNo('');
    state.reload();
  });

  // Không phải tenant_admin thì máy chủ trả 403: không hiện card.
  if (state.error || !state.data) return null;

  const s = state.data;
  const valid = licenseNo.trim().length >= MIN && licenseNo.trim().length <= MAX;
  const canSubmit = s.status !== 'approved';

  return (
    <Card title="Giấy phép khám chữa bệnh">
      <p className="muted">
        {s.status === 'approved'
          ? 'Giấy phép đã được duyệt. Tổ chức có thể nhận bệnh nhân thật.'
          : 'Số giấy phép do Sở Y tế cấp. Tổ chức chưa được duyệt giấy phép chỉ dùng dữ liệu thực tập, không nhận bệnh nhân thật.'}
      </p>
      <p>
        <strong>Trạng thái:</strong> {LABEL[s.status]}
        {s.licenseNo && <> · <span className="mono">{s.licenseNo}</span></>}
      </p>
      {s.status === 'rejected' && s.note && <Notice kind="warn">Lý do từ chối: {s.note}</Notice>}
      {msg && <Notice kind="ok">{msg}</Notice>}
      {canSubmit && (
        <div className="stack">
          <Field label="Số giấy phép khám chữa bệnh" hint={`${MIN}–${MAX} ký tự. Nộp lại sẽ đưa về trạng thái chờ duyệt.`}>
            <input value={licenseNo} maxLength={MAX} onChange={(e) => setLicenseNo(e.target.value)} placeholder="Ví dụ: 123/GPHD-SYT" />
          </Field>
          <div className="row">
            <button disabled={submit.busy || !valid} onClick={() => void submit.run()}>
              {s.status === 'pending' ? 'Nộp lại số giấy phép' : 'Nộp giấy phép'}
            </button>
          </div>
          <ErrorBox error={submit.error} />
        </div>
      )}
    </Card>
  );
}
