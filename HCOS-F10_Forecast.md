# HCOS-F10 — Dự báo kinh doanh

Nối tiếp HCOS-F9. Migration mới: **013_forecast.sql**.

Theo đề xuất của chủ sản phẩm: engine dự báo **xác định / thống kê**, chạy ngay trên SQL + backend, **không dùng mô hình AI**. Đã chốt: làm **cả ba phần trong một PR**; **sức khám mỗi buổi do quản lý nhập theo phòng**; **chi phí cố định và % chi phí biến đổi do quản lý nhập, có lịch sử thay đổi**.

**Kiểm chứng trên sandbox:**
- tsc sạch. Integration `forecast-pg` (5 ca): dựng lịch sử với ngày cố định rồi so **từng con số** (trung bình theo thứ × buổi, loại khách tái khám, đặt lịch × tỷ lệ đến, cảnh báo, hệ số ICD-10, ROP, lượng đặt, hàng sắp hết hạn, doanh thu / lượt) + quyền + lịch sử chỉ-thêm. HTTP `forecast-api` (2). Web `whatif` (5, số tính tay).
- E2E trên dữ liệu thực tập: tab **Dự báo** hiện đủ 4 phần; lưu thông số → có dòng lịch sử; khai báo sức khám N1 → xuất hiện cảnh báo; kéo thanh "Phí khám" → số lượt hòa vốn giảm; lễ tân không thấy tab.
- Seed thực tập chạy 2 lần: lần 2 bỏ qua.

## 1. Tải phòng khám (7 / 14 / 30 ngày tới, theo ngày × buổi × phòng)
`Dự kiến = Vãng lai + Đặt lịch + Tái khám`
- **Vãng lai**: trung bình số lượt theo **thứ trong tuần × buổi × phòng**, 8 tuần gần nhất (từ ngày có lượt khám đầu tiên), **đã loại** khách đặt lịch và khách tái khám (để không tính hai lần). Lượt khám = đợt khám ngoại trú / cấp cứu; buổi sáng = trước 12:00 giờ VN; lượt không rõ phòng chia theo tỷ trọng phòng.
- **Đặt lịch**: `max(số lịch đã đặt × tỷ lệ đến, trung bình lịch sử khách đặt lịch cùng thứ × buổi)` — ngày xa chưa có ai đặt vẫn tính theo thói quen cũ. Tỷ lệ đến = check-in ÷ lịch không huỷ (8 tuần); < 10 mẫu → mặc định 85%.
- **Tái khám**: mỗi đơn thuốc có ngày kết thúc = ngày kê + số ngày dài nhất; khả năng quay lại = tỷ lệ thực tế (đơn kết thúc rồi, bệnh nhân có lượt khám trong [-1, +7] ngày); < 10 mẫu → mặc định 30%; rải đều 9 ngày quanh ngày kết thúc.
- **Hệ số theo thứ** = trung bình lượt / ngày của thứ đó ÷ trung bình chung (vd. ×1,5 = đông gấp rưỡi).
- **Cảnh báo**: so với **sức khám tối đa mỗi buổi** của phòng (quản lý khai báo): ≥ 85% "sắp đầy", > 100% "quá tải". Phòng chưa khai báo: không đánh giá.

