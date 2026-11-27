-- HCOS | Đăng ký khách: hoàn tất đăng ký (thiết kế 27/11/2026, mục 4 và 6; người duyệt: ceo@smart.id.vn).
--  - Thêm họ tên người đăng ký (contact_name) vào yêu cầu; signup_start nhận thêm tham số này.
--  - iam.signup_identity: đọc thông tin yêu cầu đã xác minh (không có OTP).
--  - iam.signup_complete: sau khi IdP đã tạo tài khoản (sub), tạo tổ chức ở trạng thái 'provisioning' (= chờ duyệt),
--    cơ sở trụ sở, tài khoản và membership tenant_admin tạm thời, rồi đánh dấu yêu cầu 'consumed'. Chạy một giao dịch.
--  - platform.operators: người vận hành có quyền duyệt tổ chức (không gắn tenant). Chỉ hcos_provisioner ghi.

ALTER TABLE iam.signup_requests
  ADD COLUMN contact_name text CHECK (contact_name IS NULL OR length(trim(contact_name)) BETWEEN 2 AND 80);

-- Thay chữ ký iam.signup_start (027): thêm p_contact_name cuối cùng. Chỉ hcos_app được gọi.
DROP FUNCTION iam.signup_start(text, text, text, text, text, text, interval, inet);

CREATE FUNCTION iam.signup_start(
  p_email text, p_org_name text, p_phone text, p_license text, p_slug text,
  p_otp_hash text, p_otp_ttl interval, p_ip inet, p_contact_name text)
  RETURNS TABLE (signup_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id  uuid;
  v_exp timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('signup:' || p_email));

  IF (SELECT count(*) FROM iam.signup_requests r
       WHERE r.email = p_email AND r.created_at > now() - interval '1 hour') >= 3 THEN
    RAISE EXCEPTION 'SIGNUP_RATE_LIMITED_EMAIL' USING ERRCODE = 'P0001';
  END IF;

  IF p_ip IS NOT NULL AND (SELECT count(*) FROM iam.signup_requests r
       WHERE r.client_ip = p_ip AND r.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'SIGNUP_RATE_LIMITED_IP' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM iam.tenants t WHERE t.slug = p_slug)
     OR EXISTS (SELECT 1 FROM iam.slug_redirects r WHERE r.old_slug = p_slug AND r.expires_at > now()) THEN
    RAISE EXCEPTION 'SLUG_TAKEN' USING ERRCODE = '23505';
  END IF;

  INSERT INTO iam.signup_requests (email, org_name, phone, business_license_no, slug, otp_hash, otp_expires_at, client_ip, contact_name)
  VALUES (p_email, p_org_name, p_phone, p_license, p_slug, p_otp_hash, now() + p_otp_ttl, p_ip, p_contact_name)
  RETURNING iam.signup_requests.signup_id, iam.signup_requests.otp_expires_at INTO v_id, v_exp;

  RETURN QUERY SELECT v_id, v_exp;
END
$$;

REVOKE ALL ON FUNCTION iam.signup_start(text, text, text, text, text, text, interval, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.signup_start(text, text, text, text, text, text, interval, inet, text) TO hcos_app;

-- Thông tin cần cho bước tạo tài khoản IdP. Không trả OTP.
CREATE FUNCTION iam.signup_identity(p_signup_id uuid)
  RETURNS TABLE (email text, contact_name text, org_name text, slug text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT r.email, r.contact_name, r.org_name, r.slug, r.status
    FROM iam.signup_requests r
   WHERE r.signup_id = p_signup_id
$$;

-- Hoàn tất: chỉ khi yêu cầu đã 'verified' và chưa quá 30 phút sau khi mã hết hạn.
-- Email lấy từ yêu cầu (không lấy từ tham số), sub là định danh do IdP vừa tạo.
CREATE FUNCTION iam.signup_complete(p_signup_id uuid, p_subject text)
  RETURNS TABLE (tenant_id uuid, slug text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r      iam.signup_requests%ROWTYPE;
  v_ten  uuid;
  v_org  uuid;
  v_user uuid;
BEGIN
  SELECT * INTO r FROM iam.signup_requests s WHERE s.signup_id = p_signup_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'verified' THEN
    RAISE EXCEPTION 'SIGNUP_NOT_VERIFIED' USING ERRCODE = 'P0001';
  END IF;
  IF r.otp_expires_at < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'SIGNUP_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF r.contact_name IS NULL THEN
    RAISE EXCEPTION 'SIGNUP_NOT_VERIFIED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO iam.tenants (code, name, status, slug)
  VALUES (r.slug, r.org_name, 'provisioning', r.slug)
  RETURNING iam.tenants.tenant_id INTO v_ten;

  INSERT INTO iam.organizations (tenant_id, type, code, name)
  VALUES (v_ten, 'headquarters', 'hq', r.org_name)
  RETURNING iam.organizations.organization_id INTO v_org;

  INSERT INTO iam.users (tenant_id, external_subject, email, display_name, status)
  VALUES (v_ten, p_subject, r.email, r.contact_name, 'active')
  RETURNING iam.users.user_id INTO v_user;

  INSERT INTO iam.memberships (tenant_id, user_id, organization_id, role, status)
  VALUES (v_ten, v_user, v_org, 'tenant_admin', 'active');

  UPDATE iam.signup_requests s SET status = 'consumed' WHERE s.signup_id = p_signup_id;

  RETURN QUERY SELECT v_ten, r.slug;
END
$$;

REVOKE ALL ON FUNCTION iam.signup_identity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.signup_complete(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.signup_identity(uuid), iam.signup_complete(uuid, text) TO hcos_app;

-- Người vận hành nền tảng (duyệt tổ chức). Không gắn tenant; định danh là sub của IdP.
CREATE TABLE platform.operators (
  external_subject text        PRIMARY KEY CHECK (length(trim(external_subject)) > 0),
  granted_by       text        NOT NULL CHECK (length(trim(granted_by)) > 0),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  active           boolean     NOT NULL DEFAULT true
);

ALTER TABLE platform.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.operators FORCE ROW LEVEL SECURITY;
CREATE POLICY provisioner_all ON platform.operators TO hcos_provisioner USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.operators TO hcos_provisioner;

CREATE FUNCTION platform.is_operator(p_subject text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM platform.operators o WHERE o.external_subject = p_subject AND o.active)
$$;

REVOKE ALL ON FUNCTION platform.is_operator(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.is_operator(text) TO hcos_app, hcos_provisioner;
