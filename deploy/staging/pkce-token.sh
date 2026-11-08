#!/usr/bin/env bash
# STAGING: đăng nhập thử bằng authorization code + PKCE (S256), bao gồm bước OTP, rồi đổi code lấy token và in các claim chính.
#   ./pkce-token.sh            # in URL để mở bằng trình duyệt; sau khi đăng nhập, dán URL cuối (https://smart.id.vn/callback?...code=...)
# Không in access token đầy đủ; chỉ in claim cần kiểm. Yêu cầu: curl, openssl, python3.
set -euo pipefail
BASE="${BASE:-https://smart.id.vn/auth/realms/hcos/protocol/openid-connect}"
CLIENT="${CLIENT:-hcos-web}"; REDIRECT="${REDIRECT:-https://smart.id.vn/callback}"
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
pkce_challenge() { printf '%s' "$1" | openssl dgst -sha256 -binary | b64url; }
if [ "${1:-}" = "--selftest" ]; then   # vector RFC 7636 Phụ lục B
  [ "$(pkce_challenge dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk)" = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" ] && echo "selftest ok" || { echo "selftest FAIL"; exit 1; }
  exit 0
fi
VERIFIER=$(openssl rand 48 | b64url); CHALLENGE=$(pkce_challenge "$VERIFIER"); STATE=$(openssl rand -hex 8)
ENC() { python3 -c 'import sys,urllib.parse as u;print(u.quote(sys.argv[1],safe=""))' "$1"; }
echo "Mở URL này trong trình duyệt, đăng nhập (lần đầu sẽ bắt đăng ký OTP):"
echo "$BASE/auth?client_id=$CLIENT&response_type=code&scope=openid&redirect_uri=$(ENC "$REDIRECT")&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"
echo; read -r -p "Dán URL sau khi đăng nhập xong (trang 'not found' là bình thường): " URL
CODE=$(python3 -c 'import sys,urllib.parse as u;q=u.parse_qs(u.urlparse(sys.argv[1]).query);print(q.get("code",[""])[0])' "$URL")
GOT=$(python3 -c 'import sys,urllib.parse as u;q=u.parse_qs(u.urlparse(sys.argv[1]).query);print(q.get("state",[""])[0])' "$URL")
[ -n "$CODE" ] || { echo "không có code trong URL"; exit 1; }
[ "$GOT" = "$STATE" ] || { echo "state không khớp"; exit 1; }
RESP=$(curl -sS "$BASE/token" -d grant_type=authorization_code -d client_id="$CLIENT" -d code="$CODE" -d redirect_uri="$REDIRECT" -d code_verifier="$VERIFIER")
python3 - "$RESP" <<'PY'
import sys,json,base64
r=json.loads(sys.argv[1])
if "access_token" not in r: print("LỖI:", r); sys.exit(1)
p=r["access_token"].split(".")[1]; c=json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))
for k in ("iss","aud","tenant_id","org_ids","roles","acr","exp"): print(f"{k}: {c.get(k)}")
PY
