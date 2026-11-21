/**
 * Quầy trả (HCOS-F14): BS kết thúc khám => số của bệnh nhân tự vào hàng chờ quầy trả (giữ số cũ, vd. N1-007).
 *  - Dược sĩ (tab Dược): cấp thuốc như cũ rồi bấm "Soạn xong" => số chuyển sang "Chờ gọi ra quầy".
 *  - Người đứng quầy (tab Quầy trả): chọn quầy, "Gọi tiếp" => TV hiện "N1-007 → Quầy 2"; giao thuốc, trả giấy tờ,
 *    quyết toán (thu thêm nếu thiếu / hoàn ứng nếu dư) ngay trên màn hình rồi "Hoàn tất".
 *  - Quản lý: thêm / tạm ngưng quầy.
 * Server là nơi quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/fhir';
import { fmtVnd } from '../lib/money';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';
import { CaseScreen } from './finance';
import { store } from './queue';

export interface Desk { deskId: string; code: string; name: string; isActive: boolean; version: number }
interface MedLine { itemId: string; brandName: string; strength: string; form: string; unit: string; usage: string; prescribed: number; dispensed: number }
export interface Handover {
  handoverId: string; patientId: string; encounterId: string; displayNo: string; priorityRank: number; needsMedication: boolean;
  status: 'preparing' | 'ready' | 'called' | 'skipped' | 'done' | 'cancelled';
  readyAt: string | null; preparedByName: string | null; prepNote: string | null;
  desk: { deskId: string; code: string; name: string } | null;
  calledCount: number; calledAt: string | null; calledBy: string | null; calledByName: string | null;
  completedAt: string | null; completedByName: string | null; checklist: { medication: boolean | null; documents: 'returned' | 'none' } | null;
  note: string | null; createdAt: string; version: number;
  patient: { mrn: string; familyName: string; givenName: string; birthDate: string | null };
  practitionerName: string | null;
  medications: MedLine[];
  finance: { caseId: string; balance: number; charges: number; received: number } | null;
}

export const HANDOVER_STATUS: Record<Handover['status'], string> = {
  preparing: 'Đang soạn thuốc',
  ready: 'Chờ gọi ra quầy',
  called: 'Đang gọi',
  skipped: 'Vắng mặt',
  done: 'Đã trả',
  cancelled: 'Đã huỷ',
};
const name = (h: Handover) => `${h.patient.familyName} ${h.patient.givenName}`;
const balanceText = (b: number) => (b === 0 ? 'Đủ' : b < 0 ? `Còn thu ${fmtVnd(-b)}` : `Dư ${fmtVnd(b)} (hoàn)`);
const medSummary = (h: Handover) => {
  if (!h.needsMedication) return 'Không có đơn';
  const short = h.medications.filter((m) => m.dispensed < m.prescribed).length;
  return `${h.medications.length} thuốc${short ? ` · ${short} chưa cấp đủ` : ''}`;
};
const Prio = ({ rank }: { rank: number }) =>
  rank > 0 ? <span className={`badge ${rank === 2 ? 'danger' : 'priority'}`}>{rank === 2 ? 'Cấp cứu' : 'Ưu tiên'}</span> : null;

/** Tải lại định kỳ (mặc định 10 giây) khi tab đang hiển thị. */
function usePoll(reload: () => void, ms = 10_000) {
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, ms);
    return () => clearInterval(id);
  }, [reload, ms]);
}

export function useHandovers(includeDone = false) {
  const { orgId } = useSession();
  return useLoad(
    () => api<{ handovers: Handover[] }>('GET', `/api/handover?organization=${orgId}${includeDone ? '&includeDone=1' : ''}`).then((r) => r.data.handovers),
    [orgId, includeDone],
  );
}

