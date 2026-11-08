#!/usr/bin/env bash
# restore_command:  restore_command = 'AGE_IDENTITY=/path/key.txt BUCKET=... /path/hcos-wal-restore %f %p'
# Tải gs://BUCKET/pitr/wal/<f>.gz.age, giải mã bằng khoá RIÊNG (chỉ có trên máy khôi phục), giải nén vào %p.
# Thoát khác 0 khi không có file (PostgreSQL hiểu là hết WAL để phát lại).
set -euo pipefail
umask 077
HERE="$(dirname "$(readlink -f "$0")")"; . "$HERE/pitr-common.sh"
F="${1:?cần %f}"; DEST="${2:?cần %p}"; ID="${AGE_IDENTITY:?cần AGE_IDENTITY (đường dẫn khoá riêng)}"
tmp=$(mktemp "${TMPDIR:-/tmp}/walrestore.XXXXXX"); trap 'rm -f "$tmp"' EXIT
"$GCLOUD" storage cp "gs://$BUCKET/$PREFIX/wal/$F.gz.age" "$tmp" >/dev/null 2>&1 || exit 1
"$AGE" -d -i "$ID" "$tmp" | gunzip -c > "$DEST.part"
mv "$DEST.part" "$DEST"
