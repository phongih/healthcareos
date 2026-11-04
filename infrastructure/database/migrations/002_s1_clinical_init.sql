-- =============================================================================
-- HCOS-P0-ENG-001 | Slice S1 | Patient Registry & Clinical Encounter
-- Migration 002: clinical schema (encounters, conditions, observations, clinical_documents)
-- Phụ thuộc: 001_s0_init.sql (iam.*, patient.*, platform.*, roles hcos_app/hcos_provisioner)
--
-- Nguyên tắc bảo toàn lịch sử (clinical immutability / provenance):
--  * Không bao giờ DELETE bản ghi lâm sàng: DELETE/TRUNCATE bị chặn; sửa sai = status 'entered_in_error'.
--  * Mọi UPDATE đều chụp snapshot dòng cũ vào clinical.record_history (append-only) cùng người sửa
--    (app.user_id) và thời điểm. version tăng theo trigger của S0 (optimistic concurrency).
--  * Nội dung lâm sàng đã chốt (observation final/corrected, document content) bất biến; thay đổi bằng
--    bản ghi mới tham chiếu `supersedes_*`.
--  * Composite FK (tenant_id, ...) đảm bảo con và cha luôn cùng tenant và cùng patient.
--  * Ứng dụng phải set: SELECT set_config('app.tenant_id', ..., true) và set_config('app.user_id', ..., true).
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS clinical;
GRANT USAGE ON SCHEMA clinical TO hcos_app, hcos_provisioner;

-- Cho phép FK ghép (patient_id + organization_id) từ encounters: đợt khám phải ở đúng organization của hồ sơ.
ALTER TABLE patient.patients
  ADD CONSTRAINT patients_tenant_patient_org_uk UNIQUE (tenant_id, patient_id, organization_id);

-- ---------------------------------------------------------------------------
-- 1. Helper functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinical.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% does not allow % (use status entered_in_error / supersede instead)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END
$$;

-- Snapshot dòng cũ trước khi UPDATE. TG_ARGV[0] = tên cột khoá chính (uuid).
CREATE OR REPLACE FUNCTION clinical.snapshot_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO clinical.record_history (tenant_id, table_name, record_id, record_version, operation, snapshot, changed_by)
  VALUES (
    OLD.tenant_id,
    TG_TABLE_NAME,
    (to_jsonb(OLD) ->> TG_ARGV[0])::uuid,
    OLD.version,
    TG_OP,
    to_jsonb(OLD),
    NULLIF(current_setting('app.user_id', true), '')
  );
  RETURN NEW;
END
$$;

