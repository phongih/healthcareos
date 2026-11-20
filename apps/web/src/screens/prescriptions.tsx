/**
 * Đơn thuốc (HCOS-F5).
 *  - Bác sĩ phụ trách: kê đơn trong đợt khám đang mở (liều mỗi lần, số lần/ngày, số ngày, số lượng, cách dùng); huỷ đơn chưa cấp.
 *  - Dược sĩ: hàng đợi đơn chờ cấp của cơ sở; cấp từng dòng tại vị trí kho đang chọn (FEFO, có Idempotency-Key).
 * Server là nơi quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useState, type ReactNode } from 'react';

import { api } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useIntentKey, useLoad } from '../lib/ui';

interface RxMedication { medicationId: string; brandName: string; genericName: string | null; strength: string; form: string; unitOfMeasure: string }
interface RxItem {
  itemId: string; lineNo: number; medicationId: string; doseQuantity: number; doseUnit: string; frequencyPerDay: number; durationDays: number;
  instructions: string | null; quantityPrescribed: number; quantityDispensed: number; medication: RxMedication;
}
export interface RxView {
  prescription: { prescriptionId: string; encounterId: string; patientId: string; status: string; note: string | null; prescribedAt: string; version: number };
  items: RxItem[];
  prescriber: { userId: string; displayName: string | null };
  patient?: { patientId: string; mrn: string; familyName: string; givenName: string };
}
interface Medication { medicationId: string; brandName: string; strength: string; form: string; unitOfMeasure: string; isActive: boolean }

export const RX_STATUS: Record<string, string> = {
  active: 'Chờ cấp',
  completed: 'Đã cấp đủ',
  cancelled: 'Đã huỷ',
  entered_in_error: 'Nhập nhầm',
};

const fmtNum = (n: number): string => n.toLocaleString('vi-VN', { maximumFractionDigits: 3 });
export const usage = (i: RxItem): string =>
  `${fmtNum(i.doseQuantity)} ${i.doseUnit} × ${i.frequencyPerDay} lần/ngày × ${i.durationDays} ngày${i.instructions ? ` — ${i.instructions}` : ''}`;
const medLabel = (m: RxMedication | Medication): string => `${m.brandName} (${m.strength}, ${m.form})`;

function ItemsTable({ items, extra }: { items: RxItem[]; extra?: (i: RxItem) => ReactNode }) {
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Thuốc</th>
          <th>Cách dùng</th>
          <th className="right">Kê</th>
          <th className="right">Đã cấp</th>
          {extra && <th />}
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.itemId}>
            <td>{i.lineNo}</td>
            <td>{medLabel(i.medication)}</td>
            <td>{usage(i)}</td>
            <td className="right">
              {i.quantityPrescribed} {i.medication.unitOfMeasure}
            </td>
            <td className="right">{i.quantityDispensed}</td>
            {extra && <td>{extra(i)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Trong màn đợt khám
// ---------------------------------------------------------------------------
export function EncounterPrescriptions({ encounterId, open, isPractitioner }: { encounterId: string; open: boolean; isPractitioner: boolean }) {
  const { me, roles } = useSession();
  // Bác sĩ nhưng không kê được: nói rõ lý do thay vì chỉ ẩn nút.
  const why = !roles.has('doctor')
    ? null
    : !open
      ? 'Đợt khám đã kết thúc nên không kê đơn mới được. Để kê đơn, hãy mở một đợt khám mới từ hồ sơ bệnh nhân.'
      : !isPractitioner
        ? 'Chỉ bác sĩ phụ trách đợt khám này mới kê đơn được.'
        : null;
  const list = useLoad(
    () => api<{ prescriptions: RxView[] }>('GET', `/api/prescriptions?encounter=${encounterId}`).then((r) => r.data.prescriptions),
    [encounterId],
  );
  const [composing, setComposing] = useState(false);
  const cancel = useAction(async (p: RxView) => {
    if (!confirm('Huỷ đơn thuốc này?')) return;
    await api('POST', `/api/prescriptions/${p.prescription.prescriptionId}/cancel`, { headers: { 'if-match': `W/"${p.prescription.version}"` } });
    list.reload();
  });

  return (
    <Card
      title="Đơn thuốc"
      actions={
        open && isPractitioner && !composing ? (
          <button onClick={() => setComposing(true)}>+ Kê đơn</button>
        ) : null
      }
    >
      <ErrorBox error={list.error} />
      {why && <Notice>{why}</Notice>}
      {list.data && list.data.length === 0 && !composing && <p className="muted">Chưa có đơn thuốc.</p>}
      {list.data?.map((p) => (
        <div key={p.prescription.prescriptionId} className="rx">
          <p>
            <strong>{RX_STATUS[p.prescription.status] ?? p.prescription.status}</strong>
            <span className="muted">
              {' '}
              · {fmtDateTime(p.prescription.prescribedAt)} · {p.prescriber.displayName ?? 'bác sĩ'}
            </span>
            {p.prescription.status === 'active' &&
              p.prescriber.userId === me.user.userId &&
              p.items.every((i) => i.quantityDispensed === 0) && (
                <button className="link danger spaced" onClick={() => void cancel.run(p)} disabled={cancel.busy}>
                  Huỷ đơn
                </button>
              )}
          </p>
          {p.prescription.note && <p className="muted">Lời dặn: {p.prescription.note}</p>}
          <ItemsTable items={p.items} />
        </div>
      ))}
      <ErrorBox error={cancel.error} />
      {composing && (
        <NewPrescription
          encounterId={encounterId}
          onDone={() => {
            setComposing(false);
            list.reload();
          }}
          onCancel={() => setComposing(false)}
        />
      )}
    </Card>
  );
}

interface Line { medicationId: string; dose: string; unit: string; perDay: string; days: string; quantity: string; quantityTouched: boolean; instructions: string }
const blank = (): Line => ({ medicationId: '', dose: '1', unit: '', perDay: '2', days: '5', quantity: '', quantityTouched: false, instructions: 'uống sau ăn' });
const parseNum = (s: string): number => Number(s.replace(',', '.'));

/** Số lượng gợi ý = liều × lần/ngày × ngày (khi đơn vị liều trùng đơn vị kho). */
function suggested(l: Line, med: Medication | undefined): string {
  if (!med || l.unit.trim() !== med.unitOfMeasure) return '';
  const q = Math.ceil(parseNum(l.dose) * parseNum(l.perDay) * parseNum(l.days) - 1e-9);
  return Number.isFinite(q) && q > 0 ? String(q) : '';
}

