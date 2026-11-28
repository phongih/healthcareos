# HealthcareOS (HCOS)

Nền tảng quản lý phòng khám và bệnh viện nhỏ: hồ sơ bệnh nhân, tiếp đón và hàng đợi khám, kê đơn và cấp phát thuốc, quầy trả, thu ngân, thiết bị và vật tư, cổng bệnh nhân, quản lý nhân sự và cơ sở, và báo cáo tài chính.

Mã tài liệu dự án: `HCOS-P0-ENG-001`.

## Trạng thái

- **Staging**: `https://smart.id.vn`, VM `quiz@healthcareos`, dữ liệu giả (chỉ dùng để thử nghiệm và đào tạo).
- **Cổng giấy phép khám chữa bệnh** (F18): tổ chức nộp số giấy phép, operator duyệt hoặc từ chối trước khi nhận bệnh nhân thật. Dữ liệu thực tập dùng `HCOS_TRAINING_ENV=1`.
- **Màn "Hôm nay" theo vai trò** (đợt 3): lễ tân và điều dưỡng, bác sĩ, thu ngân, dược sĩ. Các màn bác sĩ, thu ngân và dược sĩ chỉ đọc; thao tác vẫn làm ở màn tương ứng.

## Công nghệ

| Thành phần | Ghi chú |
|---|---|
| Ngôn ngữ | TypeScript, Node.js 22 (`engines` tối thiểu 20) |
| API | `services/api` (bundle bằng esbuild) |
| Web | `apps/web` (React, build bằng `node build.mjs` vào `apps/web/dist`) |
| Cơ sở dữ liệu | PostgreSQL 16, bật RLS (FORCE). Hàm nghiệp vụ dùng `SECURITY DEFINER` |
| Định danh | Keycloak 26.0.8, realm `hcos` |
| Reverse proxy | Caddy |
| Triển khai | Docker Compose trong `deploy/staging` |

## Cấu trúc thư mục

```
apps/web/                 Giao diện web (màn hình trong src/screens, điều hướng trong src/lib)
services/api/src/         API: app.ts, http/ (route), platform/, finance/, pharmacy/, portal/, iam/, ...
packages/                 domain, security (danh mục dữ liệu, mã hoá), exports
infrastructure/database/  Migration SQL 001–031
deploy/staging/           Docker Compose, Caddy, runbook triển khai và vận hành
tests/                    Unit, HTTP, web, tích hợp PostgreSQL
scripts/                  migrate.mjs, kiểm chứng R2, ...
.github/workflows/ci.yml  CI: typecheck, unit, tích hợp PostgreSQL, web, container, r2-acceptance
HCOS-F*.md                Tài liệu từng tính năng (xem bảng bên dưới)
HCOS-S0-*.md              Biên bản acceptance và bằng chứng runtime của giai đoạn S0
```

## Tài liệu tính năng

| Mã | Nội dung |
|---|---|
| [F1](HCOS-F1_Feature_Notes.md) | Tìm bệnh nhân, `POST /fhir/Patient`, gỡ hợp nhất Person |
| [F2](HCOS-F2_Access_Policy.md) | Access policy theo dữ liệu |
| [F3](HCOS-F3_Pharmacy_API.md) | API dược và access policy cho Person Registry |
| [F4](HCOS-F4_Web_App.md) | Ứng dụng web tối thiểu (`/app`) |
| [F5](HCOS-F5_Prescriptions.md) | Kê đơn và cấp phát theo đơn |
| [F6](HCOS-F6_Visit_Queue.md) | Hàng đợi khám theo số thứ tự |
| [F7](HCOS-F7_Online_Booking.md) | Đặt lịch khám online |
| [F8](HCOS-F8_Finance.md) | Thu ngân giai đoạn 1 |
| [F9](HCOS-F9_Finance_Reports.md) | Báo cáo tài chính |
| [F10](HCOS-F10_Forecast.md) | Dự báo kinh doanh |
| [F11](HCOS-F11_Decision_Engine.md) | Decision Engine có kiểm soát và AI cục bộ |
| [F12](HCOS-F12_Integrations.md) | Hạ tầng tích hợp và Microsoft Teams |
| [F13](HCOS-F13_Auto_MRN.md) | Mã bệnh nhân tự sinh |
| [F14](HCOS-F14_Quay_tra.md) | Quầy trả: soạn thuốc, gọi ra quầy, giao thuốc, quyết toán |
| [F15](HCOS-F15_Danh_muc_du_lieu.md) | Danh mục dữ liệu và cấp độ rủi ro |
| [F16](HCOS-F16_Ma_hoa.md) | Mã hoá theo trường và quản lý khoá |
| [F17](HCOS-F17_Luu_giu_xoa.md) | Lưu giữ và xoá dữ liệu |
| [F18](HCOS-F18_Ben_thu_ba_AI_xuat_du_lieu.md) | Bên thứ ba, nguồn dữ liệu AI, xuất dữ liệu |
| [F19](HCOS-F19_Thiet_bi_vat_tu.md) | Thiết bị và vật tư y khoa |
| [F20](HCOS-F20_Cong_benh_nhan.md) | Cổng bệnh nhân |
| [F21](HCOS-F21_Nhan_su_co_so.md) | Nhân sự và cơ sở (wizard mở cơ sở) |

