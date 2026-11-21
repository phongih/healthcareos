# HCOS-F17 — Lưu giữ & xoá dữ liệu

## Bốn việc khác nhau
| Việc | Áp dụng cho | Cách làm | Hoàn tác |
|---|---|---|---|
| **Xoá dữ liệu nghiệp vụ / kỹ thuật** | Dữ liệu hết mục đích: kết quả chống gửi trùng (`platform.idempotency_keys`), sự kiện chờ phát (`platform.outbox_events`) | `DELETE` thật, qua hàm `governance.purge_*` | Không |
| **Huỷ khoá (crypto-shredding)** | SĐT, email, số giấy tờ của một người / một lịch hẹn | Mỗi người, giấy tờ, lịch hẹn có **khoá riêng**. Huỷ = `wrapped_key = NULL`, nên mọi bản mã của chủ thể đó, ở bất kỳ đâu, đều không mở được | Không |
| **Ẩn danh** | Lịch hẹn quá hạn; người bệnh đã xoá | Huỷ khoá, xoá họ tên / ngày sinh / giới / lý do / index / dạng che. Giữ ngày, buổi, phòng, trạng thái (cho thống kê, dự báo) và mã hồ sơ (để toàn vẹn tham chiếu) | Không |
| **Giữ theo nghĩa vụ pháp lý** | Hồ sơ bệnh án, chứng từ thu / chi | Không tự xoá. Yêu cầu xoá chỉ xoá phần không bị ràng buộc, đánh dấu **hạn chế xử lý**, rồi **tự xoá nốt** khi hết hạn giữ | — |

## Chính sách lưu giữ
Mặc định như bảng dưới. Chủ quản đổi được ở tab **Quản trị dữ liệu → Lưu giữ & xoá**, nhưng không thấp hơn sàn (CSDL chặn bằng CHECK).

| Quy tắc | Hành động | Mặc định | Sàn | Tính từ |
|---|---|---|---|---|
| Lịch hẹn online (dữ liệu người đặt) | Ẩn danh | 90 ngày | 30 ngày | Ngày hẹn khám |
| Chống gửi trùng | Xoá | 7 ngày | 1 ngày | Lúc tạo |
| Sự kiện chờ phát (chỉ id) | Xoá | 30 ngày | 7 ngày | Lúc tạo |
| Hồ sơ bệnh án | Giữ | 10 năm | 10 năm | Lần khám cuối |
| Chứng từ thu / chi | Giữ | 10 năm | 10 năm | Hết năm tài chính của chứng từ cuối |

**Căn cứ (pháp chế cần xác nhận trước khi dùng thật):**
- Luật Bảo vệ dữ liệu cá nhân 2025, Điều 14: xoá khi đã hoàn thành mục đích xử lý, hoặc theo yêu cầu của chủ thể.
- Luật Khám bệnh, chữa bệnh 2023, Điều 69 và văn bản hướng dẫn: hồ sơ bệnh án nội trú, ngoại trú lưu tối thiểu 10 năm.
- Luật Kế toán 2015, Điều 41 và Nghị định 174/2016/NĐ-CP, Điều 13 và 15: chứng từ dùng ghi sổ lưu tối thiểu 10 năm, tính từ ngày kết thúc kỳ kế toán năm.

**Job lưu giữ:**
- Chạy mỗi ngày (`HCOS_RETENTION_INTERVAL_SEC`, mặc định 86400; `0` = tắt). Quản trị hệ thống có thể bấm "Chạy ngay".
- Mỗi lần chạy:
  1. ẩn danh lịch hẹn quá hạn;
  2. xoá dữ liệu kỹ thuật hết hạn;
  3. thực thi nốt các yêu cầu xoá đã hết hạn giữ.

## Yêu cầu xoá của người bệnh (hai người)
1. **Lập yêu cầu.** Lễ tân hoặc quản lý phòng khám (`erasure:request`, tại cơ sở của hồ sơ) mở trang hồ sơ bệnh nhân → "Quyền xoá dữ liệu cá nhân" → "Lập yêu cầu xoá…".
   - Màn hình hiện **đánh giá**: còn nghĩa vụ lưu giữ đến ngày nào, và phạm vi sẽ xoá.
   - Lập yêu cầu **chưa xoá gì**.
