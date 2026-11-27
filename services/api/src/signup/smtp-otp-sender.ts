/**
 * HCOS | Gửi mã OTP đăng ký khách qua SMTP (ví dụ Gmail / Google Workspace với mật khẩu ứng dụng).
 *  - Chỉ dùng TLS ngầm (cổng 465) hoặc kết nối đã được cung cấp sẵn qua `connect` (test). Không bao giờ gửi mật khẩu qua kết nối không mã hoá.
 *  - Mật khẩu và mã OTP không được ghi log. Mọi lỗi giao thức => false (fail-closed), không lộ chi tiết.
 *  - Chưa được nối vào app.ts: việc bật kênh phụ thuộc quyết định đánh giá nhà cung cấp (F18) cho dữ liệu cá nhân.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';

import type { SignupOtpSender } from './signup.service';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export type SmtpConnect = (cfg: SmtpConfig) => Promise<Socket>;

/** Mặc định: TLS ngầm tới máy chủ (cổng 465). */
export const tlsSmtpConnect: SmtpConnect = (cfg) =>
  new Promise((resolve, reject) => {
    const s: TLSSocket = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s));
    s.once('error', reject);
  });

/** Đọc từng phản hồi SMTP (có thể nhiều dòng "250-..."). */
class Replies {
  private buf = '';
  private waiting: ((r: { code: number; text: string }) => void) | null = null;
  private failed: Error | null = null;
  private readonly queue: Array<{ code: number; text: string }> = [];
  constructor(sock: Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        this.pending += line + '\n';
        if (/^\d{3} /.test(line)) {
          const code = Number(line.slice(0, 3));
          const reply = { code, text: this.pending.trim() };
          this.pending = '';
          if (this.waiting) {
            const w = this.waiting;
            this.waiting = null;
            w(reply);
          } else this.queue.push(reply);
        }
      }
    });
    sock.once('error', (e) => this.fail(e));
    sock.once('close', () => this.fail(new Error('SMTP connection closed')));
  }
  private pending = '';
  private fail(e: Error): void {
    this.failed = e;
    if (this.waiting) {
      this.waiting({ code: 0, text: e.message });
      this.waiting = null;
    }
  }
  next(): Promise<{ code: number; text: string }> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve) => (this.waiting = resolve));
  }
}

async function expect(replies: Replies, sock: Socket, line: string, okCodes: number[]): Promise<void> {
  sock.write(line + '\r\n');
  const r = await replies.next();
  if (!okCodes.includes(r.code)) throw new Error('SMTP unexpected reply');
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const encodedHeader = (s: string): string => `=?UTF-8?B?${b64(s)}?=`;

/** Nội dung thư: text/plain UTF-8, mã hoá base64 (tránh lỗi ký tự tiếng Việt qua các máy chủ trung gian). */
export function buildOtpMessage(from: string, to: string, code: string, orgName: string): string {
  const subject = encodedHeader(`Mã xác thực đăng ký ${orgName}`);
  const body = [
    `Mã xác thực của bạn là: ${code}`,
    'Mã có hiệu lực trong 10 phút. Không chia sẻ mã này cho bất kỳ ai.',
    'Nếu bạn không yêu cầu đăng ký, hãy bỏ qua email này.',
  ].join('\r\n');
  const headers = [
    `From: HealthcareOS <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].join('\r\n');
  // Dòng base64 74 ký tự; dấu chấm đầu dòng đã được mã hoá nên không cần dot-stuffing.
  const encoded = (Buffer.from(body, 'utf8').toString('base64').match(/.{1,74}/g) ?? []).join('\r\n');
  return `${headers}\r\n\r\n${encoded}\r\n`;
}

export async function deliverOtpBySmtp(
  cfg: SmtpConfig,
  to: string,
  code: string,
  orgName: string,
  connect: SmtpConnect = tlsSmtpConnect,
): Promise<void> {
  const sock = await connect(cfg);
  const replies = new Replies(sock);
  try {
    const greet = await replies.next();
    if (greet.code !== 220) throw new Error('SMTP greeting');
    await expect(replies, sock, 'EHLO hcos.local', [250]);
    await expect(replies, sock, 'AUTH LOGIN', [334]);
    await expect(replies, sock, b64(cfg.user), [334]);
    await expect(replies, sock, b64(cfg.pass), [235]);
    await expect(replies, sock, `MAIL FROM:<${cfg.from}>`, [250]);
    await expect(replies, sock, `RCPT TO:<${to}>`, [250, 251]);
    await expect(replies, sock, 'DATA', [354]);
    sock.write(buildOtpMessage(cfg.from, to, code, orgName) + '.\r\n');
    const sent = await replies.next();
    if (sent.code !== 250) throw new Error('SMTP message rejected');
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}

/** Kênh OTP email: trả false nếu gửi không được (không ném lỗi ra ngoài, không ghi log mã). */
export function smtpSignupOtp(cfg: SmtpConfig, connect: SmtpConnect = tlsSmtpConnect): SignupOtpSender {
  return {
    // Vendor = host SMTP; phải được duyệt trong platform.signup_vendors trước khi gửi.
    vendor: cfg.host,
    async send(to, code, orgName) {
      try {
        await deliverOtpBySmtp(cfg, to, code, orgName, connect);
        return true;
      } catch {
        return false;
      }
    },
  };
}
