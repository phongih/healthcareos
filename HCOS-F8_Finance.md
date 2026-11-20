# HCOS-F8 — Thu ngân giai đoạn 1

Nối tiếp HCOS-F7. Migration mới: **012_finance.sql** (schema `finance`).

Phạm vi đã chốt với chủ sản phẩm: phòng khám dịch vụ, người bệnh **tự trả tiền**. Có **bảng giá dịch vụ**, **phiếu thu tạm ứng / thanh toán**, **phiếu chi hoàn ứng**, **ca thu ngân có kiểm két**. Hình thức: **tiền mặt, chuyển khoản VietQR (xác nhận thủ công), thẻ POS**. **Lễ tân kiêm thu ngân**. Tạm ứng ở bước check-in là **tuỳ chọn, mặc định 500.000đ** (quản lý cài). **Chưa** có BHYT và **hoá đơn điện tử**.

**Kiểm chứng trên sandbox:**
- tsc strict sạch. Suite mới: integration `finance-pg` (10 ca), HTTP `finance-api` (4), web `money-vietqr` (5: số thành chữ, CRC-16 theo vector chuẩn, chuỗi EMVCo).
- E2E Playwright: quản lý cài đặt + bảng giá → lễ tân mở ca → check-in lịch hẹn kèm tạm ứng 500k → thêm / gỡ chi phí → hoàn ứng 170k → đóng hồ sơ → tạm ứng chuyển khoản (VietQR giải mã đúng bằng OpenCV) → huỷ phiếu → đóng ca khớp két → quản lý xem báo cáo. E2E đặt lịch và hàng đợi cũ vẫn đạt.
- Seed thực tập chạy 2 lần: lần 2 bỏ qua toàn bộ.
- Kết quả chính thức là CI trên PR.

## 1. Luồng
1. **Quản lý** (clinic_admin / tenant_admin), tab **Thu ngân → Cài đặt**: tạm ứng mặc định, tài khoản nhận chuyển khoản (BIN ngân hàng, số tài khoản, tên chủ tài khoản không dấu), bảng giá (mã, tên, nhóm, đơn giá; ngừng / dùng lại).
2. **Lễ tân / thu ngân** mở **ca** (tiền đầu ca). Không có ca thì không lập phiếu được.
3. **Check-in lịch hẹn**: đánh dấu "Thu tạm ứng" → chọn hình thức → bấm một lần: cấp số **và** lập phiếu thu. Phiếu thu là giao dịch riêng: nếu lỗi (vd. chưa mở ca) thì số vẫn được cấp, có nút **Thu lại tạm ứng** (cùng Idempotency-Key, không thu hai lần).
4. **Hồ sơ thanh toán** (một lượt đến): mở theo MRN hoặc từ danh sách "Đang mở".
   - Thêm chi phí từ bảng giá (đơn giá **chụp lại** lúc ghi); gỡ chi phí cần lý do.
   - Số dư = đã thu − đã hoàn − chi phí. Màn hình gợi ý loại phiếu và số tiền: còn phải thu → **Thanh toán**; còn dư → **Hoàn ứng**.
   - Chuyển khoản: hiện **VietQR** có sẵn số tiền + nội dung `HCOS <MRN> <loại>`; thu ngân xác nhận sau khi thấy tiền về. Thẻ: bắt buộc mã chuẩn chi POS.
   - In **phiếu thu / phiếu chi** (số tiền bằng chữ, chữ ký người nộp / thu ngân). In lại được.
   - **Đóng hồ sơ** khi số dư = 0.
5. **Đóng ca**: nhập tiền mặt đếm được → hệ thống báo phải có, khớp / thừa / thiếu.
6. **Báo cáo ca** (quản lý, ban giám đốc): các ca trong ngày, chênh lệch két, danh sách phiếu từng ca.

## 2. Quyền
| Hành động | Vai trò |
|---|---|
| `finance:collect` — ca, chi phí, lập / huỷ phiếu, đóng hồ sơ | clinic_staff, cashier, clinic_admin |
| `finance:read` — xem hồ sơ, bảng giá | + executive |
| `finance:manage` — bảng giá, cài đặt | clinic_admin, tenant_admin |
| Xem ca của **người khác** | clinic_admin, executive, tenant_admin |

Thu ngân chỉ đóng ca và huỷ phiếu **của chính mình**. Access policy (chỉ thu hẹp) không có `finance:*` thì không thu được — vd. điều dưỡng thực tập.

