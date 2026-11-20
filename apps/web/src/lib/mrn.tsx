/**
 * HCOS-F13 | Mã bệnh nhân tự sinh trên giao diện: ô "Mã bệnh nhân" khi đăng ký (mặc định tự sinh; chỉ hiện "Dùng mã cũ" khi
 * cơ sở cho phép) và thẻ cài đặt cho quản lý.
 */
import { useState } from 'react';

import { api } from './api';
import { useSession } from './session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from './ui';

export interface MrnSettings { prefix: string; allowLegacy: boolean; version: number; nextPreview: string; example: string }

export function useMrnSettings() {
  const { orgId } = useSession();
  return useLoad(() => api<MrnSettings>('GET', `/api/patient-mrn/settings?organization=${orgId}`).then((r) => r.data), [orgId]);
}

/** Mã cũ: không được có dạng mã tự sinh (kiểm cả ở máy chủ). */
const RESERVED = /^[A-Za-z]{1,4}\d{2}-?\d{6}-?\d$/;

/**
 * Ô mã bệnh nhân khi đăng ký. `value` rỗng = tự sinh. Trả về chuỗi mã cũ (nếu người dùng chọn) qua onChange.
 */
export function MrnField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useMrnSettings();
  const [legacy, setLegacy] = useState(false);
  const reserved = legacy && RESERVED.test(value.trim());
  return (
    <div className="mrn-field">
      <span className="field-label">Mã bệnh nhân</span>
      {!legacy ? (
        <div className="mrn-auto">
          Tự sinh khi lưu{s.data ? <> — mã tiếp theo dự kiến <strong className="mono">{s.data.nextPreview}</strong></> : null}
        </div>
      ) : (
        <input
          required
          aria-label="Mã cũ"
          pattern="[A-Za-z0-9][A-Za-z0-9_.\/\-]{0,63}"
          placeholder="Mã trên sổ / phần mềm cũ"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {s.data?.allowLegacy && (
        <label className="small mrn-legacy">
          <input
            type="checkbox"
            checked={legacy}
            onChange={(e) => {
              setLegacy(e.target.checked);
              if (!e.target.checked) onChange('');
            }}
          />{' '}
          Dùng mã cũ (chuyển từ sổ giấy / phần mềm cũ)
        </label>
      )}
      {reserved && <span className="field-hint text-danger">Mã cũ không được có dạng mã tự sinh — bỏ chọn “Dùng mã cũ” để hệ thống tự cấp.</span>}
      <ErrorBox error={s.error} />
    </div>
  );
}

/** Thẻ cài đặt mã bệnh nhân (quản lý phòng khám / quản trị). */
export function MrnSettingsCard() {
  const { orgId } = useSession();
  const s = useMrnSettings();
  const [prefix, setPrefix] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<boolean | null>(null);
  const save = useAction(async () => {
    const cur = s.data!;
    await api('POST', '/api/patient-mrn/settings', {
      body: { organizationId: orgId, prefix: (prefix ?? cur.prefix).trim().toUpperCase(), allowLegacy: legacy ?? cur.allowLegacy },
      headers: { 'if-match': `W/"${cur.version}"` },
    });
    setPrefix(null);
    setLegacy(null);
    s.reload();
  });
  if (!s.data) return <ErrorBox error={s.error} />;
  const p = prefix ?? s.data.prefix;
  const okPrefix = /^[A-Za-z]{1,4}$/.test(p.trim());
  return (
    <Card title="Cài đặt mã bệnh nhân">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <p className="small muted">
          Mã tự sinh dạng <span className="mono">{s.data.example}</span>: tiền tố + 2 số năm đăng ký + số thứ tự (đếm lại mỗi năm) + số kiểm tra (gõ sai một chữ số sẽ
          bị phát hiện). Mã đã cấp không bao giờ đổi. Mã tiếp theo dự kiến: <strong className="mono">{s.data.nextPreview}</strong>.
        </p>
        <div className="row wrap">
          <Field label="Tiền tố (1–4 chữ cái)" hint="Chỉ áp dụng cho mã cấp từ nay">
            <input className="short" maxLength={4} value={p} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
          </Field>
          <label className="chip-check">
            <input type="checkbox" checked={legacy ?? s.data.allowLegacy} onChange={(e) => setLegacy(e.target.checked)} /> Cho nhập mã cũ khi đăng ký (bật khi đang chuyển dữ liệu
            từ sổ giấy / phần mềm cũ)
          </label>
        </div>
        {(legacy ?? s.data.allowLegacy) && <Notice kind="warn">Đang cho nhập mã cũ: lễ tân thấy ô “Dùng mã cũ”. Tắt lại khi chuyển dữ liệu xong.</Notice>}
        <div>
          <button type="submit" disabled={save.busy || !okPrefix || (prefix === null && legacy === null)}>
            Lưu cài đặt
          </button>
        </div>
        <ErrorBox error={save.error} />
      </form>
    </Card>
  );
}
