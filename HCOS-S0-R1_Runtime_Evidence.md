# HCOS-S0-R1 — Runtime Evidence

Ngày ghi: 2026-11-04 (UTC 2026-11-03T23:4x). Môi trường: Linux sandbox, Node v22.23.4, PostgreSQL 16.15 (cluster tạm, role `pguser` chỉ dùng để tạo DB/fixture). Chỉ dùng fixture tổng hợp (không có dữ liệu bệnh nhân).

> **Phân loại bằng chứng.** 🟥 = bằng chứng thật cho tiêu chí acceptance. 🟨 = chạy trên **shim** (không phải thư viện thật) — chứng minh logic và wiring, **không** chứng minh tiêu chí "dependency thật". Mọi mục chạy test dưới đây là 🟨 vì không cài được `vitest`/`jose`/`pg` thật.

## A. Dependency (🟥 BLOCKED)

| # | Lệnh | Kết quả |
|---|---|---|
| A1 | `git rev-parse --is-inside-work-tree` | `fatal: not a git repository` — thư mục `/home/claude` chưa phải repo Git; không có branch/HEAD để ghi nhận. |
| A2 | `npm config get registry` | `https://registry.npmjs.org/` |
| A3 | `npm view jose@5.9.6 version` | `npm error network …` (không đến được registry) |
| A4 | `curl https://registry.npmjs.org/jose` (theo cấu hình: `no_proxy` có `registry.npmjs.org`) | `curl: (6) Could not resolve host` — đi thẳng, không phân giải được tên miền |
| A5 | `curl -x $HTTPS_PROXY --noproxy '' https://registry.npmjs.org/jose` | `CONNECT tunnel failed, response 403`; `/__agentproxy/status` → `connect_rejected … registry.npmjs.org:443` (policy denial) |
| A6 | `curl -x $HTTPS_PROXY https://registry-1.docker.io/v2/` | bị từ chối tương tự (`connect_rejected registry-1.docker.io:443`) |
| A7 | tìm `pg`/`jose`/`vitest` trong `node_modules` toàn máy + `~/.npm/_cacache` | không có |

Không đi vòng qua chính sách egress (không mirror/tarball bên ngoài). Hệ quả: **không có `package-lock.json`**, **không có `tsc` với type thật**, **không có vitest thật**.

## B. Runtime startup (🟨 shim `pg` trên psql + PostgreSQL 16 thật)

`main.ts` chạy thật bằng `tsx` (tiến trình con). Chỉ driver `pg` và `jose`/`vitest` là shim.

Log thật của một lần chạy thủ công (`HCOS_PORT=28080`, role đăng nhập `r1app` ∈ `hcos_app`):

```
# liveness                         HTTP/1.1 200 OK, cache-control: no-store, {"status":"ok"}
# readiness (DB up)                HTTP/1.1 200 OK, {"status":"ready"}
# unauthenticated GET /api/persons/<uuid>  -> 401
# readiness (DB dropped)           HTTP/1.1 503 Service Unavailable, {"status":"unavailable"}
# liveness (DB dropped)            200
# exit code after SIGTERM: 0
{"level":"info","msg":"hcos-api listening","port":28080}
{"level":"warn","msg":"readiness check failed","error":"Error"}
{"level":"info","msg":"shutting down","signal":"SIGTERM"}
{"level":"info","msg":"stopped"}
# số lần mật khẩu xuất hiện trong log: 0
```

Cấu hình sai (`HCOS_DATABASE_URL=postgres://postgres:Hunter2@h/db`, thiếu biến khác):
`{"level":"fatal","msg":"Invalid configuration: HCOS_DATABASE_URL must use the restricted hcos_app role…","error":"ConfigError"}` → exit 1; mật khẩu không xuất hiện.

Phát hiện khi chạy: URL dạng unix-socket (`postgres://u:p@/db?host=/tmp`) bị `new URL` coi là không hợp lệ → `loadConfig` từ chối. Chấp nhận (fail-closed), đã ghi vào `ENVIRONMENT.md`: chỉ hỗ trợ TCP.

