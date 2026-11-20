-- HCOS-F5 — Kê đơn thuốc (đơn ngoại trú) + cấp phát theo đơn.
--
-- Bất biến được giữ ở tầng DB (không chỉ ở service):
--  1. Đơn thuộc đúng một đợt khám, cùng bệnh nhân và cùng organization với đợt khám (FK ghép).
--  2. Chỉ kê đơn khi đợt khám đang mở (in_progress).
--  3. Nội dung đơn và dòng thuốc bất biến sau khi tạo; chỉ đổi được trạng thái đơn và số đã cấp.
--  4. Trạng thái: active -> completed (chỉ khi mọi dòng đã cấp đủ) | cancelled (chỉ khi chưa cấp gì) | entered_in_error.
--  5. Số đã cấp của mỗi dòng = tổng sổ cái cấp phát gắn với dòng đó; cấp đúng thuốc, đúng đợt khám; không vượt số kê.
--     (constraint trigger hoãn tới cuối transaction, giống ràng buộc tồn kho khớp sổ cái ở 006).
--  6. Không DELETE / TRUNCATE; mọi UPDATE đều lưu snapshot vào clinical.record_history; RLS FORCE theo tenant.
BEGIN;

-- Cho phép FK ghép (encounter + organization).
ALTER TABLE clinical.encounters
  ADD CONSTRAINT encounters_tenant_encounter_org_uk UNIQUE (tenant_id, encounter_id, organization_id);

-- ---------------------------------------------------------------------------
-- 1. Đơn thuốc
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.prescriptions (
  prescription_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  encounter_id       uuid        NOT NULL,
  patient_id         uuid        NOT NULL,
  prescriber_user_id uuid        NOT NULL,
  status             text        NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'completed', 'cancelled', 'entered_in_error')),
  note               text        CHECK (note IS NULL OR length(note) <= 1000),
  prescribed_at      timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (prescription_id),
  CONSTRAINT prescriptions_tenant_id_uk UNIQUE (tenant_id, prescription_id),
  CONSTRAINT prescriptions_encounter_patient_fk FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, patient_id),
  CONSTRAINT prescriptions_encounter_org_fk FOREIGN KEY (tenant_id, encounter_id, organization_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, organization_id),
  CONSTRAINT prescriptions_prescriber_fk FOREIGN KEY (tenant_id, prescriber_user_id)
    REFERENCES iam.users (tenant_id, user_id)
);
CREATE INDEX prescriptions_tenant_encounter_idx ON clinical.prescriptions (tenant_id, encounter_id);
CREATE INDEX prescriptions_tenant_org_status_idx ON clinical.prescriptions (tenant_id, organization_id, status, prescribed_at);

-- ---------------------------------------------------------------------------
-- 2. Dòng thuốc (liều mỗi lần, số lần/ngày, số ngày — theo yêu cầu ghi đơn của TT 26/2025/TT-BYT)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.prescription_items (
  item_id             uuid          NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid          NOT NULL REFERENCES iam.tenants (tenant_id),
  prescription_id     uuid          NOT NULL,
  line_no             smallint      NOT NULL CHECK (line_no BETWEEN 1 AND 50),
  medication_id       uuid          NOT NULL,
  dose_quantity       numeric(10,3) NOT NULL CHECK (dose_quantity > 0),
  dose_unit           text          NOT NULL CHECK (length(dose_unit) BETWEEN 1 AND 32),
  frequency_per_day   smallint      NOT NULL CHECK (frequency_per_day BETWEEN 1 AND 24),
  duration_days       smallint      NOT NULL CHECK (duration_days BETWEEN 1 AND 180),
  instructions        text          CHECK (instructions IS NULL OR length(instructions) <= 500),
  quantity_prescribed integer       NOT NULL CHECK (quantity_prescribed BETWEEN 1 AND 100000),
  quantity_dispensed  integer       NOT NULL DEFAULT 0 CHECK (quantity_dispensed >= 0),
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  version             bigint        NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (item_id),
  CONSTRAINT prescription_items_tenant_id_uk UNIQUE (tenant_id, item_id),
  CONSTRAINT prescription_items_line_uk UNIQUE (tenant_id, prescription_id, line_no),
  CONSTRAINT prescription_items_medication_uk UNIQUE (tenant_id, prescription_id, medication_id),
  CONSTRAINT prescription_items_not_over_ck CHECK (quantity_dispensed <= quantity_prescribed),
  CONSTRAINT prescription_items_prescription_fk FOREIGN KEY (tenant_id, prescription_id)
    REFERENCES clinical.prescriptions (tenant_id, prescription_id),
  CONSTRAINT prescription_items_medication_fk FOREIGN KEY (tenant_id, medication_id)
    REFERENCES pharmacy.medications (tenant_id, medication_id)
);

