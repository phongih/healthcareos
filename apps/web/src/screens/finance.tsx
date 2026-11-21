/**
 * Thu ngân (HCOS-F8): ca thu ngân, hồ sơ thanh toán (chi phí, phiếu thu tạm ứng / thanh toán, phiếu chi hoàn ứng),
 * in phiếu, VietQR, cài đặt bảng giá. Lễ tân kiêm thu ngân (clinic_staff) và thu ngân (cashier) đều dùng được.
 * Server là nơi quyết định quyền và quy tắc tiền; giao diện chỉ gợi ý số tiền và ẩn nút.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { entries, fmtDateTime, mrnOf, patientName, type Bundle, type FhirPatient } from '../lib/fhir';
import { fmtVnd, parseVnd, vndInWords } from '../lib/money';
import { QrCode } from '../lib/qr-view';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, navigate, useAction, useIntentKey, useLoad } from '../lib/ui';
import { transferNote, vietQrPayload } from '../lib/vietqr';
import { CaseSuppliesCard } from './equipment';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu (khớp API)
// ---------------------------------------------------------------------------
export type Method = 'cash' | 'bank_transfer' | 'card';
export type Kind = 'deposit' | 'payment' | 'refund';
export interface Settings { depositDefault: number; bank: { bin: string; account: string; accountName: string } | null; version: number }
export interface PriceItem { itemId: string; code: string; name: string; category: string; unitPrice: number; isActive: boolean; version: number }
type Totals = Record<Method, { in: number; out: number; count: number }>;
export interface Shift {
  shiftId: string; userId: string; userName: string | null; status: 'open' | 'closed'; openingFloat: number; openedAt: string; closedAt: string | null;
  countedCash: number | null; expectedCash: number | null; cashDifference: number | null; closeNote: string | null; version: number;
  totals?: Totals; cancelledCount?: number; cashOnHand?: number;
}
interface Charge { chargeId: string; itemCode: string; description: string; quantity: number; unitPrice: number; amount: number; status: string; createdAt: string; voidReason: string | null }
export interface Receipt {
  receiptId: string; receiptNo: string; kind: Kind; method: Method; amount: number; reference: string | null; payerName: string | null; status: string;
  createdByName: string | null; createdAt: string; cancelReason: string | null;
}
export interface CaseDetail {
  caseId: string; status: 'open' | 'closed'; openedAt: string; closedAt: string | null; version: number;
  patient: { patientId: string; mrn: string; familyName: string; givenName: string; birthDate: string | null };
  totals: { charges: number; received: number; refunded: number; balance: number };
  charges: Charge[]; receipts: Receipt[];
}
interface CaseRow { caseId: string; patient: CaseDetail['patient']; openedAt: string; totals: CaseDetail['totals'] }

export const KIND_LABEL: Record<Kind, string> = { deposit: 'Tạm ứng', payment: 'Thanh toán', refund: 'Hoàn ứng' };
export const METHOD_LABEL: Record<Method, string> = { cash: 'Tiền mặt', bank_transfer: 'Chuyển khoản', card: 'Thẻ (POS)' };
const CATEGORY_LABEL: Record<string, string> = { exam: 'Khám', procedure: 'Thủ thuật', lab: 'Xét nghiệm', imaging: 'Chẩn đoán hình ảnh', drug: 'Thuốc', other: 'Khác' };

export const useSettings = () => {
  const { orgId } = useSession();
  return useLoad(() => api<Settings>('GET', `/api/finance/settings?organization=${orgId}`).then((r) => r.data), [orgId]);
};
export const useMyShift = () => {
  const { orgId } = useSession();
  return useLoad(() => api<{ shift: Shift | null }>('GET', `/api/finance/shifts/mine?organization=${orgId}`).then((r) => r.data.shift), [orgId]);
};
const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

const REASON_TEXT: Record<string, string> = {
  NO_OPEN_SHIFT: 'Bạn chưa mở ca thu ngân. Mở ca ở tab Thu ngân trước khi thu tiền.',
  SHIFT_NOT_OPEN: 'Ca của phiếu đã đóng — không huỷ được nữa.',
  PAYMENT_EXCEEDS_DUE: 'Số tiền thanh toán lớn hơn số còn phải thu.',
  REFUND_EXCEEDS_CREDIT: 'Số tiền hoàn lớn hơn số dư tạm ứng.',
  REFERENCE_REQUIRED: 'Chuyển khoản / thẻ cần mã tham chiếu (nội dung chuyển khoản hoặc mã chuẩn chi trên hoá đơn POS).',
  BALANCE_NOT_ZERO: 'Còn chênh lệch — thu thêm hoặc hoàn ứng cho đủ rồi mới đóng hồ sơ.',
  NOT_SHIFT_OWNER: 'Chỉ người lập phiếu (trong ca của mình) mới huỷ được.',
  CASE_NOT_OPEN: 'Hồ sơ thanh toán đã đóng.',
  SHIFT_ALREADY_OPEN: 'Bạn đang có một ca mở.',
};
export function FinanceError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.detail && REASON_TEXT[error.detail]) return <Notice kind="warn">{REASON_TEXT[error.detail]}</Notice>;
  return <ErrorBox error={error} />;
}

// ---------------------------------------------------------------------------
// Ô nhập tiền
// ---------------------------------------------------------------------------
export function MoneyInput({ value, onChange, label, hint }: { value: number | null; onChange: (v: number | null) => void; label: string; hint?: string }) {
  const [text, setText] = useState(value === null ? '' : new Intl.NumberFormat('vi-VN').format(value));
  useEffect(() => {
    if (parseVnd(text) !== value) setText(value === null ? '' : new Intl.NumberFormat('vi-VN').format(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label={label} hint={hint}>
      <input
        inputMode="numeric" className="money" value={text} aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseVnd(e.target.value));
        }}
        onBlur={() => value !== null && setText(new Intl.NumberFormat('vi-VN').format(value))}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Lập phiếu (dùng ở hồ sơ thanh toán và ở bước check-in lịch hẹn)
// ---------------------------------------------------------------------------
export interface ReceiptDraft { kind: Kind; method: Method; amount: number | null; reference: string; payerName: string }
/** Nội dung chuyển khoản gợi ý = mã đối soát lưu vào phiếu. */
export const suggestedNote = (mrn: string, kind: Kind) => transferNote(`HCOS ${mrn} ${KIND_LABEL[kind]}`);

