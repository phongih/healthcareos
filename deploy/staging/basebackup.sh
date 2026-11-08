#!/usr/bin/env bash
# Sao lưu VẬT LÝ (pg_basebackup, tar, gồm WAL cần thiết) -> gzip -> age -> gs://BUCKET/pitr/base/<UTC>.tar.gz.age
# Chạy bằng user postgres (kết nối socket cục bộ, cần quyền replication). Cần kèm WAL archiving để khôi phục theo thời điểm.
set -euo pipefail
umask 077
HERE="$(dirname "$(readlink -f "$0")")"; . "$HERE/pitr-common.sh"
check_tools
check_recipient
mkdir -p "$STATE/base"
TS=$(date -u +%Y%m%dT%H%M%SZ); enc="$STATE/base/$TS.tar.gz.age"
trap 'rm -f "$enc" "$enc.part"' EXIT
pg_basebackup -D - -Ft -X fetch -c fast --no-password | gzip -c | "$AGE" -R "$RECIPIENTS" -o "$enc.part"
mv "$enc.part" "$enc"
upload_verified "$enc" "gs://$BUCKET/$PREFIX/base/$TS.tar.gz.age"
echo "basebackup ok: $TS ($(du -h "$enc" | cut -f1) mã hoá)"
