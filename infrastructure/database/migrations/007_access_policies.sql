-- =============================================================================
-- HCOS-P0-ENG-001 | IAM | Migration 007: access policy theo dữ liệu (data-driven access policies)
-- Phụ thuộc: 001_s0_init.sql (iam.*, platform.*), 002_s1_clinical_init.sql
--
-- Mô hình:
--  * iam.access_policies: chính sách thuộc tenant, `rules` là mảng JSON (ứng dụng kiểm định dạng, DB kiểm khung).
--  * iam.memberships.access_policy_id (tuỳ chọn): gắn MỘT policy cho MỘT membership.
--      - NULL  => giữ nguyên quyền mặc định của vai trò (tương thích ngược).
--      - có    => quyền = quyền vai trò ∩ policy (policy CHỈ THU HẸP, không bao giờ cấp thêm quyền ngoài vai trò).
--  * iam.access_policy_versions: ảnh chụp từng phiên bản policy (append-only) để truy vết "ai đổi luật gì, lúc nào".
--  * Policy `retired` là trạng thái cuối: bất biến, không gắn được vào membership mới; không retire được khi còn
--    membership active đang dùng (tránh vô tình cắt quyền lâm sàng của cả khoa).
--  * Mọi bảng: RLS FORCE theo tenant, FK ghép (tenant_id, id); không cấp DELETE.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Policies
-- ---------------------------------------------------------------------------
CREATE TABLE iam.access_policies (
  policy_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 3 AND 100),
  description  text        CHECK (description IS NULL OR char_length(description) <= 1000),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  rules        jsonb       NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) BETWEEN 1 AND 50),
  created_by   uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (policy_id),
  CONSTRAINT access_policies_tenant_policy_uk UNIQUE (tenant_id, policy_id),
  CONSTRAINT access_policies_tenant_name_uk   UNIQUE (tenant_id, name),
  CONSTRAINT access_policies_creator_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES iam.users (tenant_id, user_id)
);

CREATE TRIGGER iam_access_policies_guard_version
  BEFORE UPDATE ON iam.access_policies
  FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

CREATE OR REPLACE FUNCTION iam.guard_access_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired access policy % is immutable', OLD.policy_id USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'access policy provenance is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'retired' AND EXISTS (
       SELECT 1 FROM iam.memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.access_policy_id = NEW.policy_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'access policy % is still assigned to active memberships', NEW.policy_id
      USING ERRCODE = '55000', CONSTRAINT = 'access_policies_in_use';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER access_policies_guard_state
  BEFORE UPDATE ON iam.access_policies
  FOR EACH ROW EXECUTE FUNCTION iam.guard_access_policy();

-- ---------------------------------------------------------------------------
-- 2. Lịch sử phiên bản (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE iam.access_policy_versions (
  tenant_id    uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  policy_id    uuid        NOT NULL,
  version      bigint      NOT NULL CHECK (version >= 1),
  name         text        NOT NULL,
  description  text,
  status       text        NOT NULL,
  rules        jsonb       NOT NULL,
  changed_by   text        NOT NULL,        -- app.user_id (subject) của transaction ghi
  changed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id, version),
  CONSTRAINT access_policy_versions_policy_fk FOREIGN KEY (tenant_id, policy_id)
    REFERENCES iam.access_policies (tenant_id, policy_id)
);

CREATE OR REPLACE FUNCTION iam.snapshot_access_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor text := NULLIF(current_setting('app.user_id', true), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'app.user_id must be set to change access policies' USING ERRCODE = '42501';
  END IF;
  INSERT INTO iam.access_policy_versions (tenant_id, policy_id, version, name, description, status, rules, changed_by)
  VALUES (NEW.tenant_id, NEW.policy_id, NEW.version, NEW.name, NEW.description, NEW.status, NEW.rules, v_actor);
  RETURN NULL;
END
$$;

CREATE TRIGGER access_policies_snapshot
  AFTER INSERT OR UPDATE ON iam.access_policies
  FOR EACH ROW EXECUTE FUNCTION iam.snapshot_access_policy();

CREATE OR REPLACE FUNCTION iam.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% not allowed)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER access_policy_versions_no_update
  BEFORE UPDATE OR DELETE ON iam.access_policy_versions
  FOR EACH ROW EXECUTE FUNCTION iam.forbid_mutation();
CREATE TRIGGER access_policy_versions_no_truncate
  BEFORE TRUNCATE ON iam.access_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION iam.forbid_mutation();
CREATE TRIGGER access_policies_no_delete
  BEFORE DELETE ON iam.access_policies
  FOR EACH ROW EXECUTE FUNCTION iam.forbid_mutation();
CREATE TRIGGER access_policies_no_truncate
  BEFORE TRUNCATE ON iam.access_policies
  FOR EACH STATEMENT EXECUTE FUNCTION iam.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 3. Gắn policy vào membership
-- ---------------------------------------------------------------------------
ALTER TABLE iam.memberships
  ADD COLUMN access_policy_id uuid,
  ADD CONSTRAINT memberships_access_policy_fk FOREIGN KEY (tenant_id, access_policy_id)
    REFERENCES iam.access_policies (tenant_id, policy_id);

CREATE INDEX memberships_tenant_policy_idx
  ON iam.memberships (tenant_id, access_policy_id) WHERE access_policy_id IS NOT NULL;

CREATE OR REPLACE FUNCTION iam.guard_membership_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.access_policy_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.access_policy_id IS DISTINCT FROM OLD.access_policy_id)
     AND NOT EXISTS (
       SELECT 1 FROM iam.access_policies p
        WHERE p.tenant_id = NEW.tenant_id AND p.policy_id = NEW.access_policy_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'access policy % is not active', NEW.access_policy_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memberships_guard_policy
  BEFORE INSERT OR UPDATE OF access_policy_id ON iam.memberships
  FOR EACH ROW EXECUTE FUNCTION iam.guard_membership_policy();

-- ---------------------------------------------------------------------------
-- 4. RLS (fail-closed) + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['iam.access_policies', 'iam.access_policy_versions']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO hcos_app
         USING (tenant_id = platform.current_tenant_id())
         WITH CHECK (tenant_id = platform.current_tenant_id())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON iam.access_policies TO hcos_app;
GRANT SELECT, INSERT         ON iam.access_policy_versions TO hcos_app;
REVOKE DELETE, TRUNCATE ON iam.access_policies, iam.access_policy_versions FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
