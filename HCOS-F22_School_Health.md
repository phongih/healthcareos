# HCOS-F22 — School Health: hồ sơ sức khoẻ học sinh, khám, tiêm chủng, sơ cứu, cổng phụ huynh

Trạng thái: **đề xuất thiết kế, chưa triển khai**. Tài liệu này chốt phạm vi, mô hình dữ liệu, phân quyền, quy trình đồng ý, và kế hoạch pilot. Các điểm pháp lý và hợp đồng vendor được đánh dấu **[cần xác nhận]**.

## 1. Vì sao không tái dùng module bệnh nhân

HCOS hiện giả định người được chăm sóc là **bệnh nhân** có hồ sơ Person (F1, F3), có encounter lâm sàng (S1), có phiếu thu (F8), và người giám hộ là một bệnh nhân khác (F20, `patient.guardian_links`). Với học sinh, các giả định này sai:

- học sinh không phải là bệnh nhân khám chữa bệnh. Phần lớn sự kiện là sơ cứu, theo dõi, cấp thuốc tại chỗ, không có encounter;
- phụ huynh không phải là bệnh nhân và không nên có thể "đi khám thay" theo cách của F20;
- dữ liệu học sinh có thời hạn lưu giữ, quyền đồng ý và phạm vi xem khác với bệnh án người lớn.

Vì vậy School Health là **module riêng** với các thực thể `student`, `guardian`, `guardian_consent`. Chỉ liên kết với Person / Patient khi có yêu cầu rõ ràng (ví dụ học sinh được chuyển sang khám ở phòng khám có HCOS), và liên kết đó phải do người có quyền thực hiện, có ghi audit.

Tái dùng: F16 (mã hoá theo trường, khoá), F17 (quy trình xoá, crypto-shredding), F15 (danh mục dữ liệu và cấp độ rủi ro), F2 (access policy), F13 (sinh mã), F12 (tích hợp, nhưng OTP và dữ liệu học sinh không đi qua Teams).

## 2. Phạm vi

Trong phạm vi:

- hồ sơ sức khoẻ học sinh theo **trường → điểm trường → lớp → khối**;
- dị ứng, bệnh mãn tính, thuốc đang dùng (có hiệu lực theo thời gian);
- khám định kỳ và khám phát sinh;
- tiêm chủng theo lịch và nhắc nhở phụ huynh;
- sơ cứu, tai nạn, sự kiện sức khoẻ ngoại trú, cấp thuốc tại trường;
- hồ sơ chuyển tuyến (giấy chuyển, theo dõi trạng thái, nhận kết quả);
- cổng phụ huynh và ý kiến đồng ý can thiệp;
- báo cáo tổng hợp không danh tính;
- nhập hàng loạt từ Excel và xuất mẫu thống kê.

Ngoài phạm vi (giai đoạn này): liên thông sổ sức khoẻ điện tử quốc gia, thanh toán BHYT, đặt lịch khám trên cổng, tích hợp với hệ thống quản lý học tập của trường.

## 3. Mô hình dữ liệu

Các thực thể mới (bảng nằm trong schema `school`):

