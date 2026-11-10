-- HCOS-P0-ENG-001 | Slice S3 | 006: hardening của schema pharmacy (sau rà soát code 2026-11-10)
--
--  1. FK ghép (tenant_id, id): FK đơn cột bỏ qua RLS nên tenant B tham chiếu được lô/kho/lượt khám của tenant A.
--  2. CHECK hình dạng sổ cái theo movement_type (dispense phải có kho nguồn + lượt khám, receipt phải có kho đích...).
--  3. Lô (batches) bất biến sau khi tạo: không đổi hạn dùng, số lô, thuốc.
--  4. Tồn kho phải khớp sổ cái: constraint trigger hoãn đến COMMIT, chặn mọi sửa tồn kho không có dòng sổ cái
--     tương ứng (kể cả lost update do ghi đè từ số đọc cũ).
-- Chỉ kiểm các dòng bị chạm sau migration; dữ liệu cũ không bị validate lại.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Khóa ghép để FK giữ đúng tenant
-- ---------------------------------------------------------------------------
ALTER TABLE pharmacy.substances      ADD CONSTRAINT substances_tenant_id_uk      UNIQUE (tenant_id, substance_id);
ALTER TABLE pharmacy.medications     ADD CONSTRAINT medications_tenant_id_uk     UNIQUE (tenant_id, medication_id);
ALTER TABLE pharmacy.stock_locations ADD CONSTRAINT stock_locations_tenant_id_uk UNIQUE (tenant_id, location_id);
ALTER TABLE pharmacy.batches         ADD CONSTRAINT batches_tenant_id_uk         UNIQUE (tenant_id, batch_id);

ALTER TABLE pharmacy.medications DROP CONSTRAINT medications_substance_id_fkey;
ALTER TABLE pharmacy.medications
  ADD CONSTRAINT medications_substance_fk FOREIGN KEY (tenant_id, substance_id)
  REFERENCES pharmacy.substances (tenant_id, substance_id);

ALTER TABLE pharmacy.stock_locations
  ADD CONSTRAINT stock_locations_org_fk FOREIGN KEY (tenant_id, organization_id)
  REFERENCES iam.organizations (tenant_id, organization_id);

ALTER TABLE pharmacy.batches DROP CONSTRAINT batches_medication_id_fkey;
ALTER TABLE pharmacy.batches
  ADD CONSTRAINT batches_medication_fk FOREIGN KEY (tenant_id, medication_id)
  REFERENCES pharmacy.medications (tenant_id, medication_id);

ALTER TABLE pharmacy.inventory_balances DROP CONSTRAINT inventory_balances_location_id_fkey;
ALTER TABLE pharmacy.inventory_balances DROP CONSTRAINT inventory_balances_batch_id_fkey;
ALTER TABLE pharmacy.inventory_balances
  ADD CONSTRAINT inventory_balances_location_fk FOREIGN KEY (tenant_id, location_id)
  REFERENCES pharmacy.stock_locations (tenant_id, location_id),
  ADD CONSTRAINT inventory_balances_batch_fk FOREIGN KEY (tenant_id, batch_id)
  REFERENCES pharmacy.batches (tenant_id, batch_id);

ALTER TABLE pharmacy.stock_movements DROP CONSTRAINT stock_movements_source_location_id_fkey;
ALTER TABLE pharmacy.stock_movements DROP CONSTRAINT stock_movements_destination_location_id_fkey;
ALTER TABLE pharmacy.stock_movements DROP CONSTRAINT stock_movements_batch_id_fkey;
ALTER TABLE pharmacy.stock_movements DROP CONSTRAINT stock_movements_encounter_id_fkey;
ALTER TABLE pharmacy.stock_movements
  ADD CONSTRAINT stock_movements_source_fk FOREIGN KEY (tenant_id, source_location_id)
  REFERENCES pharmacy.stock_locations (tenant_id, location_id),
  ADD CONSTRAINT stock_movements_destination_fk FOREIGN KEY (tenant_id, destination_location_id)
  REFERENCES pharmacy.stock_locations (tenant_id, location_id),
  ADD CONSTRAINT stock_movements_batch_fk FOREIGN KEY (tenant_id, batch_id)
  REFERENCES pharmacy.batches (tenant_id, batch_id),
  ADD CONSTRAINT stock_movements_encounter_fk FOREIGN KEY (tenant_id, encounter_id)
  REFERENCES clinical.encounters (tenant_id, encounter_id);

