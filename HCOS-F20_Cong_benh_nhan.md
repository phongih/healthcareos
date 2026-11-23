# HCOS-F20 — Cổng bệnh nhân

Người bệnh (và người giám hộ) tự xem hồ sơ trên điện thoại: các lần khám đã hoàn tất, chẩn đoán, chỉ số, thuốc, phiếu thu; đặt / huỷ lịch; đổi số điện thoại, email; gửi yêu cầu đính chính hoặc yêu cầu xoá dữ liệu; chia sẻ một lần khám cho bác sĩ khác bằng link có PIN.

- **Trang:** `/app/portal.html#/portal/<slug>`, trong đó slug là tên đường dẫn đặt lịch online của cơ sở (môi trường thực tập: `thuc-tap`). Link cũ dạng `/app/#/portal/<slug>` tự chuyển sang trang này.
- **Bundle riêng, nhẹ:** khoảng 220 KiB (ứng dụng nhân viên khoảng 580 KiB). Không có OIDC, không có màn hình nhân viên, không import từ `packages/`.
- **Phía nhân viên:**
  - thẻ **Cổng bệnh nhân** ở trang bệnh nhân;
  - thẻ **Yêu cầu đính chính từ cổng bệnh nhân** ở tab Lịch hẹn;
  - đường dẫn cổng hiện ở mục **Cài đặt đặt lịch online**.

## 1. Đăng nhập (tách hẳn khỏi nhân viên)
- **Không có mật khẩu.** Đăng nhập theo 2 bước:
  1. Nhập **số điện thoại**, hoặc **mã BN + ngày sinh**.
  2. Nhập **mã OTP 6 số** gửi tới số điện thoại trong hồ sơ. Mã hiệu lực 5 phút.
- **Đăng nhập bằng số điện thoại:**
  - so khớp qua blind index F16; số điện thoại không bao giờ lưu dạng rõ;
  - chỉ hợp lệ khi đúng **một** hồ sơ dùng số đó. Nếu cả nhà dùng chung số, người bệnh phải đăng nhập bằng mã BN + ngày sinh.
- **Không lộ việc hồ sơ có tồn tại hay không:** định danh không khớp vẫn nhận phản hồi giống hệt. Hệ thống tạo một "thử thách mồi" không có mã, nên nhập mã gì cũng sai.
- **Lưu trữ an toàn:**
  - mã OTP lưu dạng HMAC (khoá index F16), không lưu mã rõ;
  - token phiên `hpt_…` là chuỗi ngẫu nhiên 256 bit, CSDL chỉ lưu SHA-256;
  - địa chỉ IP lưu dạng HMAC.
- **Giới hạn:**
  - tối đa **3 lần gửi mã / 15 phút** cho cùng định danh;
  - sai **5 lần** (cộng dồn trong 30 phút) thì **khoá định danh 30 phút**;
  - mỗi thử thách cho sai tối đa 5 lần;
  - ở tầng HTTP còn giới hạn theo IP: OTP 10, xác thực 30, xem link chia sẻ 30, thao tác trong phiên 600 (mỗi cửa sổ 15 phút).
- **Phiên:** tối đa 12 giờ, nhàn rỗi 30 phút thì hết. Token giữ trong `sessionStorage` của tab (đóng tab là mất).
- **Tách biệt API:**
  - chỉ `/api/portal/*` nhận header `Authorization: Portal <token>`;
  - mọi API nội bộ khác yêu cầu JWT nhân viên, nên token cổng bị từ chối (401).
