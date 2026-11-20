# HCOS-F7 — Đặt lịch khám online

Nối tiếp HCOS-F6. Migration mới: **011_online_booking.sql**.

Quyết định đã chốt với chủ sản phẩm:
- người bệnh **không cần tài khoản**, nhận **mã đặt lịch** để tra cứu / huỷ;
- lịch đặt **theo buổi** (sáng / chiều), mỗi phòng có **giới hạn số chỗ** mỗi buổi;
- khi đến, **lễ tân check-in → cấp số** vào hàng đợi F6.

**Kiểm chứng trên sandbox:**
- tsc strict sạch. Suite mới: `tests/clinical/booking-rules.test.ts` (4), `tests/http/booking-api.test.ts` (6), integration `booking-pg` (10).
- Các suite queue / HTTP / clinical cũ vẫn đạt.
- E2E Playwright: quản lý cấu hình → người bệnh đặt trên điện thoại → trùng SĐT → tra cứu sai/đúng → huỷ → lễ tân check-in (hồ sơ cũ trùng + hồ sơ mới) → số xuất hiện ở Hàng đợi.
- Seed thực tập chạy hai lần: lần hai bỏ qua toàn bộ.
- Kết quả chính thức là CI trên PR.

## 1. Luồng
1. **Quản lý** (clinic_admin / tenant_admin), tab **Lịch hẹn → Cài đặt đặt lịch online**:
   - đặt **số chỗ mỗi buổi** cho từng phòng (0 = không nhận đặt online);
   - tạo **đường dẫn đặt lịch** (`/app/#/book/<tên>`), có thể **Tạm ngừng / Mở lại**.
2. **Người bệnh** mở đường dẫn (trang dành cho điện thoại, không đăng nhập):
   - chọn phòng → ngày + buổi (hiện số chỗ còn lại) → điền họ, tên, ngày sinh, giới, SĐT, CCCD (tuỳ chọn), lý do;
   - đánh dấu **đồng ý xử lý dữ liệu cá nhân** (bắt buộc);
   - nhận **mã đặt lịch** dạng `XXXX-XXXX` (8 ký tự, bỏ các ký tự dễ nhầm 0/O, 1/I/L). Mã chỉ hiện **một lần**.
   - **Tra cứu / huỷ** ở `/app/#/book/<tên>/tra-cuu` bằng mã + SĐT đã đặt.
3. **Lễ tân** (clinic_staff / clinic_admin), tab **Lịch hẹn**:
   - nhập mã (hoặc bấm **Check-in** trên danh sách trong ngày nếu người bệnh quên mã);
   - hệ thống đưa ra **hồ sơ cũ có thể trùng** (trùng CCCD, họ tên + ngày sinh, hoặc SĐT + ngày sinh); lễ tân chọn một hồ sơ, hoặc **tạo hồ sơ mới** từ thông tin đặt lịch (chỉ cần nhập MRN);
   - chọn ưu tiên (tự gợi ý theo tuổi) → **Check-in & cấp số**: gắn hồ sơ và cấp số vào **đúng phòng đã đặt** trong cùng một transaction → **In phiếu**.
   - Lễ tân cũng **huỷ** được lịch (trả lại chỗ).

## 2. Quy tắc buổi
- Đặt trước tối đa **14 ngày**; không nhận **Chủ nhật**.
- Trong ngày: buổi sáng đóng nhận lịch lúc **11:00**, buổi chiều lúc **16:00** (giờ VN). Người bệnh huỷ được tới cùng mốc đó.
- Check-in chỉ đúng **ngày khám** (theo giờ VN).
- Một SĐT chỉ có **một lịch còn hiệu lực mỗi ngày** tại một cơ sở (huỷ rồi thì đặt lại được).

