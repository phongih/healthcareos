#!/usr/bin/env bash
# STAGING / THỰC TẬP: tài khoản theo vai trò thật + dữ liệu giả + web có dải cảnh báo.
# Chạy trên VM, bằng user có quyền docker + sudo:   bash deploy/staging/training/setup-training.sh
# Idempotent: chạy lại chỉ thêm phần còn thiếu, không nhân đôi bệnh nhân, không cộng kho lần hai.
#
# Biến tuỳ chọn:
#   TT_PATIENTS=40        số bệnh nhân giả (chỉ có tác dụng ở lần sinh đầu, hoặc khi tăng lên)
#   SKIP_WEB=1            không build lại web
set -euo pipefail
cd "$(dirname "$0")/.."                 # deploy/staging
REPO=$(cd ../.. && pwd)
umask 077
[ -f hcos.env ] && [ -f secrets.env ] || { echo "Thiếu hcos.env/secrets.env: chạy trong deploy/staging đã setup." >&2; exit 1; }
LABEL="${HCOS_ENV_LABEL:-MÔI TRƯỜNG THỰC TẬP — dữ liệu giả, không nhập thông tin bệnh nhân thật}"
NODE_RUN=(docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false)

echo "== 1/4 Tài khoản thực tập trong DB (iam.users, iam.memberships)"
python3 training/accounts.py sql | sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d hcos

echo "== 2/4 Tài khoản Keycloak (mật khẩu tạm, bắt đổi mật khẩu + cài TOTP ở lần đầu)"
PW=training-passwords.txt
for u in $(python3 training/accounts.py usernames); do
  grep -q "^$u=" "$PW" 2>/dev/null || echo "$u=$(openssl rand -base64 18 | tr -d '/+=')" >> "$PW"
done
chmod 600 "$PW"
# JSON có mật khẩu chỉ đi qua pipe, không ghi ra đĩa. Mật khẩu admin đọc từ biến môi trường trong container.
python3 training/accounts.py keycloak "$PW" | docker compose --env-file secrets.env exec -T keycloak sh -c '
  K=/opt/keycloak/bin/kcadm.sh
  $K config credentials --server http://127.0.0.1:8081/auth --realm master --user admin --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null &&
  $K create partialImport -r hcos -o -f -' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"   thêm {d.get(\"added\",0)}, đã có (bỏ qua) {d.get(\"skipped\",0)}")'

echo "== 3/4 Dữ liệu giả qua API thật (role hcos_api, RLS + audit như người dùng thật)"
"${NODE_RUN[@]}" --env-file hcos.env -e TT_PATIENTS="${TT_PATIENTS:-40}" -v "$REPO":/w -w /w node:22 \
  sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx tsx scripts/seed-training.ts'

if [ "${SKIP_WEB:-0}" != 1 ]; then
  echo "== 4/4 Build web có dải cảnh báo"
  "${NODE_RUN[@]}" -e HCOS_ENV_LABEL="$LABEL" -v "$REPO/apps/web":/w -w /w node:22 \
    sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run build'
  # Xoá NỘI DUNG rồi chép vào thư mục cũ: Caddy mount thư mục này, xoá cả thư mục thì container vẫn thấy bản cũ.
  mkdir -p web-dist && umask 022 && find web-dist -mindepth 1 -delete && cp -r "$REPO/apps/web/dist/." web-dist/ && chmod -R a+rX web-dist
  ls web-dist
fi

echo
echo "Xong. Danh sách tài khoản: python3 training/accounts.py list"
echo "Mật khẩu tạm nằm trong $(pwd)/$PW (chỉ bạn đọc được). Giao cho từng học viên qua kênh riêng; KHÔNG dán vào chat/nhóm chung."
