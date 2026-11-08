#!/usr/bin/env bash
# Dựng lại một data directory từ bản sao lưu vật lý mới nhất không muộn hơn TARGET_TIME, sẵn sàng phát lại WAL tới TARGET_TIME.
#   AGE_IDENTITY=~/key.txt BUCKET=... DEST=/var/lib/postgresql/16/restore TARGET_TIME='2026-11-08 10:30:00+00' ./pitr-restore.sh
# Không khởi động PostgreSQL: in lệnh tiếp theo. Không đụng cluster đang chạy. DEST phải chưa tồn tại hoặc rỗng.
# TARGET_TIME bỏ trống = phát lại hết WAL có trong kho. ACTION=promote|pause (mặc định pause: kiểm tra rồi mới promote).
set -euo pipefail
umask 077
HERE="$(dirname "$(readlink -f "$0")")"; . "$HERE/pitr-common.sh"
DEST="${DEST:?cần DEST}"; ID="${AGE_IDENTITY:?cần AGE_IDENTITY}"; TARGET="${TARGET_TIME:-}"; ACTION="${ACTION:-pause}"
[ -d "$DEST" ] && [ -n "$(ls -A "$DEST")" ] && { echo "DEST không rỗng: $DEST" >&2; exit 2; }
mkdir -p "$DEST"; chmod 700 "$DEST"
# Chọn bản sao lưu: tên là thời điểm bắt đầu (UTC). Phải bắt đầu TRƯỚC thời điểm đích.
LIMIT=""; [ -n "$TARGET" ] && LIMIT=$(date -u -d "$TARGET" +%Y%m%dT%H%M%SZ)
BASE=$("$GCLOUD" storage ls "gs://$BUCKET/$PREFIX/base/" | sed -n 's#.*/\([0-9]\{8\}T[0-9]\{6\}Z\)\.tar\.gz\.age$#\1#p' | sort \
  | awk -v lim="$LIMIT" 'lim=="" || $0<=lim' | tail -n 1)
[ -n "$BASE" ] || { echo "không có bản sao lưu vật lý nào không muộn hơn $TARGET" >&2; exit 1; }
echo "dùng bản sao lưu: $BASE"
tmp=$(mktemp "${TMPDIR:-/tmp}/base.XXXXXX"); trap 'rm -f "$tmp"' EXIT
"$GCLOUD" storage cp "gs://$BUCKET/$PREFIX/base/$BASE.tar.gz.age" "$tmp" >/dev/null
"$AGE" -d -i "$ID" "$tmp" | gunzip -c | tar -x -C "$DEST"
{
  echo "restore_command = 'AGE_IDENTITY=$ID BUCKET=$BUCKET GCS_PREFIX=$PREFIX AGE_BIN=$AGE GCLOUD_BIN=$GCLOUD PITR_ENV=/dev/null $HERE/wal-restore.sh %f %p'"
  [ -n "$TARGET" ] && { echo "recovery_target_time = '$TARGET'"; echo "recovery_target_action = '$ACTION'"; }
  echo "archive_mode = off"
} >> "$DEST/postgresql.auto.conf"
touch "$DEST/recovery.signal"
echo "xong: $DEST. Khởi động thử (cổng khác, không nghe mạng):"
echo "  pg_ctl -D $DEST -o '-p 55433 -c listen_addresses=\"\"' start"