-- Chỉ cho INSERT khi đợt khám ở trạng thái cho phép (TG_ARGV = danh sách trạng thái).
CREATE OR REPLACE FUNCTION clinical.require_encounter_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
  FROM clinical.encounters
  WHERE tenant_id = NEW.tenant_id AND encounter_id = NEW.encounter_id;

  IF v_status IS NULL OR NOT (v_status = ANY (TG_ARGV)) THEN
    RAISE EXCEPTION 'encounter % is not open for new % records (status=%)',
      NEW.encounter_id, TG_TABLE_NAME, COALESCE(v_status, 'missing')
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. History (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.record_history (
  history_id     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  table_name     text        NOT NULL,
  record_id      uuid        NOT NULL,
  record_version bigint      NOT NULL,
  operation      text        NOT NULL,
  snapshot       jsonb       NOT NULL,
  changed_by     text,
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_history_lookup_idx ON clinical.record_history (tenant_id, table_name, record_id, record_version);

CREATE TRIGGER record_history_immutable
  BEFORE UPDATE OR DELETE ON clinical.record_history
  FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER record_history_no_truncate
  BEFORE TRUNCATE ON clinical.record_history
  FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 3. Encounters
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.encounters (
  encounter_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  patient_id           uuid        NOT NULL,
  organization_id      uuid        NOT NULL,
  practitioner_user_id uuid        NOT NULL,
  status               text        NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('planned', 'in_progress', 'finished', 'cancelled', 'entered_in_error')),
  encounter_class      text        NOT NULL CHECK (encounter_class IN ('ambulatory', 'inpatient', 'emergency', 'virtual')),
  reason_text          text,
  period_start         timestamptz NOT NULL DEFAULT now(),
  period_end           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (encounter_id),
  CONSTRAINT encounters_tenant_encounter_uk         UNIQUE (tenant_id, encounter_id),
  CONSTRAINT encounters_tenant_encounter_patient_uk UNIQUE (tenant_id, encounter_id, patient_id),
  CONSTRAINT encounters_patient_org_fk FOREIGN KEY (tenant_id, patient_id, organization_id)
    REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT encounters_practitioner_fk FOREIGN KEY (tenant_id, practitioner_user_id)
    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT encounters_period_chk CHECK (period_end IS NULL OR period_end >= period_start),
  CONSTRAINT encounters_finished_has_end CHECK (status <> 'finished' OR period_end IS NOT NULL)
);
CREATE INDEX encounters_tenant_patient_idx ON clinical.encounters (tenant_id, patient_id, period_start DESC);
CREATE INDEX encounters_tenant_org_status_idx ON clinical.encounters (tenant_id, organization_id, status);
CREATE INDEX encounters_tenant_practitioner_idx ON clinical.encounters (tenant_id, practitioner_user_id, status);

CREATE OR REPLACE FUNCTION clinical.encounters_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.patient_id <> OLD.patient_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.practitioner_user_id <> OLD.practitioner_user_id THEN
    RAISE EXCEPTION 'encounter patient/organization/practitioner are immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('finished', 'cancelled', 'entered_in_error') THEN
    -- Đợt khám đã đóng: chỉ được đánh dấu nhập nhầm (finished -> entered_in_error), không đổi nội dung khác.
    IF NOT (OLD.status = 'finished' AND NEW.status = 'entered_in_error') THEN
      RAISE EXCEPTION 'encounter % is closed (status=%)', OLD.encounter_id, OLD.status USING ERRCODE = '55000';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'closed encounter content is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('planned', 'in_progress'), ('planned', 'cancelled'), ('planned', 'entered_in_error'),
      ('in_progress', 'finished'), ('in_progress', 'cancelled'), ('in_progress', 'entered_in_error')
  ) THEN
    RAISE EXCEPTION 'illegal encounter transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER encounters_a_guard   BEFORE UPDATE ON clinical.encounters FOR EACH ROW EXECUTE FUNCTION clinical.encounters_guard();
CREATE TRIGGER encounters_b_history BEFORE UPDATE ON clinical.encounters FOR EACH ROW EXECUTE FUNCTION clinical.snapshot_history('encounter_id');
CREATE TRIGGER encounters_c_version BEFORE UPDATE ON clinical.encounters FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 4. Conditions (chẩn đoán / vấn đề sức khoẻ)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.conditions (
  condition_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  patient_id          uuid        NOT NULL,
  encounter_id        uuid        NOT NULL,
  category            text        NOT NULL DEFAULT 'encounter_diagnosis'
                      CHECK (category IN ('encounter_diagnosis', 'problem_list_item')),
  code_system         text        NOT NULL,           -- vd: http://hl7.org/fhir/sid/icd-10
  code                text        NOT NULL,
  display             text,
  clinical_status     text        NOT NULL DEFAULT 'active'
                      CHECK (clinical_status IN ('active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved')),
  verification_status text        NOT NULL DEFAULT 'confirmed'
                      CHECK (verification_status IN ('unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered_in_error')),
  onset_at            timestamptz,
  abated_at           timestamptz,
  recorded_by_user_id uuid        NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (condition_id),
  CONSTRAINT conditions_tenant_condition_uk UNIQUE (tenant_id, condition_id),
  CONSTRAINT conditions_encounter_patient_fk FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, patient_id),
  CONSTRAINT conditions_recorder_fk FOREIGN KEY (tenant_id, recorded_by_user_id)
    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT conditions_abated_chk CHECK (abated_at IS NULL OR onset_at IS NULL OR abated_at >= onset_at)
);
CREATE UNIQUE INDEX conditions_encounter_code_uk
  ON clinical.conditions (tenant_id, encounter_id, code_system, code)
  WHERE verification_status <> 'entered_in_error';
CREATE INDEX conditions_tenant_patient_idx ON clinical.conditions (tenant_id, patient_id);

