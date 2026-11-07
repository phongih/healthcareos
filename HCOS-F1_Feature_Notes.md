# HCOS-F1 — Patient search, `POST /fhir/Patient`, Person unmerge

Trạng thái kiểm chứng: **tsc strict sạch; unit + integration (PG16 cục bộ) xanh trên sandbox dùng shim cho vitest/jose/pg.**
Kết quả có giá trị chính thức chỉ khi GitHub Actions (npm ci + vitest/pg/jose thật) xanh — chưa chạy cho commit này.

## 1. Tìm kiếm bệnh nhân — `GET /fhir/Patient`
- Bắt buộc `organization=<uuid>` (token phải có org đó; quyền `chart:read` tại org). Tham số: `mrn`, `identifier=system|value`, `given`+`family`+`birthdate` (đi cùng nhau), `_count` (1–20, mặc định 20).
- Tham số lạ hoặc lặp → 400; thiếu tiêu chí / sai định dạng → 422. Nhiều tiêu chí = AND. Trả `Bundle` `searchset`.
- Tên so khớp theo `name_key` (không dấu, không phân biệt thứ tự). Audit chỉ ghi loại tiêu chí và số kết quả.

## 2. Tạo bệnh nhân — `POST /fhir/Patient`
- Một transaction: person + identifiers + patient. Lỗi MRN/định danh/trùng → rollback, không có person mồ côi.
- MRN: `identifier.type.text = "mrn"`, `system = urn:hcos:mrn:<orgId>`; org lấy từ `managingOrganization`. Cần vai trò tạo person và đăng ký patient TẠI org đó.
- Trùng nghi ngờ (probable/definite) → 409; endpoint này không nhận `duplicateOverride` (dùng `/api/persons` trước). 201 + `Location` + `ETag`.

## 3. Hoàn tác merge — `POST /api/persons/:id/unmerge`
- Quyền: clinic_admin / tenant_admin. Body: `reason` (5–500), `expectedSourceVersion`, `expectedTargetVersion`.
- **Chính sách: chặn, không đoán.** Nếu sau merge dữ liệu đã đổi → 409 `UNMERGE_BLOCKED` kèm `blockers`:
  `TARGET_MODIFIED`, `TARGET_NOT_ACTIVE`, `PATIENTS_CHANGED`, `IDENTIFIERS_CHANGED`, `USERS_CHANGED`, `MERGE_RECORD_LEGACY`.
- Khi hợp lệ (cùng transaction): source → active; target trả các trường về snapshot lúc merge; patients/identifiers/users chuyển lại source; ghi `person_unmerges` (append-only) + outbox + audit.
- DB: `merged → active` chỉ được phép khi có bản ghi `person_unmerges` khớp cặp merge, tạo trong cùng transaction; mọi đường khác vẫn lỗi `55000`.
- Một merge chỉ hoàn tác một lần; sau đó có thể merge lại (trigger đảm bảo tối đa một merge đang hiệu lực cho mỗi source).

## Giới hạn đã biết
- Định danh trùng đã bị "retire" khi merge **không** được kích hoạt lại khi unmerge (báo trong `leftInactiveIdentifierIds`).
- Merge cũ (trước migration 004) không có snapshot → không unmerge được (`MERGE_RECORD_LEGACY`).
- Person cũ chưa có `name_key` không tìm được bằng tên (vẫn tìm được bằng MRN/định danh).
- Bốn suite integration cũ vẫn dùng adapter psql trong sandbox; chỉ `startup` và `jwks-e2e` dùng `pg` thật — CI mới là bằng chứng cuối.
- Lý do override trùng được lưu trong payload audit (đã có từ trước).
