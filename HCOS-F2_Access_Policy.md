# HCOS-F2 — Access policy theo dữ liệu

Trạng thái kiểm chứng: **tsc strict sạch; unit (12 suite) và integration PG 16.15 (7 suite) xanh trên sandbox.**
Sandbox dùng shim tự viết cho vitest và jose; integration chạy qua adapter psql. Hai suite `startup` và `jwks-e2e` cần `pg` thật nên chưa chạy ở đây.
Kết quả chỉ có giá trị chính thức khi GitHub Actions xanh (npm ci, cùng vitest/pg/jose thật).

Ý tưởng lấy từ AccessPolicy của Medplum, nhưng giữ nguyên lợi thế ở tầng DB của HealthcareOS (RLS, append-only, FK ghép).

## 1. Mô hình
- `iam.access_policies`: policy thuộc tenant, `rules` là mảng luật JSON. `iam.memberships.access_policy_id` là tuỳ chọn: mỗi membership gắn tối đa một policy.
- **Policy chỉ thu hẹp quyền, không bao giờ cấp thêm.** Quyền thực tế bằng quyền của vai trò (bảng `PERMISSIONS` trong code) giao với policy.
  - Membership không gắn policy: giữ hành vi cũ (tương thích ngược).
  - Membership có gắn policy: chỉ được phép khi có ít nhất một luật cùng `action` mà mọi điều kiện đều khớp.
- Không đổi chính sách hiện tại: bệnh nhân xem hồ sơ của chính mình không qua policy.

Ví dụ: điều dưỡng chỉ được ghi nhiệt độ và SpO₂, không tự đặt thời điểm đo, không xem chẩn đoán và CCCD.
```json
[
  { "action": "patient:read", "hiddenFields": ["identifiers"] },
  { "action": "encounter:read", "criteria": { "encounterStatus": ["in_progress"] }, "hiddenFields": ["conditions"] },
  { "action": "observation:write", "criteria": { "codes": ["http://loinc.org|8310-5", "http://loinc.org|59408-5"] },
    "readonlyFields": ["effectiveAt", "status"] }
]
```

## 2. Danh mục (đóng; luật lạ bị từ chối khi lưu)
| action | quyền nền | điều kiện | hiddenFields | readonlyFields |
|---|---|---|---|---|
| `patient:read` | chart:read | — | person.phone, person.email, person.birthDate, identifiers | — |
| `encounter:read` | chart:read | practitioner=self, encounterClass, encounterStatus | encounter.reasonText, conditions, observations | — |
| `patient:register` | patient:register | — | — | — |
| `encounter:create` | encounter:create | encounterClass | — | periodStart |
| `condition:write` | condition:write | codes | — | category, clinicalStatus, verificationStatus, onsetAt |
| `observation:write` | observation:write | practitioner=self, codes | — | status, effectiveAt |
| `encounter:close` | encounter:close | encounterClass | — | — |

Person Registry và dược (bổ sung ở HCOS-F3):
| action | quyền nền | điều kiện | hiddenFields |
|---|---|---|---|
| `person:read` | person:search | — | person.phone, person.email, person.birthDate, identifiers |
| `person:search` · `person:create` · `person:identifier` · `person:merge` · `person:unmerge` | cùng tên | — | — |
| `pharmacy:catalog:read` · `pharmacy:catalog:write` | cùng tên | — | — |
| `pharmacy:location:write` · `pharmacy:stock:receive` · `pharmacy:stock:dispense` | cùng tên | locationType | — |
| `pharmacy:stock:read` | pharmacy:stock:read | locationType | unitCost |

- `codes` nhận `system|code` hoặc `system|*` (mọi mã trong một hệ mã).
- `readonlyFields`: người gọi không được đặt giá trị **khác mặc định của server** (ví dụ `status` bị khoá thì chỉ ghi được `final`). Vi phạm trả 403 kèm `field`.
- Xem danh mục qua API: `GET /api/access-policies/catalog`.

