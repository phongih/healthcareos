/** HCOS-F12 | Gửi HTTP thật tới server cục bộ: thành công, lỗi, không theo chuyển hướng, hết giờ, chặn IP nội bộ. */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { httpTransport } from '../../services/api/src/integration/transport';

let server: Server;
let base = '';
const seen: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.url === '/ok') { res.writeHead(202); res.end('accepted'); }
      else if (req.url === '/fail') { res.writeHead(503, { 'retry-after': '120' }); res.end('busy'); }
      else if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); }
      else if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(100_000)); }
      else if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end(); }, 3000); }
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

describe('httpTransport', () => {
  const t = httpTransport({ allowPrivate: true, timeoutMs: 500 });
  it('POST JSON + header; 202 => status', async () => {
    const r = await t({ url: `${base}/ok`, headers: { 'x-hcos-event': 'decision.event' }, body: '{"a":1}' });
    expect(r).toMatchObject({ status: 202, error: null });
    const s = seen.at(-1)!;
    expect(s.body).toBe('{"a":1}');
    expect(s.headers['x-hcos-event']).toBe('decision.event');
    expect(s.headers['content-type']).toContain('application/json');
    expect(s.headers['user-agent']).toBe('HealthcareOS-Integrations/1');
  });
  it('503 + Retry-After', async () => {
    expect(await t({ url: `${base}/fail`, headers: {}, body: '{}' })).toMatchObject({ status: 503, retryAfterSec: 120 });
  });
  it('không theo chuyển hướng', async () => {
    const before = seen.length;
    expect(await t({ url: `${base}/redirect`, headers: {}, body: '{}' })).toMatchObject({ status: 302 });
    expect(seen.length).toBe(before + 1);
  });
  it('phản hồi lớn bị cắt, không treo', async () => {
    expect((await t({ url: `${base}/big`, headers: {}, body: '{}' })).status).toBe(200);
  });
  it('hết giờ', async () => {
    const r = await t({ url: `${base}/slow`, headers: {}, body: '{}' });
    expect(r).toMatchObject({ status: null, error: 'TIMEOUT' });
    expect(r.durationMs).toBeLessThan(2000);
  });
  it('không kết nối được', async () => {
    expect(await t({ url: 'http://127.0.0.1:1/x', headers: {}, body: '{}' })).toMatchObject({ status: null, error: 'CONNECT_REFUSED' });
  });
  it('mặc định chặn địa chỉ nội bộ SAU khi phân giải DNS (localhost → 127.0.0.1)', async () => {
    const strict = httpTransport({ timeoutMs: 500 });
    const port = (server.address() as { port: number }).port;
    expect(await strict({ url: `http://localhost:${port}/ok`, headers: {}, body: '{}' })).toMatchObject({ status: null, error: 'BLOCKED_ADDRESS' });
  });
});
