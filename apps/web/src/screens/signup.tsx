/**
 * HCOS | Đăng ký tổ chức mới (khách tự đăng ký, không đăng nhập).
 *  Bốn bước: thông tin tổ chức => mã OTP qua email => đặt mật khẩu => chờ duyệt.
 *  Mỗi lần gọi start / complete cần một lời giải CAPTCHA proof-of-work, tính ngay trên trình duyệt (Web Crypto, không dịch vụ ngoài).
 *  Máy chủ quyết định mọi quy tắc; màn này kiểm tra sơ bộ để báo lỗi sớm.
 */
import { useState, type FormEvent } from 'react';

declare const __HCOS_ENV_LABEL__: string;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

class SignupApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly field?: string) {
    super(code);
    this.name = 'SignupApiError';
  }
}

const MESSAGES: Record<string, string> = {
  INVALID_INPUT: 'Thông tin chưa đúng định dạng. Kiểm tra lại các ô được đánh dấu.',
  SLUG_TAKEN: 'Đường dẫn này đã có tổ chức khác dùng. Chọn đường dẫn khác.',
  RATE_LIMITED: 'Bạn thao tác quá nhiều lần. Thử lại sau ít phút.',
  OTP_UNAVAILABLE: 'Chưa gửi được mã xác nhận qua email. Thử lại sau.',
  WRONG: 'Mã xác nhận không đúng.',
  LOCKED: 'Nhập sai quá nhiều lần. Bấm "Bắt đầu lại" để đăng ký lại.',
  EXPIRED: 'Mã đã hết hạn. Bấm "Bắt đầu lại" để đăng ký lại.',
  NOT_PENDING: 'Yêu cầu đăng ký không còn hiệu lực. Bấm "Bắt đầu lại".',
  ACCOUNT_EXISTS: 'Email này đã có tài khoản. Liên hệ bộ phận hỗ trợ nếu bạn cần giúp.',
  IDP_UNAVAILABLE: 'Hệ thống đăng nhập đang bận. Thử lại sau.',
  CAPTCHA_FAILED: 'Xác minh không thành công. Thử lại.',
  NETWORK: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  CAPTCHA: 'Không tải được thử thách xác minh. Thử lại sau.',
};

const FIELD_LABEL: Record<string, string> = {
  email: 'Email', orgName: 'Tên tổ chức', contactName: 'Họ tên người đăng ký', phone: 'Số điện thoại',
  license: 'Số giấy phép kinh doanh', slug: 'Đường dẫn', password: 'Mật khẩu', code: 'Mã xác nhận',
};

