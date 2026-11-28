/**
 * Màn "Hôm nay" cho thu ngân: ca đang mở của tôi, hồ sơ còn số dư chờ thu, tổng thu trong ca.
 * Chỉ đọc qua các API tài chính sẵn có (GET shifts/mine, GET cases?status=open); thu tiền và đóng ca làm ở màn Thu ngân.
 * Tự làm mới 30 giây một lần khi tab đang mở.
 */
import { useEffect } from 'react';

import { api } from '../lib/api';
import { fmtVnd } from '../lib/money';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Notice, useLoad } from '../lib/ui';
import type { Shift } from './finance';

interface CaseRow {
  caseId: string;
  patient: { mrn: string; familyName: string; givenName: string };
  openedAt: string;
  totals: { charges: number; received: number; refunded: number; balance: number };
}

const REFRESH_MS = 30_000;
const fmtTime = (iso: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const longDate = () => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

/** Tổng thu trong ca = tiền vào trừ tiền ra, cộng mọi phương thức. */
const netInShift = (s: Shift | null): number => {
  if (!s?.totals) return 0;
  return Object.values(s.totals).reduce((n, t) => n + (t.in - t.out), 0);
};

export function CashierToday() {
  const { me, orgId } = useSession();

  const shift = useLoad(
    () => api<{ shift: Shift | null }>('GET', `/api/finance/shifts/mine?organization=${orgId}`).then((r) => r.data.shift),
    [orgId],
  );
  const cases = useLoad(
    () => api<{ cases: CaseRow[] }>('GET', `/api/finance/cases?organization=${orgId}&status=open`).then((r) => r.data.cases),
    [orgId],
  );

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      shift.reload();
      cases.reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const s = shift.data ?? null;
  const open = cases.data ?? [];
  const owed = open.reduce((n, c) => n + Math.max(0, c.totals.balance), 0);
  const err = shift.error ?? cases.error;
  const shiftOpen = s?.status === 'open';

  return (
    <div className="stack">
      <Card title={`Hôm nay · ${longDate()}`}>
        <p className="muted">
          Chào {me.user.displayName ?? 'thu ngân'}. Màn này chỉ đọc; thu tiền, hoàn ứng và đóng ca làm ở màn Thu ngân.
        </p>
        <ErrorBox error={err} />
        <div className="row wrap">
          <div><strong>{open.length}</strong> hồ sơ đang mở</div>
          <div><strong>{fmtVnd(owed)}</strong> còn phải thu</div>
          <div><strong>{shiftOpen ? fmtVnd(netInShift(s)) : '—'}</strong> thu trong ca</div>
        </div>
      </Card>

      <Card title="Ca làm việc của tôi">
        {shift.data !== undefined && !s && <Notice>Bạn chưa mở ca. Mở ca ở màn Thu ngân trước khi thu tiền.</Notice>}
        {s && (
          <div className="row wrap">
            <div>Trạng thái: <strong>{shiftOpen ? 'Đang mở' : 'Đã đóng'}</strong></div>
            <div>Tiền đầu ca: <strong>{fmtVnd(s.openingFloat)}</strong></div>
            {s.cashOnHand !== undefined && <div>Tiền mặt hiện có: <strong>{fmtVnd(s.cashOnHand)}</strong></div>}
            <div>Mở lúc: <span className="nowrap">{fmtTime(s.openedAt)}</span></div>
          </div>
        )}
        {s && (
          <p><a href={`#/finance/shifts/${s.shiftId}`}>Xem chi tiết ca</a></p>
        )}
      </Card>

      <Card title={`Hồ sơ đang mở (${open.length})`}>
        {cases.data && open.length === 0 && <Notice>Không có hồ sơ nào đang mở tại cơ sở.</Notice>}
        {open.length > 0 && (
          <table>
            <thead><tr><th>Bệnh nhân</th><th>Mã BN</th><th>Mở lúc</th><th>Phát sinh</th><th>Đã thu</th><th>Còn lại</th><th /></tr></thead>
            <tbody>
              {open.map((c) => (
                <tr key={c.caseId}>
                  <td>{c.patient.familyName} {c.patient.givenName}</td>
                  <td className="mono">{c.patient.mrn}</td>
                  <td className="nowrap">{fmtTime(c.openedAt)}</td>
                  <td>{fmtVnd(c.totals.charges)}</td>
                  <td>{fmtVnd(c.totals.received)}</td>
                  <td><strong>{fmtVnd(c.totals.balance)}</strong></td>
                  <td><a href={`#/finance/cases/${c.caseId}`}>Mở</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
