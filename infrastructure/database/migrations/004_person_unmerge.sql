-- =============================================================================
-- HCOS-P0-ENG-001 | Person Registry
-- Migration 004: unmerge có kiểm soát
-- Phụ thuộc: 003_person_registry.sql
--
-- Nguyên tắc:
--  * Person `merged` vẫn bất biến, TRỪ MỘT đường duy nhất: chuyển merged -> active khi đã có dòng patient.person_unmerges
--    (append-only, vĩnh viễn) được ghi TRONG CÙNG transaction (unmerged_at = now()). Không có dòng ghi nhận => 55000 như cũ.
--  * Mỗi merge chỉ unmerge được một lần (UNIQUE (tenant_id, merge_id)); sau unmerge, source có thể được merge lại (vào target khác).
--  * Merge ghi thêm snapshot của TARGET trước merge và version của target sau merge, để unmerge chỉ chạy khi target chưa bị đổi.
--    Dòng merge cũ (trước migration này) không có hai giá trị đó => ứng dụng từ chối unmerge (MERGE_RECORD_LEGACY).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Mở rộng lịch sử merge (ADD COLUMN không kích hoạt trigger bất biến theo dòng)
-- ---------------------------------------------------------------------------
ALTER TABLE patient.person_merges
  ADD COLUMN target_snapshot      jsonb,
  ADD COLUMN target_version_after integer;

ALTER TABLE patient.person_merges
  ADD CONSTRAINT person_merges_tenant_merge_uk UNIQUE (tenant_id, merge_id);

-- "Một person chỉ bị merge một lần" -> "chỉ một merge ĐANG HIỆU LỰC" (merge đã unmerge không tính).
ALTER TABLE patient.person_merges DROP CONSTRAINT person_merges_source_uk;

-- ---------------------------------------------------------------------------
-- 2. Lịch sử unmerge (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE patient.person_unmerges (
  unmerge_id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                   uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  merge_id                    uuid        NOT NULL,
  source_person_id            uuid        NOT NULL,
  target_person_id            uuid        NOT NULL,
  reason                      text        NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  unmerged_by_user_id         uuid        NOT NULL,
  restored_patient_ids        uuid[]      NOT NULL DEFAULT '{}',
  restored_identifier_ids     uuid[]      NOT NULL DEFAULT '{}',
  left_inactive_identifier_ids uuid[]     NOT NULL DEFAULT '{}',
  restored_user_ids           uuid[]      NOT NULL DEFAULT '{}',
  unmerged_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unmerge_id),
  CONSTRAINT person_unmerges_merge_uk UNIQUE (tenant_id, merge_id),   -- một merge chỉ unmerge được một lần
  CONSTRAINT person_unmerges_merge_fk FOREIGN KEY (tenant_id, merge_id) REFERENCES patient.person_merges (tenant_id, merge_id),
  CONSTRAINT person_unmerges_user_fk  FOREIGN KEY (tenant_id, unmerged_by_user_id) REFERENCES iam.users (tenant_id, user_id)
);
CREATE INDEX person_unmerges_source_idx ON patient.person_unmerges (tenant_id, source_person_id);

CREATE TRIGGER person_unmerges_immutable
  BEFORE UPDATE OR DELETE ON patient.person_unmerges
  FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER person_unmerges_no_truncate
  BEFORE TRUNCATE ON patient.person_unmerges
  FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();

ALTER TABLE patient.person_unmerges ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.person_unmerges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient.person_unmerges TO hcos_app
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT ON patient.person_unmerges TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON patient.person_unmerges FROM PUBLIC, hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 3. Chỉ một merge đang hiệu lực cho mỗi source (thay cho UNIQUE đã bỏ)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION patient.person_merges_single_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM patient.person_merges m
   WHERE m.tenant_id = NEW.tenant_id AND m.source_person_id = NEW.source_person_id
     AND NOT EXISTS (SELECT 1 FROM patient.person_unmerges u WHERE u.tenant_id = m.tenant_id AND u.merge_id = m.merge_id);
  IF FOUND THEN
    RAISE EXCEPTION 'person already has an active merge' USING ERRCODE = '23505', CONSTRAINT = 'person_merges_source_uk';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER person_merges_single_active
  BEFORE INSERT ON patient.person_merges
  FOR EACH ROW EXECUTE FUNCTION patient.person_merges_single_active();

-- ---------------------------------------------------------------------------
-- 4. Guard persons: cho phép đúng một đường merged -> active (có bản ghi unmerge cùng transaction)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION patient.persons_merge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'merged' THEN
    IF NEW.status = 'active' AND NEW.merged_into_person_id IS NULL
       AND NEW.given_name = OLD.given_name AND NEW.family_name = OLD.family_name
       AND NEW.birth_date IS NOT DISTINCT FROM OLD.birth_date
       AND NEW.sex IS NOT DISTINCT FROM OLD.sex AND NEW.phone IS NOT DISTINCT FROM OLD.phone
       AND NEW.email IS NOT DISTINCT FROM OLD.email
       AND EXISTS (
         SELECT 1
           FROM patient.person_unmerges u
           JOIN patient.person_merges m ON m.tenant_id = u.tenant_id AND m.merge_id = u.merge_id
          WHERE u.tenant_id = OLD.tenant_id
            AND m.source_person_id = OLD.person_id
            AND m.target_person_id = OLD.merged_into_person_id
            AND u.unmerged_at = now()                       -- cùng transaction với dòng unmerge
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'merged person % is immutable', OLD.person_id USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'merged' THEN
    IF NEW.merged_into_person_id IS NULL OR NEW.merged_into_person_id = NEW.person_id THEN
      RAISE EXCEPTION 'invalid merge target' USING ERRCODE = '55000';
    END IF;
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

COMMIT;