2. **Duyệt.** Quản trị hệ thống (`erasure:approve`) duyệt ở tab Quản trị dữ liệu. Người duyệt phải **khác** người lập: service chặn, CHECK trong CSDL chặn, và hàm thực thi trong CSDL cũng kiểm tra lại. Duyệt là **thực thi ngay**:
   - **Không còn ràng buộc:** xoá toàn bộ, gồm:
     - danh tính (kể cả các hồ sơ đã gộp vào người này);
     - giấy tờ;
     - lịch hẹn (gắn với hồ sơ, hoặc trùng CCCD);
     - ảnh chụp gộp hồ sơ;
     - kết quả chống gửi trùng có nhắc tới người này.

     Mọi khoá riêng bị huỷ. Từ đó, xem bản rõ trả lỗi "đã xoá".
   - **Còn hồ sơ bệnh án hoặc chứng từ:** chỉ xoá lịch hẹn, đánh dấu **hạn chế xử lý**, trạng thái "Đã xoá một phần". Job tự xoá nốt khi hết hạn giữ.
3. **Trả lời người yêu cầu.** Bấm "Văn bản trả lời" để tải file Markdown. File không ghi họ tên; nhân viên điền khi in.

## Bằng chứng
- **Biên nhận xoá** (`governance.deletion_receipts`, chỉ-thêm) ghi:
  - chính sách và phiên bản (SHA-256 của quy tắc + số ngày đang áp dụng);
  - căn cứ, tiêu chí;
  - phạm vi (số bản ghi theo bảng), số khoá đã huỷ;
  - thời điểm, kết quả, người duyệt;
  - ngày **không thể khôi phục**.

  Biên nhận **không** chứa giá trị nào đã xoá.
- **Audit:** mỗi lần lập, duyệt, từ chối, chạy job đều có sự kiện audit, chỉ ghi id và số đếm.
- **Hồ sơ tự đánh giá (F15)** có thêm mục 6 "Lưu giữ & xoá dữ liệu".

## Bản sao lưu, WAL, bản sao chép
Khoá chủ thể nằm trong CSDL, nên **cũng nằm trong mọi bản sao lưu và WAL được tạo trước lần xoá**. Hệ thống xử lý điều này như sau:
1. **Trên hệ thống đang chạy:** huỷ có hiệu lực ngay, không còn bản sao nào của khoá. Khoá chủ thể không được cache ngoài transaction.
2. **Bản sao lưu hết hạn theo vòng đời:**
   - bucket GCS (bản dump logic, bản vật lý, WAL): 90 ngày;
   - bản dump cục bộ: 7 bản.

   Biên nhận ghi ngày không thể khôi phục = lúc xoá + `HCOS_BACKUP_HORIZON_DAYS` (mặc định 90). **Nếu đổi vòng đời bucket thì phải đổi số này theo.**
3. **Sổ huỷ khoá** (`keyvault.shred_events`): chỉ chứa id và hành động.
   - Cron đẩy sổ ra GCS mỗi 15 phút (`shred-ledger-offsite.sh`, mã hoá bằng age, `--no-clobber`, xác minh MD5). Sổ nằm **ngoài** bản sao lưu CSDL.
   - **Mọi lần khôi phục** (pg_restore hoặc PITR) phải chạy `shred-replay.sh` **trước khi mở API**. Script áp lại đúng hàm xoá, nên dữ liệu đã xoá không "sống lại".
   - Thẻ "Lưu giữ & xoá" cảnh báo khi còn lần huỷ chưa được đẩy sổ.
4. **Bản sao chép (replica):** staging không có. Nếu sau này có, replica nhận thay đổi qua WAL nên tự huỷ theo; bản chụp (snapshot) đĩa của replica cũng phải tuân vòng đời như bản sao lưu.
5. **Ngoài hệ thống:** dữ liệu đã được xuất ra ngoài trước khi xoá (file Excel, bản in) không nằm trong phạm vi này. Theo dõi xuất dữ liệu thuộc F18.

