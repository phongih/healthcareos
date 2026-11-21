/**
 * Dược: danh mục thuốc, vị trí kho, tồn kho theo lô, nhập kho, cấp phát FEFO cho đợt khám.
 *
 * Chống gửi trùng: mỗi lần nhập / cấp phát dùng một Idempotency-Key. Khoá GIỮ NGUYÊN khi bấm lại sau lỗi mạng
 * (server trả lại kết quả cũ, không trừ kho lần hai) và ĐỔI khi người dùng sửa nội dung (ý định mới).
 */
import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import { CCCD_SYSTEM, entries, fmtDate, fmtDateTime, mrnOf, patientName, STATUS_LABEL, type Bundle, type FhirEncounter, type FhirPatient } from '../lib/fhir';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, RedactedBadge, useAction, useIntentKey, useLoad } from '../lib/ui';
import { PrepareCard } from './handover';
import { PrescriptionQueue } from './prescriptions';

interface Medication { medicationId: string; brandName: string; genericName?: string; strength: string; form: string; unitOfMeasure: string; isActive: boolean }
interface Location { locationId: string; name: string; type: string; isActive: boolean }
interface StockLine { batchId: string; batchNumber: string; expiryDate: string; medicationId: string; brandName: string; quantityOnHand: number; quantityReserved: number; unitCost: number | null }
interface Plan { requestedQuantity: number; allocatedTotal: number; isFullyAllocated: boolean; items: Array<{ batchNumber: string; expiryDate: string; allocatedQuantity: number }> }
interface Movement { movementId: string; quantity: number; batchId: string; occurredAt: string; reason?: string }

const LOCATION_TYPES: Record<string, string> = {
  main_warehouse: 'Kho chính',
  dispensary_counter: 'Quầy cấp phát',
  ward_cabinet: 'Tủ trực khoa',
  quarantine: 'Khu cách ly',
};