// ===========================================================================
// Tab "Quầy trả"
// ===========================================================================
export function HandoverScreen() {
  const { orgId, me, roles } = useSession();
  const desks = useLoad(() => api<{ desks: Desk[] }>('GET', `/api/handover/desks?organization=${orgId}`).then((r) => r.data.desks), [orgId]);
  const [showDone, setShowDone] = useState(false);
  const list = useHandovers(showDone);
  usePoll(list.reload);
  const storeKey = `hcos.handoverDesk.${orgId}`;
  const [deskId, setDeskId] = useState(() => store.get(storeKey) ?? '');
  const active = desks.data?.filter((d) => d.isActive) ?? [];
  useEffect(() => {
    if (desks.data && !active.some((d) => d.deskId === deskId)) setDeskId(active[0]?.deskId ?? '');
  }, [desks.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseDesk = (id: string) => {
    setDeskId(id);
    store.set(storeKey, id);
  };
  const serving = list.data?.find((h) => h.status === 'called' && h.desk?.deskId === deskId) ?? null;
  const mine = serving && serving.calledBy === me.user.userId ? serving : null;
  const readyCount = list.data?.filter((h) => h.status === 'ready').length ?? 0;
  const preparingCount = list.data?.filter((h) => h.status === 'preparing').length ?? 0;

  const call = useAction(async () => {
    const r = await api<{ handover: Handover | null }>('POST', `/api/handover/desks/${deskId}/call-next`);
    list.reload();
    if (!r.data.handover) throw new Error('Chưa có số nào chờ gọi ra quầy.');
  });

  return (
    <div className="stack">
      <Card title="Quầy của tôi" actions={<button className="link" onClick={list.reload}>Tải lại</button>}>
        <ErrorBox error={desks.error} />
        {desks.data && active.length === 0 && (
          <Notice kind="warn">Cơ sở chưa có quầy trả nào{can.handoverManage(roles) ? ' — thêm ở thẻ "Các quầy trả" bên dưới.' : '. Nhờ quản lý thêm quầy.'}</Notice>
        )}
        {active.length > 0 && (
          <div className="row wrap">
            <Field label="Tôi đang ngồi ở">
              <select value={deskId} onChange={(e) => chooseDesk(e.target.value)}>
                {active.map((d) => (
                  <option key={d.deskId} value={d.deskId}>{d.name} ({d.code})</option>
                ))}
              </select>
            </Field>
            <button onClick={() => void call.run()} disabled={call.busy || !deskId || !!serving}>
              {call.busy ? 'Đang gọi…' : 'Gọi tiếp'}
            </button>
            <span className="muted">
              Chờ gọi: <strong>{readyCount}</strong> · Đang soạn thuốc: <strong>{preparingCount}</strong>
            </span>
          </div>
        )}
        <ErrorBox error={call.error} />
        {serving && !mine && <Notice kind="warn">Quầy này đang gọi số {serving.displayNo} (do {serving.calledByName ?? 'người khác'} gọi).</Notice>}
      </Card>

      {mine && <Serving key={mine.handoverId} h={mine} onChange={list.reload} />}

      <Card
        title={`Hàng chờ quầy trả hôm nay${list.data ? ` (${list.data.filter((h) => h.status !== 'done').length})` : ''}`}
        actions={
          <label className="radio">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            <span>Hiện số đã trả</span>
          </label>
        }
      >
        <ErrorBox error={list.error} />
        {list.data && list.data.length === 0 && <p className="muted">Chưa có bệnh nhân nào khám xong hôm nay.</p>}
        {list.data && list.data.length > 0 && <HandoverTable rows={list.data} onChange={list.reload} />}
      </Card>

      {can.handoverManage(roles) && <DeskAdmin desks={desks.data ?? []} onChange={desks.reload} />}
    </div>
  );
}

function HandoverTable({ rows, onChange }: { rows: Handover[]; onChange: () => void }) {
  const act = useAction(async (h: Handover, action: 'requeue' | 'cancel') => {
    let body: unknown;
    if (action === 'cancel') {
      const note = prompt(`Lý do huỷ số ${h.displayNo} (${name(h)})? (tối thiểu 5 ký tự)`);
      if (!note) return;
      body = { note };
    }
    await api('POST', `/api/handover/${h.handoverId}/${action}`, body === undefined ? {} : { body });
    onChange();
  });
  return (
    <>
      <table>
        <thead>
          <tr><th>Số</th><th>Bệnh nhân</th><th>Trạng thái</th><th>Thuốc</th><th>Thanh toán</th><th>BS</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.handoverId} className={h.status === 'done' ? 'muted-row' : ''}>
              <td><strong>{h.displayNo}</strong> <Prio rank={h.priorityRank} /></td>
              <td>{name(h)}<div className="muted small">{h.patient.mrn}</div></td>
              <td>
                {HANDOVER_STATUS[h.status]}
                {h.status === 'called' && h.desk && <div className="muted small">{h.desk.name} · {h.calledByName}</div>}
                {h.status === 'done' && <div className="muted small">{fmtDateTime(h.completedAt ?? '')} · {h.completedByName}</div>}
                {h.prepNote && <div className="muted small">Dược: {h.prepNote}</div>}
              </td>
              <td>{medSummary(h)}</td>
              <td>{h.finance ? balanceText(h.finance.balance) : <span className="muted">—</span>}</td>
              <td>{h.practitionerName ?? '—'}</td>
              <td className="actions">
                {h.status === 'skipped' && <button className="link" disabled={act.busy} onClick={() => void act.run(h, 'requeue')}>Đưa lại hàng chờ</button>}
                {['preparing', 'ready', 'skipped'].includes(h.status) && (
                  <button className="link danger" disabled={act.busy} onClick={() => void act.run(h, 'cancel')}>Huỷ</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorBox error={act.error} />
    </>
  );
}

/** Số đang gọi tại quầy của tôi: giao thuốc, trả giấy tờ, quyết toán, hoàn tất. */
function Serving({ h, onChange }: { h: Handover; onChange: () => void }) {
  const { orgId, roles } = useSession();
  const [medsOk, setMedsOk] = useState(false);
  const [docs, setDocs] = useState<'returned' | 'none' | ''>('');
  const [note, setNote] = useState('');
  const [caseId, setCaseId] = useState<string | null>(h.finance?.caseId ?? null);
  useEffect(() => setCaseId(h.finance?.caseId ?? null), [h.finance?.caseId]);
  const balance = h.finance?.balance ?? 0;
  const financeRole = can.finance(roles);

  const op = useAction(async (action: 'recall' | 'skip' | 'release') => {
    await api('POST', `/api/handover/${h.handoverId}/${action}`);
    onChange();
  });
  const openCase = useAction(async () => {
    const r = await api<{ caseId: string }>('POST', '/api/finance/cases', { body: { organizationId: orgId, patientId: h.patientId } });
    setCaseId(r.data.caseId);
    onChange();
  });
  const done = useAction(async () => {
    await api('POST', `/api/handover/${h.handoverId}/complete`, {
      body: { checklist: { ...(h.needsMedication ? { medication: medsOk } : {}), documents: docs }, note: note.trim() || null },
    });
    onChange();
  });
  const short = h.medications.filter((m) => m.dispensed < m.prescribed);
  const ready = (!h.needsMedication || medsOk) && docs !== '' && balance === 0;

  return (
    <Card title={`Đang phục vụ tại ${h.desk?.name ?? 'quầy'}`}>
      <div className="row wrap top">
        <div className="handover-no">
          <div className="hn-no">{h.displayNo}</div>
          <Prio rank={h.priorityRank} />
          <div className="muted small">gọi {h.calledCount} lần · {fmtDateTime(h.calledAt ?? '')}</div>
        </div>
        <div className="stack small-gap">
          <div><strong>{name(h)}</strong> · {h.patient.mrn}{h.patient.birthDate ? ` · sinh ${fmtDate(h.patient.birthDate)}` : ''}</div>
          <div className="muted">BS khám: {h.practitionerName ?? '—'}</div>
          <div className="row wrap">
            <button className="secondary" disabled={op.busy} onClick={() => void op.run('recall')}>Gọi lại</button>
            <button className="secondary" disabled={op.busy} onClick={() => void op.run('skip')}>Vắng mặt</button>
            <button className="link" disabled={op.busy} onClick={() => void op.run('release')} title="Trả số về hàng chờ để quầy khác gọi">Trả về hàng chờ</button>
          </div>
          <ErrorBox error={op.error} />
        </div>
      </div>

      <h3>1. Giao thuốc</h3>
      {!h.needsMedication && <p className="muted">Đợt khám không có đơn thuốc.</p>}
      {h.needsMedication && (
        <>
          <table>
            <thead><tr><th>Thuốc</th><th>Cách dùng</th><th className="right">Kê</th><th className="right">Đã cấp</th></tr></thead>
            <tbody>
              {h.medications.map((m) => (
                <tr key={m.itemId} className={m.dispensed < m.prescribed ? 'warn-row' : ''}>
                  <td>{m.brandName} <span className="muted">({m.strength}, {m.form})</span></td>
                  <td>{m.usage}</td>
                  <td className="right">{m.prescribed} {m.unit}</td>
                  <td className="right">{m.dispensed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {short.length > 0 && (
            <Notice kind="warn">
              Còn {short.length} thuốc chưa cấp đủ{h.prepNote ? ` — dược ghi: "${h.prepNote}"` : ''}. Báo bệnh nhân mua thêm / quay lại lấy.
            </Notice>
          )}
          <label className="radio">
            <input type="checkbox" checked={medsOk} onChange={(e) => setMedsOk(e.target.checked)} />
            <span>Đã giao thuốc và dặn cách dùng</span>
          </label>
        </>
      )}

      <h3>2. Trả giấy tờ</h3>
      <div className="row wrap">
        <label className="radio">
          <input type="radio" name={`docs-${h.handoverId}`} checked={docs === 'returned'} onChange={() => setDocs('returned')} />
          <span>Đã trả giấy tờ (CCCD / thẻ BHYT / sổ khám / kết quả)</span>
        </label>
        <label className="radio">
          <input type="radio" name={`docs-${h.handoverId}`} checked={docs === 'none'} onChange={() => setDocs('none')} />
          <span>Không giữ giấy tờ nào</span>
        </label>
      </div>

      <h3>3. Quyết toán</h3>
      {!caseId && <p className="muted">Không có hồ sơ thanh toán đang mở (không tạm ứng, chưa ghi chi phí).</p>}
      {!caseId && financeRole && (
        <button className="secondary" disabled={openCase.busy} onClick={() => void openCase.run()}>Mở hồ sơ thanh toán để ghi chi phí</button>
      )}
      <ErrorBox error={openCase.error} />
      {caseId && h.finance && (
        <Notice kind={balance === 0 ? 'ok' : 'warn'}>
          {balance === 0 ? 'Số dư bằng 0 — đã quyết toán xong.' : balance < 0 ? `Còn phải thu ${fmtVnd(-balance)}: lập phiếu thu bên dưới.` : `Còn dư ${fmtVnd(balance)}: lập phiếu chi hoàn ứng bên dưới.`}
        </Notice>
      )}
      {caseId && financeRole && <CaseScreen id={caseId} embedded onChange={onChange} />}
      {caseId && !financeRole && <Notice kind="warn">Bạn không có quyền thu ngân: nhờ thu ngân lập phiếu ({balanceText(balance)}).</Notice>}

      <h3>4. Hoàn tất</h3>
      <div className="row wrap">
        <Field label="Ghi chú (tuỳ chọn)">
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="vd. đã hẹn tái khám 5 ngày" />
        </Field>
        <button disabled={done.busy || !ready} onClick={() => void done.run()}>{done.busy ? 'Đang lưu…' : `Hoàn tất ${h.displayNo}`}</button>
      </div>
      {!ready && (
        <p className="muted small">
          Cần: {[h.needsMedication && !medsOk && 'xác nhận đã giao thuốc', docs === '' && 'chọn tình trạng giấy tờ', balance !== 0 && 'số dư thanh toán bằng 0'].filter(Boolean).join(', ')}.
        </p>
      )}
      <ErrorBox error={done.error} />
    </Card>
  );
}

function DeskAdmin({ desks, onChange }: { desks: Desk[]; onChange: () => void }) {
  const { orgId } = useSession();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const add = useAction(async () => {
    await api('POST', '/api/handover/desks', { body: { organizationId: orgId, code: code.trim().toUpperCase(), name: label.trim() } });
    setCode('');
    setLabel('');
    onChange();
  });
  const toggle = useAction(async (d: Desk) => {
    await api('POST', `/api/handover/desks/${d.deskId}/active`, { body: { isActive: !d.isActive }, headers: { 'if-match': `W/"${d.version}"` } });
    onChange();
  });
  return (
    <Card title="Các quầy trả">
      {desks.length > 0 && (
        <table>
          <thead><tr><th>Mã</th><th>Tên hiển thị trên TV</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {desks.map((d) => (
              <tr key={d.deskId} className={d.isActive ? '' : 'muted-row'}>
                <td>{d.code}</td>
                <td>{d.name}</td>
                <td>{d.isActive ? 'Đang mở' : 'Tạm ngưng'}</td>
                <td className="actions">
                  <button className="link" disabled={toggle.busy} onClick={() => void toggle.run(d)}>{d.isActive ? 'Tạm ngưng' : 'Mở lại'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
        <Field label="Mã quầy" hint="1–6 ký tự A–Z / 0–9, vd. Q3">
          <input className="short" required value={code} maxLength={6} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Tên trên TV">
          <input required value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} placeholder="vd. Quầy 3" />
        </Field>
        <button type="submit" className="secondary" disabled={add.busy}>Thêm quầy</button>
      </form>
      <ErrorBox error={add.error ?? toggle.error} />
    </Card>
  );
}

// ===========================================================================
// Tab Dược: soạn thuốc cho quầy trả
// ===========================================================================
export function PrepareCard({ refreshKey }: { refreshKey: number }) {
  const list = useHandovers(false);
  usePoll(list.reload, 15_000);
  useEffect(() => {
    if (refreshKey > 0) list.reload();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (list.data ?? []).filter((h) => h.status === 'preparing');
  const prepared = useAction(async (h: Handover) => {
    const short = h.medications.filter((m) => m.dispensed < m.prescribed);
    let note: string | null = null;
    if (short.length > 0) {
      note = prompt(`Còn ${short.map((m) => `${m.brandName} (${m.dispensed}/${m.prescribed})`).join(', ')} chưa cấp đủ.\nLý do vẫn chuyển ra quầy (vd. hết thuốc)?`);
      if (!note) return;
    }
    await api('POST', `/api/handover/${h.handoverId}/prepared`, { body: { note } });
    list.reload();
  });
  const denied = list.error instanceof ApiError && list.error.status === 403;
  if (denied) return null;
  return (
    <Card title={`Soạn thuốc cho quầy trả${list.data ? ` (${rows.length})` : ''}`} actions={<button className="link" onClick={list.reload}>Tải lại</button>}>
      <ErrorBox error={list.error} />
      {list.data && rows.length === 0 && <p className="muted">Không có bệnh nhân nào đang chờ soạn thuốc.</p>}
      {rows.length > 0 && (
        <p className="muted small">Cấp thuốc ở thẻ "Đơn chờ cấp" bên dưới, rồi bấm "Soạn xong" để chuyển số ra quầy trả.</p>
      )}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>Số</th><th>Bệnh nhân</th><th>Thuốc (đã cấp / kê)</th><th>Khám xong lúc</th><th /></tr></thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.handoverId}>
                <td><strong>{h.displayNo}</strong> <Prio rank={h.priorityRank} /></td>
                <td>{name(h)}<div className="muted small">{h.patient.mrn}</div></td>
                <td>
                  {h.medications.map((m) => (
                    <div key={m.itemId} className={m.dispensed < m.prescribed ? 'warn-text' : ''}>
                      {m.brandName}: {m.dispensed}/{m.prescribed} {m.unit}
                    </div>
                  ))}
                </td>
                <td>{fmtDateTime(h.createdAt)}</td>
                <td className="actions">
                  <button disabled={prepared.busy} onClick={() => void prepared.run(h)}>Soạn xong</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorBox error={prepared.error} />
    </Card>
  );
}