function leadingZeroBits(digest: Uint8Array): number {
  let n = 0;
  for (const b of digest) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** Lấy thử thách và tìm nonce có đủ bit 0 đầu (SHA-256 của token:nonce). */
async function solveCaptcha(): Promise<{ captchaToken: string; captchaNonce: string }> {
  let c: { token: string; bits: number };
  try {
    const r = await fetch('/api/public/captcha', { cache: 'no-store', credentials: 'omit', headers: { accept: 'application/json' } });
    if (!r.ok) throw new SignupApiError(r.status, 'CAPTCHA');
    c = (await r.json()) as { token: string; bits: number };
  } catch (e) {
    if (e instanceof SignupApiError) throw e;
    throw new SignupApiError(0, 'NETWORK');
  }
  const enc = new TextEncoder();
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${c.token}:${nonce}`)));
    if (leadingZeroBits(digest) >= c.bits) return { captchaToken: c.token, captchaNonce: nonce };
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignupApiError(0, 'NETWORK');
  }
  const data = (await r.json().catch(() => ({}))) as { error?: string; field?: string };
  if (!r.ok) throw new SignupApiError(r.status, data.error ?? 'INTERNAL', data.field);
  return data as T;
}

const errorText = (e: unknown): string => {
  if (e instanceof SignupApiError) {
    const base = MESSAGES[e.code] ?? 'Có lỗi xảy ra, vui lòng thử lại.';
    return e.field && FIELD_LABEL[e.field] ? `${base} (${FIELD_LABEL[e.field]})` : base;
  }
  return 'Có lỗi xảy ra, vui lòng thử lại.';
};

type Step = 'form' | 'otp' | 'password' | 'done';
interface Form { email: string; orgName: string; contactName: string; phone: string; license: string; slug: string }
const EMPTY: Form = { email: '', orgName: '', contactName: '', phone: '', license: '', slug: '' };

export function PublicSignupScreen() {
  const [step, setStep] = useState<Step>('form');
  const [f, setF] = useState<Form>(EMPTY);
  const [signupId, setSignupId] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneSlug, setDoneSlug] = useState('');
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'slug' ? e.target.value.trim().toLowerCase() : e.target.value });

  const restart = () => {
    setStep('form');
    setSignupId('');
    setCode('');
    setPassword('');
    setPassword2('');
    setErr(null);
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(f.email.trim())) return setErr('Email chưa đúng định dạng.');
    if (!f.orgName.trim() || !f.contactName.trim() || !f.phone.trim() || !f.license.trim()) return setErr('Vui lòng điền đủ các ô.');
    if (!SLUG_RE.test(f.slug)) return setErr('Đường dẫn: 3–30 ký tự, chữ thường không dấu, số hoặc dấu gạch ngang, không bắt đầu/kết thúc bằng "-".');
    void run(async () => {
      const cap = await solveCaptcha();
      const r = await post<{ signupId: string }>('/api/public/signup/start', { ...f, email: f.email.trim(), ...cap });
      setSignupId(r.signupId);
      setStep('otp');
    });
  };

  const submitOtp = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setErr('Mã xác nhận gồm 6 chữ số.');
    void run(async () => {
      await post('/api/public/signup/verify', { signupId, code });
      setCode('');
      setStep('password');
    });
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setErr(`Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`);
    if (password !== password2) return setErr('Hai lần nhập mật khẩu không khớp.');
    void run(async () => {
      const cap = await solveCaptcha();
      const r = await post<{ slug: string }>('/api/public/signup/complete', { signupId, password, ...cap });
      setPassword('');
      setPassword2('');
      setDoneSlug(r.slug);
      setStep('done');
    });
  };

  return (
    <div className="pub">
      {__HCOS_ENV_LABEL__ && <div className="env-banner" role="alert">{__HCOS_ENV_LABEL__}</div>}
      <header className="pub-head">
        <h1>Đăng ký tổ chức</h1>
      </header>
      <main className="pub-main">
        {step === 'form' && (
          <form className="stack" onSubmit={submitForm} noValidate>
            <p className="muted">Điền thông tin tổ chức. Chúng tôi gửi mã xác nhận đến email của bạn. Sau khi hoàn tất, hồ sơ chờ được duyệt.</p>
            <label className="field"><span className="field-label">Email (nhận mã xác nhận)</span><input type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></label>
            <label className="field"><span className="field-label">Tên tổ chức</span><input value={f.orgName} onChange={set('orgName')} maxLength={120} required /></label>
            <label className="field"><span className="field-label">Họ tên người đăng ký</span><input autoComplete="name" value={f.contactName} onChange={set('contactName')} maxLength={80} required /></label>
            <label className="field"><span className="field-label">Số điện thoại</span><input type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} maxLength={20} required /></label>
            <label className="field">
              <span className="field-label">Số giấy phép kinh doanh</span>
              <input value={f.license} onChange={set('license')} maxLength={40} required />
              <span className="field-hint">Quản trị viên đối chiếu số này khi duyệt. Không cần tải giấy tờ lên.</span>
            </label>
            <label className="field">
              <span className="field-label">Đường dẫn của tổ chức</span>
              <input value={f.slug} onChange={set('slug')} maxLength={30} placeholder="vd. phong-kham-an-binh" required />
              <span className="field-hint">Mã định danh của tổ chức trong hệ thống (3–30 ký tự, chữ thường, số, dấu gạch ngang).</span>
            </label>
            {err && <div className="alert error" role="alert">{err}</div>}
            <div className="row"><button type="submit" disabled={busy}>{busy ? 'Đang xác minh…' : 'Gửi mã xác nhận'}</button></div>
          </form>
        )}

        {step === 'otp' && (
          <form className="stack" onSubmit={submitOtp} noValidate>
            <p className="muted">Đã gửi mã 6 chữ số đến <strong>{f.email.trim()}</strong>. Mã hết hạn sau 10 phút; nhập sai tối đa 5 lần.</p>
            <label className="field">
              <span className="field-label">Mã xác nhận</span>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
            </label>
            {err && <div className="alert error" role="alert">{err}</div>}
            <div className="row wrap">
              <button type="submit" disabled={busy}>{busy ? 'Đang kiểm tra…' : 'Xác nhận'}</button>
              <button type="button" className="secondary" disabled={busy} onClick={restart}>Bắt đầu lại</button>
            </div>
          </form>
        )}

        {step === 'password' && (
          <form className="stack" onSubmit={submitPassword} noValidate>
            <p className="muted">Email đã xác nhận. Đặt mật khẩu cho tài khoản quản trị của tổ chức (tối thiểu {MIN_PASSWORD} ký tự). Sau lần đăng nhập đầu, bạn sẽ được yêu cầu cài ứng dụng xác thực OTP.</p>
            <label className="field"><span className="field-label">Mật khẩu</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} required /></label>
            <label className="field"><span className="field-label">Nhập lại mật khẩu</span><input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} maxLength={128} required /></label>
            {err && <div className="alert error" role="alert">{err}</div>}
            <div className="row wrap">
              <button type="submit" disabled={busy}>{busy ? 'Đang gửi…' : 'Hoàn tất đăng ký'}</button>
              <button type="button" className="secondary" disabled={busy} onClick={restart}>Bắt đầu lại</button>
            </div>
          </form>
        )}

        {step === 'done' && (
          <div className="stack">
            <div className="alert ok" role="status">Đã nhận hồ sơ đăng ký của <strong>{doneSlug}</strong>. Hồ sơ đang chờ duyệt.</div>
            <p className="muted">Bạn sẽ dùng được hệ thống sau khi hồ sơ được duyệt. Khi đó, đăng nhập tại trang ứng dụng bằng email và mật khẩu vừa đặt.</p>
          </div>
        )}
      </main>
    </div>
  );
}
