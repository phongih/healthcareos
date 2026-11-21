/**
 * Dự báo kinh doanh (HCOS-F10) — quản lý / ban giám đốc (kho dược: chỉ phần tồn kho).
 * Mọi con số là ước tính thống kê đơn giản, giải thích được: màn hình luôn ghi nguồn tham số (dữ liệu / mặc định)
 * và cảnh báo khi lịch sử còn ít.
 */
import { useEffect, useMemo, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtVnd } from '../lib/money';
import { dmy } from '../../../../packages/exports/src/report-sheets';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';
import { NO_CHANGE, simulate, type WhatIfLevers } from '../lib/whatif';
import { MoneyInput } from './finance';

type Period = 'morning' | 'afternoon';
type Status = 'ok' | 'busy' | 'overload' | 'unknown';
interface Cell { servicePointId: string | null; walkIn: number; bookedRaw: number; booked: number; followUp: number; total: number; capacity: number | null; utilization: number | null; status: Status }
interface Room { servicePointId: string; code: string; name: string; visitCapacity: number | null; version: number }
interface Load {
  from: string; to: string; rooms: Room[];
  days: Array<{ date: string; weekday: number; periods: Record<Period, Cell[]>; total: number; worst: Status }>;
  alerts: Array<{ date: string; period: Period; code: string; total: number; capacity: number; utilization: number; status: 'busy' | 'overload' }>;
  weekdayIndex: number[];
  params: { historyDays: number; sufficient: boolean; showRate: number; showRateSource: string; showRateSample: number; returnRate: number; returnRateSource: string; returnRateSample: number; morningShare: number; avgDailyVisits: number };
  totals: { walkIn: number; booked: number; followUp: number; total: number };
}
interface InvLine {
  medicationId: string; name: string; unit: string; available: number; avgDaily: number; trendFactor: number; trendCodes: Array<{ code: string; ratio: number }>;
  adjustedDaily: number; safetyStock: number; reorderPoint: number; targetLevel: number; suggestedOrder: number; estimatedOrderValue: number | null;
  daysOfCover: number | null; earliestExpiry: string | null; expiryRiskQty: number; status: 'stockout' | 'urgent' | 'reorder' | 'ok' | 'no_demand';
}
interface Inventory {
  asOf: string; params: { windowDays: number; sufficient: boolean; leadTimeDays: number; serviceLevelPct: number; z: number; reviewDays: number };
  lines: InvLine[]; risingCodes: Array<{ code: string; display: string | null; last7: number; prior21: number; ratio: number }>;
}
interface CashBase {
  visits: number; walkIn: number; followUp: number; booked: number; showRate: number; revenuePerVisit: number | null; revenueSample: number;
  examShare: number; avgExamPrice: number | null; actualVisitsLast30: number; actualRevenueLast30: number; fixedCostsMonthly: number; variableCostPct: number;
}
interface Settings {
  fixedCostsMonthly: number; variableCostPct: number; leadTimeDays: number; serviceLevelPct: number; version: number;
  history: Array<{ version: number; fixedCostsMonthly: number; variableCostPct: number; leadTimeDays: number; serviceLevelPct: number; changedByName: string | null; changedAt: string }>;
}

const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const PERIOD: Record<Period, string> = { morning: 'Sáng', afternoon: 'Chiều' };
const STATUS_TEXT: Record<Status, string> = { ok: 'Bình thường', busy: 'Sắp đầy', overload: 'Quá tải', unknown: 'Chưa khai báo sức khám' };
const INV_STATUS: Record<InvLine['status'], string> = { stockout: 'Hết hàng', urgent: 'Khẩn — dưới thời gian chờ hàng', reorder: 'Cần đặt hàng', ok: 'Đủ', no_demand: 'Chưa có tiêu thụ' };
const src = (s: string) => (s === 'data' ? 'từ dữ liệu' : 'mặc định — chưa đủ dữ liệu');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

