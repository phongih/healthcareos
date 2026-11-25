/**
 * HCOS-F20 | Kênh gửi OTP cổng bệnh nhân.
 *   off       — tắt đăng nhập cổng (mặc định).
 *   training  — môi trường dữ liệu giả: mã trả về để HIỆN TRÊN MÀN ĐĂNG NHẬP (config bắt buộc HCOS_TRAINING_ENV=1).
 *   webhook   — POST {to, text} tới cổng SMS / ZNS / email của nhà cung cấp; PortalService kiểm nhà cung cấp còn được duyệt cho
 *               dữ liệu 'personal' (sổ F18) ngay trước mỗi lần gửi. Không bao giờ gửi qua Teams.
 */
import type { PortalOtpConfig } from '../config';
import type { Transport } from '../integration/transport';

export interface OtpMessage {
  readonly to: string;
  readonly code: string;
  readonly purpose: 'login' | 'phone_change';
  readonly organizationName: string;
}
export interface OtpSender {
  readonly channel: 'training' | 'vendor' | 'none';
  readonly vendorId: string | null;
  /** true = đã giao cho kênh. Kênh training luôn true (mã hiện trên màn hình). */
  send(m: OtpMessage): Promise<boolean>;
}

export const otpText = (m: OtpMessage): string =>
  `${m.organizationName}: ma xac thuc ${m.code} (${m.purpose === 'login' ? 'dang nhap cong benh nhan' : 'doi so dien thoai'}), het han sau 5 phut. Khong chia se ma nay cho bat ky ai.`;

export const DISABLED_OTP: OtpSender = { channel: 'none', vendorId: null, send: async () => false };
export const TRAINING_OTP: OtpSender = { channel: 'training', vendorId: null, send: async () => true };

export function webhookOtp(cfg: { url: string; token: string; vendorId: string }, transport: Transport): OtpSender {
  return {
    channel: 'vendor',
    vendorId: cfg.vendorId,
    async send(m) {
      const r = await transport({
        url: cfg.url,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ to: m.to, text: otpText(m) }),
      });
      return r.status !== null && r.status >= 200 && r.status < 300;
    },
  };
}

export function otpSenderFor(cfg: PortalOtpConfig, transport: Transport): OtpSender {
  if (cfg.mode === 'training') return TRAINING_OTP;
  if (cfg.mode === 'webhook') return webhookOtp(cfg, transport);
  return DISABLED_OTP;
}
