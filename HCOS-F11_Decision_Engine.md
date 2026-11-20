# HCOS-F11 — Decision Engine có kiểm soát + Native AI cục bộ

Mục tiêu: hệ thống tự quan sát dữ liệu vận hành và **báo đúng người, đúng lúc**, nhưng **không tự quyết thay con người** và **không làm bẩn dữ liệu**.

## 1. Nguyên tắc an toàn (chốt với chủ dự án)

| Nguyên tắc | Cách bảo đảm |
|---|---|
| Engine chỉ **ghi nhật ký + thông báo + gợi ý** | Hành động là danh mục đóng (`log_only`, `notify_<vai trò>`, `suggest`), kiểm ở service **và** CHECK ở CSDL. Service không có câu lệnh ghi nào ngoài schema `decision`. Test tích hợp so "dấu vân tay" 16 bảng lâm sàng / tài chính / kho trước và sau khi chạy engine và khi áp dụng gợi ý. |
| Gợi ý do **người** áp dụng | Nút "Áp dụng" chỉ mở màn hình nghiệp vụ (`#/encounters/…`, `#/finance/shifts/…`, `#/forecast`…) và ghi nhận đã áp dụng; thay đổi thật do người dùng làm, bằng quyền của chính họ. |
| Dữ liệu không rời máy | Không dùng AI đám mây. Phát hiện bất thường = thống kê giải thích được trên máy chủ của mình. Tìm ICD-10 / thuốc và chuẩn hoá triệu chứng chạy **trong trình duyệt**. |
| Sự kiện không chứa định danh bệnh nhân | Tiêu đề / chi tiết chỉ có chỉ số và liên kết; xem bệnh nhân phải mở hồ sơ qua kiểm soát truy cập thường (có audit). Test kiểm tra không lộ tên / MRN. |
| Báo đúng vai trò | Mỗi bộ phát hiện có danh sách vai trò được nhận (vd. sinh hiệu không gửi thu ngân, lệch quỹ không gửi dược). Hộp thư lọc theo vai trò của người gọi tại cơ sở; thông báo của vai trò khác trả 404. |
| Truy vết đầy đủ | `events`, `action_log`, `job_runs`, `rule_versions` **chỉ thêm** (trigger chặn UPDATE / DELETE / TRUNCATE). Luật không xoá cứng ("Xoá" = retired). Sự kiện lưu phiên bản luật lúc phát. Mọi thao tác quản lý / người dùng vào chuỗi audit hash. |

## 2. Mô hình Observe → Detect → Decide → Act

- **Observe — 11 bộ phát hiện** (`services/api/src/decision/catalog.ts`). Mỗi bộ chỉ ĐỌC và trả "ứng viên" gồm chỉ số + khoá đối tượng:

| Bộ | Nhóm | Chỉ số chính | Nguồn |
|---|---|---|---|
| `vital_abnormal` | Lâm sàng | spo2_pct, temperature_c, pulse_bpm, systolic/diastolic_mmhg | kết quả đo mới nhất (24 giờ) của đợt khám đang mở; bỏ kết quả đã bị thay thế |
| `icd_spike` | Lâm sàng | last7_count, ratio, poisson_z | ICD-10 7 ngày so với 21 ngày trước |
| `room_overload` | Vận hành | utilization_pct, forecast_visits, days_ahead | dùng chung công thức dự báo tải F10 |
| `booking_no_show` | Vận hành | no_show_pct, baseline_pct, robust_z | lịch hẹn 7 ngày so với 8 tuần |
| `visit_volume` | Vận hành | visits, baseline_median, robust_z | lượt khám hôm qua so với cùng thứ 8 tuần |
| `stock_low` | Dược | below_reorder_point, days_of_cover | ROP của F10 |
| `stock_expiry` | Dược | days_to_expiry, expiry_risk_qty | FEFO của F10 |
| `rx_not_dispensed` | Dược | age_hours, undispensed_items | đơn còn hiệu lực chưa phát đủ |
| `cash_difference` | Tài chính | abs_difference_vnd | ca đã đóng 7 ngày |
| `receipt_cancellations` | Tài chính | cancel_count, cancel_pct, robust_z | phiếu huỷ theo người lập 7 ngày |
| `deposit_aging` | Tài chính | age_days, held_vnd | hồ sơ thanh toán mở đang giữ tiền |

- **Detect** — điều kiện AND (1–5 điều kiện, phép `< <= > >= = !=`); thiếu chỉ số ⇒ không khớp (fail-closed).
- **Decide** — ưu tiên P1–P3; **cooldown theo (luật, đối tượng)**; tối đa 50 sự kiện / luật / lần chạy.
- **Act** — sự kiện + nhật ký hành động + thông báo theo vai trò (+ gợi ý).

