# HCOS-F14 — Quầy trả: soạn thuốc, gọi ra quầy, giao thuốc + trả hồ sơ + quyết toán

## Vì sao
Trước F14, khám xong thì người bệnh tự đi tìm quầy thuốc rồi quầy thu ngân. Không ai biết đơn đã soạn xong chưa, và tiền tạm ứng thừa hay thiếu phải hỏi lại. F14 thêm một hàng chờ thứ hai sau khám:

```
BS kết thúc khám ─► Đang soạn thuốc ─(dược sĩ "Soạn xong")─► Chờ gọi ra quầy ─("Gọi tiếp" tại Quầy n)─► Đang gọi ─(Hoàn tất)─► Đã trả
       (không có đơn thì bỏ qua bước soạn)                                       ├─ Gọi lại / Vắng mặt ─► Đưa lại hàng chờ
                                                                                └─ Trả về hàng chờ (đổi quầy)
```

## Quy tắc
- **Tự vào hàng chờ.** Khi BS kết thúc khám (`in_progress → finished`), CSDL tạo phiếu trả trong **cùng transaction**:
  - **Giữ số thứ tự cũ** (vd. `N1-007`), nên người bệnh không cần nhớ số mới.
  - Khám không qua hàng đợi thì được cấp số `R-001…`, đếm lại mỗi ngày.
  - Mức ưu tiên được giữ nguyên.
  - Không tạo phiếu trả cho khám từ xa, hoặc đợt khám bắt đầu trước đó hơn 24 giờ (nhập bù, đóng muộn).
- **Dược sĩ soạn thuốc.** Cấp thuốc như cũ ở thẻ "Đơn chờ cấp", rồi bấm **Soạn xong** ở thẻ "Soạn thuốc cho quầy trả". Nếu còn thuốc chưa cấp đủ (hết hàng…) thì phải ghi lý do mới chuyển được. Quầy sẽ thấy lý do này.
- **Gọi ra quầy.** Người đứng quầy chọn quầy mình ngồi (máy nhớ lựa chọn) rồi bấm **Gọi tiếp**:
  - Thứ tự gọi: cấp cứu trước, rồi ưu tiên, rồi theo giờ soạn xong.
  - Mỗi quầy chỉ gọi một số tại một thời điểm (CSDL chặn).
  - Hai quầy bấm cùng lúc sẽ nhận hai số khác nhau (`SKIP LOCKED`).
- **Một người làm cả ba việc tại quầy:**
  1. **Giao thuốc:** xem thuốc đã cấp so với số kê, đánh dấu "Đã giao thuốc và dặn cách dùng".
  2. **Trả giấy tờ:** chọn "Đã trả CCCD / thẻ BHYT / sổ khám / kết quả" hoặc "Không giữ giấy tờ nào".
  3. **Quyết toán:** hồ sơ thanh toán nhúng ngay trên màn quầy để ghi chi phí. Thiếu tiền thì **thu thêm** (phiếu thu), dư thì **hoàn ứng** (phiếu chi). Phải đang mở ca thu ngân.
- **Hoàn tất** chỉ được khi đã giao thuốc (nếu có đơn) và **số dư thanh toán = 0**. Hồ sơ thanh toán đang mở được **đóng trong cùng transaction**.
- **Chỉ người đã gọi số** mới gọi lại, báo vắng, trả về hàng chờ hay hoàn tất được.
- **Huỷ phiếu trả** (người bệnh về trước…) phải ghi lý do. Không huỷ được số đang gọi hoặc đã xong.

## Quyền
| Action | Vai trò |
|---|---|
| `handover:read` | dược sĩ, quản lý kho dược, lễ tân / điều dưỡng, thu ngân, quản lý PK, quản trị |
| `handover:prepare` | dược sĩ, quản lý kho dược |
| `handover:serve` | dược sĩ, lễ tân, thu ngân, quản lý PK (lập phiếu thu / chi vẫn cần `finance:collect` + ca đang mở) |
| `handover:manage` | quản lý PK, quản trị |

Tài khoản thực tập mới: **`tt.quaytra1`** (Lý Thu Trang), vai trò dược sĩ + thu ngân.

## Màn hình TV
TV dùng chung đường dẫn với màn hình gọi số F6:
- Cột **ĐANG GỌI**: thêm dòng "`N1-007` → Quầy 2"; bật đọc số thì máy đọc "Mời số N1 007 đến Quầy 2".
- Cột **SẮP TỚI**: thêm nhóm "Lấy thuốc · trả hồ sơ". Số đậm là đang chờ gọi ra quầy, số mờ là đang soạn thuốc.
- Không có tên, MRN hay bất kỳ dữ liệu bệnh nhân nào; dữ liệu đọc qua hàm `clinical.handover_board(key)` (SECURITY DEFINER).

## CSDL (migration 017)
- **Bảng:**
  - `clinical.handover_desks`: quầy (mã, tên hiện trên TV, đang mở).
  - `clinical.handover_counters`: số `R-…` theo ngày.
  - `clinical.handover_tickets`: phiếu trả.
- **Bất biến:**
  - Mỗi đợt khám một phiếu trả.
  - Nội dung phiếu không sửa được.
  - Trạng thái chỉ đi theo bước hợp lệ.
  - Đang gọi hoặc đã xong thì phải có quầy và người gọi.
  - Đã xong thì phải có người hoàn tất và biên bản giao (`checklist`).
  - Không DELETE / TRUNCATE; RLS FORCE theo tenant.

## API
- `GET /api/handover/desks?organization=`
- `POST /api/handover/desks { organizationId, code, name }`
- `POST /api/handover/desks/:id/active { isActive }` + `If-Match`
- `POST /api/handover/desks/:id/call-next` → `{ handover | null }`
- `GET /api/handover?organization=[&includeDone=1]`: mỗi phiếu trả kèm danh sách thuốc và số dư hồ sơ thanh toán đang mở.
- `GET /api/handover/:id`
- `POST /api/handover/:id/prepared { note? }`
- `POST /api/handover/:id/(recall|skip|release|requeue)`
- `POST /api/handover/:id/cancel { note }`
- `POST /api/handover/:id/complete { checklist: { medication?, documents: 'returned'|'none' }, note? }`
- **Lỗi:** `409` với mã `DESK_BUSY`, `DESK_INACTIVE`, `CALLED_BY_OTHER`, `MEDICATION_NOT_DISPENSED`, `MEDICATION_NOT_HANDED`, `BALANCE_NOT_SETTLED` (thông báo ghi số tiền còn thu / còn dư) hoặc `HANDOVER_STATE`; `422 REASON_REQUIRED`.

## Sửa kèm
- Phiếu số, phiếu thu và cột nút in trên cùng một hàng giờ canh trên. Trước đây phiếu ngắn bị đẩy xuống đáy khi phiếu bên cạnh cao hơn.
- Hồ sơ thanh toán đã quyết toán xong (số dư 0) không còn gợi ý sẵn "Thanh toán 500.000".

## Chưa làm
- Tự ghi chi phí thuốc theo số đã cấp (nay vẫn ghi tay từ bảng giá).
- Gửi lên TV/loa thông báo khi soạn thuốc quá lâu (có thể thêm luật Decision Engine).
