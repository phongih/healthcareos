#!/usr/bin/env python3
"""
Keycloak realm `hcos`: phạm vi theo tài khoản + claim MFA (`amr`) cho API.

  python3 idp-scope-mfa.py apply      # chạy lại được (idempotent)
  python3 idp-scope-mfa.py status     # chỉ in hiện trạng
  python3 idp-scope-mfa.py rollback   # quay về luồng `browser` mặc định + claim cố định cũ
  python3 idp-scope-mfa.py admin-client   # F21: client service-account `hcos-admin-api` cho quản trị nhân sự,
                                          # ghi HCOS_KC_ADMIN_CLIENT_SECRET vào hcos.env (KHÔNG in ra màn hình)

`apply` làm:
  1. Kiểm Keycloak có mapper `oidc-amr-mapper`.
  2. Chép luồng `browser` thành `hcos browser` (luồng có sẵn không sửa được), gắn tham chiếu AMR:
     bước mật khẩu => "pwd", bước OTP => "otp" (hiệu lực 10 giờ = 1 ca; quá hạn thì token mới không còn "otp" => API bắt đăng nhập lại).
  3. Đặt `hcos browser` làm luồng đăng nhập trình duyệt của realm.
  4. Client `hcos-web`: thêm mapper `amr`; GỠ các claim cố định `tenant_id` / `org_ids` / `org_id`
     (API tra tenant + cơ sở theo tài khoản trong DB — migration 024).
Chạy trong deploy/staging (cần secrets.env, container keycloak đang chạy). Không in mật khẩu.
"""
import json
import subprocess
import sys

REALM = 'hcos'
FLOW = 'hcos browser'
CLIENT = 'hcos-web'
MAX_AGE = '36000'
REFS = {'auth-username-password-form': 'pwd', 'auth-otp-form': 'otp'}
HARDCODED = ('tenant_id', 'org_ids', 'org_id')
LEGACY = {
    'tenant_id': ('00000000-0000-4000-8000-0000000000a1', 'String'),
    'org_ids': ('["00000000-0000-4000-8000-0000000000b1"]', 'JSON'),
    'org_id': ('00000000-0000-4000-8000-0000000000b1', 'String'),
}
BASE = ['docker', 'compose', '--env-file', 'secrets.env', 'exec', '-T', 'keycloak']


def kc(*args: str, body: object | None = None, ok_fail: bool = False) -> str:
    cmd = BASE + ['/opt/keycloak/bin/kcadm.sh', *args]
    r = subprocess.run(cmd, input=None if body is None else json.dumps(body), capture_output=True, text=True)
    if r.returncode != 0 and not ok_fail:
        sys.exit(f'kcadm {args[0]} {args[1] if len(args) > 1 else ""} lỗi: {r.stderr.strip()[:400]}')
    return r.stdout


def kj(*args: str) -> object:
    out = kc(*args)
    return json.loads(out) if out.strip() else None