Acceptance giai đoạn S0: [R1](HCOS-S0-R1_Acceptance.md), [R2](HCOS-S0-R2_Acceptance.md), kèm bằng chứng runtime ([R1](HCOS-S0-R1_Runtime_Evidence.md), [R2](HCOS-S0-R2_Runtime_Evidence.md)).

## Vai trò và màn hình "Hôm nay"

`TodayScreen` chọn màn theo vai trò:

- Bác sĩ (không phải lễ tân): `DoctorToday`, lượt khám của tôi và hàng đợi theo phòng.
- Thu ngân (không phải lễ tân, bác sĩ): `CashierToday`, ca đang mở, hồ sơ đang mở và số còn phải thu.
- Dược sĩ (không phải lễ tân, bác sĩ, thu ngân): `PharmacistToday`, đơn còn thiếu thuốc và hàng soạn thuốc đang chờ.
- Còn lại (lễ tân, điều dưỡng): `ReceptionToday`.

Quyền truy cập màn hình nằm trong `apps/web/src/lib/roles.ts`; ghim mặc định theo vai trò nằm trong `apps/web/src/lib/nav-model.ts`. Server vẫn là nơi quyết định quyền thật; giao diện chỉ ẩn nút.

## Chạy và kiểm thử

Cài phụ thuộc và kiểm tra kiểu:

```bash
npm ci
npm run typecheck
```

Các nhóm kiểm thử:

```bash
npm test                      # unit: security, clinical, http, registry, config, pharmacy, iam, web
npm run test:integration      # tích hợp với PostgreSQL thật
npm run gate:g0g1             # typecheck + unit + integration
```

Kiểm thử tích hợp PostgreSQL cần `HCOS_IT=1` và trỏ tới cụm PostgreSQL (ví dụ `PGHOST=/var/run/postgresql`).

Build web:

```bash
cd apps/web && node build.mjs
```

Chạy API cục bộ (dùng cho phát triển):

```bash
npm run dev                   # services/api/src/main.ts
```

`.devstack.ts` chỉ dùng để phát triển cục bộ (API thật trên PostgreSQL, OIDC giả); không commit thay đổi của tệp này.

## Migration cơ sở dữ liệu

Migration nằm trong `infrastructure/database/migrations/`, áp dụng theo thứ tự số (001 đến 031). CI kiểm tra migration chạy sạch và chạy lại được (idempotent).

```bash
npm run db:migrate
```

## Triển khai staging

Runbook đầy đủ nằm trong `deploy/staging/`:

- [SIGNUP_DEPLOY.md](deploy/staging/SIGNUP_DEPLOY.md): đăng ký khách, OTP, duyệt vendor, cổng giấy phép.
- [IDP.md](deploy/staging/IDP.md): Keycloak.
- [BACKUP.md](deploy/staging/BACKUP.md) và [PITR.md](deploy/staging/PITR.md): sao lưu và khôi phục theo thời điểm.
- [ALERTS.md](deploy/staging/ALERTS.md): cảnh báo.
- [TRAINING.md](deploy/staging/TRAINING.md): dữ liệu đào tạo.

Khi chỉ cập nhật web, sau khi `main` đã có thay đổi: `git pull --ff-only origin main`, `cd apps/web && node build.mjs`, chép `dist/*` vào `deploy/staging/web-dist/`, rồi kiểm tra tên bundle trong `index.html`.

## Quy tắc đóng góp

- Mọi thay đổi đi qua PR vào `main`. CI phải xanh (cả `typecheck-and-unit`, `integration-postgres`, `web`, `container`, `r2-acceptance`) trước khi merge.
- Merge bằng squash.
- Commit và PR ghi rõ mã tính năng (ví dụ `HCOS-F21`) và thêm trailer của Claude khi do Claude thực hiện.
- Không commit bí mật. `deploy/staging/secrets.env`, `deploy/staging/hcos.env` và các file `.env` đã nằm trong `.gitignore`. Mật khẩu, mã OTP và khóa không được đưa vào chat, issue, PR hay log.

## Việc còn mở

- Xóa `KC_BOOTSTRAP_ADMIN_*` khỏi `docker-compose.yml` và `secrets.env` (hoặc đổi mật khẩu admin).
- Lưu nháp wizard mở cơ sở trên server (hiện nháp chỉ nằm trong trình duyệt).
- Cập nhật `deploy/staging/SIGNUP_DEPLOY.md` cho migration 029–031, API duyệt và cổng giấy phép.
- Đổi trạng thái tài khoản Keycloak `phongthan` sang `@example.invalid`, và rà soát `quantri`.
- Roadmap: step-up OTP, khóa sau 5 lần nhập sai, xử lý vendor bị tắt, chuông thông báo trên điện thoại (PR #39), danh sách từ cấm cho đường dẫn, F16b, F19 phần 2, đơn thuốc.
