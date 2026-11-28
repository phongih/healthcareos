/**
 * Giao diện đợt 3 | "Hôm nay" — workspace lễ tân / điều dưỡng.
 * Gom việc trong ngày lên một màn: ô tìm bệnh nhân (mã BN hoặc CCCD), 3 việc hay làm, 4 con số,
 * hàng đợi theo phòng, lịch hẹn chưa check-in, việc cần làm (vắng mặt, yêu cầu từ cổng bệnh nhân).
 * Chỉ đọc qua các API sẵn có (máy chủ lọc theo quyền / access policy); không hiện SĐT / CCCD của lịch hẹn.
 * Tự làm mới 30 giây một lần khi tab đang mở.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { api } from '../lib/api';
import { CCCD_SYSTEM, entries, fmtDate, fmtDateTime, isRedacted, mrnOf, patientName, type Bundle, type FhirPatient } from '../lib/fhir';
import { Icon } from '../lib/icons';
import { can, useSession } from '../lib/session';
import { ErrorBox, navigate, Notice, RedactedBadge, useAction, useLoad } from '../lib/ui';
import { firstName, searchParamsFor, summarizeQueue, todayVN } from '../lib/today-model';
import type { ServicePoint } from './queue';
import { CashierToday } from './today-cashier';
import { DoctorToday } from './today-doctor';

interface Ticket {
  ticketId: string; servicePointId: string; displayNo: string; status: string; calledAt: string | null; priorityReason: string | null;
  patient: { mrn: string; familyName: string; givenName: string };
}
interface Booking {
  bookingId: string; servicePointId: string; servicePointName: string; period: 'morning' | 'afternoon'; familyName: string; givenName: string; status: string;
}
interface PortalReq { requestId: string; name: string; mrn: string | null; createdAt: string; message: string }

const PERIOD: Record<string, string> = { morning: 'Sáng', afternoon: 'Chiều' };
const REFRESH_MS = 30_000;

const longDate = (now = new Date()) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);

function ReceptionToday() {
  const { me, orgId, roles } = useSession();
  const day = todayVN();
  const canPortal = can.portalManage(roles);

  const points = useLoad(() => api<{ servicePoints: ServicePoint[] }>('GET', `/api/service-points?organization=${orgId}`).then((r) => r.data.servicePoints), [orgId]);
  const tickets = useLoad(() => api<{ tickets: Ticket[] }>('GET', `/api/queue?organization=${orgId}`).then((r) => r.data.tickets), [orgId]);
  const bookings = useLoad(
    () => (can.bookings(roles) ? api<{ bookings: Booking[] }>('GET', `/api/bookings?organization=${orgId}&date=${day}`).then((r) => r.data.bookings) : Promise.resolve([] as Booking[])),
    [orgId, day],
  );
  const requests = useLoad(
    () => (canPortal ? api<{ requests: PortalReq[] }>('GET', `/api/portal-admin/requests?organization=${orgId}`).then((r) => r.data.requests) : Promise.resolve([] as PortalReq[])),
    [orgId],
  );

  // Tự làm mới khi tab đang hiển thị (hàng đợi thay đổi liên tục).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      tickets.reload();
      bookings.reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const t = tickets.data ?? [];
  const waiting = t.filter((x) => x.status === 'waiting').length;
  const inProgress = t.filter((x) => x.status === 'called' || x.status === 'in_service').length;
  const skipped = t.filter((x) => x.status === 'skipped');
  const pending = (bookings.data ?? []).filter((b) => b.status === 'booked');
  const rooms = useMemo(() => summarizeQueue(points.data ?? [], t), [points.data, t]);
  const openReqs = requests.data ?? [];

  return (
    <div className="stack today">
      <div className="today-head">
        <div>
          <span className="muted today-date">{longDate()}</span>
          <h1>Chào {firstName(me.user.displayName) || 'bạn'}</h1>
        </div>
        <button type="button" className="secondary small-btn" onClick={() => { tickets.reload(); bookings.reload(); requests.reload(); points.reload(); }}>
          Làm mới
        </button>
      </div>

      <PatientQuickSearch />

      <div className="today-actions">
        {can.registerPatient(roles) && (
          <a className="today-action primary" href="#/patients/new"><Icon name="plus" size={22} /><span>Đăng ký mới</span></a>
        )}
        <a className="today-action" href="#/queue"><Icon name="ticket" size={22} /><span>Cấp số khám</span></a>
        {can.bookings(roles) && (
          <a className="today-action" href="#/bookings"><Icon name="check" size={22} /><span>Check-in lịch hẹn</span></a>
        )}
      </div>

      <div className="today-kpis" aria-live="polite">
        <Kpi n={tickets.data ? waiting : null} label="Đang chờ khám" tone="brand" />
        <Kpi n={tickets.data ? inProgress : null} label="Đang gọi / đang khám" />
        <Kpi n={tickets.data ? skipped.length : null} label="Vắng mặt" tone={skipped.length ? 'warn' : undefined} />
        <Kpi n={bookings.data ? pending.length : null} label="Lịch hẹn chưa đến" />
      </div>
      <ErrorBox error={tickets.error ?? points.error} />

      <div className="today-cols">
        <section className="card today-rooms">
          <div className="card-head">
            <h2>Hàng đợi theo phòng</h2>
            <a href="#/queue" className="today-link">Mở hàng đợi</a>
          </div>
          {points.data && rooms.length === 0 && <Notice>Cơ sở chưa có phòng khám đang hoạt động.</Notice>}
          <div className="room-grid">
            {rooms.map((r) => (
              <a key={r.point.servicePointId} className="room" href="#/queue">
                <span className="room-name">{r.point.code} · {r.point.name}</span>
                <span className="room-no">{r.current?.displayNo ?? '—'}</span>
                <span className="room-sub">{r.current ? (r.current.status === 'in_service' ? 'đang khám' : 'đang gọi') : 'chưa gọi'} · {r.waiting} người chờ</span>
              </a>
            ))}
          </div>
        </section>

        {can.bookings(roles) && (
          <section className="card">
            <div className="card-head">
              <h2>Lịch hẹn chưa check-in ({pending.length})</h2>
              <a href="#/bookings" className="today-link">Lịch hẹn</a>
            </div>
            <ErrorBox error={bookings.error} />
            {bookings.data && pending.length === 0 && <p className="muted">Không còn lịch hẹn nào chờ check-in hôm nay.</p>}
            <ul className="today-list">
              {pending.slice(0, 6).map((b) => (
                <li key={b.bookingId}>
                  <span className="when">{PERIOD[b.period] ?? b.period}</span>
                  <span className="what">
                    <strong>{b.familyName} {b.givenName}</strong>
                    <span className="muted">{b.servicePointName}</span>
                  </span>
                  <a className="today-btn" href="#/bookings">Check-in</a>
                </li>
              ))}
            </ul>
            {pending.length > 6 && <a href="#/bookings" className="today-link">Xem thêm {pending.length - 6} lịch hẹn</a>}
          </section>
        )}
      </div>

      {(skipped.length > 0 || openReqs.length > 0) && (
        <section className="card">
          <div className="card-head"><h2>Việc cần làm</h2></div>
          <ul className="today-list tasks">
            {skipped.slice(0, 5).map((s) => (
              <li key={s.ticketId}>
                <span className="task-icon warn"><Icon name="queue" size={18} /></span>
                <span className="what">
                  <strong>Số {s.displayNo} vắng mặt · {s.patient.familyName} {s.patient.givenName}</strong>
                  <span className="muted">Người bệnh quay lại thì "Đưa lại hàng chờ" ở Hàng đợi</span>
                </span>
                <a className="today-btn" href="#/queue">Hàng đợi</a>
              </li>
            ))}
            {openReqs.slice(0, 5).map((r) => (
              <li key={r.requestId}>
                <span className="task-icon"><Icon name="idcard" size={18} /></span>
                <span className="what">
                  <strong>Yêu cầu đính chính · {r.name}{r.mrn ? ` (${r.mrn})` : ''}</strong>
                  <span className="muted">Cổng bệnh nhân · gửi {fmtDateTime(r.createdAt)}</span>
                </span>
                <a className="today-btn" href="#/bookings">Xử lý</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Kpi({ n, label, tone }: { n: number | null; label: string; tone?: 'brand' | 'warn' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <span className="kpi-n">{n ?? '…'}</span>
      <span className="kpi-l">{label}</span>
    </div>
  );
}

/** Ô tìm nhanh: mã bệnh nhân hoặc CCCD 12 số. Tìm theo họ tên + ngày sinh vẫn ở màn Bệnh nhân. */
function PatientQuickSearch() {
  const { orgId } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FhirPatient[] | null>(null);
  const search = useAction(async () => {
    const { mode, value } = searchParamsFor(q);
    const p = new URLSearchParams({ organization: orgId, _count: '8' });
    if (mode === 'cccd') p.set('identifier', `${CCCD_SYSTEM}|${value}`);
    else p.set('mrn', value);
    const r = await api<Bundle<FhirPatient>>('GET', `/fhir/Patient?${p.toString()}`);
    const list = entries(r.data);
    if (list.length === 1 && list[0]?.id) navigate(`#/patients/${list[0].id}`);
    else setResults(list);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) void search.run();
  };
  return (
    <div className="today-search">
      <form onSubmit={submit} role="search">
        <label className="search-box">
          <Icon name="search" size={20} />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setResults(null); }}
            placeholder="Mã bệnh nhân hoặc CCCD"
            aria-label="Tìm bệnh nhân theo mã bệnh nhân hoặc CCCD"
            autoComplete="off"
          />
          <button type="submit" disabled={search.busy || !q.trim()}>{search.busy ? 'Đang tìm…' : 'Tìm'}</button>
        </label>
      </form>
      <span className="field-hint">Gõ hoặc quét mã (thiếu gạch / chữ thường vẫn được); CCCD đủ 12 số. Tìm theo họ tên + ngày sinh: mở <a href="#/patients">Bệnh nhân</a>.</span>
      <ErrorBox error={search.error} />
      {results && results.length === 0 && <Notice>Không tìm thấy bệnh nhân phù hợp tại cơ sở này.</Notice>}
      {results && results.length > 1 && (
        <ul className="today-list">
          {results.map((p) => (
            <li key={p.id}>
              <span className="what">
                <strong>{patientName(p)} <RedactedBadge show={isRedacted(p)} /></strong>
                <span className="muted">{mrnOf(p)} · {fmtDate(p.birthDate)}</span>
              </span>
              <a className="today-btn" href={`#/patients/${p.id}`}>Mở</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Bác sĩ (không phải lễ tân) thấy màn riêng; lễ tân / điều dưỡng giữ màn cũ. */
export function TodayScreen() {
  const { roles } = useSession();
  if (roles.has('doctor') && !roles.has('clinic_staff')) return <DoctorToday />;
  if (roles.has('cashier') && !roles.has('clinic_staff') && !roles.has('doctor')) return <CashierToday />;
  return <ReceptionToday />;
}
