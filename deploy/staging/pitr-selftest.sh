#!/usr/bin/env bash
# Tự kiểm chứng toàn bộ chuỗi WAL archive -> base backup -> khôi phục theo thời điểm, trên một cluster TẠM
# (không đụng cluster thật), với kho GCS GIẢ (thư mục cục bộ) và age thật. Chạy bằng user không phải root.
#   ./pitr-selftest.sh          # cần: PostgreSQL 16 binaries trong PATH hoặc PGBIN, age, gzip, openssl
# Kiểm chứng LOGIC; không kiểm chứng gcloud/GCS thật (việc đó do lần chạy đầu trên VM).
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
[ "$(id -u)" != 0 ] || { echo "không chạy bằng root"; exit 2; }
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"; export PATH="$PGBIN:$PATH"
T=$(mktemp -d "${TMPDIR:-/tmp}/pitr.XXXXXX"); PORT=${PORT:-55440}; FAIL=0
ok(){ echo "  ok    $*"; }; bad(){ echo "  FAIL  $*"; FAIL=1; }
cleanup(){ pg_ctl -D "$T/pg" -m immediate stop >/dev/null 2>&1 || true; pg_ctl -D "$T/restore" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/gcs"
cat > "$T/gcloud" <<'G'
#!/usr/bin/env bash
# gcloud giả: storage cp [--no-clobber] SRC DST | storage objects describe URL --format=... | storage ls URL
G="$FAKE_GCS"; p(){ echo "$G/$(echo "$1" | sed 's#gs://[^/]*/##')"; }
shift  # storage
case "$1" in
  cp) shift; nc=0; [ "$1" = --no-clobber ] && { nc=1; shift; }; s="$1"; d="$2"
      case "$s" in gs://*) cp "$(p "$s")" "$d";; *) dd_=$(p "$d"); mkdir -p "$(dirname "$dd_")"; if [ -e "$dd_" ] && [ $nc = 1 ]; then :; else cp "$s" "$dd_"; fi;; esac;;
  objects) f=$(p "$3"); [ -e "$f" ] && openssl md5 -binary "$f" | base64;;
  ls) d=$(p "$2"); for f in "$d"*; do [ -e "$f" ] && echo "gs://b/${f#$G/}"; done; true;;
