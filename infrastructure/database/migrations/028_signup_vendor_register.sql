-- HCOS | Đăng ký khách: danh mục vendor cấp nền tảng cho kênh OTP (quyết định F18, thiết kế 27/11/2026, mục 6).
-- Đăng ký chạy trước khi có tenant nên không thể dùng governance.vendor_cleared (gắn tenant).
-- Mỗi kênh gửi OTP phải có một dòng được duyệt, còn hiệu lực và chưa quá hạn xét lại.
-- Không có dòng nào được thêm tự động: người duyệt ghi dòng bằng hcos_provisioner (fail-closed).
--  - Ứng dụng (hcos_app) chỉ gọi platform.signup_channel_cleared để hỏi, không đọc được bảng.

CREATE TABLE platform.signup_vendors (
  vendor      text        NOT NULL CHECK (length(trim(vendor)) BETWEEN 1 AND 255),
  category    text        NOT NULL CHECK (category IN ('signup_otp_email')),
  cleared_by  text        NOT NULL CHECK (length(trim(cleared_by)) > 0),
  cleared_at  timestamptz NOT NULL DEFAULT now(),
  review_due  timestamptz NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  PRIMARY KEY (vendor, category),
  CHECK (review_due > cleared_at)
);

ALTER TABLE platform.signup_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.signup_vendors FORCE ROW LEVEL SECURITY;
CREATE POLICY provisioner_all ON platform.signup_vendors TO hcos_provisioner USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.signup_vendors TO hcos_provisioner;

CREATE FUNCTION platform.signup_channel_cleared(p_category text, p_vendor text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform.signup_vendors v
     WHERE v.category = p_category
       AND v.vendor = p_vendor
       AND v.active
       AND v.review_due > now())
$$;

REVOKE ALL ON FUNCTION platform.signup_channel_cleared(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.signup_channel_cleared(text, text) TO hcos_app, hcos_provisioner;
