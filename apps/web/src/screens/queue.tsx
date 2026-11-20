/**
 * Hàng đợi khám theo số thứ tự (HCOS-F6).
 *  - Lễ tân: cấp số (ở hồ sơ bệnh nhân — IssueTicket), đưa số vắng mặt lại hàng chờ, huỷ số.
 *  - Bác sĩ: chọn phòng, "Gọi số tiếp theo" (ưu tiên trước), gọi lại, vắng mặt, "Bắt đầu khám" => mở đợt khám.
 *  - Quản lý: phòng khám, màn hình gọi số (đường dẫn có khoá chỉ hiện MỘT lần).
 *  - Màn hình TV (#/board/<khoá>): không đăng nhập, chỉ hiện số thứ tự + phòng.
 * Server là nơi quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, navigate, useAction, useLoad } from '../lib/ui';

export interface ServicePoint { servicePointId: string; code: string; name: string; isActive: boolean; bookingCapacity: number; version: number }
interface Ticket {
  ticketId: string; servicePointId: string; patientId: string; ticketNo: number; displayNo: string; servicePointCode: string; servicePointName: string;
  priorityReason: string | null; priorityRank: number; status: string; calledCount: number; calledAt: string | null; calledByUserId: string | null;
  calledByName: string | null; encounterId: string | null; issuedAt: string;
  patient: { mrn: string; familyName: string; givenName: string; birthDate: string | null };
}
interface Display { displayId: string; name: string; isActive: boolean; createdAt: string }

export const PRIORITY_LABEL: Record<string, string> = {
  emergency: 'Cấp cứu',
  child_under_6: 'Trẻ em dưới 6 tuổi',
  pregnant: 'Phụ nữ có thai',
  severe_disability: 'Người khuyết tật nặng / đặc biệt nặng',
  elderly_75: 'Người từ đủ 75 tuổi',
  revolutionary_merit: 'Người có công với cách mạng',
};
const TICKET_STATUS: Record<string, string> = { waiting: 'Đang chờ', called: 'Đang gọi', in_service: 'Đang khám', skipped: 'Vắng mặt', cancelled: 'Đã huỷ' };

/** Đọc / ghi localStorage an toàn (có thể bị chặn). */
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* bỏ qua */
    }
  },
};

const PriorityBadge = ({ reason }: { reason: string | null }) =>
  reason ? <span className={`badge ${reason === 'emergency' ? 'danger' : 'priority'}`}>{reason === 'emergency' ? 'Cấp cứu' : 'Ưu tiên'}</span> : null;

export function useServicePoints() {
  const { orgId } = useSession();
  return useLoad(() => api<{ servicePoints: ServicePoint[] }>('GET', `/api/service-points?organization=${orgId}`).then((r) => r.data.servicePoints), [orgId]);
}

