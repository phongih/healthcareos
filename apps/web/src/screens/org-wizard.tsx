/**
 * HCOS | Wizard mở cơ sở (thiết kế mục 3): 5 bước trên API POST /api/admin/organizations có sẵn.
 *   1. Thông tin cơ sở   — tên, mã, tiền tố mã bệnh nhân, nguồn sao chép cấu hình
 *   2. Phòng khám & ca   — chép số chỗ / phòng khám (servicePoints), cài đặt mã bệnh nhân (mrnSettings)
 *   3. Dịch vụ & bảng giá — bảng giá, định mức vật tư, thiết bị yêu cầu
 *   4. Nhân sự & quyền   — tạm ứng, dự báo, quầy trả, luật quyết định (không chép tài khoản ngân hàng)
 *   5. Kiểm tra & mở     — tóm tắt, rồi tạo cơ sở
 * Nháp chỉ giữ trong trình duyệt (chưa lưu server). Quyền tenant_admin do máy chủ kiểm tra.
 */
import { useState, type FormEvent } from 'react';

import { api } from '../lib/api';
import { Card, ErrorBox, Field, Notice, useAction } from '../lib/ui';

export const COPY: Array<[string, string]> = [
  ['servicePoints', 'Phòng khám (+ số chỗ đặt lịch / sức khám)'], ['priceList', 'Bảng giá dịch vụ'], ['supplyNorms', 'Định mức vật tư theo dịch vụ'],
  ['deviceRequirements', 'Dịch vụ cần thiết bị'], ['financeSettings', 'Tạm ứng mặc định (KHÔNG chép tài khoản ngân hàng)'], ['forecastSettings', 'Thông số dự báo'],
  ['handoverDesks', 'Quầy trả'], ['decisionRules', 'Luật Decision Engine'], ['mrnSettings', 'Cài đặt mã bệnh nhân'],
];

/** Nhóm copy theo từng bước của wizard. */
const STEP_COPY: Record<2 | 3 | 4, string[]> = {
  2: ['servicePoints', 'mrnSettings'],
  3: ['priceList', 'supplyNorms', 'deviceRequirements'],
  4: ['financeSettings', 'forecastSettings', 'handoverDesks', 'decisionRules'],
};
const STEP_TITLE: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Thông tin cơ sở',
  2: 'Phòng khám & ca khám',
  3: 'Dịch vụ & bảng giá',
  4: 'Nhân sự & quyền',
  5: 'Kiểm tra & mở',
};

export interface WizardOrg { organizationId: string; name: string; status: string }

