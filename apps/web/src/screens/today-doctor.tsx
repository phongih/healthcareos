/**
 * Hôm nay — màn bác sĩ.
 *  - Lượt khám đang mở của tôi, và tổng lượt khám đang mở tại cơ sở (GET /api/worklist).
 *  - Hàng đợi theo phòng: số đang chờ và người đang được gọi (GET /api/queue, /api/service-points).
 *  - Đơn thuốc đang hiệu lực tại cơ sở (GET /api/prescriptions?status=active).
 * Chỉ đọc. Máy chủ lọc quyền; màn này không hiện SĐT, CCCD hay liên lạc của bệnh nhân.
 * Tự làm mới 30 giây một lần khi tab đang mở.
 */
import { useEffect } from 'react';

import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Notice, useLoad } from '../lib/ui';
import { summarizeQueue } from '../lib/today-model';
import type { ServicePoint } from './queue';

interface WorklistItem {
  encounterId: string;
  mrn: string;
  familyName: string;
  givenName: string;
  periodStart: string;
  reasonText: string | null;
  reasonRedacted: boolean;
  practitionerUserId: string;
  practitionerName: string | null;
}
interface Ticket {
  ticketId: string; servicePointId: string; displayNo: string; status: string; calledAt: string | null;
}
interface Rx { prescriptionId?: string; id?: string; status?: string }

const REFRESH_MS = 30_000;
const fmtTime = (iso: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const longDate = () => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

export function DoctorToday() {
  const { me, orgId } = useSession();

  const worklist = useLoad(
    () => api<{ items: WorklistItem[] }>('GET', `/api/worklist?organization=${orgId}`).then((r) => r.data.items),
    [orgId],
  );
  const points = useLoad(() => api<{ servicePoints: ServicePoint[] }>('GET', `/api/service-points?organization=${orgId}`).then((r) => r.data.servicePoints), [orgId]);
  const tickets = useLoad(() => api<{ tickets: Ticket[] }>('GET', `/api/queue?organization=${orgId}`).then((r) => r.data.tickets), [orgId]);
  const rx = useLoad(() => api<{ prescriptions: Rx[] }>('GET', `/api/prescriptions?organization=${orgId}&status=active`).then((r) => r.data.prescriptions), [orgId]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      worklist.reload();
      tickets.reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const items = worklist.data ?? [];
  const mine = items.filter((i) => i.practitionerUserId === me.user.userId);
  const rooms = summarizeQueue(points.data ?? [], tickets.data ?? []);
  const activeRx = rx.data?.length ?? 0;
  const err = worklist.error ?? points.error ?? tickets.error ?? rx.error;

  return (
    <div className="stack">
      <Card title={`Hôm nay · ${longDate()}`}>
        <p className="muted">Chào {me.user.displayName ?? 'bác sĩ'}. Màn này chỉ đọc; khám và kê đơn làm ở màn Bệnh nhân.</p>
        <ErrorBox error={err} />
        <div className="row wrap">
          <div><strong>{mine.length}</strong> lượt khám đang mở của tôi</div>
          <div><strong>{items.length}</strong> lượt khám đang mở tại cơ sở</div>
          <div><strong>{rooms.reduce((n, r) => n + r.waiting, 0)}</strong> người đang chờ</div>
          <div><strong>{activeRx}</strong> đơn thuốc đang hiệu lực</div>
        </div>
      </Card>

      <Card title={`Lượt khám của tôi (${mine.length})`}>
        {worklist.data && mine.length === 0 && <Notice>Bạn chưa có lượt khám nào đang mở.</Notice>}
        {mine.length > 0 && (
          <table>
            <thead><tr><th>Bệnh nhân</th><th>Mã BN</th><th>Bắt đầu</th><th>Lý do khám</th></tr></thead>
            <tbody>
              {mine.map((i) => (
                <tr key={i.encounterId}>
                  <td>{i.familyName} {i.givenName}</td>
                  <td className="mono">{i.mrn}</td>
                  <td className="nowrap">{fmtTime(i.periodStart)}</td>
                  <td>{i.reasonRedacted ? <span className="muted">(đã che)</span> : (i.reasonText ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Hàng đợi theo phòng">
        {points.data && rooms.length === 0 && <Notice>Cơ sở chưa có phòng khám nào.</Notice>}
        {rooms.length > 0 && (
          <table>
            <thead><tr><th>Phòng</th><th>Đang gọi</th><th>Đang chờ</th></tr></thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.point.servicePointId}>
                  <td>{r.point.name}</td>
                  <td className="mono">{r.current ? r.current.displayNo : '—'}</td>
                  <td>{r.waiting}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
