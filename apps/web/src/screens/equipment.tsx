/**
 * HCOS-F19 | Tab Thiết bị: sổ thiết bị y tế (mã tài sản, phòng, phân loại rủi ro, kiểm định / hiệu chuẩn, trạng thái, khấu hao),
 * dịch vụ cần máy, xuất sổ thiết bị; vật tư tiêu hao (kho trừ, định mức theo dịch vụ, dòng thiếu, giá vốn, tra thu hồi lô).
 * Trang thiết bị #/tb/<mã> (QR trên thân máy trỏ tới #/tb/<mã>/qr): bàn giao đầu ca, báo hỏng tại chỗ, nhật ký, kiểm định.
 * Server quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useState } from 'react';

import { api } from '../lib/api';
import { exportFile } from '../lib/download';
import { fmtDate, fmtDateTime } from '../lib/fhir';
import { fmtVnd } from '../lib/money';
import { QrCode } from '../lib/qr-view';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

type Regime = 'atkt' | 'do_luong' | 'buc_xa' | 'ap_luc' | 'hieu_chuan';
type RegimeState = 'ok' | 'due_soon' | 'overdue' | 'failed' | 'missing' | 'reinspect';
interface RegimeStatus {
  regime: Regime; cycleMonths: number; mandatory: boolean; state: RegimeState; performedOn: string | null; validUntil: string | null;
  result: 'pass' | 'fail' | null; provider: string | null; certificateNo: string | null; version: number;
}
interface Device {
  deviceId: string; assetCode: string; typeId: string; typeCode: string; typeName: string; name: string; manufacturer: string | null; model: string | null;
  serialNo: string | null; servicePointId: string | null; roomCode: string | null; riskClass: 'A' | 'B' | 'C' | 'D'; registrationNo: string | null;
  warrantyUntil: string | null; acquiredOn: string | null; inServiceOn: string | null; cost: number | null; usefulLifeMonths: number | null;
  status: 'active' | 'broken' | 'maintenance' | 'retired'; statusSince: string; retiredOn: string | null; version: number; blockers: string[];
  regimes: RegimeStatus[]; nextDue: { regime: Regime; validUntil: string | null; state: RegimeState } | null;
  depreciation: { monthly: number; thisMonth: number; accumulated: number; bookValue: number; monthsElapsed: number; endsOn: string } | null;
}
interface DeviceList {
  devices: Device[]; types: Array<{ typeId: string; code: string; name: string }>; rooms: Array<{ servicePointId: string; code: string; name: string }>;
  requirements: Array<{ itemId: string; itemCode: string; itemName: string; typeId: string; active: boolean; blocked: boolean }>;
  totals: { devices: number; usable: number; outOfService: number; dueSoon: number; depreciationThisMonth: number }; canUse: boolean; canManage: boolean;
}

export const REGIME_LABEL: Record<Regime, string> = {
  atkt: 'Kiểm định an toàn & tính năng kỹ thuật', do_luong: 'Kiểm định phương tiện đo', buc_xa: 'Kiểm định an toàn bức xạ',
  ap_luc: 'Kiểm định thiết bị áp lực', hieu_chuan: 'Hiệu chuẩn / bảo dưỡng định kỳ',
};
const REGIME_HINT: Record<Regime, string> = {
  atkt: 'thiết bị trong danh mục TT 05/2022/TT-BYT', do_luong: 'phương tiện đo theo pháp luật đo lường', buc_xa: 'X-quang…',
  ap_luc: 'nồi hấp…', hieu_chuan: 'theo nhà sản xuất / quy trình nội bộ (thường không bắt buộc)',
};
const STATE: Record<RegimeState, [string, string]> = {
  ok: ['Còn hạn', 'ok'], due_soon: ['Sắp đến hạn', 'warn'], overdue: ['Quá hạn', 'err'], failed: ['Không đạt', 'err'], missing: ['Chưa kiểm định', 'err'],
  reinspect: ['Cần kiểm định lại (sau sửa chữa lớn)', 'err'],
};
const STATUS: Record<Device['status'], [string, string]> = { active: ['Đang dùng', 'ok'], broken: ['Hỏng', 'err'], maintenance: ['Bảo trì', 'warn'], retired: ['Đã thanh lý', ''] };
const KIND: Record<string, string> = {
  registered: 'Đăng ký', handover: 'Nhận bàn giao', fault: 'Báo hỏng', maintenance_start: 'Bắt đầu bảo trì', repaired: 'Sửa xong', moved: 'Chuyển phòng',
  retired: 'Thanh lý', note: 'Ghi chú',
};
const blockerText = (b: string): string => {
  const [k, a, c] = b.split(':');
  if (k === 'status') return STATUS[a as Device['status']]?.[0] ?? a ?? '';
  return `${REGIME_LABEL[a as Regime] ?? a}: ${STATE[c as RegimeState]?.[0] ?? c}`;
};
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const num = (s: string): number | null => (s.trim() === '' ? null : Number(s.replace(/[.\s]/g, '')));

function UsableBadge({ d }: { d: Device }) {
  if (d.status === 'retired') return <span className="badge">Đã thanh lý</span>;
  return d.blockers.length === 0 ? <span className="badge ok">Dùng được</span> : <span className="badge err">KHÔNG được dùng</span>;
}

// ===========================================================================
export function EquipmentScreen() {
  const { roles } = useSession();
  return (
    <div className="stack">
      <DevicesCard />
      {can.supplies(roles) && <SuppliesSection />}
    </div>
  );
}

function DevicesCard() {
  const { orgId } = useSession();
  const l = useLoad(() => api<DeviceList>('GET', `/api/equipment?organization=${orgId}`).then((r) => r.data), [orgId]);
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const exp = useAction(async () => {
    await exportFile('equipment_register', { organizationId: orgId });
  });
  if (l.error) return <ErrorBox error={l.error} />;
  if (!l.data) return <p className="muted">Đang tải…</p>;
  const { devices, totals, canManage } = l.data;
  const shown = devices.filter((d) => showRetired || d.status !== 'retired');
  return (
    <>
      <Card
        title={`Thiết bị y tế (${totals.devices})`}
        actions={
          <>
            <button className="link" disabled={exp.busy} onClick={() => void exp.run()}>Xuất sổ thiết bị (Excel)</button>
            {canManage && !adding && <button className="link" onClick={() => setAdding(true)}>+ Thiết bị</button>}
          </>
        }
      >
        <div className="kpis">
          <div><strong>{totals.usable}</strong> dùng được</div>
          <div><strong className={totals.devices - totals.usable ? 'danger' : ''}>{totals.devices - totals.usable}</strong> không được dùng</div>
          <div><strong>{totals.outOfService}</strong> hỏng / bảo trì</div>
          <div><strong>{totals.dueSoon}</strong> sắp đến hạn kiểm định (≤ 30 ngày)</div>
          <div><strong>{fmtVnd(totals.depreciationThisMonth)}</strong> khấu hao tháng này</div>
        </div>
        <p className="muted small">
          Máy <strong>không được dùng</strong> khi đang hỏng / bảo trì, hoặc một chế độ kiểm định <em>bắt buộc</em> quá hạn, không đạt, chưa có, hay đã sửa chữa lớn mà chưa
          kiểm định lại. Khi đó dịch vụ cần loại máy này không chỉ định được nếu cơ sở không còn máy cùng loại dùng được. Quét QR trên thân máy để bàn giao đầu ca hoặc báo hỏng.
        </p>
        <ErrorBox error={exp.error} />
        {adding && <RegisterForm list={l.data} onDone={() => { setAdding(false); l.reload(); }} onCancel={() => setAdding(false)} />}
        {shown.length === 0 ? <p className="muted">Chưa có thiết bị.</p> : (
          <table>
            <thead><tr><th>Mã tài sản</th><th>Thiết bị</th><th>Phòng</th><th>Loại</th><th>Trạng thái</th><th>Kiểm định gần hạn nhất</th><th /></tr></thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.deviceId} className={d.status === 'retired' ? 'muted-row' : ''}>
                  <td><a href={`#/tb/${d.assetCode}`}><code>{d.assetCode}</code></a></td>
                  <td><strong>{d.name}</strong><div className="muted small">{d.typeName}{d.serialNo ? ` · SN ${d.serialNo}` : ''}</div></td>
                  <td>{d.roomCode ?? '—'}</td>
                  <td>Loại {d.riskClass}</td>
                  <td><span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span></td>
                  <td className="small">
                    {d.nextDue ? (
                      <>
                        <span className={`badge ${STATE[d.nextDue.state][1]}`}>{STATE[d.nextDue.state][0]}</span>{' '}
                        {REGIME_LABEL[d.nextDue.regime]}{d.nextDue.validUntil ? ` · hạn ${fmtDate(d.nextDue.validUntil)}` : ''}
                      </>
                    ) : <span className="muted">chưa khai báo chế độ</span>}
                  </td>
                  <td><UsableBadge d={d} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {devices.some((d) => d.status === 'retired') && (
          <label className="small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Hiện thiết bị đã thanh lý</label>
        )}
      </Card>
      <RequirementsCard list={l.data} onChanged={l.reload} />
    </>
  );
}

function RegisterForm({ list, onDone, onCancel }: { list: DeviceList; onDone: () => void; onCancel: () => void }) {
  const { orgId } = useSession();
  const [f, setF] = useState({
    typeId: list.types[0]?.typeId ?? '', name: '', manufacturer: '', model: '', serialNo: '', servicePointId: '', riskClass: 'B', registrationNo: '',
    warrantyUntil: '', acquiredOn: '', inServiceOn: today(), cost: '', usefulLifeMonths: '',
  });
  const [regimes, setRegimes] = useState<Record<Regime, { on: boolean; cycle: string; mandatory: boolean }>>({
    atkt: { on: false, cycle: '12', mandatory: true }, do_luong: { on: false, cycle: '12', mandatory: true }, buc_xa: { on: false, cycle: '12', mandatory: true },
    ap_luc: { on: false, cycle: '12', mandatory: true }, hieu_chuan: { on: true, cycle: '12', mandatory: false },
  });
  const [newType, setNewType] = useState({ code: '', name: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const addType = useAction(async () => {
    const r = await api<{ typeId: string }>('POST', '/api/equipment/types', { body: newType });
    list.types.push({ typeId: r.data.typeId, code: newType.code.toUpperCase(), name: newType.name });
    setF({ ...f, typeId: r.data.typeId });
    setNewType({ code: '', name: '' });
  });
  const save = useAction(async () => {
    const cost = num(f.cost);
    const life = num(f.usefulLifeMonths);
    await api('POST', '/api/equipment/devices', {
      body: {
        organizationId: orgId, typeId: f.typeId, name: f.name.trim(), riskClass: f.riskClass,
        ...(f.manufacturer.trim() ? { manufacturer: f.manufacturer.trim() } : {}), ...(f.model.trim() ? { model: f.model.trim() } : {}),
        ...(f.serialNo.trim() ? { serialNo: f.serialNo.trim() } : {}), ...(f.servicePointId ? { servicePointId: f.servicePointId } : {}),
        ...(f.registrationNo.trim() ? { registrationNo: f.registrationNo.trim() } : {}), ...(f.warrantyUntil ? { warrantyUntil: f.warrantyUntil } : {}),
        ...(f.acquiredOn ? { acquiredOn: f.acquiredOn } : {}), ...(f.inServiceOn ? { inServiceOn: f.inServiceOn } : {}),
        ...(cost !== null ? { cost } : {}), ...(life !== null ? { usefulLifeMonths: life } : {}),
        regimes: (Object.keys(regimes) as Regime[]).filter((r) => regimes[r].on).map((r) => ({ regime: r, cycleMonths: Number(regimes[r].cycle), mandatory: regimes[r].mandatory })),
      },
    });
    onDone();
  });
  return (
    <form className="sub stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <strong>Đăng ký thiết bị</strong>
      <p className="muted small">Mã tài sản (TByy-nnnn-c, có số kiểm tra) do hệ thống cấp. Phân loại rủi ro A–D và số lưu hành lấy theo hồ sơ công bố / đăng ký lưu hành của thiết bị.</p>
      <div className="row wrap">
        <Field label="Loại thiết bị *">
          <select required value={f.typeId} onChange={set('typeId')}>
            <option value="">— chọn —</option>
            {list.types.map((t) => <option key={t.typeId} value={t.typeId}>{t.name} ({t.code})</option>)}
          </select>
        </Field>
        <Field label="Thêm loại" hint="mã A-Z 0-9 _, vd. SIEU_AM">
          <span className="row">
            <input placeholder="Mã" size={10} value={newType.code} onChange={(e) => setNewType({ ...newType, code: e.target.value })} />
            <input placeholder="Tên loại" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} />
            <button type="button" disabled={addType.busy || !newType.code || !newType.name} onClick={() => void addType.run()}>Thêm</button>
          </span>
        </Field>
      </div>
      <ErrorBox error={addType.error} />
      <div className="row wrap">
        <Field label="Tên thiết bị *"><input required value={f.name} onChange={set('name')} placeholder="Máy siêu âm tổng quát" /></Field>
        <Field label="Hãng"><input value={f.manufacturer} onChange={set('manufacturer')} /></Field>
        <Field label="Model"><input value={f.model} onChange={set('model')} /></Field>
        <Field label="Số serial"><input value={f.serialNo} onChange={set('serialNo')} /></Field>
        <Field label="Phòng đặt máy">
          <select value={f.servicePointId} onChange={set('servicePointId')}>
            <option value="">(kho / chưa đặt)</option>
            {list.rooms.map((r) => <option key={r.servicePointId} value={r.servicePointId}>{r.code} — {r.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="row wrap">
        <Field label="Phân loại rủi ro *">
          <select value={f.riskClass} onChange={set('riskClass')}>{['A', 'B', 'C', 'D'].map((x) => <option key={x} value={x}>Loại {x}</option>)}</select>
        </Field>
        <Field label="Số lưu hành"><input value={f.registrationNo} onChange={set('registrationNo')} /></Field>
        <Field label="Bảo hành đến"><input type="date" value={f.warrantyUntil} onChange={set('warrantyUntil')} /></Field>
        <Field label="Ngày mua"><input type="date" value={f.acquiredOn} onChange={set('acquiredOn')} /></Field>
        <Field label="Đưa vào sử dụng"><input type="date" value={f.inServiceOn} onChange={set('inServiceOn')} /></Field>
      </div>
      <div className="row wrap">
        <Field label="Nguyên giá (đ)" hint="bỏ trống nếu không tính khấu hao"><input inputMode="numeric" value={f.cost} onChange={set('cost')} /></Field>
        <Field label="Số tháng sử dụng" hint="theo khung của Bộ Tài chính, kế toán xác nhận"><input inputMode="numeric" value={f.usefulLifeMonths} onChange={set('usefulLifeMonths')} /></Field>
      </div>
      <div>
        <strong className="small">Chế độ kiểm định / hiệu chuẩn áp dụng</strong>
        <p className="muted small">Cơ sở tự xác định thiết bị thuộc diện kiểm định nào. Chế độ "bắt buộc" quá hạn thì máy bị chặn chỉ định.</p>
        {(Object.keys(REGIME_LABEL) as Regime[]).map((r) => (
          <div key={r} className="row wrap small">
            <label><input type="checkbox" checked={regimes[r].on} onChange={(e) => setRegimes({ ...regimes, [r]: { ...regimes[r], on: e.target.checked } })} /> {REGIME_LABEL[r]} <span className="muted">({REGIME_HINT[r]})</span></label>
            {regimes[r].on && (
              <>
                <span>chu kỳ <input size={3} inputMode="numeric" value={regimes[r].cycle} onChange={(e) => setRegimes({ ...regimes, [r]: { ...regimes[r], cycle: e.target.value } })} /> tháng</span>
                <label><input type="checkbox" checked={regimes[r].mandatory} onChange={(e) => setRegimes({ ...regimes, [r]: { ...regimes[r], mandatory: e.target.checked } })} /> bắt buộc</label>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <button type="submit" disabled={save.busy}>Đăng ký</button>
        <button type="button" className="link" onClick={onCancel}>Huỷ</button>
      </div>
      <ErrorBox error={save.error} />
    </form>
  );
}

function RequirementsCard({ list, onChanged }: { list: DeviceList; onChanged: () => void }) {
  const { orgId } = useSession();
  const items = useLoad(() => (list.canManage ? api<{ items: Array<{ itemId: string; code: string; name: string; isActive: boolean }> }>('GET', `/api/finance/price-items?organization=${orgId}`).then((r) => r.data.items) : Promise.resolve([])), [orgId, list.canManage]);
  const [f, setF] = useState({ itemId: '', typeId: '' });
  const setReq = useAction(async (itemId: string, typeId: string, active: boolean) => {
    await api('POST', '/api/equipment/requirements', { body: { organizationId: orgId, itemId, typeId, active } });
    setF({ itemId: '', typeId: '' });
    onChanged();
  });
  const typeName = (id: string) => list.types.find((t) => t.typeId === id)?.name ?? id;
  return (
    <Card title="Dịch vụ cần máy">
      <p className="muted small">Gắn dịch vụ trong bảng giá với loại máy. Khi cơ sở không còn máy nào của loại đó dùng được, hệ thống không cho ghi dịch vụ (tránh chỉ định nhầm).</p>
      {list.requirements.length === 0 ? <p className="muted">Chưa gắn dịch vụ nào.</p> : (
        <table>
          <thead><tr><th>Dịch vụ</th><th>Cần loại máy</th><th>Hiện tại</th><th /></tr></thead>
          <tbody>
            {list.requirements.map((r) => (
              <tr key={`${r.itemId}-${r.typeId}`} className={r.active ? '' : 'muted-row'}>
                <td><code>{r.itemCode}</code> {r.itemName}</td>
                <td>{typeName(r.typeId)}</td>
                <td>{!r.active ? 'Đã bỏ' : r.blocked ? <span className="badge err">Đang chặn — không còn máy dùng được</span> : <span className="badge ok">Chỉ định được</span>}</td>
                <td>{list.canManage && <button className="link" disabled={setReq.busy} onClick={() => void setReq.run(r.itemId, r.typeId, !r.active)}>{r.active ? 'Bỏ' : 'Bật lại'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list.canManage && (
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void setReq.run(f.itemId, f.typeId, true); }}>
          <select required value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}>
            <option value="">— dịch vụ —</option>
            {(items.data ?? []).filter((i) => i.isActive).map((i) => <option key={i.itemId} value={i.itemId}>{i.code} — {i.name}</option>)}
          </select>
          <select required value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })}>
            <option value="">— loại máy —</option>
            {list.types.map((t) => <option key={t.typeId} value={t.typeId}>{t.name}</option>)}
          </select>
          <button type="submit" disabled={setReq.busy}>Gắn</button>
        </form>
      )}
      <ErrorBox error={setReq.error ?? items.error} />
    </Card>
  );
}

// ===========================================================================
// Trang thiết bị (QR)
// ===========================================================================
interface DevicePage {
  device: Device;
  events: Array<{ eventId: string; kind: string; note: string | null; majorRepair: boolean; fromStatus: string | null; toStatus: string | null; fromRoom: string | null; toRoom: string | null; via: string; actorName: string | null; occurredAt: string }>;
  inspections: Array<{ inspectionId: string; regime: Regime; performedOn: string; result: 'pass' | 'fail'; validUntil: string; provider: string; certificateNo: string | null; note: string | null; recordedByName: string | null }>;
  canUse: boolean; canManage: boolean;
}

export function DeviceScreen({ code, qr }: { code: string; qr: boolean }) {
  const { orgId } = useSession();
  const p = useLoad(() => api<DevicePage>('GET', `/api/equipment/devices/${encodeURIComponent(code)}`).then((r) => r.data), [code]);
  const rooms = useLoad(() => api<DeviceList>('GET', `/api/equipment?organization=${orgId}`).then((r) => r.data.rooms), [orgId]);
  const [label, setLabel] = useState(false);
  const ev = useAction(async (kind: string, extra: Record<string, unknown> = {}) => {
    await api('POST', `/api/equipment/devices/${encodeURIComponent(code)}/events`, { body: { kind, via: qr ? 'qr' : 'web', ...extra } });
    p.reload();
  });
  const ask = (kind: string, q: string, required = true, extra: Record<string, unknown> = {}) => {
    const note = prompt(q);
    if (note === null) return;
    if (required && note.trim().length < 3) return alert('Cần ghi mô tả (ít nhất 3 ký tự).');
    void ev.run(kind, { ...(note.trim() ? { note: note.trim() } : {}), ...extra });
  };
  if (p.error) return <div className="stack"><a href="#/equipment" className="back">← Thiết bị</a><ErrorBox error={p.error} /></div>;
  if (!p.data) return <p className="muted">Đang tải…</p>;
  const { device: d, events, inspections, canUse, canManage } = p.data;
  const live = d.status !== 'retired';
  const link = `${location.origin}/app/#/tb/${d.assetCode}/qr`;
  return (
    <div className="stack">
      <a href="#/equipment" className="back">← Thiết bị</a>
      {live && (d.blockers.length === 0
        ? <Notice kind="ok"><strong>ĐƯỢC DÙNG.</strong> Máy đang hoạt động và các chế độ kiểm định bắt buộc còn hạn.</Notice>
        : <Notice kind="warn"><strong>KHÔNG ĐƯỢC DÙNG</strong> — {d.blockers.map(blockerText).join('; ')}. Không chỉ định dịch vụ dùng máy này.</Notice>)}
      <Card
        title={`${d.assetCode} — ${d.name}`}
        actions={<button className="link" onClick={() => setLabel(!label)}>{label ? 'Ẩn nhãn QR' : 'Nhãn QR để dán lên máy'}</button>}
      >
        {label && (
          <div className="print-ticket">
            <QrCode text={link} size={180} label={`Mã QR thiết bị ${d.assetCode}`} />
            <div className="pt-room">{d.assetCode}</div>
            <div className="pt-name">{d.name}{d.serialNo ? ` · SN ${d.serialNo}` : ''}</div>
            <button className="no-print" onClick={() => window.print()}>In nhãn</button>
          </div>
        )}
        <dl className="kv">
          <dt>Trạng thái</dt><dd><span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span> <span className="muted small">từ {fmtDateTime(d.statusSince)}</span></dd>
          <dt>Loại / phòng</dt><dd>{d.typeName} · {d.roomCode ?? 'chưa đặt phòng'}</dd>
          <dt>Hãng / model / serial</dt><dd>{[d.manufacturer, d.model, d.serialNo].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>Phân loại rủi ro</dt><dd>Loại {d.riskClass} · số lưu hành {d.registrationNo ?? <span className="danger">chưa nhập</span>}</dd>
          <dt>Bảo hành</dt><dd>{d.warrantyUntil ? `đến ${fmtDate(d.warrantyUntil)}${d.warrantyUntil < today() ? ' (đã hết)' : ''}` : '—'}</dd>
          <dt>Khấu hao</dt>
          <dd>{d.depreciation && d.cost !== null ? <>Nguyên giá {fmtVnd(d.cost)} · {d.usefulLifeMonths} tháng · {fmtVnd(d.depreciation.monthly)}/tháng · luỹ kế {fmtVnd(d.depreciation.accumulated)} · còn lại {fmtVnd(d.depreciation.bookValue)}</> : '—'}</dd>
        </dl>
        {live && (
          <div className="row wrap">
            {canUse && <button onClick={() => ask('handover', 'Nhận bàn giao đầu ca — ghi chú tình trạng (có thể bỏ trống):', false)} disabled={ev.busy}>Nhận bàn giao đầu ca</button>}
            {canUse && (d.status === 'active' || d.status === 'maintenance') && (
              <button className="danger" onClick={() => ask('fault', 'Mô tả lỗi (không ghi tên / thông tin người bệnh):')} disabled={ev.busy}>Báo hỏng</button>
            )}
            {canUse && <button className="link" onClick={() => ask('note', 'Ghi chú:')} disabled={ev.busy}>Ghi chú</button>}
            {canManage && (d.status === 'active' || d.status === 'broken') && <button className="link" onClick={() => ask('maintenance_start', 'Nội dung bảo trì:')} disabled={ev.busy}>Bắt đầu bảo trì</button>}
            {canManage && (d.status === 'broken' || d.status === 'maintenance') && (
              <>
                <button onClick={() => ask('repaired', 'Đã sửa / bảo trì gì?', true, { majorRepair: false })} disabled={ev.busy}>Sửa xong</button>
                <button className="link" onClick={() => ask('repaired', 'Sửa chữa lớn — nội dung (máy phải kiểm định lại mới được dùng):', true, { majorRepair: true })} disabled={ev.busy}>Sửa xong (sửa chữa lớn)</button>
              </>
            )}
            {canManage && (
              <select value="" onChange={(e) => e.target.value && void ev.run('moved', { toServicePointId: e.target.value === '-' ? null : e.target.value })} disabled={ev.busy}>
                <option value="">Chuyển phòng…</option>
                {d.servicePointId && <option value="-">(về kho)</option>}
                {(rooms.data ?? []).filter((r) => r.servicePointId !== d.servicePointId).map((r) => <option key={r.servicePointId} value={r.servicePointId}>{r.code} — {r.name}</option>)}
              </select>
            )}
            {canManage && <button className="link danger" onClick={() => confirm('Thanh lý thiết bị? Không ghi thêm được nữa.') && ask('retired', 'Căn cứ thanh lý (số quyết định…):')} disabled={ev.busy}>Thanh lý</button>}
          </div>
        )}
        <ErrorBox error={ev.error} />
      </Card>
      <InspectionsCard page={p.data} onChanged={p.reload} />
      <Card title="Nhật ký thiết bị">
        <p className="muted small">Chỉ ghi thêm, không sửa / xoá được. Trạng thái máy chỉ đổi qua nhật ký này.</p>
        <table>
          <thead><tr><th>Lúc</th><th>Việc</th><th>Trạng thái</th><th>Người</th><th>Ghi chú</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.eventId}>
                <td className="small">{fmtDateTime(e.occurredAt)}</td>
                <td>{KIND[e.kind] ?? e.kind}{e.majorRepair ? ' (sửa chữa lớn)' : ''}{e.via === 'qr' ? <span className="muted small"> · quét QR</span> : null}</td>
                <td className="small">{e.fromStatus && e.fromStatus !== e.toStatus ? `${STATUS[e.fromStatus as Device['status']]?.[0]} → ${STATUS[e.toStatus as Device['status']]?.[0]}` : ''}{e.kind === 'moved' ? `${e.fromRoom ?? 'kho'} → ${e.toRoom ?? 'kho'}` : ''}</td>
                <td>{e.actorName ?? '—'}</td>
                <td className="small">{e.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {inspections.length > 0 && (
        <Card title="Lịch sử kiểm định / hiệu chuẩn">
          <table>
            <thead><tr><th>Ngày</th><th>Chế độ</th><th>Kết quả</th><th>Hiệu lực đến</th><th>Đơn vị</th><th>Số GCN / tem</th><th>Người ghi</th></tr></thead>
            <tbody>
              {inspections.map((i) => (
                <tr key={i.inspectionId}>
                  <td>{fmtDate(i.performedOn)}</td><td>{REGIME_LABEL[i.regime]}</td>
                  <td>{i.result === 'pass' ? <span className="badge ok">Đạt</span> : <span className="badge err">Không đạt</span>}{i.note ? <div className="muted small">{i.note}</div> : null}</td>
                  <td>{i.result === 'pass' ? fmtDate(i.validUntil) : '—'}</td><td className="small">{i.provider}</td><td>{i.certificateNo ?? ''}</td><td className="small">{i.recordedByName ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function InspectionsCard({ page, onChanged }: { page: DevicePage; onChanged: () => void }) {
  const d = page.device;
  const [rec, setRec] = useState<RegimeStatus | null>(null);
  const [f, setF] = useState({ performedOn: today(), result: 'pass', provider: '', certificateNo: '', validUntil: '', note: '' });
  const [addR, setAddR] = useState({ regime: '' as Regime | '', cycle: '12', mandatory: true });
  const save = useAction(async () => {
    if (!rec) return;
    await api('POST', `/api/equipment/devices/${d.deviceId}/inspections`, {
      body: {
        regime: rec.regime, performedOn: f.performedOn, result: f.result, provider: f.provider.trim(),
        ...(f.certificateNo.trim() ? { certificateNo: f.certificateNo.trim() } : {}), ...(f.validUntil ? { validUntil: f.validUntil } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}),
      },
    });
    setRec(null);
    onChanged();
  });
  const regime = useAction(async (r: Regime, cycleMonths: number, mandatory: boolean, active: boolean, version?: number) => {
    await api('POST', `/api/equipment/devices/${d.deviceId}/regimes`, { body: { regime: r, cycleMonths, mandatory, active, ...(version ? { version } : {}) } });
    setAddR({ regime: '', cycle: '12', mandatory: true });
    onChanged();
  });
  const missing = (Object.keys(REGIME_LABEL) as Regime[]).filter((r) => !d.regimes.some((x) => x.regime === r));
  return (
    <Card title="Kiểm định / hiệu chuẩn">
      {d.regimes.length === 0 ? <p className="muted">Chưa khai báo chế độ nào.</p> : (
        <table>
          <thead><tr><th>Chế độ</th><th>Chu kỳ</th><th>Tình trạng</th><th>Lần gần nhất</th><th>Hạn</th><th /></tr></thead>
          <tbody>
            {d.regimes.map((r) => (
              <tr key={r.regime}>
                <td>{REGIME_LABEL[r.regime]}{r.mandatory ? '' : <span className="muted small"> (không bắt buộc — chỉ nhắc)</span>}</td>
                <td>{r.cycleMonths} tháng</td>
                <td><span className={`badge ${STATE[r.state][1]}`}>{STATE[r.state][0]}</span></td>
                <td className="small">{r.performedOn ? `${fmtDate(r.performedOn)} · ${r.provider ?? ''}${r.certificateNo ? ` · ${r.certificateNo}` : ''}` : '—'}</td>
                <td>{r.validUntil && r.result === 'pass' ? fmtDate(r.validUntil) : '—'}</td>
                <td className="actions">
                  {page.canManage && d.status !== 'retired' && (
                    <>
                      <button className="link" onClick={() => { setRec(r); setF({ ...f, validUntil: '' }); }}>Ghi kết quả</button>
                      <button className="link" disabled={regime.busy} onClick={() => confirm(`Bỏ chế độ "${REGIME_LABEL[r.regime]}" khỏi thiết bị?`) && void regime.run(r.regime, r.cycleMonths, r.mandatory, false, r.version)}>Bỏ</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rec && (
        <form className="sub row wrap" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <strong>{REGIME_LABEL[rec.regime]}</strong>
          <Field label="Ngày thực hiện *"><input type="date" required max={today()} value={f.performedOn} onChange={(e) => setF({ ...f, performedOn: e.target.value })} /></Field>
          <Field label="Kết quả *">
            <select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="pass">Đạt</option><option value="fail">Không đạt</option></select>
          </Field>
          <Field label="Đơn vị thực hiện *"><input required value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} /></Field>
          <Field label={f.result === 'pass' ? 'Số giấy chứng nhận / tem *' : 'Số biên bản'}><input required={f.result === 'pass'} value={f.certificateNo} onChange={(e) => setF({ ...f, certificateNo: e.target.value })} /></Field>
          {f.result === 'pass' && <Field label="Hiệu lực đến" hint={`bỏ trống = +${rec.cycleMonths} tháng`}><input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></Field>}
          <Field label="Ghi chú"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <button type="submit" disabled={save.busy}>Lưu</button>
          <button type="button" className="link" onClick={() => setRec(null)}>Huỷ</button>
          <ErrorBox error={save.error} />
        </form>
      )}
      {page.canManage && d.status !== 'retired' && missing.length > 0 && (
        <form className="row wrap small" onSubmit={(e) => { e.preventDefault(); if (addR.regime) void regime.run(addR.regime, Number(addR.cycle), addR.mandatory, true); }}>
          <select value={addR.regime} onChange={(e) => setAddR({ ...addR, regime: e.target.value as Regime, mandatory: e.target.value !== 'hieu_chuan' })}>
            <option value="">+ Thêm chế độ…</option>
            {missing.map((r) => <option key={r} value={r}>{REGIME_LABEL[r]}</option>)}
          </select>
          {addR.regime && (
            <>
              <span>chu kỳ <input size={3} value={addR.cycle} onChange={(e) => setAddR({ ...addR, cycle: e.target.value })} /> tháng</span>
              <label><input type="checkbox" checked={addR.mandatory} onChange={(e) => setAddR({ ...addR, mandatory: e.target.checked })} /> bắt buộc</label>
              <button type="submit" disabled={regime.busy}>Thêm</button>
            </>
          )}
        </form>
      )}
      <ErrorBox error={regime.error} />
    </Card>
  );
}

// ===========================================================================
// Vật tư tiêu hao
// ===========================================================================
interface SupplyOverview {
  settings: { locationId: string | null; version: number };
  locations: Array<{ locationId: string; name: string; type: string }>;
  supplies: Array<{ medicationId: string; name: string; strength: string; unit: string; onHand: number; unitCost: number }>;
  services: Array<{ itemId: string; code: string; name: string; category: string; unitPrice: number; isActive: boolean; norms: Array<{ medicationId: string; quantity: number }>; standardCost: number }>;
  shortfalls: Array<{ consumptionId: string; name: string; unit: string; quantity: number; cost: number; batchNumber: string | null; at: string }>;
  cogsLast30: Array<{ code: string | null; name: string; cases: number; cost: number }>;
  canManage: boolean; canRecall: boolean;
}

function SuppliesSection() {
  const { orgId } = useSession();
  const o = useLoad(() => api<SupplyOverview>('GET', `/api/supplies?organization=${orgId}`).then((r) => r.data), [orgId]);
  const [open, setOpen] = useState<string | null>(null);
  const loc = useAction(async (locationId: string) => {
    await api('POST', '/api/supplies/settings', { body: { organizationId: orgId, locationId: locationId || null, version: o.data?.settings.version ?? 0 } });
    o.reload();
  });
  const resolve = useAction(async (id: string) => {
    const note = prompt('Đối soát — đã xử lý thế nào? (vd. nhập bù, điều chỉnh kho, ghi sai định mức)');
    if (note === null) return;
    await api('POST', `/api/supplies/shortfalls/${id}/resolve`, { body: { note } });
    o.reload();
  });
  if (o.error) return <ErrorBox error={o.error} />;
  if (!o.data) return null;
  const x = o.data;
  const supplyName = (id: string) => x.supplies.find((s) => s.medicationId === id)?.name ?? id;
  return (
    <>
      <Card title="Vật tư tiêu hao — định mức theo dịch vụ">
        <p className="muted small">
          Vật tư dùng chung kho lô / hạn dùng của Dược (thêm ở tab Dược, chọn loại "Vật tư tiêu hao"). Khi thu ngân <strong>tất toán</strong> hồ sơ, hệ thống trừ kho theo định mức:
          lô điều dưỡng đã ghi lúc làm thủ thuật được trừ trước, phần còn lại tự chọn lô hết hạn trước (FEFO). Thiếu tồn không chặn tất toán — ghi "thiếu" chờ đối soát.
        </p>
        <div className="row wrap">
          <Field label="Kho / tủ trừ vật tư">
            <select value={x.settings.locationId ?? ''} disabled={!x.canManage || loc.busy} onChange={(e) => void loc.run(e.target.value)}>
              <option value="">(chưa chọn — mọi dòng sẽ ghi thiếu)</option>
              {x.locations.map((l) => <option key={l.locationId} value={l.locationId}>{l.name}</option>)}
            </select>
          </Field>
        </div>
        <ErrorBox error={loc.error} />
        {!x.settings.locationId && <Notice kind="warn">Chưa chọn kho trừ vật tư.</Notice>}
        <table>
          <thead><tr><th>Dịch vụ</th><th>Định mức / lần</th><th>Giá vốn vật tư chuẩn</th><th>Giá bán</th><th /></tr></thead>
          <tbody>
            {x.services.filter((s) => s.isActive).flatMap((s) => {
              const lines = s.norms.filter((n) => n.quantity > 0);
              const rows = [
                <tr key={s.itemId}>
                  <td><code>{s.code}</code> {s.name}</td>
                  <td className="small">{lines.length ? lines.map((n) => `${supplyName(n.medicationId)} × ${n.quantity}`).join(', ') : <span className="muted">—</span>}</td>
                  <td>{s.standardCost ? fmtVnd(s.standardCost) : '—'}</td>
                  <td>{fmtVnd(s.unitPrice)}</td>
                  <td>{x.canManage && <button className="link" onClick={() => setOpen(open === s.itemId ? null : s.itemId)}>{open === s.itemId ? 'Đóng' : 'Sửa định mức'}</button>}</td>
                </tr>,
              ];
              if (open === s.itemId) rows.push(<tr key={`${s.itemId}-e`}><td colSpan={5}><NormEditor service={s} supplies={x.supplies} onChanged={o.reload} /></td></tr>);
              return rows;
            })}
          </tbody>
        </table>
      </Card>

      <Card title={`Dòng thiếu chờ đối soát (${x.shortfalls.length})`}>
        {x.shortfalls.length === 0 ? <p className="muted">Không có.</p> : (
          <table>
            <thead><tr><th>Lúc tất toán</th><th>Vật tư</th><th>Thiếu</th><th>Lô (nếu đã ghi)</th><th>Giá vốn ước</th><th /></tr></thead>
            <tbody>
              {x.shortfalls.map((s) => (
                <tr key={s.consumptionId}>
                  <td className="small">{fmtDateTime(s.at)}</td><td>{s.name}</td><td>{s.quantity} {s.unit}</td><td>{s.batchNumber ?? '—'}</td><td>{fmtVnd(Math.round(s.cost))}</td>
                  <td>{x.canManage && <button className="link" disabled={resolve.busy} onClick={() => void resolve.run(s.consumptionId)}>Đối soát</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorBox error={resolve.error} />
      </Card>

      <Card title="Giá vốn vật tư 30 ngày (theo ngày tất toán)">
        {x.cogsLast30.length === 0 ? <p className="muted">Chưa có.</p> : (
          <table>
            <thead><tr><th>Dịch vụ</th><th>Số hồ sơ</th><th>Giá vốn vật tư</th></tr></thead>
            <tbody>{x.cogsLast30.map((c) => <tr key={c.code ?? '-'}><td>{c.code ? <code>{c.code}</code> : null} {c.name}</td><td>{c.cases}</td><td>{fmtVnd(c.cost)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>

      {x.canRecall && <RecallCard supplies={x.supplies} />}
    </>
  );
}

function NormEditor({ service, supplies, onChanged }: { service: SupplyOverview['services'][number]; supplies: SupplyOverview['supplies']; onChanged: () => void }) {
  const { orgId } = useSession();
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(supplies.map((s) => [s.medicationId, String(service.norms.find((n) => n.medicationId === s.medicationId)?.quantity ?? 0)])));
  const save = useAction(async () => {
    for (const s of supplies) {
      const was = service.norms.find((n) => n.medicationId === s.medicationId)?.quantity ?? 0;
      const now = Number(qty[s.medicationId] ?? 0);
      if (now !== was) await api('POST', '/api/supplies/norms', { body: { organizationId: orgId, itemId: service.itemId, medicationId: s.medicationId, quantity: now } });
    }
    onChanged();
  });
  if (supplies.length === 0) return <p className="muted small">Chưa có vật tư tiêu hao trong danh mục (thêm ở tab Dược).</p>;
  return (
    <form className="row wrap small" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      {supplies.map((s) => (
        <label key={s.medicationId}>{s.name} <input size={3} inputMode="numeric" value={qty[s.medicationId] ?? '0'} onChange={(e) => setQty({ ...qty, [s.medicationId]: e.target.value })} /> {s.unit}</label>
      ))}
      <button type="submit" disabled={save.busy}>Lưu định mức</button>
      <ErrorBox error={save.error} />
    </form>
  );
}

function RecallCard({ supplies }: { supplies: SupplyOverview['supplies'] }) {
  const { orgId } = useSession();
  const [f, setF] = useState({ batchNumber: '', medicationId: '', reason: '' });
  const [res, setRes] = useState<null | { batchNumber: string; patients: Array<{ patientId: string; mrn: string; name: string | null; erased: boolean; restricted: boolean; supply: string; batchNumber: string; quantity: number; at: string; certainty: 'recorded' | 'fefo'; caseStatus: 'open' | 'closed' }> }>(null);
  const go = useAction(async () => {
    const r = await api<NonNullable<typeof res>>('POST', '/api/supplies/recall', {
      body: { organizationId: orgId, batchNumber: f.batchNumber.trim(), reason: f.reason.trim(), ...(f.medicationId ? { medicationId: f.medicationId } : {}) },
    });
    setRes(r.data);
  });
  return (
    <Card title="Tra cứu thu hồi lô vật tư">
      <p className="muted small">
        Khi nhà cung cấp thông báo thu hồi: nhập số lô để ra danh sách người bệnh đã dùng. "Chắc chắn" = điều dưỡng đã quét / ghi đúng lô; "Có khả năng" = hệ thống tự chọn lô
        theo FEFO lúc tất toán. Kết quả có họ tên — bắt buộc ghi lý do, lần tra được ghi nhật ký.
      </p>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void go.run(); }}>
        <Field label="Số lô *"><input required value={f.batchNumber} onChange={(e) => setF({ ...f, batchNumber: e.target.value })} /></Field>
        <Field label="Vật tư">
          <select value={f.medicationId} onChange={(e) => setF({ ...f, medicationId: e.target.value })}>
            <option value="">(mọi vật tư)</option>
            {supplies.map((s) => <option key={s.medicationId} value={s.medicationId}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Lý do *" hint="vd. số công văn thu hồi"><input required minLength={5} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <button type="submit" disabled={go.busy}>Tra</button>
      </form>
      <ErrorBox error={go.error} />
      {res && (res.patients.length === 0 ? <p className="muted">Không có người bệnh nào dùng lô {res.batchNumber}.</p> : (
        <table>
          <thead><tr><th>Mã BN</th><th>Họ tên</th><th>Vật tư</th><th>SL</th><th>Lúc</th><th>Mức chắc chắn</th></tr></thead>
          <tbody>
            {res.patients.map((p, i) => (
              <tr key={`${p.patientId}-${i}`}>
                <td><a href={`#/patients/${p.patientId}`}>{p.mrn}</a></td>
                <td>{p.erased ? <span className="muted">(đã xoá theo yêu cầu)</span> : p.name}{p.restricted ? <span className="badge warn">hạn chế xử lý</span> : null}</td>
                <td>{p.supply} · lô {p.batchNumber}</td><td>{p.quantity}</td><td className="small">{fmtDateTime(p.at)}{p.caseStatus === 'open' ? ' (chưa tất toán)' : ''}</td>
                <td>{p.certainty === 'recorded' ? <span className="badge ok">Chắc chắn</span> : <span className="badge warn">Có khả năng (FEFO)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </Card>
  );
}

// ===========================================================================
// Ghi lô vật tư đã dùng (thẻ trong trang đợt khám)
// ===========================================================================
export function SupplyLotsCard({ patientId }: { patientId: string }) {
  const { orgId } = useSession();
  const l = useLoad(() => api<{ caseOpen: boolean; canRecord: boolean; supplies: Array<{ medicationId: string; name: string; unit: string }>; lots: Array<{ usageId: string; name: string; unit: string; batchNumber: string; expiry: string | null; quantity: number; status: string; recordedAt: string; recordedByName: string | null }> }>(
    'GET', `/api/supplies/lots?organization=${orgId}&patient=${patientId}`).then((r) => r.data), [orgId, patientId]);
  const [f, setF] = useState({ batchNumber: '', medicationId: '', quantity: '1' });
  const add = useAction(async () => {
    await api('POST', '/api/supplies/lots', {
      body: { organizationId: orgId, patientId, batchNumber: f.batchNumber.trim(), quantity: Number(f.quantity), ...(f.medicationId ? { medicationId: f.medicationId } : {}) },
    });
    setF({ ...f, batchNumber: '', quantity: '1' });
    l.reload();
  });
  const cancel = useAction(async (id: string) => {
    const reason = prompt('Lý do huỷ dòng này?');
    if (reason === null) return;
    await api('POST', `/api/supplies/lots/${id}/cancel`, { body: { reason } });
    l.reload();
  });
  if (l.error || !l.data) return null;
  const { caseOpen, canRecord, supplies, lots } = l.data;
  return (
    <Card title="Vật tư đã dùng (ghi lô)">
      <p className="muted small">Quét / nhập số lô vật tư vừa dùng để truy xuất chính xác khi có thu hồi. Không bắt buộc: lúc tất toán hệ thống vẫn trừ theo định mức (chọn lô theo FEFO).</p>
      {!caseOpen && <Notice>Người bệnh chưa có hồ sơ thanh toán đang mở — chưa ghi lô được.</Notice>}
      {lots.length > 0 && (
        <ul className="list small">
          {lots.map((x) => (
            <li key={x.usageId} className={x.status === 'cancelled' ? 'muted' : ''}>
              {x.name} · lô <strong>{x.batchNumber}</strong>{x.expiry ? ` (HD ${fmtDate(x.expiry)})` : ''} × {x.quantity} {x.unit} · {x.recordedByName ?? ''} {fmtDateTime(x.recordedAt)}
              {x.status === 'cancelled' ? ' — đã huỷ' : canRecord && caseOpen ? <> <button className="link" disabled={cancel.busy} onClick={() => void cancel.run(x.usageId)}>Huỷ</button></> : null}
            </li>
          ))}
        </ul>
      )}
      {caseOpen && canRecord && (
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
          <input required autoComplete="off" placeholder="Số lô (quét mã)" value={f.batchNumber} onChange={(e) => setF({ ...f, batchNumber: e.target.value })} />
          <select value={f.medicationId} onChange={(e) => setF({ ...f, medicationId: e.target.value })}>
            <option value="">(tự nhận theo số lô)</option>
            {supplies.map((s) => <option key={s.medicationId} value={s.medicationId}>{s.name}</option>)}
          </select>
          <input size={3} inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
          <button type="submit" disabled={add.busy}>Ghi</button>
        </form>
      )}
      <ErrorBox error={add.error ?? cancel.error} />
    </Card>
  );
}

// ===========================================================================
// Vật tư đã trừ của hồ sơ thanh toán (màn hồ sơ thu ngân)
// ===========================================================================
export function CaseSuppliesCard({ caseId }: { caseId: string }) {
  const c = useLoad(() => api<{ lines: Array<{ name: string; unit: string; batchNumber: string | null; quantity: number; cost: number; source: string; itemCode: string | null }>; cogs: number; shortfallQty: number }>(
    'GET', `/api/supplies/cases/${caseId}`).then((r) => r.data), [caseId]);
  if (c.error || !c.data || c.data.lines.length === 0) return null;
  const SRC: Record<string, string> = { recorded: 'lô đã ghi', fefo: 'FEFO', shortfall: 'THIẾU tồn' };
  return (
    <Card title={`Vật tư đã trừ khi tất toán — giá vốn ${fmtVnd(c.data.cogs)}`}>
      {c.data.shortfallQty > 0 && <Notice kind="warn">Có {c.data.shortfallQty} đơn vị vật tư thiếu tồn — kho đối soát ở tab Thiết bị.</Notice>}
      <table>
        <thead><tr><th>Dịch vụ</th><th>Vật tư</th><th>Lô</th><th>SL</th><th>Nguồn</th><th>Giá vốn</th></tr></thead>
        <tbody>
          {c.data.lines.map((l, i) => (
            <tr key={i}><td>{l.itemCode ?? '(ngoài định mức)'}</td><td>{l.name}</td><td>{l.batchNumber ?? '—'}</td><td>{l.quantity} {l.unit}</td><td>{SRC[l.source] ?? l.source}</td><td>{fmtVnd(l.cost)}</td></tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
