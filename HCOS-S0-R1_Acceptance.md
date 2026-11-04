# HCOS-S0-R1 — Acceptance

## Quyết định: **G0 = BLOCKED**

Tiêu chí G0 của R1 yêu cầu dependency thật, `tsc` không stub, hồi quy trên vitest thật và container boot. Các mục đó không thực hiện được vì **chính sách egress của sandbox**:

- `registry.npmjs.org:443` → `CONNECT 403` (`connect_rejected` trong `/__agentproxy/status`); đi thẳng thì không phân giải được tên miền.
- `registry-1.docker.io:443` → bị từ chối tương tự; không có Docker daemon chạy.

Không dùng đường vòng (mirror/tarball ngoài) để lách chính sách. Không có tuyên bố PASS dựa trên stub/shim.

| Tiêu chí | Trạng thái | Bằng chứng |
|---|---|---|
| Cài dependency thật thành công | ❌ BLOCKED | Evidence §A (A2–A7) |
| Lockfile thật | ❌ BLOCKED | `package-lock.json` chưa tồn tại |
| TypeScript không stub | ❌ BLOCKED | Chỉ `tsc` strict với stub: sạch |
| Hồi quy đầy đủ (vitest thật) | ⚠️ CONDITIONAL | 152/152 trên shim, 0 fail (§E) |
| Integration trên PostgreSQL 16 | ⚠️ CONDITIONAL | PG 16.15 thật; runner/driver là shim |
| API boot thật (`main.ts`) | ⚠️ CONDITIONAL | Boot, 200/200, 503 khi DB mất, exit 0 — với shim `pg` |
| Container boot | ❌ BLOCKED | Chưa build (không daemon, Docker Hub 403, npm 403) |
| Health/readiness đúng hành vi | ✅ đã kiểm (logic, 14 test + chạy tay) | Evidence §B–C |
| Cô lập tenant & audit còn nguyên | ✅ đã kiểm trong hồi quy (S0 29, S1 32, HTTP 18, PG 13+6+9+2) | Evidence §E (trên shim) |

## Đã thay đổi trong R1 (không có tính năng lâm sàng mới)
- `GET /healthz` (liveness, không phụ thuộc DB) và `GET /readyz` (readiness, timeout cứng, 503 không lộ chi tiết).
- `PgReadinessProbe`, `assertSafeDatabaseRole` (từ chối superuser/BYPASSRLS), `PgAuditSink`, `PgTenantStatusLookup`.
- `startApp` (app.ts) tách khỏi `main.ts`; tắt êm SIGTERM/SIGINT; log chỉ có tên lỗi.
- Test: `tests/http/health.test.ts` (10), `tests/integration/startup.integration.test.ts` (4), `tests/integration/tenant-status-pg.integration.test.ts` (2), cập nhật `tests/config`.
- `Dockerfile`, `.dockerignore`, `ENVIRONMENT.md`, job CI `container`, scripts `build/start/dev`.
- Không sửa test để che lỗi. Hai lỗi thật tìm thấy và sửa ở mã nguồn/thiết lập, không ở assertion: (1) sự kiện audit từ chối/lỗi không được ghi vì thiếu sink Postgres → thêm `PgAuditSink`; (2) URL unix-socket bị từ chối bởi `loadConfig` → giữ hành vi, tài liệu hoá TCP-only.

## Để chuyển G0 → PASS (cần môi trường có egress tới npm + Docker Hub, hoặc CI)
1. `npm install` → commit `package-lock.json`.
2. `npm run typecheck` (type thật), `npm run test:unit`, `npm run test:integration` với `HCOS_IT=1 PGHOST=… PGUSER=<superuser>` trên PostgreSQL 16.
3. `docker build -f services/api/Dockerfile -t hcos-api:local .`; chạy với env tổng hợp; kiểm `/healthz`, `/readyz`, `docker stop` (exit 0), `id -u` ≠ 0.
4. Thêm test xác thực JWT thật qua `main.ts` (JWKS cục bộ) nếu muốn bao phủ đầu-cuối tenant + audit.

Có thể chạy `npm run gate:g0g1` + job `container` trong `.github/workflows/ci.yml`; khi cả hai xanh trên runner có mạng, cập nhật file này thành PASS kèm log thật.
