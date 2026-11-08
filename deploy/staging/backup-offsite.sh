#!/usr/bin/env bash
# Mã hoá (age, khoá CÔNG KHAI) rồi đẩy bản sao lưu mới lên GCS. Chạy bằng root (cron.d), SAU hcos-backup.
#   BUCKET=hco-staging-backups-513303 hcos-backup-offsite
# - Khoá riêng KHÔNG ở trên VM: VM chỉ mã hoá được, không giải mã được.
# - Đẩy với --no-clobber (không ghi đè). Xác minh bằng MD5 của object trên GCS trước khi đánh dấu đã đẩy.
# - Chỉ đánh dấu "đã đẩy" khi xác minh khớp; lần chạy sau tự thử lại các file chưa đẩy.
set -euo pipefail
umask 077
BUCKET="${BUCKET:?cần BUCKET}"
DIR="${BACKUP_DIR:-/var/backups/hcos}"
RECIPIENTS="${AGE_RECIPIENTS:-/etc/hcos/backup.age.pub}"
STATE="${STATE_DIR:-/var/lib/hcos-backup-offsite}"
AGE="${AGE_BIN:-age}"; GCLOUD="${GCLOUD_BIN:-gcloud}"
PREFIX="${GCS_PREFIX:-hcos}"
[ -s "$RECIPIENTS" ] || { echo "thiếu khoá công khai age: $RECIPIENTS" >&2; exit 2; }
# Khoá công khai age hợp lệ có dạng age1<58 ký tự a-z0-9>. Từ chối khoá giữ chỗ ("age1...") và KHOÁ RIÊNG (không bao giờ được nằm trên VM).
if grep -q 'AGE-SECRET-KEY' "$RECIPIENTS"; then echo "$RECIPIENTS chứa KHOÁ RIÊNG: xoá ngay và dùng khoá công khai (age1...)" >&2; exit 2; fi
grep -Eq '^age1[0-9a-z]{50,}$' "$RECIPIENTS" || { echo "$RECIPIENTS không chứa khoá công khai age hợp lệ (dạng age1xxxx…, ~62 ký tự)" >&2; exit 2; }
mkdir -p "$STATE/pending"   # file đã mã hoá chờ xác minh: GIỮ NGUYÊN giữa các lần thử lại (age mã hoá không tất định)
touch "$STATE/uploaded.list"
fail=0; n=0
shopt -s nullglob
for base in $(ls -1 "$DIR"/hcos-????????T??????Z.dump 2>/dev/null | sort | sed 's/\.dump$//'); do
  b=$(basename "$base")
  if grep -qx "$b" "$STATE/uploaded.list"; then continue; fi
  # Bản sao lưu phải đủ bộ và checksum đúng trước khi mã hoá.
  ( cd "$DIR" && sha256sum -c "$b.sha256" >/dev/null 2>&1 ) || { echo "BỎ QUA $b: checksum không khớp hoặc thiếu file" >&2; fail=1; continue; }
  ok=1
  exts="dump globals.sql sha256"; [ -s "$DIR/$b.keycloak.dump" ] && exts="dump globals.sql keycloak.dump sha256"
  for ext in $exts; do
    src="$DIR/$b.$ext"; enc="$STATE/pending/$b.$ext.age"; obj="gs://$BUCKET/$PREFIX/$b.$ext.age"
    if [ ! -s "$enc" ]; then
      if "$AGE" -R "$RECIPIENTS" -o "$enc.part" "$src"; then mv "$enc.part" "$enc"
      else rm -f "$enc.part"; echo "mã hoá lỗi: $src" >&2; ok=0; continue; fi
    fi
    # Đã có trên bucket (lần chạy trước bị gián đoạn) => chỉ xác minh, không ghi đè.
    "$GCLOUD" storage cp --no-clobber "$enc" "$obj" >/dev/null 2>&1 || true
    want=$(openssl md5 -binary "$enc" | base64)
    got=$("$GCLOUD" storage objects describe "$obj" --format='value(md5_hash)' 2>/dev/null || true)
    if [ "$want" != "$got" ]; then
      # Upload lỗi hoặc object trên GCS khác nội dung: coi là lỗi, KHÔNG ghi đè; lần sau thử lại với đúng file đã mã hoá.
      echo "KHÔNG xác minh được $obj (md5 cục bộ=$want, trên GCS=${got:-<không có>})" >&2; ok=0
    fi
  done
  if [ "$ok" = 1 ]; then
    echo "$b" >> "$STATE/uploaded.list"; rm -f "$STATE/pending/$b".*.age; n=$((n+1)); echo "offsite ok: $b"
  else fail=1; fi
done
[ "$fail" = 0 ] && echo "offsite xong ($n bản mới)" || { echo "offsite có lỗi" >&2; exit 1; }