| Thực thể | Nội dung chính | Ghi chú |
|---|---|---|
| `school.schools` | Trường (thuộc tenant của quận/huyện hoặc đơn vị quản lý) | Tenant là ranh giới cách ly dữ liệu, RLS FORCE như các module khác |
| `school.campuses` | Điểm trường / cơ sở vật lý | Phòng y tế gắn với campus |
| `school.classes` | Lớp, năm học, khối | Một học sinh có một lớp hiện hành tại một năm học |
| `school.students` | Học sinh: mã học sinh, họ tên, ngày sinh, giới tính, lớp | Không có quan hệ bắt buộc với Person registry |
| `school.guardians` | Phụ huynh / người giám hộ: họ tên, email (mã hoá), SĐT (tuỳ chọn, mã hoá) | Có tài khoản cổng qua email |
| `school.student_guardians` | Liên kết học sinh – phụ huynh: quan hệ, phạm vi xem, hiệu lực | Thay cho `guardian_links` của F20 trong module này |
| `school.guardian_consents` | Đồng ý can thiệp: học sinh, phạm vi, phiên bản văn bản, trạng thái, dấu thời gian, băm IP và thiết bị | Bất biến; rút đồng ý là bản ghi mới |
| `school.health_profiles` | Hồ sơ sức khoẻ gốc: nhóm máu (tuỳ chọn), ghi chú nền | Một bản hiện hành, có lịch sử |
| `school.allergies` | Dị ứng: tác nhân, mức độ, phản ứng thường gặp, hiệu lực | Mức độ nặng tạo cờ cảnh báo cho GVCN |
| `school.conditions` | Bệnh mãn tính / cần theo dõi: tên, ngày bắt đầu, ghi chú, cờ cảnh báo | Không lưu chẩn đoán chi tiết nếu không cần cho vận hành |
| `school.medications_in_use` | Thuốc đang dùng ở nhà hoặc tại trường: liều, cách dùng, người kê, hiệu lực | Cấp thuốc tại trường ghi vào `dispenses` |
| `school.health_checks` | Khám định kỳ (theo đợt) và khám phát sinh: chỉ số, kết luận, người khám | Đợt khám có mã và có kỳ khám |
| `school.immunizations` | Mũi tiêm: vắc-xin, số lô, ngày, người tiêm, nguồn | Gắn với `immunization_schedules` |
| `school.immunization_schedules` | Lịch tiêm theo độ tuổi và vắc-xin | Dữ liệu tham chiếu, quản trị được |
| `school.reminders` | Nhắc nhở phụ huynh: loại (tiêm, khám, hết hạn thuốc), lịch gửi, trạng thái | Gửi qua email |
| `school.health_events` | Sự kiện sức khoẻ ngoại trú: sơ cứu, tai nạn, sốt, nghỉ y tế, cấp thuốc | **Không** cần encounter lâm sàng |
| `school.first_aid_actions` | Hành động sơ cứu trong sự kiện: loại, người thực hiện, kết quả | Liên kết `health_events` |
| `school.referrals` | Chuyển tuyến: cơ sở nhận, lý do, tài liệu đính kèm, trạng thái, kết quả trả về | Gắn consent khi cần |
| `school.consent_requests` | Yêu cầu đồng ý gửi tới phụ huynh: nội dung, hạn, kết quả | Đầu vào của quy trình consent |
| `school.imports` | Phiên nhập Excel: tệp (xoá sau 24 giờ), báo cáo kiểm tra, người nhập | Có bước kiểm tra trước khi ghi |
| `school.audit_log` | Nhật ký chỉ thêm (append-only): ai, lúc nào, đối tượng, hành động, lý do, băm chuỗi | Xem mục 7 |

Quy ước chung:

- mọi bảng có `tenant_id`, `school_id`, RLS FORCE; khoá ngoại ghép theo `(tenant_id, …)` như F2;
- trường nhạy cảm (email, SĐT phụ huynh, ghi chú chẩn đoán) mã hoá theo F16 và nhãn trong danh mục F15;
- mọi thay đổi hồ sơ dùng cột `version` và `If-Match`, giống các module khác.

## 4. Phân quyền

Bốn vai trò chính, cộng với quyền vận hành hệ thống:

