# HCOS-F16 — Mã hoá theo trường & quản lý khoá

## Mục tiêu
- **Người có quyền đọc CSDL không lấy được khoá giải mã.** Người đó có thể là DBA, người cầm bản sao lưu, hay kẻ chiếm được tài khoản `postgres`.
  - CSDL chỉ chứa bản mã và DEK đã bọc.
  - KEK để mở DEK nằm ngoài CSDL, trong biến môi trường của máy chủ ứng dụng.
- **Quyền giải mã tách khỏi quyền đọc dữ liệu.** Đọc hồ sơ chỉ thấy giá trị đã che (`091****678`). Xem bản rõ cần:
  - quyền `pii:reveal` tại cơ sở của bản ghi;
  - lý do (5–200 ký tự).

  Mỗi lần xem ghi một sự kiện audit `pii.reveal`, gồm người xem, bản ghi, trường và lý do. Audit **không** ghi giá trị.
- Tìm kiếm và chống trùng vẫn hoạt động, nhờ **blind index** dùng khoá riêng, tách khỏi khoá mã hoá.

## Phạm vi đợt này (định danh & liên hệ)
| Bảng | Cột mã hoá | Blind index | Hiển thị che |
|---|---|---|---|
| `patient.persons` | `phone_enc`, `email_enc` | `phone_bidx` (chống trùng) | `phone_hint`, `email_hint` |
| `patient.identifiers` | `value_enc` (CCCD, BHYT, hộ chiếu…) | `value_bidx` (unique theo `system`, tìm theo CCCD) | `value_hint` |
| `clinical.bookings` | `phone_enc`, `national_id_enc` | `phone_bidx` (1 lịch/SĐT/ngày, tra cứu công khai), `national_id_bidx` (khớp hồ sơ cũ) | `phone_hint`, `national_id_hint` |
| `patient.person_merges` | khối `contact` trong ảnh chụp (`phoneEnc`, `emailEnc`, gợi ý) | — | — |

- Các cột bản rõ cũ (`phone`, `email`, `phone_key`, `value`, `national_id`) được giữ lại để backfill, chỉ được phép là `NULL`.
  - Trigger `*_z_no_plaintext` chặn mọi lệnh ghi bản rõ, kể cả của superuser, trừ khi tắt trigger có chủ đích.
- **Chuyển sang F16b** (lưu rõ có chủ đích trong đợt này, được bảo vệ bằng RLS và phân quyền):
  - `persons.birth_date`: dùng để tính tuổi / liều, cho danh sách lâm sàng và FHIR;
  - `bookings.reason`: lễ tân cần đọc khi check-in;
  - `receipts.payer_name`: in trên biên lai;
  - họ tên và dữ liệu lâm sàng.

## Thiết kế
- **Thuật toán:** AES-256-GCM, IV 12 byte ngẫu nhiên.
  - Bản mã có dạng `e1.<phiên bản DEK>.<base64url(iv | ciphertext | tag)>`.
  - AAD là `hcos-pii|<tenant>|<miền>`, với miền là `phone`, `email` hoặc `identifier`. Do đó bản mã của tenant này không mở được dưới tenant khác, và không dùng lẫn giữa các miền.
- **Envelope encryption:** mỗi tenant có:
  - một **DEK** (`purpose = data`) để mã hoá dữ liệu;
  - một **khoá blind index** (`purpose = index`) cho HMAC-SHA256.

  Cả hai sinh ngẫu nhiên 32 byte, được bọc bằng KEK (AES-256-GCM, AAD `hcos-dek|tenant|purpose|version`) và lưu trong `keyvault.tenant_keys`. Bảng này:
  - bật RLS FORCE;
  - không cho xoá;
  - chỉ có một khoá `active` cho mỗi mục đích.
- **KEK:** `HCOS_KEKS=id1:base64,id2:base64`.
  - KEK đầu tiên đang dùng; các KEK sau chỉ để mở DEK cũ.
  - Truy cập qua interface `KeyProvider`. Hiện có `LocalKeyProvider` đọc từ biến môi trường; sau này có thể thay bằng HSM / KMS mà không đổi dữ liệu.
- **Blind index:** HMAC-SHA256 (khoá index, `miền \0 giá trị chuẩn hoá`), cắt còn 32 ký tự hex.
  - SĐT được chuẩn hoá về `0xxxxxxxxx` (`+84 912…` và `0912…` cho cùng index).
  - Khoá index là khoá riêng, nên lộ index không giúp giải mã và ngược lại.
- **Lịch hẹn → hồ sơ:** `POST /api/bookings/:id/register` giải mã trong server rồi mã hoá lại cho hồ sơ, nên SĐT và CCCD không đi qua trình duyệt khi lễ tân check-in người mới.

