-- HCOS-F17 — Lưu giữ & xoá dữ liệu: khoá theo chủ thể (crypto-shredding), chính sách lưu giữ, yêu cầu xoá hai người duyệt,
-- biên nhận xoá và sổ huỷ khoá (để phát lại sau khi khôi phục bản sao lưu).
--
-- Phân biệt bốn việc:
--  * XOÁ dữ liệu nghiệp vụ hết hạn (idempotency, outbox)          -> governance.purge_* (DELETE thật).
--  * HUỶ KHOÁ chủ thể (crypto-shredding)                          -> keyvault.subject_keys.status = 'shredded', wrapped_key = NULL:
--                                                                     mọi bản mã s1 của chủ thể đó không còn mở được, ở bất kỳ đâu.
--  * ẨN DANH (lịch hẹn hết hạn, người bệnh đã xoá)                 -> giữ dòng cho thống kê / toàn vẹn tham chiếu, bỏ mọi trường định danh.
--  * GIỮ theo nghĩa vụ pháp lý (hồ sơ bệnh án, chứng từ kế toán)  -> governance.hold_until(): yêu cầu xoá chỉ xoá phần không bị ràng buộc,
--                                                                     đánh dấu hạn chế xử lý, phần còn lại chờ hết hạn giữ.
-- Mọi thao tác xoá đi qua hàm SECURITY DEFINER dưới đây (role ứng dụng không có quyền DELETE / không được tự huỷ khoá),
-- và mỗi lần huỷ khoá / ẩn danh ghi một dòng keyvault.shred_events (chỉ id, không dữ liệu) để đẩy ra ngoài bản sao lưu.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Ngữ cảnh "đang xoá theo chính sách": chỉ đúng bên trong hàm SECURITY DEFINER (chủ hàm là superuser)
--    hoặc phiên superuser phát lại sổ huỷ. Role ứng dụng tự set_config cũng không qua được (không phải superuser).
-- ---------------------------------------------------------------------------
CREATE FUNCTION governance.in_erasure() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('hcos.erasure', true) = 'on' AND COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
$$;

-- Bản mã s1 (khoá chủ thể, F17) bên cạnh e1 (DEK tenant, F16).
CREATE OR REPLACE FUNCTION keyvault.is_sealed(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NULL OR v ~ '^e1\.[0-9]{1,6}\.[A-Za-z0-9_-]{38,}$' OR v ~ '^s1\.[A-Za-z0-9_-]{38,}$'
$$;

-- ---------------------------------------------------------------------------
-- 1. Khoá chủ thể
-- ---------------------------------------------------------------------------
CREATE TABLE keyvault.subject_keys (
  tenant_id     uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('person', 'identifier', 'booking')),
  subject_id    uuid        NOT NULL,
  dek_version   integer     NOT NULL CHECK (dek_version BETWEEN 1 AND 999999),
  wrapped_key   bytea       CHECK (wrapped_key IS NULL OR length(wrapped_key) = 60),   -- bọc bằng DEK tenant: iv 12 + key 32 + tag 16
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'shredded')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  rewrapped_at  timestamptz,
  shredded_at   timestamptz,
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  CONSTRAINT subject_keys_shred_ck CHECK ((status = 'shredded') = (wrapped_key IS NULL) AND (status = 'shredded') = (shredded_at IS NOT NULL))
);
CREATE INDEX subject_keys_dek_idx ON keyvault.subject_keys (tenant_id, dek_version) WHERE status = 'active';

CREATE FUNCTION keyvault.subject_keys_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subject keys are never deleted (shred instead)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.subject_kind, NEW.subject_id, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.subject_kind, OLD.subject_id, OLD.created_at) THEN
    RAISE EXCEPTION 'subject key identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'shredded' THEN
    RAISE EXCEPTION 'shredded subject key cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'shredded' AND NOT governance.in_erasure() THEN
    RAISE EXCEPTION 'subject keys are shredded only through governance erasure functions' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subject_keys_guard BEFORE UPDATE OR DELETE ON keyvault.subject_keys FOR EACH ROW EXECUTE FUNCTION keyvault.subject_keys_guard();
CREATE TRIGGER subject_keys_no_truncate BEFORE TRUNCATE ON keyvault.subject_keys FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE keyvault.subject_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyvault.subject_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON keyvault.subject_keys TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON keyvault.subject_keys TO hcos_app;
REVOKE DELETE, TRUNCATE ON keyvault.subject_keys FROM PUBLIC, hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 2. Sổ huỷ khoá / ẩn danh: chỉ id + hành động. Được đẩy ra GCS (ngoài bản sao lưu CSDL) và phát lại sau khi khôi phục.
-- ---------------------------------------------------------------------------
CREATE TABLE keyvault.shred_events (
  event_id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('person', 'booking')),
  subject_id    uuid        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('erase_person', 'erase_booking')),
  receipt_id    uuid        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  exported_at   timestamptz,
  replayed      boolean     NOT NULL DEFAULT false
);
CREATE INDEX shred_events_pending_idx ON keyvault.shred_events (event_id) WHERE exported_at IS NULL;
CREATE INDEX shred_events_receipt_idx ON keyvault.shred_events (tenant_id, receipt_id);