CREATE OR REPLACE FUNCTION clinical.conditions_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.patient_id <> OLD.patient_id OR NEW.encounter_id <> OLD.encounter_id
     OR NEW.code_system <> OLD.code_system OR NEW.code <> OLD.code
     OR NEW.recorded_by_user_id <> OLD.recorded_by_user_id OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'condition identity/provenance fields are immutable (record a new condition)' USING ERRCODE = '42501';
  END IF;
  IF OLD.verification_status = 'entered_in_error' THEN
    RAISE EXCEPTION 'condition entered in error cannot be modified' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conditions_a_require_open BEFORE INSERT ON clinical.conditions
  FOR EACH ROW EXECUTE FUNCTION clinical.require_encounter_status('in_progress');
CREATE TRIGGER conditions_b_guard   BEFORE UPDATE ON clinical.conditions FOR EACH ROW EXECUTE FUNCTION clinical.conditions_guard();
CREATE TRIGGER conditions_c_history BEFORE UPDATE ON clinical.conditions FOR EACH ROW EXECUTE FUNCTION clinical.snapshot_history('condition_id');
CREATE TRIGGER conditions_d_version BEFORE UPDATE ON clinical.conditions FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 5. Observations (sinh hiệu, xét nghiệm, đo lường)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.observations (
  observation_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                 uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  patient_id                uuid        NOT NULL,
  encounter_id              uuid        NOT NULL,
  status                    text        NOT NULL DEFAULT 'final'
                            CHECK (status IN ('registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered_in_error', 'unknown')),
  code_system               text        NOT NULL,       -- vd: http://loinc.org
  code                      text        NOT NULL,
  display                   text,
  value_numeric             numeric,
  value_unit                text,
  value_ucum_code           text,
  value_string              text,
  effective_at              timestamptz NOT NULL DEFAULT now(),
  supersedes_observation_id uuid,
  recorded_by_user_id       uuid        NOT NULL,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (observation_id),
  CONSTRAINT observations_tenant_observation_uk UNIQUE (tenant_id, observation_id),
  CONSTRAINT observations_encounter_patient_fk FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, patient_id),
  CONSTRAINT observations_recorder_fk FOREIGN KEY (tenant_id, recorded_by_user_id)
    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT observations_supersedes_fk FOREIGN KEY (tenant_id, supersedes_observation_id)
    REFERENCES clinical.observations (tenant_id, observation_id),
  CONSTRAINT observations_value_chk CHECK (
    (value_numeric IS NOT NULL)::int + (value_string IS NOT NULL)::int = 1
  ),
  CONSTRAINT observations_unit_chk CHECK (value_numeric IS NULL OR value_unit IS NOT NULL)
);
CREATE INDEX observations_tenant_patient_code_idx ON clinical.observations (tenant_id, patient_id, code_system, code, effective_at DESC);
CREATE INDEX observations_tenant_encounter_idx    ON clinical.observations (tenant_id, encounter_id);

CREATE OR REPLACE FUNCTION clinical.observations_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.patient_id <> OLD.patient_id OR NEW.encounter_id <> OLD.encounter_id
     OR NEW.code_system <> OLD.code_system OR NEW.code <> OLD.code
     OR NEW.recorded_by_user_id <> OLD.recorded_by_user_id OR NEW.recorded_at <> OLD.recorded_at
     OR NEW.supersedes_observation_id IS DISTINCT FROM OLD.supersedes_observation_id THEN
    RAISE EXCEPTION 'observation identity/provenance fields are immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'entered_in_error' THEN
    RAISE EXCEPTION 'observation entered in error cannot be modified' USING ERRCODE = '55000';
  END IF;

  -- Kết quả đã chốt: chỉ được chuyển sang entered_in_error; giá trị bị đóng băng.
  IF OLD.status IN ('final', 'amended', 'corrected') THEN
    IF NEW.status <> 'entered_in_error' THEN
      RAISE EXCEPTION 'finalized observation is immutable; record a corrected observation (supersedes_observation_id)'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.value_numeric IS DISTINCT FROM OLD.value_numeric OR NEW.value_string IS DISTINCT FROM OLD.value_string
       OR NEW.value_unit IS DISTINCT FROM OLD.value_unit OR NEW.effective_at <> OLD.effective_at THEN
      RAISE EXCEPTION 'finalized observation value is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER observations_a_require_open BEFORE INSERT ON clinical.observations
  FOR EACH ROW EXECUTE FUNCTION clinical.require_encounter_status('in_progress');
