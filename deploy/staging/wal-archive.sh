#!/usr/bin/env bash
# archive_command của PostgreSQL:  archive_command = '/usr/local/sbin/hcos-wal-archive %p %f'
# Nén (gzip) + mã hoá (age, khoá CÔNG KHAI) rồi đẩy lên gs://BUCKET/pitr/wal/<file>.gz.age, không ghi đè, xác minh MD5.
# Thoát 0 CHỈ khi object trên GCS đã được xác minh (PostgreSQL chỉ xoá WAL sau khi lệnh này thành công).
# File đã mã hoá được giữ trong STATE giữa các lần thử lại (age không tất định: thử lại phải dùng đúng file đã đẩy một phần).
set -euo pipefail
umask 077
HERE="$(dirname "$(readlink -f "$0")")"; . "$HERE/pitr-common.sh"
P="${1:?cần %p}"; F="${2:?cần %f}"
check_recipient
mkdir -p "$STATE/wal" "$STATE/done"
enc="$STATE/wal/$F.gz.age"; obj="gs://$BUCKET/$PREFIX/wal/$F.gz.age"
# Gọi lại sau khi đã thành công (PostgreSQL có thể gọi lại nếu sự cố xảy ra trước khi ghi nhận): age không tất định nên không thể
# mã hoá lại rồi so MD5. Thay vào đó: nếu đã ghi MD5 đã xác minh của đoạn này và object trên GCS vẫn đúng MD5 đó thì coi là xong.
if [ -s "$STATE/done/$F" ]; then
  got=$("$GCLOUD" storage objects describe "$obj" --format='value(md5_hash)' 2>/dev/null || true)
  [ "$got" = "$(cat "$STATE/done/$F")" ] && { rm -f "$enc"; exit 0; }
fi
if [ ! -s "$enc" ]; then
  gzip -c "$P" | "$AGE" -R "$RECIPIENTS" -o "$enc.part"
  mv "$enc.part" "$enc"
fi
upload_verified "$enc" "$obj"
openssl md5 -binary "$enc" | base64 > "$STATE/done/$F"   # chỉ ghi sau khi đã xác minh
rm -f "$enc"
