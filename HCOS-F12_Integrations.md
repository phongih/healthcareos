# HCOS-F12 — Hạ tầng tích hợp + Microsoft Teams

Lõi dùng chung cho mọi kết nối bên thứ ba sau này, kiểm chứng bằng kết nối thật đầu tiên: **gửi sự kiện Decision Engine và sự cố hệ thống vào kênh Microsoft Teams**.

## 1. Kiến trúc

```
Nghiệp vụ (Decision Engine…) ──(cùng transaction)──► integration.outbox ──► integration.deliveries (mỗi kết nối nhận một dòng)
                                                                               │
                         IntegrationDispatcher (mỗi 15 giây) ◄─────────────────┘
                           tx1 giữ chỗ (sending, locked_until) → gửi HTTP ngoài transaction → tx2 ghi kết quả
                           → integration.delivery_attempts (chỉ thêm)
```

- **Outbox** ghi cùng transaction với thay đổi nghiệp vụ: không mất sự kiện, không gửi sự kiện của transaction đã rollback. Chỉ tạo bản ghi khi có kết nối đăng ký nhận.
- **Thử lại**: 1 phút → 5 phút → 15 phút → 1 giờ → 6 giờ → 24 giờ (tối đa 7 lần). 408 / 425 / 429 / 5xx / lỗi mạng là lỗi tạm thời (tôn trọng `Retry-After`, tối đa 1 giờ). Chuyển hướng và 4xx khác là lỗi vĩnh viễn.
- **Tự tạm dừng**: kết nối lỗi liên tiếp 10 lần thì tự tạm dừng, báo "sự cố hệ thống" qua **các kết nối khác** và ghi audit. Bật lại thì huỷ các tin tồn đọng quá 24 giờ.
- Tiến trình chết giữa lúc gửi: quá `locked_until` (2 phút) thì lượt đó được nhận lại. Hai bản API cùng chạy không gửi trùng (giữ chỗ bằng UPDATE có điều kiện).

## 2. Bảo vệ dữ liệu (NĐ 13/2023)

| Rủi ro | Biện pháp |
|---|---|
| Dữ liệu bệnh nhân ra ngoài | Nội dung dựng từ **danh sách trắng** trường (tiêu đề, chỉ số, tên luật, tên cơ sở). Liên kết chứa mã nội bộ (UUID đợt khám…) được thay bằng `#/inbox`. Test kiểm tra tên, MRN và mã đợt khám không xuất hiện trong outbox lẫn nội dung gửi. |
| Lộ URL Teams (URL = quyền gửi vào kênh) | Mã hoá AES-256-GCM, AAD gắn với tenant + kết nối + loại trường; khoá `HCOS_INTEGRATION_KEY` nằm ngoài CSDL. API và giao diện chỉ hiện gợi ý đã che (`prod-27…logic.azure.com/…G123`). |
| SSRF (gửi vào mạng nội bộ) | Teams chỉ nhận `*.logic.azure.com` và `*.environment.api.powerplatform.com` qua https:443. Webhook: https, không user:pass, chặn tên máy và IP nội bộ cả lúc lưu lẫn **sau khi phân giải DNS** lúc gửi. Không theo chuyển hướng; hết giờ 10 giây; chỉ đọc 4 KB phản hồi và không lưu phản hồi. |
| Chèn nội dung vào thẻ Teams | Thoát markdown ở mọi trường do người dùng nhập (tên thuốc, tên luật…). |
| Giả mạo webhook | `X-HCOS-Signature: v1=hex(HMAC-SHA256(secret, "<timestamp>.<body>"))` kèm `X-HCOS-Timestamp`, `X-HCOS-Event`, `X-HCOS-Delivery`. Bí mật chỉ hiện một lần khi tạo / đổi (`Cache-Control: no-store`). |
| Truy vết | Lịch sử cấu hình (không chứa URL), mọi lần gửi đều có nhật ký chỉ-thêm; tạo / sửa / tạm dừng / gửi thử / gửi lại / tự tạm dừng đều vào chuỗi audit hash. |

## 3. Microsoft Teams

Microsoft đã ngừng Office 365 Connectors (webhook kiểu cũ) từ tháng 5/2026; HealthcareOS dùng **Workflows webhook**:

1. Trong Teams, mở kênh → **…** → **Workflows** → mẫu **"Post to a channel when a webhook request is received"** → chọn nhóm, kênh.
2. Sao chép URL, dán vào **Tích hợp → + Kết nối mới → Microsoft Teams**. Không dán URL vào chat hay email.
3. Bấm **Gửi thử**: kênh nhận thẻ "TEST · Kiểm tra kết nối".