-- ---------------------------------------------------------------------------
-- 2. Hình dạng sổ cái và dữ liệu lô
-- ---------------------------------------------------------------------------
ALTER TABLE pharmacy.stock_movements
  ADD CONSTRAINT stock_movements_shape_ck CHECK (
       (movement_type = 'receipt'    AND destination_location_id IS NOT NULL AND source_location_id IS NULL)
    OR (movement_type = 'dispense'   AND source_location_id IS NOT NULL AND destination_location_id IS NULL
                                     AND encounter_id IS NOT NULL)
    OR (movement_type = 'disposal'   AND source_location_id IS NOT NULL AND destination_location_id IS NULL)
    OR (movement_type = 'transfer'   AND source_location_id IS NOT NULL AND destination_location_id IS NOT NULL
                                     AND source_location_id <> destination_location_id)
    OR (movement_type = 'adjustment' AND num_nonnulls(source_location_id, destination_location_id) = 1)
  );

ALTER TABLE pharmacy.batches
  ADD CONSTRAINT batches_unit_cost_ck CHECK (unit_cost >= 0),
  ADD CONSTRAINT batches_dates_ck CHECK (manufacturing_date IS NULL OR manufacturing_date < expiry_date);

-- ---------------------------------------------------------------------------
-- 3. Lô bất biến (áp cả với owner/superuser; role app còn bị thu quyền UPDATE)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pharmacy.batches_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.medication_id <> OLD.medication_id
     OR NEW.batch_number <> OLD.batch_number OR NEW.expiry_date <> OLD.expiry_date
     OR NEW.manufacturing_date IS DISTINCT FROM OLD.manufacturing_date
     OR NEW.unit_cost <> OLD.unit_cost THEN
    RAISE EXCEPTION 'pharmacy.batches is immutable (batch %)', OLD.batch_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER batches_immutable_t BEFORE UPDATE ON pharmacy.batches
  FOR EACH ROW EXECUTE FUNCTION pharmacy.batches_immutable();
REVOKE UPDATE ON pharmacy.batches FROM PUBLIC, hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 4. Tồn kho = tổng nhập đích - tổng xuất nguồn trong sổ cái (kiểm khi COMMIT)
--    Chạy với quyền người gọi nên chịu RLS: luôn có app.tenant_id khi app ghi.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pharmacy.assert_balance_matches_ledger(p_tenant uuid, p_location uuid, p_batch uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_ledger bigint;
  v_onhand bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN destination_location_id = p_location THEN quantity ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN source_location_id      = p_location THEN quantity ELSE 0 END), 0)
    INTO v_ledger
    FROM pharmacy.stock_movements
   WHERE tenant_id = p_tenant AND batch_id = p_batch
     AND (destination_location_id = p_location OR source_location_id = p_location);

  SELECT COALESCE(MAX(quantity_on_hand), 0) INTO v_onhand
    FROM pharmacy.inventory_balances
   WHERE tenant_id = p_tenant AND location_id = p_location AND batch_id = p_batch;

  IF v_ledger <> v_onhand THEN
    RAISE EXCEPTION 'stock balance does not match movement ledger (location %, batch %): ledger=% on_hand=%',
      p_location, p_batch, v_ledger, v_onhand USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION pharmacy.balances_check_t() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy.assert_balance_matches_ledger(NEW.tenant_id, NEW.location_id, NEW.batch_id);
  RETURN NULL;
END
$$;

CREATE FUNCTION pharmacy.movements_check_t() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_location_id IS NOT NULL THEN
    PERFORM pharmacy.assert_balance_matches_ledger(NEW.tenant_id, NEW.source_location_id, NEW.batch_id);
  END IF;
  IF NEW.destination_location_id IS NOT NULL THEN
    PERFORM pharmacy.assert_balance_matches_ledger(NEW.tenant_id, NEW.destination_location_id, NEW.batch_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER inventory_balances_ledger_ct
  AFTER INSERT OR UPDATE ON pharmacy.inventory_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy.balances_check_t();

CREATE CONSTRAINT TRIGGER stock_movements_ledger_ct
  AFTER INSERT ON pharmacy.stock_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pharmacy.movements_check_t();

COMMIT;
