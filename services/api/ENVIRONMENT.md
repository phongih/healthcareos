# HealthcareOS API — cấu hình môi trường

Cấu hình **chỉ** qua biến môi trường lúc chạy. Image không chứa bí mật; thiếu/sai biến => tiến trình in lý do (chỉ tên biến) và thoát mã 1.

| Biến | Bắt buộc | Mặc định | Ghi chú |
|---|---|---|---|
| `HCOS_DATABASE_URL` | có | — | `postgres://<login-role>:<mật khẩu>@host:5432/db` (TCP; không hỗ trợ URL unix-socket). Login-role phải là thành viên `hcos_app`, **không** superuser/BYPASSRLS; không dùng `postgres`/`hcos_provisioner`. Khởi động bị từ chối nếu phiên DB là superuser/BYPASSRLS. |
| `HCOS_JWT_ISSUER` | có | — | Nhiều giá trị: phân tách bằng dấu phẩy |
| `HCOS_JWT_AUDIENCE` | có | — | Nhiều giá trị: phân tách bằng dấu phẩy |
| `HCOS_JWKS_URL` | có | — | `https://…` (http chỉ cho localhost/127.0.0.1) |
| `HCOS_PORT` | không | `8080` | 1–65535 |
| `HCOS_HOST` | không | mọi giao diện | Địa chỉ IP (v4/v6) để lắng nghe. Đặt `127.0.0.1` khi chạy sau reverse proxy cùng máy (network host) để API không lộ ra ngoài proxy. Trong container bridge mạng mặc định phải để trống. Tên host không được chấp nhận |
| `HCOS_MAX_BODY_BYTES` | không | `1048576` | 1024 – 52428800 |
| `HCOS_DB_POOL_MAX` | không | `10` | 1–200 |
| `HCOS_READY_TIMEOUT_MS` | không | `2000` | Timeout cứng của `/readyz` (100–30000) |
| `HCOS_DECISION_INTERVAL_SEC` | không | `300` | Chu kỳ chạy Decision Engine (giây); `0` = tắt, ≥ 60 |
| `HCOS_INTEGRATION_KEY` | không | — | Khoá AES-256 (base64 32 byte, `openssl rand -base64 32`) mã hoá URL / bí mật kết nối tích hợp. Không đặt ⇒ tắt tích hợp. **Sao lưu riêng**: mất khoá ⇒ phải nhập lại URL các kết nối |
| `HCOS_KEKS` | **có** | — | HCOS-F16: danh sách KEK `id:base64(32 byte)`, phân cách bằng dấu phẩy; KEK **đầu tiên** đang dùng để bọc DEK, các KEK sau chỉ để mở DEK cũ (khi đổi KEK). Tạo: `echo "k1:$(openssl rand -base64 32)"`. Không được trùng `HCOS_INTEGRATION_KEY`. **Mất KEK ⇒ mất SĐT / email / CCCD đã mã hoá**: sao lưu offline, tách khỏi bản sao lưu CSDL |
| `HCOS_PORTAL_OTP` | không | `off` | HCOS-F20: kênh OTP cổng bệnh nhân. `off` = tắt đăng nhập cổng; `training` = mã hiện trên màn đăng nhập (**bắt buộc** kèm `HCOS_TRAINING_ENV=1`, chỉ môi trường dữ liệu giả); `webhook` = gửi qua nhà cung cấp SMS / ZNS |
| `HCOS_TRAINING_ENV` | không | — | `1` = môi trường dữ liệu giả (cho phép `HCOS_PORTAL_OTP=training`). **Không** đặt ở production |
| `HCOS_PORTAL_OTP_URL` / `HCOS_PORTAL_OTP_TOKEN` / `HCOS_PORTAL_OTP_VENDOR` | khi `webhook` | — | URL https của nhà cung cấp, Bearer token (≥ 16 ký tự), id nhà cung cấp trong sổ F18 — phải có đánh giá còn hiệu lực cho dữ liệu "Cá nhân" (kiểm trước mỗi lần gửi). Chỉ bật khi đã có DPA thật |
| `HCOS_RETENTION_INTERVAL_SEC` | không | `86400` | HCOS-F17: chu kỳ job lưu giữ / xoá (giây); `0` = tắt (vẫn bấm "Chạy ngay" được), tối thiểu 300 |
| `HCOS_BACKUP_HORIZON_DAYS` | không | `90` | Thời hạn giữ bản sao lưu dài nhất (vòng đời bucket); ghi vào biên nhận xoá làm ngày "không thể khôi phục". Đổi vòng đời bucket thì đổi theo |
| `HCOS_PUBLIC_BASE_URL` | không | — | Địa chỉ https công khai (vd `https://smart.id.vn`) để thẻ Teams có nút "Mở trong HealthcareOS" |
| `HCOS_INTEGRATION_DISPATCH_SEC` | không | `15` | Chu kỳ giao webhook (giây); `0` = tắt, ≥ 5 |

Tạo login-role cho ứng dụng (chạy bởi DBA, không nằm trong migration vì chứa mật khẩu):

```sql
CREATE ROLE hcos_api LOGIN PASSWORD '<từ secret manager>' IN ROLE hcos_app;
```

## Endpoint vận hành (không cần xác thực, không trả dữ liệu tenant)
- `GET /healthz` — liveness: 200 khi tiến trình sống; **không** phụ thuộc DB.
- `GET /readyz` — readiness: 200 `{"status":"ready"}` khi lấy được kết nối và đọc được bảng nền tảng; 503 `{"status":"unavailable"}` nếu không (timeout `HCOS_READY_TIMEOUT_MS`). Body cố định, không lộ lỗi SQL/chuỗi kết nối. Không thay thế test cô lập tenant.

## Container
```
docker build -f services/api/Dockerfile -t hcos-api:local .
docker run --rm -p 8080:8080 --env-file ./hcos.env hcos-api:local   # hcos.env KHÔNG commit
```
- Chạy bằng user `node` (uid 1000); `HEALTHCHECK` dùng `/healthz`.
- `SIGTERM`/`SIGINT`: ngừng nhận kết nối, chờ request đang chạy, đóng pool, thoát 0 (tối đa 10 giây, quá hạn thoát 1). Kubernetes: đặt `terminationGracePeriodSeconds` ≥ 15; `livenessProbe` → `/healthz`, `readinessProbe` → `/readyz`.
- Migration **không** nằm trong image: chạy `node scripts/migrate.mjs` (cần `psql`) như một job riêng bằng role có quyền DDL.
