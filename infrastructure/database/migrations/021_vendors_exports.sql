-- HCOS-F18 — Trách nhiệm bên thứ ba & xuất dữ liệu.
--
--  * Sổ nhà cung cấp (governance.vendors) + đánh giá chỉ-thêm (governance.vendor_assessments): thoả thuận xử lý dữ liệu,
--    nơi lưu trữ, chuyển ra nước ngoài, LOẠI DỮ LIỆU được phép nhận, biện pháp bảo vệ, hiệu lực (tối đa 3 năm => đánh giá lại).
--  * Kết nối ngoài (F12) phải gắn một nhà cung cấp; CHỈ gửi khi nhà cung cấp đang hoạt động và có đánh giá 'approved'
--    còn hiệu lực cho loại dữ liệu của sự kiện. Kiểm tra ở CSDL lúc xếp hàng VÀ lúc gửi (hết hạn / thu hồi => ngừng ngay).
--  * Dịch vụ AI (kind = 'ai_service') KHÔNG BAO GIỜ được duyệt nhận dữ liệu cá nhân / sức khoẻ (CSDL chặn).
--  * Nhật ký xuất dữ liệu (governance.data_exports, chỉ-thêm): mọi file xuất do máy chủ tạo, ghi ai / bộ dữ liệu / bộ lọc /
--    số dòng / có dữ liệu cá nhân / mục đích / SHA-256 của file. Không lưu nội dung file.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Nhà cung cấp
-- ---------------------------------------------------------------------------
CREATE TABLE governance.vendors (
  vendor_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  name         text        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  kind         text        NOT NULL CHECK (kind IN ('cloud_hosting', 'messaging', 'webhook_partner', 'ai_service', 'software', 'other')),
  role         text        NOT NULL CHECK (role IN ('processor', 'sub_processor', 'third_party')),
  services     text        NOT NULL CHECK (length(btrim(services)) BETWEEN 3 AND 500),
  contact      text        CHECK (contact IS NULL OR length(contact) <= 300),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'terminated')),
  status_note  text        CHECK (status_note IS NULL OR length(status_note) <= 500),
  created_by   uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (vendor_id),
  CONSTRAINT vendors_tenant_uk UNIQUE (tenant_id, vendor_id),
  CONSTRAINT vendors_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT vendors_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE UNIQUE INDEX vendors_name_uk ON governance.vendors (tenant_id, lower(btrim(name)));
CREATE FUNCTION governance.vendors_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendors are kept as evidence (terminate instead)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.kind, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'vendor kind / creator are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'terminated' AND NEW.status <> 'terminated' THEN
    RAISE EXCEPTION 'terminated vendor cannot be reactivated (register again)' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER vendors_a_guard BEFORE UPDATE OR DELETE ON governance.vendors FOR EACH ROW EXECUTE FUNCTION governance.vendors_guard();
CREATE TRIGGER vendors_b_version BEFORE UPDATE ON governance.vendors FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();
ALTER TABLE governance.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.vendors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.vendors TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON governance.vendors TO hcos_app;
REVOKE DELETE, TRUNCATE ON governance.vendors FROM PUBLIC, hcos_app, hcos_provisioner;

