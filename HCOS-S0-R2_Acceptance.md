# HCOS-S0-R2 — Acceptance

## Quyết định: **G0 = PASS**

Căn cứ: GitHub Actions workflow `ci`, run **#7**, commit `f491d74` (nhánh `main`, 2026-11-04 08:34Z), kết luận **xanh** (1m22s). Run này gồm 4 job: `typecheck-and-unit`, `integration-postgres`, `container`, `r2-acceptance`.

Tính đáng tin của kết quả xanh:
- `scripts/r2-verify.sh` thoát khác 0 nếu bất kỳ bước nào rớt hoặc có ít hơn 21 bước. Đã được chứng minh trên CI thật: run #6 (commit `0477efe`) đỏ đúng vì bước D3 rớt, trong khi trước bản sửa exit code (`5032282`, run #5) job xanh dù D3 rớt (lỗi của script, đã sửa).
- Run #7 là lần đầu cả 21 bước đạt sau khi sửa bước D3 (lỗi script: `tee /dev/stderr` làm hỏng log bước, không phải credential trong image).

| Tiêu chí bắt buộc | Kết quả | Bước / bằng chứng |
|---|---|---|
| A. Baseline (host, repo, branch, HEAD, tool, registry npm + Docker) | ✅ | A1–A4 |
| Cài dependency thật; lockfile; cài lại tái lập | ✅ | `package-lock.json` đã commit (`6aed992`); B1 `npm install`, B2 `npm ci` |
| TypeScript strict, không stub | ✅ | B3 (và job `typecheck-and-unit`) |
| Unit test bằng vitest thật | ✅ | B4 |
| Integration trên PostgreSQL 16 | ✅ | B5 (PG 16), B6 (migration áp dụng 2 lần), B7 |
| `main.ts` với `pg`/`jose` thật; JWT qua JWKS cục bộ; cô lập tenant + audit qua HTTP thật | ✅ | B7 gồm `startup` và `jwks-e2e` (chạy `main.ts` thật) |
| Liveness/readiness; role DB an toàn; cấu hình sai; tắt êm; không lộ bí mật | ✅ | B7, D5–D11 |
| Docker build, user không phải root | ✅ | D1, D2 |
| Không có credential trong image | ✅ | D3 (sau khi sửa script) |
| Container: `/healthz`, `/readyz`, healthcheck `healthy` | ✅ | D5–D7 |
| DB mất ⇒ `/readyz` 503, `/healthz` 200 | ✅ | D8 |
| `docker stop` thoát mã 0 trong 15 giây | ✅ | D9 |
| Log container không lộ mật khẩu | ✅ | D10 |
| Cấu hình sai trong container thoát mã 1, không lộ | ✅ | D11 |

## Hành trình sửa lỗi (đều trong phạm vi PoC)
1. Run #1 đỏ: `tsc` với type thật phát hiện `server.address()` là `string | AddressInfo | null` (stub ở sandbox che mất) → sửa 3 test.
2. Run #2–#3 đỏ: thiếu `package-lock.json` (Dockerfile dùng `npm ci`) → commit lockfile.
3. Run #5 xanh giả: `r2-verify.sh` luôn thoát 0 vì biến gán trong subshell → sửa (run #6 đỏ đúng).
4. Run #6 đỏ: D3 hỏng do `tee /dev/stderr` ghi đè log bước → sửa → run #7 xanh.

## Giới hạn còn lại (không chặn G0)
- Tôi (tác giả) chưa đọc log chi tiết của run #7; kết luận dựa trên trạng thái run + ngữ nghĩa script đã chứng minh. Log từng bước và `SUMMARY.md` nằm trong artifact `r2-evidence` của run #7 (nên tải lưu cùng repo).
- Các suite `clinical-pg`, `http-pg`, `registry-pg`, `tenant-status-pg` vẫn truy cập DB qua adapter `psql`; chỉ `startup` và `jwks-e2e` đi qua `pg.Pool` thật. Việc chuyển phần còn lại sang `pg` là cải tiến sau.
- Bộ quét credential của D3 là heuristic (từ khoá); không thay thế quét bí mật chuyên dụng (vd. gitleaks) và quét lỗ hổng image.
- Chưa kiểm dưới tải, failover DB, xoay khoá JWKS, hay trên nhiều phiên bản node/PG.
- Đây là PoC: không có dữ liệu bệnh nhân thật, chưa triển khai production.
