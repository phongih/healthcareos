#!/usr/bin/env bash
# Cho biết khoá riêng nào mở được bản sao lưu nào trên GCS (không in khoá hay dữ liệu). Chạy trên máy CÓ khoá riêng (không phải VM), cần gcloud + age.
#   BUCKET=hco-staging-backups-513303 ./key-coverage.sh ~/key.txt
# In: khoá công khai tương ứng; từng bản sao lưu vật lý OK/NO; WAL chỉ tại điểm đổi trạng thái; sao lưu logic OK/NO.
set -uo pipefail
ID="${1:?cần đường dẫn khoá riêng}"; BUCKET="${BUCKET:?cần BUCKET}"; PREFIX="${GCS_PREFIX:-pitr}"
chk() { gcloud storage cat "$1" 2>/dev/null | age -d -i "$ID" >/dev/null 2>&1 && echo OK || echo NO; }
echo "khoá công khai của $ID: $(age-keygen -y "$ID")"
echo "--- sao lưu vật lý"; for o in $(gcloud storage ls "gs://$BUCKET/$PREFIX/base/*.age"); do echo "$(chk "$o") ${o##*/}"; done
echo "--- WAL (chỉ in tại điểm đổi OK/NO; dòng ZZ_PREFLIGHT_* là file thử, bỏ qua)"
prev=""; for o in $(gcloud storage ls "gs://$BUCKET/$PREFIX/wal/0*.gz.age"); do s=$(chk "$o"); [ "$s" != "$prev" ] && echo "$s từ ${o##*/}"; prev=$s; done
echo "--- sao lưu logic"; for o in $(gcloud storage ls "gs://$BUCKET/hcos/*.sha256.age"); do echo "$(chk "$o") ${o##*/}"; done