def login() -> None:
    r = subprocess.run(BASE + ['sh', '-c', '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8081/auth '
                               '--realm master --user admin --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('Không đăng nhập được kcadm (kiểm tra container keycloak / KC_ADMIN_PASSWORD).')


def flow_path(alias: str) -> str:
    return 'authentication/flows/' + alias.replace(' ', '%20') + '/executions'


def client_id() -> str:
    cs = kj('get', 'clients', '-r', REALM, '-q', f'clientId={CLIENT}', '--fields', 'id,clientId')
    if not cs:
        sys.exit(f'Không thấy client {CLIENT}')
    return cs[0]['id']  # type: ignore[index]


def mappers(cid: str) -> list[dict]:
    return kj('get', f'clients/{cid}/protocol-mappers/models', '-r', REALM) or []  # type: ignore[return-value]


def status() -> None:
    realm = kj('get', f'realms/{REALM}', '--fields', 'browserFlow')
    print(f'Luồng đăng nhập trình duyệt: {realm["browserFlow"]}')  # type: ignore[index]
    flows = [f['alias'] for f in kj('get', 'authentication/flows', '-r', REALM)]  # type: ignore[union-attr]
    if FLOW in flows:
        for e in kj('get', flow_path(FLOW), '-r', REALM):  # type: ignore[union-attr]
            if e.get('providerId') in REFS:
                cfg = 'có tham chiếu AMR' if e.get('authenticationConfig') else 'CHƯA có tham chiếu AMR'
                print(f'  {e["displayName"]} ({e["providerId"]}): {cfg}')
    else:
        print(f'  Chưa có luồng "{FLOW}"')
    ms = mappers(client_id())
    print('Mapper của hcos-web: ' + ', '.join(sorted(m['name'] for m in ms)))


def apply() -> None:
    # KHÔNG dùng --fields: kcadm lọc trường làm rỗng map lồng (protocolMapperTypes.openid-connect) => báo thiếu mapper sai.
    info = kj('get', 'serverinfo')
    ids = {m['id'] for m in info['protocolMapperTypes'].get('openid-connect', [])}  # type: ignore[index]
    if not ids:
        sys.exit('Không đọc được danh sách mapper từ serverinfo — dừng, không sửa realm.')
    if 'oidc-amr-mapper' not in ids:
        sys.exit('Keycloak này không có oidc-amr-mapper — cần Keycloak có hỗ trợ AMR trước khi bật MFA ở API.')

    flows = [f['alias'] for f in kj('get', 'authentication/flows', '-r', REALM)]  # type: ignore[union-attr]
    if FLOW not in flows:
        kc('create', 'authentication/flows/browser/copy', '-r', REALM, '-f', '-', body={'newName': FLOW})
        print(f'Đã chép luồng browser => "{FLOW}"')
    seen = set()
    for e in kj('get', flow_path(FLOW), '-r', REALM):  # type: ignore[union-attr]
        ref = REFS.get(e.get('providerId'))
        if not ref:
            continue
        seen.add(e['providerId'])
        if e.get('authenticationConfig'):
            continue
        kc('create', f'authentication/executions/{e["id"]}/config', '-r', REALM, '-f', '-',
           body={'alias': f'hcos-amr-{ref}', 'config': {'default.reference.value': ref, 'default.reference.maxAge': MAX_AGE}})
        print(f'  Gắn tham chiếu AMR "{ref}" cho {e["displayName"]}')
    missing = set(REFS) - seen
    if missing:
        sys.exit(f'Luồng "{FLOW}" thiếu bước: {", ".join(sorted(missing))}')
    kc('update', f'realms/{REALM}', '-s', f'browserFlow={FLOW}')
    print(f'Luồng đăng nhập trình duyệt = "{FLOW}"')

    cid = client_id()
    ms = mappers(cid)
    if not any(m.get('protocolMapper') == 'oidc-amr-mapper' for m in ms):
        kc('create', f'clients/{cid}/protocol-mappers/models', '-r', REALM, '-f', '-', body={
            'name': 'amr', 'protocol': 'openid-connect', 'protocolMapper': 'oidc-amr-mapper',
            'config': {'access.token.claim': 'true', 'id.token.claim': 'true', 'introspection.token.claim': 'true'}})
        print('Đã thêm mapper amr')
    for m in ms:
        if m['name'] in HARDCODED and m.get('protocolMapper') == 'oidc-hardcoded-claim-mapper':
            kc('delete', f'clients/{cid}/protocol-mappers/models/{m["id"]}', '-r', REALM)
            print(f'Đã gỡ claim cố định {m["name"]}')
    status()


def rollback() -> None:
    kc('update', f'realms/{REALM}', '-s', 'browserFlow=browser')
    cid = client_id()
    ms = mappers(cid)
    names = {m['name'] for m in ms}
    for m in ms:
        if m.get('protocolMapper') == 'oidc-amr-mapper':
            kc('delete', f'clients/{cid}/protocol-mappers/models/{m["id"]}', '-r', REALM)
    for name, (value, typ) in LEGACY.items():
        if name not in names:
            kc('create', f'clients/{cid}/protocol-mappers/models', '-r', REALM, '-f', '-', body={
                'name': name, 'protocol': 'openid-connect', 'protocolMapper': 'oidc-hardcoded-claim-mapper',
                'config': {'claim.name': name, 'claim.value': value, 'jsonType.label': typ, 'access.token.claim': 'true', 'id.token.claim': 'false'}})
    print('Đã quay về luồng browser + claim cố định cũ (luồng "hcos browser" vẫn giữ, không dùng).')
    status()


ADMIN_CLIENT = 'hcos-admin-api'
ADMIN_ROLES = ('manage-users', 'view-users', 'query-users')


def admin_client() -> None:
    """Client confidential chỉ có service account; quyền realm-management tối thiểu để tạo / khoá / đặt lại user của realm hcos."""
    cs = kj('get', 'clients', '-r', REALM, '-q', f'clientId={ADMIN_CLIENT}', '--fields', 'id,clientId')
    if not cs:
        kc('create', 'clients', '-r', REALM, '-f', '-', body={
            'clientId': ADMIN_CLIENT, 'name': 'HealthcareOS API — quản trị nhân sự (service account)', 'enabled': True,
            'protocol': 'openid-connect', 'publicClient': False, 'serviceAccountsEnabled': True,
            'standardFlowEnabled': False, 'implicitFlowEnabled': False, 'directAccessGrantsEnabled': False,
            'clientAuthenticatorType': 'client-secret', 'attributes': {'access.token.lifespan': '300'},
        })
        print(f'Đã tạo client {ADMIN_CLIENT}')
        cs = kj('get', 'clients', '-r', REALM, '-q', f'clientId={ADMIN_CLIENT}', '--fields', 'id,clientId')
    cid = cs[0]['id']  # type: ignore[index]
    kc('add-roles', '-r', REALM, '--uusername', f'service-account-{ADMIN_CLIENT}', '--cclientid', 'realm-management',
       *[x for r in ADMIN_ROLES for x in ('--rolename', r)])
    print('Service account có quyền realm-management: ' + ', '.join(ADMIN_ROLES))
    secret = kj('get', f'clients/{cid}/client-secret', '-r', REALM)['value']  # type: ignore[index]
    if not secret or len(secret) < 16:
        sys.exit('Không lấy được client secret')
    env = 'hcos.env'
    lines = open(env, encoding='utf-8').read().splitlines()
    keep = [l for l in lines if not l.startswith('HCOS_KC_ADMIN_CLIENT_SECRET=')]
    keep.append(f'HCOS_KC_ADMIN_CLIENT_SECRET={secret}')
    import os
    mode = os.stat(env).st_mode & 0o777
    tmp = env + '.tmp'
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode), 'w', encoding='utf-8') as f:
        f.write('\n'.join(keep) + '\n')
    os.replace(tmp, env)
    print(f'Đã ghi HCOS_KC_ADMIN_CLIENT_SECRET vào {env} (quyền {oct(mode)}; giá trị không in ra).')


if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action not in ('apply', 'status', 'rollback', 'admin-client'):
        sys.exit(__doc__)
    login()
    {'apply': apply, 'status': status, 'rollback': rollback, 'admin-client': admin_client}[action]()