## 3. Bảo mật
- **Cổng công khai chỉ ghi.** Không bao giờ trả hồ sơ bệnh nhân. Tra cứu chỉ trả trạng thái, ngày, buổi, tên phòng và **tên gọi** (không họ, không ngày sinh).
- **Mã không lưu thô:** DB chỉ giữ SHA-256 của mã (`code_hash`). Mã có ~8,5×10¹¹ khả năng và phải khớp cùng SĐT.
- **Không dò được:** slug sai, mã sai, SĐT sai, cổng tạm ngừng, tenant bị đình chỉ đều trả **cùng một 404**.
- **Giới hạn tần suất theo IP** (trong bộ nhớ tiến trình API): đặt lịch 5 lượt / 10 phút; tra cứu + huỷ 20 lượt / 10 phút; xem buổi 120 lượt / phút → 429 + `Retry-After`.
  - IP lấy từ `X-Forwarded-For` (phần tử cuối) **chỉ khi** kết nối đến từ proxy nội bộ (loopback / mạng riêng, tức Caddy); nếu không, dùng địa chỉ socket.
- **Bẫy bot:** trường ẩn `website`; có giá trị → từ chối.
- **Tra slug** qua hàm DB `clinical.booking_portal(slug)` (SECURITY DEFINER, `search_path` cố định, chỉ trả cổng đang bật của tenant `active`). Mọi thao tác sau đó chạy dưới tenant context của cơ sở (RLS FORCE). Audit actor là `service:public-booking`; payload audit không có dữ liệu cá nhân.
- Lỗi lạ ở cổng công khai → 500 với thông điệp chung, không lộ chi tiết.
- Quyền nhân viên: hành động mới **`booking:read`** (clinic_staff, clinic_admin) để xem lịch / tra mã; check-in và huỷ dùng `queue:issue`; cấu hình dùng `queue:manage`. Bác sĩ không thấy tab Lịch hẹn. Access policy (chỉ thu hẹp) có thể bỏ `booking:read`.

## 4. Toàn vẹn dữ liệu (migration 011)
- `clinical.service_points.booking_capacity` (0–500).
- `clinical.booking_portals`: một cổng mỗi cơ sở; slug duy nhất toàn hệ thống; chỉ `is_active` được sửa.
- `clinical.booking_counters`: số chỗ đã giữ theo (phòng, ngày, buổi). Giữ chỗ **nguyên tử**: `INSERT … ON CONFLICT DO UPDATE SET booked = booked + 1 WHERE booked < sức chứa` — nhiều người đặt cùng lúc không vượt sức chứa (integration: 4 người / 2 chỗ → đúng 2 thành công).
- `clinical.bookings`:
  - thông tin người đặt **bất biến**; trạng thái chỉ đi `booked → checked_in | cancelled | no_show`;
  - `checked_in` bắt buộc có hồ sơ + phiếu số; `cancelled` bắt buộc có người huỷ + thời điểm;
  - FK tổng hợp theo (tenant, organization) tới phòng, hồ sơ, phiếu số.
- **Ràng buộc trì hoãn** (deferred constraint trigger): bộ đếm luôn bằng số lịch `booked + checked_in` của buổi đó; sửa tay lệch → 23514 khi commit.
- RLS FORCE trên cả ba bảng; không DELETE / TRUNCATE.

## 5. API
Nhân viên (đăng nhập):

| Method | Đường dẫn | Quyền |
|---|---|---|
| GET | `/api/bookings?organization=&date=` | booking:read |
| GET | `/api/bookings/by-code?organization=&code=` | booking:read |
| GET | `/api/bookings/:id` | booking:read |
| POST | `/api/bookings/:id/check-in` `{ patientId, priorityReason? }` | queue:issue |
| POST | `/api/bookings/:id/cancel` | queue:issue |
| POST | `/api/service-points/:id/booking-capacity` `{ capacity }` + If-Match | queue:manage |
| GET | `/api/booking-portal?organization=` | queue:manage hoặc booking:read |
| POST | `/api/booking-portal` `{ organizationId, slug }` | queue:manage |
| POST | `/api/booking-portal/active` `{ organizationId, isActive }` + If-Match | queue:manage |

Công khai (không token, xử lý trước xác thực trong `server.ts`):

| Method | Đường dẫn |
|---|---|
| GET | `/api/public/booking/<slug>/options` |
| POST | `/api/public/booking/<slug>/bookings` → 201 `{ code, … }` |
| POST | `/api/public/booking/<slug>/lookup` `{ code, phone }` |
| POST | `/api/public/booking/<slug>/cancel` `{ code, phone }` |

