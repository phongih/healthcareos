/**
 * Đặt lịch khám online (HCOS-F7).
 *  - Công khai, KHÔNG đăng nhập: #/book/<slug> (chọn phòng / ngày / buổi, điền thông tin, nhận MÃ ĐẶT LỊCH)
 *    và #/book/<slug>/tra-cuu (tra cứu / huỷ bằng mã + số điện thoại).
 *  - Lễ tân (tab "Lịch hẹn"): danh sách theo ngày, check-in theo mã (hoặc từ danh sách), chọn hồ sơ cũ có thể trùng
 *    hoặc tạo hồ sơ mới từ thông tin đã đặt, cấp số vào phòng đã đặt và in phiếu.
 *  - Quản lý: sức chứa mỗi buổi theo phòng, đường dẫn cổng đặt lịch.
 * Server là nơi quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { MrnField } from '../lib/mrn';
import { fmtVnd } from '../lib/money';
import { QrCode } from '../lib/qr-view';
import { Reveal } from '../lib/reveal';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, printOnly, useAction, useIntentKey, useLoad } from '../lib/ui';
import { FinanceError, PrintReceipt, ReceiptFields, receiptBody, useMyShift, useSettings, type Receipt, type ReceiptDraft } from './finance';
import { PRIORITY_LABEL, useServicePoints, type ServicePoint } from './queue';
import { PortalRequestsCard } from './portal-admin';

declare const __HCOS_ENV_LABEL__: string;

type Period = 'morning' | 'afternoon';
const PERIOD_LABEL: Record<Period, string> = { morning: 'Buổi sáng', afternoon: 'Buổi chiều' };
const STATUS_LABEL: Record<string, string> = { booked: 'Đã đặt', checked_in: 'Đã check-in', cancelled: 'Đã huỷ', no_show: 'Không đến' };
const SEX_LABEL: Record<string, string> = { male: 'Nam', female: 'Nữ', other: 'Khác', unknown: 'Không rõ' };
const WEEKDAY = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const fmtDay = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${WEEKDAY[new Date(Date.UTC(y!, m! - 1, day!)).getUTCDay()]}, ${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
};
const fmtDob = (d: string | null) => (d ? d.split('-').reverse().join('/') : '—');

// ---------------------------------------------------------------------------
// Gọi API công khai (không token)
// ---------------------------------------------------------------------------
class PublicError extends Error {
  constructor(public readonly status: number, public readonly reason: string | null) {
    super(reason ?? String(status));
  }
}
async function pub<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
  let r: Response;
  try {
    r = await fetch(path, {
      method, credentials: 'omit', cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PublicError(0, 'NETWORK');
  }
  if (r.status === 404) return null;
  const data = (await r.json().catch(() => null)) as unknown;
  if (!r.ok) throw new PublicError(r.status, (data as { issue?: Array<{ details?: { text?: string } }> } | null)?.issue?.[0]?.details?.text ?? null);
  return data as T;
}

const PUBLIC_MESSAGES: Record<string, string> = {
  NETWORK: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  RATE_LIMITED: 'Bạn thao tác quá nhiều lần. Vui lòng đợi khoảng 10 phút rồi thử lại.',
  SESSION_FULL: 'Buổi này vừa hết chỗ. Vui lòng chọn buổi khác.',
  SESSION_CLOSED: 'Buổi này đã ngừng nhận đặt lịch. Vui lòng chọn buổi khác.',
  ROOM_NOT_BOOKABLE: 'Phòng khám này hiện không nhận đặt lịch online.',
  PHONE_ALREADY_BOOKED: 'Số điện thoại này đã có một lịch hẹn trong ngày đó. Dùng "Tra cứu / huỷ lịch" nếu muốn đổi.',
  CONSENT_REQUIRED: 'Vui lòng đọc và đánh dấu đồng ý xử lý dữ liệu cá nhân.',
  INVALID_PHONE: 'Số điện thoại phải gồm 10 chữ số, bắt đầu bằng 0.',
  INVALID_NATIONAL_ID: 'Số CCCD phải gồm 12 chữ số (hoặc để trống).',
  INVALID_INPUT: 'Thông tin chưa hợp lệ. Kiểm tra họ tên (chỉ chữ cái), ngày sinh, giới tính.',
  NOT_CANCELLABLE: 'Lịch này không huỷ được nữa (đã check-in, đã huỷ, hoặc buổi khám đã bắt đầu).',
};
const publicMessage = (e: unknown) =>
  e instanceof PublicError ? (e.reason && PUBLIC_MESSAGES[e.reason]) || (e.status >= 500 ? 'Hệ thống đang bận, vui lòng thử lại sau.' : 'Có lỗi xảy ra, vui lòng thử lại.') : 'Có lỗi xảy ra, vui lòng thử lại.';

function PublicShell({ title, children }: { title: string; children: ReactNode }) {
  const env = __HCOS_ENV_LABEL__;
  return (
    <div className="pub">
      {env && <div className="env-banner" role="alert">{env}</div>}
      <header className="pub-head">
        <h1>{title}</h1>
      </header>
      <main className="pub-main">{children}</main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trang đặt lịch công khai
// ---------------------------------------------------------------------------
interface Options {
  organizationName: string;
  consentVersion: string;
  consentText: string;
  rooms: Array<{ servicePointId: string; code: string; name: string }>;
  slots: Array<{ servicePointId: string; date: string; period: Period; remaining: number }>;
}
interface Booked { code: string; visitDate: string; period: Period; servicePointName: string; organizationName: string }

export function PublicBookingScreen({ slug }: { slug: string }) {
  const [opts, setOpts] = useState<Options | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [room, setRoom] = useState('');
  const [slot, setSlot] = useState<{ date: string; period: Period } | null>(null);
  const [f, setF] = useState({ familyName: '', givenName: '', birthDate: '', sex: '', phone: '', nationalId: '', reason: '', website: '' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<Booked | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const load = () =>
    pub<Options>('GET', `/api/public/booking/${slug}/options`).then(
      (o) => {
        setOpts(o);
        setLoadErr(null);
        if (o && o.rooms.length === 1) setRoom(o.rooms[0]!.servicePointId);
      },
      (e: unknown) => setLoadErr(e),
    );
  useEffect(() => {
    void load();
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!slot || !opts) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await pub<Booked>('POST', `/api/public/booking/${slug}/bookings`, {
        servicePointId: room, visitDate: slot.date, period: slot.period, familyName: f.familyName.trim(), givenName: f.givenName.trim(),
        birthDate: f.birthDate, sex: f.sex, phone: f.phone.trim(), nationalId: f.nationalId.trim() || null, reason: f.reason.trim() || null,
        consent, consentVersion: opts.consentVersion, ...(f.website ? { website: f.website } : {}),
      });
      if (!r) throw new PublicError(404, null);
      setDone(r);
    } catch (e) {
      setErr(e);
      if (e instanceof PublicError && (e.reason === 'SESSION_FULL' || e.reason === 'SESSION_CLOSED')) {
        setSlot(null);
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (opts === undefined && !loadErr) return <PublicShell title="Đặt lịch khám">Đang tải…</PublicShell>;
  if (loadErr) return <PublicShell title="Đặt lịch khám"><div className="alert error">{publicMessage(loadErr)}</div></PublicShell>;
  if (opts === null) return <PublicShell title="Đặt lịch khám"><div className="alert warn">Đường dẫn đặt lịch không đúng hoặc cơ sở đã tạm ngừng nhận đặt lịch online.</div></PublicShell>;
  const o = opts!;

  if (done) {
    return (
      <PublicShell title={o.organizationName}>
        <div className="pub-card pub-done">
          <p>Đặt lịch thành công. Mã đặt lịch của bạn:</p>
          {/* QR chỉ chứa mã đặt lịch (không có thông tin cá nhân): máy quét ở quầy / kiosk đọc là ra màn check-in. */}
          <QrCode text={done.code} label={`Mã QR của mã đặt lịch ${done.code}`} />
          <div className="pub-code select-all">{done.code}</div>
          <p>
            <strong>{PERIOD_LABEL[done.period]}</strong> · {fmtDay(done.visitDate)}
            <br />
            {done.servicePointName}
          </p>
          <div className="alert warn">
            Hãy <strong>chụp màn hình (cả mã QR) hoặc ghi lại mã này</strong> — mã chỉ hiển thị một lần. Khi đến, đưa mã QR cho quầy lễ tân quét (hoặc đọc mã) để được cấp số thứ tự.
            Mang theo CCCD (và thẻ BHYT nếu có).
          </div>
          <div className="row wrap">
            <button onClick={() => void navigator.clipboard?.writeText(done.code).catch(() => {})}>Sao chép mã</button>
            <button className="secondary" onClick={() => window.print()}>In</button>
          </div>
          <p className="muted">Muốn huỷ? Vào <a href={`#/book/${slug}/tra-cuu`}>Tra cứu / huỷ lịch</a> với mã và số điện thoại đã đặt.</p>
        </div>
      </PublicShell>
    );
  }

  const roomSlots = o.slots.filter((s) => s.servicePointId === room);
  const days = [...new Set(roomSlots.map((s) => s.date))];
  const chosenRoom = o.rooms.find((r) => r.servicePointId === room);

  return (
    <PublicShell title={o.organizationName}>
      <p className="muted">
        Đặt lịch khám không cần tài khoản. Đã đặt rồi? <a href={`#/book/${slug}/tra-cuu`}>Tra cứu / huỷ lịch</a>
      </p>
      {o.rooms.length === 0 ? (
        <div className="alert warn">Hiện chưa có phòng khám nào nhận đặt lịch online.</div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="pub-card">
            <h2>1. Chọn phòng khám</h2>
            <div className="pub-choices">
              {o.rooms.map((r) => (
                <button type="button" key={r.servicePointId} className={room === r.servicePointId ? 'choice on' : 'choice'} onClick={() => { setRoom(r.servicePointId); setSlot(null); }}>
                  {r.name}
                </button>
              ))}
            </div>
          </section>

          {room && (
            <section className="pub-card">
              <h2>2. Chọn ngày và buổi</h2>
              {days.length === 0 && <p className="muted">Không còn buổi nào trong 14 ngày tới.</p>}
              <div className="pub-days">
                {days.map((d) => (
                  <div key={d} className="pub-day">
                    <div className="pub-day-name">{fmtDay(d)}</div>
                    <div className="pub-choices">
                      {(['morning', 'afternoon'] as Period[]).map((p) => {
                        const s = roomSlots.find((x) => x.date === d && x.period === p);
                        if (!s) return null;
                        const on = slot?.date === d && slot.period === p;
                        return (
                          <button type="button" key={p} disabled={s.remaining === 0} className={on ? 'choice on' : 'choice'} onClick={() => setSlot({ date: d, period: p })}>
                            {PERIOD_LABEL[p]}
                            <small>{s.remaining === 0 ? 'Hết chỗ' : `Còn ${s.remaining} chỗ`}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {slot && (
            <section className="pub-card">
              <h2>3. Thông tin người khám</h2>
              <p className="muted">
                {chosenRoom?.name} · {PERIOD_LABEL[slot.period]} · {fmtDay(slot.date)}
              </p>
              <div className="grid2">
                <Field label="Họ *">
                  <input required maxLength={100} autoComplete="family-name" value={f.familyName} onChange={set('familyName')} placeholder="Nguyễn Văn" />
                </Field>
                <Field label="Tên *">
                  <input required maxLength={100} autoComplete="given-name" value={f.givenName} onChange={set('givenName')} placeholder="An" />
                </Field>
                <Field label="Ngày sinh *">
                  <input required type="date" min="1900-01-01" max={new Date().toISOString().slice(0, 10)} value={f.birthDate} onChange={set('birthDate')} />
                </Field>
                <Field label="Giới tính *">
                  <select required value={f.sex} onChange={set('sex')}>
                    <option value="">— chọn —</option>
                    <option value="male">Nam</option>
                    <option value="female">Nữ</option>
                    <option value="other">Khác</option>
                  </select>
                </Field>
                <Field label="Số điện thoại *" hint="Dùng để tra cứu / huỷ lịch">
                  <input required inputMode="tel" autoComplete="tel" pattern="[0-9 +]{10,15}" value={f.phone} onChange={set('phone')} placeholder="09xxxxxxxx" />
                </Field>
                <Field label="Số CCCD" hint="Không bắt buộc — giúp lễ tân tìm đúng hồ sơ cũ">
                  <input inputMode="numeric" pattern="[0-9]{12}" maxLength={12} value={f.nationalId} onChange={set('nationalId')} />
                </Field>
              </div>
              <Field label="Lý do khám / triệu chứng">
                <textarea maxLength={500} rows={3} value={f.reason} onChange={set('reason')} />
              </Field>
              {/* Bẫy bot: người dùng thật không thấy trường này. */}
              <div className="hp" aria-hidden="true">
                <label>
                  Website
                  <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} />
                </label>
              </div>
              <label className="consent">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
                <span>{o.consentText}</span>
              </label>
              {err != null && <div className="alert error">{publicMessage(err)}</div>}
              <button type="submit" className="pub-submit" disabled={busy || !consent}>
                {busy ? 'Đang gửi…' : 'Xác nhận đặt lịch'}
              </button>
            </section>
          )}
          {!slot && err != null && <div className="alert error">{publicMessage(err)}</div>}
        </form>
      )}
    </PublicShell>
  );
}

// ---------------------------------------------------------------------------
// Tra cứu / huỷ (công khai)
// ---------------------------------------------------------------------------
interface Lookup { status: string; visitDate: string; period: Period; servicePointName: string; givenName: string }

export function PublicLookupScreen({ slug }: { slug: string }) {
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [res, setRes] = useState<Lookup | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);

  const run = async (op: 'lookup' | 'cancel') => {
    if (op === 'cancel' && !confirm('Huỷ lịch hẹn này? Không thể hoàn tác.')) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await pub<Lookup>('POST', `/api/public/booking/${slug}/${op}`, { code: code.trim(), phone: phone.trim() });
      setRes(r);
      if (op === 'cancel' && r) setCancelled(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell title="Tra cứu / huỷ lịch khám">
      <p className="muted">
        <a href={`#/book/${slug}`}>← Đặt lịch mới</a>
      </p>
      <form
        className="pub-card stack"
        onSubmit={(e) => {
          e.preventDefault();
          setCancelled(false);
          void run('lookup');
        }}
      >
        <div className="grid2">
          <Field label="Mã đặt lịch">
            <input required className="code-input" autoCapitalize="characters" autoComplete="off" maxLength={9} placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Số điện thoại đã đặt">
            <input required inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <button type="submit" disabled={busy}>Tra cứu</button>
        {err != null && <div className="alert error">{publicMessage(err)}</div>}
        {res === null && <div className="alert warn">Không tìm thấy lịch hẹn khớp với mã và số điện thoại này.</div>}
        {res && (
          <div className={cancelled ? 'alert ok' : 'pub-result'}>
            {cancelled && <p>Đã huỷ lịch hẹn.</p>}
            <p>
              <strong>{res.givenName}</strong> · {STATUS_LABEL[res.status] ?? res.status}
              <br />
              {PERIOD_LABEL[res.period]} · {fmtDay(res.visitDate)} · {res.servicePointName}
            </p>
            {res.status === 'booked' && (
              <button type="button" className="danger" disabled={busy} onClick={() => void run('cancel')}>
                Huỷ lịch này
              </button>
            )}
          </div>
        )}
      </form>
    </PublicShell>
  );
}

// ---------------------------------------------------------------------------
// Tab "Lịch hẹn" (nhân viên)
// ---------------------------------------------------------------------------
interface Booking {
  bookingId: string; servicePointId: string; servicePointCode: string; servicePointName: string; visitDate: string; period: Period;
  familyName: string; givenName: string; birthDate: string; sex: string; phone: string; nationalId: string | null; reason: string | null;
  status: string; patientId: string | null; ticketId: string | null; checkedInAt: string | null; cancelledBy: string | null; createdAt: string;
}
interface Candidate { patientId: string; mrn: string; familyName: string; givenName: string; birthDate: string | null; matchedBy: string[] }
interface Found { booking: Booking; candidates: Candidate[] }
interface IssuedTicket { displayNo: string; servicePointName: string; priorityReason: string | null; issuedAt: string }

const MATCH_LABEL: Record<string, string> = {
  national_id: 'trùng CCCD',
  phone_birthdate: 'trùng SĐT + ngày sinh',
  name_birthdate: 'trùng họ tên + ngày sinh',
  phone: 'chỉ trùng SĐT — có thể là người nhà',
};
/** Mức tin cậy để tô màu / chọn sẵn: CCCD hoặc SĐT + ngày sinh là "mạnh"; chỉ tên hoặc chỉ SĐT phải kiểm tra bằng giấy tờ. */
const strong = (c: Candidate) => c.matchedBy.includes('national_id') || c.matchedBy.includes('phone_birthdate');
/** Chọn sẵn hồ sơ chỉ khi đúng MỘT hồ sơ khớp mạnh; không có khớp nào => tạo mới; còn lại để lễ tân tự chọn. */
function defaultChoice(cs: Candidate[]): string {
  const s = cs.filter(strong);
  if (s.length === 1) return s[0]!.patientId;
  return cs.length === 0 ? 'new' : '';
}
const vnToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
function ageOf(birthDate: string): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  const now = new Date();
  let a = now.getFullYear() - y!;
  if (now.getMonth() + 1 < m! || (now.getMonth() + 1 === m! && now.getDate() < d!)) a--;
  return a;
}

export function BookingsScreen() {
  const { orgId, roles } = useSession();
  const canManage = roles.has('clinic_admin') || roles.has('tenant_admin');
  const isStaff = roles.has('clinic_staff') || roles.has('clinic_admin');
  const [date, setDate] = useState(vnToday());
  const list = useLoad(
    () => (isStaff ? api<{ bookings: Booking[] }>('GET', `/api/bookings?organization=${orgId}&date=${date}`).then((r) => r.data.bookings) : Promise.resolve([] as Booking[])),
    [orgId, date, isStaff],
  );
  const denied = list.error instanceof ApiError && list.error.status === 403;
  const [code, setCode] = useState('');
  const codeRef = useRef<HTMLInputElement | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [notFound, setNotFound] = useState(false);

  const lookup = useAction(async () => {
    setNotFound(false);
    setFound(null);
    try {
      const r = await api<Found>('GET', `/api/bookings/by-code?organization=${orgId}&code=${encodeURIComponent(code.trim())}`);
      setFound(r.data);
      codeRef.current?.select(); // lượt quét tiếp theo ghi đè mã cũ
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else throw e;
    }
  });
  const open = useAction(async (b: Booking) => {
    const r = await api<Found>('GET', `/api/bookings/${b.bookingId}`);
    setFound(r.data);
    setNotFound(false);
    scrollTo({ top: 0, behavior: 'smooth' });
  });
  const cancel = useAction(async (b: Booking) => {
    if (!confirm(`Huỷ lịch hẹn của ${b.familyName} ${b.givenName}?`)) return;
    await api('POST', `/api/bookings/${b.bookingId}/cancel`);
    if (found?.booking.bookingId === b.bookingId) setFound(null);
    list.reload();
  });

  const rows = list.data ?? [];
  const active = rows.filter((b) => b.status === 'booked').length;

  return (
    <div className="stack">
      {isStaff && !denied && (
        <Card title="Check-in lịch hẹn online">
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup.run();
            }}
          >
            <Field label="Mã đặt lịch" hint="Quét mã QR bằng máy quét, hoặc gõ mã người bệnh đọc (vd. ABCD-2345)">
              <input
                required autoFocus ref={codeRef} className="code-input" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={9}
                value={code} onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <button type="submit" disabled={lookup.busy}>Tìm</button>
          </form>
          {notFound && <Notice kind="warn">Không có lịch hẹn nào với mã này tại cơ sở. Kiểm tra lại mã, hoặc tìm theo tên trong danh sách bên dưới.</Notice>}
          <ErrorBox error={lookup.error ?? open.error} />
          {found && (
            <CheckInPanel
              key={found.booking.bookingId}
              found={found}
              onDone={() => list.reload()}
              onClose={() => {
                setFound(null);
                setCode('');
                setTimeout(() => codeRef.current?.focus(), 0); // sẵn sàng cho lượt quét tiếp theo
              }}
            />
          )}
        </Card>
      )}

      <Card title="Lịch hẹn theo ngày" actions={<button className="link" onClick={list.reload}>Tải lại</button>}>
        {denied ? (
          <Notice kind="warn">Bạn không có quyền xem lịch hẹn online.</Notice>
        ) : !isStaff ? (
          <Notice>Lịch hẹn online do lễ tân / quản lý phòng khám xử lý.</Notice>
        ) : (
          <>
            <div className="row wrap">
              <Field label="Ngày">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value || vnToday())} />
              </Field>
              <span className="muted">{rows.length} lịch · {active} chưa check-in</span>
            </div>
            <ErrorBox error={list.error ?? cancel.error} />
            {list.data && rows.length === 0 && <p className="muted">Không có lịch hẹn nào.</p>}
            {rows.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Buổi</th>
                    <th>Phòng</th>
                    <th>Họ tên</th>
                    <th>Ngày sinh</th>
                    <th>SĐT</th>
                    <th>Trạng thái</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.bookingId} className={b.status === 'booked' ? '' : 'muted-row'}>
                      <td>{b.period === 'morning' ? 'Sáng' : 'Chiều'}</td>
                      <td>{b.servicePointCode}</td>
                      <td>
                        {b.familyName} {b.givenName}
                        {b.reason && <div className="muted small">{b.reason}</div>}
                      </td>
                      <td>{fmtDob(b.birthDate)}</td>
                      <td><Reveal masked={b.phone} target={{ kind: 'booking', id: b.bookingId, field: 'phone' }} allowed={can.revealPii(roles)} /></td>
                      <td>
                        {STATUS_LABEL[b.status] ?? b.status}
                        {b.status === 'cancelled' && b.cancelledBy && <span className="muted"> ({b.cancelledBy === 'patient' ? 'người bệnh' : 'lễ tân'})</span>}
                      </td>
                      <td className="actions">
                        {b.status === 'booked' && (
                          <>
                            <button className="link" onClick={() => void open.run(b)} disabled={open.busy}>Check-in</button>
                            <button className="link danger" onClick={() => void cancel.run(b)} disabled={cancel.busy}>Huỷ</button>
                          </>
                        )}
                        {b.patientId && <a href={`#/patients/${b.patientId}`}>Hồ sơ</a>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>

      {isStaff && !denied && <PortalRequestsCard />}
      {canManage && <BookingSettings />}
    </div>
  );
}

function CheckInPanel({ found, onDone, onClose }: { found: Found; onDone: () => void; onClose: () => void }) {
  const { orgId, roles } = useSession();
  const b = found.booking;
  const today = vnToday();
  const age = ageOf(b.birthDate);
  const suggested = age < 6 ? 'child_under_6' : age >= 75 ? 'elderly_75' : '';
  const [choice, setChoice] = useState<string>(() => defaultChoice(found.candidates));
  const [mrn, setMrn] = useState('');
  const [reason, setReason] = useState(suggested);
  const [ticket, setTicket] = useState<IssuedTicket | null>(null);
  // Thu tạm ứng cùng lúc check-in (tuỳ chọn; số tiền mặc định do quản lý cài, thường 500.000đ).
  const { orgId: org, me } = useSession();
  const orgName = me.memberships.find((m) => m.organization.organizationId === org)?.organization.name ?? '';
  const settings = useSettings();
  const shift = useMyShift();
  const financeDenied = settings.error instanceof ApiError && settings.error.status === 403;
  const [depositOn, setDepositOn] = useState(false);
  // Sau check-in: lễ tân vẫn thu tạm ứng được (nút "Thu tạm ứng" trên phiếu số).
  const [lateDeposit, setLateDeposit] = useState(false);
  const [draft, setDraft] = useState<ReceiptDraft>({ kind: 'deposit', method: 'cash', amount: null, reference: '', payerName: '' });
  useEffect(() => {
    if (settings.data) setDraft((d) => (d.amount === null ? { ...d, amount: settings.data!.depositDefault || null } : d));
  }, [settings.data]);
  const [depKey] = useIntentKey([draft.method, draft.amount, draft.reference, draft.payerName]);
  const [checkedIn, setCheckedIn] = useState<{ patientId: string; mrn: string } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // Hồ sơ vừa tạo ở lần bấm trước (check-in lỗi rồi thử lại): nhớ mã do hệ thống cấp.
  const [created, setCreated] = useState<{ patientId: string; mrn: string } | null>(null);
  const chosenMrn =
    created && choice === created.patientId ? created.mrn : choice === 'new' ? mrn.trim() : (found.candidates.find((c) => c.patientId === choice)?.mrn ?? '');

  const collect = useAction(async (patientId: string) => {
    const body = receiptBody(draft);
    if (!body) throw new Error('Nhập số tiền tạm ứng.');
    if (body.method !== 'cash' && !body.reference) throw new Error('Chuyển khoản / thẻ cần mã tham chiếu.');
    const r = await api<{ receipt: Receipt }>('POST', '/api/finance/receipts', {
      headers: { 'idempotency-key': depKey }, body: { organizationId: org, patientId, ...body },
    });
    setReceipt(r.data.receipt);
    shift.reload();
  });

  const go = useAction(async () => {
    if (depositOn) {
      const body = receiptBody(draft);
      if (!body) throw new Error('Nhập số tiền tạm ứng (hoặc bỏ chọn "Thu tạm ứng").');
      if (body.method !== 'cash' && !body.reference) throw new Error('Chuyển khoản / thẻ cần mã tham chiếu.');
    }
    let patientId = choice;
    let newMrn: string | null = null;
    if (choice === 'new') {
      // F16: tạo hồ sơ ở server từ chính lịch hẹn — SĐT / CCCD được giải mã và mã hoá lại trong server,
      // không đi qua trình duyệt. Bỏ trống mã => hệ thống tự sinh (HCOS-F13); chỉ gửi khi lễ tân chọn "Dùng mã cũ".
      const pt = (await api<{ patientId: string; mrn: string }>('POST', `/api/bookings/${b.bookingId}/register`, { body: mrn.trim() ? { mrn: mrn.trim() } : {} })).data;
      patientId = pt.patientId;
      newMrn = pt.mrn;
      setCreated({ patientId, mrn: newMrn });
      setChoice(patientId); // check-in lỗi rồi thử lại => không tạo hồ sơ lần hai
    }
    const mrnNow = newMrn ?? chosenMrn;
    const r = await api<{ ticket: IssuedTicket }>('POST', `/api/bookings/${b.bookingId}/check-in`, { body: { patientId, priorityReason: reason || null } });
    setTicket(r.data.ticket);
    setCheckedIn({ patientId, mrn: mrnNow });
    onDone();
    // Tạm ứng là phiếu riêng: lỗi (vd. chuyển khoản chưa về) không làm mất số đã cấp; thử lại dùng cùng Idempotency-Key.
    if (depositOn) void collect.run(patientId);
  });
  const e = go.error;
  const dup = e instanceof ApiError && e.status === 409 && !e.detail;
  const queued = e instanceof ApiError && e.detail === 'PATIENT_ALREADY_QUEUED';

  if (ticket) {
    return (
      <div className="row wrap top">
        <div className="print-ticket">
          <div className="pt-org">Phiếu số thứ tự · đặt lịch online</div>
          <div className="pt-no">{ticket.displayNo}</div>
          <div className="pt-room">{ticket.servicePointName}</div>
          {ticket.priorityReason && <div className="pt-priority">ƯU TIÊN · {PRIORITY_LABEL[ticket.priorityReason]}</div>}
          <div className="pt-name">{b.familyName} {b.givenName}</div>
          {checkedIn?.mrn && <div className="pt-mrn">Mã BN: {checkedIn.mrn}</div>}
          <div className="pt-time">{fmtDateTime(ticket.issuedAt)}</div>
        </div>
        {receipt && <PrintReceipt r={receipt} patient={{ mrn: checkedIn?.mrn ?? '', name: `${b.familyName} ${b.givenName}` }} orgName={orgName} />}
        <div className="stack">
          <button onClick={() => printOnly('ticket')}>In phiếu số</button>
          {receipt && <button onClick={() => printOnly('receipt')}>In phiếu thu tạm ứng</button>}
          {!receipt && !financeDenied && checkedIn && (depositOn ? (
            <>
              {collect.busy && <span className="muted">Đang lập phiếu thu tạm ứng…</span>}
              <FinanceError error={collect.error} />
              {collect.error != null && (
                <button className="secondary" disabled={collect.busy} onClick={() => void collect.run(checkedIn.patientId)}>Thu lại tạm ứng</button>
              )}
            </>
          ) : shift.data === null ? (
            <p className="muted small">Thu tạm ứng: bạn chưa mở ca thu ngân (mở ở tab <a href="#/finance">Thu ngân</a>, rồi bấm "Thu tạm ứng" ở đây).{' '}
              <button type="button" className="link" onClick={() => shift.reload()}>Kiểm tra lại</button></p>
          ) : shift.data && !lateDeposit ? (
            <button className="secondary" onClick={() => setLateDeposit(true)}>
              Thu tạm ứng{draft.amount ? ` ${fmtVnd(draft.amount)}` : ''}
            </button>
          ) : shift.data ? (
            <form
              className="stack deposit"
              onSubmit={(ev) => {
                ev.preventDefault();
                void collect.run(checkedIn.patientId);
              }}
            >
              <ReceiptFields draft={draft} set={setDraft} settings={settings.data} mrn={checkedIn.mrn || 'BN'} fixedKind />
              <FinanceError error={collect.error} />
              <div className="row">
                <button type="submit" disabled={collect.busy || !draft.amount}>
                  {collect.busy ? 'Đang lập phiếu…' : `Lập phiếu thu tạm ứng${draft.amount ? ` ${fmtVnd(draft.amount)}` : ''}`}
                </button>
                <button type="button" className="link" disabled={collect.busy} onClick={() => setLateDeposit(false)}>Thôi</button>
              </div>
            </form>
          ) : null)}
          <button className="link" onClick={onClose}>Xong</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack checkin">
      <div className="grid2 kv">
        <div><span className="muted">Người khám</span><strong>{b.familyName} {b.givenName}</strong></div>
        <div><span className="muted">Ngày sinh · giới</span>{fmtDob(b.birthDate)} ({age} tuổi) · {SEX_LABEL[b.sex] ?? b.sex}</div>
        <div><span className="muted">SĐT</span><Reveal masked={b.phone} target={{ kind: 'booking', id: b.bookingId, field: 'phone' }} allowed={can.revealPii(roles)} /></div>
        <div><span className="muted">CCCD</span><Reveal masked={b.nationalId} target={{ kind: 'booking', id: b.bookingId, field: 'nationalId' }} allowed={can.revealPii(roles)} /></div>
        <div><span className="muted">Lịch</span>{PERIOD_LABEL[b.period]} · {fmtDay(b.visitDate)} · {b.servicePointCode} {b.servicePointName}</div>
        <div><span className="muted">Lý do</span>{b.reason ?? '—'}</div>
      </div>

      {b.status !== 'booked' ? (
        <Notice kind="warn">Lịch này {STATUS_LABEL[b.status]?.toLowerCase() ?? b.status}{b.checkedInAt ? ` lúc ${fmtDateTime(b.checkedInAt)}` : ''}.</Notice>
      ) : b.visitDate !== today ? (
        <Notice kind="warn">Lịch hẹn cho {fmtDay(b.visitDate)} — chỉ check-in được đúng ngày khám.</Notice>
      ) : (
        <form
          className="stack"
          onSubmit={(ev) => {
            ev.preventDefault();
            void go.run();
          }}
        >
          <fieldset>
            <legend>Hồ sơ bệnh nhân</legend>
            {found.candidates.map((c) => (
              <label key={c.patientId} className="radio">
                <input type="radio" name="pt" checked={choice === c.patientId} onChange={() => setChoice(c.patientId)} />
                <span>
                  <strong>{c.mrn}</strong> · {c.familyName} {c.givenName} · {fmtDob(c.birthDate)}{' '}
                  <span className={`badge ${strong(c) ? 'match-strong' : 'match-weak'}`}>{c.matchedBy.map((m) => MATCH_LABEL[m] ?? m).join(', ')}</span>
                  {c.birthDate && c.birthDate !== b.birthDate && <span className="badge priority">ngày sinh khác lịch đặt</span>}
                </span>
              </label>
            ))}
            {found.candidates.length === 0 && <p className="muted">Không thấy hồ sơ cũ nào trùng CCCD / họ tên + ngày sinh / SĐT + ngày sinh.</p>}
            <label className="radio">
              <input type="radio" name="pt" checked={choice === 'new'} onChange={() => setChoice('new')} />
              <span>Tạo hồ sơ mới từ thông tin đặt lịch</span>
            </label>
            {choice === 'new' && <MrnField value={mrn} onChange={setMrn} />}
            {found.candidates.length > 0 && !found.candidates.some(strong) && choice !== 'new' && (
              <Notice kind="warn">Chỉ trùng tên hoặc chỉ trùng SĐT — đối chiếu CCCD / giấy tờ trước khi chọn, vì nhiều người trùng tên và ngày sinh, hoặc dùng chung SĐT với người nhà.</Notice>
            )}
            {found.candidates.length > 0 && choice === 'new' && (
              <Notice kind="warn">Có hồ sơ có thể là cùng người ở trên — kiểm tra kỹ trước khi tạo hồ sơ mới để tránh trùng.</Notice>
            )}
          </fieldset>
          <div className="row wrap">
            <Field label="Ưu tiên" hint={suggested && reason === suggested ? `gợi ý theo tuổi (${age})` : undefined}>
              <select value={reason} onChange={(ev) => setReason(ev.target.value)}>
                <option value="">Không</option>
                {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            <button type="submit" disabled={go.busy || !choice}>
              {go.busy ? 'Đang xử lý…' : `Check-in & cấp số ${b.servicePointCode}${depositOn && draft.amount ? ' + thu tạm ứng' : ''}`}
            </button>
            <button type="button" className="link" onClick={onClose}>Đóng</button>
          </div>
          {!financeDenied && (
            <div className="deposit">
              {shift.data === null ? (
                <p className="muted small">Thu tạm ứng: bạn chưa mở ca thu ngân (mở ở tab <a href="#/finance">Thu ngân</a>).</p>
              ) : shift.data ? (
                <>
                  <label className="radio">
                    <input type="checkbox" checked={depositOn} onChange={(ev) => setDepositOn(ev.target.checked)} />
                    <span>Thu tạm ứng {draft.amount ? <strong>{fmtVnd(draft.amount)}</strong> : null} cùng lúc check-in</span>
                  </label>
                  {depositOn && <ReceiptFields draft={draft} set={setDraft} settings={settings.data} mrn={chosenMrn || 'BN'} fixedKind />}
                </>
              ) : null}
            </div>
          )}
          {queued ? (
            <Notice kind="warn">Bệnh nhân này đã có số đang chờ hôm nay. Xem tab Hàng đợi (huỷ số cũ nếu cần).</Notice>
          ) : dup ? (
            <Notice kind="warn">Không tạo được hồ sơ mới: trùng MRN, CCCD hoặc họ tên + ngày sinh với hồ sơ đã có. Hãy chọn hồ sơ cũ hoặc dùng MRN khác.</Notice>
          ) : (
            <ErrorBox error={e} />
          )}
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cài đặt đặt lịch (quản lý)
// ---------------------------------------------------------------------------
interface Portal { portalId: string; slug: string; isActive: boolean; version: number }
type SpWithCap = ServicePoint;

function BookingSettings() {
  const { orgId } = useSession();
  const sps = useServicePoints();
  const portal = useLoad(() => api<{ portal: Portal | null }>('GET', `/api/booking-portal?organization=${orgId}`).then((r) => r.data.portal), [orgId]);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [slug, setSlug] = useState('');

  const saveCap = useAction(async (s: SpWithCap) => {
    const v = Number(caps[s.servicePointId] ?? s.bookingCapacity);
    await api('POST', `/api/service-points/${s.servicePointId}/booking-capacity`, { headers: { 'if-match': `W/"${s.version}"` }, body: { capacity: v } });
    setCaps((c) => {
      const n = { ...c };
      delete n[s.servicePointId];
      return n;
    });
    sps.reload();
  });
  const createPortal = useAction(async () => {
    await api('POST', '/api/booking-portal', { body: { organizationId: orgId, slug: slug.trim().toLowerCase() } });
    portal.reload();
  });
  const togglePortal = useAction(async (p: Portal) => {
    await api('POST', '/api/booking-portal/active', { headers: { 'if-match': `W/"${p.version}"` }, body: { organizationId: orgId, isActive: !p.isActive } });
    portal.reload();
  });
  const slugTaken = createPortal.error instanceof ApiError && createPortal.error.detail === 'SLUG_TAKEN';
  const url = portal.data ? `${location.origin}/app/#/book/${portal.data.slug}` : '';

  return (
    <Card title="Cài đặt đặt lịch online">
      <h3>Đường dẫn đặt lịch</h3>
      {portal.data ? (
        <>
          <p>
            <code className="select-all">{url}</code> · {portal.data.isActive ? 'đang nhận đặt lịch' : <span className="muted">đang tạm ngừng</span>}{' '}
            <button className="link" onClick={() => void togglePortal.run(portal.data!)} disabled={togglePortal.busy}>
              {portal.data.isActive ? 'Tạm ngừng' : 'Mở lại'}
            </button>
          </p>
          <p className="muted">Đăng đường dẫn này lên website / fanpage / mã QR tại quầy. Người bệnh không cần tài khoản.</p>
          <h3>Cổng bệnh nhân</h3>
          <p>
            <code className="select-all">{`${location.origin}/app/portal.html#/portal/${portal.data.slug}`}</code>
          </p>
          <p className="muted">
            Người bệnh đăng nhập bằng mã OTP (SĐT trong hồ sơ, hoặc mã BN + ngày sinh) để xem các lần khám đã hoàn tất, phiếu thu, đặt / huỷ lịch, gửi yêu cầu.
            Người giám hộ được liên kết tại trang bệnh nhân sau khi đối chiếu giấy tờ.
          </p>
        </>
      ) : (
        portal.data === null && (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void createPortal.run();
            }}
          >
            <Field label="Tên đường dẫn" hint="3–40 ký tự a-z, 0-9, dấu gạch (vd. phong-kham-an-binh)">
              <input required pattern="[a-z0-9][a-z0-9\-]{2,39}" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
            </Field>
            <button type="submit" disabled={createPortal.busy}>Tạo đường dẫn</button>
          </form>
        )
      )}
      {slugTaken ? <Notice kind="warn">Tên đường dẫn đã được dùng, chọn tên khác.</Notice> : <ErrorBox error={createPortal.error ?? togglePortal.error ?? portal.error} />}

      <h3>Số chỗ đặt online mỗi buổi</h3>
      <p className="muted">0 = phòng không nhận đặt online. Buổi sáng đóng nhận lịch lúc 11:00, buổi chiều lúc 16:00 (giờ VN); không nhận Chủ nhật; đặt trước tối đa 14 ngày.</p>
      {(sps.data as SpWithCap[] | undefined)?.map((s) => (
        <form
          key={s.servicePointId}
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void saveCap.run(s);
          }}
        >
          <span className="cap-name">
            <strong>{s.code}</strong> · {s.name} {s.isActive ? '' : <span className="muted">(ngừng)</span>}
          </span>
          <input
            type="number" className="short" min={0} max={500} aria-label={`Số chỗ ${s.code}`}
            value={caps[s.servicePointId] ?? String(s.bookingCapacity)}
            onChange={(e) => setCaps({ ...caps, [s.servicePointId]: e.target.value })}
          />
          <button type="submit" className="secondary" disabled={saveCap.busy || (caps[s.servicePointId] ?? String(s.bookingCapacity)) === String(s.bookingCapacity)}>
            Lưu
          </button>
        </form>
      ))}
      <ErrorBox error={saveCap.error ?? sps.error} />
    </Card>
  );
}
