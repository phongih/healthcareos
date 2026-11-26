-- HCOS: tenant / cơ sở THEO TỪNG TÀI KHOẢN (bỏ claim tenant_id / org_ids cố định ở IdP).
-- API tra tenant của `sub` (đã xác thực chữ ký) qua hàm này, rồi đọc membership dưới RLS của tenant đó.
-- Chỉ trả tenant đang 'active' mà user ở trạng thái 'active'. Nhiều hơn một tenant => API yêu cầu claim tenant_id (fail-closed).

CREATE FUNCTION iam.tenants_for_subject(p_subject text) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT u.tenant_id
    FROM iam.users u JOIN iam.tenants t ON t.tenant_id = u.tenant_id
   WHERE u.external_subject = p_subject AND u.status = 'active' AND t.status = 'active'
   ORDER BY u.tenant_id
   LIMIT 2
$$;
REVOKE ALL ON FUNCTION iam.tenants_for_subject(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.tenants_for_subject(text) TO hcos_app;

-- Tra theo sub trên mọi tenant cần chỉ mục riêng (UNIQUE hiện có bắt đầu bằng tenant_id).
CREATE INDEX users_external_subject_idx ON iam.users (external_subject);
