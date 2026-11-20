/**
 * HCOS-F12 | Nội dung gửi ra ngoài. Chỉ dựng từ các trường cho phép (danh sách trắng) — không bao giờ chép nguyên
 * bản ghi nghiệp vụ. Liên kết có mã định danh nội bộ (UUID) được thay bằng hộp thông báo, để Teams / đối tác không
 * nhận mã đợt khám / hồ sơ.
 */
import { createHmac } from 'node:crypto';

export type EventType = 'decision.event' | 'system.alert' | 'integration.test';
export const SUBSCRIBABLE: readonly { id: Exclude<EventType, 'integration.test'>; label: string; description: string }[] = [
  { id: 'decision.event', label: 'Sự kiện Decision Engine', description: 'Mỗi sự kiện mới, lọc theo mức ưu tiên tối đa của kết nối.' },
  { id: 'system.alert', label: 'Sự cố hệ thống', description: 'Engine chạy lỗi / một phần; kết nối khác bị tự tạm dừng vì gửi lỗi liên tục.' },
];

export interface DecisionEventData {
  readonly title: string;
  readonly detail: string | null;
  readonly ruleName: string;
  readonly detector: string;
  readonly detectorLabel: string;
  readonly link: string | null;
  readonly detectedAt: string;
  readonly organizationName: string;
  readonly metrics: Readonly<Record<string, number | null>>;
}
export interface SystemAlertData {
  readonly code: string;
  readonly title: string;
  readonly detail: string | null;
  readonly link: string | null;
  readonly organizationName: string;
}
export interface TestData {
  readonly title: string;
  readonly organizationName: string;
  readonly requestedBy: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Liên kết nội bộ an toàn để gửi ra ngoài: chỉ hash route, không chứa UUID. */
export function outboundLink(link: string | null | undefined): string | null {
  if (!link || !/^#\/[A-Za-z0-9/_?=&.:-]{0,200}$/.test(link)) return null;
  return UUID_RE.test(link) ? '#/inbox' : link;
}

const clip = (s: string | null | undefined, n: number): string | null => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function decisionPayload(x: DecisionEventData): Record<string, unknown> {
  const metrics: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(x.metrics).slice(0, 12)) if (/^[a-z][a-z0-9_]{0,40}$/.test(k)) metrics[k] = num(v);
  return {
    title: clip(x.title, 200), detail: clip(x.detail, 500), ruleName: clip(x.ruleName, 120), detector: x.detector, detectorLabel: clip(x.detectorLabel, 80),
    link: outboundLink(x.link), detectedAt: x.detectedAt, organizationName: clip(x.organizationName, 120), metrics,
  };
}
export function systemPayload(x: SystemAlertData): Record<string, unknown> {
  return { code: x.code, title: clip(x.title, 200), detail: clip(x.detail, 500), link: outboundLink(x.link), organizationName: clip(x.organizationName, 120) };
}
export function testPayload(x: TestData): Record<string, unknown> {
  return { title: clip(x.title, 200), organizationName: clip(x.organizationName, 120), requestedBy: clip(x.requestedBy, 120) };
}

// ---------------------------------------------------------------------------
// Microsoft Teams (Workflows webhook): Adaptive Card
// ---------------------------------------------------------------------------
const PRIORITY: Record<number, { label: string; color: string }> = {
  1: { label: 'P1 KHẨN', color: 'Attention' },
  2: { label: 'P2 CAO', color: 'Warning' },
  3: { label: 'P3 THEO DÕI', color: 'Accent' },
};
/** Tắt markdown của Teams trong dữ liệu (tên thuốc / tên luật do người dùng nhập) để không chèn được liên kết / định dạng. */
export const mdEscape = (s: string): string => s.replace(/([\\*_[\]`~>#|])/g, '\\$1').replace(/\r?\n/g, ' ');
const vnTime = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));

export function teamsMessage(
  e: { type: EventType; priority: number; occurredAt: string; payload: Record<string, unknown> },
  publicBaseUrl: string | null,
): Record<string, unknown> {
  const p = e.payload;
  const str = (k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);
  const pr = PRIORITY[e.priority] ?? PRIORITY[3]!;
  const kindLabel = e.type === 'decision.event' ? 'Decision Engine' : e.type === 'system.alert' ? 'Sự cố hệ thống' : 'Kiểm tra kết nối';
  const facts: Array<{ title: string; value: string }> = [];
  if (e.type === 'decision.event') {
    if (str('ruleName')) facts.push({ title: 'Luật', value: mdEscape(str('ruleName')!) });
    if (str('detectorLabel')) facts.push({ title: 'Bộ phát hiện', value: mdEscape(str('detectorLabel')!) });
  }
  if (e.type === 'system.alert' && str('code')) facts.push({ title: 'Mã', value: mdEscape(str('code')!) });
  if (e.type === 'integration.test' && str('requestedBy')) facts.push({ title: 'Người gửi thử', value: mdEscape(str('requestedBy')!) });
  facts.push({ title: 'Lúc', value: vnTime(str('detectedAt') ?? e.occurredAt) });
  const body: Array<Record<string, unknown>> = [
    { type: 'TextBlock', text: mdEscape(`${e.type === 'integration.test' ? 'TEST' : pr.label} · ${kindLabel} · ${str('organizationName') ?? ''}`), color: e.type === 'integration.test' ? 'Good' : pr.color, weight: 'Bolder', size: 'Small', wrap: true },
    { type: 'TextBlock', text: mdEscape(str('title') ?? '(không có tiêu đề)'), weight: 'Bolder', size: 'Medium', wrap: true },
  ];
  if (str('detail')) body.push({ type: 'TextBlock', text: mdEscape(str('detail')!), wrap: true, isSubtle: true });
  body.push({ type: 'FactSet', facts });
  body.push({ type: 'TextBlock', text: 'Không có dữ liệu bệnh nhân trong tin này. Mở HealthcareOS (cần đăng nhập) để xem chi tiết.', size: 'Small', isSubtle: true, wrap: true });
  const link = str('link');
  const actions =
    publicBaseUrl && (link || e.type === 'integration.test')
      ? [{ type: 'Action.OpenUrl', title: 'Mở trong HealthcareOS', url: `${publicBaseUrl}/app/${link ?? ''}` }]
      : [];
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', msteams: { width: 'Full' }, body, actions },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Webhook chung: thân JSON + chữ ký HMAC-SHA256
// ---------------------------------------------------------------------------
export function webhookBody(e: { eventId: string; type: EventType; priority: number; occurredAt: string; organizationId: string; payload: Record<string, unknown> }): string {
  return JSON.stringify({ id: e.eventId, type: e.type, priority: e.priority, occurredAt: e.occurredAt, organizationId: e.organizationId, data: e.payload });
}
/** X-HCOS-Signature: v1=<hex(HMAC-SHA256(secret, `${timestamp}.${body}`))>. Bên nhận nên từ chối timestamp lệch quá 5 phút. */
export function sign(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
