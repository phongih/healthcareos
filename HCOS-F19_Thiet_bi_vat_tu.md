# HCOS-F19 — Thiết bị & vật tư y khoa

Hai luồng tách riêng: **vật tư tiêu hao** (gạc, bơm tiêm, que thử…) dùng chung kho lô / FEFO của Dược; **thiết bị định danh** (máy siêu âm, monitor, nồi hấp…) quản lý từng chiếc. Tab mới **Thiết bị**; trang thiết bị `#/tb/<mã tài sản>` (QR dán trên thân máy).

## 1. Vật tư tiêu hao
- **Danh mục:** thêm ở tab Dược → "+ Thêm thuốc / vật tư", chọn loại **Vật tư tiêu hao** (`pharmacy.medications.item_kind = 'supply'`). Nhập kho, lô, hạn dùng, chuyển kho giống thuốc.
  - Vật tư **không kê đơn được**: màn kê đơn ẩn vật tư; máy chủ coi là "không tìm thấy thuốc"; CSDL chặn (trigger trên `clinical.prescription_items`).
- **Kho / tủ trừ vật tư** của cơ sở: thẻ "Vật tư tiêu hao — định mức theo dịch vụ". Chưa chọn thì mọi dòng khi tất toán đều ghi "thiếu".
- **Định mức theo dịch vụ** (`equipment.supply_norms`): mỗi dịch vụ trong bảng giá × vật tư × số lượng / lần. Số lượng 0 = bỏ khỏi định mức. Màn hình hiện **giá vốn vật tư chuẩn** (định mức × đơn giá lô nhập gần nhất).
- **Ghi lô thực tế** (không bắt buộc): bác sĩ / điều dưỡng quét hoặc nhập số lô ở thẻ **"Vật tư đã dùng (ghi lô)"** trong trang đợt khám. Lô gắn vào hồ sơ thanh toán **đang mở** của người bệnh. Huỷ được khi hồ sơ còn mở (bắt buộc lý do).
- **Trừ kho khi TẤT TOÁN** (`equipment.consume_case`, chạy trong cùng transaction đóng hồ sơ):
  1. nhu cầu = định mức × số lượng của từng chi phí còn hiệu lực;
  2. trừ **lô đã ghi thực tế** trước;
  3. phần còn lại tự chọn lô còn hạn, **hết hạn trước dùng trước (FEFO)** ở kho trừ;
  4. lô ghi thực tế vượt định mức vẫn trừ (dòng "ngoài định mức");
  5. **thiếu tồn không chặn tất toán**: ghi dòng `shortfall` (đơn giá lô gần nhất) chờ đối soát, Decision Engine báo P2.
  - Sổ cái kho có loại mới `consume` gắn `billing_case_id`; tồn và sổ cái luôn khớp (ràng buộc có sẵn của Dược).
  - Chạy lại cho cùng hồ sơ không trừ thêm.
- **Giá vốn (COGS)**: `equipment.supply_consumptions` (chỉ-thêm) lưu lô, số lượng, đơn giá, thành tiền, nguồn (`recorded` / `fefo` / `shortfall`). Màn hồ sơ thu ngân sau khi đóng có thẻ **"Vật tư đã trừ khi tất toán — giá vốn …"**. Tab Thiết bị có bảng giá vốn 30 ngày theo dịch vụ.
- **Đối soát dòng thiếu** (quản lý kho / quản lý): ghi chú cách xử lý (nhập bù, điều chỉnh kho, sửa định mức). Chỉ-thêm.
- **Tra cứu thu hồi lô**: nhập số lô → danh sách người bệnh (mã BN, họ tên), số lượng, lúc dùng, gồm cả hồ sơ chưa tất toán đã ghi lô.
  - **Chắc chắn** = lô do nhân viên ghi; **Có khả năng (FEFO)** = hệ thống tự chọn lúc tất toán.
  - Có họ tên nên **bắt buộc lý do** (vd. số công văn thu hồi), quyền `supply:recall`, lần tra được ghi nhật ký kiểm toán.
- **Điểm đặt hàng lại (ROP)**: tab Dự báo tính cả vật tư (tiêu thụ = sổ cái `dispense` + `consume`), có nhãn "vật tư". Luật "Thuốc / vật tư dưới điểm đặt hàng" áp dụng chung.

