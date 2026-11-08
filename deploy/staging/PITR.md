# WAL archiving + khôi phục theo thời điểm (PITR) — staging

Mục tiêu: giảm mất dữ liệu tối đa từ "tới 24 giờ" (sao lưu logic hằng đêm) xuống ≈ `archive_timeout` (5 phút) khi VM/đĩa mất, và cho phép khôi phục về một thời điểm (ví dụ ngay trước khi ai đó xoá nhầm).

Cách hoạt động: mỗi đoạn WAL 16 MB được nén, mã hoá bằng khoá CÔNG KHAI age, đẩy lên `gs://<bucket>/pitr/wal/` (không ghi đè, xác minh MD5 mới trả thành công cho PostgreSQL). Mỗi ngày một bản `pg_basebackup` (mã hoá) lên `pitr/base/`. Khoá RIÊNG không ở trên VM: VM không giải mã được; việc khôi phục chỉ làm trên máy có khoá riêng.
Sao lưu logic hằng đêm (pg_dump) vẫn giữ nguyên, chạy song song.

## Bật trên VM (cần khởi động lại PostgreSQL MỘT lần)
```
cd ~/healthcareos && git pull
sudo install -d -m 755 /usr/local/lib/hcos
sudo install -m 755 deploy/staging/{pitr-common,wal-archive,basebackup,wal-restore,pitr-restore}.sh /usr/local/lib/hcos/
sudo chmod 644 /etc/hcos/backup.age.pub                       # khoá CÔNG KHAI: user postgres cần đọc
# PostgreSQL chạy với PATH tối thiểu: dùng đường dẫn tuyệt đối (gcloud cài bằng snap ở /snap/bin; kiểm tra: command -v gcloud age)
printf 'BUCKET=hco-staging-backups-513303\nGCLOUD_BIN=/snap/bin/gcloud\nAGE_BIN=/usr/bin/age\n' | sudo tee /etc/hcos/pitr.env >/dev/null
```
Kiểm tra trước khi bật (đẩy một file thử bằng đúng user và đường đi sẽ dùng thật; object `ZZ_PREFLIGHT_*` sẽ ở lại trên bucket vì VM không có quyền xoá):
```
sudo -u postgres bash -c 'cd /tmp && echo preflight > pf.txt && /usr/local/lib/hcos/wal-archive.sh /tmp/pf.txt ZZ_PREFLIGHT_$(date -u +%s) && echo PREFLIGHT OK; rm -f /tmp/pf.txt'
sudo -u postgres psql -tA -c "show data_directory" -c "show wal_level" -c "show archive_mode"
sudo grep -n -i 'replication' /etc/postgresql/16/main/pg_hba.conf
```
Lưu ý: bước này chạy qua `sudo` nên có PATH đầy đủ và KHÔNG chứng minh dịch vụ PostgreSQL tìm được `gcloud`; vì vậy `pitr.env` dùng đường dẫn tuyệt đối. Sau khi bật, luôn kiểm tra `pg_stat_archiver` (đã gặp lỗi này thật ở lần bật đầu trên VM). Phải thấy `PREFLIGHT OK`, `wal_level=replica` (hoặc cao hơn), và một dòng `local replication all peer` (nếu thiếu, `pg_basebackup` sẽ bị từ chối). Chỉ khi đạt mới bật:
```
sudo tee /etc/postgresql/16/main/conf.d/hcos-archive.conf >/dev/null <<'CONF'
archive_mode = on
archive_command = '/usr/local/lib/hcos/wal-archive.sh %p %f'
archive_timeout = 300
CONF
sudo systemctl restart postgresql
(cd ~/healthcareos/deploy/staging && docker compose --env-file secrets.env ps)   # API/Keycloak tự kết nối lại; chờ ~1 phút và kiểm tra healthy
sudo -u postgres psql -c "SELECT pg_switch_wal()"; sleep 20
sudo -u postgres psql -x -c "SELECT archived_count, failed_count, last_archived_wal, last_failed_wal FROM pg_stat_archiver"
sudo -u postgres /usr/local/lib/hcos/basebackup.sh            # bản sao lưu vật lý đầu tiên (bắt buộc: WAL chưa có nền thì không khôi phục được)
sudo install -m 640 -o postgres -g postgres /dev/null /var/log/hcos-pitr.log
echo '40 1 * * * postgres /usr/local/lib/hcos/basebackup.sh >> /var/log/hcos-pitr.log 2>&1' | sudo tee /etc/cron.d/hcos-pitr
```
Kỳ vọng: `archived_count` tăng, `failed_count = 0`, `basebackup ok: <thời điểm>`. Nếu API/Keycloak không tự nối lại DB sau khi PostgreSQL khởi động lại: `docker compose --env-file secrets.env restart api keycloak`.

