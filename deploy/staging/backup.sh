#!/usr/bin/env bash
# Sao lưu PostgreSQL của HealthcareOS (STAGING/PROD). Chạy bằng user có quyền đọc DB, ví dụ:
#   sudo -u postgres env PGDATABASE=hcos BACKUP_DIR=/var/backups/hcos /usr/local/sbin/hcos-backup
# Tạo: <dir>/hcos-<UTC>.dump (pg_dump -Fc), <dir>/hcos-<UTC>.globals.sql (roles), .sha256; giữ KEEP bản gần nhất.
# Backup chứa dữ liệu bệnh nhân khi dùng thật: thư mục chỉ chủ sở hữu đọc được; đồng thời PHẢI mã hoá khi sao chép ra ngoài máy.
set -euo pipefail
umask 077
DB="${PGDATABASE:-hcos}"; DIR="${BACKUP_DIR:-/var/backups/hcos}"; KEEP="${KEEP:-7}"
mkdir -p "$DIR"; chmod 700 "$DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ); BASE="$DIR/hcos-$TS"
pg_dump -Fc --no-password -d "$DB" -f "$BASE.dump"
pg_dumpall --globals-only --no-role-passwords -d "$DB" > "$BASE.globals.sql" 2>/dev/null || pg_dumpall --globals-only --no-role-passwords > "$BASE.globals.sql"
pg_restore --list "$BASE.dump" > /dev/null          # file đọc được, danh mục hợp lệ
( cd "$DIR" && sha256sum "hcos-$TS.dump" "hcos-$TS.globals.sql" > "hcos-$TS.sha256" )
# Giữ KEEP bản gần nhất
ls -1 "$DIR"/hcos-*.dump 2>/dev/null | sort | head -n -"$KEEP" | while read -r f; do b="${f%.dump}"; rm -f "$b.dump" "$b.globals.sql" "$b.sha256"; done
echo "backup ok: $BASE.dump ($(du -h "$BASE.dump" | cut -f1))"