## Thay đổi kỹ thuật
- **Bản mã `s1`** (khoá chủ thể) thay `e1` (DEK tenant, F16).
  - Bấm "Mã hoá lại" ở thẻ Mã hoá để chuyển dữ liệu cũ.
  - Xoay DEK giờ chỉ cần bọc lại các khoá chủ thể; dữ liệu không phải mã hoá lại.
  - AAD gắn với loại và id chủ thể, nên không ghép được bản mã sang dòng khác.
  - Gộp hồ sơ mã hoá lại liên hệ bằng khoá của hồ sơ giữ lại.
- **Migration 020:**
  - bảng `keyvault.subject_keys`, `keyvault.shred_events`;
  - bảng `governance.retention_settings`, `retention_runs`, `deletion_receipts`, `erasure_requests`;
  - cột `erased_at` / `processing_restricted_at`; người bệnh có thêm trạng thái `erased`;
  - guard chỉ cho xoá trong ngữ cảnh `governance.in_erasure()`. Ngữ cảnh này chỉ đúng bên trong hàm SECURITY DEFINER; role ứng dụng tự đặt cờ cũng không qua được;
  - role ứng dụng không có quyền DELETE, không tự huỷ khoá được, không gọi được `_erase_*` / `replay_shred`.
- **Quyền mới:**
  - `retention:read`: quản lý PK, ban giám đốc, quản trị;
  - `retention:manage`: quản trị;
  - `erasure:request`: lễ tân, quản lý PK;
  - `erasure:approve`: quản trị.

## Triển khai lên staging
Chạy trong `~/healthcareos/deploy/staging`:
1. Làm các bước như mọi đợt:
   - `git pull`;
   - sao lưu;
   - **áp migration 020** (thư mục tạm của postgres + `migrate.mjs`; lệnh đầy đủ ở runbook kèm PR);
   - tag image rollback, build, tạo lại container `api`.
2. Chuyển bản mã `e1` sang khoá chủ thể:
   ```bash
   docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp --env-file hcos.env -v "$HOME/healthcareos":/w -w /w node:22 \
     sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx tsx scripts/pii-backfill.ts 00000000-0000-4000-8000-0000000000a1'
   ```
   Script báo "Bản mã dạng cũ còn lại: 0". Cũng có thể bấm "Mã hoá lại" trên giao diện.
3. Cài cron sổ huỷ:
   ```bash
   sudo install -D -m 755 shred-ledger-offsite.sh /usr/local/lib/hcos/shred-ledger-offsite.sh
   sudo install -D -m 755 shred-replay.sh /usr/local/lib/hcos/shred-replay.sh
   echo '*/15 * * * * root BUCKET=hco-staging-backups-513303 GCLOUD_BIN=/snap/bin/gcloud /usr/local/lib/hcos/shred-ledger-offsite.sh >> /var/log/hcos-shred-ledger.log 2>&1' \
     | sudo tee /etc/cron.d/hcos-shred-ledger
   ```
4. Chạy `bash training/setup-training.sh`, rồi **ghi nhận lại cấp độ** (danh mục đổi phiên bản).

## Kiểm thử
- `tests/integration/retention-pg.integration.test.ts` (6 bài, PostgreSQL thật) kiểm tra:
  - sàn pháp lý trong mã nguồn khớp với CSDL;
  - role ứng dụng không tự huỷ khoá / xoá / phát lại được;
  - job ẩn danh và xoá, bản mã cũ không mở được nữa, biên nhận không chứa giá trị;
  - người lập ≠ người duyệt (service và CSDL);
  - xoá toàn bộ, xoá một phần → hết hạn giữ → xoá nốt;
  - từ chối cần lý do;
  - sổ huỷ chỉ đánh dấu một lần;
  - phát lại idempotent;
  - tách tenant.
- `deploy/staging/shred-ledger-selftest.sh` chạy chuỗi: xoá → đẩy sổ (age + GCS giả) → khôi phục bản sao lưu cũ (dữ liệu "sống lại") → phát lại → bị xoá lại → chạy lại báo `already`.