Quay lại nếu lỗi: `sudo rm /etc/postgresql/16/main/conf.d/hcos-archive.conf && sudo systemctl restart postgresql`.

## Rủi ro vận hành (đọc trước khi bật)
- Nếu việc đẩy WAL lên GCS **lỗi liên tục** (mất quyền, hết hạn khoá, sai khoá công khai), PostgreSQL **giữ lại WAL** và `pg_wal` lớn dần cho đến khi đầy đĩa → DB dừng. Hiện CHƯA có cảnh báo cho việc này. Kiểm tra tay thường xuyên:
  `sudo -u postgres psql -tA -c "SELECT failed_count, last_failed_time FROM pg_stat_archiver"` và `df -h /`.
  Việc tiếp theo trong danh sách là cảnh báo `failed_count` tăng và đĩa > 70%.
- Vòng đời bucket (90 ngày) áp dụng chung cho `wal/` và `base/`: bản sao lưu vật lý nào còn thì WAL tương ứng còn (cùng tuổi). Không đặt vòng đời khác nhau cho hai tiền tố.
- Thư mục `/var/lib/postgresql/hcos-pitr/done/` chứa MD5 đã xác minh của từng đoạn (rất nhỏ); cần để gọi lại an toàn. Mất thư mục này thì các đoạn đã đẩy sẽ báo lỗi khi bị gọi lại (không ghi đè): xử lý tay.

## Khôi phục theo thời điểm (làm trên máy có khoá riêng, KHÔNG ghi đè cluster đang chạy)
```
AGE_IDENTITY=~/key.txt BUCKET=hco-staging-backups-513303 DEST=/var/lib/postgresql/16/restore \
TARGET_TIME='2026-11-08 10:30:00+00' ./pitr-restore.sh       # chọn bản base mới nhất ≤ thời điểm, dựng data dir
pg_ctl -D <DEST> -o '-p 55433 -c listen_addresses=""' start    # phát lại WAL tới TARGET_TIME rồi dừng ở trạng thái pause
psql -p 55433 ...                                              # kiểm tra dữ liệu; đúng thì: SELECT pg_wal_replay_resume();
```
Trên máy mới: cài PostgreSQL 16 và age, `gcloud auth` có quyền đọc bucket, tải 5 script, rồi như trên. Thời điểm trong `TARGET_TIME` phải sau lần sao lưu vật lý đầu tiên.

## Đã kiểm chứng / chưa
- `pitr-selftest.sh` (cluster tạm + PostgreSQL 16 thật + age thật + kho GCS GIẢ là thư mục): dữ liệu khôi phục đúng thời điểm (có nhóm A, B; không có C); không có lần archive lỗi; bản sao lưu và WAL là ciphertext. Kiểm tra phủ định: không đặt thời điểm thì có thêm C. Kiểm tra gọi lặp lại: chấp nhận đúng object đã xác minh, từ chối object bị đổi nội dung.
- **Chưa kiểm chứng**: `gcloud` và GCS thật (lần chạy đầu trên VM là bằng chứng đầu tiên), một diễn tập khôi phục sự cố thật trên máy mới, thời gian khôi phục với dữ liệu lớn (bản sao lưu hiện ghi qua file tạm, chưa phát trực tiếp), và hành vi khi chuyển timeline nhiều lần.
- Cũng là giới hạn: RPO ≈ 5 phút chỉ khi archive chạy tốt; không có replica nên vẫn có thời gian ngừng khi mất VM (RTO = thời gian dựng máy + tải + phát lại WAL, chưa đo).
