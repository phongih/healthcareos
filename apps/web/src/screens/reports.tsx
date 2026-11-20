/**
 * Báo cáo tài chính (HCOS-F9) — quản lý / ban giám đốc.
 * Hai cách nhìn tách rõ: THỰC THU (tiền vào/ra két theo phiếu hợp lệ) và DOANH THU DỊCH VỤ (chi phí đã ghi).
 * Tạm ứng là tiền giữ hộ người bệnh, chưa phải doanh thu. Xuất Excel 6 sheet (tạo ngay trong trình duyệt).
 */
import { useMemo, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { downloadXlsx } from '../lib/download';
import { fmtVnd } from '../lib/money';
import { CATEGORY_LABEL, dmy, reportSheets, vnTime, type ReportData } from '../lib/report-sheets';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useLoad } from '../lib/ui';
import { buildXlsx } from '../lib/xlsx';

const KIND: Record<string, string> = { deposit: 'Tạm ứng', payment: 'Thanh toán', refund: 'Hoàn ứng' };
const METHOD: Record<string, string> = { cash: 'Tiền mặt', bank_transfer: 'Chuyển khoản', card: 'Thẻ (POS)' };

const vnToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const shift = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
function presets(today: string): Array<{ label: string; from: string; to: string }> {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const firstThis = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastPrev = shift(firstThis, -1);
  const firstPrev = `${lastPrev.slice(0, 7)}-01`;
  return [
    { label: 'Hôm nay', from: today, to: today },
    { label: 'Hôm qua', from: shift(today, -1), to: shift(today, -1) },
    { label: '7 ngày', from: shift(today, -6), to: today },
    { label: 'Tháng này', from: firstThis, to: today },
    { label: 'Tháng trước', from: firstPrev, to: lastPrev },
  ];
}

function Tile({ label, value, tone, hint }: { label: string; value: number; tone?: 'pos' | 'neg' | 'zero'; hint?: string }) {
  return (
    <div className={tone ?? ''} title={hint}>
      <span>{label}</span>
      <strong>{fmtVnd(value)}</strong>
    </div>
  );
}