## Quyền
- `pii:reveal`: lễ tân (`clinic_staff`), quản lý phòng khám, bác sĩ, tại cơ sở có hồ sơ của người bệnh / cơ sở của lịch hẹn. Dược sĩ và thu ngân chỉ thấy giá trị đã che.
- `keys:manage`: quản trị hệ thống (`tenant_admin`). Dùng cho tab **Quản trị dữ liệu → Mã hoá theo trường**:
  - xem khoá (chỉ siêu dữ liệu);
  - mã hoá dữ liệu cũ;
  - xoay DEK, mã hoá lại;
  - bọc lại bằng KEK mới;
  - xoay khoá blind index.

## API
| Phương thức | Đường dẫn | Quyền |
|---|---|---|
| POST | `/api/pii/reveal {kind: patient\|person\|identifier\|booking, id, field, reason}` | `pii:reveal` |
| GET | `/api/keys` | `keys:manage` |
| POST | `/api/keys/rotate {purpose: data\|index}` | `keys:manage` |
| POST | `/api/keys/reencrypt {limit?}` · `/api/keys/rewrap` · `/api/keys/backfill {limit?}` | `keys:manage` |
| POST | `/api/bookings/:id/register {mrn?}` | `queue:issue` (lễ tân check-in) + quyền tạo hồ sơ của dịch vụ đăng ký |

## Vận hành khoá
- **Xoay DEK:** bấm "Xoay DEK".
  - Dữ liệu ghi mới dùng phiên bản mới; dữ liệu cũ vẫn đọc được.
  - Sau đó bấm "Mã hoá lại" (theo lô 500) để đưa mọi giá trị về DEK mới. DEK cũ chuyển sang `retired` nhưng được giữ lại để mở bản sao lưu cũ.
- **Đổi KEK:**
  1. Thêm KEK mới vào **đầu** `HCOS_KEKS`, giữ KEK cũ phía sau.
  2. Khởi động lại API.
  3. Bấm "Bọc lại bằng KEK mới".
  4. Gỡ KEK cũ khỏi cấu hình và khởi động lại.

  Dữ liệu không phải mã hoá lại.
- **Xoay khoá blind index:** khoá các bảng liên quan rồi tính lại mọi index trong **một** giao dịch, nên chống trùng và tra cứu không bao giờ thấy trạng thái lẫn lộn. Với dữ liệu nhỏ, việc này mất vài giây.
- **Mất KEK là mất SĐT / email / CCCD đã mã hoá.**
  - Sao lưu KEK offline, tách khỏi bản sao lưu CSDL. Nếu để chung, người cầm bản sao lưu có cả hai.
  - Không dán KEK vào chat, ticket hay repo.

## Triển khai lên staging (một lần)
Chạy trên VM, trong `~/healthcareos/deploy/staging`:
1. Tạo KEK và thêm vào `hcos.env`. **Không in ra màn hình, không dán vào đâu:**
   ```bash
   echo "HCOS_KEKS=k1:$(openssl rand -base64 32)" >> hcos.env
   ```
   Sau đó chép `hcos.env` (hoặc riêng dòng `HCOS_KEKS`) ra nơi lưu offline.
2. Thực hiện các bước triển khai thường lệ:
   1. `git pull`
   2. sao lưu CSDL
   3. migrate (migration `019_field_encryption.sql`)
   4. tag image rollback
   5. build
   6. `docker compose … up -d --no-deps --force-recreate api`

   Nếu API thiếu `HCOS_KEKS`, nó sẽ dừng ngay và báo lỗi cấu hình.
3. Mã hoá dữ liệu cũ và xoá bản rõ (kể cả ảnh chụp gộp hồ sơ):
   ```bash
   docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false \
     --env-file hcos.env -v "$HOME/healthcareos":/w -w /w node:22 \
     sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx tsx scripts/pii-backfill.ts 00000000-0000-4000-8000-0000000000a1'
   ```
   Kết quả phải là `Bản rõ còn lại: 0`. Nếu không, script trả mã lỗi 1, và có thể chạy lại an toàn.
4. Chạy `bash training/setup-training.sh`.
5. Mở **Quản trị dữ liệu**:
   - thẻ "Mã hoá theo trường" phải báo "Không còn giá trị nào lưu bản rõ";
   - danh mục đã đổi phiên bản, nên **ghi nhận lại cấp độ** ở thẻ "Hồ sơ tự đánh giá".

**Rollback:** nếu phải quay về image cũ, image cũ không đọc được cột mã hoá. Khôi phục bản sao lưu ở bước 2 cùng image rollback.

## Kiểm thử
`tests/integration/pii-pg.integration.test.ts` (PostgreSQL thật) kiểm tra:
- quét mọi bảng / audit / outbox bằng superuser: không có bản rõ;
- KEK sai không mở được DEK, và tenant khác không mở được bản mã;
- trigger chặn ghi bản rõ;
- `pii:reveal`: phân quyền, cơ sở, lý do, audit;
- blind index khớp giữa lịch hẹn và hồ sơ;
- xoay DEK + mã hoá lại; đổi KEK rồi gỡ KEK cũ; xoay khoá index;
- backfill (cả ảnh chụp gộp), chạy lại không thay đổi gì, guard của ảnh chụp.

Ngoài ra, CI chạy `scripts/pii-backfill.ts` với driver `pg` thật sau bước seed dữ liệu thực tập.
