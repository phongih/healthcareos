-- HCOS-F16 — Mã hoá theo trường (envelope encryption) cho dữ liệu định danh & liên hệ.
--
--  * keyvault.tenant_keys: DEK của từng tenant (mục đích 'data' / 'index'), có phiên bản, CHỈ lưu dạng đã bọc bằng KEK.
--    KEK không bao giờ nằm trong CSDL => người đọc được CSDL (kể cả bản sao lưu) không giải mã được.
--  * Cột mới <cột>_enc (bản mã), <cột>_bidx (blind index), <cột>_hint (dạng che để hiển thị).
--  * Cột bản rõ cũ (persons.phone/email/phone_key, identifiers.value, bookings.phone/national_id) được GIỮ tạm cho đến khi
--    chạy scripts/pii-backfill.ts (mã hoá → kiểm tra giải mã khớp → xoá bản rõ). Trigger chặn MỌI ghi bản rõ mới:
--    chỉ được đổi bản rõ thành NULL.
--  * Ảnh chụp gộp hồ sơ (patient.person_merges) chỉ được thay phone/email bằng bản mã qua hàm patient.seal_merge_snapshot.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Kho khoá
-- ---------------------------------------------------------------------------
CREATE SCHEMA keyvault;
GRANT USAGE ON SCHEMA keyvault TO hcos_app;

