#!/usr/bin/env bash
# HCOS-S0-R2 — chạy MỘT LẦN trên VM PoC / CI có truy cập npm + Docker registry. Không dùng dữ liệu thật; chỉ fixture tổng hợp.
# Ghi log từng bước vào evidence/r2/ và in bảng tổng kết. Thoát 0 chỉ khi mọi tiêu chí bắt buộc đạt (=> G0 PASS).
# Yêu cầu: node>=20, npm, docker (daemon chạy), psql (client). Cấu hình tuỳ chọn: R2_PG_PORT (mặc định 55433).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=evidence/r2; rm -rf "$OUT"; mkdir -p "$OUT"
declare -a NAMES=() RESULTS=()
step() { # step <id> <mô tả> -- <lệnh...>
  local id=$1 desc=$2; shift 3
  { echo "\$ $*"; "$@"; echo "[exit=$?]"; } >"$OUT/$id.log" 2>&1
  local ec; ec=$(grep -ao '\[exit=[0-9]*\]$' "$OUT/$id.log" | tail -1 | tr -dc 0-9)
  NAMES+=("$id $desc"); RESULTS+=("${ec:-1}")
  printf '%-4s %-60s exit=%s\n' "$id" "$desc" "${ec:-1}"
}
sh_step() { local id=$1 desc=$2 script=$3; step "$id" "$desc" -- bash -c "$script"; }

# ---------------- Phase A ----------------
sh_step A1 "host/user/repo/branch/HEAD/status" 'hostname; whoami; pwd; git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain=v1'
sh_step A2 "tool versions" 'node -v && npm -v && docker --version && psql --version'
sh_step A3 "npm registry reachable" 'npm ping --registry=https://registry.npmjs.org/'
sh_step A4 "docker daemon + registry reachable" 'docker info >/dev/null && docker pull node:22-bookworm-slim && docker pull postgres:16'

# ---------------- Phase B ----------------
sh_step B1 "npm install (lockfile)" 'npm install --no-audit --no-fund && test -s package-lock.json && sha256sum package-lock.json'
sh_step B2 "npm ci (reproducible)" 'rm -rf node_modules && npm ci --no-audit --no-fund && npm ls --depth=0'
sh_step B3 "tsc strict, no stubs" 'npm run typecheck'
sh_step B4 "unit tests (real vitest)" 'npm run test:unit'

PGPORT_R2=${R2_PG_PORT:-55433}; PGPW="r2-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker rm -f hcos-r2-pg >/dev/null 2>&1; docker network create hcos-r2 >/dev/null 2>&1
docker run -d --name hcos-r2-pg --network hcos-r2 -e POSTGRES_PASSWORD="$PGPW" -p 127.0.0.1:$PGPORT_R2:5432 postgres:16 >"$OUT/B0-pg-start.log" 2>&1
for _ in $(seq 60); do PGPASSWORD=$PGPW psql -h 127.0.0.1 -p $PGPORT_R2 -U postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
sh_step B5 "PostgreSQL 16 version" "PGPASSWORD=$PGPW psql -h 127.0.0.1 -p $PGPORT_R2 -U postgres -tAc 'select version()' | grep -q 'PostgreSQL 16'"
sh_step B6 "migrations apply + idempotent" "createdb_() { PGPASSWORD=$PGPW createdb -h 127.0.0.1 -p $PGPORT_R2 -U postgres hcos_r2; }; createdb_ && for i in 1 2; do PGPASSWORD=$PGPW PGHOST=127.0.0.1 PGPORT=$PGPORT_R2 PGUSER=postgres PGDATABASE=hcos_r2 node scripts/migrate.mjs; done"
sh_step B7 "integration tests (PG16; main.ts suites use real pg + real jose JWKS)" "HCOS_IT=1 PGHOST=127.0.0.1 PGPORT=$PGPORT_R2 PGUSER=postgres PGPASSWORD=$PGPW npm run test:integration"

# ---------------- Phase D ----------------
sh_step D1 "docker build (multi-stage)" 'docker build -f services/api/Dockerfile -t hcos-api:r2 .'
sh_step D2 "image runs as non-root" 'test "$(docker run --rm --entrypoint id hcos-api:r2 -u)" != "0"'
sh_step D3 "no credentials baked in image" 'cfg=$(docker image inspect hcos-api:r2 --format "env={{json .Config.Env}} cmd={{json .Config.Cmd}} labels={{json .Config.Labels}}"); echo "$cfg"; hist=$(docker history --no-trunc --format "{{.CreatedBy}}" hcos-api:r2); echo "--- layer commands (truncated to 160 cols):"; echo "$hist" | cut -c1-160; echo "--- scan:"; if printf "%s\n%s\n" "$cfg" "$hist" | grep -Ein "password|passwd|secret|postgres://|HCOS_DATABASE_URL="; then echo "FOUND credential-like text above"; exit 1; fi; echo "no credential-like text found"'

