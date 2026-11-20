# HCOS-F5 — Kê đơn thuốc và cấp phát theo đơn

Nối tiếp HCOS-F4. Migration mới: **009_prescriptions.sql**.

**Kiểm chứng trên sandbox:**
- tsc strict sạch; toàn bộ unit suite xanh, thêm `tests/http/prescription-api.test.ts`.
- 10 suite integration trên PG 16 xanh, gồm suite mới `prescription-pg` với 8 ca.
- E2E Playwright luồng bác sĩ → dược sĩ đạt dưới CSP thật; e2e cũ vẫn đạt.
- Kết quả chính thức là CI trên PR.

## 1. Luồng
1. **Bác sĩ phụ trách** đợt khám đang mở kê đơn: 1–20 thuốc.
   - Mỗi dòng có liều mỗi lần, đơn vị, số lần/ngày, số ngày, số lượng cấp và cách dùng. TT 26/2025/TT-BYT bắt buộc ghi các trường này trên đơn.
   - Số lượng được gợi ý theo công thức liều × lần/ngày × ngày khi đơn vị liều trùng đơn vị kho; bác sĩ sửa được.
2. **Dược sĩ** mở màn Dược và thấy **"Đơn chờ cấp"** của cơ sở, đơn cũ nhất trước, kèm MRN, tên bệnh nhân và bác sĩ kê.
   - Cấp từng dòng từ kho đang chọn, theo FEFO.
   - Được cấp nhiều lần cho một dòng, nhưng tổng không vượt số kê.
3. Khi mọi dòng đã cấp đủ, đơn tự chuyển sang **completed** trong cùng transaction với lần cấp cuối.
4. Bác sĩ **huỷ** được đơn của mình nếu đơn chưa cấp gì (If-Match theo version).

Cấp phát tự do theo đợt khám (không theo đơn) vẫn giữ như cũ.

## 2. API
| Route | Quyền | Ghi chú |
|---|---|---|
| `POST /api/prescriptions` | `prescription:write`: doctor, phải là bác sĩ phụ trách | Body: `{ encounterId, note?, items: [{ medicationId, doseQuantity, doseUnit, frequencyPerDay, durationDays, quantity, instructions? }] }`. Trả 201 kèm ETag. |
| `GET /api/prescriptions?encounter=<id>` | `prescription:read`: doctor, pharmacist; hoặc chính bệnh nhân | Trả đơn kèm dòng thuốc, thông tin thuốc và tên bác sĩ kê. |
| `GET /api/prescriptions?organization=<id>[&status=]` | `prescription:read` | Hàng đợi; mặc định `active`, tối đa 100 đơn, có MRN và tên bệnh nhân. |
| `POST /api/prescriptions/:id/cancel` | người kê đơn | Bắt buộc `If-Match`; trả 409 `ALREADY_DISPENSED` nếu đã cấp. |
| `POST /api/pharmacy/dispenses` + `prescriptionItemId` | `pharmacy:stock:dispense` | Trả 422 `PRESCRIPTION_MISMATCH`, 409 `EXCEEDS_PRESCRIPTION` hoặc 409 `PRESCRIPTION_NOT_ACTIVE`. |

- Lỗi nghiệp vụ của phần lâm sàng giờ có `reason` trong OperationOutcome, giống phần dược.
- Access policy có thêm hai action trong catalog:
  - `prescription:write`, với điều kiện `encounterClass`;
  - `prescription:read`.
- Policy đã có từ trước không chứa hai action này. Vì vậy người có policy (ví dụ điều dưỡng thực tập) mặc định **không** xem được đơn. Policy chỉ thu hẹp quyền.

## 3. Bất biến ở tầng DB (migration 009)
- **FK ghép:** đơn cùng tenant, cùng bệnh nhân và cùng organization với đợt khám. Mỗi dòng thuốc trỏ tới danh mục thuốc của chính tenant.
- **Chỉ kê đơn khi đợt khám `in_progress`.** Mỗi đơn không có hai dòng trùng thuốc.
- **Nội dung đơn và dòng thuốc bất biến.**
  - Chỉ đổi được trạng thái đơn và số đã cấp.
  - Số đã cấp chỉ tăng, và chỉ tăng khi đơn còn `active`.
- **Trạng thái đơn:** `active` chuyển sang `completed` (mọi dòng đã đủ), `cancelled` (chưa cấp gì) hoặc `entered_in_error`.
- **Đã cấp khớp sổ cái:** `quantity_dispensed` = tổng `pharmacy.stock_movements` gắn với dòng đó.
  - Sổ cái phải đúng thuốc, đúng đợt khám.
  - Kiểm bằng constraint trigger hoãn tới cuối transaction, giống ràng buộc tồn kho khớp sổ cái ở 006.
- **Không xoá, không truncate;** mọi UPDATE đều lưu snapshot vào `clinical.record_history`; RLS FORCE theo tenant.
- **Cấp đồng thời cùng một dòng:** dòng đơn và đơn bị khoá `FOR UPDATE` trước khi trừ kho. Test 6 lần cấp song song, mỗi lần 4 viên, trên dòng kê 10 viên: đúng 2 lần thành công (8 viên).

## 4. Web
- **Màn đợt khám:** thẻ **Đơn thuốc** cho bác sĩ và dược sĩ.
  - Bác sĩ phụ trách thấy nút "+ Kê đơn" (form nhiều dòng, số lượng tự tính) và nút "Huỷ đơn" khi đơn chưa cấp.
  - Điều dưỡng không thấy thẻ này.
- **Màn Dược:** thẻ **Đơn chờ cấp** cho dược sĩ.
  - Mỗi dòng có ô số lượng (mặc định là số còn lại, không cho vượt) và nút "Cấp".
  - Mỗi lần cấp có Idempotency-Key riêng.

## 5. Môi trường thực tập
- `seed-training.ts`:
  - Đợt khám đã đóng: bác sĩ kê đơn, dược sĩ cấp theo từng dòng, rồi đóng đợt khám.
  - Thêm **3 đơn chờ cấp** cho các đợt khám đang mở của `TT00030`, `TT00035`, `TT00040`, để dược sĩ tập.
  - Trên staging đã seed trước đây, chạy lại chỉ thêm 3 đơn chờ cấp này.
- `TRAINING.md` có thêm bài tập kê đơn và cấp theo đơn.

## 6. Triển khai
- Áp migration 009 trước, rồi mới chạy API mới. Code cũ vẫn chạy được với schema 009: cột mới trong `stock_movements` có thể để trống.
- Rollback API không cần khôi phục DB.

## 7. Chưa làm
- Liên thông **Hệ thống đơn thuốc quốc gia**:
  - mã đơn quốc gia, chữ ký số, gửi và huỷ đơn qua API;
  - cần tài khoản cơ sở và tài liệu kỹ thuật của Bộ Y tế.
- In đơn thuốc (mẫu theo TT 26), đơn thuốc "N" và "H", thuốc gây nghiện / hướng thần, cảnh báo tương tác và dị ứng.
- FHIR `MedicationRequest` / `MedicationDispense`.
- Chống gửi trùng cho thao tác kê đơn. Hiện web chỉ chặn bấm hai lần; dòng trùng thuốc trong cùng đơn thì bị DB chặn.
