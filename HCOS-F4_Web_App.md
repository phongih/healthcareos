# HCOS-F4 — Ứng dụng web tối thiểu (`/app`)

Nối tiếp HCOS-F3. Không có migration mới.

**Trạng thái kiểm chứng trên sandbox:**
- Backend: tsc strict sạch; toàn bộ unit suite và 9 integration suite (PG 16) xanh.
- Web: build bằng esbuild và chạy e2e Playwright cho đủ 4 luồng, dưới đúng CSP của Caddy.
- Typecheck của web mới chạy với shim kiểu React. Kết quả typecheck với `@types/react` thật là job `web` trên GitHub Actions.

## 1. Phạm vi
| Luồng | Vai trò | Màn hình |
|---|---|---|
| Lễ tân | clinic_staff, doctor | Tìm bệnh nhân theo MRN, CCCD, hoặc họ tên + ngày sinh. Đăng ký mới; trùng thì trả 409 và hiện cảnh báo. |
| Bác sĩ | doctor | Mở đợt khám, ghi chẩn đoán ICD-10 và sinh hiệu (LOINC/UCUM), đóng đợt khám (`$close` kèm If-Match). |
| Dược | pharmacist, pharmacy_admin | Quản lý kho, xem tồn theo lô (giá vốn bị che nếu policy che), nhập kho, cấp phát theo đợt khám, danh mục thuốc. |
| Quản trị | tenant_admin | Access policy: tạo, validate, sửa (revise), ngừng (retire), xem các phiên bản. Gán policy cho membership. |

- Menu hiển thị theo `GET /api/me`, tức là theo membership trong DB, không theo claim JWT.
- Server vẫn là nơi quyết định quyền: UI chỉ ẩn nút, mọi request vẫn bị kiểm tra lại.
- Trường bị policy che hiển thị nhãn "đã che".

## 2. API mới cho web
| Route | Ghi chú |
|---|---|
| `GET /api/me` | Người dùng và các membership còn hiệu lực, kèm tên và loại organization. Không cần quyền admin. |
| `GET /api/memberships?organization=<uuid>` | Chỉ tenant_admin; có ghi audit; tối đa 500 dòng. |
| `GET /fhir/Encounter?patient=<id>` | Bundle searchset, sắp theo period_start giảm dần. |

Về `GET /fhir/Encounter?patient=<id>`:
- Cần quyền `patient:read` tại organization của bệnh nhân.
- Đợt khám mà `encounter:read` từ chối sẽ bị lọc bỏ.
- `reasonText` bị null khi policy che, và đợt khám đó mang nhãn REDACTED.
- Có ghi audit `patient.encounters.list`.
- Chỉ nhận tham số `patient`.

Ngoài ra, tên policy giờ được phép chứa dấu gạch dài (–, —).

## 3. Bảo mật phía trình duyệt
- **OIDC Authorization Code + PKCE S256** với client công khai `hcos-web`.
  - Token chỉ nằm trong bộ nhớ: tải lại trang là phải đăng nhập lại.
  - `sessionStorage` chỉ giữ verifier và state trong lúc redirect, xóa ngay sau callback.
  - Callback kiểm tra state và `sub`.
  - Đăng nhập dùng `prompt=login`.
- **CSP chặt** (đặt ở Caddy, không dùng script hay style inline):
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`
- Header khác: `X-Frame-Options DENY`, `Referrer-Policy no-referrer`.
- Cache: file có hash trong tên được cache `immutable`; `index.html` dùng `no-store`.
- **Chống gửi trùng:**
  - Mỗi form nhập kho và cấp phát có một Idempotency-Key.
  - Key được giữ nguyên khi bấm thử lại.
  - Key được tạo mới khi nội dung form thay đổi.

## 4. Build và triển khai
```bash
cd apps/web
npm install        # lần đầu tạo package-lock.json -> commit file này
npm run typecheck
npm run build      # ra dist/index.html, dist/app-<hash>.js, dist/app-<hash>.css
```
- Caddy phục vụ `deploy/staging/web-dist` (mount chỉ đọc vào `/srv/hcos-web`) tại `/app/`.
- Mọi đường dẫn con đều fallback về `index.html`.
- Realm template thêm redirect `https://smart.id.vn/app/callback` và post-logout `https://smart.id.vn/app/` cho client `hcos-web`.
- Realm đang chạy phải được cập nhật bằng kcadm (xem runbook staging).

## 5. Giới hạn đã biết
- Không có chế độ offline. Tải lại trang thì phải đăng nhập lại; đây là đánh đổi có chủ ý để token không bị lưu.
- Danh sách membership tối đa 500 dòng mỗi organization. Chưa có phân trang trong danh sách đợt khám (lấy tối đa 50 đợt gần nhất).
- Chưa có in ấn hay xuất đơn thuốc. Chưa có giao diện gộp hoặc tách hồ sơ person.
