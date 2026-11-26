# HCOS-F4 — Ứng dụng web tối thiểu (`/app`)

Nối tiếp HCOS-F3. Không có migration mới. Phần kê đơn thêm sau, ở HCOS-F5 (`HCOS-F5_Prescriptions.md`); hàng đợi số thứ tự và màn hình TV ở HCOS-F6 (`HCOS-F6_Visit_Queue.md`).

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
| `GET /api/worklist?organization=<id>` | Danh sách đang khám: đợt `in_progress` của cơ sở (tối đa 200, cũ nhất trước), có MRN, họ tên, lý do khám, bác sĩ. Cần quyền đọc hồ sơ; từng đợt khám còn qua `encounter:read` (lọc hoặc che lý do theo policy). Không trả CCCD hay liên lạc. Có audit `encounter.worklist`. |

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
- Khi cập nhật `web-dist`, **xoá nội dung bên trong rồi chép vào** (`find web-dist -mindepth 1 -delete && cp -r apps/web/dist/. web-dist/`). Nếu xoá cả thư mục rồi tạo lại, container Caddy vẫn giữ bind mount tới thư mục cũ và tiếp tục phục vụ bản cũ.
- Biến `HCOS_ENV_LABEL` lúc build: nếu có giá trị, web hiện một dải cảnh báo ở đầu trang (dùng cho môi trường thực tập, xem `deploy/staging/TRAINING.md`). Nếu để trống thì không hiện.
- Mọi đường dẫn con đều fallback về `index.html`.
- Realm template thêm redirect `https://smart.id.vn/app/callback` và post-logout `https://smart.id.vn/app/` cho client `hcos-web`.
- Realm đang chạy phải được cập nhật bằng kcadm (xem runbook staging).

## 5. Điều hướng (giao diện đợt 2)
- Danh mục ứng dụng ở `apps/web/src/lib/nav.tsx` (`APPS`): khoá, đường dẫn, nhóm, biểu tượng (`lib/icons.tsx`, nét đơn, không thư viện ngoài), từ khoá tìm không dấu, hàm quyền (`can.*`) và các route thuộc ứng dụng. Chỉ hiện ứng dụng vai trò được phép; máy chủ vẫn kiểm tra quyền ở từng API.
- ≥ 1024px: thanh bên theo nhóm + thanh trên sáng (tên mục, ô Cơ sở, chuông). Hẹp hơn: thanh trên màu thương hiệu + **thanh dưới đáy** (tối đa 4 mục ghim + "Ứng dụng") + **lưới ứng dụng** (bảng trượt, ô tìm, Esc để đóng).
- Ghim mặc định theo vai trò (`ROLE_PINS`, vai trò quản trị ưu tiên trước); người dùng sửa ghim, lưu ở `localStorage` khoá `hcos.nav.pins.v1.<userId>` (chỉ là tiện ích theo trình duyệt; không lưu được thì dùng mặc định). Không lưu dữ liệu bệnh nhân.
- Vào `#/` => mở mục ghim đầu tiên.

## 6. Giới hạn đã biết
- Không có chế độ offline. Tải lại trang thì phải đăng nhập lại; đây là đánh đổi có chủ ý để token không bị lưu.
- Danh sách membership tối đa 500 dòng mỗi organization. Chưa có phân trang trong danh sách đợt khám (lấy tối đa 50 đợt gần nhất).
- Chưa có in ấn hay xuất đơn thuốc. Chưa có giao diện gộp hoặc tách hồ sơ person.
