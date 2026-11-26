# HCOS-F21 — Nhân sự & cơ sở

Tab **Nhân sự** (quản lý cơ sở, quản trị hệ thống). Thay cho việc sửa SQL / `accounts.json` khi thêm nhân viên hoặc mở cơ sở mới.

## Tài khoản nhân viên
- **Thêm nhân viên:** họ tên, tên đăng nhập, email công việc (nên có), cơ sở, 1–4 vai trò, ngày hết hạn (tuỳ chọn).
  - API tạo tài khoản trên **Keycloak** qua client service-account `hcos-admin-api` (chỉ quyền quản lý user của realm `hcos`), với **mật khẩu tạm** và bắt buộc **đổi mật khẩu + cài OTP** ở lần đăng nhập đầu.
  - Mật khẩu tạm (dạng `abcd-EFGH-jkmn-PQRS`) chỉ hiện **một lần** trên màn hình; không lưu, không vào audit.
  - Tên đăng nhập đã có trên Keycloak: phải tích "Tài khoản đã có sẵn" để **liên kết** (không tạo mới, không có mật khẩu tạm).
  - Lỗi ghi DB sau khi đã tạo trên Keycloak => tài khoản Keycloak vừa tạo bị **tắt** (không để lại tài khoản mồ côi đang bật).
- **Cấp vai trò** tại một cơ sở (tuỳ chọn hết hạn); **thu hồi** bắt buộc lý do. Thu hồi là **cuối cùng** (trigger CSDL); cấp lại = membership mới, lịch sử giữ nguyên (người cấp, người / lúc / lý do thu hồi).
- **Khoá / mở khoá:** tắt / bật trên Keycloak trước (lỗi Keycloak => không đổi gì), đăng xuất mọi phiên, chặn ở API ngay (xoá cache phạm vi cơ sở).
- **Đặt lại mật khẩu + OTP** (vd. mất điện thoại): mật khẩu tạm mới, xoá OTP cũ, bắt cài lại, đăng xuất.

## Ai được làm gì
| | Quản lý cơ sở (clinic_admin) | Quản trị hệ thống (tenant_admin) |
|---|---|---|
| Xem nhân viên | cơ sở mình quản lý | mọi cơ sở |
| Cấp / thu hồi | bác sĩ, lễ tân / điều dưỡng, thu ngân, dược sĩ, quản lý kho dược — tại cơ sở mình | mọi vai trò (trừ `system`, `patient`) |
| Khoá / đặt lại | nhân viên không giữ vai trò quản trị và chỉ làm ở cơ sở mình | mọi tài khoản |
| Tạo / ngừng cơ sở | — | có |

Không ai tự sửa quyền / khoá / đặt lại chính mình. Luôn còn ít nhất một quản trị hệ thống và một cơ sở đang hoạt động. Mã từ chối (`ROLE_CEILING`, `ORG_SCOPE`, `SELF_CHANGE`…) hiện rõ trên giao diện.

## Cơ sở
- **Tạo cơ sở:** tên, mã, tiền tố mã bệnh nhân (nên khác cơ sở khác), tuỳ chọn **sao chép cấu hình** từ một cơ sở đang hoạt động:
  - phòng khám (+ số chỗ đặt lịch / sức khám), bảng giá, định mức vật tư, dịch vụ cần thiết bị (nối theo mã dịch vụ);
  - tạm ứng mặc định (**không** chép tài khoản ngân hàng), thông số dự báo, quầy trả, luật Decision Engine (mặc định không chép), cài đặt mã BN.
  - **Không** chép: người bệnh, phiếu thu, ca, kho / lô thuốc, thiết bị, cổng đặt lịch, kết nối ngoài, tài khoản ngân hàng.
- **Ngừng / mở lại** cơ sở (bắt buộc lý do). Cơ sở ngừng không cấp được vai trò mới và biến khỏi phạm vi đăng nhập.
- Sau khi tạo: cấp vai trò quản lý cơ sở cho người phụ trách ở bảng Nhân sự; cổng đặt lịch, kho, thiết bị, tài khoản ngân hàng cấu hình ở từng tab.

## Kỹ thuật
- Migration **025**: `iam.users.username`; `iam.memberships.granted_by / revoked_by / revoked_at / revoke_reason`; duy nhất (user, cơ sở, vai trò) chỉ trong membership **đang hiệu lực**; trigger `iam.memberships_guard` (khoá / vai trò / cơ sở / người cấp không đổi; thu hồi là cuối cùng).
- Quyền mới trong danh mục access policy: `staff:manage`, `org:manage`.
- Cấu hình API: `HCOS_KC_ADMIN_CLIENT_SECRET` (+ `HCOS_KC_ADMIN_URL`, `HCOS_KC_REALM`, `HCOS_KC_ADMIN_CLIENT_ID`). Thiếu secret => xem / cấp / thu hồi / tạo cơ sở vẫn chạy; tạo / khoá / đặt lại tài khoản báo `IDP_NOT_CONFIGURED`.
- Keycloak: `python3 deploy/staging/idp-scope-mfa.py admin-client` tạo client + gán quyền + ghi secret vào `hcos.env` (không in ra).
- `accounts.py` (thực tập) chỉ cấp membership chưa từng có => chạy lại `setup-training.sh` không cấp lại vai trò đã thu hồi.
