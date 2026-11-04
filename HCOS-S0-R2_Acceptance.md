# HCOS-S0-R2 — Acceptance

## Quyết định: **G0 = BLOCKED** (không đổi so với R1)

Nguyên nhân duy nhất: môi trường chạy phiên này bị chính sách egress chặn `registry.npmjs.org` và `registry-1.docker.io` (CONNECT 403), không có Docker daemon, và không phải VM PoC có repo Git. Không dùng đường vòng; không tuyên bố PASS dựa trên shim.

| Tiêu chí bắt buộc (R2) | Trạng thái | Ghi chú |
|---|---|---|
| A. Baseline môi trường PoC (repo, branch, HEAD, registry, cô lập) | ❌ | Không phải repo Git; registry bị chặn; không xác nhận được môi trường PoC |
| B1–B2 `npm install` + `npm ci`, lockfile | ❌ BLOCKED | Chưa có `package-lock.json` |
| B3 `tsc` strict không stub | ❌ BLOCKED | |
| B4 Unit test bằng vitest thật | ❌ BLOCKED | Chỉ có kết quả trên shim (R1: 152/152) |
| B5 Integration PG16 qua driver `pg` thật | ❌ BLOCKED | Chỉ có kết quả trên shim `pg` |
| C. `main.ts` với dependency thật; JWT qua JWKS cục bộ | ❌ BLOCKED | Test viết xong; trên shim: 6/6 (không tính là bằng chứng G0) |
| D. Docker build/run/health/ready/DB down/shutdown/credentials | ❌ BLOCKED | Chưa từng build |

## Việc đã làm trong R2
- Thêm `tests/integration/jwks-e2e.integration.test.ts` (6 test, JWT RS256 + JWKS cục bộ + `main.ts` thật + PG16 + RLS + audit).
- Thêm `scripts/r2-verify.sh` / `npm run verify:r2`: tự động hoá toàn bộ Phase A–D và quyết định PASS/FAIL, kèm log trong `evidence/r2/`.
- Không sửa mã S0/S1 hay assertion nào.

## Cách đóng G0
Trên VM PoC/CI có egress tới npm + Docker registry và repo Git của HealthcareOS:
1. Đưa thư mục này vào repo (nhánh riêng), chạy `npm run verify:r2` (cần docker daemon, `psql`, node ≥ 20).
2. Nếu `evidence/r2/SUMMARY.md` kết thúc bằng `G0 = PASS`: commit `package-lock.json` + `evidence/r2/*`, và cập nhật tài liệu này thành PASS với log thật.
3. Nếu có bước FAIL (khả năng cao nhất: khác biệt hành vi giữa shim và `jose`/`vitest`/`pg` thật, ví dụ kiểu dữ liệu `pg`, thông điệp lỗi, `createRemoteJWKSet` qua http): gửi log bước đó; sửa trong phạm vi PoC rồi chạy lại.