Thẻ là Adaptive Card 1.4: dòng mức ưu tiên (màu theo P1/P2/P3), tiêu đề, chi tiết, bảng (Luật, Bộ phát hiện, Lúc), dòng "Không có dữ liệu bệnh nhân…", nút **Mở trong HealthcareOS** (cần `HCOS_PUBLIC_BASE_URL`). Tin hiện dưới tên bot Workflows; Microsoft không cho đổi tên hay ảnh bot.

Mỗi kết nối chọn: sự kiện Decision Engine (chỉ P1 / P1–P2 / P1–P3) và / hoặc sự cố hệ thống (engine chạy lỗi / một phần; kết nối khác tự tạm dừng).

## 4. CSDL — migration 015 (schema `integration`)

- `endpoints`: cấu hình, gồm URL / bí mật đã mã hoá; có version; không xoá cứng (retired).
- `endpoint_health`: số lỗi liên tiếp, lần tốt / lỗi gần nhất. Tách riêng để bộ giao **không đổi version cấu hình**.
- `endpoint_history`: chỉ thêm, ghi bằng trigger SECURITY DEFINER.
- `outbox`: chỉ thêm.
- `deliveries`: chỉ đổi cột trạng thái; xong rồi thì không đổi được nữa.
- `delivery_attempts`: chỉ thêm.
- `due_deliveries(p_now, p_limit)`: SECURITY DEFINER, chỉ trả khoá.
- RLS FORCE theo tenant, FK hỗn hợp (tenant, cơ sở).

## 5. API

| Route | Quyền |
|---|---|
| `GET /api/integrations/catalog` | đã đăng nhập |
| `GET /api/integrations/overview · endpoints · endpoints/:id/history · deliveries · deliveries/:id/attempts` | `integration:read` (quản lý PK, ban giám đốc, quản trị) |
| `POST /api/integrations/endpoints`, `POST /endpoints/:id` (+If-Match), `POST /endpoints/:id/status`, `POST /endpoints/:id/test`, `POST /deliveries/:id/retry` | `integration:manage` (quản lý PK, quản trị) |

Web: tab **Tích hợp** (kết nối, gửi thử, tạm dừng / bật lại, sửa URL, đổi bí mật, lịch sử cấu hình, lịch sử giao + chi tiết từng lần gửi + gửi lại); trang **`#/inbox`** (hộp thông báo toàn trang, đích của nút trên thẻ Teams).

## 6. Cấu hình

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `HCOS_INTEGRATION_KEY` | — (tắt) | `openssl rand -base64 32`. **Sao lưu riêng**; mất khoá ⇒ nhập lại URL. |
| `HCOS_PUBLIC_BASE_URL` | — | `https://smart.id.vn` |
| `HCOS_INTEGRATION_DISPATCH_SEC` | 15 | 0 = tắt |

## 7. Kiểm thử

- Hàm thuần (`integration-core`, 14): mã hoá / AAD / chống sửa bản mã, kiểm tra đích Teams / webhook / dải IP, thẻ Teams + thoát markdown + bỏ UUID, chữ ký HMAC, phân loại + lịch thử lại, cấu hình.
- Gửi HTTP thật tới server cục bộ (`transport`, 7): 202, 503 + Retry-After, không theo 302, cắt phản hồi lớn, hết giờ, không kết nối được, chặn `localhost` sau phân giải DNS.
- PostgreSQL (`integrations-pg`, 7):
  - Decision Engine → outbox → giao theo mức ưu tiên; không lộ PII; HMAC đúng;
  - version không đổi khi gửi;
  - thử lại theo lịch, 404 dừng ngay, gửi lại tay;
  - tự tạm dừng + báo qua kết nối khác, bật lại huỷ tin cũ;
  - gửi thử, sửa URL / đổi bí mật, xoá mềm;
  - chỉ-thêm + RLS; tắt khi thiếu khoá.
- HTTP (`integration-api`, 3).
- E2E trình duyệt (Teams giả lập + máy nhận webhook thật):
  - URL sai bị chặn; tạo Teams và gửi thử; tạo webhook, bí mật hiện một lần;
  - kênh lỗi báo "Lỗi phía nhận (500)";
  - Decision Engine P1 → Teams + webhook (kiểm chữ ký, không có dữ liệu bệnh nhân);
  - lịch sử giao, chi tiết lần gửi; tạm dừng / bật lại / xoá; bác sĩ không thấy tab; `#/inbox`.

**Chưa kiểm được trên Teams thật** (môi trường phát triển không ra Internet): cần bấm "Gửi thử" với URL Workflows thật trên staging.

## 8. Việc sau

Các kết nối tiếp theo dùng lại lõi này: Zalo ZNS / SMS nhắc lịch, hoá đơn điện tử, đơn thuốc quốc gia, xuất XML BHYT, nhận webhook vào (đối soát chuyển khoản), API key cho đối tác (scope, hạn dùng, giới hạn tần suất).