CREATE FUNCTION keyvault.shred_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Chỉ được đánh dấu "đã đẩy ra ngoài" một lần (script đẩy sổ chạy bằng superuser).
  IF TG_OP = 'UPDATE' AND OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL
     AND (to_jsonb(NEW) - 'exported_at') = (to_jsonb(OLD) - 'exported_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'keyvault.shred_events is append-only' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER shred_events_guard BEFORE UPDATE OR DELETE ON keyvault.shred_events FOR EACH ROW EXECUTE FUNCTION keyvault.shred_events_guard();
CREATE TRIGGER shred_events_no_truncate BEFORE TRUNCATE ON keyvault.shred_events FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE keyvault.shred_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyvault.shred_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON keyvault.shred_events TO hcos_app USING (tenant_id = platform.current_tenant_id());
GRANT SELECT ON keyvault.shred_events TO hcos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON keyvault.shred_events FROM PUBLIC, hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 3. Chính sách lưu giữ: SÀN pháp lý + mặc định nằm ở đây (CSDL tự chặn đặt thấp hơn sàn); bản sao trong mã nguồn được test đối chiếu.
-- ---------------------------------------------------------------------------
CREATE FUNCTION governance.retention_floor(p_rule text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rule
    WHEN 'booking_contact'  THEN 30     -- đủ để tra khiếu nại / đối soát
    WHEN 'idempotency'      THEN 1
    WHEN 'outbox'           THEN 7
    WHEN 'medical_record'   THEN 3650   -- hồ sơ bệnh án ngoại trú: tối thiểu 10 năm
    WHEN 'financial_record' THEN 3650   -- chứng từ kế toán dùng ghi sổ: tối thiểu 10 năm (tính từ hết năm tài chính)
  END
$$;
CREATE FUNCTION governance.retention_default(p_rule text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rule
    WHEN 'booking_contact'  THEN 90
    WHEN 'idempotency'      THEN 7
    WHEN 'outbox'           THEN 30
    WHEN 'medical_record'   THEN 3650
    WHEN 'financial_record' THEN 3650
  END
$$;

CREATE TABLE governance.retention_settings (
  tenant_id   uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  rule_id     text        NOT NULL CHECK (governance.retention_floor(rule_id) IS NOT NULL),
  days        integer     NOT NULL,
  updated_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, rule_id),
  CONSTRAINT retention_settings_floor_ck CHECK (days >= governance.retention_floor(rule_id) AND days <= 36500),
  CONSTRAINT retention_settings_user_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER retention_settings_no_delete BEFORE DELETE ON governance.retention_settings FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE governance.retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.retention_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.retention_settings TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON governance.retention_settings TO hcos_app;

CREATE FUNCTION governance.retention_days(p_rule text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT days FROM governance.retention_settings WHERE tenant_id = platform.current_tenant_id() AND rule_id = p_rule),
    governance.retention_default(p_rule))
$$;

-- Lần chạy job lưu giữ (vận hành; chỉ số đếm).
CREATE TABLE governance.retention_runs (
  run_id        uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  trigger       text        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  triggered_by  uuid,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  status        text        NOT NULL CHECK (status IN ('succeeded', 'failed')),
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_code    text
);
CREATE INDEX retention_runs_tenant_idx ON governance.retention_runs (tenant_id, started_at DESC);
CREATE TRIGGER retention_runs_no_update BEFORE UPDATE OR DELETE ON governance.retention_runs FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE governance.retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.retention_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.retention_runs TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT ON governance.retention_runs TO hcos_app;

-- ---------------------------------------------------------------------------
-- 4. Biên nhận xoá: BẰNG CHỨNG (chính sách, căn cứ, phạm vi = số đếm, thời điểm, kết quả, ngày không thể khôi phục).
--    Không lưu bất kỳ giá trị nào đã xoá.
-- ---------------------------------------------------------------------------
CREATE TABLE governance.deletion_receipts (
  receipt_id          uuid        NOT NULL PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  kind                text        NOT NULL CHECK (kind IN ('retention', 'erasure')),
  rule_id             text,
  request_id          uuid,
  policy_version      text        NOT NULL CHECK (policy_version ~ '^[0-9a-f]{64}$'),
  legal_basis         text        NOT NULL CHECK (length(legal_basis) BETWEEN 5 AND 1000),
  criteria            jsonb       NOT NULL,
  scope               jsonb       NOT NULL,
  keys_shredded       integer     NOT NULL DEFAULT 0 CHECK (keys_shredded >= 0),
  outcome             text        NOT NULL CHECK (outcome IN ('completed', 'partial')),
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz NOT NULL,
  backup_horizon_days integer     NOT NULL CHECK (backup_horizon_days BETWEEN 0 AND 3650),
  irreversible_after  timestamptz NOT NULL,
  executed_by         uuid,       -- NULL = job hệ thống
  approved_by         uuid,
  CONSTRAINT deletion_receipts_kind_ck CHECK ((kind = 'retention') = (rule_id IS NOT NULL) AND (kind = 'erasure') = (request_id IS NOT NULL))
);
CREATE INDEX deletion_receipts_tenant_idx ON governance.deletion_receipts (tenant_id, finished_at DESC);
CREATE TRIGGER deletion_receipts_no_update BEFORE UPDATE OR DELETE ON governance.deletion_receipts FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER deletion_receipts_no_truncate BEFORE TRUNCATE ON governance.deletion_receipts FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE governance.deletion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.deletion_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.deletion_receipts TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT ON governance.deletion_receipts TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON governance.deletion_receipts FROM PUBLIC, hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 5. Yêu cầu xoá của chủ thể dữ liệu: người lập KHÁC người duyệt (CSDL chặn).
-- ---------------------------------------------------------------------------
CREATE TABLE governance.erasure_requests (
  request_id      uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id uuid        NOT NULL,
  patient_id      uuid        NOT NULL,
  person_id       uuid        NOT NULL,
  channel         text        NOT NULL CHECK (channel IN ('counter', 'written', 'email', 'phone')),
  note            text        CHECK (note IS NULL OR length(note) <= 500),
  received_at     timestamptz NOT NULL,
  requested_by    uuid        NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  assessment      jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected', 'completed', 'deferred')),
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text        CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  deferred_until  timestamptz,
  receipt_id      uuid,
  final_receipt_id uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT erasure_requests_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT erasure_requests_patient_fk FOREIGN KEY (tenant_id, patient_id) REFERENCES patient.patients (tenant_id, patient_id),
  CONSTRAINT erasure_requests_requester_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT erasure_requests_decider_fk FOREIGN KEY (tenant_id, decided_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT erasure_requests_four_eyes_ck CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT erasure_requests_decided_ck CHECK ((decided_by IS NULL) = (decided_at IS NULL) AND (status = 'pending' OR decided_by IS NOT NULL)),
  CONSTRAINT erasure_requests_deferred_ck CHECK ((status = 'deferred') = (deferred_until IS NOT NULL) OR status = 'completed')
);
CREATE UNIQUE INDEX erasure_requests_one_open_uk ON governance.erasure_requests (tenant_id, person_id) WHERE status IN ('pending', 'deferred');
CREATE INDEX erasure_requests_tenant_idx ON governance.erasure_requests (tenant_id, requested_at DESC);

CREATE FUNCTION governance.erasure_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed constant text[] := ARRAY['request_id', 'tenant_id', 'organization_id', 'patient_id', 'person_id', 'channel', 'note', 'received_at',
                                 'requested_by', 'requested_at', 'assessment'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'erasure requests are kept as evidence' USING ERRCODE = '42501';
  END IF;
  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(fixed) k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(fixed) k) THEN
    RAISE EXCEPTION 'erasure request content is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.decided_by IS NOT NULL AND NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    RAISE EXCEPTION 'decision maker cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('rejected', 'completed', 'deferred'))
    OR (OLD.status = 'deferred' AND NEW.status = 'completed')) THEN
    RAISE EXCEPTION 'illegal erasure request transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('rejected', 'completed') THEN
    RAISE EXCEPTION 'closed erasure request is immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
CREATE TRIGGER erasure_requests_guard BEFORE UPDATE OR DELETE ON governance.erasure_requests FOR EACH ROW EXECUTE FUNCTION governance.erasure_requests_guard();
ALTER TABLE governance.erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.erasure_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.erasure_requests TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON governance.erasure_requests TO hcos_app;
REVOKE DELETE, TRUNCATE ON governance.erasure_requests FROM PUBLIC, hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 6. Cột trạng thái xoá / hạn chế xử lý; trường định danh được phép NULL khi (và chỉ khi) đã xoá.
-- ---------------------------------------------------------------------------
ALTER TABLE patient.persons
  ADD COLUMN erased_at timestamptz,
  ADD COLUMN processing_restricted_at timestamptz,
  ALTER COLUMN given_name DROP NOT NULL,
  ALTER COLUMN family_name DROP NOT NULL,
  DROP CONSTRAINT persons_status_check,
  ADD CONSTRAINT persons_status_check CHECK (status IN ('active', 'merged', 'deceased', 'inactive', 'erased')),
  ADD CONSTRAINT persons_erased_ck CHECK ((status = 'erased') = (erased_at IS NOT NULL)),
  ADD CONSTRAINT persons_names_ck CHECK (erased_at IS NOT NULL OR (given_name IS NOT NULL AND family_name IS NOT NULL));

ALTER TABLE patient.identifiers
  ADD COLUMN erased_at timestamptz,
  DROP CONSTRAINT identifiers_value_present_ck,
  ADD CONSTRAINT identifiers_value_present_ck
    CHECK (erased_at IS NOT NULL OR value IS NOT NULL OR (value_enc IS NOT NULL AND value_bidx IS NOT NULL AND value_hint IS NOT NULL));

ALTER TABLE clinical.bookings
  ADD COLUMN erased_at timestamptz,
  ALTER COLUMN family_name DROP NOT NULL,
  ALTER COLUMN given_name DROP NOT NULL,
  ALTER COLUMN birth_date DROP NOT NULL,
  ALTER COLUMN sex DROP NOT NULL,
  DROP CONSTRAINT bookings_phone_present_ck,
  ADD CONSTRAINT bookings_phone_present_ck
    CHECK (erased_at IS NOT NULL OR phone IS NOT NULL OR (phone_enc IS NOT NULL AND phone_bidx IS NOT NULL AND phone_hint IS NOT NULL)),
  ADD CONSTRAINT bookings_identity_ck
    CHECK (erased_at IS NOT NULL OR (family_name IS NOT NULL AND given_name IS NOT NULL AND birth_date IS NOT NULL AND sex IS NOT NULL));

-- Guard: thêm đường xoá theo chính sách (chỉ trong ngữ cảnh governance.in_erasure()).
CREATE OR REPLACE FUNCTION clinical.bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pii constant text[] := ARRAY['phone', 'national_id', 'phone_enc', 'phone_bidx', 'phone_hint', 'national_id_enc', 'national_id_bidx', 'national_id_hint'];
  outcome constant text[] := ARRAY['status', 'patient_id', 'ticket_id', 'checked_in_by', 'checked_in_at', 'cancelled_by', 'cancelled_at', 'version', 'updated_at'];
  erasable constant text[] := ARRAY['family_name', 'given_name', 'birth_date', 'sex', 'reason', 'erased_at'];
BEGIN
  IF governance.in_erasure() THEN
    IF (to_jsonb(NEW) - pii - erasable - ARRAY['version', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - pii - erasable - ARRAY['version', 'updated_at']) THEN
      RAISE EXCEPTION 'erasure may only clear identifying booking fields' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'erased booking is immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - outcome - pii) IS DISTINCT FROM (to_jsonb(OLD) - outcome - pii) THEN
    RAISE EXCEPTION 'booking details are immutable' USING ERRCODE = '42501';
  END IF;
  IF (OLD.phone_enc IS NOT NULL AND NEW.phone_enc IS NULL) OR (OLD.national_id_enc IS NOT NULL AND NEW.national_id_enc IS NULL) THEN
    RAISE EXCEPTION 'encrypted booking contact cannot be removed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'booked' AND NEW.status IN ('checked_in', 'cancelled', 'no_show')) THEN
    RAISE EXCEPTION 'illegal booking transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF NEW.status = OLD.status AND (NEW.patient_id, NEW.ticket_id, NEW.checked_in_by, NEW.checked_in_at, NEW.cancelled_by, NEW.cancelled_at)
     IS DISTINCT FROM (OLD.patient_id, OLD.ticket_id, OLD.checked_in_by, OLD.checked_in_at, OLD.cancelled_by, OLD.cancelled_at) THEN
    RAISE EXCEPTION 'booking outcome fields change only with a status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION patient.persons_merge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF governance.in_erasure() THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'erased' THEN
    RAISE EXCEPTION 'erased person % is immutable', OLD.person_id USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'erased' OR NEW.erased_at IS DISTINCT FROM OLD.erased_at OR NEW.processing_restricted_at IS DISTINCT FROM OLD.processing_restricted_at THEN
    RAISE EXCEPTION 'erasure / restriction is set only through governance functions' USING ERRCODE = '42501';
  END IF;
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
            AND u.unmerged_at = now()
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

CREATE OR REPLACE FUNCTION patient.identifiers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF governance.in_erasure() THEN
    RETURN NEW;
  END IF;
  IF OLD.erased_at IS NOT NULL OR NEW.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'identifier erasure is done only through governance functions' USING ERRCODE = '42501';
  END IF;
  IF NEW.type <> OLD.type OR NEW.system <> OLD.system OR NEW.value <> OLD.value THEN
    RAISE EXCEPTION 'identifier type/system/value are immutable (create a new identifier)' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'entered_in_error' THEN
    RAISE EXCEPTION 'identifier entered in error cannot be modified' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION patient.person_merges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok_src boolean;
  ok_tgt boolean;
  f constant text[] := ARRAY['phone', 'email', 'contact'];
BEGIN
  IF TG_OP = 'UPDATE' AND governance.in_erasure() THEN
    -- Xoá: chỉ được thay ảnh chụp bằng {"erased": true}; mọi cột khác giữ nguyên.
    IF (to_jsonb(NEW) - ARRAY['source_snapshot', 'target_snapshot']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['source_snapshot', 'target_snapshot'])
       OR (NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot AND NEW.source_snapshot <> '{"erased": true}'::jsonb)
       OR (NEW.target_snapshot IS DISTINCT FROM OLD.target_snapshot AND NEW.target_snapshot <> '{"erased": true}'::jsonb) THEN
      RAISE EXCEPTION 'erasure may only replace snapshots with {"erased": true}' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR current_setting('hcos.seal_snapshot', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'patient.person_merges is append-only' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['source_snapshot', 'target_snapshot']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['source_snapshot', 'target_snapshot']) THEN
    RAISE EXCEPTION 'only snapshots may be sealed' USING ERRCODE = '42501';
  END IF;
  ok_src := (NEW.source_snapshot - f) = (OLD.source_snapshot - f)
            AND NEW.source_snapshot->>'phone' IS NULL AND NEW.source_snapshot->>'email' IS NULL
            AND keyvault.is_sealed(NEW.source_snapshot->'contact'->>'phoneEnc') AND keyvault.is_sealed(NEW.source_snapshot->'contact'->>'emailEnc');
  ok_tgt := NEW.target_snapshot IS NOT DISTINCT FROM OLD.target_snapshot
            OR ((NEW.target_snapshot - f) = (OLD.target_snapshot - f)
                AND NEW.target_snapshot->>'phone' IS NULL AND NEW.target_snapshot->>'email' IS NULL
                AND keyvault.is_sealed(NEW.target_snapshot->'contact'->>'phoneEnc') AND keyvault.is_sealed(NEW.target_snapshot->'contact'->>'emailEnc'));
  IF NOT (ok_src AND ok_tgt) THEN
    RAISE EXCEPTION 'snapshot sealing may only replace phone/email with encrypted contact' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- idempotency_keys: chỉ xoá được qua hàm lưu giữ.
CREATE FUNCTION governance.forbid_unless_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND governance.in_erasure() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%.% is append-only (% not allowed)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;
DROP TRIGGER idempotency_keys_no_delete ON platform.idempotency_keys;
CREATE TRIGGER idempotency_keys_no_delete BEFORE DELETE ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION governance.forbid_unless_erasure();

-- ---------------------------------------------------------------------------
-- 7. Hàm lõi (KHÔNG cấp cho role ứng dụng). Chạy bên trong hàm SECURITY DEFINER hoặc phiên superuser phát lại sổ.
--    Lọc tenant tường minh bằng platform.current_tenant_id() (superuser bỏ qua RLS).
-- ---------------------------------------------------------------------------
-- Người + mọi hồ sơ đã gộp vào người đó (cùng một con người).
CREATE FUNCTION governance.person_group(p_person uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  WITH RECURSIVE g(id) AS (
    SELECT person_id FROM patient.persons WHERE tenant_id = platform.current_tenant_id() AND person_id = p_person
    UNION
    SELECT p.person_id FROM patient.persons p JOIN g ON p.merged_into_person_id = g.id WHERE p.tenant_id = platform.current_tenant_id()
  )
  SELECT COALESCE(array_agg(id), '{}') FROM g
$$;

-- Hạn giữ theo nghĩa vụ pháp lý của một nhóm người: hồ sơ bệnh án (lần khám cuối + N ngày),
-- chứng từ kế toán (hết năm tài chính của phiếu thu/chi cuối + N ngày). NULL = không bị ràng buộc.
CREATE FUNCTION governance.hold_until(p_persons uuid[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH pts AS (
    SELECT patient_id FROM patient.patients WHERE tenant_id = platform.current_tenant_id() AND person_id = ANY(p_persons)
  ), med AS (
    SELECT max(COALESCE(e.period_end, e.period_start, e.created_at)) AS last_at, count(*) AS n
      FROM clinical.encounters e WHERE e.tenant_id = platform.current_tenant_id() AND e.patient_id IN (SELECT patient_id FROM pts)
  ), fin AS (
    SELECT max(r.created_at) AS last_at, count(*) AS n
      FROM finance.receipts r JOIN finance.billing_cases c ON c.tenant_id = r.tenant_id AND c.case_id = r.case_id
     WHERE r.tenant_id = platform.current_tenant_id() AND c.patient_id IN (SELECT patient_id FROM pts)
  )
  SELECT jsonb_build_object(
    'medical_record', (SELECT CASE WHEN n = 0 THEN NULL ELSE last_at + make_interval(days => governance.retention_days('medical_record')) END FROM med),
    'medical_record_count', (SELECT n FROM med),
    'financial_record', (SELECT CASE WHEN n = 0 THEN NULL
                                     ELSE (date_trunc('year', last_at AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '1 year') AT TIME ZONE 'Asia/Ho_Chi_Minh'
                                          + make_interval(days => governance.retention_days('financial_record')) END FROM fin),
    'financial_record_count', (SELECT n FROM fin))
$$;

CREATE FUNCTION governance._shred(p_kind text, p_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE keyvault.subject_keys SET status = 'shredded', wrapped_key = NULL, shredded_at = now()
   WHERE tenant_id = platform.current_tenant_id() AND subject_kind = p_kind AND subject_id = p_id AND status = 'active';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Ẩn danh một lịch hẹn: huỷ khoá + xoá mọi trường định danh; giữ ngày / buổi / phòng / trạng thái cho thống kê.
CREATE FUNCTION governance._erase_booking(p_booking uuid, p_receipt uuid, p_replay boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE k integer;
BEGIN
  PERFORM set_config('hcos.erasure', 'on', true);
  UPDATE clinical.bookings
     SET family_name = NULL, given_name = NULL, birth_date = NULL, sex = NULL, reason = NULL,
         phone = NULL, phone_enc = NULL, phone_bidx = NULL, phone_hint = NULL,
         national_id = NULL, national_id_enc = NULL, national_id_bidx = NULL, national_id_hint = NULL,
         erased_at = COALESCE(erased_at, now())
   WHERE tenant_id = platform.current_tenant_id() AND booking_id = p_booking;
  k := governance._shred('booking', p_booking);
  INSERT INTO keyvault.shred_events (tenant_id, subject_kind, subject_id, action, receipt_id, exported_at, replayed)
  VALUES (platform.current_tenant_id(), 'booking', p_booking, 'erase_booking', p_receipt, CASE WHEN p_replay THEN now() END, p_replay);
  RETURN k;
END
$$;

-- Xoá toàn bộ một người (KHÔNG kiểm tra hạn giữ — hàm bọc phải kiểm tra trước). Trả số đếm theo bảng.
CREATE FUNCTION governance._erase_person(p_person uuid, p_receipt uuid, p_replay boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  t uuid := platform.current_tenant_id();
  grp uuid[] := governance.person_group(p_person);
  ids uuid[];
  bks uuid[];
  n_persons integer; n_ident integer; n_snap integer; n_idem integer; k integer := 0; b uuid; i uuid;
BEGIN
  IF cardinality(grp) = 0 THEN
    RETURN jsonb_build_object('persons', 0);
  END IF;
  PERFORM set_config('hcos.erasure', 'on', true);
  SELECT COALESCE(array_agg(identifier_id), '{}') INTO ids FROM patient.identifiers WHERE tenant_id = t AND person_id = ANY(grp);
  -- Lịch hẹn của người này: gắn với hồ sơ của họ, hoặc trùng CCCD (blind index) — tính TRƯỚC khi xoá index.
  SELECT COALESCE(array_agg(DISTINCT bk.booking_id), '{}') INTO bks FROM clinical.bookings bk
   WHERE bk.tenant_id = t AND bk.erased_at IS NULL
     AND (bk.patient_id IN (SELECT patient_id FROM patient.patients WHERE tenant_id = t AND person_id = ANY(grp))
          OR bk.national_id_bidx IN (SELECT value_bidx FROM patient.identifiers
                                      WHERE tenant_id = t AND person_id = ANY(grp) AND type = 'national_id' AND value_bidx IS NOT NULL));
  UPDATE patient.persons
     SET given_name = NULL, family_name = NULL, birth_date = NULL, sex = NULL, name_key = NULL,
         phone = NULL, email = NULL, phone_key = NULL, phone_enc = NULL, phone_bidx = NULL, phone_hint = NULL, email_enc = NULL, email_hint = NULL,
         status = 'erased', merged_into_person_id = NULL, erased_at = COALESCE(erased_at, now())
   WHERE tenant_id = t AND person_id = ANY(grp);
  GET DIAGNOSTICS n_persons = ROW_COUNT;
  UPDATE patient.identifiers
     SET value = NULL, value_enc = NULL, value_bidx = NULL, value_hint = NULL, status = 'inactive', erased_at = COALESCE(erased_at, now())
   WHERE tenant_id = t AND identifier_id = ANY(ids);
  GET DIAGNOSTICS n_ident = ROW_COUNT;
  UPDATE patient.person_merges
     SET source_snapshot = CASE WHEN source_person_id = ANY(grp) THEN '{"erased": true}'::jsonb ELSE source_snapshot END,
         target_snapshot = CASE WHEN target_person_id = ANY(grp) AND target_snapshot IS NOT NULL THEN '{"erased": true}'::jsonb ELSE target_snapshot END
   WHERE tenant_id = t AND (source_person_id = ANY(grp) OR target_person_id = ANY(grp));
  GET DIAGNOSTICS n_snap = ROW_COUNT;
  -- Kết quả API lưu để chống gửi trùng có thể chứa họ tên: xoá các bản ghi nhắc tới người / hồ sơ này.
  DELETE FROM platform.idempotency_keys ik
   WHERE ik.tenant_id = t AND ik.response IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(grp || ARRAY(SELECT patient_id FROM patient.patients WHERE tenant_id = t AND person_id = ANY(grp))) x
                  WHERE ik.response::text LIKE '%' || x::text || '%');
  GET DIAGNOSTICS n_idem = ROW_COUNT;
  FOREACH i IN ARRAY grp LOOP
    k := k + governance._shred('person', i);
    INSERT INTO keyvault.shred_events (tenant_id, subject_kind, subject_id, action, receipt_id, exported_at, replayed)
    VALUES (t, 'person', i, 'erase_person', p_receipt, CASE WHEN p_replay THEN now() END, p_replay);
  END LOOP;
  FOREACH i IN ARRAY ids LOOP
    k := k + governance._shred('identifier', i);
  END LOOP;
  FOREACH b IN ARRAY bks LOOP
    k := k + governance._erase_booking(b, p_receipt, p_replay);
  END LOOP;
  RETURN jsonb_build_object('persons', n_persons, 'identifiers', n_ident, 'bookings', cardinality(bks), 'mergeSnapshots', n_snap,
                            'idempotencyResponses', n_idem, 'keysShredded', k);
END
$$;

-- ---------------------------------------------------------------------------
-- 8. Hàm cho role ứng dụng (SECURITY DEFINER, search_path cố định): tự kiểm tra điều kiện, không tin tham số.
-- ---------------------------------------------------------------------------
-- Thực thi yêu cầu xoá ĐÃ được người thứ hai duyệt. Còn hạn giữ => xoá phần không bị ràng buộc (lịch hẹn),
-- hạn chế xử lý hồ sơ, trả 'partial' + hạn giữ; hết ràng buộc => xoá toàn bộ.
CREATE FUNCTION governance.execute_erasure(p_request uuid, p_receipt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := platform.current_tenant_id();
  r governance.erasure_requests%ROWTYPE;
  grp uuid[];
  holds jsonb;
  v_until timestamptz;
  k integer := 0;
  b uuid;
  bks uuid[];
  v_out jsonb;
BEGIN
  SELECT * INTO r FROM governance.erasure_requests WHERE tenant_id = t AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erasure request not found' USING ERRCODE = '42704';
  END IF;
  IF r.decided_by IS NULL OR r.decided_by = r.requested_by OR r.status NOT IN ('pending', 'deferred') THEN
    RAISE EXCEPTION 'erasure request must be approved by a second person' USING ERRCODE = '42501';
  END IF;
  IF r.status = 'deferred' AND r.deferred_until > now() THEN
    RAISE EXCEPTION 'erasure request is deferred until %', r.deferred_until USING ERRCODE = '55000';
  END IF;
  grp := governance.person_group(r.person_id);
  holds := governance.hold_until(grp);
  SELECT max(x) INTO v_until FROM (VALUES ((holds->>'medical_record')::timestamptz), ((holds->>'financial_record')::timestamptz)) v(x);
  IF v_until IS NOT NULL AND v_until > now() THEN
    PERFORM set_config('hcos.erasure', 'on', true);
    SELECT COALESCE(array_agg(booking_id), '{}') INTO bks FROM clinical.bookings
     WHERE tenant_id = t AND erased_at IS NULL
       AND patient_id IN (SELECT patient_id FROM patient.patients WHERE tenant_id = t AND person_id = ANY(grp));
    FOREACH b IN ARRAY bks LOOP
      k := k + governance._erase_booking(b, p_receipt, false);
    END LOOP;
    UPDATE patient.persons SET processing_restricted_at = COALESCE(processing_restricted_at, now())
     WHERE tenant_id = t AND person_id = ANY(grp);
    v_out := jsonb_build_object('mode', 'partial', 'holdUntil', v_until, 'holds', holds, 'bookings', cardinality(bks), 'keysShredded', k,
                              'restrictedPersons', cardinality(grp));
  ELSE
    v_out := governance._erase_person(r.person_id, p_receipt, false) || jsonb_build_object('mode', 'full', 'holds', holds);
  END IF;
  PERFORM set_config('hcos.erasure', 'off', true);
  RETURN v_out;
END
$$;

-- Ẩn danh lịch hẹn quá hạn (ngày khám < hôm nay theo giờ VN − N ngày của tenant). Trả {bookings, keysShredded}.
CREATE FUNCTION governance.anonymize_due_bookings(p_receipt uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := platform.current_tenant_id();
  cutoff date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - governance.retention_days('booking_contact');
  b uuid; n integer := 0; k integer := 0;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  FOR b IN SELECT booking_id FROM clinical.bookings WHERE tenant_id = t AND erased_at IS NULL AND visit_date < cutoff
            ORDER BY visit_date, booking_id LIMIT GREATEST(1, LEAST(p_limit, 5000)) FOR UPDATE LOOP
    k := k + governance._erase_booking(b, p_receipt, false);
    n := n + 1;
  END LOOP;
  PERFORM set_config('hcos.erasure', 'off', true);
  RETURN jsonb_build_object('bookings', n, 'keysShredded', k, 'cutoff', cutoff);
END
$$;

CREATE FUNCTION governance.purge_idempotency(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF platform.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('hcos.erasure', 'on', true);
  DELETE FROM platform.idempotency_keys WHERE ctid IN (
    SELECT ctid FROM platform.idempotency_keys
     WHERE tenant_id = platform.current_tenant_id() AND created_at < now() - make_interval(days => governance.retention_days('idempotency'))
     LIMIT GREATEST(1, LEAST(p_limit, 50000)));
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('hcos.erasure', 'off', true);
  RETURN n;
END
$$;

CREATE FUNCTION governance.purge_outbox(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF platform.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  DELETE FROM platform.outbox_events WHERE outbox_id IN (
    SELECT outbox_id FROM platform.outbox_events
     WHERE tenant_id = platform.current_tenant_id() AND created_at < now() - make_interval(days => governance.retention_days('outbox'))
     LIMIT GREATEST(1, LEAST(p_limit, 50000)));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Đánh giá (chỉ đọc) cho người lập yêu cầu: hạn giữ + phạm vi dự kiến.
CREATE FUNCTION governance.erasure_assessment(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := platform.current_tenant_id();
  grp uuid[] := governance.person_group(p_person);
BEGIN
  RETURN governance.hold_until(grp) || jsonb_build_object(
    'persons', cardinality(grp),
    'identifiers', (SELECT count(*) FROM patient.identifiers WHERE tenant_id = t AND person_id = ANY(grp) AND erased_at IS NULL),
    'bookings', (SELECT count(*) FROM clinical.bookings WHERE tenant_id = t AND erased_at IS NULL
                   AND patient_id IN (SELECT patient_id FROM patient.patients WHERE tenant_id = t AND person_id = ANY(grp))));
END
$$;

-- Phát lại sổ huỷ sau khi khôi phục bản sao lưu: CHỈ superuser (không cấp cho ứng dụng). Bỏ qua dòng không tồn tại; idempotent.
CREATE FUNCTION governance.replay_shred(p_tenant uuid, p_kind text, p_subject uuid, p_receipt uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  IF p_kind = 'person' THEN
    IF NOT EXISTS (SELECT 1 FROM patient.persons WHERE tenant_id = p_tenant AND person_id = p_subject) THEN RETURN 'absent'; END IF;
    IF EXISTS (SELECT 1 FROM patient.persons WHERE tenant_id = p_tenant AND person_id = p_subject AND status = 'erased')
       AND NOT EXISTS (SELECT 1 FROM keyvault.subject_keys WHERE tenant_id = p_tenant AND subject_kind = 'person' AND subject_id = p_subject AND status = 'active') THEN
      RETURN 'already';
    END IF;
    PERFORM governance._erase_person(p_subject, p_receipt, true);
  ELSIF p_kind = 'booking' THEN
    IF NOT EXISTS (SELECT 1 FROM clinical.bookings WHERE tenant_id = p_tenant AND booking_id = p_subject) THEN RETURN 'absent'; END IF;
    IF EXISTS (SELECT 1 FROM clinical.bookings WHERE tenant_id = p_tenant AND booking_id = p_subject AND erased_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM keyvault.subject_keys WHERE tenant_id = p_tenant AND subject_kind = 'booking' AND subject_id = p_subject AND status = 'active') THEN
      RETURN 'already';
    END IF;
    PERFORM governance._erase_booking(p_subject, p_receipt, true);
  ELSE
    RAISE EXCEPTION 'unknown subject kind %', p_kind;
  END IF;
  PERFORM set_config('hcos.erasure', 'off', true);
  RETURN 'applied';
END
$$;

-- Danh sách tenant cho bộ lập lịch (chạy ngoài ngữ cảnh tenant; chỉ trả id).
CREATE FUNCTION governance.active_tenants() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT tenant_id FROM iam.tenants WHERE status = 'active' ORDER BY tenant_id
$$;
REVOKE ALL ON FUNCTION governance.active_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION governance.active_tenants() TO hcos_app;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'governance.person_group(uuid)', 'governance.hold_until(uuid[])', 'governance._shred(text,uuid)',
    'governance._erase_booking(uuid,uuid,boolean)', 'governance._erase_person(uuid,uuid,boolean)', 'governance.replay_shred(uuid,text,uuid,uuid)',
    'governance.execute_erasure(uuid,uuid)', 'governance.anonymize_due_bookings(uuid,integer)', 'governance.purge_idempotency(integer)',
    'governance.purge_outbox(integer)', 'governance.erasure_assessment(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION governance.execute_erasure(uuid, uuid), governance.anonymize_due_bookings(uuid, integer),
  governance.purge_idempotency(integer), governance.purge_outbox(integer), governance.erasure_assessment(uuid) TO hcos_app;
GRANT EXECUTE ON FUNCTION governance.retention_days(text), governance.retention_floor(text), governance.retention_default(text), governance.in_erasure() TO hcos_app;

COMMIT;
