-- HCOS | Màn duyệt tổ chức (thiết kế 27/11/2026, mục 4): người vận hành (platform.operators) duyệt hoặc từ chối.
--  - iam.tenants: lưu số điện thoại liên hệ (để đối chiếu với tên và giấy phép khi duyệt tay), người duyệt, thời điểm, lý do.
--  - iam.signup_complete: ghi thêm giấy phép và điện thoại khi tạo tổ chức (chữ ký không đổi).
--  - platform.review_list / platform.review_decide: SECURITY DEFINER; luôn kiểm tra platform.is_operator trước.
--    Duyệt: 'provisioning' -> 'active'. Từ chối: 'provisioning' -> 'closed' (bắt buộc có lý do).
--    Đây là lúc tổ chức được phép mở cơ sở (wizard); chưa nhận bệnh nhân thật cho đến khi có giấy phép khám chữa bệnh.

ALTER TABLE iam.tenants
  ADD COLUMN contact_phone text CHECK (contact_phone IS NULL OR length(trim(contact_phone)) BETWEEN 8 AND 20),
  ADD COLUMN reviewed_by   text CHECK (reviewed_by IS NULL OR length(trim(reviewed_by)) > 0),
  ADD COLUMN reviewed_at   timestamptz,
  ADD COLUMN review_note   text CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 1 AND 500);

-- Cùng chữ ký với 029; chỉ thêm giấy phép và điện thoại vào tổ chức mới.
CREATE OR REPLACE FUNCTION iam.signup_complete(p_signup_id uuid, p_subject text)
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

  INSERT INTO iam.tenants (code, name, status, slug, business_license_no, contact_phone)
  VALUES (r.slug, r.org_name, 'provisioning', r.slug, r.business_license_no, r.phone)
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

-- Danh sách tổ chức chờ duyệt cho người vận hành.
CREATE FUNCTION platform.review_list(p_operator text)
  RETURNS TABLE (tenant_id uuid, name text, slug text, business_license_no text, contact_phone text,
                 admin_name text, admin_email text, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT platform.is_operator(p_operator) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.tenant_id, t.name, t.slug, t.business_license_no, t.contact_phone,
           u.display_name, u.email, t.created_at
      FROM iam.tenants t
      LEFT JOIN LATERAL (
        SELECT us.display_name, us.email
          FROM iam.memberships m
          JOIN iam.users us ON us.user_id = m.user_id AND us.tenant_id = m.tenant_id
         WHERE m.tenant_id = t.tenant_id AND m.role = 'tenant_admin'
         ORDER BY m.created_at
         LIMIT 1) u ON true
     WHERE t.status = 'provisioning'
     ORDER BY t.created_at;
END
$$;

-- Duyệt ('approve') hoặc từ chối ('reject', cần lý do). Trả 'OK' hoặc 'NOT_PENDING'.
CREATE FUNCTION platform.review_decide(p_operator text, p_tenant_id uuid, p_decision text, p_note text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT platform.is_operator(p_operator) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'reject' AND length(trim(coalesce(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT t.status INTO v_status FROM iam.tenants t WHERE t.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'provisioning' THEN
    RETURN 'NOT_PENDING';
  END IF;

  UPDATE iam.tenants t
     SET status      = CASE WHEN p_decision = 'approve' THEN 'active' ELSE 'closed' END,
         reviewed_by = p_operator,
         reviewed_at = now(),
         review_note = CASE WHEN p_decision = 'reject' THEN trim(p_note) ELSE NULL END,
         updated_at  = now(),
         version     = t.version + 1
   WHERE t.tenant_id = p_tenant_id;
  RETURN 'OK';
END
$$;

REVOKE ALL ON FUNCTION platform.review_list(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.review_decide(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.review_list(text), platform.review_decide(text, uuid, text, text) TO hcos_app, hcos_provisioner;