## 3. Toàn vẹn tiền ở tầng DB (migration 012)
- Tiền là **số nguyên VND** (`bigint`). Phiếu > 0. Chi phí = số lượng × đơn giá chụp lại.
- **Phiếu và chi phí bất biến**; chỉ huỷ / gỡ **một lần**, kèm lý do, khi hồ sơ còn mở; phiếu chỉ huỷ khi **ca của nó còn mở**.
- Phiếu chỉ lập trong **ca đang mở của chính người lập**, cùng cơ sở; hồ sơ phải đang mở (khoá `FOR SHARE` chống đóng đồng thời).
- **Số phiếu liên tục** `PT2026-000123` (thu) / `PC2026-000045` (chi) theo cơ sở + năm (giờ VN), cấp nguyên tử; phiếu huỷ vẫn giữ số — không có lỗ (integration: 5 phiếu đồng thời → 4..8).
- Một bệnh nhân một hồ sơ đang mở mỗi cơ sở. **Tổng hoàn ≤ tổng đã thu**; **đóng hồ sơ chỉ khi số dư = 0** — ràng buộc hoãn, kiểm ở cuối transaction.
- **Đóng ca: DB tự tính** tiền mặt phải có = đầu ca + thu tiền mặt − chi tiền mặt (phiếu hợp lệ của ca); chênh lệch là cột sinh tự động; app không ghi được số này. Ca đã đóng bất biến.
- Lập phiếu bắt buộc **Idempotency-Key** (bảng 008): gửi lại sau timeout trả đúng phiếu cũ.
- RLS FORCE; không DELETE / TRUNCATE. Mọi thao tác có audit (số phiếu, số tiền; không có dữ liệu y tế).

## 4. API
| Method | Đường dẫn |
|---|---|
| GET / POST | `/api/finance/settings` (POST + If-Match; `W/"0"` lần đầu) |
| GET / POST | `/api/finance/price-items`; POST `/api/finance/price-items/:id` + If-Match |
| GET | `/api/finance/shifts/mine?organization=`, `/api/finance/shifts?organization=&from=&to=`, `/api/finance/shifts/:id` |
| POST | `/api/finance/shifts` `{ organizationId, openingFloat }`; `/api/finance/shifts/:id/close` `{ countedCash, note? }` + If-Match |
| GET / POST | `/api/finance/cases` (POST = hồ sơ đang mở của bệnh nhân, chưa có thì mở); GET `/api/finance/cases/:id` |
| POST | `/api/finance/cases/:id/charges` `{ itemId, quantity }`; `/api/finance/charges/:id/void` `{ reason }`; `/api/finance/cases/:id/close` + If-Match |
| POST | `/api/finance/receipts` `{ organizationId, caseId \| patientId, kind, method, amount, reference?, payerName? }` + **Idempotency-Key**; `/api/finance/receipts/:id/cancel` `{ reason }` |

Lý do lỗi nghiệp vụ ở `issue[0].details.text`: `NO_OPEN_SHIFT`, `SHIFT_ALREADY_OPEN`, `SHIFT_NOT_OPEN`, `NOT_SHIFT_OWNER`, `PAYMENT_EXCEEDS_DUE`, `REFUND_EXCEEDS_CREDIT`, `REFERENCE_REQUIRED`, `BALANCE_NOT_ZERO`, `CASE_NOT_OPEN`, `PRICE_CODE_TAKEN`, `IDEMPOTENCY_KEY_REUSED`, `REPORT_ROLE`.

## 5. Pháp lý / kế toán (cần rà soát trước khi dùng thật)
- Phiếu ở đây là **phiếu thu / chi nội bộ**, **không thay thế hoá đơn**. Phòng khám kinh doanh dịch vụ phải xuất **hoá đơn điện tử** theo quy định hiện hành (NĐ 123/2020/NĐ-CP và các văn bản sửa đổi) — giai đoạn sau sẽ nối nhà cung cấp hoá đơn điện tử, lấy dữ liệu từ hồ sơ thanh toán đã đóng.
- Mẫu phiếu thu / chi, cách đánh số, thời gian lưu trữ chứng từ: cần kế toán xác nhận theo chế độ kế toán doanh nghiệp đang áp dụng.
- VietQR: chuỗi theo chuẩn EMVCo của NAPAS; **chưa nối API ngân hàng** để tự xác nhận tiền về — thu ngân phải kiểm tra thủ công. Không ghi số tài khoản giả vào hệ thống.
- Bảng giá dịch vụ phải niêm yết công khai theo quy định về giá khám chữa bệnh; giá trong seed thực tập là **giả**.

## 6. Chưa làm / hướng tiếp
- Hoá đơn điện tử (qua nhà cung cấp), BHYT (XML 130/4750).
- Tự sinh chi phí từ nghiệp vụ: phí khám khi bắt đầu khám, thuốc theo đơn đã cấp, chỉ định cận lâm sàng.
- Đối soát chuyển khoản tự động (webhook ngân hàng / cổng thanh toán), máy POS tích hợp.
- Miễn giảm / chiết khấu có phê duyệt; công nợ; nộp tiền ca về quỹ / ngân hàng; báo cáo doanh thu theo dịch vụ, theo ngày.
- In phiếu khổ K80 cho máy in nhiệt.
