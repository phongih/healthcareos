# HCOS-F3 — API dược + access policy cho Person Registry và dược

Nối tiếp HCOS-F2 (PR #1). Không có migration mới: dùng `iam.access_policies` và `iam.memberships.access_policy_id` từ migration 007.

Trạng thái kiểm chứng: **tsc strict sạch; 14 suite unit và 8 suite integration (PG 16.15) xanh trên sandbox.**
Sandbox dùng shim cho vitest và jose. Kết quả chính thức là GitHub Actions trên PR.

## 1. Phân quyền dược: thay đổi hành vi (cần lưu ý khi triển khai)
- **Vai trò lấy từ `iam.memberships` còn hiệu lực, không lấy từ claim `roles` trong JWT nữa** (giống clinical và registry).
  Trước khi deploy, mỗi dược sĩ và quản lý kho phải có membership `pharmacist` hoặc `pharmacy_admin` **tại organization sở hữu kho**.
- Phạm vi:
  - Danh mục thuốc thuộc tenant: chỉ cần membership ở một organization nằm trong phạm vi token.
  - Kho, tồn kho, nhập, xuất: phải có membership **tại organization của vị trí kho**, và organization đó phải nằm trong phạm vi token.
- Thứ tự kiểm tra: nếu không có vai trò phù hợp ở bất kỳ organization nào thì trả 403 ngay, trước mọi truy vấn khác. Sau đó mới tải kho, rồi xét vai trò và policy tại organization của kho, rồi mới validate dữ liệu.
- Nếu một thao tác quên gọi bước phân quyền thì nó **lỗi chứ không thành công** (kiểm trong `exec`).
- Cấp phát: đợt khám phải tồn tại trong tenant, **cùng organization với kho**, và không ở trạng thái `cancelled` hay `entered_in_error`.
- `performed_by` trong sổ cái và `actor` trong audit lấy `user_id` từ DB. Trước đây hai trường này rỗng khi đi qua HTTP vì `ctx.userId` luôn là null. Audit ghi organization của kho.

| Quyền | Vai trò |
|---|---|
| pharmacy:catalog:read | pharmacist, pharmacy_admin, doctor, clinic_staff |
| pharmacy:catalog:write · pharmacy:stock:receive | pharmacist, pharmacy_admin |
| pharmacy:location:write | pharmacy_admin |
| pharmacy:stock:read | pharmacist, pharmacy_admin |
| pharmacy:stock:dispense | pharmacist |

## 2. Route
| Route | Ghi chú |
|---|---|
| `GET /api/pharmacy/medications?active=&_count=` | tối đa 200 |
| `POST /api/pharmacy/medications` · `POST /api/pharmacy/substances` | 201 |
| `GET /fhir/Medication/:id` | FHIR R4 Medication (status, code.text, form, barcode trong identifier) |
| `GET /api/pharmacy/locations?organization=` · `POST /api/pharmacy/locations` | |
| `GET /api/pharmacy/locations/:id/stock` | tồn theo lô; `unitCost` = null và `redacted` khi policy che |
| `POST /api/pharmacy/receipts` | nhập theo lô |
| `POST /api/pharmacy/dispenses` | FEFO; hết hàng trả 409 `INSUFFICIENT_STOCK` |
| `GET /api/pharmacy/dispenses?encounter=` | các lần cấp phát của đợt khám |

Lỗi dược được map thành OperationOutcome:

| Lỗi | HTTP | Ghi chú |
|---|---|---|
| VALIDATION | 422 | `details.text` = reason |
| NOT_FOUND | 404 | |
| CONFLICT | 409 | |
| INSUFFICIENT_STOCK | 409 | `business-rule` |
| EXPIRED_BATCH | 422 | `business-rule` |
| FORBIDDEN | 403 | không kèm chi tiết |

Trước đây mọi lỗi dược đều thành 500.

## 3. Access policy cho Person Registry
- `GET /api/persons/:id` che phone, email, birthDate và identifiers theo policy, kèm `redacted`.
- Các thao tác tạo, định danh, merge, unmerge và `POST /fhir/Patient` đều đi qua policy (chỉ thu hẹp).
- Audit ghi `accessPolicyIds`. Audit từ chối ghi `reason: ACCESS_POLICY`.

## 4. Chống gửi trùng (migration 008)
`POST /api/pharmacy/receipts` và `POST /api/pharmacy/dispenses` **bắt buộc** header `Idempotency-Key`. Thiếu header thì trả 428. Khoá dài 8–128 ký tự `[A-Za-z0-9._:-]`, khuyến nghị dùng UUID v4, mỗi ý định nhập hoặc cấp phát dùng một khoá.

| Tình huống | Kết quả |
|---|---|
| Lần đầu | thực hiện, lưu kết quả **trong cùng transaction** với thao tác kho |
| Gửi lại cùng khoá + cùng body | trả lại đúng kết quả cũ (cùng status 201) kèm `Idempotent-Replayed: true`; **không** đụng tới kho; audit ghi `idempotentReplay` |
| Gửi đồng thời cùng khoá | PostgreSQL bắt lần sau chờ lần trước commit, rồi trả kết quả đã lưu (test: 8 request song song thì đúng 1 lần trừ kho) |
| Cùng khoá, body khác | 422 `IDEMPOTENCY_KEY_REUSED` |
| Lần trước lỗi (hết hàng, sai dữ liệu…) | khoá rollback cùng thao tác, nên gửi lại sẽ **thực hiện lại** |
| Người dùng khác dùng trùng khoá | yêu cầu độc lập: không gian khoá theo (tenant, người gọi, loại thao tác) |

- Body được so khớp qua sha256 của JSON chuẩn hoá (không phụ thuộc thứ tự khoá).
- Bảng `platform.idempotency_keys` có RLS FORCE theo tenant và FK người gọi. `request_hash` và `response` bất biến sau khi hoàn tất. Không có quyền DELETE.
- Replay chỉ kiểm vai trò ở mức tenant, không kiểm lại policy theo kho: người gọi chỉ nhận lại kết quả của **chính mình** và không có thay đổi dữ liệu nào.
- Chưa có job dọn khoá cũ (index `created_at` đã sẵn). Khi thêm, nên giữ ít nhất 24 giờ.

## Giới hạn đã biết
- Chưa có chuyển kho, điều chỉnh hay huỷ (loại `transfer`, `adjustment`, `disposal` đã có trong schema nhưng chưa có API). Chưa có FHIR MedicationDispense.
- `listMedications` và `listStockLocations` đọc từng dòng (N+1). Ổn ở quy mô PoC (≤ 200 dòng).
- `pharmacy:catalog:read` cho phép tất cả vai trò lâm sàng xem danh mục. Danh mục không chứa PHI.