| Vai trò | Xem | Ghi | Ghi chú |
|---|---|---|---|
| **Y tế trường** (`school_nurse`) | Toàn bộ hồ sơ trong trường | Hồ sơ, khám, tiêm, sơ cứu, chuyển tuyến, cấp thuốc | Cần `pii:reveal` có lý do để xem trường nhạy cảm đã mã hoá |
| **Giáo viên chủ nhiệm** (`homeroom_teacher`) | Học sinh của lớp mình: tên, lớp, **cờ cảnh báo** (dị ứng nặng, bệnh cần theo dõi khẩn), thuốc cần cấp trong giờ | Ghi nhận sự kiện tại lớp (ví dụ "em A thấy mệt, đã báo y tế") | Không xem chẩn đoán, kết quả khám, lịch sử tiêm |
| **Phụ huynh** (`guardian`) | Chỉ con mình (theo `student_guardians`, hiệu lực và phạm vi) | Đồng ý / từ chối / rút đồng ý; cập nhật thông tin liên hệ; khai báo thuốc đang dùng ở nhà | Không xem hồ sơ học sinh khác, không xem nhật ký |
| **Admin district** (`district_admin`) | Báo cáo tổng hợp theo trường / khối (không danh tính) | Không | Không có quyền xem hồ sơ cá nhân |
| **Quản trị hệ thống** | Nhật ký, cấu hình, danh mục | Cấu hình lưu giữ trong sàn, tài khoản | Không có quyền xem nội dung hồ sơ học sinh |

Cách thực thi:

- quyền theo vai trò đặt qua access policy (F2), membership gắn policy; server kiểm tra, giao diện chỉ ẩn nút;
- luật "giáo viên chỉ thấy cờ cảnh báo" là luật ở tầng DB (view có RLS), không chỉ ở API;
- nếu một người vừa là phụ huynh vừa là giáo viên của trường, hai vai trò tách hai membership, và mỗi phiên chỉ dùng một ngữ cảnh.

## 5. Đồng ý can thiệp (consent) và cổng phụ huynh

### 5.1 Phạm vi đồng ý

Mỗi đồng ý gắn với **một học sinh** và **một phạm vi**. Các phạm vi mẫu:

- cấp thuốc tại trường theo đơn (kèm tên thuốc, liều, thời điểm);
- tiêm vắc-xin theo đợt (kèm tên vắc-xin, lịch);
- khám sức khoẻ định kỳ và chia sẻ kết quả với phụ huynh;
- chuyển tuyến đến cơ sở y tế (kèm tài liệu nào được gửi);
- thu thập và lưu trữ thông tin nền (dị ứng, bệnh mãn tính).

### 5.2 Quy trình

1. Y tế trường tạo `consent_request` cho học sinh và phạm vi, có hạn trả lời.
2. Hệ thống gửi email tới phụ huynh có liên kết hiệu lực, kèm đường dẫn đăng nhập.
3. Phụ huynh đăng nhập bằng OTP gửi tới email (xem 5.3), đọc nội dung can thiệp và phiên bản văn bản.
4. Phụ huynh đồng ý, từ chối, hoặc yêu cầu liên hệ. Hệ thống ghi bản ghi `guardian_consents` gồm phiên bản văn bản, dấu thời gian, băm IP và băm thiết bị.
5. Đồng ý có hiệu lực tới khi bị rút hoặc hết hạn. Rút đồng ý tạo bản ghi mới; không sửa bản cũ.
6. Mọi thao tác can thiệp kiểm tra consent hiện hành tại thời điểm thực hiện.

**Ngoại lệ khẩn cấp:** sơ cứu cần thiết ngay tại chỗ không chờ consent. Hệ thống ghi sự kiện với cờ "khẩn cấp", và gửi thông báo ngay cho phụ huynh. Phạm vi ngoại lệ cần pháp chế xác nhận **[cần xác nhận]**.

### 5.3 Đăng nhập cổng phụ huynh: email, không SMS

Lý do: chi phí và vendor SMS chưa rõ, và F20 đã phụ thuộc vendor OTP qua SMS (`HCOS_PORTAL_OTP`) với cấu hình chưa có hợp đồng cho trường học.