export function ReceiptFields({ draft, set, settings, mrn, fixedKind, max }: {
  draft: ReceiptDraft; set: (d: ReceiptDraft) => void; settings: Settings | undefined; mrn: string; fixedKind?: boolean; max?: number;
}) {
  const note = suggestedNote(mrn, draft.kind);
  const qr = useMemo(() => {
    if (draft.method !== 'bank_transfer' || !settings?.bank || !draft.amount || draft.kind === 'refund') return null;
    try {
      return vietQrPayload({ bin: settings.bank.bin, account: settings.bank.account, amount: draft.amount, note });
    } catch {
      return null;
    }
  }, [draft.method, draft.amount, draft.kind, settings, note]);
  return (
    <div className="stack">
      <div className="row wrap">
        {!fixedKind && (
          <Field label="Loại phiếu">
            <select value={draft.kind} onChange={(e) => set({ ...draft, kind: e.target.value as Kind })}>
              {(['deposit', 'payment', 'refund'] as Kind[]).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </Field>
        )}
        <MoneyInput label="Số tiền (đ)" value={draft.amount} onChange={(amount) => set({ ...draft, amount })} hint={max !== undefined ? `tối đa ${fmtVnd(max)}` : undefined} />
        <fieldset className="methods">
          <legend>Hình thức</legend>
          {(['cash', 'bank_transfer', 'card'] as Method[]).map((m) => (
            <label key={m} className="radio">
              <input
                type="radio" name={`method-${fixedKind ? 'ci' : 'case'}`} checked={draft.method === m}
                onChange={() => set({ ...draft, method: m, reference: m === 'bank_transfer' ? note : m === 'card' ? '' : draft.reference })}
              />
              <span>{METHOD_LABEL[m]}</span>
            </label>
          ))}
        </fieldset>
      </div>
      {draft.method !== 'cash' && (
        <Field label={draft.method === 'card' ? 'Mã chuẩn chi POS *' : 'Nội dung / mã giao dịch chuyển khoản *'} hint="Dùng để đối soát sau này">
          <input required minLength={4} maxLength={100} value={draft.reference} onChange={(e) => set({ ...draft, reference: e.target.value })} />
        </Field>
      )}
      {draft.method === 'bank_transfer' && draft.kind !== 'refund' && (
        qr && settings?.bank ? (
          <div className="vietqr">
            <QrCode text={qr} ecl="M" size={180} label={`Mã VietQR chuyển ${fmtVnd(draft.amount ?? 0)}`} />
            <div>
              <strong>{settings.bank.accountName}</strong>
              <br />
              STK {settings.bank.account} · BIN {settings.bank.bin}
              <br />
              Số tiền <strong>{fmtVnd(draft.amount ?? 0)}</strong> · Nội dung <code>{note}</code>
              <p className="muted small">Người bệnh quét bằng app ngân hàng. Chỉ bấm xác nhận sau khi thấy tiền đã về trong tài khoản.</p>
            </div>
          </div>
        ) : (
          <Notice kind="warn">{settings?.bank ? 'Nhập số tiền để hiện mã VietQR.' : 'Chưa cấu hình tài khoản nhận chuyển khoản (quản lý cài ở Thu ngân → Cài đặt).'}</Notice>
        )
      )}
      <Field label="Người nộp / nhận tiền" hint="Để trống nếu là chính người bệnh">
        <input maxLength={200} value={draft.payerName} onChange={(e) => set({ ...draft, payerName: e.target.value })} />
      </Field>
    </div>
  );
}

/** Body gửi API từ bản nháp (null nếu chưa hợp lệ). */
export const receiptBody = (d: ReceiptDraft) =>
  d.amount && d.amount > 0
    ? { kind: d.kind, method: d.method, amount: d.amount, reference: d.method === 'cash' ? null : d.reference.trim() || null, payerName: d.payerName.trim() || null }
    : null;

// ---------------------------------------------------------------------------
// Phiếu in
// ---------------------------------------------------------------------------
export function PrintReceipt({ r, patient, orgName }: { r: Receipt; patient: { mrn: string; name: string }; orgName: string }) {
  const refund = r.kind === 'refund';
  return (
    <div className="print-receipt">
      <div className="pr-org">{orgName}</div>
      <h3>{refund ? 'PHIẾU CHI' : 'PHIẾU THU'}</h3>
      <div className="pr-no">Số: {r.receiptNo} · {fmtDateTime(r.createdAt)}</div>
      <dl>
        <dt>{refund ? 'Người nhận' : 'Người nộp'}</dt>
        <dd>{r.payerName ?? patient.name}</dd>
        <dt>Bệnh nhân</dt>
        <dd>{patient.name} ({patient.mrn})</dd>
        <dt>Lý do</dt>
        <dd>{refund ? 'Hoàn tiền tạm ứng' : KIND_LABEL[r.kind]} khám chữa bệnh</dd>
        <dt>Hình thức</dt>
        <dd>{METHOD_LABEL[r.method]}{r.reference ? ` · ${r.reference}` : ''}</dd>
        <dt>Số tiền</dt>
        <dd><strong>{fmtVnd(r.amount)}</strong></dd>
        <dt>Bằng chữ</dt>
        <dd><em>{vndInWords(r.amount)}</em></dd>
      </dl>
      {r.status === 'cancelled' && <div className="pr-cancelled">ĐÃ HUỶ — {r.cancelReason}</div>}
      <div className="pr-sign">
        <span>{refund ? 'Người nhận' : 'Người nộp'}</span>
        <span>Thu ngân<br /><small>{r.createdByName ?? ''}</small></span>
      </div>
      <div className="pr-note">Phiếu thu nội bộ, không thay thế hoá đơn.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab Thu ngân
// ---------------------------------------------------------------------------
export function FinanceScreen() {
  const { roles } = useSession();
  const canCollect = ['clinic_staff', 'cashier', 'clinic_admin'].some((r) => roles.has(r as never));
  const canManage = roles.has('clinic_admin') || roles.has('tenant_admin');
  const canReport = ['clinic_admin', 'executive', 'tenant_admin'].some((r) => roles.has(r as never));
  return (
    <div className="stack">
      {canCollect && <ShiftCard />}
      {canCollect && <CaseFinder />}
      {canReport && <ShiftReport />}
      {canManage && <FinanceSettings />}
    </div>
  );
}

function ShiftCard() {
  const { orgId } = useSession();
  const shift = useMyShift();
  const [float, setFloat] = useState<number | null>(0);
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [closed, setClosed] = useState<Shift | null>(null);
  const open = useAction(async () => {
    await api('POST', '/api/finance/shifts', { body: { organizationId: orgId, openingFloat: float ?? 0 } });
    setClosed(null);
    shift.reload();
  });
  const close = useAction(async (s: Shift) => {
    if (counted === null) throw new Error('Nhập số tiền mặt đếm được trong két.');
    if (!confirm(`Đóng ca với tiền mặt đếm được ${fmtVnd(counted)}? Sau khi đóng không lập / huỷ phiếu trong ca này được nữa.`)) return;
    const r = await api<Shift>('POST', `/api/finance/shifts/${s.shiftId}/close`, { headers: { 'if-match': `W/"${s.version}"` }, body: { countedCash: counted, note: note.trim() || null } });
    setClosed(r.data);
    setCounted(null);
    setNote('');
    shift.reload();
  });
  if (forbidden(shift.error)) return <Notice kind="warn">Bạn không có quyền thu ngân tại cơ sở này.</Notice>;
  const s = shift.data;
  return (
    <Card title="Ca thu ngân của tôi" actions={<button className="link" onClick={shift.reload}>Tải lại</button>}>
      <ErrorBox error={shift.error} />
      {closed && <ShiftResult s={closed} />}
      {shift.data === null && (
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void open.run(); }}>
          <MoneyInput label="Tiền đầu ca (tiền lẻ trong két)" value={float} onChange={setFloat} />
          <button type="submit" disabled={open.busy || float === null}>Mở ca</button>
        </form>
      )}
      {s && s.totals && (
        <>
          <p>
            Mở lúc {fmtDateTime(s.openedAt)} · tiền đầu ca {fmtVnd(s.openingFloat)} · <strong>tiền mặt phải có {fmtVnd(s.cashOnHand ?? 0)}</strong>
            {s.cancelledCount ? <span className="muted"> · {s.cancelledCount} phiếu huỷ</span> : null}
          </p>
          <table className="compact">
            <thead><tr><th>Hình thức</th><th>Thu</th><th>Chi</th><th>Số phiếu</th></tr></thead>
            <tbody>
              {(['cash', 'bank_transfer', 'card'] as Method[]).map((m) => (
                <tr key={m}><td>{METHOD_LABEL[m]}</td><td>{fmtVnd(s.totals![m].in)}</td><td>{fmtVnd(s.totals![m].out)}</td><td>{s.totals![m].count}</td></tr>
              ))}
            </tbody>
          </table>
          <p><a href={`#/finance/shifts/${s.shiftId}`}>Xem các phiếu trong ca</a></p>
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void close.run(s); }}>
            <MoneyInput label="Tiền mặt đếm được trong két" value={counted} onChange={setCounted} />
            <Field label="Ghi chú">
              <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <button type="submit" className="secondary" disabled={close.busy}>Đóng ca</button>
          </form>
        </>
      )}
      <FinanceError error={open.error ?? close.error} />
    </Card>
  );
}

