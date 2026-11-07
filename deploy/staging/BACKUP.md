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
