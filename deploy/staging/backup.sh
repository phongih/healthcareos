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
FILES="hcos-$TS.dump hcos-$TS.globals.sql"
# DB của Keycloak (người dùng, thông tin xác thực, OTP): sao lưu cùng bộ nếu tồn tại (KC_DB_NAME, mặc định keycloak).
KCDB="${KC_DB_NAME:-keycloak}"
if psql -X -q -tA --no-password -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$KCDB'" | grep -q 1; then
  pg_dump -Fc --no-password -d "$KCDB" -f "$BASE.keycloak.dump"
  pg_restore --list "$BASE.keycloak.dump" > /dev/null
  FILES="$FILES hcos-$TS.keycloak.dump"
fi
( cd "$DIR" && sha256sum $FILES > "hcos-$TS.sha256" )
# Giữ KEEP bản gần nhất
ls -1 "$DIR"/hcos-????????T??????Z.dump 2>/dev/null | sort | head -n -"$KEEP" | while read -r f; do b="${f%.dump}"; rm -f "$b.dump" "$b.globals.sql" "$b.keycloak.dump" "$b.sha256"; done
echo "backup ok: $BASE.dump ($(du -h "$BASE.dump" | cut -f1))"