Lookup / cancel dùng POST để SĐT không nằm trong URL và log. Lý do lỗi nghiệp vụ nằm ở `issue[0].details.text`: `SESSION_FULL`, `SESSION_CLOSED`, `PHONE_ALREADY_BOOKED`, `CONSENT_REQUIRED`, `INVALID_PHONE`, `INVALID_NATIONAL_ID`, `ROOM_NOT_BOOKABLE`, `NOT_CANCELLABLE`, `RATE_LIMITED`.

## 6. Pháp lý và lưu trữ (cần rà soát trước khi dùng thật)
- **Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân:** trang đặt lịch thu **sự đồng ý rõ ràng** (ô đánh dấu, không đánh sẵn) kèm mục đích xử lý. DB lưu `consent_version` và `consent_at`. Đổi nội dung đồng ý → tăng `CONSENT_VERSION` trong `booking.service.ts`.
  - "Lý do khám" có thể là **dữ liệu sức khoẻ (dữ liệu nhạy cảm)**; nội dung đồng ý đã nêu rõ. Cần pháp chế duyệt câu chữ chính thức.
- **Lưu trữ:** chưa có job xoá / ẩn danh lịch hẹn. Đề xuất: lịch `cancelled` / `no_show` / chưa check-in quá hạn ẩn danh hoá sau 90 ngày; lịch đã check-in giữ theo hồ sơ khám. Chưa làm ở bản này.
- `no_show`: DB đã có trạng thái nhưng chưa có thao tác đánh dấu (sẽ làm cùng job cuối ngày).

## 7. Bổ sung (PR sau F7): mã QR + khớp hồ sơ theo độ tin cậy
- **Mã QR** trên màn xác nhận đặt lịch, ngay trên mã chữ. QR **chỉ chứa mã đặt lịch** (không có thông tin cá nhân).
  - Bộ mã hoá QR tự viết (`apps/web/src/lib/qr.ts`, chế độ byte UTF-8, phiên bản 1–40, mức L/M/Q/H), vẽ bằng SVG nên hợp CSP và không cần thư viện ngoài. Đã giải mã kiểm chứng bằng OpenCV; test giữ băm ma trận tham chiếu (`tests/web/qr.test.ts`).
  - Ô "Mã đặt lịch" ở tab Lịch hẹn tự focus và nhận máy quét kiểu bàn phím (gõ mã + Enter). Sau khi tìm thấy, mã được bôi chọn để lượt quét kế tiếp ghi đè.
  - **Bảng ký tự mã mới không có nguyên âm, D, W** (`BCFGHJKMNPQRSTVXZ2-9`): máy quét gõ như bàn phím, nếu máy lễ tân đang bật Telex/VNI thì "AS", "A1", "DD", "W"… bị biến thành dấu. Không có nguyên âm thì bộ gõ không đổi gì. Mã cũ (bảng ký tự đầu) vẫn tra được.
- **Khớp hồ sơ cũ theo độ tin cậy**: CCCD → SĐT + ngày sinh → họ tên + ngày sinh (không phân biệt dấu và thứ tự họ/tên) → chỉ SĐT (có thể là người nhà).
  - Chỉ **chọn sẵn** khi đúng một hồ sơ khớp mạnh (CCCD hoặc SĐT + ngày sinh). Chỉ trùng tên / chỉ trùng SĐT: không chọn sẵn, hiện cảnh báo đối chiếu giấy tờ.
  - Nhãn xanh = khớp mạnh, vàng = cần kiểm tra; thêm nhãn "ngày sinh khác lịch đặt" khi hồ sơ khớp CCCD/SĐT nhưng ngày sinh lệch.

## 8. Chưa làm / hướng tiếp
- Gửi SMS / Zalo xác nhận và nhắc lịch.
- Kiosk tự check-in bằng mã.
- Giới hạn tần suất dùng chung khi chạy nhiều tiến trình API (hiện trong bộ nhớ từng tiến trình).
- Khung giờ chi tiết trong buổi, ngày nghỉ lễ.