/** Cột thực thu ròng theo ngày (SVG, không thư viện). */
function DailyBars({ days }: { days: ReportData['cashflow']['days'] }) {
  if (days.length < 2) return null;
  const max = Math.max(1, ...days.map((d) => Math.abs(d.net)));
  const w = 640;
  const h = 140;
  const bw = Math.max(4, Math.min(36, (w - 20) / days.length - 4));
  return (
    <svg className="bars" viewBox={`0 0 ${w} ${h + 22}`} role="img" aria-label="Thực thu ròng theo ngày">
      <line x1="0" x2={w} y1={h} y2={h} stroke="currentColor" strokeOpacity="0.3" />
      {days.map((d, i) => {
        const bh = (Math.abs(d.net) / max) * (h - 10);
        const x = 10 + i * ((w - 20) / days.length);
        return (
          <g key={d.date}>
            <rect x={x} y={h - bh} width={bw} height={bh} className={d.net < 0 ? 'bar neg' : 'bar'}>
              <title>{`${dmy(d.date)}: ${fmtVnd(d.net)}`}</title>
            </rect>
            {(days.length <= 10 || i % Math.ceil(days.length / 10) === 0) && (
              <text x={x + bw / 2} y={h + 15} textAnchor="middle" fontSize="11">{dmy(d.date).slice(0, 5)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function ReportsScreen() {
  const { orgId, me } = useSession();
  const orgName = me.memberships.find((m) => m.organization.organizationId === orgId)?.organization.name ?? '';
  const today = vnToday();
  const [range, setRange] = useState({ from: today, to: today });
  const [draft, setDraft] = useState(range);
  const r = useLoad(
    () => api<ReportData>('GET', `/api/finance/reports?organization=${orgId}&from=${range.from}&to=${range.to}`).then((x) => x.data),
    [orgId, range.from, range.to],
  );
  const ps = useMemo(() => presets(today), [today]);
  const denied = r.error instanceof ApiError && r.error.status === 403;
  const exportXlsx = () => {
    if (!r.data) return;
    downloadXlsx(`bao-cao-tai-chinh_${r.data.from}_${r.data.to}.xlsx`, buildXlsx(reportSheets(r.data, orgName)));
  };
  if (denied) return <Notice kind="warn">Báo cáo tài chính chỉ dành cho quản lý phòng khám / ban giám đốc.</Notice>;
  const d = r.data;
  const t = d?.cashflow.totals;

  return (
    <div className="stack">
      <Card title="Báo cáo tài chính" actions={<button className="secondary" onClick={exportXlsx} disabled={!d}>Xuất Excel</button>}>
        <div className="row wrap">
          {ps.map((p) => (
            <button key={p.label} className={range.from === p.from && range.to === p.to ? 'choice on' : 'choice'} onClick={() => { setRange(p); setDraft(p); }}>
              {p.label}
            </button>
          ))}
        </div>
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); setRange(draft); }}>
          <Field label="Từ ngày"><input type="date" value={draft.from} max={today} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
          <Field label="Đến ngày"><input type="date" value={draft.to} max={today} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
          <button type="submit">Xem</button>
          <span className="muted small">Tối đa 92 ngày · theo giờ Việt Nam</span>
        </form>
        <ErrorBox error={r.error} />
        {r.loading && !d && <p className="muted">Đang tải…</p>}
        {d && t && (
          <>
            <p className="muted small">
              {d.from === d.to ? `Ngày ${dmy(d.from)}` : `Từ ${dmy(d.from)} đến ${dmy(d.to)}`} · lập lúc {vnTime(d.generatedAt)}
            </p>
            <h3>Thực thu (tiền vào / ra két)</h3>
            <div className="totals">
              <Tile label="Thực thu ròng" value={t.net} tone={t.net < 0 ? 'neg' : 'zero'} hint="Tạm ứng + thanh toán − hoàn ứng" />
              <Tile label="Thu tạm ứng" value={t.deposit} hint="Tiền giữ hộ, chưa phải doanh thu" />
              <Tile label="Thu thanh toán" value={t.payment} />
              <Tile label="Chi hoàn ứng" value={t.refund} />
            </div>
            <table className="compact">
              <thead><tr><th>Hình thức</th><th>Thu</th><th>Chi</th><th>Ròng</th></tr></thead>
              <tbody>
                {(['cash', 'bank_transfer', 'card'] as const).map((m) => (
                  <tr key={m}><td>{METHOD[m]}</td><td>{fmtVnd(t.byMethod[m].in)}</td><td>{fmtVnd(t.byMethod[m].out)}</td><td><strong>{fmtVnd(t.byMethod[m].in - t.byMethod[m].out)}</strong></td></tr>
                ))}
              </tbody>
            </table>
            <DailyBars days={d.cashflow.days} />
            {d.cashflow.days.length > 1 && (
              <details>
                <summary>Theo ngày ({d.cashflow.days.length} ngày có phát sinh)</summary>
                <table>
                  <thead><tr><th>Ngày</th><th>Tạm ứng</th><th>Thanh toán</th><th>Hoàn ứng</th><th>Ròng</th><th>Số phiếu</th></tr></thead>
                  <tbody>
                    {d.cashflow.days.map((x) => (
                      <tr key={x.date}><td>{dmy(x.date)}</td><td>{fmtVnd(x.deposit)}</td><td>{fmtVnd(x.payment)}</td><td>{fmtVnd(x.refund)}</td><td><strong>{fmtVnd(x.net)}</strong></td><td>{x.receiptCount}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            <h3>Doanh thu dịch vụ (chi phí đã ghi)</h3>
            <div className="totals">
              <Tile label="Doanh thu dịch vụ" value={d.services.total} tone="zero" />
              {d.services.byCategory.map((c) => (
                <Tile key={c.category} label={`${CATEGORY_LABEL[c.category] ?? c.category} (${c.quantity})`} value={c.amount} />
              ))}
            </div>
            {d.services.items.length === 0 ? (
              <p className="muted">Không có chi phí nào trong kỳ.</p>
            ) : (
              <table>
                <thead><tr><th>Mã</th><th>Dịch vụ</th><th>Nhóm</th><th>Số lượng</th><th>Số hồ sơ</th><th>Thành tiền</th><th>Tỷ trọng</th></tr></thead>
                <tbody>
                  {d.services.items.map((i) => (
                    <tr key={i.code}>
                      <td>{i.code}</td><td>{i.name}</td><td>{CATEGORY_LABEL[i.category] ?? i.category}</td><td>{i.quantity}</td><td>{i.cases}</td>
                      <td>{fmtVnd(i.amount)}</td><td>{d.services.total ? `${Math.round((i.amount / d.services.total) * 100)}%` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Tạm ứng còn giữ & công nợ (hiện tại)</h3>
            <div className="totals">
              <Tile label="Tạm ứng còn giữ" value={d.openCases.depositsHeld} tone={d.openCases.depositsHeld ? 'pos' : 'zero'} hint="Số dư dương của hồ sơ đang mở — phải hoàn hoặc cấn trừ" />
              <Tile label="Còn phải thu" value={d.openCases.receivable} tone={d.openCases.receivable ? 'neg' : 'zero'} hint="Số dư âm của hồ sơ đang mở" />
            </div>
            {d.openCases.cases.length > 0 && (
              <details>
                <summary>{d.openCases.cases.length} hồ sơ đang mở</summary>
                <table>
                  <thead><tr><th>Mở lúc</th><th>Bệnh nhân</th><th>Chi phí</th><th>Đã thu</th><th>Đã hoàn</th><th>Số dư</th><th /></tr></thead>
                  <tbody>
                    {d.openCases.cases.map((c) => (
                      <tr key={c.caseId}>
                        <td>{vnTime(c.openedAt)}</td><td>{c.patient.familyName} {c.patient.givenName} ({c.patient.mrn})</td>
                        <td>{fmtVnd(c.totals.charges)}</td><td>{fmtVnd(c.totals.received)}</td><td>{fmtVnd(c.totals.refunded)}</td>
                        <td className={c.totals.balance < 0 ? 'neg' : c.totals.balance > 0 ? 'pos' : ''}>{fmtVnd(c.totals.balance)}</td>
                        <td><a href={`#/finance/cases/${c.caseId}`}>Mở</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            <h3>Theo thu ngân</h3>
            {d.cashiers.length === 0 ? (
              <p className="muted">Không có phát sinh.</p>
            ) : (
              <table>
                <thead><tr><th>Thu ngân</th><th>Số phiếu</th><th>Thu</th><th>Chi</th><th>Phiếu huỷ</th><th>Chi phí gỡ</th><th>Số ca</th><th>Chênh lệch két</th></tr></thead>
                <tbody>
                  {d.cashiers.map((c) => (
                    <tr key={c.name ?? ''}>
                      <td>{c.name}</td><td>{c.receiptCount}</td><td>{fmtVnd(c.in)}</td><td>{fmtVnd(c.out)}</td>
                      <td className={c.cancelledCount ? 'pos' : ''}>{c.cancelledCount}{c.cancelledCount ? ` (${fmtVnd(c.cancelledAmount)})` : ''}</td>
                      <td className={c.voidedCharges ? 'pos' : ''}>{c.voidedCharges}</td>
                      <td>{c.shifts}{c.openShifts ? <span className="muted"> ({c.openShifts} chưa đóng)</span> : null}</td>
                      <td className={c.cashDifference ? 'neg' : ''}>{fmtVnd(c.cashDifference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Kiểm soát: phiếu huỷ & chi phí gỡ</h3>
            {d.controls.cancelledReceipts.length + d.controls.voidedCharges.length === 0 ? (
              <p className="muted">Không có phiếu huỷ hay chi phí gỡ trong kỳ.</p>
            ) : (
              <table>
                <thead><tr><th>Loại</th><th>Số phiếu / mã</th><th>Bệnh nhân</th><th>Số tiền</th><th>Người huỷ / gỡ</th><th>Lúc</th><th>Lý do</th></tr></thead>
                <tbody>
                  {d.controls.cancelledReceipts.map((x) => (
                    <tr key={x.receiptNo}>
                      <td>Huỷ {KIND[x.kind]?.toLowerCase()} · {METHOD[x.method]}</td><td>{x.receiptNo}</td><td>{x.patientName} ({x.mrn})</td>
                      <td>{fmtVnd(x.amount)}</td><td>{x.cancelledByName}</td><td>{vnTime(x.cancelledAt)}</td><td>{x.reason}</td>
                    </tr>
                  ))}
                  {d.controls.voidedCharges.map((x, i) => (
                    <tr key={`v${i}`}>
                      <td>Gỡ chi phí</td><td>{x.itemCode}</td><td>{x.patientName} ({x.mrn})</td>
                      <td>{fmtVnd(x.amount)}</td><td>{x.voidedByName}</td><td>{vnTime(x.voidedAt)}</td><td>{x.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
