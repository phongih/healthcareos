# Dùng chung cho các script PITR (source, không chạy trực tiếp).
[ -r "${PITR_ENV:-/etc/hcos/pitr.env}" ] && . "${PITR_ENV:-/etc/hcos/pitr.env}"
BUCKET="${BUCKET:?cần BUCKET (đặt trong /etc/hcos/pitr.env)}"
PREFIX="${GCS_PREFIX:-pitr}"
AGE="${AGE_BIN:-age}"; GCLOUD="${GCLOUD_BIN:-gcloud}"
RECIPIENTS="${AGE_RECIPIENTS:-/etc/hcos/backup.age.pub}"
STATE="${STATE_DIR:-/var/lib/postgresql/hcos-pitr}"
check_recipient() {
  [ -s "$RECIPIENTS" ] || { echo "thiếu khoá công khai age: $RECIPIENTS" >&2; return 2; }
  if grep -q 'AGE-SECRET-KEY' "$RECIPIENTS"; then echo "$RECIPIENTS chứa KHOÁ RIÊNG: xoá ngay" >&2; return 2; fi
  grep -Eq '^age1[0-9a-z]{50,}$' "$RECIPIENTS" || { echo "$RECIPIENTS không chứa khoá công khai age hợp lệ" >&2; return 2; }
}
# upload_verified <file đã mã hoá> <gs://object>: không ghi đè; thành công chỉ khi MD5 trên GCS khớp.
upload_verified() {
  local enc="$1" obj="$2" want got
  "$GCLOUD" storage cp --no-clobber "$enc" "$obj" >/dev/null 2>&1 || true
  want=$(openssl md5 -binary "$enc" | base64)
  got=$("$GCLOUD" storage objects describe "$obj" --format='value(md5_hash)' 2>/dev/null || true)
  [ "$want" = "$got" ] || { echo "KHÔNG xác minh được $obj (md5 cục bộ=$want, trên GCS=${got:-<không có>})" >&2; return 1; }
}