CREATE TRIGGER observations_b_guard   BEFORE UPDATE ON clinical.observations FOR EACH ROW EXECUTE FUNCTION clinical.observations_guard();
CREATE TRIGGER observations_c_history BEFORE UPDATE ON clinical.observations FOR EACH ROW EXECUTE FUNCTION clinical.snapshot_history('observation_id');
CREATE TRIGGER observations_d_version BEFORE UPDATE ON clinical.observations FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 6. Clinical documents (metadata; nội dung nằm ở object storage, định danh bằng hash)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.clinical_documents (
  document_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  patient_id              uuid        NOT NULL,
  encounter_id            uuid        NOT NULL,
  doc_type                text        NOT NULL,           -- vd: discharge_summary, lab_report, imaging_report
  title                   text        NOT NULL,
  content_type            text        NOT NULL,
  storage_uri             text        NOT NULL,
  content_hash            bytea       NOT NULL CHECK (length(content_hash) = 32),  -- SHA-256
  size_bytes              bigint      NOT NULL CHECK (size_bytes >= 0),
  status                  text        NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'entered_in_error')),
  supersedes_document_id  uuid,
  author_user_id          uuid        NOT NULL,
  authored_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (document_id),
  CONSTRAINT documents_tenant_document_uk UNIQUE (tenant_id, document_id),
  CONSTRAINT documents_encounter_patient_fk FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, patient_id),
  CONSTRAINT documents_author_fk FOREIGN KEY (tenant_id, author_user_id)
    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT documents_supersedes_fk FOREIGN KEY (tenant_id, supersedes_document_id)
    REFERENCES clinical.clinical_documents (tenant_id, document_id)
);
CREATE INDEX documents_tenant_patient_idx   ON clinical.clinical_documents (tenant_id, patient_id, authored_at DESC);
CREATE INDEX documents_tenant_encounter_idx ON clinical.clinical_documents (tenant_id, encounter_id);

CREATE OR REPLACE FUNCTION clinical.documents_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.patient_id <> OLD.patient_id OR NEW.encounter_id <> OLD.encounter_id
     OR NEW.doc_type <> OLD.doc_type OR NEW.title <> OLD.title
     OR NEW.content_type <> OLD.content_type OR NEW.storage_uri <> OLD.storage_uri
     OR NEW.content_hash <> OLD.content_hash OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.author_user_id <> OLD.author_user_id OR NEW.authored_at <> OLD.authored_at
     OR NEW.supersedes_document_id IS DISTINCT FROM OLD.supersedes_document_id THEN
    RAISE EXCEPTION 'clinical document content/provenance is immutable (upload a new version)' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'entered_in_error' THEN
    RAISE EXCEPTION 'document entered in error cannot be modified' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

-- Tài liệu có thể đến muộn sau khi đóng đợt khám (kết quả cận lâm sàng): cho phép in_progress và finished.
CREATE TRIGGER documents_a_require_open BEFORE INSERT ON clinical.clinical_documents
  FOR EACH ROW EXECUTE FUNCTION clinical.require_encounter_status('in_progress', 'finished');
CREATE TRIGGER documents_b_guard   BEFORE UPDATE ON clinical.clinical_documents FOR EACH ROW EXECUTE FUNCTION clinical.documents_guard();
CREATE TRIGGER documents_c_history BEFORE UPDATE ON clinical.clinical_documents FOR EACH ROW EXECUTE FUNCTION clinical.snapshot_history('document_id');
CREATE TRIGGER documents_d_version BEFORE UPDATE ON clinical.clinical_documents FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 7. Không bao giờ xoá dữ liệu lâm sàng
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical.encounters', 'clinical.conditions', 'clinical.observations', 'clinical.clinical_documents']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation()',
                   replace(t, '.', '_') || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation()',
                   replace(t, '.', '_') || '_no_truncate', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 8. Row-Level Security (fail-closed) + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinical.encounters', 'clinical.conditions', 'clinical.observations',
    'clinical.clinical_documents', 'clinical.record_history'
  ]
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

GRANT SELECT, INSERT, UPDATE ON clinical.encounters, clinical.conditions,
                                clinical.observations, clinical.clinical_documents TO hcos_app;
GRANT SELECT, INSERT ON clinical.record_history TO hcos_app;
REVOKE DELETE, TRUNCATE ON clinical.encounters, clinical.conditions, clinical.observations,
                           clinical.clinical_documents, clinical.record_history FROM PUBLIC, hcos_app, hcos_provisioner;
REVOKE UPDATE ON clinical.record_history FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