# Container + JWKS cục bộ: dùng DB riêng, role đăng nhập hạn chế.
APP_PW="app-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export PGPASSWORD=$PGPW
psql -h 127.0.0.1 -p $PGPORT_R2 -U postgres -qc "CREATE ROLE hcos_api LOGIN PASSWORD '$APP_PW' IN ROLE hcos_app" >>"$OUT/D0-setup.log" 2>&1
docker rm -f hcos-r2-api >/dev/null 2>&1
docker run -d --name hcos-r2-api --network hcos-r2 -p 127.0.0.1:28090:8080 \
  -e HCOS_DATABASE_URL="postgres://hcos_api:$APP_PW@hcos-r2-pg:5432/hcos_r2" -e HCOS_JWT_ISSUER=https://idp.hcos.test/ \
  -e HCOS_JWT_AUDIENCE=hcos-api -e HCOS_JWKS_URL=http://127.0.0.1:9/jwks hcos-api:r2 >"$OUT/D4-run.log" 2>&1
for _ in $(seq 40); do curl -fs 127.0.0.1:28090/healthz >/dev/null 2>&1 && break; sleep 0.5; done
sh_step D5 "container /healthz 200" 'curl -fsS -i 127.0.0.1:28090/healthz'
sh_step D6 "container /readyz 200 (DB up)" 'curl -fsS -i 127.0.0.1:28090/readyz'
sh_step D7 "container healthcheck status healthy" 'for i in $(seq 30); do s=$(docker inspect -f "{{.State.Health.Status}}" hcos-r2-api); echo $s; [ "$s" = healthy ] && exit 0; sleep 2; done; exit 1'
docker stop hcos-r2-pg >/dev/null 2>&1   # mô phỏng DB không khả dụng
sh_step D8 "readyz 503 when DB down, healthz still 200" 'for i in $(seq 20); do c=$(curl -s -o /dev/null -w "%{http_code}" 127.0.0.1:28090/readyz); [ "$c" = 503 ] && break; sleep 1; done; test "$c" = 503 && curl -s 127.0.0.1:28090/readyz | grep -qx "{\"status\":\"unavailable\"}" && test "$(curl -s -o /dev/null -w "%{http_code}" 127.0.0.1:28090/healthz)" = 200'
sh_step D9 "graceful container shutdown (exit 0, <15s)" 'docker stop -t 15 hcos-r2-api && test "$(docker inspect -f "{{.State.ExitCode}}" hcos-r2-api)" = 0'
docker logs hcos-r2-api >"$OUT/D10-container.log" 2>&1
sh_step D10 "no secrets in container logs" "! grep -F -e '$APP_PW' -e '$PGPW' '$OUT/D10-container.log'"
sh_step D11 "invalid config in container fails fast without leaking" 'o=$(docker run --rm -e HCOS_DATABASE_URL=postgres://postgres:Hunter2@h/db hcos-api:r2 2>&1); c=$?; echo "$o"; test $c -eq 1 && ! echo "$o" | grep -q Hunter2'
docker rm -f hcos-r2-api hcos-r2-pg >/dev/null 2>&1; docker network rm hcos-r2 >/dev/null 2>&1

# ---------------- Tổng kết ----------------
# Tính FAIL NGOÀI pipeline (gán trong `{ ...; } | tee` chạy ở subshell nên sẽ bị mất => exit luôn 0).
FAIL=0
for r in "${RESULTS[@]}"; do [ "$r" != 0 ] && FAIL=1; done
[ "${#RESULTS[@]}" -ge 21 ] || FAIL=1   # script bị cắt ngang/thiếu bước cũng là thất bại
{ echo "# HCOS-S0-R2 verify summary ($(date -u +%FT%TZ))"; for i in "${!NAMES[@]}"; do
    r=PASS; [ "${RESULTS[$i]}" != 0 ] && r=FAIL; echo "- ${NAMES[$i]}: $r (exit ${RESULTS[$i]})"; done
  echo; [ "$FAIL" = 0 ] && echo "G0 = PASS" || echo "G0 != PASS (xem log từng bước)"; } | tee "$OUT/SUMMARY.md"
exit $FAIL
