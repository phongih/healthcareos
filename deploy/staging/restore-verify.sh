#!/usr/bin/env bash
# Khôi phục bản sao lưu MỚI NHẤT vào DB tạm rồi kiểm chứng, sau đó xoá DB tạm. Không đụng DB đang chạy.
#   sudo -u postgres env PGDATABASE=hcos BACKUP_DIR=/var/backups/hcos /usr/local/sbin/hcos-restore-verify [file.dump]
# Kiểm: checksum; số dòng từng bảng khớp nguồn (nếu bản sao lưu vừa tạo và DB nguồn không đổi — dùng --strict-counts);
#       RLS/FORCE RLS còn nguyên; chuỗi hash audit toàn vẹn; mọi thay đổi bị chặn (append-only) vẫn có trigger.
set -euo pipefail
DB="${PGDATABASE:-hcos}"; DIR="${BACKUP_DIR:-/var/backups/hcos}"; SCRATCH="hcos_restore_check_$$"
STRICT=0; FILE=""
for a in "$@"; do case "$a" in --strict-counts) STRICT=1;; *) FILE="$a";; esac; done
[ -n "$FILE" ] || FILE=$(ls -1 "$DIR"/hcos-????????T??????Z.dump | sort | tail -n 1)
BASE="${FILE%.dump}"
FAIL=0; ok(){ echo "  ok    $*"; }; bad(){ echo "  FAIL  $*"; FAIL=1; }
q(){ psql -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
cleanup(){ psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "restore-verify: $FILE"
( cd "$DIR" && sha256sum -c "$(basename "$BASE").sha256" >/dev/null 2>&1 ) && ok "checksum" || bad "checksum không khớp"
q -d postgres -c "CREATE DATABASE \"$SCRATCH\""
pg_restore --no-password -d "$SCRATCH" --exit-on-error "$FILE" && ok "pg_restore hoàn tất" || bad "pg_restore lỗi"

TABLES=$(q -d "$SCRATCH" -c "SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='r' AND n.nspname IN ('iam','patient','platform','clinical') ORDER BY 1")
[ -n "$TABLES" ] && ok "$(echo "$TABLES" | wc -l) bảng nghiệp vụ có mặt" || bad "không có bảng nghiệp vụ"
TOTAL=0
for t in $TABLES; do
  r=$(q -d "$SCRATCH" -c "SELECT count(*) FROM $t"); TOTAL=$((TOTAL + r))
  if [ "$STRICT" = 1 ]; then s=$(q -d "$DB" -c "SELECT count(*) FROM $t"); [ "$r" = "$s" ] || bad "$t: khôi phục $r ≠ nguồn $s"; fi
done
ok "tổng số dòng đã khôi phục: $TOTAL"; [ "$STRICT" = 1 ] && ok "số dòng khớp nguồn (strict)"

NOFORCE=$(q -d "$SCRATCH" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('iam','patient','clinical') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
[ "$NOFORCE" = 0 ] && ok "mọi bảng iam/patient/clinical còn ENABLE+FORCE RLS" || bad "$NOFORCE bảng mất RLS/FORCE RLS sau khôi phục"

BROKEN=$(q -d "$SCRATCH" -c "SELECT count(*) FROM platform.audit_events e WHERE e.prev_hash <> '\\x00'::bytea AND NOT EXISTS (SELECT 1 FROM platform.audit_events p WHERE p.tenant_id=e.tenant_id AND p.event_hash=e.prev_hash)")
FORKS=$(q -d "$SCRATCH" -c "SELECT coalesce(sum(n-d),0) FROM (SELECT count(*) n, count(DISTINCT prev_hash) d FROM platform.audit_events GROUP BY tenant_id) x")
[ "$BROKEN" = 0 ] && [ "$FORKS" = 0 ] && ok "chuỗi hash audit toàn vẹn" || bad "chuỗi audit hỏng (đứt=$BROKEN, rẽ nhánh=$FORKS)"

TRG=$(q -d "$SCRATCH" -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('person_merges_immutable','person_unmerges_immutable')")
[ "$TRG" = 2 ] && ok "trigger bất biến của lịch sử merge/unmerge còn nguyên" || bad "thiếu trigger bất biến ($TRG/2)"
if q -d "$SCRATCH" -c "DELETE FROM platform.audit_events" >/dev/null 2>&1; then bad "audit_events vẫn xoá được sau khôi phục"; else ok "audit_events vẫn append-only"; fi

KCFILE="$BASE.keycloak.dump"
if [ -f "$KCFILE" ]; then
  KCS="${SCRATCH}_kc"
  q -d postgres -c "CREATE DATABASE \"$KCS\""
  if pg_restore --no-password -d "$KCS" --exit-on-error "$KCFILE"; then
    R=$(q -d "$KCS" -c "SELECT count(*) FROM realm WHERE name='hcos'")
    U=$(q -d "$KCS" -c "SELECT count(*) FROM user_entity")
    [ "$R" = 1 ] && [ "$U" -ge 1 ] && ok "DB Keycloak khôi phục được (realm hcos, $U người dùng)" || bad "DB Keycloak thiếu realm/người dùng (realm=$R, users=$U)"
  else bad "pg_restore DB Keycloak lỗi"; fi
  psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$KCS\"" >/dev/null 2>&1 || true
fi

[ "$FAIL" = 0 ] && echo "RESTORE VERIFY: PASS" || { echo "RESTORE VERIFY: FAIL"; exit 1; }
