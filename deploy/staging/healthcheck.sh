#!/usr/bin/env bash
# Kiểm tra sức khoẻ vận hành, chạy bằng root mỗi 5 phút (cron). Ghi trạng thái vào STATUS_DIR/status: "OK" hoặc "FAIL: <lý do>".
# status-server.py chỉ trả 200 khi file bắt đầu bằng OK VÀ còn mới (cron chết => file cũ => 503 => cảnh báo).
# Chi tiết lý do ghi ở STATUS_DIR/detail.txt và syslog (tag hcos-health); KHÔNG lộ ra HTTP công khai.
set -uo pipefail
STATUS_DIR="${STATUS_DIR:-/var/lib/hcos-status}"
PSQL=${PSQL_CMD:-"runuser -u postgres -- psql -X -tA --no-password -d postgres"}
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hcos}"; BACKUP_LOG="${BACKUP_LOG:-/var/log/hcos-backup.log}"
OFFSITE_LIST="${OFFSITE_LIST:-/var/lib/hcos-backup-offsite/uploaded.list}"
BASE_MARK="${BASE_MARK:-/var/lib/postgresql/hcos-pitr/last_base_ok}"
WAL_DIR="${WAL_DIR:-/var/lib/postgresql/16/main/pg_wal}"
MAX_H="${MAX_H:-26}"; DISK_PCT="${DISK_PCT:-70}"; WAL_MB="${WAL_MB:-2048}"; ROOT_FS="${ROOT_FS:-/}"
API_URL="${API_URL:-http://127.0.0.1:8080/readyz}"; KC_URL="${KC_URL:-http://127.0.0.1:8081/auth/realms/hcos/.well-known/openid-configuration}"
R=()
now=$(date +%s)
age_h() { local m; m=$(stat -c %Y "$1" 2>/dev/null) || { echo 99999; return; }; echo $(( (now - m) / 3600 )); }
fresh() { [ "$(age_h "$1")" -le "$MAX_H" ]; }   # $1 = file

# 1. PostgreSQL + archive
if mode=$($PSQL -c "SHOW archive_mode" 2>/dev/null); then
  [ "$mode" = on ] || R+=("archive_mode=$mode (WAL archiving tắt)")
  row=$($PSQL -F' ' -c "SELECT coalesce(extract(epoch FROM last_failed_time),0)::bigint, coalesce(extract(epoch FROM last_archived_time),0)::bigint FROM pg_stat_archiver" 2>/dev/null) || row=""
  if [ -n "$row" ]; then set -- $row; [ "$1" -gt "$2" ] && R+=("archive WAL đang lỗi (lần lỗi gần nhất sau lần thành công gần nhất)"); fi
else R+=("PostgreSQL không truy vấn được"); fi
if [ -d "$WAL_DIR" ]; then mb=$(du -sm "$WAL_DIR" | cut -f1); [ "$mb" -ge "$WAL_MB" ] && R+=("pg_wal ${mb}MB >= ${WAL_MB}MB (WAL tồn đọng)"); fi

# 2. Đĩa
used=$(df --output=pcent "$ROOT_FS" | tail -1 | tr -dc 0-9); [ -n "$used" ] && [ "$used" -ge "$DISK_PCT" ] && R+=("đĩa $ROOT_FS ${used}% >= ${DISK_PCT}%")

# 3. Sao lưu
[ -e "$BASE_MARK" ] && { fresh "$BASE_MARK" || R+=("sao lưu vật lý cũ hơn ${MAX_H}h"); } || R+=("chưa có dấu hoàn tất sao lưu vật lý")
newest=$(ls -1t "$BACKUP_DIR"/hcos-????????T??????Z.dump 2>/dev/null | head -1); { [ -n "$newest" ] && fresh "$newest"; } || R+=("sao lưu logic cũ hơn ${MAX_H}h hoặc không có")
[ -e "$OFFSITE_LIST" ] && { fresh "$OFFSITE_LIST" || R+=("đẩy ngoài máy cũ hơn ${MAX_H}h"); } || R+=("chưa có danh sách đẩy ngoài máy")
if [ -e "$BACKUP_LOG" ]; then
  fresh "$BACKUP_LOG" || R+=("log sao lưu cũ hơn ${MAX_H}h")
  last=$(grep -E 'RESTORE VERIFY:' "$BACKUP_LOG" | tail -1); case "$last" in *PASS*) ;; *) R+=("restore-verify gần nhất không PASS");; esac
else R+=("thiếu log sao lưu"); fi

# 4. Dịch vụ cục bộ
curl -fsS -m 5 -o /dev/null "$API_URL" 2>/dev/null || R+=("API /readyz không đạt")
curl -fsS -m 5 -o /dev/null "$KC_URL" 2>/dev/null || R+=("Keycloak không trả lời")

mkdir -p "$STATUS_DIR"; chmod 755 "$STATUS_DIR"
if [ ${#R[@]} -eq 0 ]; then msg="OK"; else msg="FAIL: $(IFS='; '; echo "${R[*]}")"; fi
printf '%s\n' "$msg" > "$STATUS_DIR/status.tmp"; chmod 644 "$STATUS_DIR/status.tmp"; mv "$STATUS_DIR/status.tmp" "$STATUS_DIR/status"
printf '%s %s\n' "$(date -u +%FT%TZ)" "$msg" > "$STATUS_DIR/detail.txt"
[ "$msg" = OK ] || logger -t hcos-health "$msg" 2>/dev/null || true
[ "$msg" = OK ]
