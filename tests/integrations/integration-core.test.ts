/** HCOS-F12 | Hàm thuần của hạ tầng tích hợp: mã hoá, kiểm tra đích (SSRF), thẻ Teams, chữ ký webhook, phân loại / lịch thử lại. */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../services/api/src/config';
import { decisionPayload, mdEscape, outboundLink, sign, teamsMessage, webhookBody } from '../../services/api/src/integration/payloads';
import { aadOf, SecretBox } from '../../services/api/src/integration/secrets';
import { isBlockedAddress, validateTarget } from '../../services/api/src/integration/targets';
import { BACKOFF_SEC, classify, MAX_ATTEMPTS } from '../../services/api/src/integration/transport';

const TEAMS = 'https://prod-27.southeastasia.logic.azure.com:443/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sv=1.0&sig=AbCdEfGh123';
const TEAMS2 = 'https://default0a1b2c3d.4e.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=Zz9';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32));
  it('mã hoá / giải mã; bản mã khác nhau mỗi lần; không chứa bản rõ', () => {
    const a = box.seal(TEAMS, aadOf('t', 'e', 'url'));
    const b = box.seal(TEAMS, aadOf('t', 'e', 'url'));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+$/);
    expect(a).not.toContain('logic.azure');
    expect(box.open(a, aadOf('t', 'e', 'url'))).toBe(TEAMS);
  });
  it('sai AAD (chép bản mã sang kết nối / tenant khác) hoặc bị sửa => lỗi', () => {
    const a = box.seal('x', aadOf('t', 'e', 'url'));
    expect(() => box.open(a, aadOf('t', 'e2', 'url'))).toThrow();
    expect(() => box.open(a, aadOf('t', 'e', 'secret'))).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open(a, aadOf('t', 'e', 'url'))).toThrow();
    const raw = Buffer.from(a.slice(3), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => box.open(`v1:${raw.toString('base64')}`, aadOf('t', 'e', 'url'))).toThrow();
  });
});