-- Loại dữ liệu nhà cung cấp được phép nhận / lưu.
--   operational       sự kiện vận hành, số liệu tổng hợp — không định danh người bệnh
--   backup_encrypted  bản sao lưu đã mã hoá, nhà cung cấp KHÔNG có khoá
--   personal          dữ liệu cá nhân cơ bản (họ tên, liên hệ)
--   health            dữ liệu sức khoẻ (cá nhân nhạy cảm)
CREATE FUNCTION governance.is_data_categories(v text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(v) BETWEEN 1 AND 4 AND v <@ ARRAY['operational', 'backup_encrypted', 'personal', 'health']::text[]
$$;

CREATE TABLE governance.vendor_assessments (
  assessment_id   uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  vendor_id       uuid        NOT NULL,
  decision        text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  dpa_reference   text        CHECK (dpa_reference IS NULL OR length(btrim(dpa_reference)) BETWEEN 3 AND 200),
  data_categories text[]      NOT NULL CHECK (governance.is_data_categories(data_categories)),
  data_location   text        NOT NULL CHECK (length(btrim(data_location)) BETWEEN 2 AND 200),
  cross_border    boolean     NOT NULL,
  measures        text        NOT NULL CHECK (length(btrim(measures)) BETWEEN 20 AND 4000),
  rationale       text        NOT NULL CHECK (length(btrim(rationale)) BETWEEN 10 AND 4000),
  valid_from      date        NOT NULL,
  valid_until     date        NOT NULL,
  assessed_by     uuid        NOT NULL,
  assessed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_assessments_vendor_fk FOREIGN KEY (tenant_id, vendor_id) REFERENCES governance.vendors (tenant_id, vendor_id),
  CONSTRAINT vendor_assessments_user_fk FOREIGN KEY (tenant_id, assessed_by) REFERENCES iam.users (tenant_id, user_id),
  -- Đánh giá có hiệu lực tối đa 3 năm => buộc đánh giá lại định kỳ.
  CONSTRAINT vendor_assessments_validity_ck CHECK (valid_until > valid_from AND valid_until <= valid_from + 1096),
  -- Duyệt phải có thoả thuận xử lý dữ liệu (số hợp đồng / phụ lục).
  CONSTRAINT vendor_assessments_dpa_ck CHECK (decision <> 'approved' OR dpa_reference IS NOT NULL)
);
CREATE INDEX vendor_assessments_vendor_idx ON governance.vendor_assessments (tenant_id, vendor_id, assessed_at DESC);
-- Dịch vụ AI không bao giờ được duyệt nhận dữ liệu cá nhân / sức khoẻ (không gửi dữ liệu người bệnh cho AI bên ngoài).
CREATE FUNCTION governance.vendor_assessments_ai_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision = 'approved' AND NEW.data_categories && ARRAY['personal', 'health']::text[]
     AND EXISTS (SELECT 1 FROM governance.vendors v WHERE v.tenant_id = NEW.tenant_id AND v.vendor_id = NEW.vendor_id AND v.kind = 'ai_service') THEN
    RAISE EXCEPTION 'AI services may not be approved for personal or health data' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER vendor_assessments_ai_guard BEFORE INSERT ON governance.vendor_assessments FOR EACH ROW EXECUTE FUNCTION governance.vendor_assessments_ai_guard();
CREATE TRIGGER vendor_assessments_no_update BEFORE UPDATE OR DELETE ON governance.vendor_assessments FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER vendor_assessments_no_truncate BEFORE TRUNCATE ON governance.vendor_assessments FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE governance.vendor_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.vendor_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.vendor_assessments TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT ON governance.vendor_assessments TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON governance.vendor_assessments FROM PUBLIC, hcos_app, hcos_provisioner;

-- Nhà cung cấp có được nhận loại dữ liệu này NGAY BÂY GIỜ không: đang hoạt động + đánh giá MỚI NHẤT là 'approved',
-- còn hiệu lực (theo ngày giờ Việt Nam) và bao gồm loại dữ liệu. Đánh giá 'rejected' mới hơn = thu hồi.
CREATE FUNCTION governance.vendor_cleared(p_vendor uuid, p_category text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT a.decision = 'approved'
           AND (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= a.valid_from
           AND (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <  a.valid_until
           AND p_category = ANY (a.data_categories)
      FROM governance.vendors v
      JOIN governance.vendor_assessments a ON a.tenant_id = v.tenant_id AND a.vendor_id = v.vendor_id
     WHERE v.vendor_id = p_vendor AND v.tenant_id = platform.current_tenant_id() AND v.status = 'active'
     ORDER BY a.assessed_at DESC LIMIT 1), false)
$$;
GRANT EXECUTE ON FUNCTION governance.vendor_cleared(uuid, text) TO hcos_app;

-- ---------------------------------------------------------------------------
-- 2. Kết nối ngoài (F12) phải gắn nhà cung cấp
-- ---------------------------------------------------------------------------
ALTER TABLE integration.endpoints
  ADD COLUMN vendor_id uuid,
  ADD CONSTRAINT endpoints_vendor_fk FOREIGN KEY (tenant_id, vendor_id) REFERENCES governance.vendors (tenant_id, vendor_id);
ALTER TABLE integration.endpoint_history ADD COLUMN vendor_id uuid;
CREATE OR REPLACE FUNCTION integration.endpoints_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, integration AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.name, NEW.url_ciphertext, NEW.secret_ciphertext, NEW.event_types, NEW.max_priority, NEW.status, NEW.vendor_id)
       IS NOT DISTINCT FROM (OLD.name, OLD.url_ciphertext, OLD.secret_ciphertext, OLD.event_types, OLD.max_priority, OLD.status, OLD.vendor_id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO integration.endpoint_history (tenant_id, endpoint_id, version, name, url_hint, url_changed, secret_rotated, event_types, max_priority, status, paused_reason, changed_by, vendor_id)
  VALUES (NEW.tenant_id, NEW.endpoint_id, NEW.version, NEW.name, NEW.url_hint,
          TG_OP = 'UPDATE' AND NEW.url_ciphertext IS DISTINCT FROM OLD.url_ciphertext,
          TG_OP = 'UPDATE' AND NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext,
          NEW.event_types, NEW.max_priority, NEW.status, NEW.paused_reason,
          CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.updated_by END, NEW.vendor_id);
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Nhật ký xuất dữ liệu
-- ---------------------------------------------------------------------------
CREATE TABLE governance.data_exports (
  export_id        uuid        NOT NULL PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid,
  dataset          text        NOT NULL CHECK (dataset ~ '^[a-z][a-z0-9_]{2,63}$'),
  params           jsonb       NOT NULL,
  row_count        integer     NOT NULL CHECK (row_count >= 0),
  contains_personal boolean    NOT NULL,
  purpose          text        CHECK (purpose IS NULL OR length(btrim(purpose)) BETWEEN 5 AND 300),
  file_name        text        NOT NULL CHECK (length(file_name) BETWEEN 3 AND 200),
  content_type     text        NOT NULL,
  byte_size        integer     NOT NULL CHECK (byte_size > 0),
  sha256           text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  exported_by      uuid        NOT NULL,
  exported_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_exports_user_fk FOREIGN KEY (tenant_id, exported_by) REFERENCES iam.users (tenant_id, user_id),
  -- Xuất dữ liệu cá nhân phải ghi mục đích.
  CONSTRAINT data_exports_purpose_ck CHECK (NOT contains_personal OR purpose IS NOT NULL)
);
CREATE INDEX data_exports_tenant_idx ON governance.data_exports (tenant_id, exported_at DESC);
CREATE INDEX data_exports_sha_idx ON governance.data_exports (tenant_id, sha256);
CREATE TRIGGER data_exports_no_update BEFORE UPDATE OR DELETE ON governance.data_exports FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER data_exports_no_truncate BEFORE TRUNCATE ON governance.data_exports FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE governance.data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.data_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.data_exports TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT ON governance.data_exports TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON governance.data_exports FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
