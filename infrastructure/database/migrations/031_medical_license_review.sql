-- HCOS | Giấy phép khám chữa bệnh (thiết kế 27/11/2026, mục 1 và 4; bước 2 và 3 của kế hoạch giấy phép).
--  - tenant_admin của tổ chức đã duyệt nộp số giấy phép khám chữa bệnh: none|rejected|pending -> pending.
--    Tổ chức đã approved không đổi số qua đường này (cần thao tác riêng của vận hành).
--  - Người vận hành (platform.operators) duyệt hoặc từ chối: pending -> approved | rejected (từ chối cần lý do).
--  - Cổng bệnh nhân thật (medical-license-gate) chỉ mở khi medical_license_status = 'approved'. Không đổi cổng ở đây.
--  - Các hàm SECURITY DEFINER luôn kiểm tra quyền trong DB (membership tenant_admin / platform.is_operator).

ALTER TABLE iam.tenants
  ADD COLUMN medical_license_submitted_at timestamptz,
  ADD COLUMN medical_license_reviewed_by  text CHECK (medical_license_reviewed_by IS NULL OR length(trim(medical_license_reviewed_by)) > 0),
  ADD COLUMN medical_license_reviewed_at  timestamptz,
  ADD COLUMN medical_license_note         text CHECK (medical_license_note IS NULL OR length(trim(medical_license_note)) BETWEEN 1 AND 500);

-- Trạng thái giấy phép của chính tổ chức mà người gọi là tenant_admin (đọc cho màn Nhân sự).
CREATE FUNCTION iam.medical_license_state(p_subject text, p_tenant_id uuid)
  RETURNS TABLE (status text, license_no text, note text, submitted_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM iam.memberships m
      JOIN iam.users u ON u.user_id = m.user_id AND u.tenant_id = m.tenant_id
     WHERE m.tenant_id = p_tenant_id AND u.external_subject = p_subject
       AND u.status = 'active' AND m.role = 'tenant_admin' AND m.status = 'active') THEN
    RAISE EXCEPTION 'NOT_TENANT_ADMIN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.medical_license_status, t.medical_license_no, t.medical_license_note, t.medical_license_submitted_at
      FROM iam.tenants t WHERE t.tenant_id = p_tenant_id;
END
$$;

-- Nộp hoặc nộp lại số giấy phép. Trả 'OK'.
CREATE FUNCTION iam.submit_medical_license(p_subject text, p_tenant_id uuid, p_license_no text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_no     text := btrim(coalesce(p_license_no, ''));
  v_status text;
  v_tstat  text;
BEGIN
  IF length(v_no) NOT BETWEEN 5 AND 40 THEN
    RAISE EXCEPTION 'INVALID_LICENSE_NO' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM iam.memberships m
      JOIN iam.users u ON u.user_id = m.user_id AND u.tenant_id = m.tenant_id
     WHERE m.tenant_id = p_tenant_id AND u.external_subject = p_subject
       AND u.status = 'active' AND m.role = 'tenant_admin' AND m.status = 'active') THEN
    RAISE EXCEPTION 'NOT_TENANT_ADMIN' USING ERRCODE = '42501';
  END IF;

  SELECT t.status, t.medical_license_status INTO v_tstat, v_status
    FROM iam.tenants t WHERE t.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR v_tstat <> 'active' THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'approved' THEN
    RAISE EXCEPTION 'ALREADY_APPROVED' USING ERRCODE = '22023';
  END IF;

  UPDATE iam.tenants t
     SET medical_license_no           = v_no,
         medical_license_status       = 'pending',
         medical_license_submitted_at = now(),
         medical_license_reviewed_by  = NULL,
         medical_license_reviewed_at  = NULL,
         medical_license_note         = NULL,
         updated_at                   = now(),
         version                      = t.version + 1
   WHERE t.tenant_id = p_tenant_id;
  RETURN 'OK';
END
$$;

-- Danh sách giấy phép khám chữa bệnh chờ duyệt cho người vận hành.
CREATE FUNCTION platform.license_list(p_operator text)
  RETURNS TABLE (tenant_id uuid, name text, slug text, medical_license_no text, contact_phone text, submitted_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT platform.is_operator(p_operator) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.tenant_id, t.name, t.slug, t.medical_license_no, t.contact_phone, t.medical_license_submitted_at
      FROM iam.tenants t
     WHERE t.status = 'active' AND t.medical_license_status = 'pending'
     ORDER BY t.medical_license_submitted_at NULLS LAST, t.created_at;
END
$$;

-- Duyệt ('approve') hoặc từ chối ('reject', cần lý do). Trả 'OK' hoặc 'NOT_PENDING'.
CREATE FUNCTION platform.license_decide(p_operator text, p_tenant_id uuid, p_decision text, p_note text)
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

  SELECT t.medical_license_status INTO v_status FROM iam.tenants t WHERE t.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'pending' THEN
    RETURN 'NOT_PENDING';
  END IF;

  UPDATE iam.tenants t
     SET medical_license_status      = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
         medical_license_reviewed_by = p_operator,
         medical_license_reviewed_at = now(),
         medical_license_note        = CASE WHEN p_decision = 'reject' THEN trim(p_note) ELSE NULL END,
         updated_at                  = now(),
         version                     = t.version + 1
   WHERE t.tenant_id = p_tenant_id;
  RETURN 'OK';
END
$$;

REVOKE ALL ON FUNCTION iam.medical_license_state(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.submit_medical_license(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.license_list(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.license_decide(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.medical_license_state(text, uuid), iam.submit_medical_license(text, uuid, text) TO hcos_app;
GRANT EXECUTE ON FUNCTION platform.license_list(text), platform.license_decide(text, uuid, text, text) TO hcos_app, hcos_provisioner;