describe('kiểm tra đích', () => {
  it('Teams: chỉ URL Workflows của Microsoft, https, cổng 443; gợi ý đã che', () => {
    const t = validateTarget('teams_workflow', TEAMS);
    expect(t).toMatchObject({ hint: 'prod-27.southeastasia.logic.azure.com/…h123' });
    expect('url' in t && t.url).toContain('sig=AbCdEfGh123');
    expect('hint' in t && t.hint).not.toContain('sig');
    expect(validateTarget('teams_workflow', TEAMS2)).toHaveProperty('url');
    expect(validateTarget('teams_workflow', TEAMS.replace('https', 'http'))).toHaveProperty('error');
    expect(validateTarget('teams_workflow', 'https://evil.com/workflows/x?sig=1')).toHaveProperty('error');
    expect(validateTarget('teams_workflow', 'https://logic.azure.com.evil.com/workflows/x')).toHaveProperty('error');
    expect(validateTarget('teams_workflow', 'https://x.logic.azure.com:8443/workflows/x')).toHaveProperty('error');
    expect(validateTarget('teams_workflow', 'https://outlook.office.com/webhook/abc')).toHaveProperty('error');
  });
  it('webhook: https, không user:pass, không tên máy / IP nội bộ', () => {
    expect(validateTarget('webhook', 'https://partner.example.vn/hooks/hcos')).toHaveProperty('url');
    for (const bad of ['http://partner.example.vn/h', 'https://u:p@partner.example.vn/h', 'https://localhost/h', 'https://10.0.0.5/h', 'https://[::1]/h',
      'https://169.254.169.254/latest/meta-data', 'https://intranet/h', 'https://db.internal/h', 'ftp://x.vn/a', 'https://x.vn/a#frag', 'không phải url'])
      expect(validateTarget('webhook', bad)).toHaveProperty('error');
    expect(validateTarget('webhook', 'http://127.0.0.1:9999/h', { allowPrivate: true })).toHaveProperty('url');
  });
  it('dải địa chỉ bị chặn', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '13.107.42.14', '172.32.0.1', '2606:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
});

describe('nội dung gửi ra ngoài', () => {
  const ev = decisionPayload({
    title: 'Sốt **cao** [bấm](https://x.vn)', detail: 'Nhiệt độ 39,4', ruleName: 'Sốt cao', detector: 'vital_abnormal', detectorLabel: 'Sinh hiệu bất thường',
    link: '#/encounters/0b1c2d3e-0000-4000-8000-000000000001', detectedAt: '2026-11-20T15:00:00Z', organizationName: 'PK A', metrics: { temperature_c: 39.4, 'bad key': 1 },
  });
  it('liên kết có mã nội bộ được thay bằng hộp thông báo; chỉ số tên lạ bị bỏ', () => {
    expect(ev['link']).toBe('#/inbox');
    expect(outboundLink('#/forecast')).toBe('#/forecast');
    expect(outboundLink('https://evil')).toBeNull();
    expect(ev['metrics']).toEqual({ temperature_c: 39.4 });
  });
  it('thẻ Teams: Adaptive Card, chặn markdown chèn liên kết, nút mở HealthcareOS', () => {
    const m = teamsMessage({ type: 'decision.event', priority: 1, occurredAt: '2026-11-20T15:00:00Z', payload: ev }, 'https://smart.id.vn') as {
      type: string; attachments: Array<{ contentType: string; content: { type: string; body: Array<{ text?: string; facts?: Array<{ title: string; value: string }> }>; actions: Array<{ url: string }> } }>;
    };
    expect(m.type).toBe('message');
    expect(m.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = m.attachments[0]!.content;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.body[0]!.text).toContain('P1 KHẨN');
    expect(card.body[1]!.text).toBe('Sốt \\*\\*cao\\*\\* \\[bấm\\](https://x.vn)');
    expect(card.body.find((b) => b.facts)!.facts!.map((f) => f.title)).toEqual(['Luật', 'Bộ phát hiện', 'Lúc']);
    expect(card.body.find((b) => b.facts)!.facts!.at(-1)!.value).toContain('22:00');
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Mở trong HealthcareOS', url: 'https://smart.id.vn/app/#/inbox' }]);
    expect(JSON.stringify(m)).not.toContain('0b1c2d3e');
    expect((teamsMessage({ type: 'decision.event', priority: 2, occurredAt: '2026-11-20T15:00:00Z', payload: ev }, null) as { attachments: Array<{ content: { actions: unknown[] } }> }).attachments[0]!.content.actions).toEqual([]);
    expect(mdEscape('a_b\nc')).toBe('a\\_b c');
  });
  it('webhook: thân JSON chuẩn + chữ ký HMAC kiểm được', () => {
    const body = webhookBody({ eventId: 'e1', type: 'decision.event', priority: 1, occurredAt: '2026-11-20T15:00:00Z', organizationId: 'o1', payload: ev });
    expect(JSON.parse(body)).toMatchObject({ id: 'e1', type: 'decision.event', priority: 1, organizationId: 'o1', data: { title: ev['title'] } });
    const sig = sign('whsec_x', 1_795_000_000, body);
    expect(sig).toBe(`v1=${createHmac('sha256', 'whsec_x').update(`1795000000.${body}`).digest('hex')}`);
    expect(sign('whsec_y', 1_795_000_000, body)).not.toBe(sig);
  });
});

describe('phân loại + thử lại', () => {
  const r = (status: number | null, error: string | null = null, retryAfterSec: number | null = null) => ({ status, error, retryAfterSec, durationMs: 5 });
  it('2xx thành công (Teams Workflows trả 202)', () => {
    expect(classify(r(202), 1, true)).toEqual({ outcome: 'success' });
  });
  it('5xx / 429 / lỗi mạng thử lại theo lịch; Retry-After được tôn trọng (tối đa 1 giờ)', () => {
    expect(classify(r(500), 1, true)).toEqual({ outcome: 'retry', afterSec: 60, error: 'HTTP_500' });
    expect(classify(r(null, 'TIMEOUT'), 2, true)).toEqual({ outcome: 'retry', afterSec: 300, error: 'TIMEOUT' });
    expect(classify(r(429, null, 900), 1, true)).toEqual({ outcome: 'retry', afterSec: 900, error: 'HTTP_429' });
    expect(classify(r(429, null, 99999), 1, true)).toMatchObject({ afterSec: 3600 });
    expect(BACKOFF_SEC).toEqual([60, 300, 900, 3600, 21600, 86400]);
    expect(classify(r(503), MAX_ATTEMPTS, true)).toEqual({ outcome: 'dead', error: 'HTTP_503' });
  });
  it('4xx, chuyển hướng, địa chỉ bị chặn => lỗi vĩnh viễn; gửi tay không tự thử lại', () => {
    expect(classify(r(404), 1, true)).toEqual({ outcome: 'dead', error: 'HTTP_404' });
    expect(classify(r(302), 1, true)).toEqual({ outcome: 'dead', error: 'REDIRECT_NOT_FOLLOWED' });
    expect(classify(r(null, 'BLOCKED_ADDRESS'), 1, true)).toEqual({ outcome: 'dead', error: 'BLOCKED_ADDRESS' });
    expect(classify(r(500), 1, false)).toEqual({ outcome: 'dead', error: 'HTTP_500' });
  });
});

describe('cấu hình', () => {
  const OK = { HCOS_DATABASE_URL: 'postgres://hcos_api:x@127.0.0.1:5432/hcos', HCOS_JWT_ISSUER: 'https://i/', HCOS_JWT_AUDIENCE: 'a', HCOS_JWKS_URL: 'https://i/jwks', HCOS_KEKS: 't1:' + Buffer.alloc(32, 7).toString('base64') };
  it('mặc định: tích hợp tắt, giao mỗi 15 giây', () => {
    expect(loadConfig(OK)).toMatchObject({ integrationKey: null, publicBaseUrl: null, integrationDispatchSec: 15 });
  });
  it('khoá 32 byte, URL công khai https', () => {
    const k = randomBytes(32).toString('base64');
    const c = loadConfig({ ...OK, HCOS_INTEGRATION_KEY: k, HCOS_PUBLIC_BASE_URL: 'https://smart.id.vn/' });
    expect(c.integrationKey?.length).toBe(32);
    expect(c.publicBaseUrl).toBe('https://smart.id.vn');
  });
  it('từ chối khoá sai độ dài, URL http, chu kỳ quá ngắn', () => {
    expect(() => loadConfig({ ...OK, HCOS_INTEGRATION_KEY: randomBytes(16).toString('base64') })).toThrow(/HCOS_INTEGRATION_KEY/);
    expect(() => loadConfig({ ...OK, HCOS_PUBLIC_BASE_URL: 'http://smart.id.vn' })).toThrow(/HCOS_PUBLIC_BASE_URL/);
    expect(() => loadConfig({ ...OK, HCOS_INTEGRATION_DISPATCH_SEC: '2' })).toThrow(/DISPATCH/);
  });
});
