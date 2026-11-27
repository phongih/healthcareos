-- HCOS | Đăng ký khách & đường dẫn tổ chức (thiết kế 27/11/2026: claude/Thiet_ke_mo_co_so_duong_dan_va_dang_ky.md).
--  - iam.tenants.slug: đường dẫn /app/<slug>, duy nhất toàn hệ thống; NULL cho tổ chức có sẵn (đặt sau).
--    Slug chỉ là điểm vào, không cấp quyền: quyền vẫn do membership quyết định.
--  - Chờ duyệt dùng lại status 'provisioning' có sẵn (không thêm trạng thái mới).
--  - Giấy phép: business_license_no (nhập khi đăng ký); medical_license_no + medical_license_status
--    ('none' | 'pending' | 'approved' | 'rejected'). Chưa 'approved' => chưa nhận bệnh nhân thật (kiểm ở API).
--  - iam.slug_redirects: slug cũ chuyển hướng 90 ngày; trong thời gian đó slug không cấp cho tổ chức khác.
--  - iam.signup_requests: yêu cầu đăng ký công khai (OTP băm). Không có tenant context => chỉ hcos_provisioner.
--  - iam.resolve_slug(): hàm công khai, chỉ trả tenant_id, tên hiển thị, trạng thái, có phải chuyển hướng không.

-- 1. Cột và ràng buộc trên tổ chức
ALTER TABLE iam.tenants
  ADD COLUMN slug                    text,
  ADD COLUMN business_license_no     text,
  ADD COLUMN medical_license_no      text,
  ADD COLUMN medical_license_status  text NOT NULL DEFAULT 'none'
    CONSTRAINT tenants_medical_license_status_ck CHECK (medical_license_status IN ('none', 'pending', 'approved', 'rejected')),
  ADD CONSTRAINT tenants_slug_fmt CHECK (
    slug IS NULL OR (
      slug ~ '^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$'
      AND slug NOT IN ('app', 'api', 'auth', 'admin', 'www', 'login', 'portal', 'fhir', 'healthz', 'readyz',
                       'opsstatus', 'static', 'support', 'help', 'mail')
    )),
  ADD CONSTRAINT tenants_slug_uk UNIQUE (slug),
  ADD CONSTRAINT tenants_business_license_fmt CHECK (business_license_no IS NULL OR length(btrim(business_license_no)) BETWEEN 5 AND 40),
  ADD CONSTRAINT tenants_medical_license_fmt CHECK (medical_license_no IS NULL OR length(btrim(medical_license_no)) BETWEEN 5 AND 40),
  ADD CONSTRAINT tenants_medical_license_pair_ck CHECK (medical_license_status = 'none' OR medical_license_no IS NOT NULL);

-- 2. Slug cũ chuyển hướng 90 ngày
CREATE TABLE iam.slug_redirects (
  old_slug    text        PRIMARY KEY CONSTRAINT slug_redirects_fmt CHECK (old_slug ~ '^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$'),
  tenant_id   uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  CONSTRAINT slug_redirects_expiry_ck CHECK (expires_at > created_at)
);

-- Đổi slug: ghi slug cũ vào slug_redirects (SECURITY DEFINER để không cần cấp quyền ghi cho hcos_app).
CREATE FUNCTION iam.slug_change_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Slug còn trong thời gian chuyển hướng của tổ chức khác => không cấp.
  IF NEW.slug IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug AND EXISTS (
       SELECT 1 FROM iam.slug_redirects r
        WHERE r.old_slug = NEW.slug AND r.expires_at > now() AND r.tenant_id <> NEW.tenant_id) THEN
    RAISE EXCEPTION 'slug is reserved by a redirect' USING ERRCODE = '23505';
  END IF;
  IF OLD.slug IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    INSERT INTO iam.slug_redirects (old_slug, tenant_id) VALUES (OLD.slug, NEW.tenant_id)
    ON CONFLICT (old_slug) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id, created_at = now(), expires_at = now() + interval '90 days';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION iam.slug_change_guard() FROM PUBLIC;
CREATE TRIGGER tenants_slug_change_guard BEFORE UPDATE OF slug ON iam.tenants
  FOR EACH ROW EXECUTE FUNCTION iam.slug_change_guard();

-- 3. Yêu cầu đăng ký công khai (chưa có tenant)
CREATE TABLE iam.signup_requests (
  signup_id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text        NOT NULL CONSTRAINT signup_requests_email_ck CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  org_name             text        NOT NULL CONSTRAINT signup_requests_org_name_ck CHECK (length(btrim(org_name)) BETWEEN 2 AND 200),
  phone                text        NOT NULL CONSTRAINT signup_requests_phone_ck CHECK (phone ~ '^\+?[0-9 ]{8,20}$'),
  business_license_no  text        NOT NULL CONSTRAINT signup_requests_license_ck CHECK (length(btrim(business_license_no)) BETWEEN 5 AND 40),
  slug                 text        NOT NULL CONSTRAINT signup_requests_slug_ck CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$'),
  otp_hash             text        NOT NULL,
  otp_expires_at       timestamptz NOT NULL,
  otp_attempts         integer     NOT NULL DEFAULT 0 CONSTRAINT signup_requests_attempts_ck CHECK (otp_attempts BETWEEN 0 AND 5),
  status               text        NOT NULL DEFAULT 'pending'
    CONSTRAINT signup_requests_status_ck CHECK (status IN ('pending', 'verified', 'consumed', 'expired')),
  client_ip            inet,
  created_at           timestamptz NOT NULL DEFAULT now(),
  verified_at          timestamptz
);
-- Giới hạn tốc độ: đếm yêu cầu theo email và theo IP trong cửa sổ thời gian.
CREATE INDEX signup_requests_email_idx ON iam.signup_requests (email, created_at);
CREATE INDEX signup_requests_ip_idx ON iam.signup_requests (client_ip, created_at);

-- 4. Hàm công khai tra slug (không lộ danh sách cơ sở, nhân viên, hay dữ liệu bệnh nhân)
CREATE FUNCTION iam.resolve_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid, display_name text, status text, is_redirect boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT t.tenant_id, t.name, t.status, false
    FROM iam.tenants t
   WHERE t.slug = p_slug
  UNION ALL
  SELECT t.tenant_id, t.name, t.status, true
    FROM iam.slug_redirects r JOIN iam.tenants t ON t.tenant_id = r.tenant_id
   WHERE r.old_slug = p_slug AND r.expires_at > now()
     AND NOT EXISTS (SELECT 1 FROM iam.tenants x WHERE x.slug = p_slug)
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION iam.resolve_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.resolve_slug(text) TO hcos_app, hcos_provisioner;

-- 5. RLS + quyền
ALTER TABLE iam.slug_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.slug_redirects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON iam.slug_redirects TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
CREATE POLICY provisioner_all ON iam.slug_redirects TO hcos_provisioner USING (true) WITH CHECK (true);
GRANT SELECT ON iam.slug_redirects TO hcos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.slug_redirects TO hcos_provisioner;

ALTER TABLE iam.signup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.signup_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY provisioner_all ON iam.signup_requests TO hcos_provisioner USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON iam.signup_requests TO hcos_provisioner;
REVOKE ALL ON iam.signup_requests FROM PUBLIC, hcos_app;