## C. Health & readiness
- `/healthz` không chạm DB (test đơn vị: probe ném lỗi vẫn 200, probe không bị gọi).
- `/readyz`: `SELECT 1 FROM iam.tenants LIMIT 0` (chứng minh kết nối + migration + quyền SELECT; không đặt tenant, không đọc dòng nào), timeout cứng (mặc định 2000 ms) kể cả khi `connect()` treo; client trả muộn vẫn được release; 503 body cố định `{"status":"unavailable"}`; lỗi chỉ log **tên** lỗi.
- Không cấu hình probe ⇒ `/readyz` = 503 (fail-closed).
- Bổ sung an toàn: `assertSafeDatabaseRole` — từ chối khởi động nếu `current_user`/`session_user` là superuser hoặc BYPASSRLS (RLS sẽ bị vô hiệu im lặng). Test: role superuser thật → exit 1, `UnsafeDatabaseRoleError`.

## D. Container (🟥 BLOCKED — chưa build/chạy được)
Đã tạo `services/api/Dockerfile` (3 stage: build+typecheck+esbuild bundle → prod-deps → runtime; user `node`; `HEALTHCHECK` → `/healthz`; không bí mật), `services/api/.dockerignore` (+ bản sao ở gốc repo và `Dockerfile.dockerignore`), `services/api/ENVIRONMENT.md`, job `container` trong CI.
Chặn: (1) `docker info` → không có daemon (`/var/run/docker.sock` không tồn tại; `dockerd` có binary nhưng chưa chạy); (2) kéo base image từ Docker Hub bị chính sách 403 (A6); (3) `npm ci` trong build cần registry (A5) và `package-lock.json`.
Kiểm được độc lập: bundle `esbuild services/api/src/main.ts --bundle --platform=node --format=esm --packages=external` thành công (110.3 kB, esbuild cục bộ) — **chưa chạy artifact này với `pg`/`jose` thật**.

## E. Kết quả test (🟨; runner = shim vitest, mã thoát của shim không dùng làm bằng chứng, dùng số đếm)

| Bộ test | Passed | Failed |
|---|---|---|
| unit security/tenant-isolation (S0) | 29 | 0 |
| unit clinical/encounter-lifecycle (S1) | 32 | 0 |
| unit http/clinical-api | 18 | 0 |
| unit http/health (mới) | 10 | 0 |
| unit registry/person-registry | 23 | 0 |
| unit config/config | 6 | 0 |
| integration clinical-pg (PG16, RLS) | 13 | 0 |
| integration http-pg | 6 | 0 |
| integration registry-pg | 9 | 0 |
| integration tenant-status-pg (tenant status dưới RLS + audit sink) | 2 | 0 |
| integration startup (main.ts tiến trình thật: cấu hình sai, role superuser, 200/200, 503 khi DB mất, SIGINT/SIGTERM exit 0, không lộ mật khẩu) | 4 | 0 |
| **Tổng** | **152** | **0** |

`tsc` strict với stub: sạch (🟨 — stub không phải type thật). Chưa chạy `tsc` với `@types/node`/`@types/pg`/`jose` thật.

## F. Điều chưa kiểm chứng / giới hạn
1. `pg.Pool` thật (kết nối, `connectionTimeoutMillis`, `statement_timeout`, hành vi khi DB rớt giữa chừng, `pool.end()`).
2. `jose` thật: `createRemoteJWKSet` và xác thực JWT từ JWKS qua `main.ts`. Test startup không đăng nhập bằng JWT thật; cô lập tenant + audit được kiểm ở integration trong-tiến-trình (`registry-pg`, `http-pg`, `clinical-pg`, `tenant-status-pg`) cùng wiring thành phần, không qua `main.ts`.
3. Dockerfile chưa từng được build; `HEALTHCHECK`, user non-root, bundle chạy trong image chưa kiểm.
4. Mọi lệnh chạy bằng tay ở trên không được tự động hóa thành CI evidence cho đến khi CI chạy được với npm thật.
