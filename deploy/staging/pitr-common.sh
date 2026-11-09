# Dùng chung cho các script PITR (source, không chạy trực tiếp).
# PostgreSQL chạy archive_command với PATH của dịch vụ, có thể thiếu thư mục hệ thống (đã gặp: gcloud snap báo "dirname/readlink/python: not found").
# Tự đặt PATH đầy đủ để không phụ thuộc môi trường của người gọi.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin${PATH:+:$PATH}"
[ -r "${PITR_ENV:-/etc/hcos/pitr.env}" ] && . "${PITR_ENV:-/etc/hcos/pitr.env}"
BUCKET="${BUCKET:?cần BUCKET (đặt trong /etc/hcos/pitr.env)}"
PREFIX="${GCS_PREFIX:-pitr}"
AGE="${AGE_BIN:-age}"; GCLOUD="${GCLOUD_BIN:-gcloud}"
RECIPIENTS="${AGE_RECIPIENTS:-/etc/hcos/backup.age.pub}"
STATE="${STATE_DIR:-/var/lib/postgresql/hcos-pitr}"
# Danh sách người nhận: tối thiểu MIN_RECIPIENTS (mặc định 2) khoá CÔNG KHAI age KHÁC NHAU, để mất một khoá riêng không làm mất khả năng khôi phục.
# Mỗi dòng: khoá công khai (age1...), dòng trống hoặc chú thích (#). Từ chối khoá riêng và mọi dòng lạ.
check_recipient() {
  [ -s "$RECIPIENTS" ] || { echo "thiếu danh sách khoá công khai age: $RECIPIENTS" >&2; return 2; }
  if grep -q 'AGE-SECRET-KEY' "$RECIPIENTS"; then echo "$RECIPIENTS chứa KHOÁ RIÊNG: xoá ngay" >&2; return 2; fi
  if grep -Ev '^(age1[0-9a-z]{50,}|#.*|[[:space:]]*)$' "$RECIPIENTS" | grep -q .; then echo "$RECIPIENTS có dòng không hợp lệ (chỉ khoá công khai age1... hoặc chú thích #)" >&2; return 2; fi
  local n; n=$(grep -E '^age1[0-9a-z]{50,}$' "$RECIPIENTS" | sort -u | wc -l)
  [ "$n" -ge "${MIN_RECIPIENTS:-2}" ] || { echo "$RECIPIENTS có $n khoá khác nhau; cần ít nhất ${MIN_RECIPIENTS:-2} (hai khoá độc lập, giữ ở hai nơi tách biệt)" >&2; return 2; }
}
# Dịch vụ PostgreSQL chạy với PATH tối thiểu (không có /snap/bin): phải tìm được gcloud/age ngay, báo lỗi đúng nguyên nhân.
check_tools() {
  command -v "$GCLOUD" >/dev/null 2>&1 || { echo "không tìm thấy gcloud ('$GCLOUD'): đặt GCLOUD_BIN=<đường dẫn tuyệt đối> trong /etc/hcos/pitr.env (snap: /snap/bin/gcloud)" >&2; return 2; }
  command -v "$AGE" >/dev/null 2>&1 || { echo "không tìm thấy age ('$AGE'): đặt AGE_BIN=<đường dẫn tuyệt đối> trong /etc/hcos/pitr.env" >&2; return 2; }
}
# upload_verified <file đã mã hoá> <gs://object>: không ghi đè; thành công chỉ khi MD5 trên GCS khớp.
upload_verified() {
  local enc="$1" obj="$2" want got
  "$GCLOUD" storage cp --no-clobber "$enc" "$obj" >/dev/null 2>"${TMPDIR:-/tmp}/hcos-cp.$$" || { echo "gcloud cp lỗi:" >&2; tail -3 "${TMPDIR:-/tmp}/hcos-cp.$$" >&2; }
  rm -f "${TMPDIR:-/tmp}/hcos-cp.$$"
  want=$(openssl md5 -binary "$enc" | base64)
  got=$("$GCLOUD" storage objects describe "$obj" --format='value(md5_hash)' 2>/dev/null || true)
  [ "$want" = "$got" ] || { echo "KHÔNG xác minh được $obj (md5 cục bộ=$want, trên GCS=${got:-<không có>})" >&2; return 1; }
}