- **Kênh gửi OTP** (`HCOS_PORTAL_OTP`):
  - `off` (mặc định): tắt đăng nhập cổng.
  - `training`: **chỉ chạy được khi có `HCOS_TRAINING_ENV=1`**. Mã hiện ngay trên màn đăng nhập (khung đỏ "MÔI TRƯỜNG THỰC TẬP"), không gửi tin nhắn thật.
  - `webhook`: POST `{to, text}` tới cổng SMS / ZNS của nhà cung cấp. Cần đủ ba biến:
    - `HCOS_PORTAL_OTP_URL` (https);
    - `HCOS_PORTAL_OTP_TOKEN` (từ 16 ký tự);
    - `HCOS_PORTAL_OTP_VENDOR` (uuid nhà cung cấp trong sổ F18).
  - Ở chế độ `webhook`, **trước mỗi lần gửi** hệ thống kiểm tra nhà cung cấp còn được duyệt cho loại dữ liệu "Cá nhân". Nếu không, hệ thống không gửi và báo `VENDOR_NOT_CLEARED`.
  - **Chưa bật** chế độ `webhook` cho tới khi có nhà cung cấp SMS với số DPA thật của tổ chức.

## 2. Đọc dữ liệu: RLS riêng cho cổng
- **Vai riêng:** mọi truy vấn đọc của cổng chạy trong transaction `SET LOCAL ROLE hcos_portal`, kèm danh sách person của phiên (bản thân và người phụ thuộc còn hiệu lực). Service **không tự lọc thay** CSDL.
  - `hcos_portal` chỉ có SELECT, và chỉ có chính sách `portal_read`.
  - Login role của ứng dụng (thừa kế `hcos_app`) được **đổi vai** sang `hcos_portal` nhưng **không thừa hưởng** quyền của nó (`INHERIT FALSE`).
  - Test CI kiểm tra không có chính sách nào khác áp cho vai này.
- **Những gì cổng thấy:**
  - **Lần khám:** chỉ lần **đã kết thúc**. Ghi chép dở của buổi khám đang mở không hiện.
  - **Chẩn đoán:** bỏ dòng "nhập nhầm" và "đã bác bỏ".
  - **Chỉ số:** chỉ dòng chính thức (`final` / `amended` / `corrected`). Bản đã bị bản sửa thay thế không hiện.
  - **Đơn thuốc:** chỉ đơn còn hiệu lực / đã hoàn tất, **chỉ dòng thuốc** (không hiện vật tư).
  - **Khác:** phiếu thu còn hiệu lực; lịch hẹn của người đó.
  - **Nhân viên:** chỉ thấy tên hiển thị (không thấy tài khoản đăng nhập).
- **Audit:**
  - mỗi lần đọc / ghi đều ghi `platform.audit_events`;
  - actor là `service: patient-portal`, `person_id` là người đăng nhập;
  - payload **chỉ chứa id**: không có họ tên, số điện thoại, nội dung.

## 3. Người giám hộ
- Lễ tân / quản lý tạo liên kết ở trang bệnh nhân (người được giám hộ), nhập **mã BN người giám hộ**. Người giám hộ phải có hồ sơ tại cơ sở.
- **Bắt buộc tích** "đã đối chiếu giấy tờ tuỳ thân và giấy tờ chứng minh quan hệ tại quầy". Nếu không tích, cả máy chủ và giao diện đều chặn.
- **Hạn liên kết:**
  - **Trẻ em:** liên kết **tự hết vào ngày tròn 18 tuổi**. CSDL ép trần này, kể cả khi nhân viên nhập ngày xa hơn. Với trẻ nhỏ, hạn có thể xa hơn 10 năm.
  - **Người lớn** (vd. cha mẹ già, người được giám hộ theo quyết định): bắt buộc nhập ngày hết hạn, tối đa 10 năm.
- **Không sửa được:** muốn đổi thì thu hồi (bắt buộc lý do) rồi tạo liên kết mới.
- **Trên cổng:** người giám hộ thấy các hồ sơ dạng nút chuyển ở đầu trang. Hồ sơ người phụ thuộc ghi rõ "Quyền xem đến hết ngày …".
- **Đăng xuất mọi thiết bị:** nút ở thẻ Cổng bệnh nhân. Dùng khi người bệnh báo mất điện thoại.

