/**
 * HCOS | Kênh OTP email SMTP: hội thoại SMTP đúng thứ tự, mật khẩu và mã không lộ ra ngoài log,
 * lỗi xác thực / từ chối => false. Máy chủ SMTP giả (không mã hoá) chỉ dùng qua connect() của test.
 */
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { smtpSignupOtp, type SmtpConfig } from '../../services/api/src/signup/smtp-otp-sender';

type Script = { authOk: boolean; rejectRcpt?: boolean };

function fakeSmtp(script: Script): Promise<{ server: Server; port: number; transcript: string[]; message: () => string }> {
  const transcript: string[] = [];
  let message = '';
  const server = createServer((sock: Socket) => {
    sock.setEncoding('utf8');
    let stage: 'ehlo' | 'authUser' | 'authPass' | 'mail' | 'rcpt' | 'data' | 'body' | 'done' = 'ehlo';
    let buf = '';
    const reply = (s: string) => sock.write(s + '\r\n');
    reply('220 fake smtp');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (stage === 'body') {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        message = buf.slice(0, end);
        buf = buf.slice(end + 5);
        stage = 'done';
        reply('250 queued');
        return;
      }
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        transcript.push(line !== 'AUTH LOGIN' && (stage === 'authUser' || stage === 'authPass') ? '<b64>' : line);
        if (stage === 'ehlo') { reply('250 hello'); stage = 'authUser'; continue; }
        if (line === 'AUTH LOGIN') { reply('334 VXNlcm5hbWU6'); continue; }
        if (stage === 'authUser') { reply('334 UGFzc3dvcmQ6'); stage = 'authPass'; continue; }
        if (stage === 'authPass') {
          if (script.authOk) { reply('235 ok'); stage = 'mail'; } else { reply('535 bad credentials'); stage = 'done'; }
          continue;
        }
        if (line.startsWith('MAIL FROM')) { reply('250 ok'); stage = 'rcpt'; continue; }
        if (line.startsWith('RCPT TO')) {
          if (script.rejectRcpt) reply('550 no such user'); else { reply('250 ok'); stage = 'data'; }
          continue;
        }
        if (line === 'DATA') { reply('354 go'); stage = 'body'; break; }
        if (line === 'QUIT') { reply('221 bye'); sock.end(); }
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, transcript, message: () => message }));
  });
}

const cfg = (port: number): SmtpConfig => ({ host: '127.0.0.1', port, user: 'noreply@smart.id.vn', pass: 'mat-khau-ung-dung-it', from: 'noreply@smart.id.vn' });
const plainConnect = (port: number) => (): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = netConnect(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

let open: Server | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

describe('kênh OTP email SMTP', () => {
  it('gửi thành công: đúng thứ tự hội thoại, nội dung có mã, không có mật khẩu dạng rõ trên dây', async () => {
    const f = await fakeSmtp({ authOk: true });
    open = f.server;
    const sender = smtpSignupOtp(cfg(f.port), plainConnect(f.port));
    expect(await sender.send('chu@pk.vn', '482913', 'Phòng khám Mới')).toBe(true);
    // Chờ máy chủ giả xử lý xong thư.
    await new Promise((r) => setTimeout(r, 50));
    expect(f.transcript.slice(0, 4)).toEqual(['EHLO hcos.local', 'AUTH LOGIN', '<b64>', '<b64>']);
    expect(f.transcript).toContain('MAIL FROM:<noreply@smart.id.vn>');
    expect(f.transcript).toContain('RCPT TO:<chu@pk.vn>');
    expect(f.transcript.join('\n')).not.toContain('mat-khau-ung-dung-it');
    const body = f.message().split('\r\n\r\n')[1] ?? '';
    const text = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    expect(text).toContain('482913');
    expect(f.message()).toContain('To: <chu@pk.vn>');
  });

  it('sai mật khẩu hoặc máy chủ từ chối người nhận => false', async () => {
    const bad = await fakeSmtp({ authOk: false });
    open = bad.server;
    expect(await smtpSignupOtp(cfg(bad.port), plainConnect(bad.port)).send('chu@pk.vn', '111111', 'PK')).toBe(false);
    bad.server.close();
    const rej = await fakeSmtp({ authOk: true, rejectRcpt: true });
    open = rej.server;
    expect(await smtpSignupOtp(cfg(rej.port), plainConnect(rej.port)).send('chu@pk.vn', '111111', 'PK')).toBe(false);
  });

  it('không kết nối được => false (không ném lỗi ra ngoài)', async () => {
    const sender = smtpSignupOtp(cfg(1), async () => {
      throw new Error('refused');
    });
    expect(await sender.send('chu@pk.vn', '111111', 'PK')).toBe(false);
  });
});
