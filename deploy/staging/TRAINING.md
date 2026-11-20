# Môi trường thực tập (staging, smart.id.vn/app)

Mục tiêu: nhân viên tập các thao tác hằng ngày bằng **tài khoản theo vai trò thật** trên **dữ liệu giả**.
Đầu trang web luôn có dải màu cam ghi "MÔI TRƯỜNG THỰC TẬP".

## Quy tắc bắt buộc
- **Không nhập thông tin bệnh nhân thật** (tên, CCCD, số điện thoại, chẩn đoán của người thật). Staging không đạt yêu cầu pháp lý cho dữ liệu sức khoẻ thật.
- Cách nhận biết dữ liệu giả:
  - MRN bắt đầu bằng `TT`;
  - CCCD bắt đầu bằng `099` (không phải mã tỉnh nào);
  - số điện thoại bắt đầu bằng `0120` (đầu số đã bị thu hồi).
  Khi tự tạo bệnh nhân để tập, hãy theo cùng quy ước này.
- Mỗi người chỉ dùng tài khoản của mình. Mọi thao tác đều được ghi audit theo đúng người làm.
- Mật khẩu tạm được giao riêng cho từng người. Không dán mật khẩu vào nhóm chat chung.

## Tài khoản
| Tài khoản | Vai trò trong hệ thống | Dùng để tập |
|---|---|---|
| `tt.letan1`, `tt.letan2` | clinic_staff | Lễ tân: tìm và đăng ký bệnh nhân |
| `tt.bacsi1`, `tt.bacsi2` | doctor | Bác sĩ: mở đợt khám, ghi sinh hiệu và chẩn đoán, đóng đợt khám |
| `tt.dieuduong1` | clinic_staff + policy "Điều dưỡng — che CCCD, chỉ ghi sinh hiệu" | Điều dưỡng: ghi sinh hiệu; không thấy CCCD |
| `tt.duocsi1` | pharmacist | Dược sĩ: xem tồn kho, cấp phát theo đợt khám |
| `tt.thukho1` | pharmacy_admin | Thủ kho: danh mục thuốc, tạo kho, nhập lô |
| `tt.quanly1` | clinic_admin + tenant_admin | Quản lý: access policy, gán policy cho nhân viên |

**Lần đăng nhập đầu tiên** tại `https://smart.id.vn/app/`:
1. Nhập mật khẩu tạm.
2. Đặt mật khẩu mới: ít nhất 12 ký tự, không trùng tên đăng nhập.
3. Quét mã QR bằng ứng dụng xác thực (Google Authenticator, Microsoft Authenticator…), rồi nhập mã 6 số.

Từ lần sau, đăng nhập bằng mật khẩu và mã 6 số. Hệ thống không lưu phiên khi tải lại trang, nên mỗi lần tải lại phải đăng nhập lại; đây là thiết kế có chủ đích.

## Dữ liệu có sẵn
- 40 bệnh nhân (`TT00001`–`TT00040`), khoảng 80% có CCCD.
- Đợt khám ngoại trú trong 30 ngày gần nhất, đã đóng, có sinh hiệu, chẩn đoán ICD-10 và thuốc đã cấp phát.
- **8 đợt khám đang mở hôm nay** để tập, ở các bệnh nhân `TT00005`, `TT00010`, `TT00015`, `TT00020`, `TT00025`, `TT00030`, `TT00035`, `TT00040`.
  - Năm đợt `TT00005`–`TT00025` mới có sinh hiệu: để bác sĩ tập chẩn đoán và kê đơn.
  - Ba đợt `TT00030`, `TT00035`, `TT00040` đã có **đơn chờ cấp**: để dược sĩ tập cấp theo đơn.
- Các đợt khám đã đóng đều có đơn thuốc đã cấp đủ.
- 14 thuốc thông dụng; hai kho là "Kho tổng" và "Quầy cấp phát thực tập".
- Ở quầy, mỗi thuốc có 1 lô cận hạn (20–75 ngày) và 1 lô hạn xa. Vì vậy cấp phát sẽ lấy lô cận hạn trước (FEFO).

## Bài tập theo vai trò
**Lễ tân** (`tt.letan1`)
1. Tìm bệnh nhân `TT00012` theo MRN. Sau đó tìm lại người đó theo họ tên và ngày sinh.
2. Đăng ký một bệnh nhân mới với MRN `TT9xxxx` tự đặt và CCCD `099…`.
3. Đăng ký lại đúng người vừa tạo, xem cảnh báo trùng hiện ra thế nào.

**Điều dưỡng** (`tt.dieuduong1`)
1. Mở bệnh nhân `TT00005`. Thấy CCCD bị che (nhãn "đã che").
2. Thử tìm bệnh nhân theo CCCD: hệ thống từ chối, đúng như policy.
3. Vào đợt khám đang mở, ghi nhiệt độ và SpO₂.