const CODE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function OrgWizard({ orgs, onDone, onCancel }: { orgs: WizardOrg[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [prefix, setPrefix] = useState('');
  const [from, setFrom] = useState(orgs.find((o) => o.status === 'active')?.organizationId ?? '');
  const [copy, setCopy] = useState<Record<string, boolean>>(Object.fromEntries(COPY.map(([k]) => [k, k !== 'decisionRules'])));
  const [localErr, setLocalErr] = useState<string | null>(null);

  const label = (k: string) => COPY.find(([x]) => x === k)?.[1].split(' (')[0] ?? k;
  const sourceName = orgs.find((o) => o.organizationId === from)?.name;

  const create = useAction(async () => {
    const r = await api<{ copied: Record<string, number> }>('POST', '/api/admin/organizations', {
      body: { code, name: name.trim(), ...(prefix ? { mrnPrefix: prefix } : {}), ...(from ? { copyFrom: from, copy } : {}) },
    });
    const c = Object.entries(r.data.copied).filter(([, n]) => n > 0).map(([k, n]) => `${label(k)}: ${n}`);
    onDone(`Đã tạo ${name.trim()}.${c.length ? ` Đã chép — ${c.join('; ')}.` : ''} Cấp vai trò quản lý cho người phụ trách ở bảng Nhân sự; cổng đặt lịch, kho, thiết bị, tài khoản ngân hàng cấu hình riêng.`);
  });

  const next = (e?: FormEvent) => {
    e?.preventDefault();
    setLocalErr(null);
    if (step === 1) {
      if (name.trim().length < 3) return setLocalErr('Tên cơ sở tối thiểu 3 ký tự.');
      if (!CODE.test(code)) return setLocalErr('Mã cơ sở: chữ thường, số, gạch ngang; 2–40 ký tự.');
      if (prefix && !/^[A-Za-z]{1,4}$/.test(prefix)) return setLocalErr('Tiền tố mã bệnh nhân: 1–4 chữ cái.');
      // Không có nguồn sao chép thì bỏ qua bước 2–4.
      setStep(from ? 2 : 5);
      return;
    }
    if (step === 5) return;
    setStep((step + 1) as 2 | 3 | 4 | 5);
  };
  const back = () => {
    setLocalErr(null);
    if (step === 5) setStep(from ? 4 : 1);
    else setStep((step - 1) as 1 | 2 | 3 | 4);
  };

  const stepCopy = (s: 2 | 3 | 4) => (
    <fieldset className="roles">
      <legend>{STEP_TITLE[s]} — chép từ {sourceName}</legend>
      {STEP_COPY[s].map((k) => (
        <label key={k} className="check">
          <input type="checkbox" checked={!!copy[k]} onChange={(e) => setCopy({ ...copy, [k]: e.target.checked })} /> {COPY.find(([x]) => x === k)?.[1]}
        </label>
      ))}
    </fieldset>
  );

  return (
    <Card title={`Mở cơ sở mới — bước ${step}/5: ${STEP_TITLE[step]}`} actions={<button className="link" onClick={onCancel}>Huỷ</button>}>
      <form className="stack" onSubmit={(e) => (step === 5 ? (e.preventDefault(), void create.run()) : next(e))}>
        {step === 1 && (
          <>
            <div className="row wrap">
              <Field label="Tên cơ sở *"><input required minLength={3} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Mã *" hint="chữ thường, số, gạch — vd. pk-quan-7"><input required value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} /></Field>
              <Field label="Tiền tố mã BN" hint="1–4 chữ cái, nên khác cơ sở khác (vd. Q7)"><input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} /></Field>
            </div>
            <Field label="Sao chép cấu hình từ" hint="Không chép người bệnh, phiếu thu, ca, kho, thiết bị, cổng đặt lịch, kết nối ngoài.">
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">— Không sao chép (cơ sở trống) —</option>
                {orgs.filter((o) => o.status === 'active').map((o) => <option key={o.organizationId} value={o.organizationId}>{o.name}</option>)}
              </select>
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <Notice>Số phòng khám và ca khám được chép từ cơ sở nguồn. Bạn vẫn chỉnh được trong Hàng đợi sau khi mở.</Notice>
            {stepCopy(2)}
          </>
        )}

        {step === 3 && (
          <>
            <Notice>Bảng giá và định mức vật tư được chép; có thể sửa sau trong từng màn.</Notice>
            {stepCopy(3)}
          </>
        )}

        {step === 4 && (
          <>
            <Notice kind="warn">Nhân sự không được chép. Sau khi mở, cấp vai trò quản lý cơ sở cho người phụ trách ở bảng Nhân sự.</Notice>
            {stepCopy(4)}
          </>
        )}

        {step === 5 && (
          <div className="stack">
            <p><strong>{name.trim()}</strong> · mã <span className="mono">{code}</span>{prefix && <> · tiền tố BN <span className="mono">{prefix}</span></>}</p>
            {from ? (
              <p className="muted">
                Chép từ <strong>{sourceName}</strong>: {COPY.filter(([k]) => copy[k]).map(([k]) => label(k)).join('; ') || 'không mục nào'}.
              </p>
            ) : (
              <p className="muted">Cơ sở trống, không sao chép cấu hình.</p>
            )}
          </div>
        )}

        {localErr && <Notice kind="warn">{localErr}</Notice>}
        <ErrorBox error={create.error} />

        <div className="row">
          {step > 1 && <button type="button" className="secondary" onClick={back} disabled={create.busy}>Quay lại</button>}
          {step < 5 && <button type="submit">Tiếp tục</button>}
          {step === 5 && <button type="submit" disabled={create.busy}>Mở cơ sở</button>}
        </div>
      </form>
    </Card>
  );
}
