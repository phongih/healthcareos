/**
 * HCOS-P0-ENG-001 | Entrypoint tiến trình: cấu hình từ env, tắt êm khi nhận SIGTERM/SIGINT.
 * Mã thoát: 0 = tắt êm; 1 = lỗi khởi động/cấu hình, hoặc tắt quá 10s (cưỡng bức).
 * Log chỉ gồm thông điệp + tên lỗi; không bao giờ in giá trị cấu hình (URL DB có mật khẩu).
 */
import { startApp, jsonLog } from './app';

const FORCE_EXIT_MS = 10_000;

startApp(process.env)
  .then((app) => {
    const shutdown = (signal: string): void => {
      jsonLog({ level: 'info', msg: 'shutting down', signal });
      setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
      app.stop().then(() => {
        jsonLog({ level: 'info', msg: 'stopped' });
        process.exit(0);
      });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((e: unknown) => {
    const name = e instanceof Error ? e.name : 'error';
    // ConfigError.message chỉ liệt kê tên biến + lý do (không có giá trị).
    jsonLog({ level: 'fatal', msg: name === 'ConfigError' && e instanceof Error ? e.message : 'startup failed', error: name });
    process.exit(1);
  });