esac
G
chmod +x "$T/gcloud"
age-keygen -o "$T/key.txt" 2>/dev/null; age-keygen -o "$T/key2.txt" 2>/dev/null
{ grep -o 'age1[0-9a-z]*' "$T/key.txt" | head -1; grep -o 'age1[0-9a-z]*' "$T/key2.txt" | head -1; } > "$T/pub"   # hai khoá độc lập (bắt buộc >= 2)
export FAKE_GCS="$T/gcs" BUCKET=b GCS_PREFIX=pitr STATE_DIR="$T/st" AGE_RECIPIENTS="$T/pub" GCLOUD_BIN="$T/gcloud" PITR_ENV=/dev/null
export PGHOST="$T" PGPORT=$PORT PGDATABASE=postgres
initdb -D "$T/pg" -A trust >/dev/null
cat >> "$T/pg/postgresql.conf" <<C
port = $PORT
listen_addresses = ''
unix_socket_directories = '$T'
archive_mode = on
archive_command = 'env FAKE_GCS=$FAKE_GCS BUCKET=b GCS_PREFIX=pitr STATE_DIR=$T/st AGE_RECIPIENTS=$T/pub GCLOUD_BIN=$T/gcloud PITR_ENV=/dev/null $HERE/wal-archive.sh %p %f'
wal_level = replica
max_wal_senders = 3
C
echo "local all all trust" >> "$T/pg/pg_hba.conf"; echo "local replication all trust" >> "$T/pg/pg_hba.conf"
# Mô phỏng Debian/Ubuntu: cấu hình NẰM NGOÀI thư mục dữ liệu (nên pg_basebackup không chép chúng).
mkdir -p "$T/conf"; mv "$T/pg/postgresql.conf" "$T/pg/pg_hba.conf" "$T/pg/pg_ident.conf" "$T/conf/"
pg_ctl -D "$T/pg" -w -l "$T/pg.log" -o "-c config_file=$T/conf/postgresql.conf -c hba_file=$T/conf/pg_hba.conf -c ident_file=$T/conf/pg_ident.conf" start >/dev/null
psql -X -q -c "CREATE TABLE t(phase text, n int)" -c "INSERT INTO t SELECT 'A', g FROM generate_series(1,100) g"
"$HERE/basebackup.sh" && ok "basebackup chạy và xác minh được" || bad "basebackup lỗi"
psql -X -q -c "INSERT INTO t SELECT 'B', g FROM generate_series(1,50) g" -c "SELECT pg_switch_wal()" >/dev/null
sleep 2
TARGET=$(psql -X -tA -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')||'+00'")
sleep 2
psql -X -q -c "INSERT INTO t SELECT 'C', g FROM generate_series(1,25) g" -c "SELECT pg_switch_wal()" >/dev/null
for i in $(seq 1 30); do [ "$(psql -X -tA -c "SELECT last_archived_wal IS NOT NULL AND failed_count=0 FROM pg_stat_archiver")" = t ] && break; sleep 1; done
sleep 3
A=$(psql -X -tA -c "SELECT archived_count||'/'||failed_count FROM pg_stat_archiver"); echo "  info  archived/failed = $A"
[ "${A#*/}" = 0 ] && ok "không có lần archive lỗi" || bad "có lần archive lỗi ($A)"
N=$(ls "$T/gcs/pitr/wal" | wc -l); [ "$N" -ge 2 ] && ok "$N đoạn WAL đã mã hoá trên kho giả" || bad "quá ít đoạn WAL ($N)"
grep -aq 'PGDMP\|PostgreSQL' "$T/gcs/pitr/base/"*.age 2>/dev/null && bad "bản sao lưu KHÔNG được mã hoá" || ok "bản sao lưu/WAL là ciphertext (không thấy văn bản gốc)"
# Cả hai khoá độc lập đều giải mã được cùng một bản sao lưu (mất một khoá vẫn khôi phục được)
BF=$(ls "$T"/gcs/pitr/base/*.age | head -1)
for k in key key2; do
  LIST=$(age -d -i "$T/$k.txt" "$BF" 2>/dev/null | gunzip -c 2>/dev/null | tar -t 2>/dev/null || true)   # lấy hết rồi mới grep (grep -q + pipefail sẽ bắn SIGPIPE)
  case "$LIST" in *PG_VERSION*) ok "khoá $k giải mã được bản sao lưu vật lý";; *) bad "khoá $k KHÔNG giải mã được";; esac
done
# Khoá THỨ BA (không có trong danh sách người nhận) phải KHÔNG giải mã được
age-keygen -o "$T/key3.txt" 2>/dev/null
LIST3=$(age -d -i "$T/key3.txt" "$BF" 2>/dev/null | gunzip -c 2>/dev/null | tar -t 2>/dev/null || true)
[ -z "$LIST3" ] && ok "khoá lạ không giải mã được (đúng)" || bad "khoá lạ giải mã được bản sao lưu!"
# Khôi phục tới TARGET (giữa B và C)
AGE_IDENTITY="$T/key.txt" DEST="$T/restore" TARGET_TIME="$TARGET" ACTION=promote "$HERE/pitr-restore.sh" >/dev/null && ok "pitr-restore dựng data dir" || bad "pitr-restore lỗi"
[ -s "$T/restore/pg_hba.conf" ] && ok "bản khôi phục có cấu hình tối thiểu dù nguồn để cấu hình ngoài data dir" || bad "thiếu pg_hba.conf trong bản khôi phục"
pg_ctl -D "$T/restore" -w -t 60 -o "-p $((PORT+1)) -c listen_addresses='' -c unix_socket_directories='$T'" -l "$T/restore.log" start >/dev/null 2>&1 || { bad "PostgreSQL khôi phục không khởi động"; tail -20 "$T/restore.log"; }
export PGPORT=$((PORT+1))
for i in $(seq 1 30); do [ "$(psql -X -tA -c "SELECT pg_is_in_recovery()" 2>/dev/null)" = f ] && break; sleep 1; done
R=$(psql -X -tA -F, -c "SELECT phase||'='||count(*) FROM t GROUP BY phase ORDER BY phase" 2>/dev/null | paste -sd' ')
echo "  info  sau khôi phục: $R"
[ "$R" = "A=100 B=50" ] && ok "đúng thời điểm: có A và B, KHÔNG có C" || bad "dữ liệu sau khôi phục sai: '$R' (kỳ vọng 'A=100 B=50')"
[ "$FAIL" = 0 ] && echo "PITR SELFTEST: PASS" || { echo "PITR SELFTEST: FAIL"; exit 1; }