## 3. Quy tắc quyết định (fail-closed)
1. Điều kiện cần một dữ kiện mà thao tác không có (ví dụ `practitioner` khi tìm bệnh nhân) thì luật **không khớp**.
2. Policy không tải được, đã `retired`, hoặc bị sửa tay sai định dạng trong DB: membership đó **không có quyền**. Hệ thống không rơi về quyền mặc định.
3. Khi nhiều membership hoặc nhiều luật cùng cho phép, trường bị che và trường bị khoá là phần **giao** của chúng (con đường rộng nhất thắng). Một membership không gắn policy thắng tuyệt đối.
4. Khi `identifiers` hoặc `person.birthDate` bị che, **cấm tìm kiếm** theo identifier hay tên + ngày sinh. Nếu không, phép tìm sẽ thành công cụ xác nhận giá trị bị che.
5. Response bị che có `redacted: [...]` (REST). Bên FHIR, resource và Bundle được gắn `meta.security` = `v3-ObservationValue#REDACTED`, để client không hiểu nhầm là "không có dữ liệu".
6. Audit thành công ghi `accessPolicyIds` và `redacted`. Audit từ chối ghi `reason: ACCESS_POLICY`. Nội dung luật không bao giờ được trả cho client bị từ chối.

## 4. Quản trị — chỉ `tenant_admin` còn hiệu lực (đọc từ DB, không tin claim JWT)
| Route | Ghi chú |
|---|---|
| `GET /api/access-policies` · `GET /api/access-policies/:id` | `:id` trả kèm lịch sử phiên bản và số membership đang dùng; có ETag |
| `GET /api/access-policies/catalog` · `POST /api/access-policies/validate` | `validate` kiểm định thử, không ghi; lỗi trả 422 kèm `path` (ví dụ `rules[0].criteria.codes[1]`) |
| `POST /api/access-policies` | `{name, description?, rules}` → 201 + Location |
| `POST /api/access-policies/:id/revise` | `If-Match` bắt buộc; `{description?, rules?}` |
| `POST /api/access-policies/:id/retire` | `If-Match`; trả 409 `POLICY_IN_USE` nếu còn membership active |
| `POST /api/memberships/:id/access-policy` | `If-Match` = version của membership; `{policyId: uuid | null}` |

**Chống tự nới quyền:** admin không được gắn hay gỡ policy trên membership của chính mình. Admin cũng không được sửa hay retire một policy đang giới hạn chính mình. Những việc này phải do một `tenant_admin` khác làm.

Mỗi thay đổi ghi trong cùng một transaction:
- audit, kèm sha256 của bộ luật (không chép nguyên văn);
- outbox `iam.access_policy.changed` hoặc `iam.membership.access_policy.changed`;
- một snapshot vào `iam.access_policy_versions`.

## 5. DB (migration 007)
- RLS FORCE theo tenant trên cả hai bảng. FK ghép `(tenant_id, policy_id)` nên membership không trỏ được sang policy của tenant khác.
- Trigger:
  - policy `retired` là bất biến; `created_by` và `created_at` không đổi được;
  - không retire được policy khi còn membership active dùng nó;
  - không gắn được policy không active;
  - mỗi INSERT/UPDATE sinh một snapshot, có `changed_by` lấy từ `app.user_id` (bắt buộc phải có).
- `access_policy_versions` chỉ cho ghi thêm. Không cấp quyền DELETE hay TRUNCATE trên cả hai bảng.
- CHECK: `rules` phải là mảng 1–50 phần tử; tên 3–100 ký tự, duy nhất trong tenant.
- Các suite integration giờ áp **toàn bộ** migration (trước đây mỗi suite chọn một tập con).

## Giới hạn đã biết
- Áp cho dịch vụ lâm sàng (S1), Person Registry và dược (HCOS-F3). Chưa áp cho chính API quản trị policy (chỉ `tenant_admin`).
- Không cache: mỗi request đọc policy trong cùng transaction (luôn mới, tốn thêm 1 truy vấn khi có policy). Đã phát sự kiện outbox để làm cache sau này.
- Che trường ở mức đối tượng miền. Chưa có che theo mã (ví dụ ẩn riêng kết quả HIV). Muốn vậy cần thêm điều kiện `codes` cho `encounter:read`.
- Điều kiện là danh mục đóng, có chủ đích. Thêm điều kiện mới phải sửa code, viết test và duyệt.