**Bác sĩ** (`tt.bacsi1`, `tt.bacsi2`)
1. Màn **Bệnh nhân** có thẻ **Đang khám** (mặc định "Của tôi"), liệt kê các đợt khám chưa kết thúc mà bạn phụ trách. Bấm vào một bệnh nhân để mở đợt khám, rồi xem các sinh hiệu điều dưỡng đã ghi.
   - Chỉ bác sĩ phụ trách mới kê đơn được, và chỉ khi đợt khám chưa kết thúc. Nếu không kê được, màn hình sẽ ghi lý do.
   - Phần lớn đợt khám trong dữ liệu giả đã kết thúc, nên không kê đơn được. Nếu muốn, bác sĩ có thể tự mở đợt khám mới cho bất kỳ bệnh nhân nào.
2. Thêm chẩn đoán, ví dụ `J06.9` (Nhiễm trùng hô hấp trên cấp).
3. Bấm **+ Kê đơn** và kê 2 thuốc, ví dụ:
   - Paracetamol 500, 1 viên × 2 lần/ngày × 5 ngày: số lượng tự tính ra 10;
   - Loratadin 10, 1 viên × 1 lần/ngày × 7 ngày.
   Thêm lời dặn rồi lưu.
4. Kê thêm một đơn sai rồi bấm **Huỷ đơn**. Chỉ huỷ được khi đơn chưa cấp gì.
5. Đợi dược sĩ cấp xong (đơn chuyển sang "Đã cấp đủ"), rồi **Kết thúc đợt khám**.
6. Mở một bệnh nhân bất kỳ, tạo một đợt khám mới.

**Dược sĩ** (`tt.duocsi1`)
1. Chọn "Quầy cấp phát thực tập", xem tồn theo lô. Để ý lô cận hạn.
2. Ở thẻ **Đơn chờ cấp**, cấp đơn của `TT00030`.
   - Cấp một phần trước, rồi cấp phần còn lại.
   - Xem đơn biến khỏi hàng đợi khi đã cấp đủ, và lô cận hạn bị trừ trước.
3. Thử nhập số lượng lớn hơn số còn lại: hệ thống không cho.
4. Cấp đơn mà bác sĩ vừa kê ở bài tập của bác sĩ. Bấm **Tải lại** nếu chưa thấy đơn.
5. Ở thẻ "Cấp phát theo đợt khám" (cấp ngoài đơn), bấm cấp hai lần liền với cùng nội dung: kho chỉ bị trừ một lần.

**Thủ kho** (`tt.thukho1`)
1. Nhập một lô mới vào "Kho tổng" với số lô `TT-…`.
2. Thử nhập một lô có hạn dùng là hôm nay: hệ thống từ chối.
3. Thêm một thuốc mới vào danh mục.

**Quản lý** (`tt.quanly1`)
1. Mở tab Quản trị, xem policy của điều dưỡng và lịch sử phiên bản.
2. Sửa policy, ví dụ giới hạn điều dưỡng chỉ được ghi nhiệt độ và SpO₂, rồi đăng nhập lại bằng `tt.dieuduong1` để kiểm tra.
3. Gỡ policy khỏi điều dưỡng rồi gán lại.

## Vận hành (dành cho quản trị staging)
- Chạy lần đầu, hoặc khi đã thêm tài khoản: `bash deploy/staging/training/setup-training.sh` (từ thư mục gốc của repo trên VM).
  - Script có thể chạy lại an toàn: phần nào đã có thì bỏ qua.
  - Mật khẩu tạm của tài khoản mới được ghi vào `deploy/staging/training-passwords.txt` (quyền 600).
- **Thêm học viên:** thêm một dòng vào `training/accounts.json`.
  - `id` là UUID mới, chưa dùng; `username` có dạng `tt.<tên>`.
  - Sau đó chạy lại script với `SKIP_WEB=1`.
- **Khoá tài khoản:** tắt user trong Keycloak.
  ```bash
  docker compose --env-file secrets.env exec -T keycloak sh -c 'K=/opt/keycloak/bin/kcadm.sh; $K config credentials --server http://127.0.0.1:8081/auth --realm master --user admin --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null && $K update users/<id> -r hcos -s enabled=false'
  ```
- **Học viên quên mật khẩu hoặc mất TOTP:** chưa có SMTP để tự đặt lại. Quản trị đặt lại mật khẩu tạm bằng `kcadm set-password --temporary` và xoá credential OTP của user đó.
- **Không có nút "làm sạch dữ liệu".** Audit, lịch sử và sổ cái kho đều chỉ cho ghi thêm, nên không xoá được dữ liệu tập.
  - Muốn có bộ dữ liệu mới, tăng `TT_PATIENTS` để sinh thêm bệnh nhân.
  - Muốn quay về trạng thái trước đợt tập, khôi phục bằng PITR về thời điểm đó (xem `PITR.md`).
- Web có dải cảnh báo là do build với `HCOS_ENV_LABEL`. Khi build tay, nhớ giữ biến này.
- Cập nhật `web-dist`: **xoá nội dung bên trong**, không xoá cả thư mục. Caddy mount thư mục này; xoá thư mục thì container vẫn phục vụ bản cũ.
