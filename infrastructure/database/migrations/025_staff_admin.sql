-- HCOS-F21 | Quản trị nhân sự & cơ sở: tài khoản nhân viên, cấp / thu hồi vai trò tại cơ sở, tạo cơ sở.
--  - iam.users.username: tên đăng nhập ở IdP (Keycloak), để tìm / hiển thị; định danh thật vẫn là external_subject (= sub).
--  - iam.memberships: người cấp, người / lúc / lý do thu hồi. Thu hồi là CUỐI CÙNG (cấp lại = membership mới),
--    nên bỏ UNIQUE toàn phần (user, cơ sở, vai trò) và chỉ giữ duy nhất trong các membership đang hiệu lực.

ALTER TABLE iam.users ADD COLUMN username text
  CONSTRAINT users_username_ck CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,63}$');
CREATE UNIQUE INDEX users_tenant_username_uk ON iam.users (tenant_id, username) WHERE username IS NOT NULL;

ALTER TABLE iam.memberships
  ADD COLUMN granted_by    uuid,
  ADD COLUMN revoked_by    uuid,
  ADD COLUMN revoked_at    timestamptz,
  ADD COLUMN revoke_reason text CONSTRAINT memberships_revoke_reason_ck CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 300),
  ADD CONSTRAINT memberships_granted_by_fk FOREIGN KEY (tenant_id, granted_by) REFERENCES iam.users (tenant_id, user_id),
  ADD CONSTRAINT memberships_revoked_by_fk FOREIGN KEY (tenant_id, revoked_by) REFERENCES iam.users (tenant_id, user_id);

ALTER TABLE iam.memberships DROP CONSTRAINT memberships_user_org_role_uk;
CREATE UNIQUE INDEX memberships_active_uk ON iam.memberships (tenant_id, user_id, organization_id, role) WHERE status = 'active';

-- Khoá / vai trò / cơ sở / người của một membership không đổi được; thu hồi là cuối cùng.
CREATE FUNCTION iam.memberships_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.user_id, NEW.organization_id, NEW.role, NEW.granted_by) IS DISTINCT FROM (OLD.tenant_id, OLD.user_id, OLD.organization_id, OLD.role, OLD.granted_by) THEN
    RAISE EXCEPTION 'membership user / organization / role / grantor are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked' OR (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason, NEW.valid_to) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason, OLD.valid_to)) THEN
    RAISE EXCEPTION 'revoked membership is final (grant a new membership instead)' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'revoked' AND OLD.status <> 'revoked' THEN
    NEW.revoked_at := COALESCE(NEW.revoked_at, now());
    NEW.valid_to := LEAST(COALESCE(NEW.valid_to, NEW.revoked_at), NEW.revoked_at);
  ELSIF NEW.status <> 'revoked' AND (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason) THEN
    RAISE EXCEPTION 'revocation fields are set only when revoking' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER memberships_guard BEFORE UPDATE ON iam.memberships FOR EACH ROW EXECUTE FUNCTION iam.memberships_guard();
