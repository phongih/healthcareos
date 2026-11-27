-- HCOS | Đăng ký khách: hàm truy cập iam.signup_requests (thiết kế 27/11/2026, mục 4 và 5).
-- Ứng dụng chỉ kết nối bằng hcos_app, nên bảng signup_requests không được cấp quyền cho hcos_app;
-- thay vào đó các thao tác đăng ký chạy qua hàm SECURITY DEFINER (cùng mẫu với iam.tenants_for_subject và iam.resolve_slug).
--  - iam.signup_start: kiểm giới hạn tần suất (email 3/giờ, IP 10/giờ) và slug trống, rồi ghi yêu cầu. Lỗi trả mã rõ ràng.
--  - iam.signup_otp_state: đọc trạng thái OTP để app so khớp (app không nhận mã OTP dạng rõ từ DB).
--  - iam.signup_check_otp: ghi kết quả so khớp: đúng => verified; sai => tăng số lần; đủ 5 lần sai hoặc hết hạn => expired.
-- Khoá theo email (advisory lock) để hai yêu cầu đồng thời không vượt giới hạn.

CREATE FUNCTION iam.signup_start(
  p_email text, p_org_name text, p_phone text, p_license text, p_slug text,
  p_otp_hash text, p_otp_ttl interval, p_ip inet)
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

  INSERT INTO iam.signup_requests (email, org_name, phone, business_license_no, slug, otp_hash, otp_expires_at, client_ip)
  VALUES (p_email, p_org_name, p_phone, p_license, p_slug, p_otp_hash, now() + p_otp_ttl, p_ip)
  RETURNING iam.signup_requests.signup_id, iam.signup_requests.otp_expires_at INTO v_id, v_exp;

  RETURN QUERY SELECT v_id, v_exp;
END
$$;

CREATE FUNCTION iam.signup_otp_state(p_signup_id uuid)
  RETURNS TABLE (otp_hash text, otp_expires_at timestamptz, otp_attempts integer, status text, slug text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT r.otp_hash, r.otp_expires_at, r.otp_attempts, r.status, r.slug
    FROM iam.signup_requests r
   WHERE r.signup_id = p_signup_id
$$;

-- Kết quả: 'OK' | 'WRONG' | 'LOCKED' (đủ 5 lần sai) | 'EXPIRED' | 'NOT_PENDING'.
CREATE FUNCTION iam.signup_check_otp(p_signup_id uuid, p_ok boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r iam.signup_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM iam.signup_requests WHERE signup_id = p_signup_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'NOT_PENDING';
  END IF;
  IF r.status <> 'pending' THEN
    RETURN 'NOT_PENDING';
  END IF;
  IF now() > r.otp_expires_at THEN
    UPDATE iam.signup_requests SET status = 'expired' WHERE signup_id = p_signup_id;
    RETURN 'EXPIRED';
  END IF;
  IF p_ok THEN
    UPDATE iam.signup_requests SET status = 'verified', verified_at = now() WHERE signup_id = p_signup_id;
    RETURN 'OK';
  END IF;
  IF r.otp_attempts + 1 >= 5 THEN
    UPDATE iam.signup_requests SET otp_attempts = otp_attempts + 1, status = 'expired' WHERE signup_id = p_signup_id;
    RETURN 'LOCKED';
  END IF;
  UPDATE iam.signup_requests SET otp_attempts = otp_attempts + 1 WHERE signup_id = p_signup_id;
  RETURN 'WRONG';
END
$$;

REVOKE ALL ON FUNCTION iam.signup_start(text, text, text, text, text, text, interval, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.signup_otp_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.signup_check_otp(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.signup_start(text, text, text, text, text, text, interval, inet) TO hcos_app;
GRANT EXECUTE ON FUNCTION iam.signup_otp_state(uuid) TO hcos_app;
GRANT EXECUTE ON FUNCTION iam.signup_check_otp(uuid, boolean) TO hcos_app;
