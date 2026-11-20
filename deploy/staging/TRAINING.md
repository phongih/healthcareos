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

- **Hàng đợi:** có 2 phòng `N1` và `N2`, và **8 số đang chờ hôm nay** (bệnh nhân `TT00001`–`TT00004`, `TT00006`–`TT00009`).
  - Số thứ tự tính theo ngày. Muốn có số chờ mới cho ngày hôm sau, quản trị chạy lại `setup-training.sh`.
  - Đường dẫn **màn hình TV** được in một lần lúc tạo. Mất đường dẫn thì quản lý tạo cái mới ở tab Hàng đợi → Cài đặt.
- **Đặt lịch online:** phòng `N1`, `N2` nhận **10 chỗ mỗi buổi**. Trang đặt lịch công khai: `https://smart.id.vn/app/#/book/thuc-tap` (không cần đăng nhập, mở được trên điện thoại).
  - Có **5 lịch hẹn mẫu** ở buổi gần nhất còn nhận lịch (SĐT giả đầu `01209`); 2 người trùng hồ sơ cũ `TT00011`, `TT00012`, 3 người mới.
  - Mã đặt lịch mẫu được in ra khi chạy `setup-training.sh` (chỉ dữ liệu giả). Quên mã thì check-in từ danh sách trong ngày.
  - Chỉ check-in được **đúng ngày khám**. Nếu lịch mẫu rơi vào ngày mai, hôm nay hãy tự đặt một lịch buổi chiều (trước 16:00) để tập.
- **Thu ngân:** bảng giá mẫu 9 dịch vụ (khám, xét nghiệm, siêu âm, X-quang, điện tim, khí dung; **giá giả**), tạm ứng mặc định **500.000đ**.
  - **Chưa cài tài khoản nhận chuyển khoản**: số tài khoản bịa có thể trùng tài khoản thật của người khác. Muốn tập VietQR, quản lý nhập tài khoản thật của phòng khám (hoặc chỉ xem màn hình, KHÔNG chuyển tiền thật).
  - Mỗi người thu tiền phải **mở ca** của mình (tab Thu ngân). Điều dưỡng (có policy) không thu tiền được — đúng thiết kế.

## Bài tập theo vai trò
**Lễ tân** (`tt.letan1`)
1. Tìm bệnh nhân `TT00012` theo MRN. Sau đó tìm lại người đó theo họ tên và ngày sinh.
2. Đăng ký một bệnh nhân mới với MRN `TT9xxxx` tự đặt và CCCD `099…`.
3. Đăng ký lại đúng người vừa tạo, xem cảnh báo trùng hiện ra thế nào.
4. Ở hồ sơ bệnh nhân `TT00012`, thẻ **Cấp số khám**: chọn phòng `N1` rồi **Cấp số** và **In phiếu**.
   - Thử cấp thêm số cho cùng người đó: hệ thống báo bệnh nhân đã có số.
   - Với bệnh nhân từ đủ 75 tuổi hoặc dưới 6 tuổi, hệ thống tự gợi ý ưu tiên. Thử chọn ưu tiên "Cấp cứu" cho một người khác.
5. Tab **Hàng đợi**: số nào bác sĩ đánh dấu **Vắng mặt** thì bấm **Đưa lại hàng chờ**. Thử **Huỷ số** một người.
6. **Đặt lịch online** — vào vai người bệnh trên điện thoại: mở trang đặt lịch, đặt một lịch hôm nay (buổi còn mở) với SĐT `01209xxxxx` tự đặt, ghi lại mã.
   - Đặt thêm lịch cùng SĐT, cùng ngày: hệ thống báo đã có lịch.
   - Vào **Tra cứu / huỷ lịch**: thử SĐT sai (không thấy), rồi SĐT đúng.
7. Tab **Lịch hẹn**: nhập mã vừa đặt → xem hồ sơ cũ có thể trùng → chọn hồ sơ (hoặc tạo hồ sơ mới, nhập MRN `TT9xxxx`) → **Check-in & cấp số** → **In phiếu**. Kiểm tra số mới ở tab Hàng đợi.
   - Thử **Huỷ** một lịch khác trên danh sách: số chỗ của buổi đó tăng lại trên trang đặt lịch.
8. **Thu ngân** — tab **Thu ngân**: **Mở ca** với tiền đầu ca 1.000.000đ.
   - Ở bước check-in lịch hẹn (bài 7), đánh dấu **Thu tạm ứng 500.000đ** (tiền mặt) → nhận cả phiếu số và **phiếu thu**; in riêng từng phiếu.
   - Tab Thu ngân → mở hồ sơ thanh toán của người vừa check-in: thêm chi phí `KB-NOI` và `XN-CTM` × 2 (330.000đ) → hệ thống gợi ý **hoàn ứng** 170.000đ → lập phiếu chi → **Đóng hồ sơ**.
   - Thử ghi nhầm một chi phí rồi **Gỡ** (phải nhập lý do); thử lập phiếu thẻ không có mã chuẩn chi (bị chặn); lập rồi **Huỷ** một phiếu (chỉ được khi ca còn mở).
   - Cuối buổi: **Đóng ca**, nhập tiền đếm được trong két (thử nhập lệch 10.000đ để thấy báo thiếu/thừa).

**Điều dưỡng** (`tt.dieuduong1`)
1. Mở bệnh nhân `TT00005`. Thấy CCCD bị che (nhãn "đã che").
2. Thử tìm bệnh nhân theo CCCD: hệ thống từ chối, đúng như policy.
3. Vào đợt khám đang mở, ghi nhiệt độ và SpO₂.

**Bác sĩ — gọi số** (`tt.bacsi1`, `tt.bacsi2`)
1. Tab **Hàng đợi**, chọn phòng (mỗi bác sĩ một phòng, vd. `tt.bacsi1` → `N1`, `tt.bacsi2` → `N2`).
2. Bấm **Gọi số tiếp theo**. Để ý số ưu tiên được gọi trước. Nếu đang mở màn hình TV, số vừa gọi sẽ nhấp nháy ở đó.
3. Bấm **Gọi lại** một lần, rồi **Bắt đầu khám**: hệ thống tạo đợt khám và mở thẳng màn đợt khám.
4. Gọi số tiếp theo rồi bấm **Vắng mặt**, để lễ tân tập đưa số đó lại hàng chờ.

**Bác sĩ — khám và kê đơn** (`tt.bacsi1`, `tt.bacsi2`)
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
0. Tab **Hàng đợi → Cài đặt hàng đợi**: xem 2 phòng; thêm phòng `NHI` "Phòng khám Nhi"; tạo một **đường dẫn màn hình** mới rồi mở nó ở tab khác, để làm màn hình TV.
0c. Tab **Thu ngân → Cài đặt thu ngân**: sửa giá `KB-NOI` (chi phí đã ghi trước đó không đổi); thêm dịch vụ mới; xem **Báo cáo ca thu ngân** trong ngày (tiền phải có, đếm được, chênh lệch) và danh sách phiếu từng ca.
0d. Tab **Báo cáo**: xem báo cáo tài chính hôm nay sau khi lễ tân tập thu ngân (thực thu, doanh thu dịch vụ, tạm ứng còn giữ, phiếu huỷ); đổi sang "7 ngày"; bấm **Xuất Excel** và mở file.
0b. Tab **Lịch hẹn → Cài đặt đặt lịch online**: đặt số chỗ cho phòng `NHI` (vd. 5) và xem phòng xuất hiện trên trang đặt lịch; thử **Tạm ngừng** đường dẫn rồi mở trang đặt lịch (báo tạm ngừng), sau đó **Mở lại**.
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