## 2. Thiết bị định danh
- **Mã tài sản tự sinh** `TByy-nnnn-c`: năm (giờ VN), số thứ tự theo cơ sở / năm, **số kiểm tra Luhn** (cùng thuật toán mã bệnh nhân F13). Gõ sai một chữ số thì báo ngay.
- **Thông tin:** loại, tên, hãng, model, serial (không trùng trong cùng loại / hãng / model), phòng đặt máy (N1, N2… hoặc kho), **phân loại rủi ro A–D** (NĐ 98/2021/NĐ-CP, đã sửa đổi), **số lưu hành**, bảo hành, ngày mua, ngày đưa vào dùng, nguyên giá, số tháng khấu hao.
- **Trạng thái** Đang dùng / Hỏng / Bảo trì / Đã thanh lý **chỉ đổi qua nhật ký chỉ-thêm** (`equipment.device_events`). Role ứng dụng **không có quyền UPDATE** cột trạng thái / phòng.

| Việc | Ai | Trạng thái |
|---|---|---|
| Nhận bàn giao đầu ca | bác sĩ, điều dưỡng, quản lý | không đổi |
| Báo hỏng (bắt buộc mô tả) | bác sĩ, điều dưỡng, quản lý | → Hỏng |
| Ghi chú | bác sĩ, điều dưỡng, quản lý | không đổi |
| Bắt đầu bảo trì | quản lý | → Bảo trì |
| Sửa xong / **sửa chữa lớn** | quản lý | → Đang dùng (sửa chữa lớn: phải kiểm định lại) |
| Chuyển phòng | quản lý | phòng mới |
| Thanh lý (bắt buộc căn cứ) | quản lý | → Đã thanh lý, không ghi thêm được |

- **QR trên thân máy**: trang thiết bị → "Nhãn QR để dán lên máy" → In nhãn. QR trỏ tới `https://<máy chủ>/app/#/tb/<mã>/qr`, **không chứa bí mật**, phải đăng nhập. Thao tác qua QR được đánh dấu "quét QR" trong nhật ký.

## 3. Kiểm định / hiệu chuẩn
Mỗi thiết bị khai báo các **chế độ** áp dụng (chu kỳ tháng, bắt buộc hay không). Cơ sở tự xác định thiết bị thuộc diện nào.

| Mã | Chế độ | Ghi chú |
|---|---|---|
| `atkt` | Kiểm định an toàn & tính năng kỹ thuật | danh mục TT 05/2022/TT-BYT |
| `do_luong` | Kiểm định phương tiện đo | pháp luật đo lường |
| `buc_xa` | Kiểm định an toàn bức xạ | X-quang… |
| `ap_luc` | Kiểm định thiết bị áp lực | nồi hấp… |
| `hieu_chuan` | Hiệu chuẩn / bảo dưỡng định kỳ | thường không bắt buộc |

- **Ghi kết quả** (chỉ-thêm): ngày thực hiện (không ở tương lai), đạt / không đạt, đơn vị thực hiện, **số giấy chứng nhận / tem** (bắt buộc khi đạt), hiệu lực đến (bỏ trống = ngày thực hiện + chu kỳ).
- **Tình trạng:** Còn hạn · Sắp đến hạn (≤ 30 ngày) · Quá hạn · Không đạt · Chưa kiểm định · Cần kiểm định lại (có "sửa chữa lớn" sau lần gần nhất, kể cả cùng ngày nhưng sau lúc ghi kết quả).
- **Máy KHÔNG được dùng** khi: đang Hỏng / Bảo trì, hoặc một chế độ **bắt buộc** quá hạn / không đạt / chưa kiểm định / cần kiểm định lại. Chế độ không bắt buộc chỉ nhắc.
- **Xuất trình thanh tra:** nút **"Xuất sổ thiết bị (Excel)"** (qua `POST /api/exports`, bộ dữ liệu `equipment_register`, ghi nhật ký xuất F18; không có dữ liệu cá nhân). Hai sheet: Sổ thiết bị (phân loại, số lưu hành, bảo hành, trạng thái, được dùng / lý do, hạn từng chế độ, khấu hao) và Kiểm định – hiệu chuẩn (mọi lần, số GCN).

## 4. Chặn chỉ định nhầm
- Thẻ **"Dịch vụ cần máy"**: gắn dịch vụ trong bảng giá với loại máy (vd. SA-BUNG → Máy siêu âm).
- Khi cơ sở **không còn chiếc nào của loại đó dùng được**, thêm chi phí dịch vụ bị từ chối (`DEVICE_UNAVAILABLE`); CSDL cũng chặn (trigger trên `finance.charges`).
- Phạm vi: theo **cơ sở**, chưa theo từng phòng (dịch vụ trong bảng giá chưa gắn phòng thực hiện).