CREATE TABLE keyvault.tenant_keys (
  tenant_id     uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  purpose       text        NOT NULL CHECK (purpose IN ('data', 'index')),
  version       integer     NOT NULL CHECK (version BETWEEN 1 AND 999999),
  kek_id        text        NOT NULL CHECK (kek_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  wrapped_key   bytea       NOT NULL CHECK (length(wrapped_key) = 60),   -- iv 12 + key 32 + tag 16
  status        text        NOT NULL CHECK (status IN ('active', 'retired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  retired_at    timestamptz,
  rewrapped_at  timestamptz,
  PRIMARY KEY (tenant_id, purpose, version),
  CONSTRAINT tenant_keys_retired_ck CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_keys_one_active_uk ON keyvault.tenant_keys (tenant_id, purpose) WHERE status = 'active';

-- Khoá chỉ được: tạo; chuyển active -> retired; bọc lại (đổi kek_id + wrapped_key). Không xoá, không hồi sinh.
CREATE FUNCTION keyvault.tenant_keys_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.purpose, NEW.version, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.purpose, OLD.version, OLD.created_at) THEN
    RAISE EXCEPTION 'tenant key identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'retired key cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  IF NEW.wrapped_key IS DISTINCT FROM OLD.wrapped_key AND NEW.kek_id = OLD.kek_id THEN
    RAISE EXCEPTION 'rewrapping must change kek_id' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenant_keys_guard BEFORE UPDATE ON keyvault.tenant_keys FOR EACH ROW EXECUTE FUNCTION keyvault.tenant_keys_guard();
CREATE TRIGGER tenant_keys_no_delete BEFORE DELETE ON keyvault.tenant_keys FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER tenant_keys_no_truncate BEFORE TRUNCATE ON keyvault.tenant_keys FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();
ALTER TABLE keyvault.tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyvault.tenant_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON keyvault.tenant_keys TO hcos_app
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON keyvault.tenant_keys TO hcos_app;
REVOKE DELETE, TRUNCATE ON keyvault.tenant_keys FROM PUBLIC, hcos_app, hcos_provisioner;

-- Dạng che cho dòng CHƯA backfill (giống maskPhone / maskEmail / maskIdentifier trong packages/security/src/pii.ts).
CREATE FUNCTION keyvault.mask_phone(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN NULL
              WHEN length(replace(v, ' ', '')) <= 6 THEN repeat('*', length(replace(v, ' ', '')))
              ELSE left(replace(v, ' ', ''), 3) || repeat('*', length(replace(v, ' ', '')) - 6) || right(replace(v, ' ', ''), 3) END
$$;
CREATE FUNCTION keyvault.mask_email(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN NULL ELSE left(split_part(v, '@', 1), 1) || '***@' || split_part(v, '@', 2) END
$$;
CREATE FUNCTION keyvault.mask_identifier(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN NULL
              WHEN length(replace(v, ' ', '')) <= 4 THEN repeat('*', length(replace(v, ' ', '')))
              ELSE repeat('*', length(replace(v, ' ', '')) - 4) || right(replace(v, ' ', ''), 4) END
$$;

-- Chặn ghi bản rõ: INSERT phải để NULL; UPDATE chỉ được giữ nguyên hoặc đổi thành NULL. TG_ARGV = tên các cột bản rõ.
CREATE FUNCTION keyvault.forbid_plaintext() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c text;
  n jsonb := to_jsonb(NEW);
  o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    IF n->>c IS NOT NULL AND (TG_OP = 'INSERT' OR n->c IS DISTINCT FROM o->c) THEN
      RAISE EXCEPTION 'plaintext PII column %.% must stay NULL (HCOS-F16: write the encrypted column)', TG_TABLE_NAME, c USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
-- Bản mã phải đúng định dạng; blind index 128 bit hex.
CREATE FUNCTION keyvault.is_sealed(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT v IS NULL OR v ~ '^e1\.[0-9]{1,6}\.[A-Za-z0-9_-]{38,}$' $$;
CREATE FUNCTION keyvault.is_bidx(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT v IS NULL OR v ~ '^[0-9a-f]{32}$' $$;

-- ---------------------------------------------------------------------------
-- 2. patient.persons: phone, email
-- ---------------------------------------------------------------------------
ALTER TABLE patient.persons
  ADD COLUMN phone_enc  text CHECK (keyvault.is_sealed(phone_enc)),
  ADD COLUMN phone_bidx text CHECK (keyvault.is_bidx(phone_bidx)),
  ADD COLUMN phone_hint text CHECK (phone_hint IS NULL OR length(phone_hint) <= 32),
  ADD COLUMN email_enc  text CHECK (keyvault.is_sealed(email_enc)),
  ADD COLUMN email_hint text CHECK (email_hint IS NULL OR length(email_hint) <= 260),
  ADD CONSTRAINT persons_phone_sealed_ck CHECK ((phone_enc IS NULL) = (phone_bidx IS NULL) AND (phone_enc IS NULL) = (phone_hint IS NULL)),
  ADD CONSTRAINT persons_email_sealed_ck CHECK ((email_enc IS NULL) = (email_hint IS NULL));
CREATE INDEX persons_active_phone_bidx_idx ON patient.persons (tenant_id, phone_bidx) WHERE status = 'active' AND phone_bidx IS NOT NULL;
CREATE TRIGGER persons_z_no_plaintext BEFORE INSERT OR UPDATE ON patient.persons
  FOR EACH ROW EXECUTE FUNCTION keyvault.forbid_plaintext('phone', 'email', 'phone_key');

-- ---------------------------------------------------------------------------
-- 3. patient.identifiers: value
-- ---------------------------------------------------------------------------
ALTER TABLE patient.identifiers
  ALTER COLUMN value DROP NOT NULL,
  ADD COLUMN value_enc  text CHECK (keyvault.is_sealed(value_enc)),
  ADD COLUMN value_bidx text CHECK (keyvault.is_bidx(value_bidx)),
  ADD COLUMN value_hint text CHECK (value_hint IS NULL OR length(value_hint) <= 64),
  ADD CONSTRAINT identifiers_value_present_ck CHECK (value IS NOT NULL OR (value_enc IS NOT NULL AND value_bidx IS NOT NULL AND value_hint IS NOT NULL));
CREATE UNIQUE INDEX identifiers_active_system_bidx_uk ON patient.identifiers (tenant_id, system, value_bidx)
  WHERE status = 'active' AND value_bidx IS NOT NULL;
CREATE TRIGGER identifiers_z_no_plaintext BEFORE INSERT OR UPDATE ON patient.identifiers
  FOR EACH ROW EXECUTE FUNCTION keyvault.forbid_plaintext('value');

-- ---------------------------------------------------------------------------
-- 4. clinical.bookings: phone, national_id (lý do khám để F16b)
-- ---------------------------------------------------------------------------
ALTER TABLE clinical.bookings
  ALTER COLUMN phone DROP NOT NULL,
  ADD COLUMN phone_enc        text CHECK (keyvault.is_sealed(phone_enc)),
  ADD COLUMN phone_bidx       text CHECK (keyvault.is_bidx(phone_bidx)),
  ADD COLUMN phone_hint       text CHECK (phone_hint IS NULL OR length(phone_hint) <= 32),
  ADD COLUMN national_id_enc  text CHECK (keyvault.is_sealed(national_id_enc)),
  ADD COLUMN national_id_bidx text CHECK (keyvault.is_bidx(national_id_bidx)),
  ADD COLUMN national_id_hint text CHECK (national_id_hint IS NULL OR length(national_id_hint) <= 32),
  ADD CONSTRAINT bookings_phone_present_ck CHECK (phone IS NOT NULL OR (phone_enc IS NOT NULL AND phone_bidx IS NOT NULL AND phone_hint IS NOT NULL)),
  ADD CONSTRAINT bookings_nid_sealed_ck CHECK ((national_id_enc IS NULL) = (national_id_bidx IS NULL) AND (national_id_enc IS NULL) = (national_id_hint IS NULL));
CREATE UNIQUE INDEX bookings_one_per_phone_bidx_day_uk ON clinical.bookings (tenant_id, organization_id, visit_date, phone_bidx)
  WHERE status = 'booked' AND phone_bidx IS NOT NULL;
CREATE TRIGGER bookings_z_no_plaintext BEFORE INSERT OR UPDATE ON clinical.bookings
  FOR EACH ROW EXECUTE FUNCTION keyvault.forbid_plaintext('phone', 'national_id');

-- Nội dung lịch hẹn vẫn bất biến; riêng các cột PII chỉ được đổi theo hướng bản rõ -> NULL / bản mã (backfill, xoay khoá).
CREATE OR REPLACE FUNCTION clinical.bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pii constant text[] := ARRAY['phone', 'national_id', 'phone_enc', 'phone_bidx', 'phone_hint', 'national_id_enc', 'national_id_bidx', 'national_id_hint'];
  outcome constant text[] := ARRAY['status', 'patient_id', 'ticket_id', 'checked_in_by', 'checked_in_at', 'cancelled_by', 'cancelled_at', 'version', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - outcome - pii) IS DISTINCT FROM (to_jsonb(OLD) - outcome - pii) THEN
    RAISE EXCEPTION 'booking details are immutable' USING ERRCODE = '42501';
  END IF;
  -- Đã mã hoá thì không được xoá bản mã (chỉ thay bằng bản mã khác khi xoay khoá).
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

-- ---------------------------------------------------------------------------
-- 5. Ảnh chụp gộp hồ sơ: chỉ được thay phone/email bản rõ bằng khối 'contact' đã mã hoá
-- ---------------------------------------------------------------------------
CREATE FUNCTION patient.person_merges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok_src boolean;
  ok_tgt boolean;
  f constant text[] := ARRAY['phone', 'email', 'contact'];
BEGIN
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
DROP TRIGGER person_merges_immutable ON patient.person_merges;
CREATE TRIGGER person_merges_immutable BEFORE UPDATE OR DELETE ON patient.person_merges
  FOR EACH ROW EXECUTE FUNCTION patient.person_merges_guard();

-- Đường duy nhất để sửa ảnh chụp (dùng bởi scripts/pii-backfill.ts). SECURITY DEFINER: role ứng dụng không có quyền UPDATE bảng này.
CREATE FUNCTION patient.seal_merge_snapshot(p_merge uuid, p_source jsonb, p_target jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM set_config('hcos.seal_snapshot', 'on', true);
  UPDATE patient.person_merges SET source_snapshot = p_source, target_snapshot = p_target
   WHERE tenant_id = platform.current_tenant_id() AND merge_id = p_merge;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge % not found for current tenant', p_merge USING ERRCODE = '42704';
  END IF;
  PERFORM set_config('hcos.seal_snapshot', 'off', true);
END
$$;
REVOKE ALL ON FUNCTION patient.seal_merge_snapshot(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.seal_merge_snapshot(uuid, jsonb, jsonb) TO hcos_app;

COMMIT;
