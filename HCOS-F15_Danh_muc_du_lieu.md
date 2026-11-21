# HCOS-F15 — Danh mục dữ liệu & cấp độ rủi ro an ninh dữ liệu

## Bối cảnh pháp lý
- **Luật An ninh dữ liệu:** Quốc hội thông qua ngày 20/11/2026, có hiệu lực từ 01/7/2027.
  - Luật chia 5 cấp độ rủi ro. Cấp độ rủi ro là căn cứ áp dụng biện pháp bảo vệ, **không thay thế** việc phân loại dữ liệu cốt lõi / quan trọng theo Luật Dữ liệu.
  - Hệ thống xử lý nhiều cấp độ phải đáp ứng yêu cầu bảo vệ theo **cấp độ cao nhất phát sinh**.
  - Luật cấm cố ý xác định cấp độ thấp hơn quy định.
  - Khoản 2 Điều 27 (hệ thống đã vận hành trước ngày luật có hiệu lực) có mốc áp dụng riêng; cần đọc toàn văn.
- **Luật Bảo vệ dữ liệu cá nhân:** có hiệu lực từ 01/01/2026. Dữ liệu sức khoẻ là dữ liệu cá nhân nhạy cảm.
- Cấp độ do HealthcareOS **tính** chỉ là đề xuất kỹ thuật. Cấp độ chính thức do chủ quản xác định, có pháp chế xem xét khi có nghị định hướng dẫn tiêu chí.

## Thành phần
1. **Danh mục trong mã nguồn** (`packages/security/src/data-catalog.ts`).
   - Mỗi bảng có một nhãn gồm:
     - cấp độ 1–5;
     - nhóm dữ liệu: danh mục / vận hành / an ninh / cá nhân / cá nhân nhạy cảm / tài chính;
     - chủ thể dữ liệu;
     - **người chịu trách nhiệm** (data steward): quản lý phòng khám, quản lý kho dược hoặc quản trị hệ thống;
     - mục đích xử lý;
     - nhóm thời hạn lưu (thời hạn cụ thể gắn ở F17).
   - Cột nào khác bảng thì có nhãn riêng: cấp độ, nhóm, cách lưu (rõ / băm / mã hoá / dẫn xuất), ghi chú.
   - **Chủ quản dữ liệu** là cơ sở khám chữa bệnh (tenant). Nhà cung cấp phần mềm / hạ tầng là bên xử lý, không nhận chuyển giao trách nhiệm.
2. **Cổng CI** (`tests/integration/data-catalog-pg.integration.test.ts`, chạy trong job `integration-postgres` sau mọi migration). CI báo lỗi khi:
   - một bảng trong CSDL chưa có nhãn, hoặc danh mục có nhãn cho bảng / cột không tồn tại;
   - bảng chứa dữ liệu của người có cột mang tên gợi ý dữ liệu cá nhân hoặc nội dung tự do (`phone`, `email`, `note`, `payload`, …) mà chưa được gắn nhãn riêng;
   - một cột được gắn cấp cao hơn bảng của nó;
   - một bảng của ứng dụng không bật RLS FORCE mà role ứng dụng vẫn có quyền truy cập.
3. **Cấp độ hệ thống** bằng cấp cao nhất trong danh mục.
   - Danh mục hiện tại: **cấp 3** (dữ liệu sức khoẻ, danh tính, tài chính của người bệnh). Không có bảng cấp 4 hoặc 5.
   - **Phiên bản danh mục** là SHA-256 của nội dung danh mục; sửa bất kỳ nhãn nào thì phiên bản đổi.
4. **Hồ sơ tự đánh giá** (migration 018, bảng `governance.risk_assessments`, chỉ ghi thêm, RLS FORCE).
   - Quản trị hệ thống ghi nhận cấp độ xác định kèm căn cứ.
   - CSDL lưu cùng lúc: cấp tính được, phiên bản danh mục và quy mô dữ liệu tại thời điểm đó.
   - Cấp xác định **không được thấp hơn** cấp tính được; cả service lẫn ràng buộc CHECK của CSDL đều chặn.
   - Khi danh mục đổi phiên bản, hệ thống báo "cần đánh giá lại".
5. **Màn hình "Quản trị dữ liệu"** (quản lý phòng khám, quản lý kho dược, ban giám đốc, quản trị):
   - cấp độ hệ thống;
   - quy mô dữ liệu, chỉ đếm dữ liệu của chủ quản đó;
   - danh sách cột nhạy cảm còn lưu dạng rõ (đầu vào cho F16);
   - danh mục có lọc và tìm, xem nhãn từng cột;
   - lịch sử hồ sơ tự đánh giá;
   - nút **tải hồ sơ tự đánh giá (.md)**.

## API
- `GET /api/governance/catalog`, `GET /api/governance/assessments`, `GET /api/governance/dossier` (`governance:read`).
- `POST /api/governance/assessments { declaredLevel, rationale }` (`governance:assess`, chỉ quản trị hệ thống).
  - Lỗi `422 DECLARED_BELOW_COMPUTED`: cấp xác định thấp hơn cấp tính được.
  - Lỗi `422 RATIONALE_REQUIRED`: thiếu căn cứ.

## Thêm bảng / cột mới
Viết migration, rồi thêm nhãn vào `DATA_CATALOG` **trong cùng PR**. Nếu thiếu, job `integration-postgres` báo lỗi và chỉ rõ bảng / cột cần gắn nhãn. Sau khi merge, quản trị hệ thống ghi nhận lại cấp độ, vì phiên bản danh mục đã đổi.

## Kế tiếp
- **F16:** mã hoá theo trường 33 cột nhạy cảm còn lưu dạng rõ (SĐT, CCCD, họ tên, ghi chú lâm sàng…), dùng chỉ mục băm để tìm kiếm, khoá riêng từng tenant, có xoay khoá.
- **F17:** thời hạn lưu trữ cho từng nhóm và cơ chế xoá: huỷ khoá mã hoá (crypto-shredding) hoặc ẩn danh, vẫn giữ chuỗi kiểm toán.
- **F18:** sổ nhà cung cấp (GCS backup, Microsoft Teams, VM), sổ nguồn dữ liệu AI, nhật ký xuất dữ liệu, đầu ra cho kiểm toán viên.
