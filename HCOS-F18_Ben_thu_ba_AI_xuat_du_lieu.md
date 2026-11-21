# HCOS-F18 — Bên thứ ba, nguồn dữ liệu AI, xuất dữ liệu

F18 thực hiện ba nguyên tắc: **Vendor / Third-party Accountability**, **AI Data Integrity** và **Evidence-based Governance** (có bằng chứng cho dữ liệu đã ra khỏi hệ thống).

## 1. Sổ nhà cung cấp
Tab **Quản trị dữ liệu → Nhà cung cấp / bên thứ ba**. Quyền xem: quản lý phòng khám, ban giám đốc, quản trị. Quyền ghi: quản trị hệ thống.

- **Thông tin nhà cung cấp:**
  - loại: hạ tầng đám mây / sao lưu, nhắn tin, đối tác webhook, **dịch vụ AI**, phần mềm, khác;
  - vai trò: bên xử lý, bên xử lý phụ, bên thứ ba;
  - dịch vụ cung cấp, đầu mối liên hệ;
  - trạng thái: hoạt động / tạm ngừng / chấm dứt. Chấm dứt thì không bật lại được.
- **Đánh giá** (chỉ-thêm), gồm:
  - kết luận duyệt / từ chối;
  - **số thoả thuận xử lý dữ liệu** (bắt buộc khi duyệt);
  - nơi lưu / xử lý, có chuyển ra nước ngoài không;
  - **loại dữ liệu được nhận**:

    | Loại | Ý nghĩa |
    |---|---|
    | `operational` | Vận hành, không định danh |
    | `backup_encrypted` | Bản sao lưu đã mã hoá, nhà cung cấp không có khoá |
    | `personal` | Dữ liệu cá nhân cơ bản |
    | `health` | Dữ liệu sức khoẻ |
  - biện pháp bảo vệ đã kiểm tra, căn cứ;
  - hiệu lực **tối đa 3 năm** (CSDL chặn), nên phải đánh giá lại định kỳ.
- **Thu hồi** = ghi một đánh giá "Từ chối" mới. Đánh giá **mới nhất** quyết định.
- **Dịch vụ AI không bao giờ được duyệt nhận dữ liệu cá nhân / sức khoẻ.** Service chặn, trigger CSDL cũng chặn.
- **Trạng thái hiển thị:** Đã duyệt · Sắp hết hạn (≤ 30 ngày) · Hết hạn / Bị từ chối / Chưa đánh giá / Tạm ngừng — các trạng thái này đều **chặn gửi**.
- Chủ quản dữ liệu vẫn chịu trách nhiệm. Sổ là bằng chứng đã đánh giá, không chuyển giao trách nhiệm.

### Ràng buộc với kết nối ngoài (F12)
- Mỗi kết nối **phải gắn một nhà cung cấp**.
- Sự kiện chỉ được xếp hàng và gửi khi `governance.vendor_cleared(vendor, 'operational')` đúng, tức là cả ba điều kiện:
  - nhà cung cấp đang hoạt động;
  - đánh giá mới nhất là "Duyệt" và đang trong hiệu lực (theo ngày giờ Việt Nam);
  - đánh giá cho phép dữ liệu vận hành.
- CSDL kiểm tra **cả lúc xếp hàng và lúc gửi**. Nếu đánh giá hết hạn hoặc bị thu hồi sau khi đã xếp hàng, lượt giao bị đánh dấu `VENDOR_NOT_CLEARED` và không gửi. Lỗi này không tính vào bộ đếm tự tạm dừng, vì không phải lỗi của kết nối.
- "Gửi thử" và "Bật lại" bị từ chối khi nhà cung cấp chưa được duyệt.
- Kết nối tạo trước F18 (chưa gắn nhà cung cấp) **bị chặn gửi** cho tới khi bấm "Sửa" và chọn nhà cung cấp đã được duyệt.

## 2. Xuất dữ liệu qua máy chủ + nhật ký xuất
Mọi file ra khỏi hệ thống đều do **máy chủ** tạo qua `POST /api/exports`. Trình duyệt chỉ nhận file và lưu xuống.