function NewPrescription({ encounterId, onDone, onCancel }: { encounterId: string; onDone: () => void; onCancel: () => void }) {
  const meds = useLoad(
    () => api<{ medications: Medication[] }>('GET', '/api/pharmacy/medications?active=true&_count=200').then((r) => r.data.medications),
    [],
  );
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [note, setNote] = useState('');
  const medOf = (id: string) => meds.data?.find((m) => m.medicationId === id);

  const update = (idx: number, patch: Partial<Line>) =>
    setLines((ls) =>
      ls.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...patch };
        if (patch.medicationId !== undefined) next.unit = medOf(patch.medicationId)?.unitOfMeasure ?? '';
        if (!next.quantityTouched) next.quantity = suggested(next, medOf(next.medicationId));
        return next;
      }),
    );

  const save = useAction(async () => {
    const items = lines.map((l, i) => {
      const n = (s: string, what: string) => {
        const v = parseNum(s);
        if (!Number.isFinite(v) || v <= 0) throw new Error(`Dòng ${i + 1}: ${what} không hợp lệ`);
        return v;
      };
      if (!l.medicationId) throw new Error(`Dòng ${i + 1}: chưa chọn thuốc`);
      return {
        medicationId: l.medicationId,
        doseQuantity: n(l.dose, 'liều mỗi lần'),
        doseUnit: l.unit.trim(),
        frequencyPerDay: n(l.perDay, 'số lần/ngày'),
        durationDays: n(l.days, 'số ngày'),
        quantity: n(l.quantity, 'số lượng'),
        instructions: l.instructions.trim() || null,
      };
    });
    await api('POST', '/api/prescriptions', { body: { encounterId, note: note.trim() || null, items } });
    onDone();
  });

  return (
    <form
      className="sub stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
    >
      <ErrorBox error={meds.error} />
      {meds.data && meds.data.length === 0 && <Notice kind="warn">Danh mục thuốc trống.</Notice>}
      {lines.map((l, idx) => (
        <fieldset key={idx} className="rx-line row wrap">
          <legend>Thuốc {idx + 1}</legend>
          <Field label="Thuốc *">
            <select required value={l.medicationId} onChange={(e) => update(idx, { medicationId: e.target.value })}>
              <option value="">— chọn —</option>
              {meds.data?.map((m) => (
                <option key={m.medicationId} value={m.medicationId} disabled={lines.some((x, j) => j !== idx && x.medicationId === m.medicationId)}>
                  {medLabel(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Liều mỗi lần *">
            <input required inputMode="decimal" className="short" value={l.dose} onChange={(e) => update(idx, { dose: e.target.value })} />
          </Field>
          <Field label="Đơn vị *">
            <input required className="short" maxLength={32} value={l.unit} onChange={(e) => update(idx, { unit: e.target.value })} />
          </Field>
          <Field label="Lần/ngày *">
            <input required type="number" min={1} max={24} className="short" value={l.perDay} onChange={(e) => update(idx, { perDay: e.target.value })} />
          </Field>
          <Field label="Số ngày *">
            <input required type="number" min={1} max={180} className="short" value={l.days} onChange={(e) => update(idx, { days: e.target.value })} />
          </Field>
          <Field label={`Số lượng${medOf(l.medicationId) ? ` (${medOf(l.medicationId)!.unitOfMeasure})` : ''} *`} hint={l.quantityTouched ? undefined : 'tự tính'}>
            <input
              required
              type="number"
              min={1}
              className="short"
              value={l.quantity}
              onChange={(e) => update(idx, { quantity: e.target.value, quantityTouched: true })}
            />
          </Field>
          <Field label="Cách dùng">
            <input maxLength={500} value={l.instructions} onChange={(e) => update(idx, { instructions: e.target.value })} />
          </Field>
          {lines.length > 1 && (
            <button type="button" className="link danger" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
              Bỏ dòng
            </button>
          )}
        </fieldset>
      ))}
      <div className="row wrap">
        <button type="button" className="link" onClick={() => setLines((ls) => [...ls, blank()])} disabled={lines.length >= 20}>
          + Thêm thuốc
        </button>
      </div>
      <Field label="Lời dặn">
        <input maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="vd. Tái khám sau 5 ngày" />
      </Field>
      <div className="row">
        <button type="submit" disabled={save.busy || !meds.data}>
          Lưu đơn thuốc
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Huỷ
        </button>
      </div>
      <ErrorBox error={save.error} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Hàng đợi của dược sĩ
// ---------------------------------------------------------------------------
export function PrescriptionQueue({ locationId, locationName, onDispensed }: { locationId: string; locationName: string; onDispensed: () => void }) {
  const { orgId } = useSession();
  const queue = useLoad(
    () => api<{ prescriptions: RxView[] }>('GET', `/api/prescriptions?organization=${orgId}`).then((r) => r.data.prescriptions),
    [orgId],
  );
  const done = () => {
    queue.reload();
    onDispensed();
  };
  return (
    <Card title={`Đơn chờ cấp${queue.data ? ` (${queue.data.length})` : ''}`} actions={<button className="link" onClick={queue.reload}>Tải lại</button>}>
      <ErrorBox error={queue.error} />
      {queue.data && queue.data.length === 0 && <p className="muted">Không có đơn nào đang chờ.</p>}
      {queue.data?.map((p) => (
        <div key={p.prescription.prescriptionId} className="rx">
          <p>
            <strong>{p.patient ? `${p.patient.familyName} ${p.patient.givenName}` : 'Bệnh nhân'}</strong>
            <span className="muted">
              {' '}
              · MRN {p.patient?.mrn ?? '—'} · {p.prescriber.displayName ?? 'bác sĩ'} · {fmtDateTime(p.prescription.prescribedAt)}
            </span>{' '}
            <a href={`#/encounters/${p.prescription.encounterId}`}>Xem đợt khám</a>
          </p>
          {p.prescription.note && <p className="muted">Lời dặn: {p.prescription.note}</p>}
          <ItemsTable
            items={p.items}
            extra={(i) =>
              i.quantityDispensed < i.quantityPrescribed ? (
                <DispenseItem rx={p} item={i} locationId={locationId} locationName={locationName} onDone={done} />
              ) : (
                <span className="muted">đủ</span>
              )
            }
          />
        </div>
      ))}
    </Card>
  );
}

function DispenseItem({ rx, item, locationId, locationName, onDone }: { rx: RxView; item: RxItem; locationId: string; locationName: string; onDone: () => void }) {
  const remaining = item.quantityPrescribed - item.quantityDispensed;
  const [qty, setQty] = useState(String(remaining));
  const [key, resetKey] = useIntentKey([locationId, item.itemId, qty]);
  const run = useAction(async () => {
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > remaining) throw new Error(`Số lượng phải từ 1 đến ${remaining}`);
    await api('POST', '/api/pharmacy/dispenses', {
      headers: { 'idempotency-key': key },
      body: { medicationId: item.medicationId, locationId, encounterId: rx.prescription.encounterId, quantity, prescriptionItemId: item.itemId },
    });
    resetKey();
    onDone();
  });
  return (
    <form
      className="row inline"
      onSubmit={(e) => {
        e.preventDefault();
        void run.run();
      }}
    >
      <input type="number" min={1} max={remaining} className="short" aria-label={`Số lượng cấp ${item.medication.brandName}`} value={qty} onChange={(e) => setQty(e.target.value)} />
      <button type="submit" disabled={run.busy} title={`Cấp từ ${locationName}`}>
        Cấp
      </button>
      <ErrorBox error={run.error} />
    </form>
  );
}
