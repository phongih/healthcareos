# Sao lưu / khôi phục PostgreSQL (HealthcareOS)

Cài (trên VM, một lần):
```
sudo install -m 755 deploy/staging/backup.sh /usr/local/sbin/hcos-backup
sudo install -m 755 deploy/staging/restore-verify.sh /usr/local/sbin/hcos-restore-verify
sudo install -d -m 700 -o postgres -g postgres /var/backups/hcos
```
Chạy tay: `sudo -u postgres env PGDATABASE=hcos /usr/local/sbin/hcos-backup`
Kiểm chứng: `sudo -u postgres env PGDATABASE=hcos /usr/local/sbin/hcos-restore-verify`  (in `RESTORE VERIFY: PASS|FAIL`).
Lịch: `/etc/cron.d/hcos-backup` — 02:00 sao lưu, 02:30 kiểm chứng khôi phục.

Phạm vi và giới hạn:
- Đây là sao lưu logic (pg_dump), mất tối đa dữ liệu từ lần chạy cuối (RPO = chu kỳ cron). Muốn RPO nhỏ hơn cần WAL archiving/PITR.
- Cùng một máy với DB nên KHÔNG chống mất VM/đĩa: cần sao chép ra ngoài (đã mã hoá) — chưa cấu hình.
- Khôi phục sang máy mới: tạo cluster, nạp `*.globals.sql` (roles, không có mật khẩu — đặt lại mật khẩu `hcos_api`), rồi `pg_restore -d hcos --exit-on-error <file>.dump`.
- Kiểm chứng này chứng minh: checksum, khôi phục được, RLS/FORCE RLS và trigger bất biến còn nguyên, chuỗi audit toàn vẹn. Không thay thế diễn tập khôi phục sự cố thật.

## Sao chép ngoài máy (GCS, mã hoá bằng age)
`backup-offsite.sh` (cài thành `/usr/local/sbin/hcos-backup-offsite`, chạy bằng root sau `hcos-backup`):
- mã hoá từng file bằng khoá CÔNG KHAI age (`/etc/hcos/backup.age.pub`); khoá RIÊNG không ở trên VM;
- đẩy với `--no-clobber` rồi so MD5 của object trên GCS với file đã mã hoá; chỉ khi khớp mới đánh dấu "đã đẩy";
- service account của VM chỉ có `objectCreator` + `objectViewer` trên bucket (không xoá/ghi đè); bucket bật versioning và
  vòng đời xoá bản cũ do bucket đảm nhiệm, không phải VM.
Giải mã/khôi phục: `age -d -i key.txt hcos-<ts>.dump.age > hcos.dump` rồi `pg_restore`.
Mất khoá riêng = mất khả năng khôi phục từ bản sao lưu ngoài máy: giữ khoá ở ít nhất hai nơi tách biệt.
Đã thử với age thật và gcloud giả lập; hành vi trên GCS thật được kiểm chứng ở lần chạy đầu (script báo lỗi rõ nếu MD5 không khớp).