| Bộ dữ liệu | File | Dữ liệu cá nhân |
|---|---|---|
| `finance_report` | Excel báo cáo tài chính | Có khi còn công nợ (danh sách có họ tên người bệnh) |
| `governance_dossier` | Hồ sơ tự đánh giá (Markdown) | Không |
| `erasure_letter` | Văn bản trả lời yêu cầu xoá (Markdown) | Có (mã bệnh nhân) |

- **Quyền:** do service nguồn kiểm tra (báo cáo tài chính, quản trị dữ liệu, yêu cầu xoá). Xuất không mở rộng quyền.
- **Mục đích:** file có dữ liệu cá nhân bắt buộc ghi mục đích (5–300 ký tự). Thiếu mục đích thì máy chủ trả `PURPOSE_REQUIRED`, trình duyệt hỏi rồi gửi lại. CSDL cũng chặn bằng CHECK.
- **Dấu nhận diện trong file:** người xuất, thời điểm, mã xuất, nhắc chỉ dùng đúng mục đích. Với Excel, mỗi sheet có thêm dòng này và có sheet "Thông tin xuất".
- **Nhật ký** (`governance.data_exports`, chỉ-thêm):
  - ai xuất, cơ sở, bộ dữ liệu, bộ lọc;
  - số dòng, có dữ liệu cá nhân, mục đích;
  - tên file, kích thước, **SHA-256**.

  **Không lưu nội dung file.**
- **Tra cứu một file trôi nổi:** tính `sha256sum tên-file` rồi tra ở thẻ "Nhật ký xuất dữ liệu". Kết quả cho biết ai xuất, khi nào, để làm gì.
- Đã **gỡ** hai đường tải trực tiếp (`GET /api/governance/dossier` và `GET /api/erasure-requests/:id/letter`) để không còn đường bỏ qua nhật ký.
- **Ngoài phạm vi:** xem trên màn hình rồi chụp ảnh / sao chép thủ công. Rủi ro này được giảm bằng quyền xem, che dữ liệu (F16) và dấu người xuất.

## 3. Sổ nguồn dữ liệu AI
Sổ nằm ở `packages/security/src/ai-registry.ts` và hiện ở thẻ **Nguồn dữ liệu AI** cùng mục 8 của hồ sơ tự đánh giá.

| Thành phần | Chạy tại | Kiểm định |
|---|---|---|
| Danh mục ICD-10 rút gọn | trình duyệt | **Chưa kiểm định** (chưa đối chiếu QĐ 4469/QĐ-BYT) |
| Tìm kiếm mờ + từ điển viết tắt | trình duyệt | Đã rà soát nội bộ |
| Chuẩn hoá triệu chứng | trình duyệt | **Chưa kiểm định** lâm sàng |
| Decision Engine (bộ phát hiện + thống kê) | máy chủ | Đã rà soát nội bộ |

- **Mỗi thẻ ghi:**
  - nguồn, phiên bản, **SHA-256** của đúng các file;
  - người chịu trách nhiệm;
  - trạng thái và ghi chú kiểm định;
  - mục đích được phép / bị cấm, ghi chú thay đổi.
- **Khoá phiên bản:** `tests/security/ai-registry.test.ts` tính lại SHA-256. Sửa dữ liệu / luật AI mà không cập nhật thẻ (phiên bản, SHA-256, ghi chú) thì **CI đỏ**. Thay đổi AI vì thế luôn đi qua PR có người duyệt. Mọi file trong `apps/web/src/lib/ai/*.ts` đều phải có thẻ.
- **Không gửi dữ liệu người bệnh ra AI bên ngoài.** Test kiểm tra cả ba điểm:
  - CSP `connect-src 'self'`: trình duyệt chỉ kết nối tới máy chủ;
  - mã web không gọi URL tuyệt đối;
  - phía máy chủ chỉ có hai file được ra ngoài: bộ giao tích hợp (F12, đã chặn theo nhà cung cấp) và tải khoá JWKS của IdP.