## 4. Thao tác ghi
- **Ghi trực tiếp (có audit):**
  - **Đặt lịch / huỷ lịch** cho bản thân hoặc người phụ thuộc.
    - Đổi lịch = đặt lịch mới rồi huỷ lịch cũ.
    - Họ tên, ngày sinh lấy từ hồ sơ; số điện thoại liên hệ là số của người đăng nhập.
    - Lịch ghi `portal_person_id` qua trigger, nên lễ tân biết lịch đến từ cổng.
  - **Đổi số điện thoại:**
    - OTP được gửi **tới số mới**;
    - khi xác nhận: mã hoá lại số mới bằng khoá của chính người đó (F17), cập nhật blind index và số che;
    - **các phiên khác của người đó bị thu hồi**.
  - **Email:** đổi trực tiếp (mã hoá như F16). Để trống thì xoá email.
- **Chỉ gửi yêu cầu (nhân viên xử lý):**
  - **Đính chính:** người bệnh mô tả thông tin sai (tối đa 5 yêu cầu đang chờ). Lễ tân / quản lý xử lý hoặc từ chối kèm ghi chú phản hồi; người bệnh thấy phản hồi ở mục Tài khoản. Bệnh án **không** sửa từ cổng.
  - **Xoá dữ liệu:** tạo yêu cầu F17 với hình thức "Cổng bệnh nhân (OTP)".
    - Không có người lập là nhân viên, nên bất kỳ quản trị viên có quyền đều duyệt được.
    - Bệnh án còn thời hạn lưu bắt buộc thì yêu cầu được **hoãn**, theo đúng quy tắc F17.
- **Khi F17 thực thi xoá:** trong cùng transaction, mọi phiên cổng và link chia sẻ của người đó bị thu hồi. Nội dung yêu cầu đính chính do người bệnh tự viết được thay bằng nhãn "[đã xoá theo yêu cầu xoá dữ liệu]".

## 5. Link chia sẻ cho bác sĩ tuyến trên
- Tạo trong chi tiết **một lần khám đã kết thúc**. Hiệu lực **24 giờ**, có **PIN 6 số**; PIN chỉ hiện một lần.
  - Nhập sai PIN **5 lần** thì link bị khoá.
  - Tối đa 5 link còn hiệu lực trên mỗi hồ sơ.
  - Thu hồi được ở mục Tài khoản.
- **Bảo vệ token:** link dạng `…/portal.html#/s/hps_…`. Token nằm trong fragment nên không gửi lên máy chủ qua URL; trang xoá token khỏi thanh địa chỉ ngay khi mở.
- **Nội dung bác sĩ thấy:** họ tên, ngày sinh, chẩn đoán, chỉ số, thuốc. **Không có mã BN.**
- **Ghi nhận:** mỗi lượt xem, kể cả nhập sai PIN, được ghi vào `portal.share_views`.
- **Bảo vệ ở CSDL:** chỉ cho tạo link với lần khám đã kết thúc của chính người đó, kể cả khi ghi thẳng vào bảng.

## 6. Tuân thủ
- **Danh mục dữ liệu:** 6 bảng mới (`patient.guardian_links`, `portal.otp_challenges`, `portal.sessions`, `portal.requests`, `portal.shares`, `portal.share_views`) có nhãn trong `DATA_CATALOG`. Cột mã hoá / HMAC được ghi rõ dạng lưu trữ.
- **Decision Engine:**
  - thêm nhóm **An ninh** và bộ phát hiện `portal_otp_abuse`: số lần sai OTP, số lần yêu cầu mã và số định danh khác nhau từ **một địa chỉ IP (HMAC)** trong 60 phút;
  - luật mẫu ở môi trường thực tập: **P2** khi có từ 10 lần sai, báo quản lý cơ sở;
  - sổ nguồn dữ liệu AI: `decision_engine_stats` lên `2026.11-f20`.
- **Không gửi Teams:** OTP và mọi dữ liệu cổng không đi qua Teams / tích hợp F12.

## 7. Migration 023
- schema `portal`; vai `hcos_portal`;
- bảng `patient.guardian_links`;
- `clinical.bookings.portal_person_id`;
- `governance.erasure_requests`: kênh `portal`, `requested_by` được phép NULL, thêm cột `portal_person_id`;
- trigger thu hồi phiên khi xoá dữ liệu.
- Chỉ thêm, không đổi dữ liệu cũ.
