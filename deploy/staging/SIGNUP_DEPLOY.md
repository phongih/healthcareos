# Runbook deploy: đăng ký khách (migration 026–028, route công khai, SMTP OTP)

Áp dụng cho staging (`smart.id.vn`). Chạy trên VM, từ thư mục gốc repo hoặc `deploy/staging` như ghi rõ. Không dán mật khẩu, khoá, hoặc mã OTP vào chat hay log.

## 1. Sao lưu và kiểm chứng (bắt buộc trước khi migrate)
```bash
sudo -u postgres env PGDATABASE=hcos /usr/local/sbin/hcos-backup
sudo -u postgres env PGDATABASE=hcos /usr/local/sbin/hcos-restore-verify   # phải in: RESTORE VERIFY: PASS
```
Ghi lại tên file `.dump` trong `/var/backups/hcos/`.

## 2. Cập nhật mã và áp dụng migration
```bash
cd ~/healthcareos && git fetch origin && git checkout main && git pull --ff-only origin main
git log --oneline -1
```
Migrate chạy bằng role có quyền DDL (trên staging là `postgres`, dùng socket):
```bash
mkdir -p /tmp/hcos-migrate && rm -rf /tmp/hcos-migrate/* && cp -r scripts infrastructure /tmp/hcos-migrate/
sudo -u postgres env PGHOST=/var/run/postgresql PGDATABASE=hcos PATH="$PATH" node /tmp/hcos-migrate/scripts/migrate.mjs
rm -rf /tmp/hcos-migrate
```
Lưu ý: `sudo -u postgres` không đọc được thư mục home (`/home/<user>` mode 750), nên phải copy script ra `/tmp`.

Nếu script báo lỗi ở một file đã có đối tượng trong DB (ví dụ `column ... already exists`), file đó đã được áp dụng thủ công trước đó. Kiểm tra đối tượng, nếu đủ thì ghi nhận bằng checksum của file trong `public.schema_migrations`. Đừng bỏ qua mà không kiểm tra.

Kỳ vọng: các dòng `skip`, `apply 026_...`, `apply 027_...`, `apply 028_...`, rồi `migrations up to date`.

## 3. Cấu hình trong `deploy/staging/hcos.env` (quyền 600)
Thêm các biến sau. Không in giá trị ra màn hình.
```
HCOS_SIGNUP_SMTP_HOST=smtp.gmail.com
HCOS_SIGNUP_SMTP_PORT=465
HCOS_SIGNUP_SMTP_USER=noreply@smart.id.vn
HCOS_SIGNUP_SMTP_PASS=<app password>
HCOS_SIGNUP_SMTP_FROM=noreply@smart.id.vn
HCOS_SIGNUP_OTP_KEY=<openssl rand -base64 32>
```
Quy tắc:
- Năm biến `HCOS_SIGNUP_SMTP_*` phải đặt cùng lúc; thiếu hoặc sai cổng (không phải 465) thì API không khởi động.
- Thiếu `HCOS_SIGNUP_OTP_KEY` thì API không đăng ký route `/api/public/signup/*` và `/api/public/tenants/*` (trả 401).

Kiểm tra (chỉ đếm, không in giá trị):
```bash
cd ~/healthcareos/deploy/staging
ls -l hcos.env                          # kỳ vọng: -rw-------
grep -c '^HCOS_SIGNUP_SMTP_' hcos.env   # kỳ vọng: 5
grep -c '^HCOS_SIGNUP_OTP_KEY=' hcos.env  # kỳ vọng: 1
```

Sinh khoá OTP mà không hiển thị ra màn hình:
```bash
[ -n "$(tail -c1 hcos.env)" ] && echo >> hcos.env
echo "HCOS_SIGNUP_OTP_KEY=$(openssl rand -base64 32)" >> hcos.env
```

## 4. Duyệt vendor gửi OTP (trước khi thử đăng ký)
Không có dòng này thì mọi lần gửi OTP trả `OTP_UNAVAILABLE` (fail-closed, đúng thiết kế):
```bash
sudo -u postgres psql -d hcos -c "INSERT INTO platform.signup_vendors (vendor, category, cleared_by, review_due) VALUES ('smtp.gmail.com', 'signup_otp_email', '<tên người duyệt>', now() + interval '180 days');"
sudo -u postgres psql -d hcos -Atc "SELECT vendor, category, active, review_due FROM platform.signup_vendors;"
```
Vendor hết hạn `review_due` hoặc `active = false` thì bị từ chối. Tắt tạm kênh OTP: `UPDATE platform.signup_vendors SET active = false WHERE vendor = 'smtp.gmail.com';` (không cần restart).