## 2. Tồn kho thuốc & điểm đặt hàng lại (ROP)
- **d** = tiêu thụ trung bình / ngày theo **sổ cái cấp phát** (tối đa 30 ngày, tối thiểu 7); σ = độ lệch chuẩn theo ngày.
- **Hệ số xu hướng chẩn đoán**: mỗi mã ICD-10 `(số ca 7 ngày + 1) ÷ (TB tuần 21 ngày trước + 1)`, kẹp [0,5; 2]; hệ số của thuốc = trung bình theo số lượng kê của các mã mà thuốc đó được kê cùng (90 ngày). `d' = d × hệ số`.
- `Tồn an toàn = z × σ × hệ số × √L` (z theo mức phục vụ 90 / 95 / 97,5 / 99%), `ROP = d' × L + tồn an toàn`, L = thời gian chờ hàng.
- **Đặt gợi ý** (khi tồn ≤ ROP) = đưa tồn về `d' × (L + 14) + tồn an toàn`; ước giá trị theo giá nhập lô.
- **Tồn dùng được**: mọi vị trí của cơ sở trừ kho cách ly, trừ lô đã hết hạn, trừ số đã giữ chỗ.
- **Có thể hết hạn**: mô phỏng dùng theo FEFO với tốc độ d' — phần không kịp dùng trước hạn (chỉ tính khi có tiêu thụ).
- Trạng thái: hết hàng / **khẩn** (đủ dùng < thời gian chờ hàng) / cần đặt / đủ / chưa có tiêu thụ. Danh sách "chẩn đoán đang tăng" (hệ số ≥ 1,3 và ≥ 2 ca / 7 ngày).

## 3. Dòng tiền 30 ngày & mô phỏng What-If
- Cơ sở: số lượt dự báo 30 ngày (phần 1); **doanh thu / lượt** = doanh thu dịch vụ ÷ số hồ sơ có chi phí (30 ngày qua); tỷ lệ hồ sơ có phí khám; chi phí cố định / tháng; % chi phí biến đổi. Chưa có dữ liệu thu ngân → nhập tạm doanh thu / lượt để mô phỏng.
- Thanh trượt (tính ngay trên trình duyệt): **lịch đặt online** −50…+100%, **phí khám** −100k…+200k, **giảm tỷ lệ huỷ / vắng** 0…100%.
- Kết quả hiện tại vs kịch bản: lượt khám, doanh thu / lượt, doanh thu, chi phí biến đổi, lợi nhuận, **doanh thu hòa vốn** `= cố định ÷ (1 − % biến đổi)`, **lượt hòa vốn** `= cố định ÷ lãi góp mỗi lượt`, biên an toàn.
- **Giả định ghi rõ trên màn hình**: lịch online thêm là khách mới; đổi phí khám không làm đổi lượng khách (chưa có độ co giãn); 30 ngày ≈ 1 tháng chi phí cố định.

## 4. Quyền
| Hành động | Vai trò |
|---|---|
| `forecast:read` — tải phòng khám, dòng tiền | clinic_admin, executive, tenant_admin |
| `forecast:inventory` — tồn kho | + pharmacy_admin |
| `forecast:manage` — thông số, sức khám | clinic_admin, tenant_admin |

## 5. Dữ liệu (migration 013)
- `clinical.service_points.visit_capacity` (1–500, NULL = chưa khai báo).
- `finance.forecast_settings` (chi phí cố định / tháng, % biến đổi < 100, thời gian chờ hàng 1–90 ngày, mức phục vụ 90/95/97,5/99) — If-Match.
- `finance.forecast_settings_history`: **chỉ thêm**, do trigger `SECURITY DEFINER` ghi; app không INSERT / UPDATE / DELETE được (không thể làm giả lịch sử).
- RLS FORCE; mọi lần xem / sửa có audit.

## 6. Giới hạn — đọc kỹ trước khi dùng số
- Đây là **trung bình có điều chỉnh**, không bắt được mùa dịch / lễ tết / bác sĩ nghỉ. Cần ≥ 14 ngày lịch sử (màn hình cảnh báo nếu thiếu), tốt nhất ≥ 8 tuần.
- Trên staging, dữ liệu giả có lịch sử khám 30 ngày nhưng sổ kho và đơn thuốc đều tạo cùng một ngày → tiêu thụ và tỷ lệ tái khám **chưa có ý nghĩa**; màn hình ghi rõ "mặc định — chưa đủ dữ liệu".
- Hướng tiếp: khoảng tin cậy, lịch ngày nghỉ, độ co giãn giá, so sánh dự báo với thực tế (đo sai số), xuất kế hoạch đặt hàng ra Excel.
