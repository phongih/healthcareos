#!/usr/bin/env bash
# HCOS-F17 | Đẩy SỔ HUỶ KHOÁ (keyvault.shred_events — chỉ id + hành động, KHÔNG dữ liệu) ra GCS, NGOÀI bản sao lưu CSDL.
# Mục đích: khôi phục một bản sao lưu cũ hơn lần xoá sẽ làm "sống lại" dữ liệu đã xoá; sổ này cho phép phát lại mọi lần xoá
# (shred-replay.sh) trước khi mở dịch vụ. Chạy bằng root (cron.d), mỗi 15 phút:
#   BUCKET=hco-staging-backups-513303 /usr/local/lib/hcos/shred-ledger-offsite.sh
# - Mã hoá age bằng khoá CÔNG KHAI (cùng danh sách với bản sao lưu, tối thiểu 2 khoá); VM không giải mã được.
# - Đẩy --no-clobber, so MD5; CHỈ khi khớp mới đánh dấu exported_at (một lần; trigger CSDL chặn sửa lại). Lỗi => lần sau thử lại đúng file đó.
set -euo pipefail
umask 077
BUCKET="${BUCKET:?cần BUCKET}"
RECIPIENTS="${AGE_RECIPIENTS:-/etc/hcos/backup.age.pub}"
STATE="${STATE_DIR:-/var/lib/hcos-shred-ledger}"
AGE="${AGE_BIN:-age}"; GCLOUD="${GCLOUD_BIN:-gcloud}"
PREFIX="${GCS_PREFIX:-hcos}/shred-ledger"
DB="${PGDATABASE:-hcos}"
# psql bằng superuser (bỏ qua RLS: sổ của mọi tenant). Mặc định chạy dưới user postgres.
read -r -a PSQL <<< "${PSQL_CMD:-sudo -u postgres psql}"
q() { "${PSQL[@]}" -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

[ -s "$RECIPIENTS" ] || { echo "thiếu danh sách khoá công khai age: $RECIPIENTS" >&2; exit 2; }
if grep -q 'AGE-SECRET-KEY' "$RECIPIENTS"; then echo "$RECIPIENTS chứa KHOÁ RIÊNG (không bao giờ được nằm trên VM): xoá ngay" >&2; exit 2; fi
n=$(grep -E '^age1[0-9a-z]{50,}$' "$RECIPIENTS" | sort -u | wc -l)
[ "$n" -ge "${MIN_RECIPIENTS:-2}" ] || { echo "$RECIPIENTS có $n khoá khác nhau; cần ít nhất ${MIN_RECIPIENTS:-2}" >&2; exit 2; }
mkdir -p "$STATE/pending"

push() {  # $1 = file .age; tên chứa khoảng event_id: ledger-<ts>-<a>-<b>.jsonl.age
  local enc="$1" b obj want got a z
  b=$(basename "$enc"); obj="gs://$BUCKET/$PREFIX/$b"
  "$GCLOUD" storage cp --no-clobber "$enc" "$obj" >/dev/null 2>&1 || true
  want=$(openssl md5 -binary "$enc" | base64)
  got=$("$GCLOUD" storage objects describe "$obj" --format='value(md5_hash)' 2>/dev/null || true)
  if [ "$want" != "$got" ]; then echo "KHÔNG xác minh được $obj (md5 cục bộ=$want, trên GCS=${got:-<không có>})" >&2; return 1; fi
  a=$(echo "$b" | sed -E 's/^ledger-[0-9TZ]+-([0-9]+)-([0-9]+)\.jsonl\.age$/\1/'); z=$(echo "$b" | sed -E 's/^ledger-[0-9TZ]+-([0-9]+)-([0-9]+)\.jsonl\.age$/\2/')
  q -c "UPDATE keyvault.shred_events SET exported_at = now() WHERE exported_at IS NULL AND event_id BETWEEN $a AND $z" >/dev/null
  rm -f "$enc"; echo "shred-ledger ok: $b"
}

# 1. File đã mã hoá từ lần trước nhưng chưa xác minh được: thử lại đúng file đó (age không tất định).
for f in $(find "$STATE/pending" -maxdepth 1 -type f -name 'ledger-*.jsonl.age' | sort); do push "$f"; done

# 2. Sự kiện mới.
range=$(q -c "SELECT min(event_id) || ' ' || max(event_id) FROM keyvault.shred_events WHERE exported_at IS NULL")
[ -n "$range" ] || { echo "shred-ledger: không có sự kiện mới"; exit 0; }
read -r a z <<< "$range"
ts=$(date -u +%Y%m%dT%H%M%SZ)
plain="$STATE/pending/ledger-$ts-$a-$z.jsonl"
q -c "COPY (SELECT row_to_json(e) FROM (SELECT event_id, tenant_id, subject_kind, subject_id, action, receipt_id, occurred_at
          FROM keyvault.shred_events WHERE exported_at IS NULL AND event_id BETWEEN $a AND $z ORDER BY event_id) e) TO STDOUT" > "$plain"
[ -s "$plain" ] || { rm -f "$plain"; exit 0; }
"$AGE" -R "$RECIPIENTS" -o "$plain.age.part" "$plain" && mv "$plain.age.part" "$plain.age"
rm -f "$plain"
push "$plain.age"