/** Tự tải lại theo chu kỳ khi tab đang hiện. */
function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---------------------------------------------------------------------------
// Màn Hàng đợi (nhân viên)
// ---------------------------------------------------------------------------
export function QueueScreen() {
  const { orgId, roles, me } = useSession();
  const isDoctor = roles.has('doctor');
  const isStaff = roles.has('clinic_staff') || roles.has('clinic_admin');
  const canManage = roles.has('clinic_admin') || roles.has('tenant_admin');
  const canRead = isDoctor || isStaff;
  const sps = useServicePoints();
  const storeKey = `hcos.queue.sp.${orgId}`;
  const [spId, setSpId] = useState(() => store.get(storeKey) ?? '');
  useEffect(() => {
    if (sps.data && spId && !sps.data.some((s) => s.servicePointId === spId)) setSpId('');
  }, [sps.data, spId]);
  const choose = (v: string) => {
    setSpId(v);
    store.set(storeKey, v);
  };
  const sp = sps.data?.find((s) => s.servicePointId === spId);
  // Access policy có thể không cho dùng hàng đợi (policy chỉ thu hẹp quyền): báo rõ thay vì lỗi 403 thô.
  const denied = sps.error instanceof ApiError && sps.error.status === 403;

  const list = useLoad(
    () =>
      canRead && !denied
        ? api<{ tickets: Ticket[] }>('GET', `/api/queue?organization=${orgId}${spId ? `&servicePoint=${spId}` : ''}`).then((r) => r.data.tickets)
        : Promise.resolve([] as Ticket[]),
    [orgId, spId, canRead, denied],
  );
  useInterval(list.reload, 10_000);

  const callNext = useAction(async () => {
    const r = await api<{ ticket: Ticket | null }>('POST', `/api/queue/service-points/${spId}/call-next`);
    if (!r.data.ticket) throw new Error('Không còn ai đang chờ ở phòng này.');
    list.reload();
  });
  const act = useAction(async (t: Ticket, action: 'recall' | 'skip' | 'requeue' | 'cancel') => {
    if (action === 'cancel' && !confirm(`Huỷ số ${t.displayNo}?`)) return;
    await api('POST', `/api/queue/tickets/${t.ticketId}/${action}`);
    list.reload();
  });
  const start = useAction(async (t: Ticket) => {
    const r = await api<{ encounterId: string }>('POST', `/api/queue/tickets/${t.ticketId}/start`, { body: {} });
    navigate(`#/encounters/${r.data.encounterId}`);
  });

  const tickets = list.data ?? [];
  const mine = tickets.filter((t) => t.status === 'called' && t.calledByUserId === me.user.userId);
  const waiting = tickets.filter((t) => t.status === 'waiting').length;

  return (
    <div className="stack">
      <Card title="Hàng đợi khám hôm nay" actions={<button className="link" onClick={list.reload}>Tải lại</button>}>
        {denied ? <Notice kind="warn">Access policy của bạn không cho phép xem hàng đợi. Liên hệ quản lý nếu cần.</Notice> : <ErrorBox error={sps.error} />}
        {sps.data && sps.data.length === 0 && (
          <Notice kind="warn">Cơ sở chưa có phòng khám nào{canManage ? ' — tạo ở phần "Cài đặt hàng đợi" bên dưới.' : '. Liên hệ quản lý.'}</Notice>
        )}
        {sps.data && sps.data.length > 0 && (
          <div className="row wrap">
            <Field label="Phòng">
              <select value={spId} onChange={(e) => choose(e.target.value)}>
                <option value="">{isDoctor ? '— chọn phòng của bạn —' : 'Tất cả phòng'}</option>
                {sps.data.map((s) => (
                  <option key={s.servicePointId} value={s.servicePointId} disabled={!s.isActive}>
                    {s.code} · {s.name}
                    {s.isActive ? '' : ' (ngừng)'}
                  </option>
                ))}
              </select>
            </Field>
            {isDoctor && (
              <button className="big" onClick={() => void callNext.run()} disabled={!sp || !sp.isActive || callNext.busy}>
                Gọi số tiếp theo{sp ? ` (${waiting} đang chờ)` : ''}
              </button>
            )}
          </div>
        )}
        <ErrorBox error={callNext.error} />
        <ErrorBox error={list.error} />
      </Card>

      {isDoctor && mine.length > 0 && (
        <Card title="Bạn đang gọi">
          {mine.map((t) => (
            <div key={t.ticketId} className="calling">
              <span className="ticket-no">{t.displayNo}</span>
              <div className="grow">
                <strong>
                  {t.patient.familyName} {t.patient.givenName}
                </strong>{' '}
                <PriorityBadge reason={t.priorityReason} />
                <div className="muted">
                  MRN {t.patient.mrn} · {t.servicePointName} · đã gọi {t.calledCount} lần
                  {t.priorityReason ? ` · ${PRIORITY_LABEL[t.priorityReason]}` : ''}
                </div>
              </div>
              <button onClick={() => void start.run(t)} disabled={start.busy}>
                Bắt đầu khám
              </button>
              <button className="secondary" onClick={() => void act.run(t, 'recall')} disabled={act.busy}>
                Gọi lại
              </button>
              <button className="link danger" onClick={() => void act.run(t, 'skip')} disabled={act.busy}>
                Vắng mặt
              </button>
            </div>
          ))}
          <ErrorBox error={start.error} />
        </Card>
      )}

      {canRead && !denied && (
        <Card title={`Danh sách${sp ? ` — ${sp.code} · ${sp.name}` : ''}`}>
          {list.data && tickets.length === 0 && <p className="muted">Chưa có số nào hôm nay.</p>}
          {tickets.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Số</th>
                  <th>Bệnh nhân</th>
                  <th>MRN</th>
                  <th>Ưu tiên</th>
                  <th>Trạng thái</th>
                  <th>Cấp lúc</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.ticketId} className={t.status === 'called' ? 'hl' : t.status === 'in_service' ? 'muted-row' : ''}>
                    <td>
                      <strong>{t.displayNo}</strong>
                    </td>
                    <td>
                      {t.patient.familyName} {t.patient.givenName}
                    </td>
                    <td>{t.patient.mrn}</td>
                    <td title={t.priorityReason ? PRIORITY_LABEL[t.priorityReason] : ''}>
                      <PriorityBadge reason={t.priorityReason} />
                    </td>
                    <td>
                      {TICKET_STATUS[t.status] ?? t.status}
                      {t.status === 'called' && t.calledByName ? <span className="muted"> · {t.calledByName}</span> : null}
                    </td>
                    <td>{fmtDateTime(t.issuedAt).split(' ')[0]}</td>
                    <td className="actions">
                      {t.status === 'in_service' && t.encounterId && <a href={`#/encounters/${t.encounterId}`}>Đợt khám</a>}
                      {isStaff && t.status === 'skipped' && (
                        <button className="link" onClick={() => void act.run(t, 'requeue')} disabled={act.busy}>
                          Đưa lại hàng chờ
                        </button>
                      )}
                      {isStaff && (t.status === 'waiting' || t.status === 'skipped') && (
                        <button className="link danger" onClick={() => void act.run(t, 'cancel')} disabled={act.busy}>
                          Huỷ số
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ErrorBox error={act.error} />
          {isStaff && <p className="muted">Cấp số ở hồ sơ bệnh nhân (tab Bệnh nhân → tìm → "Cấp số khám").</p>}
        </Card>
      )}

      {canManage && <QueueSettings servicePoints={sps.data ?? []} onChanged={sps.reload} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cấp số (ở hồ sơ bệnh nhân)
// ---------------------------------------------------------------------------
function ageOn(birthDate: string | undefined, now = new Date()): number | null {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  let a = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return a;
}

export function IssueTicket({ patientId, patientName, birthDate }: { patientId: string; patientName: string; birthDate?: string }) {
  const { orgId } = useSession();
  const sps = useServicePoints();
  const age = ageOn(birthDate);
  const suggested = age !== null && age < 6 ? 'child_under_6' : age !== null && age >= 75 ? 'elderly_75' : '';
  const [spId, setSpId] = useState(() => store.get(`hcos.issue.sp.${orgId}`) ?? '');
  const [reason, setReason] = useState(suggested);
  const [issued, setIssued] = useState<Ticket | null>(null);
  const active = (sps.data ?? []).filter((s) => s.isActive);
  const chosen = active.some((s) => s.servicePointId === spId) ? spId : (active[0]?.servicePointId ?? '');

  const issue = useAction(async () => {
    const r = await api<Ticket>('POST', '/api/queue/tickets', { body: { servicePointId: chosen, patientId, priorityReason: reason || null } });
    store.set(`hcos.issue.sp.${orgId}`, chosen);
    setIssued(r.data);
  });
  const already = issue.error instanceof ApiError && issue.error.status === 409 && issue.error.detail === 'PATIENT_ALREADY_QUEUED';
  // Policy không cho dùng hàng đợi => không hiện thẻ cấp số.
  if (sps.error instanceof ApiError && sps.error.status === 403) return null;
  if (!sps.data && !sps.error) return null; // đang tải

  return (
    <Card title="Cấp số khám">
      <ErrorBox error={sps.error} />
      {sps.data && active.length === 0 && <Notice kind="warn">Chưa có phòng khám nào đang hoạt động.</Notice>}
      {active.length > 0 && !issued && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void issue.run();
          }}
        >
          <Field label="Phòng khám">
            <select value={chosen} onChange={(e) => setSpId(e.target.value)}>
              {active.map((s) => (
                <option key={s.servicePointId} value={s.servicePointId}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ưu tiên" hint={suggested && reason === suggested ? `gợi ý theo tuổi (${age})` : undefined}>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Không</option>
              {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" disabled={issue.busy || !chosen}>
            Cấp số
          </button>
        </form>
      )}
      {already ? (
        <Notice kind="warn">Bệnh nhân đã có số đang chờ hôm nay. Xem ở tab Hàng đợi (huỷ số cũ nếu cần đổi phòng).</Notice>
      ) : (
        <ErrorBox error={issue.error} />
      )}
      {issued && (
        <div className="row wrap">
          <div className="print-ticket">
            <div className="pt-org">Phiếu số thứ tự</div>
            <div className="pt-no">{issued.displayNo}</div>
            <div className="pt-room">{issued.servicePointName}</div>
            {issued.priorityReason && <div className="pt-priority">ƯU TIÊN · {PRIORITY_LABEL[issued.priorityReason]}</div>}
            <div className="pt-name">{patientName}</div>
            <div className="pt-time">{fmtDateTime(issued.issuedAt)}</div>
          </div>
          <div className="stack">
            <button onClick={() => window.print()}>In phiếu</button>
            <button className="link" onClick={() => setIssued(null)}>
              Xong
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cài đặt (quản lý): phòng khám, màn hình gọi số
// ---------------------------------------------------------------------------
function QueueSettings({ servicePoints, onChanged }: { servicePoints: ServicePoint[]; onChanged: () => void }) {
  const { orgId } = useSession();
  const [f, setF] = useState({ code: '', name: '' });
  const create = useAction(async () => {
    await api('POST', '/api/service-points', { body: { organizationId: orgId, code: f.code.trim().toUpperCase(), name: f.name.trim() } });
    setF({ code: '', name: '' });
    onChanged();
  });
  const toggle = useAction(async (s: ServicePoint) => {
    await api('POST', `/api/service-points/${s.servicePointId}/active`, { headers: { 'if-match': `W/"${s.version}"` }, body: { isActive: !s.isActive } });
    onChanged();
  });
  const displays = useLoad(() => api<{ displays: Display[] }>('GET', `/api/queue/displays?organization=${orgId}`).then((r) => r.data.displays), [orgId]);
  const [dname, setDname] = useState('Màn hình sảnh chờ');
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const createDisplay = useAction(async () => {
    const r = await api<{ key: string }>('POST', '/api/queue/displays', { body: { organizationId: orgId, name: dname.trim() } });
    setNewUrl(`${location.origin}/app/#/board/${r.data.key}`);
    displays.reload();
  });
  const revoke = useAction(async (d: Display) => {
    if (!confirm(`Thu hồi "${d.name}"? Màn hình đang mở đường dẫn này sẽ ngừng hiển thị.`)) return;
    await api('POST', `/api/queue/displays/${d.displayId}/revoke`, { body: { organizationId: orgId } });
    displays.reload();
  });

  return (
    <Card title="Cài đặt hàng đợi">
      <h3>Phòng khám</h3>
      {servicePoints.length > 0 && (
        <ul className="list">
          {servicePoints.map((s) => (
            <li key={s.servicePointId}>
              <strong>{s.code}</strong> · {s.name} {s.isActive ? '' : <span className="muted">(ngừng)</span>}{' '}
              <button className="link" onClick={() => void toggle.run(s)} disabled={toggle.busy}>
                {s.isActive ? 'Ngừng' : 'Mở lại'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void create.run();
        }}
      >
        <Field label="Mã *" hint="1–6 ký tự A-Z, 0-9 (vd. N1)">
          <input required className="short" maxLength={6} pattern="[A-Za-z0-9]{1,6}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </Field>
        <Field label="Tên phòng *">
          <input required minLength={2} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Phòng khám Nội 1" />
        </Field>
        <button type="submit" disabled={create.busy}>
          Thêm phòng
        </button>
      </form>
      <ErrorBox error={create.error ?? toggle.error} />

      <h3>Màn hình gọi số (TV)</h3>
      <p className="muted">Màn hình chỉ hiện số thứ tự và phòng, không có tên bệnh nhân. Ai có đường dẫn đều xem được — chỉ mở trên TV ở sảnh.</p>
      {displays.data?.map((d) => (
        <p key={d.displayId}>
          {d.name} · {fmtDateTime(d.createdAt)} · {d.isActive ? 'đang dùng' : <span className="muted">đã thu hồi</span>}{' '}
          {d.isActive && (
            <button className="link danger" onClick={() => void revoke.run(d)} disabled={revoke.busy}>
              Thu hồi
            </button>
          )}
        </p>
      ))}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void createDisplay.run();
        }}
      >
        <Field label="Tên màn hình">
          <input required minLength={2} maxLength={100} value={dname} onChange={(e) => setDname(e.target.value)} />
        </Field>
        <button type="submit" disabled={createDisplay.busy}>
          Tạo đường dẫn màn hình
        </button>
      </form>
      {newUrl && (
        <Notice kind="ok">
          Mở đường dẫn này trên TV (chỉ hiện MỘT lần, hãy lưu lại):
          <br />
          <code className="select-all">{newUrl}</code>
        </Notice>
      )}
      <ErrorBox error={createDisplay.error ?? revoke.error ?? displays.error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Màn hình TV (không đăng nhập)
// ---------------------------------------------------------------------------
interface BoardRow { servicePointCode: string; servicePointName: string; displayNo: string; priority: string | null; calledCount: number; calledAt: string | null }
interface Board { displayName: string; organizationName: string | null; called: BoardRow[]; waiting: BoardRow[] }

export function BoardScreen({ displayKey }: { displayKey: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [speak, setSpeak] = useState(false);
  const seen = useRef(new Map<string, number>());
  const primed = useRef(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/public/queue-board', { headers: { 'x-display-key': displayKey }, cache: 'no-store' });
        if (r.status === 404) throw new Error('Đường dẫn màn hình không hợp lệ hoặc đã bị thu hồi.');
        if (!r.ok) throw new Error('Mất kết nối máy chủ, đang thử lại…');
        const b = (await r.json()) as Board;
        if (stop) return;
        // Số mới được gọi hoặc gọi lại => đọc (bỏ qua lần tải đầu để không đọc lại cả danh sách cũ).
        for (const c of b.called) {
          const k = `${c.servicePointCode}|${c.displayNo}`;
          if (primed.current && (seen.current.get(k) ?? 0) < c.calledCount && speak && 'speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(`Mời số ${c.displayNo.replace('-', ' ')} vào ${c.servicePointName}`);
            u.lang = 'vi-VN';
            speechSynthesis.speak(u);
          }
          seen.current.set(k, c.calledCount);
        }
        primed.current = true;
        setBoard(b);
        setError(null);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      stop = true;
      clearInterval(id);
      clearInterval(clock);
    };
  }, [displayKey, speak]);

  /** Nhấp nháy số vừa gọi / gọi lại trong 20 giây. */
  const isFresh = (c: BoardRow) => !!c.calledAt && now.getTime() - Date.parse(c.calledAt) < 20_000;

  const rooms = new Map<string, { name: string; rows: BoardRow[] }>();
  for (const w of board?.waiting ?? []) {
    const r = rooms.get(w.servicePointCode) ?? { name: w.servicePointName, rows: [] };
    r.rows.push(w);
    rooms.set(w.servicePointCode, r);
  }

  return (
    <div className="board">
      <header>
        <span>{board?.organizationName ?? 'HealthcareOS'}</span>
        <span>{now.toLocaleTimeString('vi-VN')}</span>
      </header>
      {error && <div className="board-error">{error}</div>}
      <div className="board-grid">
        <section>
          <h2>ĐANG GỌI</h2>
          {board && board.called.length === 0 && <p className="board-empty">Chưa gọi số nào.</p>}
          {board?.called.map((c) => (
            <div key={`${c.servicePointCode}|${c.displayNo}`} className={`board-call${isFresh(c) ? ' fresh' : ''}`}>
              <span className="board-no">{c.displayNo}</span>
              <span className="board-room">→ {c.servicePointName}</span>
              {c.priority && <span className="board-prio">{c.priority === 'emergency' ? 'CẤP CỨU' : 'ƯU TIÊN'}</span>}
            </div>
          ))}
        </section>
        <section>
          <h2>SẮP TỚI</h2>
          {board && rooms.size === 0 && <p className="board-empty">Không có ai đang chờ.</p>}
          {[...rooms].map(([code, r]) => (
            <div key={code} className="board-room-next">
              <div className="board-room-name">{r.name}</div>
              <div className="board-next">
                {r.rows.map((w) => (
                  <span key={w.displayNo} className={w.priority ? 'prio' : ''}>
                    {w.displayNo}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
      {!speak && (
        <button className="board-speak" onClick={() => setSpeak(true)}>
          Bật đọc số bằng giọng nói
        </button>
      )}
    </div>
  );
}