## 5. Build image API và tạo lại container
`restart` không nạp lại `hcos.env` và không dùng image mới. Phải build rồi tạo lại:
```bash
cd ~/healthcareos
docker tag hcos-api:staging hcos-api:rollback-$(date +%Y%m%d)-signup   # giữ image cũ để lùi
docker build -f services/api/Dockerfile -t hcos-api:staging .
cd deploy/staging
docker compose --env-file secrets.env up -d --no-deps --force-recreate api
docker compose logs --tail=20 api
```
Kỳ vọng: `hcos-api listening`, `mfa: otp`, `staffAdmin: keycloak`, không có `ConfigError`.

Không chạy `docker compose up -d` không kèm tên service: cảnh báo `KC_DB_PASSWORD` / `KC_ADMIN_PASSWORD` trống có thể làm Keycloak được tạo lại với mật khẩu rỗng.

## 6. Slug tổ chức
Migration 026 không tự gán slug cho tổ chức đang có. Kiểm tra và đặt thủ công:
```bash
sudo -u postgres psql -d hcos -Atc "SELECT code, name, slug FROM iam.tenants;"
sudo -u postgres psql -d hcos -c "UPDATE iam.tenants SET slug='<slug>' WHERE slug IS NULL;"
```

## 7. Kiểm tra sau deploy
```bash
curl -fsS https://smart.id.vn/healthz; echo        # kỳ vọng: {"status":"ok"}
curl -fsS https://smart.id.vn/readyz; echo         # kỳ vọng: {"status":"ready"}
curl -s https://smart.id.vn/api/public/tenants/<slug>; echo   # kỳ vọng: JSON có displayName
```
Lưu ý đường dẫn: `/healthz` và `/readyz` ở gốc (không có `/api`). Caddy chuyển `/api/*` cho API cần đăng nhập, nên `/api/healthz` trả 401.

Đăng ký thử (dùng email của người vận hành, slug chưa tồn tại):
```bash
curl -s -X POST https://smart.id.vn/api/public/signup/start -H 'Content-Type: application/json' \
  -d '{"email":"<email>","orgName":"Phòng khám Thử","phone":"0908697966","license":"GPKD-TEST-0001","slug":"<slug-mới>"}'; echo
curl -s -X POST https://smart.id.vn/api/public/signup/verify -H 'Content-Type: application/json' \
  -d '{"signupId":"<signupId từ bước trên>","code":"<mã trong email>"}'; echo   # kỳ vọng: {"slug":"<slug-mới>"}
```
Sau đó kiểm tra mã không nằm trong log (`docker compose logs api | grep -c "<mã>"` → `0`) và xoá bản ghi thử nếu dùng email thật:
```bash
sudo -u postgres psql -d hcos -c "DELETE FROM iam.signup_requests WHERE signup_id='<signupId>';"
```

Lỗi thường gặp:
- `OTP_UNAVAILABLE`: vendor chưa duyệt hoặc hết hạn (mục 4), hoặc SMTP chưa cấu hình. Lỗi SMTP bị nuốt nên log có thể không ghi gì.
- `SIGNUP_RATE_LIMITED_*`: giới hạn 3 yêu cầu/giờ cho mỗi email, 10/giờ cho mỗi IP.
- `AUTH_MISSING_TOKEN` trên route công khai: image chưa build lại (mục 5) hoặc thiếu `HCOS_SIGNUP_OTP_KEY` (mục 3).

## 8. Web (chuông, tên người dùng, đợt giao diện)
```bash
cd ~/healthcareos/deploy/staging && bash training/setup-training.sh
```
Lệnh này cũng nạp lại dữ liệu thực tập (idempotent). Sau đó Ctrl+F5 để tải bản mới.

## 9. Rollback
- API: `docker tag hcos-api:rollback-<ngày>-signup hcos-api:staging` rồi `docker compose --env-file secrets.env up -d --no-deps --force-recreate api`.
- Tắt OTP: `active = false` cho vendor (mục 4), không cần restart.
- Migration 026–028 không tự lùi. Khôi phục từ file sao lưu ở mục 1 theo `deploy/staging/BACKUP.md`, rồi chạy `shred-replay.sh` trước khi mở API.