- OTP 6 số gửi qua email, hiệu lực 5 phút, lưu dạng HMAC như F20;
- giới hạn theo email và theo IP, giống F20;
- phiên tách hẳn khỏi nhân viên (client Keycloak riêng hoặc realm riêng, đã quyết định khi triển khai);
- khi email không hợp lệ hoặc không nhận được, nhà trường xác nhận danh tính trực tiếp và cập nhật email (ghi audit).
- SMS là tuỳ chọn sau này, chỉ bật khi vendor và chi phí đã rõ.

### 5.4 Nhắc nhở

- Nhắc tiêm, khám định kỳ, khai báo lại thuốc, hết hạn đồng ý: gửi email theo lịch, có bản ghi `reminders`;
- không gửi thông tin sức khoẻ chi tiết trong tiêu đề email; nội dung chỉ dẫn tới cổng.

## 6. Hoạt động ngoại tuyến cho trường

Mạng trường có thể chập chờn; y tế trường không được dừng công việc khi mất mạng.

- Trình duyệt trên máy của phòng y tế lưu **bản đọc** hồ sơ đang cần (theo lớp và danh sách hôm nay) và **hàng đợi ghi**.
- Ghi được phép ngoại tuyến: sự kiện sơ cứu, cấp thuốc, ghi nhận khám tại chỗ. Mỗi lần ghi có khoá idempotency (cơ chế có sẵn từ migration 008) và dấu thời gian tại máy.
- Khi đồng bộ, máy chủ kiểm tra consent và quyền tại thời điểm đồng bộ. Xung đột (ví dụ consent đã bị rút khi đang ngoại tuyến) đưa vào hàng chờ để y tế xử lý, không tự ghi đè.
- Bản đọc ngoại tuyến hiện dấu "dữ liệu tính tới HH:MM" và hết hạn sau 12 giờ **[đề xuất, cần xác nhận]**.
- Yêu cầu bảo mật: máy dùng ngoại tuyến phải bật mã hoá đĩa; cache xoá khi đăng xuất; không lưu bản rõ các trường đã mã hoá.

## 7. Audit

- `school.audit_log` chỉ thêm, không sửa, không xoá (trừ theo quy trình F17); mỗi bản ghi băm chuỗi với bản trước để phát hiện chỉnh sửa.
- Ghi đủ: ai, vai trò, học sinh hoặc đối tượng, hành động (xem, sửa, xuất, reveal, đồng bộ), lý do nếu có, IP băm, thời gian.
- Mọi lần xem trường nhạy cảm đã mã hoá đều ghi lý do (5–200 ký tự), giống F16.
- Mục tiêu: 100% thao tác đọc và ghi hồ sơ học sinh, nhập, xuất và đồng bộ ngoại tuyến có audit.
- Quản trị xem audit qua màn riêng; y tế trường chỉ xem audit của hồ sơ mình phụ trách.

## 8. Nhập dữ liệu hàng loạt và xuất mẫu

### 8.1 Nhập từ Excel

- Mẫu Excel cố định theo năm học, có hướng dẫn và danh sách cột bắt buộc.
- Quy trình hai bước: **kiểm tra** (không ghi) → báo cáo dòng lỗi, dòng trùng, dòng thiếu → **xác nhận ghi**.
- Khoá nhận diện: `(school_id, mã học sinh)`; nhập lại là cập nhật, không tạo trùng; nhập hai lần cho kết quả giống nhau.
- Tệp nhập xoá sau 24 giờ; bản xem trước che họ tên và số điện thoại.
- Dữ liệu y tế trong tệp (dị ứng, bệnh nền, tiêm chủng cũ) phải thuộc phạm vi consent hoặc nguồn hợp lệ; dòng không đủ điều kiện được đánh dấu, không ghi.
- Cột không đồng nhất giữa các trường (tên khối, mã lớp viết khác nhau): có bảng ánh xạ, lưu lại cho lần nhập sau.

### 8.2 Xuất mẫu thống kê

