#!/usr/bin/env bash
# STAGING setup (chạy trên VM, trong thư mục deploy/staging, bằng user có quyền docker + sudo).
set -euo pipefail
cd "$(dirname "$0")"
umask 077
rnd() { openssl rand -base64 18 | tr -d '/+=' ; }

[ -f ~/hcos_api.pw ] || { echo "thiếu ~/hcos_api.pw (mật khẩu role hcos_api)"; exit 1; }
DBPW=$(cat ~/hcos_api.pw)

# 1. Seed dữ liệu giả (superuser, socket cục bộ)
sudo -u postgres psql -d hcos -v ON_ERROR_STOP=1 < "$PWD/seed.sql"   # qua stdin: user postgres không đọc được /home

# 2. Mật khẩu ngẫu nhiên, ghi vào file chỉ chủ sở hữu đọc được
if [ ! -f secrets.env ]; then
  { echo "KC_ADMIN_PASSWORD=$(rnd)"; echo "PW_BACSI=$(rnd)"; echo "PW_DIEUDUONG=$(rnd)"; echo "PW_QUANTRI=$(rnd)"; } > secrets.env
fi
set -a; . ./secrets.env; set +a

# 3. Realm import đã điền mật khẩu
mkdir -p kc-import kc-h2
# Keycloak chạy uid 1000 (khác user của bạn): thư mục import phải đọc được, thư mục H2 phải ghi được.
chmod 755 kc-import
sudo chown -R 1000:0 kc-h2
sed -e "s/__PW_BACSI__/$PW_BACSI/" -e "s/__PW_DIEUDUONG__/$PW_DIEUDUONG/" -e "s/__PW_QUANTRI__/$PW_QUANTRI/" \
  hcos-realm.template.json > kc-import/hcos-realm.json
chmod 644 kc-import/hcos-realm.json   # XOÁ file này sau khi Keycloak đã import (chứa mật khẩu demo)

# 4. Cấu hình API
cat > hcos.env <<ENV
HCOS_DATABASE_URL=postgres://hcos_api:${DBPW}@127.0.0.1:5432/hcos
HCOS_JWT_ISSUER=https://smart.id.vn/auth/realms/hcos
HCOS_JWT_AUDIENCE=hcos-api
HCOS_JWKS_URL=https://smart.id.vn/auth/realms/hcos/protocol/openid-connect/certs
HCOS_PORT=8080
ENV
echo "OK. Tiếp theo: docker compose --env-file secrets.env up -d"
