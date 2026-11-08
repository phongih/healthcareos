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
- API **không kiểm tra** claim MFA (`acr`/`amr`): MFA được ép ở Keycloak, API tin token đã ký. Cần cấu hình step-up/ACR nếu chính sách yêu cầu.
- Vẫn là một Keycloak, một VM, cùng máy với DB nghiệp vụ; chưa có SMTP (quên mật khẩu/xác minh email), chưa có quy trình cấp–thu hồi quyền, chưa có break-glass.
- `tenant_id`/`org_ids`/`roles` vẫn là claim cố định trong client mapper (một tenant giả). Production cần ánh xạ theo người dùng/tổ chức (user attributes hoặc nhóm).
- Chưa có ứng dụng web; `redirect_uri` hiện là điểm đến thử nghiệm (`https://smart.id.vn/callback` trả 404 chấp nhận được để lấy code, và `http://127.0.0.1:9999/callback`).
- Các script kiểm tra (`verify-idp.sh`, `pkce-token.sh`) chưa chạy được với Keycloak thật trong sandbox của mình: kết quả đầu tiên trên VM là bằng chứng đầu tiên.
