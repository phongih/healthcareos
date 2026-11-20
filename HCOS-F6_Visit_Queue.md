# HCOS-F6 — Hàng đợi khám theo số thứ tự

Nối tiếp HCOS-F5. Migration mới: **010_visit_queue.sql**.

**Kiểm chứng trên sandbox:**
- tsc strict sạch; 262 test unit đạt. Hai suite mới: `tests/http/queue-api.test.ts` (HTTP) và `queue-pg` (integration).
- 11 suite integration trên PG 16 đạt, gồm `queue-pg` với 8 ca.
- E2E Playwright luồng quản lý → lễ tân → bác sĩ → TV đạt; các e2e cũ vẫn đạt.
- Kết quả chính thức là CI trên PR.

## 1. Luồng
1. **Quản lý** (clinic_admin hoặc tenant_admin) tạo phòng khám ở tab **Hàng đợi → Cài đặt hàng đợi**.
   - Mỗi phòng có mã 1–6 ký tự (vd. `N1`) và tên.
   - Quản lý cũng tạo **đường dẫn màn hình gọi số** cho TV ở sảnh. Đường dẫn chỉ hiện một lần.
2. **Lễ tân** (clinic_staff) mở hồ sơ bệnh nhân, ở thẻ **Cấp số khám** chọn phòng và mức ưu tiên.
   - Hệ thống tự gợi ý ưu tiên theo tuổi: dưới 6 tuổi, hoặc từ đủ 75 tuổi.
   - Sau khi cấp, phiếu số (vd. `N1-007`) hiện ra kèm nút **In phiếu**.
3. **Bác sĩ** mở tab **Hàng đợi**, chọn phòng và bấm **Gọi số tiếp theo**.
   - Thứ tự gọi: cấp cứu trước, rồi các trường hợp ưu tiên, rồi theo số.
   - Với số đang gọi, bác sĩ có ba lựa chọn:
     - **Gọi lại**;
     - **Vắng mặt**;
     - **Bắt đầu khám**: tạo đợt khám (bác sĩ phụ trách là người gọi) và mở thẳng màn đợt khám để chẩn đoán và kê đơn.
4. **Lễ tân** xử lý số vắng mặt: **Đưa lại hàng chờ** (giữ nguyên số) hoặc **Huỷ số**.
5. **TV** mở đường dẫn màn hình, không cần đăng nhập.
   - Màn hình có hai phần: **ĐANG GỌI** (số và phòng; số vừa gọi hoặc gọi lại nhấp nháy 20 giây) và **SẮP TỚI** (5 số kế tiếp mỗi phòng).
   - Tự cập nhật mỗi 3 giây. Có nút **Bật đọc số bằng giọng nói** (trình duyệt yêu cầu bấm một lần).

"Hôm nay" tính theo giờ Việt Nam, trong DB (`clinical.queue_today()`). Số thứ tự bắt đầu lại từ 1 mỗi ngày, riêng cho từng phòng.

## 2. Ưu tiên
Theo khoản 2 Điều 3 Luật Khám bệnh, chữa bệnh 2023:

| Mã | Đối tượng | Hạng |
|---|---|---|
| `emergency` | Người bệnh cấp cứu | 2 (gọi trước nhất) |
| `child_under_6` | Trẻ em dưới 06 tuổi | 1 |
| `pregnant` | Phụ nữ có thai | 1 |
| `severe_disability` | Người khuyết tật nặng, đặc biệt nặng | 1 |
| `elderly_75` | Người từ đủ 75 tuổi | 1 |
| `revolutionary_merit` | Người có công với cách mạng | 1 |

Trong cùng hạng, ai có số nhỏ hơn được gọi trước. Lý do ưu tiên được lưu trên phiếu và ghi vào audit.

## 3. API
| Route | Quyền |
|---|---|
| `GET /api/service-points?organization=` | `queue:read` hoặc `queue:manage` |
| `POST /api/service-points` · `POST /api/service-points/:id/active` (If-Match) | `queue:manage` |
| `GET /api/queue?organization=[&servicePoint=]` | `queue:read` |
| `POST /api/queue/tickets` | `queue:issue` |
| `POST /api/queue/tickets/:id/requeue` · `/cancel` | `queue:issue` |
| `POST /api/queue/service-points/:id/call-next` | `queue:call` |
| `POST /api/queue/tickets/:id/recall` · `/skip` | `queue:call`, chỉ người đã gọi số đó |
| `POST /api/queue/tickets/:id/start` | `queue:call` + `encounter:create`, chỉ người đã gọi số đó |
| `GET/POST /api/queue/displays` · `POST /api/queue/displays/:id/revoke` | `queue:manage` |
| `GET /api/public/queue-board` + header `X-Display-Key` | **không cần đăng nhập** |

