#!/usr/bin/env python3
"""Sinh SQL (iam.users + iam.memberships) và JSON partialImport cho Keycloak từ accounts.json.

  python3 accounts.py sql                      > SQL ra stdout (chạy bằng postgres, idempotent)
  python3 accounts.py keycloak passwords.txt   > JSON ra stdout (đưa thẳng vào kcadm qua pipe, không ghi đĩa)

passwords.txt: mỗi dòng `username=mật_khẩu_tạm`. Mật khẩu là tạm: người dùng phải đổi và cài TOTP ở lần đăng nhập đầu.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ROLES = {"doctor", "pharmacist", "clinic_staff", "cashier", "clinic_admin", "pharmacy_admin", "executive", "tenant_admin"}


def load():
    with open(os.path.join(HERE, "accounts.json"), encoding="utf-8") as f:
        d = json.load(f)
    for k in ("tenantId", "organizationId"):
        assert UUID.match(d[k]), k
    seen = set()
    for a in d["accounts"]:
        assert re.match(r"^tt\.[a-z0-9]+$", a["username"]), a["username"]
        assert UUID.match(a["id"]) and a["id"] not in seen, a["id"]
        seen.add(a["id"])
        assert a["roles"] and set(a["roles"]) <= ROLES, a["roles"]
    return d


def q(s):
    return "'" + s.replace("'", "''") + "'"


def sql(d):
    t, o = d["tenantId"], d["organizationId"]
    out = ["-- STAGING / THỰC TẬP — sinh từ accounts.json. Idempotent.", "BEGIN;"]
    o2 = d.get("secondOrganization")
    if o2:
        # Cơ sở thứ 2 (thực tập): phạm vi cơ sở lấy theo membership trong DB, không theo claim cố định.
        out.append(
            "INSERT INTO iam.organizations (organization_id, tenant_id, type, code, name) VALUES "
            f"({q(o2['id'])}, {q(t)}, 'clinic', {q(o2['code'])}, {q(o2['name'])}) ON CONFLICT DO NOTHING;"
        )
    for a in d["accounts"]:
        out.append(
            "INSERT INTO iam.users (user_id, tenant_id, external_subject, email, display_name) VALUES "
            f"({q(a['id'])}, {q(t)}, {q(a['id'])}, {q(a['username'] + '@example.invalid')}, {q(a['displayName'])}) ON CONFLICT DO NOTHING;"
        )
        out.append(
            f"UPDATE iam.users SET username = {q(a['username'])} WHERE tenant_id = {q(t)} AND user_id = {q(a['id'])} AND username IS NULL;"
        )
        # Chỉ cấp khi CHƯA TỪNG có membership này (kể cả đã thu hồi): chạy lại script không cấp lại quyền quản trị đã thu hồi.
        o2 = d.get("secondOrganization")
        grants = [(o, r) for r in a["roles"]] + ([(o2["id"], r) for r in a.get("rolesAtSecond", [])] if o2 else [])
        for org, r in grants:
            out.append(
                "INSERT INTO iam.memberships (tenant_id, user_id, organization_id, role) "
                f"SELECT {q(t)}, {q(a['id'])}, {q(org)}, {q(r)} WHERE NOT EXISTS (SELECT 1 FROM iam.memberships "
                f"WHERE tenant_id = {q(t)} AND user_id = {q(a['id'])} AND organization_id = {q(org)} AND role = {q(r)});"
            )
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


def keycloak(d, pwfile):
    pw = {}
    with open(pwfile, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                u, p = line.split("=", 1)
                pw[u] = p
    users = []
    for a in d["accounts"]:
        if a["username"] not in pw:
            sys.exit(f"thiếu mật khẩu cho {a['username']}")
        users.append({
            "id": a["id"],
            "username": a["username"],
            "enabled": True,
            "emailVerified": True,
            "email": a["username"] + "@example.invalid",
            # Hồ sơ người dùng mặc định của Keycloak cấm "()" trong tên: bỏ phần chú thích vai trò.
            "firstName": re.sub(r"\s*\(.*?\)", "", a["displayName"]).strip(),
            "lastName": "Thực tập",
            "credentials": [{"type": "password", "value": pw[a["username"]], "temporary": True}],
            "realmRoles": [a["realmRole"]],
            "requiredActions": ["CONFIGURE_TOTP", "UPDATE_PASSWORD"],
        })
    return json.dumps({"ifResourceExists": "SKIP", "users": users}, ensure_ascii=False)


if __name__ == "__main__":
    d = load()
    if sys.argv[1:2] == ["sql"]:
        sys.stdout.write(sql(d))
    elif sys.argv[1:2] == ["keycloak"] and len(sys.argv) == 3:
        sys.stdout.write(keycloak(d, sys.argv[2]))
    elif sys.argv[1:2] == ["usernames"]:
        print("\n".join(a["username"] for a in d["accounts"]))
    elif sys.argv[1:2] == ["list"]:
        for a in d["accounts"]:
            print(f"{a['username']:<15} {', '.join(a['roles']):<28} {a['displayName']}")
    else:
        sys.exit(__doc__)