function ShiftResult({ s }: { s: Shift }) {
  const diff = s.cashDifference ?? 0;
  return (
    <Notice kind={diff === 0 ? 'ok' : 'warn'}>
      Đã đóng ca lúc {fmtDateTime(s.closedAt ?? '')}. Phải có {fmtVnd(s.expectedCash ?? 0)}, đếm được {fmtVnd(s.countedCash ?? 0)} —{' '}
      <strong>{diff === 0 ? 'khớp' : diff > 0 ? `thừa ${fmtVnd(diff)}` : `thiếu ${fmtVnd(-diff)}`}</strong>.
    </Notice>
  );
}

function CaseFinder() {
  const { orgId } = useSession();
  const cases = useLoad(() => api<{ cases: CaseRow[] }>('GET', `/api/finance/cases?organization=${orgId}&status=open`).then((r) => r.data.cases), [orgId]);
  const [mrn, setMrn] = useState('');
  const [notFound, setNotFound] = useState(false);
  const find = useAction(async () => {
    setNotFound(false);
    const b = await api<Bundle<FhirPatient>>('GET', `/fhir/Patient?organization=${orgId}&mrn=${encodeURIComponent(mrn.trim())}&_count=1`);
    const p = entries(b.data)[0];
    if (!p?.id) return setNotFound(true);
    const c = await api<CaseDetail>('POST', '/api/finance/cases', { body: { organizationId: orgId, patientId: p.id } });
    navigate(`#/finance/cases/${c.data.caseId}`);
  });
  return (
    <Card title="Hồ sơ thanh toán" actions={<button className="link" onClick={cases.reload}>Tải lại</button>}>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void find.run(); }}>
        <Field label="Mã bệnh nhân (MRN)" hint="Mở hồ sơ đang mở của bệnh nhân, chưa có thì tạo mới">
          <input required value={mrn} onChange={(e) => setMrn(e.target.value)} />
        </Field>
        <button type="submit" disabled={find.busy}>Mở</button>
      </form>
      {notFound && <Notice kind="warn">Không tìm thấy bệnh nhân với MRN này.</Notice>}
      <FinanceError error={find.error ?? cases.error} />
      <h3>Đang mở ({cases.data?.length ?? 0})</h3>
      {cases.data && cases.data.length === 0 && <p className="muted">Không có hồ sơ nào đang mở.</p>}
      {cases.data && cases.data.length > 0 && (
        <table>
          <thead><tr><th>Bệnh nhân</th><th>MRN</th><th>Mở lúc</th><th>Chi phí</th><th>Đã thu</th><th>Số dư</th><th /></tr></thead>
          <tbody>
            {cases.data.map((c) => (
              <tr key={c.caseId}>
                <td>{c.patient.familyName} {c.patient.givenName}</td>
                <td>{c.patient.mrn}</td>
                <td>{fmtDateTime(c.openedAt)}</td>
                <td>{fmtVnd(c.totals.charges)}</td>
                <td>{fmtVnd(c.totals.received - c.totals.refunded)}</td>
                <td className={c.totals.balance < 0 ? 'neg' : c.totals.balance > 0 ? 'pos' : ''}>{balanceText(c.totals.balance)}</td>
                <td><a href={`#/finance/cases/${c.caseId}`}>Mở</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
const balanceText = (b: number) => (b === 0 ? 'Đủ' : b < 0 ? `Còn thu ${fmtVnd(-b)}` : `Dư ${fmtVnd(b)}`);

// ---------------------------------------------------------------------------
// Một hồ sơ thanh toán
// ---------------------------------------------------------------------------
/** embedded: nhúng trong màn khác (vd. Quầy trả) — ẩn link quay lại; onChange gọi sau mỗi lần dữ liệu hồ sơ đổi. */
export function CaseScreen({ id, embedded, onChange }: { id: string; embedded?: boolean; onChange?: () => void }) {
  const { orgId, me, roles } = useSession();
  const orgName = me.memberships.find((m) => m.organization.organizationId === orgId)?.organization.name ?? '';
  const c = useLoad(() => api<CaseDetail>('GET', `/api/finance/cases/${id}`).then((r) => r.data), [id]);
  const items = useLoad(() => api<{ items: PriceItem[] }>('GET', `/api/finance/price-items?organization=${orgId}`).then((r) => r.data.items.filter((i) => i.isActive)), [orgId]);
  const settings = useSettings();
  const shift = useMyShift();
  const [data, setData] = useState<CaseDetail | null>(null);
  useEffect(() => setData(c.data ?? null), [c.data]);
  const d = data;
  const changed = useRef(onChange);
  changed.current = onChange;
  const firstData = useRef(true);
  useEffect(() => {
    if (!data) return;
    if (firstData.current) {
      firstData.current = false;
      return;
    }
    changed.current?.();
  }, [data]);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(1);
  const [draft, setDraft] = useState<ReceiptDraft>({ kind: 'payment', method: 'cash', amount: null, reference: '', payerName: '' });
  const [key, resetKey] = useIntentKey([draft.kind, draft.method, draft.amount, draft.reference, draft.payerName]);
  const [printed, setPrinted] = useState<Receipt | null>(null);

  // Gợi ý loại phiếu + số tiền theo số dư.
  useEffect(() => {
    if (!d) return;
    const b = d.totals.balance;
    setDraft((x) => ({ ...x, kind: b > 0 ? 'refund' : d.totals.charges === 0 ? 'deposit' : 'payment', amount: b > 0 ? b : b < 0 ? -b : d.totals.charges === 0 ? settings.data?.depositDefault ?? null : null }));
  }, [d?.totals.balance, d?.totals.charges, settings.data?.depositDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = useAction(async () => {
    const r = await api<CaseDetail>('POST', `/api/finance/cases/${id}/charges`, { body: { itemId, quantity: qty } });
    setData(r.data);
    setQty(1);
  });
  const voidCharge = useAction(async (ch: Charge) => {
    const reason = prompt(`Lý do gỡ "${ch.description}"?`);
    if (!reason) return;
    setData((await api<CaseDetail>('POST', `/api/finance/charges/${ch.chargeId}/void`, { body: { reason } })).data);
  });
  const pay = useAction(async () => {
    const body = receiptBody(draft);
    if (!body) throw new Error('Nhập số tiền.');
    if (body.method === 'bank_transfer' && !confirm(`Đã kiểm tra tiền ${fmtVnd(body.amount)} về tài khoản?`)) return;
    const r = await api<{ receipt: Receipt; case: CaseDetail }>('POST', '/api/finance/receipts', {
      headers: { 'idempotency-key': key }, body: { organizationId: orgId, caseId: id, ...body },
    });
    setData(r.data.case);
    setPrinted(r.data.receipt);
    resetKey();
    shift.reload();
  });
  const cancel = useAction(async (r: Receipt) => {
    const reason = prompt(`Lý do huỷ phiếu ${r.receiptNo}? (tối thiểu 5 ký tự)`);
    if (!reason) return;
    setData((await api<CaseDetail>('POST', `/api/finance/receipts/${r.receiptId}/cancel`, { body: { reason } })).data);
    shift.reload();
  });
  const close = useAction(async () => {
    if (!d) return;
    setData((await api<CaseDetail>('POST', `/api/finance/cases/${id}/close`, { headers: { 'if-match': `W/"${d.version}"` } })).data);
  });

  if (c.error) return <FinanceError error={c.error} />;
  if (!d) return <p className="muted">Đang tải…</p>;
  const name = `${d.patient.familyName} ${d.patient.givenName}`;
  const open = d.status === 'open';
  const b = d.totals.balance;
  const chosen = items.data?.find((i) => i.itemId === itemId);

  return (
    <div className="stack">
      {!embedded && <p><a href="#/finance">← Thu ngân</a></p>}
      <Card title={`Thanh toán · ${name} (${d.patient.mrn})`} actions={<a href={`#/patients/${d.patient.patientId}`}>Hồ sơ bệnh nhân</a>}>
        <div className="totals">
          <div><span>Chi phí</span><strong>{fmtVnd(d.totals.charges)}</strong></div>
          <div><span>Đã thu</span><strong>{fmtVnd(d.totals.received)}</strong></div>
          <div><span>Đã hoàn</span><strong>{fmtVnd(d.totals.refunded)}</strong></div>
          <div className={b < 0 ? 'neg' : b > 0 ? 'pos' : 'zero'}><span>{b < 0 ? 'Còn phải thu' : b > 0 ? 'Còn dư (hoàn ứng)' : 'Số dư'}</span><strong>{fmtVnd(Math.abs(b))}</strong></div>
        </div>
        {!open && <Notice kind="ok">Hồ sơ đã đóng lúc {fmtDateTime(d.closedAt ?? '')}.</Notice>}

        <h3>Chi phí</h3>
        {d.charges.length === 0 && <p className="muted">Chưa có chi phí.</p>}
        {d.charges.length > 0 && (
          <table>
            <thead><tr><th>Mã</th><th>Dịch vụ</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th><th /></tr></thead>
            <tbody>
              {d.charges.map((ch) => (
                <tr key={ch.chargeId} className={ch.status === 'voided' ? 'muted-row strike' : ''}>
                  <td>{ch.itemCode}</td>
                  <td>{ch.description}{ch.voidReason && <div className="muted small">Đã gỡ: {ch.voidReason}</div>}</td>
                  <td>{ch.quantity}</td>
                  <td>{fmtVnd(ch.unitPrice)}</td>
                  <td>{fmtVnd(ch.amount)}</td>
                  <td className="actions">{open && ch.status === 'active' && <button className="link danger" onClick={() => void voidCharge.run(ch)}>Gỡ</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {open && (
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <Field label="Dịch vụ">
              <select required value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">— chọn từ bảng giá —</option>
                {items.data?.map((i) => (
                  <option key={i.itemId} value={i.itemId}>{i.code} · {i.name} · {fmtVnd(i.unitPrice)}</option>
                ))}
              </select>
            </Field>
            <Field label="Số lượng">
              <input type="number" className="short" min={1} max={1000} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            {chosen && <span className="muted">= {fmtVnd(chosen.unitPrice * qty)}</span>}
            <button type="submit" className="secondary" disabled={add.busy || !itemId}>Thêm chi phí</button>
          </form>
        )}
        <FinanceError error={add.error ?? voidCharge.error ?? items.error} />

        {open && (
          <>
            <h3>Lập phiếu</h3>
            {shift.data === null ? (
              <Notice kind="warn">Bạn chưa mở ca thu ngân. <a href="#/finance">Mở ca</a> rồi quay lại.</Notice>
            ) : (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void pay.run(); }}>
                <ReceiptFields draft={draft} set={setDraft} settings={settings.data} mrn={d.patient.mrn}
                  max={draft.kind === 'payment' ? Math.max(0, -b) : draft.kind === 'refund' ? Math.max(0, b) : undefined} />
                <div className="row wrap">
                  <button type="submit" disabled={pay.busy || !draft.amount}>
                    {draft.kind === 'refund' ? 'Lập phiếu chi' : 'Lập phiếu thu'} {draft.amount ? fmtVnd(draft.amount) : ''}
                  </button>
                  {b === 0 && (d.charges.length > 0 || d.receipts.length > 0) && (
                    <button type="button" className="secondary" disabled={close.busy} onClick={() => void close.run()}>Đóng hồ sơ thanh toán</button>
                  )}
                </div>
              </form>
            )}
            <FinanceError error={pay.error ?? close.error} />
          </>
        )}
        {printed && (
          <div className="row wrap top">
            <PrintReceipt r={printed} patient={{ mrn: d.patient.mrn, name }} orgName={orgName} />
            <div className="stack">
              <button onClick={() => window.print()}>In phiếu</button>
              <button className="link" onClick={() => setPrinted(null)}>Xong</button>
            </div>
          </div>
        )}

        <h3>Phiếu thu / chi</h3>
        {d.receipts.length === 0 && <p className="muted">Chưa có phiếu.</p>}
        {d.receipts.length > 0 && (
          <table>
            <thead><tr><th>Số phiếu</th><th>Loại</th><th>Hình thức</th><th>Số tiền</th><th>Lúc</th><th>Người lập</th><th /></tr></thead>
            <tbody>
              {d.receipts.map((r) => (
                <tr key={r.receiptId} className={r.status === 'cancelled' ? 'muted-row strike' : ''}>
                  <td>{r.receiptNo}</td>
                  <td>{KIND_LABEL[r.kind]}{r.cancelReason && <div className="muted small">Huỷ: {r.cancelReason}</div>}</td>
                  <td>{METHOD_LABEL[r.method]}{r.reference && <div className="muted small">{r.reference}</div>}</td>
                  <td>{r.kind === 'refund' ? '−' : ''}{fmtVnd(r.amount)}</td>
                  <td>{fmtDateTime(r.createdAt)}</td>
                  <td>{r.createdByName}</td>
                  <td className="actions">
                    <button className="link" onClick={() => setPrinted(r)}>In lại</button>
                    {open && r.status === 'valid' && <button className="link danger" onClick={() => void cancel.run(r)}>Huỷ</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <FinanceError error={cancel.error} />
      </Card>
      {!open && can.supplies(roles) && <CaseSuppliesCard caseId={d.caseId} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phiếu trong một ca + báo cáo ca (quản lý)
// ---------------------------------------------------------------------------
export function ShiftScreen({ id }: { id: string }) {
  const s = useLoad(() => api<Shift & { receipts: Array<Receipt & { patientName: string; mrn: string }> }>('GET', `/api/finance/shifts/${id}`).then((r) => r.data), [id]);
  if (s.error) return <FinanceError error={s.error} />;
  if (!s.data) return <p className="muted">Đang tải…</p>;
  const x = s.data;
  return (
    <div className="stack">
      <p><a href="#/finance">← Thu ngân</a></p>
      <Card title={`Ca của ${x.userName ?? ''} · ${fmtDateTime(x.openedAt)}`}>
        {x.status === 'closed' ? <ShiftResult s={x} /> : <p>Đang mở · tiền mặt phải có {fmtVnd(x.cashOnHand ?? 0)}</p>}
        <table>
          <thead><tr><th>Số phiếu</th><th>Bệnh nhân</th><th>Loại</th><th>Hình thức</th><th>Số tiền</th><th>Lúc</th><th>Trạng thái</th></tr></thead>
          <tbody>
            {x.receipts.map((r) => (
              <tr key={r.receiptId} className={r.status === 'cancelled' ? 'muted-row strike' : ''}>
                <td>{r.receiptNo}</td>
                <td>{r.patientName} ({r.mrn})</td>
                <td>{KIND_LABEL[r.kind]}</td>
                <td>{METHOD_LABEL[r.method]}{r.reference && <div className="muted small">{r.reference}</div>}</td>
                <td>{r.kind === 'refund' ? '−' : ''}{fmtVnd(r.amount)}</td>
                <td>{fmtDateTime(r.createdAt)}</td>
                <td>{r.status === 'cancelled' ? `Huỷ: ${r.cancelReason}` : 'Hợp lệ'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ShiftReport() {
  const { orgId } = useSession();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const [date, setDate] = useState(today);
  const list = useLoad(() => api<{ shifts: Shift[] }>('GET', `/api/finance/shifts?organization=${orgId}&from=${date}&to=${date}`).then((r) => r.data.shifts), [orgId, date]);
  if (forbidden(list.error)) return null;
  return (
    <Card title="Báo cáo ca thu ngân" actions={<button className="link" onClick={list.reload}>Tải lại</button>}>
      <Field label="Ngày"><input type="date" value={date} onChange={(e) => setDate(e.target.value || today)} /></Field>
      <ErrorBox error={list.error} />
      {list.data && list.data.length === 0 && <p className="muted">Không có ca nào.</p>}
      {list.data && list.data.length > 0 && (
        <table>
          <thead><tr><th>Thu ngân</th><th>Mở</th><th>Đóng</th><th>Phải có</th><th>Đếm được</th><th>Chênh lệch</th><th /></tr></thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.shiftId}>
                <td>{s.userName}</td>
                <td>{fmtDateTime(s.openedAt)}</td>
                <td>{s.closedAt ? fmtDateTime(s.closedAt) : <em>đang mở</em>}</td>
                <td>{s.expectedCash === null ? '—' : fmtVnd(s.expectedCash)}</td>
                <td>{s.countedCash === null ? '—' : fmtVnd(s.countedCash)}</td>
                <td className={s.cashDifference ? 'neg' : ''}>{s.cashDifference === null ? '—' : fmtVnd(s.cashDifference)}</td>
                <td><a href={`#/finance/shifts/${s.shiftId}`}>Phiếu</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cài đặt (quản lý): tạm ứng mặc định, tài khoản VietQR, bảng giá
// ---------------------------------------------------------------------------
function FinanceSettings() {
  const { orgId } = useSession();
  const settings = useSettings();
  const items = useLoad(() => api<{ items: PriceItem[] }>('GET', `/api/finance/price-items?organization=${orgId}`).then((r) => r.data.items), [orgId]);
  const [dep, setDepRaw] = useState<number | null>(null);
  const [bank, setBankRaw] = useState({ bin: '', account: '', accountName: '' });
  // Chỉ nạp từ server khi người dùng chưa sửa form (tải chậm không ghi đè chữ đang gõ).
  const [dirty, setDirty] = useState(false);
  const setDep = (v: number | null) => { setDirty(true); setDepRaw(v); };
  const setBank = (v: typeof bank) => { setDirty(true); setBankRaw(v); };
  useEffect(() => {
    if (!settings.data || dirty) return;
    setDepRaw(settings.data.depositDefault);
    setBankRaw(settings.data.bank ?? { bin: '', account: '', accountName: '' });
  }, [settings.data, dirty]);
  const save = useAction(async () => {
    const s = settings.data!;
    const hasBank = bank.bin.trim() || bank.account.trim() || bank.accountName.trim();
    await api('POST', '/api/finance/settings', {
      headers: { 'if-match': `W/"${s.version}"` },
      body: { organizationId: orgId, depositDefault: dep ?? 0, bank: hasBank ? { bin: bank.bin.trim(), account: bank.account.trim(), accountName: bank.accountName.trim() } : null },
    });
    setDirty(false);
    settings.reload();
  });
  const [f, setF] = useState({ code: '', name: '', category: 'exam', unitPrice: null as number | null });
  const create = useAction(async () => {
    await api('POST', '/api/finance/price-items', { body: { organizationId: orgId, code: f.code.trim().toUpperCase(), name: f.name.trim(), category: f.category, unitPrice: f.unitPrice ?? 0 } });
    setF({ code: '', name: '', category: f.category, unitPrice: null });
    items.reload();
  });
  const [edit, setEdit] = useState<Record<string, number | null>>({});
  const update = useAction(async (i: PriceItem, patch: Partial<Pick<PriceItem, 'unitPrice' | 'isActive'>>) => {
    await api('POST', `/api/finance/price-items/${i.itemId}`, {
      headers: { 'if-match': `W/"${i.version}"` },
      body: { name: i.name, category: i.category, unitPrice: patch.unitPrice ?? i.unitPrice, isActive: patch.isActive ?? i.isActive },
    });
    setEdit((e) => { const n = { ...e }; delete n[i.itemId]; return n; });
    items.reload();
  });
  return (
    <Card title="Cài đặt thu ngân">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        {/* Khoá form tới khi tải xong cài đặt hiện tại, để không lưu đè bằng giá trị rỗng. */}
        <fieldset className="plain" disabled={!settings.data}>
        <div className="row wrap">
          <MoneyInput label="Tạm ứng mặc định khi check-in" value={dep} onChange={setDep} />
        </div>
        <h3>Tài khoản nhận chuyển khoản (VietQR)</h3>
        <p className="muted small">Mã BIN 6 số của ngân hàng (vd. Vietcombank 970436, VietinBank 970415, BIDV 970418) — kiểm tra lại với ngân hàng. Để trống cả ba nếu chưa dùng.</p>
        <div className="row wrap">
          <Field label="BIN ngân hàng"><input className="short" inputMode="numeric" maxLength={6} value={bank.bin} onChange={(e) => setBank({ ...bank, bin: e.target.value })} /></Field>
          <Field label="Số tài khoản"><input maxLength={19} value={bank.account} onChange={(e) => setBank({ ...bank, account: e.target.value })} /></Field>
          <Field label="Tên chủ tài khoản" hint="Không dấu, in hoa"><input maxLength={50} value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} /></Field>
        </div>
        <div><button type="submit" disabled={save.busy || !settings.data || dep === null}>Lưu cài đặt</button></div>
        </fieldset>
      </form>
      <FinanceError error={save.error ?? settings.error} />

      <h3>Bảng giá dịch vụ</h3>
      {items.data && items.data.length > 0 && (
        <table>
          <thead><tr><th>Mã</th><th>Tên</th><th>Nhóm</th><th>Đơn giá</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {items.data.map((i) => (
              <tr key={i.itemId} className={i.isActive ? '' : 'muted-row'}>
                <td>{i.code}</td>
                <td>{i.name}</td>
                <td>{CATEGORY_LABEL[i.category] ?? i.category}</td>
                <td>
                  {i.itemId in edit ? (
                    <span className="row">
                      <input className="money short" aria-label={`Giá mới ${i.code}`} inputMode="numeric" defaultValue={i.unitPrice}
                        onChange={(e) => setEdit({ ...edit, [i.itemId]: parseVnd(e.target.value) })} />
                      <button className="link" disabled={update.busy || edit[i.itemId] === null} onClick={() => void update.run(i, { unitPrice: edit[i.itemId]! })}>Lưu</button>
                    </span>
                  ) : (
                    <>{fmtVnd(i.unitPrice)} <button className="link" onClick={() => setEdit({ ...edit, [i.itemId]: i.unitPrice })}>Sửa</button></>
                  )}
                </td>
                <td>{i.isActive ? 'Đang dùng' : 'Ngừng'}</td>
                <td><button className="link" onClick={() => void update.run(i, { isActive: !i.isActive })} disabled={update.busy}>{i.isActive ? 'Ngừng' : 'Dùng lại'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
        <Field label="Mã *" hint="vd. KB-NOI"><input required className="short" maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{1,19}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Tên dịch vụ *"><input required minLength={2} maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Nhóm">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <MoneyInput label="Đơn giá (đ) *" value={f.unitPrice} onChange={(unitPrice) => setF({ ...f, unitPrice })} />
        <button type="submit" disabled={create.busy || f.unitPrice === null}>Thêm dịch vụ</button>
      </form>
      <FinanceError error={create.error ?? update.error ?? items.error} />
      <p className="muted small">Đổi giá không ảnh hưởng chi phí đã ghi (chi phí lưu đơn giá tại thời điểm ghi).</p>
    </Card>
  );
}

export const patientLabel = (p: FhirPatient) => `${patientName(p)} (${mrnOf(p)})`;