export function PharmacyScreen() {
  const { orgId, roles } = useSession();
  const meds = useLoad(() => api<{ medications: Medication[] }>('GET', '/api/pharmacy/medications?_count=200').then((r) => r.data.medications), []);
  const locs = useLoad(() => api<{ locations: Location[] }>('GET', `/api/pharmacy/locations?organization=${orgId}`).then((r) => r.data.locations), [orgId]);
  const [locId, setLocId] = useState('');
  useEffect(() => {
    if (locs.data && !locs.data.some((l) => l.locationId === locId)) setLocId(locs.data[0]?.locationId ?? '');
  }, [locs.data, locId]);
  const stock = useLoad(
    () => (locId ? api<{ lines: StockLine[]; redacted: string[] }>('GET', `/api/pharmacy/locations/${locId}/stock`).then((r) => r.data) : Promise.resolve(null)),
    [locId],
  );
  const loc = locs.data?.find((l) => l.locationId === locId);
  // Cấp thuốc xong => thẻ "Soạn thuốc cho quầy trả" tải lại số đã cấp.
  const [dispensedTick, setDispensedTick] = useState(0);

  return (
    <div className="stack">
      <Card title="Kho / quầy" actions={roles.has('pharmacy_admin') ? <CreateLocation onDone={locs.reload} /> : null}>
        <ErrorBox error={locs.error} />
        {locs.data && locs.data.length === 0 && <Notice>Cơ sở chưa có vị trí kho nào{roles.has('pharmacy_admin') ? ' — tạo mới ở trên.' : '.'}</Notice>}
        {locs.data && locs.data.length > 0 && (
          <Field label="Vị trí">
            <select value={locId} onChange={(e) => setLocId(e.target.value)}>
              {locs.data.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.name} ({LOCATION_TYPES[l.type] ?? l.type})
                </option>
              ))}
            </select>
          </Field>
        )}
      </Card>

      {loc && (
        <Card title={`Tồn kho — ${loc.name}`} actions={<RedactedBadge show={!!stock.data?.redacted.length} what="giá vốn" />}>
          <ErrorBox error={stock.error} />
          {stock.data && stock.data.lines.length === 0 && <p className="muted">Không còn hàng.</p>}
          {stock.data && stock.data.lines.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Thuốc</th>
                  <th>Lô</th>
                  <th>Hạn dùng</th>
                  <th className="right">Tồn</th>
                  <th className="right">Giá vốn</th>
                </tr>
              </thead>
              <tbody>
                {stock.data.lines.map((l) => (
                  <tr key={l.batchId} className={new Date(l.expiryDate) <= new Date() ? 'expired' : ''}>
                    <td>{l.brandName}</td>
                    <td>{l.batchNumber}</td>
                    <td>{fmtDate(l.expiryDate)}</td>
                    <td className="right">{l.quantityOnHand - l.quantityReserved}</td>
                    <td className="right">{l.unitCost === null ? '—' : l.unitCost.toLocaleString('vi-VN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {roles.has('pharmacist') && <PrepareCard refreshKey={dispensedTick} />}

      {loc && roles.has('pharmacist') && loc.type !== 'quarantine' && (
        <PrescriptionQueue
          locationId={loc.locationId}
          locationName={loc.name}
          onDispensed={() => {
            stock.reload();
            setDispensedTick((t) => t + 1);
          }}
        />
      )}

      {loc && meds.data && (
        <div className="grid2 top">
          <Receive locationId={loc.locationId} meds={meds.data} onDone={stock.reload} />
          {loc.type !== 'quarantine' && <Dispense locationId={loc.locationId} meds={meds.data} onDone={stock.reload} />}
        </div>
      )}

      <Card title="Danh mục thuốc">
        <ErrorBox error={meds.error} />
        {meds.data && (
          <table>
            <thead>
              <tr>
                <th>Biệt dược</th>
                <th>Hoạt chất</th>
                <th>Hàm lượng</th>
                <th>Dạng</th>
                <th>Đơn vị</th>
              </tr>
            </thead>
            <tbody>
              {meds.data.map((m) => (
                <tr key={m.medicationId}>
                  <td>{m.brandName}</td>
                  <td>{m.genericName ?? '—'}</td>
                  <td>{m.strength}</td>
                  <td>{m.form}</td>
                  <td>{m.unitOfMeasure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <AddMedication onDone={meds.reload} />
      </Card>
    </div>
  );
}

function CreateLocation({ onDone }: { onDone: () => void }) {
  const { orgId } = useSession();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', type: 'dispensary_counter' });
  const save = useAction(async () => {
    await api('POST', '/api/pharmacy/locations', { body: { organizationId: orgId, name: f.name.trim(), type: f.type } });
    setOpen(false);
    setF({ name: '', type: 'dispensary_counter' });
    onDone();
  });
  if (!open) return <button onClick={() => setOpen(true)}>+ Vị trí mới</button>;
  return (
    <form
      className="row wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
    >
      <input required placeholder="Tên vị trí" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
        {Object.entries(LOCATION_TYPES).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <button type="submit" disabled={save.busy}>
        Tạo
      </button>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Huỷ
      </button>
      <ErrorBox error={save.error} />
    </form>
  );
}

function AddMedication({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ brandName: '', genericName: '', strength: '', form: '', unitOfMeasure: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(async () => {
    await api('POST', '/api/pharmacy/medications', {
      body: { ...f, genericName: f.genericName.trim() || undefined },
    });
    setF({ brandName: '', genericName: '', strength: '', form: '', unitOfMeasure: '' });
    onDone();
  });
  return (
    <details className="sub">
      <summary>+ Thêm thuốc vào danh mục</summary>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <Field label="Biệt dược *">
          <input required value={f.brandName} onChange={set('brandName')} />
        </Field>
        <Field label="Hoạt chất">
          <input value={f.genericName} onChange={set('genericName')} />
        </Field>
        <Field label="Hàm lượng *">
          <input required placeholder="500mg" value={f.strength} onChange={set('strength')} />
        </Field>
        <Field label="Dạng *">
          <input required placeholder="viên nén" value={f.form} onChange={set('form')} />
        </Field>
        <Field label="Đơn vị *">
          <input required placeholder="viên" value={f.unitOfMeasure} onChange={set('unitOfMeasure')} />
        </Field>
        <button type="submit" disabled={save.busy}>
          Thêm
        </button>
      </form>
      <ErrorBox error={save.error} />
    </details>
  );
}

function Receive({ locationId, meds, onDone }: { locationId: string; meds: Medication[]; onDone: () => void }) {
  const [f, setF] = useState({ medicationId: meds[0]?.medicationId ?? '', batchNumber: '', expiryDate: '', unitCost: '', quantity: '' });
  // Danh mục có thể đổi sau khi form đã mở (vd. vừa thêm thuốc đầu tiên): luôn chọn một thuốc có thật.
  const medicationId = meds.some((m) => m.medicationId === f.medicationId) ? f.medicationId : (meds[0]?.medicationId ?? '');
  const [key, resetKey] = useIntentKey([locationId, medicationId, f.batchNumber, f.expiryDate, f.unitCost, f.quantity]);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(async () => {
    const r = await api('POST', '/api/pharmacy/receipts', {
      headers: { 'idempotency-key': key },
      body: {
        medicationId,
        locationId,
        batchNumber: f.batchNumber.trim(),
        expiryDate: f.expiryDate,
        unitCost: Number(f.unitCost),
        quantity: Number(f.quantity),
      },
    });
    setDone(`Đã nhập ${f.quantity} — lô ${f.batchNumber}${r.headers.get('idempotent-replayed') ? ' (yêu cầu gửi lại, không cộng kho lần hai)' : ''}.`);
    setF({ ...f, batchNumber: '', expiryDate: '', unitCost: '', quantity: '' });
    resetKey();
    onDone();
  });
  return (
    <Card title="Nhập kho">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          void save.run();
        }}
      >
        <Field label="Thuốc">
          <select value={medicationId} onChange={set('medicationId')}>
            {meds.map((m) => (
              <option key={m.medicationId} value={m.medicationId}>
                {m.brandName} {m.strength}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Số lô">
          <input required value={f.batchNumber} onChange={set('batchNumber')} />
        </Field>
        <Field label="Hạn dùng">
          <input required type="date" value={f.expiryDate} onChange={set('expiryDate')} />
        </Field>
        <Field label="Giá vốn / đơn vị">
          <input required inputMode="decimal" value={f.unitCost} onChange={set('unitCost')} />
        </Field>
        <Field label="Số lượng">
          <input required inputMode="numeric" pattern="[0-9]+" value={f.quantity} onChange={set('quantity')} />
        </Field>
        <button type="submit" disabled={save.busy || !medicationId}>
          {save.busy ? 'Đang nhập…' : 'Nhập kho'}
        </button>
      </form>
      <ErrorBox error={save.error} />
      {done && <Notice kind="ok">{done}</Notice>}
    </Card>
  );
}

function Dispense({ locationId, meds, onDone }: { locationId: string; meds: Medication[]; onDone: () => void }) {
  const [picked, setMed] = useState(meds[0]?.medicationId ?? '');
  const medicationId = meds.some((m) => m.medicationId === picked) ? picked : (meds[0]?.medicationId ?? '');
  const [quantity, setQty] = useState('');
  const [encounter, setEncounter] = useState<{ id: string; label: string } | null>(null);
  const [key, resetKey] = useIntentKey([locationId, medicationId, quantity, encounter?.id]);
  const [plan, setPlan] = useState<{ plan: Plan; replayed: boolean } | null>(null);
  const history = useLoad(
    () =>
      encounter
        ? api<{ dispenses: Movement[] }>('GET', `/api/pharmacy/dispenses?encounter=${encounter.id}`).then((r) => r.data.dispenses)
        : Promise.resolve([] as Movement[]),
    [encounter?.id, plan],
  );
  const save = useAction(async () => {
    if (!encounter) throw new Error('Chọn đợt khám trước');
    const r = await api<Plan>('POST', '/api/pharmacy/dispenses', {
      headers: { 'idempotency-key': key },
      body: { medicationId, locationId, encounterId: encounter.id, quantity: Number(quantity) },
    });
    setPlan({ plan: r.data, replayed: !!r.headers.get('idempotent-replayed') });
    setQty('');
    resetKey();
    onDone();
  });
  const unit = meds.find((m) => m.medicationId === medicationId)?.unitOfMeasure ?? '';
  return (
    <Card title="Cấp phát theo đợt khám">
      <EncounterPicker value={encounter} onChange={setEncounter} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPlan(null);
          void save.run();
        }}
      >
        <Field label="Thuốc">
          <select value={medicationId} onChange={(e) => setMed(e.target.value)}>
            {meds.map((m) => (
              <option key={m.medicationId} value={m.medicationId}>
                {m.brandName} {m.strength}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Số lượng (${unit})`}>
          <input required inputMode="numeric" pattern="[0-9]+" value={quantity} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <button type="submit" disabled={save.busy || !encounter || !medicationId}>
          {save.busy ? 'Đang cấp phát…' : 'Cấp phát (FEFO)'}
        </button>
      </form>
      <ErrorBox error={save.error} />
      {plan && (
        <Notice kind="ok">
          Đã cấp phát {plan.plan.allocatedTotal}
          {plan.replayed ? ' (yêu cầu gửi lại — không trừ kho lần hai)' : ''}:{' '}
          {plan.plan.items.map((i) => `${i.allocatedQuantity} từ lô ${i.batchNumber} (HSD ${fmtDate(i.expiryDate)})`).join('; ')}
        </Notice>
      )}
      {encounter && history.data && history.data.length > 0 && (
        <div className="sub">
          <strong>Đã cấp cho đợt khám này</strong>
          <ul className="list">
            {history.data.map((m) => (
              <li key={m.movementId}>
                {fmtDateTime(m.occurredAt)} — {m.quantity}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Chọn đợt khám: tìm bệnh nhân theo MRN/CCCD rồi chọn đợt khám của họ. */
function EncounterPicker({ value, onChange }: { value: { id: string; label: string } | null; onChange: (v: { id: string; label: string } | null) => void }) {
  const { orgId } = useSession();
  const [q, setQ] = useState('');
  const [patients, setPatients] = useState<FhirPatient[] | null>(null);
  const [patient, setPatient] = useState<FhirPatient | null>(null);
  const [encs, setEncs] = useState<FhirEncounter[] | null>(null);
  const find = useAction(async () => {
    const v = q.trim();
    const p = new URLSearchParams({ organization: orgId, _count: '10' });
    if (/^\d{9,12}$/.test(v)) p.set('identifier', `${CCCD_SYSTEM}|${v}`);
    else p.set('mrn', v);
    const r = await api<Bundle<FhirPatient>>('GET', `/fhir/Patient?${p.toString()}`);
    setPatients(entries(r.data));
    setPatient(null);
    setEncs(null);
  });
  const pick = useAction(async (p: FhirPatient) => {
    setPatient(p);
    const r = await api<Bundle<FhirEncounter>>('GET', `/fhir/Encounter?patient=${p.id}`);
    setEncs(entries(r.data).filter((e) => e.status === 'in-progress' || e.status === 'finished'));
  });

  if (value) {
    return (
      <div className="picked">
        Đợt khám: <strong>{value.label}</strong>{' '}
        <button className="link" onClick={() => onChange(null)}>
          Đổi
        </button>
      </div>
    );
  }
  return (
    <div className="sub">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void find.run();
        }}
      >
        <input required placeholder="MRN hoặc CCCD bệnh nhân" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" disabled={find.busy}>
          Tìm
        </button>
      </form>
      <ErrorBox error={find.error ?? pick.error} />
      {patients && patients.length === 0 && <p className="muted">Không tìm thấy.</p>}
      {patients && !patient && (
        <ul className="list">
          {patients.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => void pick.run(p)}>
                {patientName(p)} — {mrnOf(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {patient && encs && (
        <ul className="list">
          {encs.length === 0 && <li className="muted">Không có đợt khám đang mở / đã kết thúc.</li>}
          {encs.map((e) => (
            <li key={e.id}>
              <button className="link" onClick={() => onChange({ id: e.id!, label: `${patientName(patient)} · ${fmtDateTime(e.period?.start)}` })}>
                {fmtDateTime(e.period?.start)} — {STATUS_LABEL[e.status ?? ''] ?? e.status}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