- `GET /api/queue` trả 0 dòng cho tới 300 dòng. Kết quả không gồm số đã huỷ.

**Vai trò được cấp từng quyền:**
- `queue:read`: doctor, clinic_staff, clinic_admin;
- `queue:issue`: clinic_staff, clinic_admin;
- `queue:call`: doctor;
- `queue:manage`: clinic_admin, tenant_admin.

Cả bốn action đều có trong catalog access policy. ⚠️ **Policy tạo trước F6 không có các action này**, nên người gắn policy đó sẽ không dùng được hàng đợi (policy chỉ thu hẹp quyền). Muốn họ dùng được thì phải sửa policy, thêm action cần thiết. Seed thực tập đã tự thêm `queue:read` vào policy điều dưỡng.

## 4. Bất biến ở tầng DB (migration 010)
- **Cấp số nguyên tử** qua `clinical.queue_counters` (`INSERT … ON CONFLICT DO UPDATE`).
  - Có UNIQUE trên (phòng, ngày, số).
  - Test: 6 lần cấp đồng thời cho ra 6 số liên tiếp, không trùng.
- **Gọi số** dùng `FOR UPDATE SKIP LOCKED`. Test: hai bác sĩ gọi cùng lúc nhận hai số khác nhau.
- **Mỗi bệnh nhân chỉ có một số còn hiệu lực** (chờ, đang gọi hoặc vắng mặt) mỗi ngày tại một cơ sở. Đảm bảo bằng unique index có điều kiện.
- **FK ghép:** phiếu thuộc đúng cơ sở của phòng và của hồ sơ bệnh nhân; đợt khám gắn vào phải cùng bệnh nhân.
- **Nội dung phiếu bất biến.**
  - Trạng thái chỉ đi theo các bước hợp lệ: waiting → called → in_service hoặc skipped; skipped → waiting hoặc cancelled; waiting → cancelled.
  - Mỗi lần gọi phải tăng số lần gọi.
  - Phiếu "đang khám" bắt buộc gắn đợt khám.
- **Không xoá được;** RLS FORCE theo tenant.
- **Màn hình công khai** chỉ đọc qua hàm `clinical.queue_board(key)` (SECURITY DEFINER, `search_path` cố định).
  - Hàm chỉ trả số thứ tự, mã và tên phòng, mức ưu tiên, số lần gọi, thời điểm gọi. **Không có tên, MRN hay bất kỳ dữ liệu bệnh nhân nào.**
  - DB chỉ lưu SHA-256 của khoá.
  - Khoá dài 43 ký tự ngẫu nhiên (256 bit), nằm trong phần `#` của URL nên trình duyệt không gửi nó lên máy chủ trong URL. Web gửi khoá qua header.
  - Khoá thu hồi được.

## 5. Môi trường thực tập
`seed-training.ts` tạo các phần sau, và chạy lại không tạo trùng:
- 2 phòng: `N1` "Phòng khám Nội 1" và `N2` "Phòng khám Nội 2".
- 1 màn hình "Màn hình sảnh chờ (thực tập)". Đường dẫn chỉ in **một lần** khi tạo.
- **8 số chờ hôm nay** cho các bệnh nhân `TT00001`–`TT00004` và `TT00006`–`TT00009`, chia đều hai phòng, có ưu tiên theo tuổi.
- Số thứ tự tính theo ngày, nên muốn có số chờ mới cho ngày hôm sau thì chạy lại `setup-training.sh`.

## 6. Chưa làm
- Bàn phím hoặc máy in nhiệt chuyên dụng: hiện in phiếu bằng trình duyệt.
- Kiosk cho bệnh nhân tự lấy số; đặt lịch hẹn trước.
- Thống kê thời gian chờ.
- Gán bác sĩ cố định cho phòng.
- Gọi số bằng loa ngoài (đang dùng Speech Synthesis của trình duyệt TV).
- Màn hình TV hỏi lại máy chủ 3 giây/lần, chưa dùng kết nối đẩy (push).
- Múi giờ đang cố định `Asia/Ho_Chi_Minh`.