Chạy: bộ lập lịch trong tiến trình API mỗi `HCOS_DECISION_INTERVAL_SEC` giây (mặc định 300; `0` = tắt), bằng tài khoản hệ thống `system:decision-engine`; hoặc quản lý bấm "Chạy ngay". Mỗi cơ sở giữ advisory lock nên hai lần chạy không chồng nhau; mỗi bộ phát hiện chạy trong SAVEPOINT, một bộ lỗi không làm hỏng cả lần chạy (trạng thái "Một phần"). Lần chạy theo lịch chỉ ghi audit khi có sự kiện hoặc lỗi.

"Thử luật" chạy bộ phát hiện + điều kiện trên dữ liệu hiện tại và cho biết bao nhiêu đối tượng khớp / đang trong cooldown — **không ghi gì**.

## 3. Native AI cục bộ (web)

- `apps/web/src/lib/ai/fuzzy.ts` — tìm kiếm mờ tiếng Việt: bỏ dấu, sai chính tả 1–2 ký tự (Damerau–Levenshtein), chữ đầu ("tha"), từ điển viết tắt y khoa / thuốc ("sxh", "nkhht", "pcm", "amox"), mã ("j069"). Mỗi kết quả có lý do khớp.
- `icd10.ts` — **danh mục rút gọn** khoảng 200 mã ngoại trú thường gặp, kèm tên thường gọi. Cần đối chiếu với danh mục ICD-10 của Bộ Y tế (QĐ 4469/QĐ-BYT) trước khi dùng cho báo cáo / BHYT; ô nhập mã vẫn nhận mọi mã hợp lệ.
- `symptoms.ts` — chuẩn hoá triệu chứng từ ghi chú tự do: 39 khái niệm, thời gian ("3 ngày"), nhiệt độ, phủ định ("ko khó thở"), dấu hiệu cần chú ý (khó thở, đau ngực, ngất, co giật, sốt ≥ 39,5 °C), gợi ý mã. Ghi chú **không lưu**, không gửi đi.
- Gắn vào: ô "Tìm mã ICD-10" + "Ghi nhanh triệu chứng" ở màn đợt khám; ô "Tìm thuốc" ở mỗi dòng kê đơn.

Phía máy chủ (`decision/stats.ts`): robust z-score (trung vị / MAD, có dự phòng khi MAD = 0), z Poisson cho dữ liệu đếm.

## 4. CSDL — migration 014 (schema `decision`)

`rules` (+ `rule_versions` do trigger SECURITY DEFINER ghi), `job_runs`, `events`, `action_log`, `notifications` (chỉ đổi được cột trạng thái xử lý), hàm `due_organizations()` cho bộ lập lịch. RLS FORCE theo tenant, FK hỗn hợp (tenant, cơ sở), không xoá.

## 5. API

| Route | Quyền |
|---|---|
| `GET /api/decision/catalog` | đã đăng nhập |
| `GET /api/decision/overview · rules · rules/:id/versions · events · actions · runs` | `decision:read` (quản lý PK, ban giám đốc, quản trị) |
| `POST /api/decision/rules`, `POST /rules/:id` (+If-Match), `POST /rules/:id/status`, `POST /preview`, `POST /run` | `decision:manage` (quản lý PK, quản trị) |
| `GET /api/notifications?organization=&all=1`, `POST /api/notifications/:id` `{action: handle·apply·dismiss·reopen}` (+If-Match) | `notification:read` (mọi vai trò nhân viên) |

## 6. Seed đào tạo

13 luật mẫu (11 bật, 2 tạm dừng), chạy engine một lần. Chạy lại seed không tạo trùng (CI kiểm nhãn "luật Decision Engine").

## 7. Kiểm thử

- Tích hợp PostgreSQL (`decision-pg`, 8): danh mục / quyền, thử luật, mọi bộ phát hiện chạy trên CSDL thật, chạy + không đổi dữ liệu nghiệp vụ + không lộ tên, cooldown, hộp thư theo vai trò + áp dụng / bỏ qua / mở lại, tạm dừng / sửa / xoá mềm + lịch sử phiên bản, chỉ-thêm ở tầng CSDL + RLS, khoá chạy song song + bộ lập lịch.
- HTTP (`decision-api`, 3); hàm thuần (`decision-rules`, 8); Native AI (`native-ai`, 10).
- E2E trình duyệt: quản lý tạo / thử / tạm dừng / xoá luật và chạy; bác sĩ nhận thông báo, áp dụng gợi ý, dùng tìm ICD-10 và chuẩn hoá triệu chứng; kho dược bỏ qua gợi ý; lễ tân không thấy tab và thông báo của bác sĩ.

## 8. Giới hạn / việc sau

- Kênh Zalo / SMS / email chưa có (chỉ hộp thư trong app).
- Danh mục ICD-10 rút gọn, cần nạp bản đầy đủ của Bộ Y tế.
- Bộ phát hiện dùng ngưỡng do quản lý đặt và thống kê đơn giản; chưa có mô hình học máy (cố ý, để giải thích được).
- Bộ lập lịch chạy trong tiến trình API: nếu sau này chạy nhiều bản API, advisory lock vẫn chống chạy trùng, nhưng nên tách thành worker riêng.
