#!/usr/bin/env bash
# STAGING: kiểm tra cấu hình IdP từ bên ngoài (không cần mật khẩu): PKCE bắt buộc, password grant đã tắt, admin/master không lộ.
set -uo pipefail
H="${HOST:-https://smart.id.vn}"; R="$H/auth/realms/hcos/protocol/openid-connect"; FAIL=0
ok(){ echo "  ok    $*"; }; bad(){ echo "  FAIL  $*"; FAIL=1; }
CH=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM; RU=https%3A%2F%2Fsmart.id.vn%2Fcallback
code(){ curl -sS -o /dev/null -w '%{http_code}' "$@"; }
loc(){ curl -sS -o /dev/null -D - "$@" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}'; }

curl -sS "$H/auth/realms/hcos/.well-known/openid-configuration" | grep -q '"S256"' && ok "discovery quảng bá S256" || bad "discovery không có S256"
b=$(curl -sS "$R/token" -d grant_type=password -d client_id=hcos-web -d username=x -d password=x)
echo "$b" | grep -q 'unauthorized_client' && ok "password grant bị từ chối cho hcos-web" || bad "password grant KHÔNG bị từ chối: $b"
b=$(curl -sS "$R/token" -d grant_type=password -d client_id=hcos-staging-cli -d username=x -d password=x)
echo "$b" | grep -q 'invalid_client\|unauthorized_client' && ok "client cũ hcos-staging-cli không còn dùng được" || bad "client cũ còn hoạt động: $b"
n=$(loc "$R/auth?client_id=hcos-web&response_type=code&scope=openid&redirect_uri=$RU")
case "$n" in *error=*) ok "thiếu code_challenge bị từ chối";; *) [ "$(code "$R/auth?client_id=hcos-web&response_type=code&scope=openid&redirect_uri=$RU")" = 400 ] && ok "thiếu code_challenge bị từ chối (400)" || bad "thiếu code_challenge vẫn được chấp nhận";; esac
[ "$(code "$R/auth?client_id=hcos-web&response_type=code&scope=openid&redirect_uri=$RU&code_challenge=$CH&code_challenge_method=S256")" = 200 ] && ok "có PKCE S256 thì ra trang đăng nhập" || bad "yêu cầu PKCE hợp lệ không ra trang đăng nhập"
[ "$(code "$R/auth?client_id=hcos-web&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&code_challenge=$CH&code_challenge_method=S256")" = 400 ] && ok "redirect_uri lạ bị từ chối" || bad "redirect_uri lạ không bị từ chối"
[ "$(code "$H/auth/admin/master/console/")" = 404 ] && ok "admin console không lộ" || bad "admin console truy cập được từ Internet"
[ "$(code "$H/auth/realms/master/.well-known/openid-configuration")" = 404 ] && ok "realm master không lộ" || bad "realm master truy cập được từ Internet"
[ "$FAIL" = 0 ] && echo "VERIFY IDP: PASS" || { echo "VERIFY IDP: FAIL"; exit 1; }
