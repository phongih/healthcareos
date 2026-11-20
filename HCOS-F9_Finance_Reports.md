# HCOS-F9 — Báo cáo tài chính

Nối tiếp HCOS-F8. **Không có migration** (chỉ đọc dữ liệu `finance.*`).

Đã chốt với chủ sản phẩm: tính **cả hai, tách rõ** — thực thu và doanh thu dịch vụ. Báo cáo gồm: tổng hợp theo ngày / khoảng ngày, theo dịch vụ và nhóm, tạm ứng còn giữ và công nợ, theo thu ngân, phiếu huỷ và chi phí gỡ. Có **xuất Excel (.xlsx)**.

**Kiểm chứng trên sandbox:**
- tsc sạch. Integration `finance-pg` thêm 1 ca báo cáo (số liệu từng mục khớp dữ liệu test, khoảng ngày sai bị chặn, quyền); HTTP `finance-api` thêm route; web `xlsx` (4: CRC-32 theo vector chuẩn, cấu trúc ZIP, escape XML, 6 sheet báo cáo).
- File .xlsx mở lại bằng openpyxl: đúng tên sheet, số là ô số (định dạng `#,##0`), dòng đầu cột cố định.
- E2E: sau luồng thu ngân, quản lý mở tab **Báo cáo** → các ô số khớp (thực thu ròng 330k, tạm ứng 500k, hoàn 170k, doanh thu dịch vụ 330k) → **Xuất Excel** tải được file, đọc lại đúng số; lễ tân và bác sĩ không thấy tab.

## 1. Định nghĩa số liệu
| Mục | Cách tính |
|---|---|
| **Thực thu** | Phiếu **hợp lệ** lập trong kỳ: tạm ứng + thanh toán − hoàn ứng; tách tiền mặt / chuyển khoản / thẻ; theo từng ngày. Phiếu đã huỷ không tính. |
| **Doanh thu dịch vụ** | Chi phí **còn hiệu lực** ghi trong kỳ, theo **đơn giá tại lúc ghi**; theo dịch vụ (số lượng, số hồ sơ, tỷ trọng) và theo nhóm. Dòng đã gỡ không tính. |
| **Tạm ứng còn giữ / Còn phải thu** | Hồ sơ **đang mở tại lúc lập báo cáo** (không theo kỳ): tổng số dư dương / tổng số dư âm. |
| **Theo thu ngân** | Phiếu lập trong kỳ: số phiếu, thu, chi, phiếu huỷ (số, tiền), chi phí đã gỡ, số ca (mở trong kỳ), ca chưa đóng, tổng chênh lệch két. |
| **Kiểm soát** | Phiếu **huỷ** và chi phí **gỡ** trong kỳ (theo thời điểm huỷ / gỡ): ai lập, ai huỷ, lúc nào, lý do. |

- **Tạm ứng là tiền giữ hộ người bệnh, chưa phải doanh thu.** Doanh thu ghi nhận theo dịch vụ đã ghi; thực thu là dòng tiền qua két.
- Ngày tính theo **giờ Việt Nam**; kỳ tối đa **92 ngày**; số liệu là ảnh chụp tại lúc lập (phiếu huỷ sau đó sẽ làm số kỳ cũ thay đổi khi xem lại).

## 2. Quyền
Chỉ **quản lý phòng khám, ban giám đốc, quản trị hệ thống** (`finance:read` / `finance:manage` + vai trò báo cáo). Lễ tân / thu ngân chỉ xem ca của mình ở tab Thu ngân. Mỗi lần xem báo cáo ghi audit (`finance.report`, kỳ báo cáo).

## 3. API và web
- `GET /api/finance/reports?organization=&from=YYYY-MM-DD&to=YYYY-MM-DD` (mặc định hôm nay).
- Tab **Báo cáo**: chọn nhanh Hôm nay / Hôm qua / 7 ngày / Tháng này / Tháng trước hoặc khoảng ngày tuỳ ý; ô tổng; biểu đồ cột thực thu ròng theo ngày; các bảng chi tiết; **Xuất Excel**.
- Excel tạo **ngay trong trình duyệt** (`apps/web/src/lib/xlsx.ts`, không thư viện ngoài, không gửi dữ liệu đi đâu), 6 sheet: Tổng hợp, Thực thu theo ngày, Theo dịch vụ, Tạm ứng & công nợ, Theo thu ngân, Phiếu huỷ & chi phí gỡ.

## 4. Lưu ý
- File Excel chứa **tên và MRN bệnh nhân** (sheet công nợ, kiểm soát): là dữ liệu cá nhân — lưu và gửi theo quy định bảo vệ dữ liệu của phòng khám.
- Đây là báo cáo quản trị, **không phải báo cáo kế toán / thuế** (chưa có hoá đơn điện tử, chưa theo mẫu sổ sách kế toán).

## 5. Hướng tiếp
Báo cáo theo bác sĩ chỉ định (khi có tự sinh chi phí từ nghiệp vụ), so sánh cùng kỳ, lịch gửi báo cáo tự động, đối chiếu với sao kê ngân hàng.