## 5. Cảnh báo (Decision Engine, chạy mỗi 5 phút) + Teams
Ba bộ phát hiện mới (nhóm "Thiết bị & vật tư"):

| Bộ phát hiện | Chỉ số |
|---|---|
| `device_inspection` | `days_to_due`, `overdue`, `mandatory` (theo từng máy × chế độ) |
| `device_out_of_service` | `out_of_service`, `broken`, `hours_out` |
| `supply_shortfall` | `shortfall_qty`, `lines`, `oldest_hours` |

Luật mẫu (`setup-training.sh`):
- **P2** — sắp đến hạn kiểm định / hiệu chuẩn (`days_to_due ≤ 30`, chưa quá hạn);
- **P1** — quá hạn / không đạt kiểm định **bắt buộc**;
- **P1** — thiết bị Hỏng / Bảo trì;
- **P2** — vật tư thiếu khi tất toán.

Sự kiện P1–P2 đi ra Teams qua kết nối đã gắn nhà cung cấp được duyệt (F18). Nội dung chỉ có mã tài sản, tên máy, phòng, hạn. **Mô tả lỗi do nhân viên gõ KHÔNG gửi ra ngoài** (có thể vô tình chứa thông tin người bệnh) — xem trên trang thiết bị.

Sổ nguồn dữ liệu AI: thẻ `decision_engine_stats` lên phiên bản `2026.11-f19` (danh mục bộ phát hiện đổi; thuật toán thống kê không đổi).

## 6. Khấu hao → What-If
- **Đường thẳng theo tháng**: mỗi tháng = nguyên giá ÷ số tháng (làm tròn đồng), tháng cuối trích phần lẻ; trích từ tháng đưa vào dùng; máy hỏng / bảo trì vẫn trích; thanh lý thì dừng sau tháng thanh lý.
- Số tháng sử dụng do cơ sở nhập theo khung của Bộ Tài chính, **kế toán xác nhận** — hệ thống không tự chọn.
- Tab Dự báo → dòng tiền: thêm dòng **"Khấu hao thiết bị"** (không chi tiền mặt), cộng vào chi phí cố định khi tính lợi nhuận và điểm hòa vốn. **Đừng** cộng khấu hao vào "Chi phí cố định / tháng" nữa.
- Dòng "Giá vốn vật tư 30 ngày" chỉ để tham khảo (thường đã nằm trong % chi phí biến đổi).

## 7. Quyền

| Quyền | Vai trò mặc định |
|---|---|
| `equipment:read` | bác sĩ, điều dưỡng / lễ tân, thu ngân, dược sĩ, quản lý kho, quản lý, ban giám đốc, quản trị |
| `equipment:use` | bác sĩ, điều dưỡng / lễ tân, quản lý |
| `equipment:manage` | quản lý, quản trị |
| `supply:read` | quản lý kho, quản lý, thu ngân, ban giám đốc, quản trị |
| `supply:manage` | quản lý kho, quản lý |
| `supply:record` | bác sĩ, điều dưỡng / lễ tân |
| `supply:recall` | quản lý kho, quản lý |

Policy tạo trước F19 phải thêm action tương ứng (seed thực tập đã bổ sung `equipment:read`, `equipment:use`, `supply:record` cho policy điều dưỡng).

## 8. Dữ liệu
Migration `022_equipment_supplies.sql`, schema `equipment` (12 bảng, RLS FORCE, không xoá được; sổ vật tư đã trừ, nhật ký thiết bị, lần kiểm định, đối soát là chỉ-thêm). Đã gắn nhãn trong danh mục dữ liệu: vật tư đã trừ / lô đã ghi = cấp 3 (lộ dịch vụ người bệnh đã dùng); sổ thiết bị / kiểm định = cấp 2.

## 9. Chưa làm
- Chặn theo **phòng** (dịch vụ chưa gắn phòng thực hiện).
- Sửa thông tin thiết bị trên giao diện (API `POST /api/equipment/devices/:ref` đã có).
- Lịch bảo trì phòng ngừa, hợp đồng bảo trì, nhắc hết bảo hành.
- Đối chiếu danh mục thiết bị phải kiểm định với văn bản hiện hành: **pháp chế / phụ trách vật tư xác nhận** trước khi dùng thật.