- **Giao diện** ghi rõ "gợi ý — chưa kiểm định" ở ô tìm mã ICD-10 và ô chuẩn hoá triệu chứng.

## 4. API
| Phương thức | Đường dẫn | Quyền |
|---|---|---|
| GET / POST | `/api/vendors` | `vendor:read` / `vendor:manage` |
| GET / POST | `/api/vendors/:id/assessments` | `vendor:read` / `vendor:manage` |
| POST | `/api/vendors/:id/status` `{status, note?, version}` | `vendor:manage` |
| POST | `/api/integrations/endpoints[/:id]` (thêm `vendorId`) | `integration:manage` |
| POST | `/api/exports` `{dataset, params?, purpose?}` | theo bộ dữ liệu |
| GET | `/api/exports?sha256=` | `export:audit` |

## 5. CSDL — migration 021
- Bảng `governance.vendors`, `governance.vendor_assessments` (chỉ-thêm), `governance.data_exports` (chỉ-thêm). Tất cả bật RLS FORCE.
- Hàm `governance.vendor_cleared(vendor, category)`.
- Cột `integration.endpoints.vendor_id` và `endpoint_history.vendor_id`.

## 6. Triển khai lên staging
1. Làm các bước như mọi đợt: `git pull`, sao lưu, **áp migration 021**, build, tạo lại container `api`, chạy `setup-training.sh`.
2. **Kết nối Teams "Nexus" sẽ ngừng gửi ngay sau deploy** vì chưa gắn nhà cung cấp. Để gửi lại, `tt.quanly1` (quản trị hệ thống) làm:
   1. Vào Quản trị dữ liệu → Nhà cung cấp → "+ Nhà cung cấp": Microsoft (Teams Workflows), loại "Nhắn tin", vai trò "Bên xử lý".
   2. Bấm "Đánh giá" và điền:
      - số hợp đồng / phụ lục DPA thật của tổ chức;
      - nơi lưu, có chuyển ra nước ngoài;
      - loại dữ liệu "Vận hành";
      - biện pháp bảo vệ, căn cứ, hiệu lực.
   3. Vào Tích hợp → "Nexus" → Sửa → chọn nhà cung cấp → Lưu → Gửi thử.
3. Nên đăng ký thêm các nhà cung cấp không gắn kết nối nào, để sổ đầy đủ: Google Cloud (VM + bucket sao lưu, loại `backup_encrypted`), nhà đăng ký tên miền / DNS…
4. Ghi nhận lại cấp độ ở thẻ "Hồ sơ tự đánh giá" (danh mục dữ liệu đổi phiên bản, thêm 3 bảng).

## 7. Kiểm thử
- `tests/integration/f18-pg.integration.test.ts` (3 bài) kiểm tra:
  - quyền, bắt buộc DPA, hiệu lực ≤ 3 năm;
  - thu hồi, tạm ngừng / chấm dứt, đánh giá chỉ-thêm, tách tenant;
  - AI không nhận dữ liệu cá nhân (service + CSDL);
  - xuất: quyền theo nguồn, bắt buộc mục đích (service + CSDL), dấu trong file, SHA-256 khớp file, tra theo SHA-256, nhật ký không chứa họ tên.
- `tests/integration/integrations-pg.integration.test.ts` có thêm bài: thu hồi đánh giá thì lượt đã xếp hàng không gửi, không tính lỗi kết nối, không xếp hàng mới, không gửi thử / bật lại được.
- `tests/security/ai-registry.test.ts` kiểm tra khoá SHA-256 và các đường ra ngoài.
- E2E devstack:
  - kết nối bị chặn khi chưa có nhà cung cấp → đăng ký + đánh giá (thiếu DPA thì báo lỗi) → gắn vào kết nối thì hết chặn;
  - với dịch vụ AI, ô dữ liệu sức khoẻ bị khoá;
  - xuất Excel (hỏi mục đích vì có công nợ) và hồ sơ (có mục 7, 8);
  - tra SHA-256 ra đúng một dòng;
  - route tải trực tiếp cũ đã bị gỡ.