export function ForecastScreen() {
  const { roles } = useSession();
  const mgmt = ['clinic_admin', 'executive', 'tenant_admin'].some((r) => roles.has(r as never));
  const canManage = roles.has('clinic_admin') || roles.has('tenant_admin');
  return (
    <div className="stack">
      <Notice>
        Dự báo bằng thống kê đơn giản từ lịch sử khám, lịch hẹn, đơn thuốc, sổ kho và thu ngân — không dùng AI. Dùng để chuẩn bị nhân sự, nhập hàng và
        kế hoạch tài chính; luôn đối chiếu với thực tế.
      </Notice>
      {mgmt && <LoadCard />}
      <InventoryCard />
      {mgmt && <CashflowCard />}
      {canManage && <ForecastSettingsCard />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tải phòng khám
// ---------------------------------------------------------------------------
function LoadCard() {
  const { orgId } = useSession();
  const [days, setDays] = useState(14);
  const l = useLoad(() => api<Load>('GET', `/api/forecast/load?organization=${orgId}&days=${days}`).then((r) => r.data), [orgId, days]);
  if (forbidden(l.error)) return null;
  const d = l.data;
  return (
    <Card title="Dự báo lượt khám & tải phòng khám" actions={
      <span className="row">
        {[7, 14, 30].map((n) => <button key={n} className={days === n ? 'choice on' : 'choice'} onClick={() => setDays(n)}>{n} ngày</button>)}
      </span>
    }>
      <ErrorBox error={l.error} />
      {d && (
        <>
          {!d.params.sufficient && <Notice kind="warn">Mới có {d.params.historyDays} ngày lịch sử khám — dự báo còn thô; cần ít nhất 14 ngày (tốt nhất 8 tuần).</Notice>}
          <p className="muted small">
            {dmy(d.from)} → {dmy(d.to)} · lịch sử {d.params.historyDays} ngày (TB {d.params.avgDailyVisits} lượt/ngày) · tỷ lệ đến của lịch hẹn {pct(d.params.showRate)} ({src(d.params.showRateSource)})
            · tỷ lệ quay lại tái khám {pct(d.params.returnRate)} ({src(d.params.returnRateSource)}) · buổi sáng chiếm {pct(d.params.morningShare)}
          </p>
          <div className="totals">
            <div><span>Tổng lượt dự kiến</span><strong>{d.totals.total.toFixed(1)}</strong></div>
            <div><span>Vãng lai</span><strong>{d.totals.walkIn.toFixed(1)}</strong></div>
            <div><span>Đặt lịch</span><strong>{d.totals.booked.toFixed(1)}</strong></div>
            <div><span>Tái khám dự kiến</span><strong>{d.totals.followUp.toFixed(1)}</strong></div>
          </div>
          <h3>Hệ số theo thứ</h3>
          <div className="wdbars">
            {d.weekdayIndex.map((x, i) => (
              <div key={i} title={`${WD[i]}: ×${x}`}><span style={{ height: `${Math.min(100, x * 40)}%` }} /><small>{WD[i]}</small><small>×{x}</small></div>
            ))}
          </div>
          {d.alerts.length > 0 ? (
            <Notice kind="warn">
              <strong>{d.alerts.length} buổi sắp đầy / quá tải:</strong>{' '}
              {d.alerts.slice(0, 8).map((a) => `${WD[new Date(`${a.date}T00:00:00Z`).getUTCDay()]} ${dmy(a.date).slice(0, 5)} ${PERIOD[a.period].toLowerCase()} ${a.code} ${a.total}/${a.capacity}`).join(' · ')}
              {d.alerts.length > 8 ? ' …' : ''} — cân nhắc thêm bác sĩ hoặc giảm số chỗ đặt online buổi đó.
            </Notice>
          ) : d.rooms.some((r) => r.visitCapacity) ? (
            <Notice kind="ok">Không có buổi nào sắp đầy trong kỳ.</Notice>
          ) : (
            <Notice>Chưa phòng nào khai báo sức khám mỗi buổi — khai báo ở phần Thông số dự báo để nhận cảnh báo quá tải.</Notice>
          )}
          <div className="scroll-x">
            <table className="heat">
              <thead>
                <tr><th rowSpan={2}>Ngày</th>{d.rooms.map((r) => <th key={r.servicePointId} colSpan={2}>{r.code}{r.visitCapacity ? ` (≤${r.visitCapacity})` : ''}</th>)}<th rowSpan={2}>Tổng</th></tr>
                <tr>{d.rooms.map((r) => (['morning', 'afternoon'] as Period[]).map((p) => <th key={r.servicePointId + p}>{PERIOD[p]}</th>))}</tr>
              </thead>
              <tbody>
                {d.days.map((day) => (
                  <tr key={day.date}>
                    <td>{WD[day.weekday]} {dmy(day.date).slice(0, 5)}</td>
                    {d.rooms.map((r) => (['morning', 'afternoon'] as Period[]).map((p) => {
                      const c = day.periods[p].find((x) => x.servicePointId === r.servicePointId);
                      if (!c) return <td key={r.servicePointId + p} />;
                      return (
                        <td key={r.servicePointId + p} className={`h-${c.status}`}
                          title={`${STATUS_TEXT[c.status]} · vãng lai ${c.walkIn} + đặt lịch ${c.booked} (đã đặt ${c.bookedRaw}) + tái khám ${c.followUp}${c.capacity ? ` / sức khám ${c.capacity}` : ''}`}>
                          {c.total.toFixed(1)}{c.utilization !== null ? <small> {pct(c.utilization)}</small> : null}
                        </td>
                      );
                    }))}
                    <td><strong>{day.total.toFixed(1)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Ô: số lượt dự kiến (và % sức khám). Rê chuột để xem cấu phần. Màu: xanh bình thường · vàng ≥ 85% · đỏ quá tải · xám chưa khai báo sức khám.</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tồn kho
// ---------------------------------------------------------------------------
function InventoryCard() {
  const { orgId } = useSession();
  const inv = useLoad(() => api<Inventory>('GET', `/api/forecast/inventory?organization=${orgId}`).then((r) => r.data), [orgId]);
  const [all, setAll] = useState(false);
  if (forbidden(inv.error)) return null;
  const d = inv.data;
  const lines = d ? (all ? d.lines : d.lines.filter((x) => x.status !== 'ok' && x.status !== 'no_demand' || x.expiryRiskQty > 0)) : [];
  const orderValue = d ? d.lines.reduce((a, x) => a + (x.estimatedOrderValue ?? 0), 0) : 0;
  return (
    <Card title="Dự báo tồn kho thuốc & điểm đặt hàng lại" actions={<label className="radio"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Hiện tất cả</label>}>
      <ErrorBox error={inv.error} />
      {d && (
        <>
          {!d.params.sufficient && <Notice kind="warn">Sổ kho mới có dưới 14 ngày — tốc độ tiêu thụ còn thô.</Notice>}
          <p className="muted small">
            Tiêu thụ trung bình {d.params.windowDays} ngày gần nhất (sổ cái cấp phát) × hệ số xu hướng chẩn đoán · thời gian chờ hàng {d.params.leadTimeDays} ngày ·
            mức phục vụ {d.params.serviceLevelPct}% (z = {d.params.z}) · đặt đủ dùng thêm {d.params.reviewDays} ngày.
          </p>
          {d.risingCodes.length > 0 && (
            <p>
              <strong>Chẩn đoán đang tăng (7 ngày so với TB tuần của 21 ngày trước):</strong>{' '}
              {d.risingCodes.map((c) => <span key={c.code} className="badge match-weak" title={c.display ?? ''}>{c.code} ×{c.ratio} ({c.last7} ca)</span>)}
            </p>
          )}
          {orderValue > 0 && <p>Giá trị đặt hàng gợi ý ước tính (theo giá nhập lô gần nhất): <strong>{fmtVnd(orderValue)}</strong></p>}
          {lines.length === 0 ? (
            <Notice kind="ok">Không có thuốc nào cần đặt hàng hay có nguy cơ hết hạn.</Notice>
          ) : (
            <div className="scroll-x">
              <table>
                <thead><tr><th>Thuốc</th><th>Tồn dùng được</th><th>TB/ngày</th><th>Xu hướng</th><th>Đủ dùng</th><th>Điểm đặt lại</th><th>Đặt gợi ý</th><th>Hạn sớm nhất</th><th>Có thể hết hạn</th><th>Trạng thái</th></tr></thead>
                <tbody>
                  {lines.map((x) => (
                    <tr key={x.medicationId}>
                      <td>{x.name}</td>
                      <td>{x.available} {x.unit}</td>
                      <td>{x.avgDaily}{x.trendFactor !== 1 ? <small className="muted"> → {x.adjustedDaily}</small> : null}</td>
                      <td title={x.trendCodes.map((c) => `${c.code} ×${c.ratio}`).join(', ')}>{x.trendFactor === 1 ? '—' : `×${x.trendFactor}`}</td>
                      <td>{x.daysOfCover === null ? '—' : `${x.daysOfCover} ngày`}</td>
                      <td>{x.status === 'no_demand' ? '—' : x.reorderPoint}</td>
                      <td>{x.suggestedOrder ? <strong>{x.suggestedOrder}</strong> : '—'}{x.estimatedOrderValue ? <div className="muted small">{fmtVnd(x.estimatedOrderValue)}</div> : null}</td>
                      <td>{x.earliestExpiry ? dmy(x.earliestExpiry) : '—'}</td>
                      <td className={x.expiryRiskQty ? 'pos' : ''}>{x.expiryRiskQty || '—'}</td>
                      <td><span className={`badge inv-${x.status}`}>{INV_STATUS[x.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dòng tiền & What-If
// ---------------------------------------------------------------------------
function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string }) {
  return (
    <label className="slider">
      <span>{label}: <strong>{fmt(value)}</strong></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    </label>
  );
}

function CashflowCard() {
  const { orgId } = useSession();
  const b = useLoad(() => api<CashBase>('GET', `/api/forecast/cashflow?organization=${orgId}`).then((r) => r.data), [orgId]);
  const [lv, setLv] = useState<WhatIfLevers>(NO_CHANGE);
  const [rpvManual, setRpvManual] = useState<number | null>(null);
  if (forbidden(b.error)) return null;
  const d = b.data;
  const rpv = d?.revenuePerVisit ?? rpvManual;
  const base = d && rpv !== null && rpv !== undefined
    ? { walkIn: d.walkIn, followUp: d.followUp, booked: d.booked, showRate: d.showRate, revenuePerVisit: rpv, examShare: d.examShare || (d.revenuePerVisit === null ? 1 : 0), fixedCostsMonthly: d.fixedCostsMonthly, variableCostPct: d.variableCostPct }
    : null;
  const r0 = base ? simulate(base, NO_CHANGE) : null;
  const r1 = base ? simulate(base, lv) : null;
  const delta = (a: number, z: number) => (a === z ? '' : ` (${a > z ? '+' : '−'}${fmtVnd(Math.abs(a - z))})`);
  return (
    <Card title="Dự báo dòng tiền 30 ngày & mô phỏng kịch bản">
      <ErrorBox error={b.error} />
      {d && (
        <>
          <p className="muted small">
            30 ngày qua: {d.actualVisitsLast30} lượt khám, doanh thu dịch vụ {fmtVnd(d.actualRevenueLast30)} ({d.revenueSample} hồ sơ có chi phí).
            Dự báo 30 ngày tới: {d.visits.toFixed(0)} lượt.
          </p>
          {d.revenuePerVisit === null && (
            <Notice kind="warn">
              Chưa có dữ liệu thu ngân để tính doanh thu trung bình mỗi lượt. Nhập tạm để mô phỏng:
              <MoneyInput label="Doanh thu TB / lượt (đ)" value={rpvManual} onChange={setRpvManual} />
            </Notice>
          )}
          {!d.fixedCostsMonthly && <Notice>Chưa nhập chi phí cố định / tháng — điểm hòa vốn sẽ bằng 0. Quản lý nhập ở phần Thông số dự báo.</Notice>}
          {base && r0 && r1 && (
            <div className="whatif">
              <div className="stack">
                <Slider label="Lịch đặt online" value={lv.bookingPct} min={-50} max={100} step={5} onChange={(bookingPct) => setLv({ ...lv, bookingPct })} fmt={(v) => `${v > 0 ? '+' : ''}${v}%`} />
                <Slider label="Phí khám" value={lv.examFeeDelta} min={-100_000} max={200_000} step={5_000} onChange={(examFeeDelta) => setLv({ ...lv, examFeeDelta })} fmt={(v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtVnd(Math.abs(v))}`} />
                <Slider label="Giảm tỷ lệ huỷ / vắng lịch hẹn" value={lv.cancelReductionPct} min={0} max={100} step={5} onChange={(cancelReductionPct) => setLv({ ...lv, cancelReductionPct })} fmt={(v) => `${v}%`} />
                <button className="link" onClick={() => setLv(NO_CHANGE)}>Đặt lại</button>
                <p className="muted small">
                  Giả định: khách đặt online thêm là khách mới; đổi phí khám không làm đổi lượng khách (áp cho {pct(base.examShare)} hồ sơ có phí khám
                  {d.avgExamPrice ? `, giá khám TB ${fmtVnd(d.avgExamPrice)}` : ''}); chi phí biến đổi {d.variableCostPct}% doanh thu; 30 ngày ≈ 1 tháng chi phí cố định.
                </p>
              </div>
              <table className="compact">
                <thead><tr><th /><th>Hiện tại</th><th>Kịch bản</th></tr></thead>
                <tbody>
                  <tr><td>Lượt khám</td><td>{r0.visits.toFixed(0)}</td><td><strong>{r1.visits.toFixed(0)}</strong></td></tr>
                  <tr><td>Doanh thu / lượt</td><td>{fmtVnd(r0.revenuePerVisit)}</td><td>{fmtVnd(r1.revenuePerVisit)}</td></tr>
                  <tr><td>Doanh thu dự kiến</td><td>{fmtVnd(r0.revenue)}</td><td><strong>{fmtVnd(r1.revenue)}</strong><small className="muted">{delta(r1.revenue, r0.revenue)}</small></td></tr>
                  <tr><td>Chi phí biến đổi</td><td>{fmtVnd(r0.variableCost)}</td><td>{fmtVnd(r1.variableCost)}</td></tr>
                  <tr><td>Chi phí cố định</td><td colSpan={2}>{fmtVnd(d.fixedCostsMonthly)}</td></tr>
                  <tr><td>Lợi nhuận dự kiến</td><td className={r0.profit < 0 ? 'neg' : ''}>{fmtVnd(r0.profit)}</td><td className={r1.profit < 0 ? 'neg' : ''}><strong>{fmtVnd(r1.profit)}</strong></td></tr>
                  <tr><td>Doanh thu hòa vốn</td><td colSpan={2}>{fmtVnd(r1.breakEvenRevenue)}</td></tr>
                  <tr><td>Lượt khám hòa vốn</td><td>{r0.breakEvenVisits ?? '—'}</td><td><strong>{r1.breakEvenVisits ?? '—'}</strong></td></tr>
                  <tr><td>Biên an toàn</td><td>{r0.safetyMargin === null ? '—' : pct(r0.safetyMargin)}</td><td className={(r1.safetyMargin ?? 0) < 0 ? 'neg' : ''}>{r1.safetyMargin === null ? '—' : pct(r1.safetyMargin)}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Thông số (quản lý)
// ---------------------------------------------------------------------------
function ForecastSettingsCard() {
  const { orgId } = useSession();
  const s = useLoad(() => api<Settings>('GET', `/api/forecast/settings?organization=${orgId}`).then((r) => r.data), [orgId]);
  const load = useLoad(() => api<Load>('GET', `/api/forecast/load?organization=${orgId}&days=7`).then((r) => r.data.rooms), [orgId]);
  const [f, setF] = useState({ fixed: null as number | null, varPct: '', lead: '', level: '95' });
  useEffect(() => {
    if (s.data) setF({ fixed: s.data.fixedCostsMonthly, varPct: String(s.data.variableCostPct), lead: String(s.data.leadTimeDays), level: String(s.data.serviceLevelPct) });
  }, [s.data]);
  const save = useAction(async () => {
    await api('POST', '/api/forecast/settings', {
      headers: { 'if-match': `W/"${s.data!.version}"` },
      body: { organizationId: orgId, fixedCostsMonthly: f.fixed ?? 0, variableCostPct: Number(f.varPct.replace(',', '.')), leadTimeDays: Number(f.lead), serviceLevelPct: Number(f.level) },
    });
    s.reload();
  });
  const [cap, setCap] = useState<Record<string, string>>({});
  const saveCap = useAction(async (r: Room) => {
    const raw = (cap[r.servicePointId] ?? '').trim();
    await api('POST', `/api/forecast/capacity/${r.servicePointId}`, { headers: { 'if-match': `W/"${r.version}"` }, body: { visitCapacity: raw === '' ? null : Number(raw) } });
    setCap((c) => { const n = { ...c }; delete n[r.servicePointId]; return n; });
    load.reload();
  });
  const changed = useMemo(() => s.data && (f.fixed !== s.data.fixedCostsMonthly || f.varPct !== String(s.data.variableCostPct) || f.lead !== String(s.data.leadTimeDays) || f.level !== String(s.data.serviceLevelPct)), [f, s.data]);
  return (
    <Card title="Thông số dự báo">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <fieldset className="plain" disabled={!s.data}>
          <div className="row wrap">
            <MoneyInput label="Chi phí cố định / tháng (đ)" value={f.fixed} onChange={(fixed) => setF({ ...f, fixed })} hint="Lương, mặt bằng, khấu hao, điện nước…" />
            <Field label="Chi phí biến đổi (% doanh thu)" hint="Thuốc, vật tư, hoa hồng…">
              <input className="short" inputMode="decimal" value={f.varPct} onChange={(e) => setF({ ...f, varPct: e.target.value })} />
            </Field>
            <Field label="Thời gian chờ hàng (ngày)">
              <input className="short" type="number" min={1} max={90} value={f.lead} onChange={(e) => setF({ ...f, lead: e.target.value })} />
            </Field>
            <Field label="Mức phục vụ (không đứt hàng)">
              <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>
                {['90', '95', '97.5', '99'].map((x) => <option key={x} value={x}>{x}%</option>)}
              </select>
            </Field>
            <button type="submit" disabled={save.busy || !changed}>Lưu thông số</button>
          </div>
        </fieldset>
      </form>
      <ErrorBox error={save.error ?? s.error} />
      {s.data && s.data.history.length > 0 && (
        <details>
          <summary>Lịch sử thay đổi ({s.data.history.length})</summary>
          <table className="compact">
            <thead><tr><th>Bản</th><th>Lúc</th><th>Người sửa</th><th>Cố định / tháng</th><th>Biến đổi</th><th>Chờ hàng</th><th>Mức phục vụ</th></tr></thead>
            <tbody>
              {s.data.history.map((h) => (
                <tr key={h.version}><td>{h.version}</td><td>{new Date(h.changedAt).toLocaleString('vi-VN')}</td><td>{h.changedByName}</td><td>{fmtVnd(h.fixedCostsMonthly)}</td><td>{h.variableCostPct}%</td><td>{h.leadTimeDays} ngày</td><td>{h.serviceLevelPct}%</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <h3>Sức khám tối đa mỗi buổi (để cảnh báo quá tải)</h3>
      {load.data?.map((r) => (
        <form key={r.servicePointId} className="row wrap" onSubmit={(e) => { e.preventDefault(); void saveCap.run(r); }}>
          <span className="cap-name"><strong>{r.code}</strong> · {r.name}</span>
          <input className="short" type="number" min={1} max={500} aria-label={`Sức khám ${r.code}`} placeholder="—"
            value={cap[r.servicePointId] ?? (r.visitCapacity === null ? '' : String(r.visitCapacity))}
            onChange={(e) => setCap({ ...cap, [r.servicePointId]: e.target.value })} />
          <span className="muted small">lượt / buổi</span>
          <button type="submit" className="secondary" disabled={saveCap.busy || cap[r.servicePointId] === undefined}>Lưu</button>
        </form>
      ))}
      <ErrorBox error={saveCap.error ?? load.error} />
    </Card>
  );
}