-- ---------------------------------------------------------------------------
-- 3. Liên kết sổ cái cấp phát với dòng đơn
-- ---------------------------------------------------------------------------
ALTER TABLE pharmacy.stock_movements ADD COLUMN prescription_item_id uuid;
ALTER TABLE pharmacy.stock_movements
  ADD CONSTRAINT stock_movements_prescription_item_fk FOREIGN KEY (tenant_id, prescription_item_id)
    REFERENCES clinical.prescription_items (tenant_id, item_id),
  ADD CONSTRAINT stock_movements_prescription_item_ck CHECK (prescription_item_id IS NULL OR movement_type = 'dispense');
CREATE INDEX stock_movements_prescription_item_idx ON pharmacy.stock_movements (tenant_id, prescription_item_id)
  WHERE prescription_item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION clinical.prescriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_dispensed bigint;
  v_open      bigint;
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'prescription content is immutable (cancel and prescribe again)' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'prescription % is % and cannot change status', OLD.prescription_id, OLD.status USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(quantity_dispensed), 0), COUNT(*) FILTER (WHERE quantity_dispensed < quantity_prescribed)
    INTO v_dispensed, v_open
    FROM clinical.prescription_items
   WHERE tenant_id = NEW.tenant_id AND prescription_id = NEW.prescription_id;

  IF NEW.status = 'cancelled' AND v_dispensed > 0 THEN
    RAISE EXCEPTION 'prescription % already has dispensed items and cannot be cancelled', OLD.prescription_id USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'completed' AND v_open > 0 THEN
    RAISE EXCEPTION 'prescription % is not fully dispensed', OLD.prescription_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION clinical.prescription_items_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM clinical.prescriptions
   WHERE tenant_id = NEW.tenant_id AND prescription_id = NEW.prescription_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'cannot add items to prescription % (status=%)', NEW.prescription_id, COALESCE(v_status, 'missing')
      USING ERRCODE = '55000';
  END IF;
  IF NEW.quantity_dispensed <> 0 THEN
    RAISE EXCEPTION 'new prescription item must start with quantity_dispensed = 0' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION clinical.prescription_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF (to_jsonb(NEW) - ARRAY['quantity_dispensed', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['quantity_dispensed', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'prescription item content is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.quantity_dispensed < OLD.quantity_dispensed THEN
    RAISE EXCEPTION 'quantity_dispensed cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF NEW.quantity_dispensed > OLD.quantity_dispensed THEN
    SELECT status INTO v_status FROM clinical.prescriptions
     WHERE tenant_id = NEW.tenant_id AND prescription_id = NEW.prescription_id;
    IF v_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'prescription % is % and cannot be dispensed', NEW.prescription_id, v_status USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER prescriptions_a_require_open BEFORE INSERT ON clinical.prescriptions
  FOR EACH ROW EXECUTE FUNCTION clinical.require_encounter_status('in_progress');
CREATE TRIGGER prescriptions_b_guard   BEFORE UPDATE ON clinical.prescriptions FOR EACH ROW EXECUTE FUNCTION clinical.prescriptions_guard();
CREATE TRIGGER prescriptions_c_history BEFORE UPDATE ON clinical.prescriptions FOR EACH ROW EXECUTE FUNCTION clinical.snapshot_history('prescription_id');
CREATE TRIGGER prescriptions_d_version BEFORE UPDATE ON clinical.prescriptions FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

CREATE TRIGGER prescription_items_a_insert BEFORE INSERT ON clinical.prescription_items
  FOR EACH ROW EXECUTE FUNCTION clinical.prescription_items_insert_guard();
CREATE TRIGGER prescription_items_b_guard   BEFORE UPDATE ON clinical.prescription_items FOR EACH ROW EXECUTE FUNCTION clinical.prescription_items_guard();
CREATE TRIGGER prescription_items_c_history BEFORE UPDATE ON clinical.prescription_items FOR EACH ROW EXECUTE FUNCTION clinical.snapshot_history('item_id');
CREATE TRIGGER prescription_items_d_version BEFORE UPDATE ON clinical.prescription_items FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 5. Số đã cấp khớp sổ cái; cấp đúng thuốc, đúng đợt khám (kiểm ở cuối transaction)
-- ---------------------------------------------------------------------------
CREATE FUNCTION clinical.assert_item_matches_ledger(p_tenant uuid, p_item uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_item     clinical.prescription_items%ROWTYPE;
  v_encounter uuid;
  v_ledger   bigint;
  v_wrong    bigint;
BEGIN
  SELECT * INTO v_item FROM clinical.prescription_items WHERE tenant_id = p_tenant AND item_id = p_item;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT encounter_id INTO v_encounter FROM clinical.prescriptions
   WHERE tenant_id = p_tenant AND prescription_id = v_item.prescription_id;

  SELECT COALESCE(SUM(m.quantity), 0),
         COUNT(*) FILTER (WHERE b.medication_id <> v_item.medication_id OR m.encounter_id IS DISTINCT FROM v_encounter)
    INTO v_ledger, v_wrong
    FROM pharmacy.stock_movements m
    JOIN pharmacy.batches b ON b.tenant_id = m.tenant_id AND b.batch_id = m.batch_id
   WHERE m.tenant_id = p_tenant AND m.prescription_item_id = p_item;

  IF v_wrong > 0 THEN
    RAISE EXCEPTION 'dispense movements for prescription item % must match its medication and encounter', p_item
      USING ERRCODE = '23514';
  END IF;
  IF v_ledger <> v_item.quantity_dispensed THEN
    RAISE EXCEPTION 'prescription item % dispensed quantity does not match ledger: item=% ledger=%',
      p_item, v_item.quantity_dispensed, v_ledger USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION clinical.prescription_items_ledger_t() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM clinical.assert_item_matches_ledger(NEW.tenant_id, NEW.item_id);
  RETURN NULL;
END
$$;

CREATE FUNCTION pharmacy.movements_prescription_t() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prescription_item_id IS NOT NULL THEN
    PERFORM clinical.assert_item_matches_ledger(NEW.tenant_id, NEW.prescription_item_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER prescription_items_ledger_ct
  AFTER INSERT OR UPDATE ON clinical.prescription_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clinical.prescription_items_ledger_t();

CREATE CONSTRAINT TRIGGER stock_movements_prescription_ct
  AFTER INSERT ON pharmacy.stock_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy.movements_prescription_t();

-- ---------------------------------------------------------------------------
-- 6. Không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical.prescriptions', 'clinical.prescription_items']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation()',
                   replace(t, '.', '_') || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation()',
                   replace(t, '.', '_') || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO hcos_app
         USING (tenant_id = platform.current_tenant_id())
         WITH CHECK (tenant_id = platform.current_tenant_id())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON clinical.prescriptions, clinical.prescription_items TO hcos_app;
REVOKE DELETE, TRUNCATE ON clinical.prescriptions, clinical.prescription_items FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
