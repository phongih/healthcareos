-- =============================================================================
-- HCOS-P0-ENG-001 | Person Registry
-- Migration 003: khoá đối sánh trùng lặp, bảo vệ merge, lịch sử merge (append-only), bảo vệ định danh
-- Phụ thuộc: 001_s0_init.sql, 002_s1_clinical_init.sql (dùng clinical.forbid_mutation)
--
-- Mô hình merge ("survivorship"):
--  * Hai person `active` cùng tenant: source được đánh dấu `merged` + merged_into_person_id = target.
--  * Person `merged` là trạng thái cuối: bất biến (không sửa, không "un-merge" bằng UPDATE).
--  * patient_id KHÔNG đổi (dữ liệu lâm sàng tham chiếu patient_id) — chỉ patients.person_id chuyển sang target.
--  * Mỗi merge ghi 1 dòng patient.person_merges (append-only) kèm snapshot source và các ID bị di chuyển.
-- Ghi chú: name_key/phone_key do ứng dụng tính (chuẩn hoá Unicode); dòng cũ chưa có khoá vẫn được tìm theo ngày sinh.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Khoá đối sánh + chỉ mục
-- ---------------------------------------------------------------------------
ALTER TABLE patient.persons
  ADD COLUMN name_key  text,
  ADD COLUMN phone_key text;

CREATE INDEX persons_active_dob_idx   ON patient.persons (tenant_id, birth_date) WHERE status = 'active' AND birth_date IS NOT NULL;
CREATE INDEX persons_active_name_idx  ON patient.persons (tenant_id, name_key)   WHERE status = 'active' AND name_key IS NOT NULL;
CREATE INDEX persons_active_phone_idx ON patient.persons (tenant_id, phone_key)  WHERE status = 'active' AND phone_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Guard merge cho persons (chạy TRƯỚC platform.guard_and_bump_version: tên trigger sắp theo alphabet)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION patient.persons_merge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'merged' THEN
    RAISE EXCEPTION 'merged person % is immutable', OLD.person_id USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'merged' THEN
    IF NEW.merged_into_person_id IS NULL OR NEW.merged_into_person_id = NEW.person_id THEN
      RAISE EXCEPTION 'invalid merge target' USING ERRCODE = '55000';
    END IF;
    -- Đích phải là person active cùng tenant => không thể tạo chuỗi/chu trình merge.
    PERFORM 1 FROM patient.persons t
      WHERE t.tenant_id = NEW.tenant_id AND t.person_id = NEW.merged_into_person_id AND t.status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'merge target must be an active person in the same tenant' USING ERRCODE = '55000';
    END IF;
    IF NEW.given_name <> OLD.given_name OR NEW.family_name <> OLD.family_name
       OR NEW.birth_date IS DISTINCT FROM OLD.birth_date THEN
      RAISE EXCEPTION 'identity fields cannot change while merging' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.merged_into_person_id IS DISTINCT FROM OLD.merged_into_person_id THEN
    RAISE EXCEPTION 'merged_into_person_id can only be set by a merge' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER patient_persons_a_merge_guard
  BEFORE UPDATE ON patient.persons
  FOR EACH ROW EXECUTE FUNCTION patient.persons_merge_guard();

-- ---------------------------------------------------------------------------
-- 3. Guard cho identifiers: định danh bất biến (chỉ đổi status hoặc chuyển person khi merge)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION patient.identifiers_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type <> OLD.type OR NEW.system <> OLD.system OR NEW.value <> OLD.value THEN
    RAISE EXCEPTION 'identifier type/system/value are immutable (create a new identifier)' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'entered_in_error' THEN
    RAISE EXCEPTION 'identifier entered in error cannot be modified' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER patient_identifiers_a_guard
  BEFORE UPDATE ON patient.identifiers
  FOR EACH ROW EXECUTE FUNCTION patient.identifiers_guard();

-- ---------------------------------------------------------------------------
-- 4. Lịch sử merge (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE patient.person_merges (
  merge_id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  source_person_id       uuid        NOT NULL,
  target_person_id       uuid        NOT NULL,
  reason                 text        NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  merged_by_user_id      uuid        NOT NULL,
  source_snapshot        jsonb       NOT NULL,
  moved_patient_ids      uuid[]      NOT NULL DEFAULT '{}',
  moved_identifier_ids   uuid[]      NOT NULL DEFAULT '{}',
  retired_identifier_ids uuid[]      NOT NULL DEFAULT '{}',
  repointed_user_ids     uuid[]      NOT NULL DEFAULT '{}',
  merged_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merge_id),
  CONSTRAINT person_merges_source_uk UNIQUE (tenant_id, source_person_id),   -- một person chỉ bị merge một lần
  CONSTRAINT person_merges_distinct CHECK (source_person_id <> target_person_id),
  CONSTRAINT person_merges_source_fk FOREIGN KEY (tenant_id, source_person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT person_merges_target_fk FOREIGN KEY (tenant_id, target_person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT person_merges_user_fk   FOREIGN KEY (tenant_id, merged_by_user_id) REFERENCES iam.users (tenant_id, user_id)
);
CREATE INDEX person_merges_target_idx ON patient.person_merges (tenant_id, target_person_id);

CREATE TRIGGER person_merges_immutable
  BEFORE UPDATE OR DELETE ON patient.person_merges
  FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER person_merges_no_truncate
  BEFORE TRUNCATE ON patient.person_merges
  FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();

ALTER TABLE patient.person_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.person_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient.person_merges TO hcos_app
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT ON patient.person_merges TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON patient.person_merges FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
