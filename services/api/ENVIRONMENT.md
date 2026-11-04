# HealthcareOS API — cấu hình môi trường

Cấu hình **chỉ** qua biến môi trường lúc chạy. Image không chứa bí mật; thiếu/sai biến => tiến trình in lý do (chỉ tên biến) và thoát mã 1.

| Biến | Bắt buộc | Mặc định | Ghi chú |
|---|---|---|---|
| `HCOS_DATABASE_URL` | có | — | `postgres://<login-role>:<mật khẩu>@host:5432/db` (TCP; không hỗ trợ URL unix-socket). Login-role phải là thành viên `hcos_app`, **không** superuser/BYPASSRLS; không dùng `postgres`/`hcos_provisioner`. Khởi động bị từ chối nếu phiên DB là superuser/BYPASSRLS. |
| `HCOS_JWT_ISSUER` | có | — | Nhiều giá trị: phân tách bằng dấu phẩy |
| `HCOS_JWT_AUDIENCE` | có | — | Nhiều giá trị: phân tách bằng dấu phẩy |
| `HCOS_JWKS_URL` | có | — | `https://…` (http chỉ cho localhost/127.0.0.1) |
| `HCOS_PORT` | không | `8080` | 1–65535 |
| `HCOS_MAX_BODY_BYTES` | không | `1048576` | 1024 – 52428800 |
| `HCOS_DB_POOL_MAX` | không | `10` | 1–200 |
| `HCOS_READY_TIMEOUT_MS` | không | `2000` | Timeout cứng của `/readyz` (100–30000) |

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
