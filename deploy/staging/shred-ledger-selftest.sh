#!/usr/bin/env bash
# HCOS-F17 | Tự kiểm chứng: xoá -> đẩy sổ huỷ (age + GCS GIẢ) -> khôi phục bản sao lưu CŨ HƠN lần xoá -> phát lại sổ -> dữ liệu lại bị xoá.
# Chạy trên cluster PostgreSQL cục bộ bằng superuser (CSDL tạm, tự xoá). Cần: psql/createdb/pg_dump/pg_restore, age, openssl.
#   ./shred-ledger-selftest.sh
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"; MIG="$HERE/../../infrastructure/database/migrations"
T=$(mktemp -d "${TMPDIR:-/tmp}/shredst.XXXXXX"); DB="hcos_shredst_$$"; DB2="${DB}_restored"; FAIL=0
ok(){ echo "  ok    $*"; }; bad(){ echo "  FAIL  $*"; FAIL=1; }
cleanup(){ dropdb --if-exists "$DB" >/dev/null 2>&1 || true; dropdb --if-exists "$DB2" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/gcs"
cat > "$T/gcloud" <<'G'
#!/usr/bin/env bash
G="$FAKE_GCS"; p(){ echo "$G/$(echo "$1" | sed 's#gs://[^/]*/##')"; }
shift
case "$1" in
  cp) shift; nc=0; [ "$1" = --no-clobber ] && { nc=1; shift; }; s="$1"; d="$2"
      case "$s" in gs://*) cp "$(p "$s")" "$d";; *) dd_=$(p "$d"); mkdir -p "$(dirname "$dd_")"; if [ -e "$dd_" ] && [ $nc = 1 ]; then :; else cp "$s" "$dd_"; fi;; esac;;
  objects) f=$(p "$3"); [ -e "$f" ] && openssl md5 -binary "$f" | base64;;
  ls) d=$(p "$2"); for f in "$d"*; do [ -e "$f" ] && echo "gs://b/${f#$G/}"; done; true;;
esac
G
chmod +x "$T/gcloud"
age-keygen -o "$T/key.txt" 2>/dev/null; age-keygen -o "$T/key2.txt" 2>/dev/null
{ grep -o 'age1[0-9a-z]*' "$T/key.txt" | head -1; grep -o 'age1[0-9a-z]*' "$T/key2.txt" | head -1; } > "$T/pub"
export FAKE_GCS="$T/gcs" BUCKET=b GCS_PREFIX=st STATE_DIR="$T/st" AGE_RECIPIENTS="$T/pub" GCLOUD_BIN="$T/gcloud" PSQL_CMD=psql
q(){ psql -X -q -tA -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

createdb "$DB"
for f in $(ls "$MIG"/*.sql | sort); do psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null; done
TA=00000000-0000-4000-8000-000000000001; P=00000000-0000-4000-8000-0000000000a1; Q=00000000-0000-4000-8000-0000000000a2
q "$DB" "INSERT INTO iam.tenants(tenant_id,code,name) VALUES ('$TA','ta','A');
         INSERT INTO patient.persons(person_id,tenant_id,given_name,family_name,birth_date) VALUES ('$P','$TA','Xoa','Nguyen','1980-01-01'),('$Q','$TA','Giu','Le','1990-01-01');"
pg_dump -Fc -d "$DB" -f "$T/backup.dump"          # "bản sao lưu" chụp TRƯỚC lần xoá
q "$DB" "SELECT set_config('app.tenant_id','$TA',false); SELECT governance._erase_person('$P', gen_random_uuid(), false);" >/dev/null
[ "$(q "$DB" "SELECT status FROM patient.persons WHERE person_id='$P'")" = erased ] && ok "đã xoá trên CSDL đang chạy" || bad "không xoá được"

PGDATABASE="$DB" "$HERE/shred-ledger-offsite.sh" >/dev/null
N=$(ls "$T/gcs/st/shred-ledger" 2>/dev/null | wc -l)
[ "$N" = 1 ] && ok "sổ huỷ đã lên kho (1 file, mã hoá age)" || bad "số file sổ trên kho: $N"
grep -q "$P" "$T/gcs/st/shred-ledger/"* && bad "sổ trên kho KHÔNG được mã hoá" || ok "file trên kho là bản mã"
[ "$(q "$DB" "SELECT count(*) FROM keyvault.shred_events WHERE exported_at IS NULL")" = 0 ] && ok "đã đánh dấu exported_at" || bad "chưa đánh dấu exported_at"
PGDATABASE="$DB" "$HERE/shred-ledger-offsite.sh" | grep -q "không có sự kiện mới" && ok "chạy lại: không đẩy trùng" || bad "chạy lại vẫn đẩy"

createdb "$DB2"; pg_restore -d "$DB2" --exit-on-error "$T/backup.dump"
[ "$(q "$DB2" "SELECT status FROM patient.persons WHERE person_id='$P'")" = active ] && ok "khôi phục bản cũ: dữ liệu đã xoá 'sống lại' (đúng như dự đoán)" || bad "bản khôi phục không như mong đợi"
OUT=$(AGE_IDENTITY="$T/key.txt" PGDATABASE="$DB2" "$HERE/shred-replay.sh")
echo "$OUT" | grep -q "applied: 1" && ok "phát lại sổ: applied 1" || bad "phát lại: $OUT"
[ "$(q "$DB2" "SELECT status || '|' || coalesce(given_name,'-') FROM patient.persons WHERE person_id='$P'")" = "erased|-" ] && ok "sau phát lại: lại bị xoá" || bad "sau phát lại vẫn còn dữ liệu"
[ "$(q "$DB2" "SELECT status FROM patient.persons WHERE person_id='$Q'")" = active ] && ok "người khác không bị ảnh hưởng" || bad "ảnh hưởng người khác"
OUT2=$(AGE_IDENTITY="$T/key.txt" PGDATABASE="$DB2" "$HERE/shred-replay.sh"); echo "$OUT2" | grep -q "already: 1" && ok "phát lại lần 2: already (idempotent)" || bad "phát lại lần 2: $OUT2"
[ "$FAIL" = 0 ] && echo "SHRED LEDGER SELFTEST: PASS" || { echo "SHRED LEDGER SELFTEST: FAIL"; exit 1; }
