/**
 * HCOS-F20 | Cổng bệnh nhân — bundle riêng, nhẹ, ưu tiên điện thoại (portal.html).
 *   #/portal/<slug>   đăng nhập OTP (SĐT hoặc mã BN + ngày sinh) => hồ sơ bản thân + người phụ thuộc
 *   #/s/<token>       bác sĩ tuyến trên xem MỘT đợt khám được chia sẻ (nhập PIN 6 số). Token nằm trong fragment => không gửi lên máy chủ qua URL.
 * Không dùng OIDC / token nhân viên; không import từ packages/.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  errorText, papi, PortalApiError, storeSession, storedSession,
  type BookingOptions, type EncounterDetail, type Me, type Overview, type Period, type Profile, type Requests, type Share,
} from './portal/api';

declare const __HCOS_ENV_LABEL__: string;
const ENV_LABEL = __HCOS_ENV_LABEL__;

const PERIOD: Record<Period, string> = { morning: 'Sáng', afternoon: 'Chiều' };
const BOOKING_STATUS: Record<string, string> = { booked: 'Đã đặt', checked_in: 'Đã tiếp nhận', cancelled: 'Đã huỷ', no_show: 'Không đến', completed: 'Đã khám' };
const RECEIPT_KIND: Record<string, string> = { deposit: 'Tạm ứng', payment: 'Thanh toán', refund: 'Hoàn tiền' };
const METHOD: Record<string, string> = { cash: 'Tiền mặt', bank_transfer: 'Chuyển khoản', card: 'Thẻ' };
const RELATION: Record<string, string> = { parent: 'Con (bạn là cha / mẹ)', legal_guardian: 'Người được giám hộ', child: 'Cha / mẹ', spouse: 'Vợ / chồng', sibling: 'Anh / chị / em', other: 'Người thân' };
const REQ_STATUS: Record<string, string> = { open: 'Đang chờ xử lý', resolved: 'Đã xử lý', rejected: 'Không chấp nhận', pending: 'Đang chờ duyệt', completed: 'Đã xoá', deferred: 'Hoãn (còn thời hạn lưu trữ bắt buộc)' };

const dateVn = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00+07:00`) : new Date(iso);
  return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
};
const timeVn = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(iso));
const money = (n: number): string => `${new Intl.NumberFormat('vi-VN').format(n)} đ`;

// ---------------------------------------------------------------------------
// Khung giao diện
// ---------------------------------------------------------------------------
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true }));
    fn().then((data) => live && set({ data, loading: false }), (error: unknown) => live && set({ error, loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

const Loading = ({ on }: { on: boolean }) => (on ? <p className="p-muted" role="status">Đang tải…</p> : null);
function Err({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="p-err" role="alert">{errorText(error)}</p>;
}
function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="p-card">
      <div className="p-card-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
function Frame({ org, children, onLogout }: { org?: string; children: ReactNode; onLogout?: () => void }) {
  return (
    <>
      {ENV_LABEL && <div className="p-env" role="alert">{ENV_LABEL}</div>}
      <header className="p-top">
        <div>
          <div className="p-brand">Cổng bệnh nhân</div>
          {org && <div className="p-org">{org}</div>}
        </div>
        {onLogout && <button className="p-link" onClick={onLogout}>Đăng xuất</button>}
      </header>
      <main className="p-main">{children}</main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Đăng nhập
// ---------------------------------------------------------------------------
function Login({ slug, onToken }: { slug: string; onToken: (t: string) => void }) {
  const info = useAsync(() => papi<{ organizationName: string; enabled: boolean; training: boolean }>('GET', `/api/portal/${slug}/info`), [slug]);
  const [method, setMethod] = useState<'phone' | 'mrn'>('phone');
  const [phone, setPhone] = useState('');
  const [mrn, setMrn] = useState('');
  const [birth, setBirth] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; trainingCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = method === 'phone' ? { method, phone } : { method, mrn, birthDate: birth };
      const r = await papi<{ challengeId: string; trainingCode?: string }>('POST', `/api/portal/${slug}/otp`, body);
      setChallenge({ id: r.challengeId, trainingCode: r.trainingCode });
      setCode('');
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const r = await papi<{ token: string }>('POST', `/api/portal/${slug}/session`, { challengeId: challenge.id, code });
      onToken(r.token);
    } catch (x) {
      setError(x);
      if (x instanceof PortalApiError && (x.reason === 'OTP_EXPIRED' || x.reason === 'LOGIN_LOCKED')) setChallenge(null);
    } finally {
      setBusy(false);
    }
  };

  if (info.loading) return <Frame><p className="p-muted">Đang tải…</p></Frame>;
  if (info.error) return <Frame><Err error={info.error} /></Frame>;
  const i = info.data!;
  return (
    <Frame org={i.organizationName}>
      {!i.enabled ? (
        <p className="p-warn">Cơ sở chưa mở đăng nhập cổng bệnh nhân. Bạn vẫn có thể <a href={`index.html#/book/${slug}`}>đặt lịch khám online</a>.</p>
      ) : !challenge ? (
        <form className="p-card" onSubmit={send}>
          <h2>Đăng nhập</h2>
          <div className="p-seg" role="tablist">
            <button type="button" role="tab" aria-selected={method === 'phone'} className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>Số điện thoại</button>
            <button type="button" role="tab" aria-selected={method === 'mrn'} className={method === 'mrn' ? 'on' : ''} onClick={() => setMethod('mrn')}>Mã bệnh nhân</button>
          </div>
          {method === 'phone' ? (
            <label className="p-field">
              <span>Số điện thoại đã đăng ký tại cơ sở</span>
              <input inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09xx xxx xxx" />
            </label>
          ) : (
            <>
              <label className="p-field">
                <span>Mã bệnh nhân (in trên phiếu khám)</span>
                <input required autoCapitalize="characters" value={mrn} onChange={(e) => setMrn(e.target.value)} placeholder="BN26-000123-5" />
              </label>
              <label className="p-field">
                <span>Ngày sinh</span>
                <input type="date" required value={birth} onChange={(e) => setBirth(e.target.value)} />
              </label>
            </>
          )}
          <p className="p-hint">
            {method === 'phone'
              ? 'Nếu nhiều người trong gia đình dùng chung số này, hãy đăng nhập bằng mã bệnh nhân.'
              : 'Mã xác thực được gửi tới số điện thoại trong hồ sơ.'}
          </p>
          <Err error={error} />
          <button className="p-btn" disabled={busy}>{busy ? 'Đang gửi…' : 'Gửi mã xác thực'}</button>
        </form>
      ) : (
        <form className="p-card" onSubmit={verify}>
          <h2>Nhập mã xác thực</h2>
          <p className="p-hint">Nếu thông tin khớp với hồ sơ, mã 6 số đã được gửi tới số điện thoại của bạn (hiệu lực 5 phút).</p>
          {challenge.trainingCode && (
            <p className="p-training" role="status">
              MÔI TRƯỜNG THỰC TẬP — không gửi tin nhắn thật. Mã của bạn: <b>{challenge.trainingCode}</b>
            </p>
          )}
          <label className="p-field">
            <span>Mã 6 số</span>
            <input className="p-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <Err error={error} />
          <button className="p-btn" disabled={busy || code.length !== 6}>{busy ? 'Đang kiểm tra…' : 'Đăng nhập'}</button>
          <div className="p-row">
            <button type="button" className="p-link" onClick={() => void send()} disabled={busy}>Gửi lại mã</button>
            <button type="button" className="p-link" onClick={() => setChallenge(null)}>Đổi thông tin</button>
          </div>
        </form>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Trong phiên
// ---------------------------------------------------------------------------
type Tab = 'visits' | 'bookings' | 'receipts' | 'account';
interface Ctx { token: string; me: Me; profile: Profile; onExpired: () => void; reloadMe: () => void }

function PortalApp({ slug, token, onLogout }: { slug: string; token: string; onLogout: () => void }) {
  const me = useAsync(() => papi<Me>('GET', '/api/portal/me', undefined, token), [token]);
  const [pid, setPid] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('visits');
  const [visit, setVisit] = useState<string | null>(null);
  const expired = me.error instanceof PortalApiError && me.error.status === 401;
  useEffect(() => {
    if (expired) onLogout();
  }, [expired, onLogout]);
  const logout = useCallback(async () => {
    await papi('POST', '/api/portal/logout', {}, token).catch(() => undefined);
    onLogout();
  }, [token, onLogout]);
  if (me.loading && !me.data) return <Frame><p className="p-muted">Đang tải hồ sơ…</p></Frame>;
  if (!me.data) return <Frame onLogout={onLogout}><Err error={me.error} /></Frame>;
  const m = me.data;
  const profile = m.profiles.find((p) => p.personId === pid) ?? m.profiles[0]!;
  const ctx: Ctx = { token, me: m, profile, onExpired: onLogout, reloadMe: me.reload };
  void slug;
  return (
    <Frame org={m.organizationName} onLogout={() => void logout()}>
      {m.profiles.length > 1 && (
        <div className="p-profiles" role="tablist" aria-label="Hồ sơ">
          {m.profiles.map((p) => (
            <button key={p.personId} role="tab" aria-selected={p.personId === profile.personId} className={p.personId === profile.personId ? 'on' : ''}
              onClick={() => { setPid(p.personId); setVisit(null); }}>
              <b>{p.name}</b>
              <small>{p.self ? 'Bản thân' : RELATION[p.relationship ?? 'other'] ?? 'Người thân'}</small>
            </button>
          ))}
        </div>
      )}
      <div className="p-person">
        <b>{profile.name}</b>
        <span>{dateVn(profile.birthDate)}{profile.mrns.length ? ` · ${profile.mrns.join(', ')}` : ''}</span>
        {!profile.self && profile.validUntil && <small>Quyền xem đến hết ngày {dateVn(addDay(profile.validUntil, -1))}</small>}
      </div>
      {visit ? (
        <Visit ctx={ctx} encounterId={visit} onBack={() => setVisit(null)} />
      ) : (
        <>
          {tab === 'visits' && <Visits ctx={ctx} onOpen={setVisit} />}
          {tab === 'bookings' && <Bookings ctx={ctx} />}
          {tab === 'receipts' && <Receipts ctx={ctx} />}
          {tab === 'account' && <Account ctx={ctx} />}
        </>
      )}
      <nav className="p-tabs">
        {([['visits', 'Khám bệnh'], ['bookings', 'Lịch hẹn'], ['receipts', 'Phiếu thu'], ['account', 'Tài khoản']] as const).map(([k, label]) => (
          <button key={k} className={tab === k && !visit ? 'on' : ''} onClick={() => { setTab(k); setVisit(null); }}>{label}</button>
        ))}
      </nav>
    </Frame>
  );
}
const addDay = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function useOverview(ctx: Ctx) {
  const r = useAsync(() => papi<Overview>('GET', `/api/portal/profiles/${ctx.profile.personId}`, undefined, ctx.token), [ctx.profile.personId, ctx.token]);
  useEffect(() => {
    if (r.error instanceof PortalApiError && r.error.status === 401) ctx.onExpired();
  }, [r.error, ctx]);
  return r;
}

function Visits({ ctx, onOpen }: { ctx: Ctx; onOpen: (id: string) => void }) {
  const ov = useOverview(ctx);
  return (
    <Section title="Các lần khám">
      <Loading on={ov.loading && !ov.data} />
      <Err error={ov.error} />
      {ov.data && ov.data.encounters.length === 0 && <p className="p-muted">Chưa có lần khám nào đã hoàn tất.</p>}
      <ul className="p-list">
        {ov.data?.encounters.map((e) => (
          <li key={e.encounterId}>
            <button className="p-item" onClick={() => onOpen(e.encounterId)}>
              <span className="p-item-main">
                <b>{dateVn(e.start)}</b> · {e.practitioner ?? 'Bác sĩ'}
                <small>{e.diagnoses ?? 'Chưa ghi chẩn đoán'}</small>
              </span>
              <span className="p-chev" aria-hidden>›</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="p-hint">Chỉ hiện các lần khám đã hoàn tất. Thông tin đang ghi dở trong buổi khám không hiện ở đây.</p>
    </Section>
  );
}

function EncounterView({ d }: { d: EncounterDetail }) {
  return (
    <>
      <dl className="p-dl">
        <dt>Ngày khám</dt><dd>{dateVn(d.start)}</dd>
        <dt>Cơ sở</dt><dd>{d.organizationName ?? '—'}</dd>
        <dt>Bác sĩ</dt><dd>{d.practitioner ?? '—'}</dd>
        {d.reason && <><dt>Lý do khám</dt><dd>{d.reason}</dd></>}
      </dl>
      <h3>Chẩn đoán</h3>
      {d.diagnoses.length === 0 ? <p className="p-muted">Không có.</p> : (
        <ul className="p-bullets">{d.diagnoses.map((x, i) => <li key={i}>{x.display ?? x.code} <small>({x.code})</small></li>)}</ul>
      )}
      <h3>Chỉ số</h3>
      {d.observations.length === 0 ? <p className="p-muted">Không có.</p> : (
        <table className="p-table"><tbody>
          {d.observations.map((o, i) => (
            <tr key={i}><td>{o.display ?? o.code}</td><td className="num">{o.value !== null ? `${o.value} ${o.unit ?? ''}` : o.text ?? '—'}</td></tr>
          ))}
        </tbody></table>
      )}
      <h3>Thuốc</h3>
      {d.medications.length === 0 ? <p className="p-muted">Không kê thuốc.</p> : (
        <ul className="p-meds">
          {d.medications.map((x, i) => (
            <li key={i}>
              <b>{x.name}</b>{x.form ? ` (${x.form})` : ''}
              <small>Mỗi lần {x.dose}, {x.perDay} lần/ngày, {x.days} ngày — tổng {x.quantity} {x.unit ?? ''}</small>
              {x.instructions && <small>{x.instructions}</small>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Visit({ ctx, encounterId, onBack }: { ctx: Ctx; encounterId: string; onBack: () => void }) {
  const d = useAsync(() => papi<EncounterDetail>('GET', `/api/portal/profiles/${ctx.profile.personId}/encounters/${encounterId}`, undefined, ctx.token), [encounterId]);
  const [share, setShare] = useState<{ shareToken: string; pin: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const create = async () => {
    setErr(null);
    try {
      setShare(await papi('POST', '/api/portal/shares', { personId: ctx.profile.personId, encounterId }, ctx.token));
    } catch (e) {
      setErr(e);
    }
  };
  const link = share ? `${location.origin}${location.pathname}#/s/${share.shareToken}` : '';
  return (
    <Section title="Chi tiết lần khám" actions={<button className="p-link" onClick={onBack}>‹ Quay lại</button>}>
      <Loading on={d.loading && !d.data} />
      <Err error={d.error} />
      {d.data && <EncounterView d={d.data} />}
      {d.data && (
        <div className="p-share">
          <h3>Chia sẻ cho bác sĩ khác</h3>
          {!share ? (
            <>
              <p className="p-hint">Tạo link xem riêng lần khám này, hiệu lực 24 giờ, kèm mã PIN 6 số. Gửi link và PIN qua hai kênh khác nhau (vd. link qua tin nhắn, PIN đọc qua điện thoại).</p>
              <Err error={err} />
              <button className="p-btn ghost" onClick={() => void create()}>Tạo link chia sẻ</button>
            </>
          ) : (
            <div className="p-sharebox">
              <label className="p-field"><span>Link (hết hạn {timeVn(share.expiresAt)})</span><input readOnly value={link} onFocus={(e: { target: HTMLInputElement }) => e.target.select()} /></label>
              <p>Mã PIN: <b className="p-pin">{share.pin}</b></p>
              <p className="p-warn">PIN chỉ hiện MỘT lần. Nhập sai 5 lần link sẽ bị khoá. Bạn có thể thu hồi link ở mục Tài khoản.</p>
              {typeof navigator.share === 'function' && (
                <button className="p-btn ghost" onClick={() => void navigator.share({ title: 'Kết quả khám', url: link }).catch(() => undefined)}>Gửi link…</button>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function Bookings({ ctx }: { ctx: Ctx }) {
  const ov = useOverview(ctx);
  const [form, setForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const cancel = async (bookingId: string) => {
    if (!confirm('Huỷ lịch hẹn này?')) return;
    setErr(null);
    try {
      await papi('POST', '/api/portal/bookings/cancel', { personId: ctx.profile.personId, bookingId }, ctx.token);
      setMsg('Đã huỷ lịch hẹn.');
      ov.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <>
      <Section title="Lịch hẹn" actions={!form && <button className="p-btn small" onClick={() => { setForm(true); setMsg(null); }}>Đặt lịch</button>}>
        {msg && <p className="p-ok" role="status">{msg}</p>}
        <Loading on={ov.loading && !ov.data} />
        <Err error={ov.error ?? err} />
        {ov.data && ov.data.bookings.length === 0 && <p className="p-muted">Chưa có lịch hẹn.</p>}
        <ul className="p-list">
          {ov.data?.bookings.map((b) => (
            <li key={b.bookingId} className="p-item static">
              <span className="p-item-main">
                <b>{dateVn(b.visitDate)} · {PERIOD[b.period]}</b> — {b.room}
                <small>{BOOKING_STATUS[b.status] ?? b.status}</small>
              </span>
              {b.cancellable && <button className="p-link danger" onClick={() => void cancel(b.bookingId)}>Huỷ</button>}
            </li>
          ))}
        </ul>
        <p className="p-hint">Muốn đổi lịch: đặt lịch mới rồi huỷ lịch cũ.</p>
      </Section>
      {form && <BookingForm ctx={ctx} onDone={(code) => { setForm(false); setMsg(code ? `Đặt lịch thành công. Mã lịch hẹn: ${code}` : null); ov.reload(); }} />}
    </>
  );
}

function BookingForm({ ctx, onDone }: { ctx: Ctx; onDone: (code: string | null) => void }) {
  const o = useAsync(() => papi<BookingOptions>('GET', '/api/portal/booking/options', undefined, ctx.token), [ctx.token]);
  const [room, setRoom] = useState('');
  const [slot, setSlot] = useState('');
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const roomId = room || o.data?.rooms[0]?.servicePointId || '';
  const slots = useMemo(() => (o.data?.slots ?? []).filter((s) => s.servicePointId === roomId && s.remaining > 0), [o.data, roomId]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const [visitDate, period] = slot.split('|');
    setBusy(true);
    setErr(null);
    try {
      const r = await papi<{ code: string }>('POST', '/api/portal/bookings', { personId: ctx.profile.personId, servicePointId: roomId, visitDate, period, reason: reason || undefined, consent }, ctx.token);
      onDone(r.code);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={`Đặt lịch cho ${ctx.profile.name}`} actions={<button className="p-link" onClick={() => onDone(null)}>Đóng</button>}>
      <Loading on={o.loading && !o.data} />
      <Err error={o.error} />
      {o.data && (
        <form onSubmit={submit}>
          {o.data.rooms.length > 1 && (
            <label className="p-field"><span>Phòng khám</span>
              <select value={roomId} onChange={(e) => { setRoom(e.target.value); setSlot(''); }}>
                {o.data.rooms.map((r) => <option key={r.servicePointId} value={r.servicePointId}>{r.name}</option>)}
              </select>
            </label>
          )}
          <label className="p-field"><span>Buổi khám</span>
            <select required value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">— Chọn buổi —</option>
              {slots.map((s) => <option key={`${s.date}|${s.period}`} value={`${s.date}|${s.period}`}>{dateVn(s.date)} · {PERIOD[s.period]} (còn {s.remaining} chỗ)</option>)}
            </select>
          </label>
          {slots.length === 0 && <p className="p-muted">Hiện chưa còn buổi trống.</p>}
          <label className="p-field"><span>Lý do khám (không bắt buộc)</span>
            <textarea maxLength={300} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <details className="p-consent"><summary>Điều khoản xử lý dữ liệu</summary><p>{o.data.consentText}</p></details>
          <label className="p-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Tôi đồng ý với điều khoản xử lý dữ liệu</label>
          <p className="p-hint">Họ tên, ngày sinh lấy từ hồ sơ; số điện thoại liên hệ là số của tài khoản đang đăng nhập.</p>
          <Err error={err} />
          <button className="p-btn" disabled={busy || !slot || !consent}>{busy ? 'Đang đặt…' : 'Xác nhận đặt lịch'}</button>
        </form>
      )}
    </Section>
  );
}

function Receipts({ ctx }: { ctx: Ctx }) {
  const ov = useOverview(ctx);
  return (
    <Section title="Phiếu thu">
      <Loading on={ov.loading && !ov.data} />
      <Err error={ov.error} />
      {ov.data && ov.data.receipts.length === 0 && <p className="p-muted">Chưa có phiếu thu.</p>}
      {ov.data && ov.data.receipts.length > 0 && (
        <table className="p-table">
          <thead><tr><th>Số phiếu</th><th>Ngày</th><th className="num">Số tiền</th></tr></thead>
          <tbody>
            {ov.data.receipts.map((r) => (
              <tr key={r.receiptNo}>
                <td>{r.receiptNo}<small>{RECEIPT_KIND[r.kind] ?? r.kind} · {METHOD[r.method] ?? r.method}</small></td>
                <td>{dateVn(r.at)}</td>
                <td className="num">{r.kind === 'refund' ? '−' : ''}{money(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Account({ ctx }: { ctx: Ctx }) {
  const reqs = useAsync(() => papi<Requests>('GET', '/api/portal/requests', undefined, ctx.token), [ctx.token]);
  const shares = useAsync(() => papi<Share[]>('GET', '/api/portal/shares', undefined, ctx.token), [ctx.token]);
  const names = new Map(ctx.me.profiles.map((p) => [p.personId, p.name]));
  return (
    <>
      <Contact ctx={ctx} />
      <Correction ctx={ctx} onSent={reqs.reload} />
      <Section title="Link chia sẻ">
        <Err error={shares.error} />
        {shares.data && shares.data.length === 0 && <p className="p-muted">Chưa tạo link nào. Tạo trong chi tiết một lần khám.</p>}
        <ul className="p-list">
          {shares.data?.map((s) => (
            <li key={s.shareId} className="p-item static">
              <span className="p-item-main">
                <b>{names.get(s.personId) ?? ''} · tạo {timeVn(s.createdAt)}</b>
                <small>{{ active: `Còn hiệu lực đến ${timeVn(s.expiresAt)}`, revoked: 'Đã thu hồi', locked: 'Bị khoá (sai PIN 5 lần)', expired: 'Đã hết hạn' }[s.state]} · {s.views} lượt xem</small>
              </span>
              {s.state === 'active' && (
                <button className="p-link danger" onClick={() => void papi('POST', `/api/portal/shares/${s.shareId}/revoke`, {}, ctx.token).then(shares.reload, shares.reload)}>Thu hồi</button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Yêu cầu đã gửi">
        <Err error={reqs.error} />
        {reqs.data && reqs.data.corrections.length + reqs.data.erasures.length === 0 && <p className="p-muted">Chưa có yêu cầu.</p>}
        <ul className="p-list">
          {reqs.data?.corrections.map((r) => (
            <li key={r.requestId} className="p-item static">
              <span className="p-item-main">
                <b>Đính chính · {names.get(r.personId) ?? ''} · {dateVn(r.createdAt)}</b>
                <small>{r.message}</small>
                <small>{REQ_STATUS[r.status] ?? r.status}{r.resolutionNote ? ` — ${r.resolutionNote}` : ''}</small>
              </span>
            </li>
          ))}
          {reqs.data?.erasures.map((r) => (
            <li key={r.requestId} className="p-item static">
              <span className="p-item-main">
                <b>Xoá dữ liệu · {names.get(r.personId) ?? ''} · {dateVn(r.requestedAt)}</b>
                <small>{REQ_STATUS[r.status] ?? r.status}{r.deferredUntil ? ` đến ${dateVn(r.deferredUntil)}` : ''}{r.decisionNote ? ` — ${r.decisionNote}` : ''}</small>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Erasure ctx={ctx} onSent={reqs.reload} />
    </>
  );
}

function Contact({ ctx }: { ctx: Ctx }) {
  const [phone, setPhone] = useState('');
  const [ch, setCh] = useState<{ id: string; trainingCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await fn();
    } catch (x) {
      setErr(x);
    }
  };
  if (!ctx.profile.self) {
    return <Section title="Liên hệ"><p className="p-muted">Thông tin liên hệ chỉ đổi được trên hồ sơ của chính bạn.</p></Section>;
  }
  return (
    <Section title="Liên hệ">
      <dl className="p-dl">
        <dt>Điện thoại</dt><dd>{ctx.me.contact.phoneHint ?? '—'}</dd>
        <dt>Email</dt><dd>{ctx.me.contact.emailHint ?? '—'}</dd>
      </dl>
      {msg && <p className="p-ok" role="status">{msg}</p>}
      <Err error={err} />
      {!ch ? (
        <form className="p-inline" onSubmit={run(async () => {
          const r = await papi<{ challengeId: string; trainingCode?: string }>('POST', '/api/portal/contact/phone', { phone }, ctx.token);
          setCh({ id: r.challengeId, trainingCode: r.trainingCode });
        })}>
          <label className="p-field"><span>Số điện thoại mới</span><input inputMode="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <button className="p-btn small">Gửi mã tới số mới</button>
        </form>
      ) : (
        <form className="p-inline" onSubmit={run(async () => {
          const r = await papi<{ phoneHint: string }>('POST', '/api/portal/contact/phone/confirm', { challengeId: ch.id, code }, ctx.token);
          setCh(null); setPhone(''); setCode('');
          setMsg(`Đã đổi số điện thoại thành ${r.phoneHint}. Các thiết bị khác đã bị đăng xuất.`);
          ctx.reloadMe();
        })}>
          {ch.trainingCode && <p className="p-training">MÔI TRƯỜNG THỰC TẬP — mã: <b>{ch.trainingCode}</b></p>}
          <label className="p-field"><span>Mã 6 số gửi tới số mới</span>
            <input className="p-code" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <div className="p-row">
            <button className="p-btn small" disabled={code.length !== 6}>Xác nhận</button>
            <button type="button" className="p-link" onClick={() => setCh(null)}>Huỷ</button>
          </div>
        </form>
      )}
      <form className="p-inline" onSubmit={run(async () => {
        const r = await papi<{ emailHint: string | null }>('POST', '/api/portal/contact/email', { email }, ctx.token);
        setEmail('');
        setMsg(r.emailHint ? `Đã lưu email ${r.emailHint}.` : 'Đã xoá email.');
        ctx.reloadMe();
      })}>
        <label className="p-field"><span>Email (để trống rồi Lưu = xoá email)</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <button className="p-btn small ghost">Lưu email</button>
      </form>
    </Section>
  );
}

function Correction({ ctx, onSent }: { ctx: Ctx; onSent: () => void }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Section title="Báo thông tin sai">
      <form onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await papi('POST', '/api/portal/requests/correction', { personId: ctx.profile.personId, message: text }, ctx.token);
          setText('');
          setMsg('Đã gửi. Cơ sở sẽ đối chiếu giấy tờ và phản hồi tại mục "Yêu cầu đã gửi".');
          onSent();
        } catch (x) {
          setErr(x);
        }
      }}>
        <p className="p-hint">Hồ sơ của {ctx.profile.name}. Bệnh án không sửa trực tiếp được; cơ sở sẽ kiểm tra và đính chính nếu đúng.</p>
        <label className="p-field"><span>Thông tin nào sai, đúng là gì?</span>
          <textarea rows={3} minLength={10} maxLength={2000} required value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {msg && <p className="p-ok" role="status">{msg}</p>}
        <Err error={err} />
        <button className="p-btn small">Gửi yêu cầu</button>
      </form>
    </Section>
  );
}

function Erasure({ ctx, onSent }: { ctx: Ctx; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Section title="Yêu cầu xoá dữ liệu">
      <p className="p-hint">
        Cơ sở sẽ xem xét yêu cầu xoá dữ liệu cá nhân của {ctx.profile.name}. Bệnh án phải lưu theo thời hạn pháp luật quy định nên có thể được hoãn đến khi hết hạn;
        kết quả hiện ở mục "Yêu cầu đã gửi". Khi dữ liệu bị xoá, bạn sẽ không đăng nhập cổng được nữa.
      </p>
      {msg && <p className="p-ok" role="status">{msg}</p>}
      {!open ? (
        <button className="p-btn small ghost danger" onClick={() => setOpen(true)}>Tôi muốn yêu cầu xoá dữ liệu</button>
      ) : (
        <form onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await papi('POST', '/api/portal/requests/erasure', { personId: ctx.profile.personId, note: note || undefined }, ctx.token);
            setOpen(false);
            setMsg('Đã gửi yêu cầu xoá dữ liệu.');
            onSent();
          } catch (x) {
            setErr(x);
          }
        }}>
          <label className="p-field"><span>Ghi chú (không bắt buộc)</span><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <Err error={err} />
          <div className="p-row">
            <button className="p-btn small danger">Gửi yêu cầu xoá</button>
            <button type="button" className="p-link" onClick={() => setOpen(false)}>Huỷ</button>
          </div>
        </form>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Bác sĩ tuyến trên xem link chia sẻ
// ---------------------------------------------------------------------------
function ShareView({ token }: { token: string }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [d, setD] = useState<(EncounterDetail & { expiresAt: string }) | null>(null);
  useEffect(() => {
    // Xoá token khỏi thanh địa chỉ / lịch sử sau khi đã đọc vào bộ nhớ.
    history.replaceState(null, '', `${location.pathname}#/s`);
  }, []);
  if (d) {
    return (
      <Frame org={d.organizationName ?? undefined}>
        <Section title="Kết quả khám được chia sẻ">
          <p className="p-person"><b>{d.patient.name}</b><span>{dateVn(d.patient.birthDate)}</span></p>
          <EncounterView d={d} />
          <p className="p-hint">Link hết hạn {timeVn(d.expiresAt)}. Mọi lượt xem đều được ghi lại. Không lưu / chuyển tiếp nếu không cần cho việc điều trị.</p>
        </Section>
      </Frame>
    );
  }
  return (
    <Frame>
      <form className="p-card" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          setD(await papi('POST', '/api/portal/share-view', { token, pin }));
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}>
        <h2>Xem kết quả khám</h2>
        <p className="p-hint">Người bệnh đã chia sẻ một lần khám với bạn. Nhập mã PIN 6 số người bệnh cung cấp.</p>
        <label className="p-field"><span>Mã PIN</span>
          <input className="p-code" inputMode="numeric" maxLength={6} required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </label>
        <Err error={err} />
        <button className="p-btn" disabled={busy || pin.length !== 6}>Xem</button>
      </form>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
function Root() {
  const [hash] = useState(location.hash);
  const share = /^#\/s\/(hps_[A-Za-z0-9_-]{20,60})$/.exec(hash);
  const m = /^#\/portal\/([a-z0-9][a-z0-9-]{2,39})\/?$/.exec(hash);
  const slug = m?.[1] ?? null;
  const [token, setToken] = useState<string | null>(() => (slug ? storedSession(slug) : null));
  const onToken = useCallback((t: string) => { if (slug) storeSession(slug, t); setToken(t); }, [slug]);
  const onLogout = useCallback(() => { if (slug) storeSession(slug, null); setToken(null); }, [slug]);
  if (share) return <ShareView token={share[1]!} />;
  if (!slug) {
    return <Frame><p className="p-warn">Đường dẫn không hợp lệ. Mở cổng bệnh nhân từ link cơ sở cung cấp (dạng …/portal.html#/portal/ten-co-so).</p></Frame>;
  }
  return token ? <PortalApp slug={slug} token={token} onLogout={onLogout} /> : <Login slug={slug} onToken={onToken} />;
}

addEventListener('hashchange', () => location.reload());
createRoot(document.getElementById('root')!).render(<Root />);
