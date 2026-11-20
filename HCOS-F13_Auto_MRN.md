# HCOS-F13 — Mã bệnh nhân tự sinh

## Vì sao
Trước F13, lễ tân phải tự nghĩ mã bệnh nhân (MRN) ở hai nơi: đăng ký bệnh nhân và check-in lịch hẹn tạo hồ sơ mới. Cách làm đó gây bốn vấn đề:
- chậm, dễ trùng;
- mỗi người một kiểu mã;
- gõ sai một ký tự là "lạc" hồ sơ;
- dễ bị dùng SĐT / CCCD làm mã, lộ dữ liệu cá nhân.

## Định dạng
`<TIỀN TỐ><YY>-<NNNNNN>-<C>`, ví dụ `BN26-000123-5`:
- **Tiền tố:** 1–4 chữ cái, theo cơ sở, mặc định `BN`. Đổi tiền tố chỉ áp dụng cho mã cấp từ đó về sau.
- **YY:** năm đăng ký theo **giờ Việt Nam**. Số thứ tự NNNNNN đếm lại từ 1 mỗi năm, tối đa 999 999 mỗi cơ sở mỗi năm.
- **C:** số kiểm tra Luhn của `YYNNNNNN`. Phát hiện mọi lỗi gõ sai một chữ số và hầu hết lỗi đảo hai chữ số kề nhau.
- **Mã không chứa thông tin cá nhân.** Mã đã cấp không bao giờ đổi; hồ sơ cũ giữ mã cũ.

## Cấp số
Hàm `patient.next_mrn(tenant, cơ sở, thời điểm)` tăng bộ đếm `patient.mrn_counters` bằng `INSERT … ON CONFLICT DO UPDATE` trong cùng transaction tạo hồ sơ:
- Hai lễ tân bấm cùng lúc không bị trùng mã (test chạy 6 lượt đăng ký song song).
- Bộ đếm chỉ tăng, không xoá. Transaction lỗi thì số đã cấp có thể bị bỏ qua (khoảng trống), nhưng không bao giờ trùng.

## Mã cũ (chuyển từ sổ giấy / phần mềm cũ)
- Mặc định **tắt**. Quản lý phòng khám bật ở **Bệnh nhân → Cài đặt mã bệnh nhân**; khi đó lễ tân thấy ô "Dùng mã cũ".
- Mã cũ **không được có dạng mã tự sinh**, để không đụng số sẽ cấp sau này. Mã cũ vẫn bị kiểm tra trùng.
- Seed đào tạo tạm bật chế độ này để tạo bệnh nhân `TT00001…`, rồi tắt lại ngay.

## Tìm kiếm
Ô tìm theo MRN nhận mã gõ chữ thường hoặc thiếu gạch (máy quét mã vạch). Mã có dạng tự sinh nhưng sai số kiểm tra sẽ báo **"sai số kiểm tra — có thể gõ nhầm"**, thay vì "không tìm thấy" (hoặc mở nhầm hồ sơ).

## API
- `POST /fhir/Patient`: không gửi identifier `mrn` thì hệ thống tự sinh; có gửi thì đó là mã cũ.
- `POST /api/patients`: trường `mrn` thành tuỳ chọn.
- Lỗi mã: `409 LEGACY_MRN_DISABLED`; `422 MRN_RESERVED_FORMAT`; `400 MRN_CHECK_DIGIT` (khi tìm).
- `GET /api/patient-mrn/settings?organization=` (`patient:register`); `POST /api/patient-mrn/settings` + `If-Match` (lần đầu `W/"0"`) `{ organizationId, prefix, allowLegacy }` (`patient:configure`: quản lý PK, quản trị).

## Giao diện
- Form đăng ký và check-in lịch hẹn hiện "Tự sinh khi lưu — mã tiếp theo dự kiến …".
- **Phiếu số thứ tự in mã bệnh nhân**, để người bệnh và lễ tân biết mã vừa cấp.
- Thẻ cài đặt mã cho quản lý.

## Migration 016
- Các bảng `patient.mrn_settings` và `patient.mrn_counters`: RLS FORCE, không xoá, bộ đếm chỉ tăng.
- Các hàm `patient.luhn_digit()` và `patient.next_mrn()`.

## Kiểm thử
- Đơn vị (`tests/registry/mrn.test.ts`): định dạng, Luhn (mọi lỗi sai một chữ số), chuẩn hoá khi tìm.
- PostgreSQL (`mrn-pg`, 8 test):
  - CSDL và TypeScript tính cùng số kiểm tra; tăng dần theo cơ sở; đăng ký song song không trùng;
  - đổi năm theo giờ Việt Nam; cài đặt + quyền + xung đột phiên bản;
  - mã cũ (tắt / bật / dạng bị cấm / trùng);
  - tìm chữ thường, thiếu gạch, sai số kiểm tra, đảo chữ số; bộ đếm chỉ tăng + RLS.
- Các test cũ dùng MRN gõ sẵn (`clinical-pg`, `http-pg`, `registry-pg`) bật "mã cũ" cho cơ sở thử. Test "thiếu MRN ⇒ 422" đổi thành hành vi mới.
- E2E: lễ tân đăng ký không cần nghĩ mã; tìm mã thiếu gạch; gõ sai số kiểm tra; check-in lịch hẹn tạo hồ sơ mới có mã trên phiếu số (bỏ qua lịch trùng hồ sơ cũ — cơ chế chống trùng F7 vẫn chặn đúng); quản lý bật mã cũ → mã dạng tự sinh bị chặn → mã cũ hợp lệ lưu được → tắt lại.
