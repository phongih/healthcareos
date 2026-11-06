# HCOS-S0-R2 — Runtime Evidence

> **Cập nhật 2026-11-07:** G0 = PASS dựa trên GitHub Actions run #7 (commit `f491d74`), xem `HCOS-S0-R2_Acceptance.md`. Phần "Ghi nhận ban đầu" bên dưới là bối cảnh sandbox ngày 2026-11-04 (khi chưa có mạng); nó **không** còn là kết luận hiện hành.

## Bằng chứng CI thật (GitHub Actions, repo `phongih/healthcareos`)

| Run | Commit | Kết quả | Ghi chú |
|---|---|---|---|
| #1 | `49389a3` | đỏ | `tsc` thật: `server.address()` kiểu `string \| AddressInfo \| null` (6 lỗi, 3 file test); `integration-postgres` xanh (53s) |
| #2 | `bb2438f` | đỏ | `container`: thiếu `package-lock.json` |
| #3 | `04f15a9` | đỏ | như trên |
| #4 | `6aed992` | xanh | thêm `package-lock.json` (53s) |
| #5 | `5032282` | xanh (giả) | thêm `npm ci` + job `r2-acceptance`; script luôn thoát 0 (lỗi subshell) |
| #6 | `0477efe` | đỏ (đúng) | exit code đã sửa; D3 rớt vì log bị hỏng bởi `tee /dev/stderr`; 20/21 bước PASS (log đã xem) |
| #7 | `f491d74` | **xanh** | D3 đã sửa; cả 21 bước đạt (suy ra từ exit code, log chi tiết trong artifact `r2-evidence`) |

Log run #6 (đã xem trực tiếp): A1–A4, B1–B7, D1, D2, D5–D11 đều `exit=0`; D3 `exit=1` kèm `binary file matches`. Điều này chứng minh bằng CI thật: `npm ci`, `tsc` strict, vitest, PG16, integration (kể cả `main.ts` + JWKS), docker build, user non-root, `/healthz` 200, `/readyz` 200, healthcheck healthy, DB mất ⇒ `/readyz` 503 và `/healthz` 200, `docker stop` thoát 0, không lộ bí mật trong log, cấu hình sai thoát 1.

---

## Ghi nhận ban đầu (sandbox, trước khi có CI thật)
Ghi nhận: 2026-11-04 (UTC 01:22). Phiên này chạy trong sandbox đám mây (`hostname=vm`, `user=root`, `pwd=/home/claude`), **không phải** VM PoC/CI có repo Git và egress tới registry như R2 yêu cầu.

## A. Environment baseline (thật)

| Mục | Kết quả |
|---|---|
| Repo | `git rev-parse` → `fatal: not a git repository` (không có branch/HEAD; working tree không được Git theo dõi) |
| Công cụ | node v22.23.4, npm 10.9.9, Docker client 29.9.2, psql/PostgreSQL 16.15 (cluster tạm cục bộ) |
| npm registry | `npm view jose@5.9.6` → `npm error network`; `curl` trực tiếp → `Could not resolve host`; qua proxy → `CONNECT 403` (`connect_rejected registry.npmjs.org:443`) |
| Docker registry | qua proxy → 403 (`connect_rejected registry-1.docker.io:443`) |
| Docker daemon | `docker info` → `failed to connect to the docker API at unix:///var/run/docker.sock` |
| Cô lập PoC | Không xác nhận được (không có nhãn môi trường/repo PoC) |

Đây là chính sách egress (policy denial), không phải lỗi tạm thời; theo hướng dẫn của môi trường, không thử lại và không đi vòng.

## B–D. Chưa thực hiện được (BLOCKED)
Không có: `npm install`/`npm ci`, `package-lock.json`, `tsc` với type thật, vitest thật, driver `pg` thật, image Docker, container boot, mô phỏng DB mất trong container. Không có log thật nào cho các mục này; không dùng shim để thay thế bằng chứng.

## Phần đã chuẩn bị trong R2 (chạy trên shim, KHÔNG phải bằng chứng G0)

1. **Test JWT/JWKS đầu-cuối** `tests/integration/jwks-e2e.integration.test.ts`: dựng JWKS server cục bộ, chạy `main.ts` là tiến trình thật, gửi HTTP thật. Kiểm: token hợp lệ (tenant lấy từ token); từ chối 401 cho thiếu/rác/khoá giả cùng `kid`/hết hạn/sai audience/sai issuer/`alg:none` (và không tạo dữ liệu); tenant B → 404 trên dữ liệu tenant A; `x-tenant-id` xung đột → 403; tenant bị tạm ngưng → 403 (tra trạng thái dưới RLS); RBAC dược sĩ merge → 403 + audit `denied`; audit `success` có mặt, hash-chain nguyên vẹn, không có PHI trong payload, không lộ mật khẩu DB/JWT trong log; SIGTERM → exit 0.
   Kết quả trên shim (vitest/jose/pg) + PostgreSQL 16.15 thật: **6 passed, 0 failed**. Shim `jose` được mở rộng (JWKS, `exportJWK`) chỉ để chạy thử; hành vi với `jose` thật chưa được kiểm.
2. **`scripts/r2-verify.sh`** (`npm run verify:r2`): chạy tuần tự Phase A→D trên máy có mạng, ghi log từng bước vào `evidence/r2/`, in `SUMMARY.md`, thoát 0 chỉ khi mọi bước bắt buộc đạt. Gồm: `npm install` → lockfile → `npm ci` → `tsc` → unit → PG16 trong Docker → migration (2 lần) → integration → `docker build` → user không phải root → không có credential trong image/env/history → `/healthz`, `/readyz` → healthcheck `healthy` → dừng DB ⇒ `/readyz` 503 & `/healthz` 200 → `docker stop` ⇒ exit 0 → không lộ bí mật trong log → cấu hình sai thoát 1. Script mới chỉ kiểm cú pháp (`bash -n`), **chưa chạy**.

## Giới hạn cần biết cho lần chạy thật
- Các suite `clinical-pg`, `http-pg`, `registry-pg`, `tenant-status-pg` dùng adapter `psql` (không dùng driver `pg`). Chỉ `startup` và `jwks-e2e` (chạy `main.ts`) đi qua `pg.Pool` thật. Nếu cần toàn bộ qua `pg`, phải viết factory pool dùng `pg` cho các suite kia (chưa làm vì không thể kiểm chứng ở đây; kiểu dữ liệu trả về khác adapter).
- URL DB phải là TCP (không hỗ trợ unix-socket).
- `main.ts` yêu cầu login-role thuộc `hcos_app`, không phải superuser.
