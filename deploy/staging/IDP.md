# Danh tính (Keycloak) — staging

Thay đổi so với bản trước:
- Keycloak dùng **PostgreSQL riêng** (database `keycloak`, role `keycloak`, không phải superuser), thay cho H2 trong file. DB này nằm trong sao lưu (`*.keycloak.dump`, được mã hoá và đẩy ngoài máy cùng bộ) và `restore-verify` kiểm tra khôi phục được realm `hcos`.
- Client `hcos-web`: authorization code + **PKCE S256 bắt buộc**, `directAccessGrants` (password grant) **tắt**, redirect URI chính xác. Client cũ `hcos-staging-cli` đã bị gỡ.
- Người dùng demo có required action `CONFIGURE_TOTP`: lần đăng nhập đầu phải đăng ký OTP; từ đó mọi lần đăng nhập đòi OTP (luồng browser mặc định của Keycloak 26 yêu cầu OTP khi người dùng đã có OTP).
- Chính sách mật khẩu `length(12) and notUsername`; bật event log (90 ngày) và admin events; phiên SSO idle 30 phút, tối đa 10 giờ.

## Áp dụng trên VM (staging, dữ liệu giả)
```
cd ~/healthcareos && git pull
cd deploy/staging
./setup.sh                                   # tạo DB/role keycloak, thêm KC_DB_PASSWORD vào secrets.env, sinh lại kc-import
docker compose --env-file secrets.env up -d --force-recreate keycloak
docker compose --env-file secrets.env logs keycloak | grep -i -E 'import|started|error' | tail
./verify-idp.sh                              # kỳ vọng: VERIFY IDP: PASS
./pkce-token.sh                              # đăng nhập thật qua trình duyệt, kèm OTP
sudo install -m 755 backup.sh /usr/local/sbin/hcos-backup
sudo install -m 755 restore-verify.sh /usr/local/sbin/hcos-restore-verify
sudo install -m 755 backup-offsite.sh /usr/local/sbin/hcos-backup-offsite
sudo -u postgres env PGDATABASE=hcos /usr/local/sbin/hcos-backup && sudo -u postgres env PGDATABASE=hcos /usr/local/sbin/hcos-restore-verify
```
Sau khi ổn: `rm -rf kc-import` (chứa mật khẩu demo) và `sudo rm -rf kc-h2` (H2 cũ, có băm mật khẩu).
Admin console không mở ra Internet; dùng khi cần: `gcloud compute ssh ... --tunnel-through-iap -- -L 8081:127.0.0.1:8081` rồi mở `http://localhost:8081/auth/`.

## Giới hạn (chưa đạt mức dùng thật)
- ~~API không kiểm tra claim MFA~~ — từ PR #32: `HCOS_REQUIRE_AMR=otp` => API chỉ nhận token có `amr` chứa `otp`. Keycloak phát `amr` nhờ luồng `hcos browser` (bản sao của `browser`, bước mật khẩu gắn tham chiếu `pwd`, bước OTP gắn `otp`, hiệu lực 10 giờ) + mapper `amr` trên client `hcos-web`. Cấu hình bằng `python3 idp-scope-mfa.py apply` (xem bên dưới). Chưa có step-up theo thao tác (vd. bắt OTP lại khi duyệt xoá dữ liệu).
- Vẫn là một Keycloak, một VM, cùng máy với DB nghiệp vụ; chưa có SMTP (quên mật khẩu/xác minh email), chưa có quy trình cấp–thu hồi quyền, chưa có break-glass.
- ~~`tenant_id`/`org_ids` là claim cố định~~ — từ PR #32 API tra **tenant theo `sub`** (`iam.tenants_for_subject`, migration 024) và **cơ sở theo membership còn hiệu lực trong DB** (cache 30 giây). Claim `org_ids` / `org_id` nếu có chỉ thu hẹp, không mở rộng; tenant_admin thấy mọi cơ sở đang hoạt động. Claim `roles` không dùng để phân quyền (vai trò luôn lấy từ DB). Tài khoản IdP chưa có user / membership => 403 `USER_NOT_PROVISIONED`.
- Chưa có ứng dụng web; `redirect_uri` hiện là điểm đến thử nghiệm (`https://smart.id.vn/callback` trả 404 chấp nhận được để lấy code, và `http://127.0.0.1:9999/callback`).
- Các script kiểm tra (`verify-idp.sh`, `pkce-token.sh`) chưa chạy được với Keycloak thật trong sandbox của mình: kết quả đầu tiên trên VM là bằng chứng đầu tiên.

## Phạm vi theo tài khoản + MFA (PR #32)
```bash
cd ~/healthcareos/deploy/staging
python3 idp-scope-mfa.py status     # hiện trạng: luồng đăng nhập, tham chiếu AMR, mapper của hcos-web
python3 idp-scope-mfa.py apply      # chép luồng + gắn amr + gỡ claim cố định (chạy lại được)
python3 idp-scope-mfa.py rollback   # quay về luồng browser + claim cố định cũ
```
Thứ tự an toàn: deploy API mới (chưa đặt `HCOS_REQUIRE_AMR`) => `apply` => đăng nhập lại => **chỉ** ghi `HCOS_REQUIRE_AMR=otp` khi token thật sự có `otp`:
```bash
bash pkce-token.sh | tee /tmp/hcos-token.txt          # mở URL bằng cửa sổ ẩn danh
if grep -q "^amr: .*'otp'" /tmp/hcos-token.txt; then
  grep -q '^HCOS_REQUIRE_AMR=' hcos.env || echo 'HCOS_REQUIRE_AMR=otp' | tee -a hcos.env
  docker compose --env-file secrets.env up -d --no-deps --force-recreate api
else
  echo "KHÔNG bật HCOS_REQUIRE_AMR: token chưa có amr otp"
fi
rm -f /tmp/hcos-token.txt
```
Bài học (26/11): bật `HCOS_REQUIRE_AMR` khi token chưa có `amr` => mọi nhân viên bị chặn đăng nhập. Gỡ: `sed -i '/^HCOS_REQUIRE_AMR=/d' hcos.env` rồi tạo lại container `api`.

## Quản trị nhân sự từ HealthcareOS (PR #34, F21)
API tạo / khoá / đặt lại tài khoản Keycloak qua client service-account riêng `hcos-admin-api` (không dùng admin master). Quyền tối thiểu: realm-management `manage-users`, `view-users`, `query-users` trên realm `hcos`.
```bash
cd ~/healthcareos/deploy/staging
python3 idp-scope-mfa.py admin-client        # tạo client + gán quyền + ghi HCOS_KC_ADMIN_CLIENT_SECRET vào hcos.env (không in ra)
grep -c '^HCOS_KC_ADMIN_CLIENT_SECRET=' hcos.env   # phải ra 1
docker compose --env-file secrets.env up -d --no-deps --force-recreate api
```
Gỡ: xoá client `hcos-admin-api` (`kcadm.sh delete clients/<id> -r hcos`) và dòng `HCOS_KC_ADMIN_CLIENT_SECRET` trong `hcos.env`; API trả `IDP_NOT_CONFIGURED` cho thao tác cần Keycloak, phần còn lại vẫn chạy.