- Báo cáo tháng và năm học: số học sinh có hồ sơ đầy đủ, tỷ lệ tiêm theo vắc-xin và khối, số sự kiện sơ cứu theo loại, số chuyển tuyến, tỷ lệ hoàn thành khám định kỳ.
- Không chứa tên, mã học sinh, ngày sinh. Ô có ít hơn **5** đối tượng bị gộp hoặc ẩn **[đề xuất, cần xác nhận]**.
- Xuất ra CSV hoặc Excel; mỗi lần xuất ghi audit với người xuất và phạm vi.

## 9. Lưu giữ và xoá

Đây là điểm cần pháp chế xác nhận **trước khi triển khai**. Đề xuất ban đầu (chưa phải quy định):

| Dữ liệu | Đề xuất | Căn cứ cần xác nhận |
|---|---|---|
| Hồ sơ sức khoẻ học sinh | Giữ đến khi học sinh rời trường, cộng thời gian ngắn (ví dụ 12 tháng), sau đó xoá hoặc ẩn danh | Luật bảo vệ dữ liệu cá nhân; quy định của địa phương về hồ sơ y tế học đường |
| Tiêm chủng | Giữ lâu hơn, theo quy định tiêm chủng | Quy định về sổ tiêm chủng |
| Sự kiện sơ cứu | Giữ theo hồ sơ học sinh; báo cáo tổng hợp giữ không định danh | Quy định về hồ sơ y tế học đường |
| Email, SĐT phụ huynh | Xoá khi học sinh rời trường và phụ huynh rút liên kết | F17 |
| Nhật ký audit | Giữ lâu hơn hồ sơ được audit | Quy định nội bộ |
| Tệp nhập Excel | 24 giờ | Đề xuất |

Quy tắc kỹ thuật: thời hạn đặt trong `school.retention_settings` có **sàn** kiểm tra bằng CHECK, giống F17. Quản trị không đặt được dưới sàn.

## 10. Thay đổi kỹ thuật

- Thêm schema `school` và các bảng ở mục 3, migration từ 032 trở đi.
- Tách hẳn khỏi `patient.guardian_links` của F20; không đưa học sinh vào Person registry.
- Thêm quy trình consent điện tử (mục 5) và audit chuỗi băm (mục 7).
- Thêm luật lưu giữ riêng cho học sinh, cấu hình được và có sàn (mục 9).
- Thêm chế độ ngoại tuyến cho ghi nhận sơ cứu và cấp thuốc (mục 6).
- Thêm đăng nhập phụ huynh bằng email OTP (mục 5.3).
- Thêm nhập Excel có bước kiểm tra và xuất thống kê không định danh (mục 8).
- Thêm sự kiện ngoại trú (`health_events`) và chuyển tuyến (`referrals`), không bắt buộc encounter.
- Danh mục dữ liệu F15: mọi trường mới được gắn nhãn và cấp độ rủi ro; trường học sinh và phụ huynh đặt mức cao nhất.
- Kiểm thử: unit cho luật phân quyền và consent; tích hợp PostgreSQL cho RLS, audit chuỗi băm, nhập trùng, nhập lại; kiểm chứng sao lưu và khôi phục theo runbook BACKUP/PITR.

## 11. Gói pilot

### 11.1 Chọn trường

- 1–3 trường: một trường tiểu học nhỏ, một trường THCS hoặc THPT.
- Ưu tiên trường có phòng y tế thực tế và nhân viên y tế chuyên trách, có IT đầu mối, và có phụ huynh đại diện sẵn sàng tham gia.
- Trường đã đồng ý bằng văn bản; phụ huynh được thông báo và có quyền từ chối tham gia.

### 11.2 Đội ngũ

- Y tế trường (người dùng chính, đồng thiết kế quy trình);
- IT nhà trường (tài khoản, thiết bị, mạng);
- phụ huynh đại diện (góp ý cổng và nội dung consent);
- nhà sản xuất (triển khai, hỗ trợ, đo chỉ số, xử lý lỗi);
- pháp chế hoặc người phụ trách dữ liệu (xác nhận mục 5 và 9).

### 11.3 Lộ trình 12 tuần

