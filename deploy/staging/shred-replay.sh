#!/usr/bin/env bash
# HCOS-F17 | PHÁT LẠI sổ huỷ khoá sau khi khôi phục bản sao lưu (pg_restore hoặc PITR), TRƯỚC khi mở API.
# Bản sao lưu cũ hơn một lần xoá vẫn chứa dữ liệu + khoá chủ thể của người đã xoá; script này áp lại đúng hàm xoá
# (governance.replay_shred — chỉ superuser) cho mọi sự kiện trong sổ. Idempotent: chạy lại chỉ báo 'already'.
#   AGE_IDENTITY=~/key.txt BUCKET=hco-staging-backups-513303 PGDATABASE=<db đã khôi phục> ./shred-replay.sh
#   LEDGER_DIR=<thư mục *.jsonl đã giải mã> PGDATABASE=... ./shred-replay.sh        # dùng file có sẵn, không tải GCS
# Kết quả: số sự kiện applied / already / absent (absent = bản ghi chưa tồn tại ở thời điểm khôi phục). Không in id hay dữ liệu.
set -euo pipefail
umask 077
DB="${PGDATABASE:?cần PGDATABASE (CSDL vừa khôi phục)}"
read -r -a PSQL <<< "${PSQL_CMD:-psql}"
T=$(mktemp -d "${TMPDIR:-/tmp}/shred-replay.XXXXXX"); trap 'rm -rf "$T"' EXIT
if [ -n "${LEDGER_DIR:-}" ]; then
  cat "$LEDGER_DIR"/*.jsonl > "$T/all.jsonl" 2>/dev/null || true
else
  BUCKET="${BUCKET:?cần BUCKET hoặc LEDGER_DIR}"; ID="${AGE_IDENTITY:?cần AGE_IDENTITY (khoá riêng age)}"
  AGE="${AGE_BIN:-age}"; GCLOUD="${GCLOUD_BIN:-gcloud}"; PREFIX="${GCS_PREFIX:-hcos}/shred-ledger"
  : > "$T/all.jsonl"
  for o in $("$GCLOUD" storage ls "gs://$BUCKET/$PREFIX/" 2>/dev/null | grep -E '\.jsonl\.age$' || true); do
    "$GCLOUD" storage cp "$o" "$T/f.age" >/dev/null
    "$AGE" -d -i "$ID" "$T/f.age" >> "$T/all.jsonl"
  done
fi
lines=$(grep -c . "$T/all.jsonl" || true)
echo "Sổ huỷ: $lines sự kiện"
[ "$lines" -gt 0 ] || exit 0
"${PSQL[@]}" -X -q -v ON_ERROR_STOP=1 -d "$DB" <<SQL
\set QUIET on
BEGIN;
CREATE TEMP TABLE ledger (j jsonb) ON COMMIT DROP;
\copy ledger (j) FROM '$T/all.jsonl'
\pset tuples_only on
\pset format unaligned
SELECT r || ': ' || count(*) FROM (
  SELECT governance.replay_shred((j->>'tenant_id')::uuid, j->>'subject_kind', (j->>'subject_id')::uuid, (j->>'receipt_id')::uuid) AS r
    FROM (SELECT DISTINCT ON (j->>'tenant_id', j->>'subject_kind', j->>'subject_id') j FROM ledger ORDER BY j->>'tenant_id', j->>'subject_kind', j->>'subject_id', (j->>'event_id')::bigint) d
) x GROUP BY r ORDER BY r;
COMMIT;
SQL
echo "Phát lại xong. Kiểm tra rồi mới mở API."