| Tuần | Nội dung | Đầu ra |
|---|---|---|
| 1–2 | Khảo sát quy trình hiện tại, ký thoả thuận pilot, chốt phạm vi và mẫu Excel | Biên bản khảo sát, mẫu nhập |
| 3–4 | Nhập dữ liệu gốc (lớp, học sinh, dị ứng, thuốc đang dùng) qua Excel | Báo cáo nhập, danh sách dòng lỗi đã xử lý |
| 5–6 | Vận hành nội bộ: sơ cứu, cấp thuốc, khám định kỳ; chế độ ngoại tuyến | Nhật ký sự kiện, ghi nhận vấn đề |
| 7–8 | Consent điện tử và cổng phụ huynh; nhắc nhở email | Consent đầu tiên đã ký, tỷ lệ mở email |
| 9–10 | Tiêm chủng và báo cáo tháng | Báo cáo tháng đầu tiên, đối chiếu với sổ giấy |
| 11 | Kiểm chứng sao lưu, khôi phục, đối chiếu số dòng và audit | Biên bản kiểm chứng |
| 12 | Đánh giá theo tiêu chí, quyết định mở rộng hoặc dừng | Báo cáo kết thúc pilot |

### 11.4 Đầu ra

- Hồ sơ học sinh được lưu, tìm và sửa trong hệ thống;
- báo cáo tháng;
- dữ liệu không đồng nhất được đưa về chuẩn qua bảng ánh xạ;
- consent đã ký có băm và audit;
- sao lưu được kiểm chứng bằng khôi phục thử.

### 11.5 Tiêu chí thành công

| Tiêu chí | Ngưỡng | Cách đo |
|---|---|---|
| Hồ sơ được nhập | ≥ 80% số học sinh trong danh sách của trường | Số hồ sơ có đủ trường bắt buộc / tổng số học sinh |
| Không mất dữ liệu | 0 dòng thất lạc | Đối chiếu số dòng nhập với số bản ghi; khôi phục thử thành công |
| Audit đầy đủ | 100% thao tác nhạy cảm có bản ghi audit | Đối chiếu mẫu ngẫu nhiên và chuỗi băm còn nguyên |
| Dùng được trong giờ làm việc | Y tế dùng hệ thống trong giờ làm việc, không cần hỗ trợ trực tiếp cho thao tác thường | Nhật ký hỗ trợ; khảo sát nhanh cuối tuần 6 và 12 |

Chỉ số bổ sung (đề xuất, chưa là tiêu chí chính thức): thời gian ghi một sự kiện sơ cứu, tỷ lệ consent được ký trong hạn, số sự kiện ngoại tuyến được đồng bộ đúng.

### 11.6 Rủi ro và điều kiện dừng

- Phụ huynh không đồng ý tham gia: giảm phạm vi, không ép.
- Mất mạng kéo dài: kích hoạt chế độ ngoại tuyến, theo dõi hàng đợi.
- Dữ liệu nhập sai hàng loạt: rollback theo phiên nhập, không ghi đè bản gốc.
- Sự cố bảo mật hoặc lộ dữ liệu: dừng pilot, thông báo theo quy định, rà soát audit.

## 12. Quyết định cần chốt trước khi bắt đầu

1. Chọn trường pilot (số lượng, loại trường) và ký thoả thuận với từng trường.
2. Pháp chế xác nhận thời hạn lưu giữ và phạm vi ngoại lệ khẩn cấp (mục 5.2, 9).
3. Trường là tenant riêng hay đơn vị con của tenant quận / huyện (ảnh hưởng RLS và báo cáo district).
4. Dùng Keycloak realm riêng hay client riêng cho phụ huynh (mục 5.3).
5. Thiết bị phòng y tế dùng ngoại tuyến: ai cấp, mã hoá đĩa, quy định đăng xuất.
6. Chốt mức ẩn danh báo cáo (ngưỡng 5 hay khác).
