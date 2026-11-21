-- HCOS-F19 — Thiết bị & vật tư y khoa.
--
-- Hai luồng tách riêng:
--  A. VẬT TƯ TIÊU HAO (gạc, bơm tiêm, que thử…) dùng chung kho Lô / FEFO của Dược (pharmacy.medications.item_kind = 'supply').
--     * Định mức theo dịch vụ (equipment.supply_norms): bảng giá dịch vụ × vật tư × số lượng / lần.
--     * Khi TẤT TOÁN hồ sơ thanh toán: equipment.consume_case() trừ kho theo định mức (sổ cái 'consume', gắn hồ sơ),
--       ưu tiên LÔ GHI THỰC TẾ (điều dưỡng quét / ghi lúc làm thủ thuật), phần còn lại tự chọn theo FEFO. Thiếu tồn KHÔNG
--       chặn tất toán: ghi dòng 'shortfall' chờ đối soát. Giá vốn = số lượng × đơn giá nhập của lô (thiếu: đơn giá lô gần nhất).
--     * Truy xuất thu hồi: lô => người bệnh (equipment.supply_consumptions), phân biệt 'recorded' (chắc chắn) / 'fefo' (suy ra).
--  B. THIẾT BỊ ĐỊNH DANH (máy siêu âm, monitor, nồi hấp…): từng chiếc có mã tài sản TByy-nnnn-c (số kiểm tra Luhn), serial,
--     phòng đặt máy, phân loại rủi ro A–D (NĐ 98/2021/NĐ-CP), số lưu hành, bảo hành, nguyên giá + số tháng khấu hao.
--     * Trạng thái CHỈ đổi qua nhật ký chỉ-thêm (equipment.device_events): role ứng dụng không có quyền UPDATE cột status.
--     * Chế độ kiểm định / hiệu chuẩn theo từng máy + lần kiểm định chỉ-thêm. Máy hỏng / bảo trì, hoặc chế độ BẮT BUỘC quá hạn /
--       không đạt / chưa kiểm định / sửa chữa lớn chưa kiểm định lại => máy "không được dùng".
--     * Dịch vụ cần loại máy (equipment.service_requirements): CSDL chặn ghi chi phí dịch vụ khi cơ sở không còn máy dùng được.
BEGIN;

CREATE SCHEMA equipment;
GRANT USAGE ON SCHEMA equipment TO hcos_app;

-- ---------------------------------------------------------------------------
-- A1. Vật tư = mặt hàng kho dược loại 'supply'; không kê đơn được
-- ---------------------------------------------------------------------------
ALTER TABLE pharmacy.medications
  ADD COLUMN item_kind text NOT NULL DEFAULT 'drug' CHECK (item_kind IN ('drug', 'supply'));

CREATE FUNCTION clinical.prescription_items_drug_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT item_kind FROM pharmacy.medications WHERE tenant_id = NEW.tenant_id AND medication_id = NEW.medication_id) = 'supply' THEN
    RAISE EXCEPTION 'medication % is a consumable supply, not a drug', NEW.medication_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER prescription_items_a0_drug_only BEFORE INSERT ON clinical.prescription_items
  FOR EACH ROW EXECUTE FUNCTION clinical.prescription_items_drug_only();

-- Sổ cái: loại 'consume' (xuất vật tư khi tất toán), gắn hồ sơ thanh toán.
ALTER TABLE pharmacy.stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE pharmacy.stock_movements DROP CONSTRAINT stock_movements_shape_ck;
ALTER TABLE pharmacy.stock_movements ADD COLUMN billing_case_id uuid;
ALTER TABLE pharmacy.stock_movements
  ADD CONSTRAINT stock_movements_movement_type_check
    CHECK (movement_type IN ('receipt', 'transfer', 'dispense', 'adjustment', 'disposal', 'consume')),
  ADD CONSTRAINT stock_movements_shape_ck CHECK (
       (movement_type = 'receipt'    AND destination_location_id IS NOT NULL AND source_location_id IS NULL)
    OR (movement_type = 'dispense'   AND source_location_id IS NOT NULL AND destination_location_id IS NULL
                                     AND encounter_id IS NOT NULL)
    OR (movement_type = 'consume'    AND source_location_id IS NOT NULL AND destination_location_id IS NULL)
    OR (movement_type = 'disposal'   AND source_location_id IS NOT NULL AND destination_location_id IS NULL)
    OR (movement_type = 'transfer'   AND source_location_id IS NOT NULL AND destination_location_id IS NOT NULL
                                     AND source_location_id <> destination_location_id)
    OR (movement_type = 'adjustment' AND num_nonnulls(source_location_id, destination_location_id) = 1)
  ),
  ADD CONSTRAINT stock_movements_consume_case_ck CHECK ((movement_type = 'consume') = (billing_case_id IS NOT NULL));
CREATE INDEX stock_movements_case_idx ON pharmacy.stock_movements (tenant_id, billing_case_id) WHERE billing_case_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- A2. Cài đặt: kho / tủ trừ vật tư của cơ sở
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.supply_settings (
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  location_id      uuid,
  updated_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, organization_id),
  CONSTRAINT supply_settings_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT supply_settings_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES pharmacy.stock_locations (tenant_id, location_id),
  CONSTRAINT supply_settings_user_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER supply_settings_version BEFORE UPDATE ON equipment.supply_settings FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();
CREATE FUNCTION equipment.supply_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pharmacy.stock_locations WHERE tenant_id = NEW.tenant_id AND location_id = NEW.location_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'location % is not in organization %', NEW.location_id, NEW.organization_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supply_settings_guard BEFORE INSERT OR UPDATE ON equipment.supply_settings FOR EACH ROW EXECUTE FUNCTION equipment.supply_settings_guard();

-- ---------------------------------------------------------------------------
-- A3. Định mức vật tư theo dịch vụ (bảng giá)
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.supply_norms (
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  item_id          uuid        NOT NULL,
  medication_id    uuid        NOT NULL,
  quantity         integer     NOT NULL CHECK (quantity BETWEEN 0 AND 1000),  -- 0 = bỏ khỏi định mức (giữ lịch sử phiên bản)
  updated_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, item_id, medication_id),
  CONSTRAINT supply_norms_item_fk FOREIGN KEY (tenant_id, item_id, organization_id) REFERENCES finance.price_items (tenant_id, item_id, organization_id),
  CONSTRAINT supply_norms_med_fk FOREIGN KEY (tenant_id, medication_id) REFERENCES pharmacy.medications (tenant_id, medication_id),
  CONSTRAINT supply_norms_user_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER supply_norms_version BEFORE UPDATE ON equipment.supply_norms FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();
CREATE FUNCTION equipment.supply_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT item_kind FROM pharmacy.medications WHERE tenant_id = NEW.tenant_id AND medication_id = NEW.medication_id) IS DISTINCT FROM 'supply' THEN
    RAISE EXCEPTION 'medication % is not a consumable supply', NEW.medication_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supply_norms_supply_only BEFORE INSERT OR UPDATE ON equipment.supply_norms FOR EACH ROW EXECUTE FUNCTION equipment.supply_only();

-- ---------------------------------------------------------------------------
-- A4. Lô ghi thực tế lúc làm thủ thuật (gắn hồ sơ thanh toán đang mở của người bệnh)
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.supply_lot_usages (
  usage_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  case_id          uuid        NOT NULL,
  patient_id       uuid        NOT NULL,
  medication_id    uuid        NOT NULL,
  batch_id         uuid        NOT NULL,
  quantity         integer     NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  recorded_by      uuid        NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_by     uuid,
  cancelled_at     timestamptz,
  cancel_reason    text        CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 300),
  PRIMARY KEY (usage_id),
  CONSTRAINT lot_usages_tenant_uk UNIQUE (tenant_id, usage_id),
  CONSTRAINT lot_usages_case_fk FOREIGN KEY (tenant_id, case_id, organization_id) REFERENCES finance.billing_cases (tenant_id, case_id, organization_id),
  CONSTRAINT lot_usages_patient_fk FOREIGN KEY (tenant_id, patient_id, organization_id) REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT lot_usages_med_fk FOREIGN KEY (tenant_id, medication_id) REFERENCES pharmacy.medications (tenant_id, medication_id),
  CONSTRAINT lot_usages_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES pharmacy.batches (tenant_id, batch_id),
  CONSTRAINT lot_usages_by_fk FOREIGN KEY (tenant_id, recorded_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT lot_usages_cancel_fk FOREIGN KEY (tenant_id, cancelled_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT lot_usages_cancel_ck CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX lot_usages_case_idx ON equipment.supply_lot_usages (tenant_id, case_id);
CREATE INDEX lot_usages_batch_idx ON equipment.supply_lot_usages (tenant_id, batch_id);
CREATE FUNCTION equipment.lot_usages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_patient uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'lot usage must be created active' USING ERRCODE = '23514'; END IF;
    IF (SELECT medication_id FROM pharmacy.batches WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.batch_id) IS DISTINCT FROM NEW.medication_id THEN
      RAISE EXCEPTION 'batch % is not a batch of %', NEW.batch_id, NEW.medication_id USING ERRCODE = '23514';
    END IF;
    SELECT patient_id INTO v_patient FROM finance.billing_cases WHERE tenant_id = NEW.tenant_id AND case_id = NEW.case_id;
    IF v_patient IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'case/patient mismatch' USING ERRCODE = '23514'; END IF;
  ELSE
    IF (NEW.tenant_id, NEW.organization_id, NEW.case_id, NEW.patient_id, NEW.medication_id, NEW.batch_id, NEW.quantity, NEW.recorded_by, NEW.recorded_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.organization_id, OLD.case_id, OLD.patient_id, OLD.medication_id, OLD.batch_id, OLD.quantity, OLD.recorded_by, OLD.recorded_at) THEN
      RAISE EXCEPTION 'lot usage content is immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'active' THEN RAISE EXCEPTION 'lot usage can only be cancelled once' USING ERRCODE = '55000'; END IF;
  END IF;
  -- Chỉ ghi / huỷ khi hồ sơ còn mở (khoá chia sẻ: không chen được vào lúc đang tất toán).
  PERFORM finance.require_open_case(NEW.tenant_id, NEW.case_id, NEW.organization_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER lot_usages_guard BEFORE INSERT OR UPDATE ON equipment.supply_lot_usages FOR EACH ROW EXECUTE FUNCTION equipment.lot_usages_guard();
CREATE TRIGGER lot_usages_supply_only BEFORE INSERT ON equipment.supply_lot_usages FOR EACH ROW EXECUTE FUNCTION equipment.supply_only();

-- ---------------------------------------------------------------------------
-- A5. Vật tư đã trừ khi tất toán (chỉ-thêm) — giá vốn + truy xuất lô
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.supply_consumptions (
  consumption_id   uuid          NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid          NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid          NOT NULL,
  case_id          uuid          NOT NULL,
  patient_id       uuid          NOT NULL,
  charge_id        uuid,                       -- NULL = lô ghi thực tế vượt định mức
  usage_id         uuid,                       -- lô do người dùng ghi (nếu có)
  medication_id    uuid          NOT NULL,
  batch_id         uuid,                       -- NULL chỉ khi thiếu tồn và không biết lô
  quantity         integer       NOT NULL CHECK (quantity > 0),
  unit_cost        numeric(15,4) NOT NULL CHECK (unit_cost >= 0),
  cost             numeric(18,2) GENERATED ALWAYS AS (round(quantity * unit_cost, 2)) STORED,
  source           text          NOT NULL CHECK (source IN ('recorded', 'fefo', 'shortfall')),
  movement_id      uuid,
  location_id      uuid,
  created_by       uuid          NOT NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (consumption_id),
  CONSTRAINT consumptions_tenant_uk UNIQUE (tenant_id, consumption_id),
  CONSTRAINT consumptions_case_fk FOREIGN KEY (tenant_id, case_id, organization_id) REFERENCES finance.billing_cases (tenant_id, case_id, organization_id),
  CONSTRAINT consumptions_patient_fk FOREIGN KEY (tenant_id, patient_id, organization_id) REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT consumptions_usage_fk FOREIGN KEY (tenant_id, usage_id) REFERENCES equipment.supply_lot_usages (tenant_id, usage_id),
  CONSTRAINT consumptions_med_fk FOREIGN KEY (tenant_id, medication_id) REFERENCES pharmacy.medications (tenant_id, medication_id),
  CONSTRAINT consumptions_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES pharmacy.batches (tenant_id, batch_id),
  CONSTRAINT consumptions_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT consumptions_shape_ck CHECK (
       (source = 'shortfall' AND movement_id IS NULL)
    OR (source = 'fefo'      AND movement_id IS NOT NULL AND batch_id IS NOT NULL AND usage_id IS NULL)
    OR (source = 'recorded'  AND movement_id IS NOT NULL AND batch_id IS NOT NULL AND usage_id IS NOT NULL))
);
CREATE INDEX consumptions_case_idx ON equipment.supply_consumptions (tenant_id, case_id);
CREATE INDEX consumptions_batch_idx ON equipment.supply_consumptions (tenant_id, batch_id);
CREATE INDEX consumptions_created_idx ON equipment.supply_consumptions (tenant_id, organization_id, created_at);

-- Đối soát dòng thiếu (chỉ-thêm).
CREATE TABLE equipment.supply_shortfall_resolutions (
  consumption_id   uuid        NOT NULL,
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  note             text        NOT NULL CHECK (length(btrim(note)) BETWEEN 5 AND 500),
  resolved_by      uuid        NOT NULL,
  resolved_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumption_id),
  CONSTRAINT shortfall_res_fk FOREIGN KEY (tenant_id, consumption_id) REFERENCES equipment.supply_consumptions (tenant_id, consumption_id),
  CONSTRAINT shortfall_res_by_fk FOREIGN KEY (tenant_id, resolved_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE FUNCTION equipment.shortfall_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT source FROM equipment.supply_consumptions WHERE tenant_id = NEW.tenant_id AND consumption_id = NEW.consumption_id) IS DISTINCT FROM 'shortfall' THEN
    RAISE EXCEPTION 'only shortfall lines can be resolved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shortfall_res_only BEFORE INSERT ON equipment.supply_shortfall_resolutions FOR EACH ROW EXECUTE FUNCTION equipment.shortfall_only();

-- Đơn giá dự phòng của mặt hàng (lô nhập gần nhất).
CREATE FUNCTION equipment.last_unit_cost(p_tenant uuid, p_med uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT unit_cost FROM pharmacy.batches WHERE tenant_id = p_tenant AND medication_id = p_med ORDER BY created_at DESC, batch_id LIMIT 1), 0)
$$;

-- Trừ một lượng của MỘT lô tại kho; trả về lượng thực trừ được (≤ p_qty).
CREATE FUNCTION equipment._take_lot(p_tenant uuid, p_loc uuid, p_batch uuid, p_qty integer, p_case uuid, p_by uuid) RETURNS TABLE (taken integer, movement_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_avail integer;
  v_take integer;
  v_mov uuid;
BEGIN
  SELECT quantity_on_hand - quantity_reserved INTO v_avail FROM pharmacy.inventory_balances
   WHERE tenant_id = p_tenant AND location_id = p_loc AND batch_id = p_batch FOR UPDATE;
  v_take := LEAST(p_qty, GREATEST(COALESCE(v_avail, 0), 0));
  IF v_take > 0 THEN
    UPDATE pharmacy.inventory_balances SET quantity_on_hand = quantity_on_hand - v_take, updated_at = now()
     WHERE tenant_id = p_tenant AND location_id = p_loc AND batch_id = p_batch;
    INSERT INTO pharmacy.stock_movements (tenant_id, source_location_id, batch_id, quantity, movement_type, billing_case_id, reason, performed_by)
    VALUES (p_tenant, p_loc, p_batch, v_take, 'consume', p_case, 'Vật tư theo định mức khi tất toán', p_by)
    RETURNING stock_movements.movement_id INTO v_mov;
  END IF;
  RETURN QUERY SELECT v_take, v_mov;
END
$$;

/*
 * Trừ vật tư của hồ sơ thanh toán VỪA TẤT TOÁN (gọi trong cùng transaction, sau khi đóng hồ sơ). Chạy với quyền người gọi (RLS).
 * Chạy lại cho cùng hồ sơ => không trừ thêm.
 */
CREATE FUNCTION equipment.consume_case(p_tenant uuid, p_case uuid, p_by uuid)
RETURNS TABLE (lines integer, shortfall_qty integer, cogs numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
  v_patient uuid;
  v_status text;
  v_loc uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  n record;
  u record;
  b record;
  v_need integer;
  v_part integer;
  v_taken integer;
  v_mov uuid;
BEGIN
  SELECT organization_id, patient_id, status INTO v_org, v_patient, v_status
    FROM finance.billing_cases WHERE tenant_id = p_tenant AND case_id = p_case;
  IF v_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'billing case % is not closed', p_case USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM equipment.supply_consumptions WHERE tenant_id = p_tenant AND case_id = p_case) THEN
    SELECT location_id INTO v_loc FROM equipment.supply_settings WHERE tenant_id = p_tenant AND organization_id = v_org;

    -- 1. Nhu cầu theo định mức của từng chi phí còn hiệu lực.
    FOR n IN
      SELECT c.charge_id, nm.medication_id, (nm.quantity * c.quantity)::integer AS qty
        FROM finance.charges c
        JOIN equipment.supply_norms nm ON nm.tenant_id = c.tenant_id AND nm.item_id = c.item_id AND nm.quantity > 0
       WHERE c.tenant_id = p_tenant AND c.case_id = p_case AND c.status = 'active'
       ORDER BY c.created_at, c.charge_id, nm.medication_id
    LOOP
      v_need := n.qty;
      -- 1a. Lô ghi thực tế trước.
      FOR u IN
        SELECT lu.usage_id, lu.batch_id,
               lu.quantity - COALESCE((SELECT sum(sc.quantity) FROM equipment.supply_consumptions sc WHERE sc.tenant_id = lu.tenant_id AND sc.usage_id = lu.usage_id), 0) AS left_qty
          FROM equipment.supply_lot_usages lu
         WHERE lu.tenant_id = p_tenant AND lu.case_id = p_case AND lu.medication_id = n.medication_id AND lu.status = 'active'
         ORDER BY lu.recorded_at, lu.usage_id
      LOOP
        EXIT WHEN v_need <= 0;
        CONTINUE WHEN u.left_qty <= 0;
        v_part := LEAST(v_need, u.left_qty);
        v_taken := 0; v_mov := NULL;
        IF v_loc IS NOT NULL THEN SELECT x.taken, x.movement_id INTO v_taken, v_mov FROM equipment._take_lot(p_tenant, v_loc, u.batch_id, v_part, p_case, p_by) x; END IF;
        IF v_taken > 0 THEN
          INSERT INTO equipment.supply_consumptions (tenant_id, organization_id, case_id, patient_id, charge_id, usage_id, medication_id, batch_id, quantity, unit_cost, source, movement_id, location_id, created_by)
          SELECT p_tenant, v_org, p_case, v_patient, n.charge_id, u.usage_id, n.medication_id, u.batch_id, v_taken, bt.unit_cost, 'recorded', v_mov, v_loc, p_by
            FROM pharmacy.batches bt WHERE bt.tenant_id = p_tenant AND bt.batch_id = u.batch_id;
        END IF;
        IF v_part - v_taken > 0 THEN
          INSERT INTO equipment.supply_consumptions (tenant_id, organization_id, case_id, patient_id, charge_id, usage_id, medication_id, batch_id, quantity, unit_cost, source, location_id, created_by)
          SELECT p_tenant, v_org, p_case, v_patient, n.charge_id, u.usage_id, n.medication_id, u.batch_id, v_part - v_taken, bt.unit_cost, 'shortfall', v_loc, p_by
            FROM pharmacy.batches bt WHERE bt.tenant_id = p_tenant AND bt.batch_id = u.batch_id;
        END IF;
        v_need := v_need - v_part;
      END LOOP;
      -- 1b. Phần còn lại theo FEFO (lô còn hạn, hết hạn trước dùng trước).
      IF v_need > 0 AND v_loc IS NOT NULL THEN
        FOR b IN
          SELECT ib.batch_id FROM pharmacy.inventory_balances ib
            JOIN pharmacy.batches bt ON bt.tenant_id = ib.tenant_id AND bt.batch_id = ib.batch_id
           WHERE ib.tenant_id = p_tenant AND ib.location_id = v_loc AND bt.medication_id = n.medication_id
             AND ib.quantity_on_hand - ib.quantity_reserved > 0 AND bt.expiry_date >= v_today
           ORDER BY bt.expiry_date, bt.batch_number, bt.batch_id
        LOOP
          EXIT WHEN v_need <= 0;
          SELECT x.taken, x.movement_id INTO v_taken, v_mov FROM equipment._take_lot(p_tenant, v_loc, b.batch_id, v_need, p_case, p_by) x;
          IF v_taken > 0 THEN
            INSERT INTO equipment.supply_consumptions (tenant_id, organization_id, case_id, patient_id, charge_id, medication_id, batch_id, quantity, unit_cost, source, movement_id, location_id, created_by)
            SELECT p_tenant, v_org, p_case, v_patient, n.charge_id, n.medication_id, b.batch_id, v_taken, bt.unit_cost, 'fefo', v_mov, v_loc, p_by
              FROM pharmacy.batches bt WHERE bt.tenant_id = p_tenant AND bt.batch_id = b.batch_id;
            v_need := v_need - v_taken;
          END IF;
        END LOOP;
      END IF;
      -- 1c. Thiếu: không chặn tất toán, ghi chờ đối soát.
      IF v_need > 0 THEN
        INSERT INTO equipment.supply_consumptions (tenant_id, organization_id, case_id, patient_id, charge_id, medication_id, quantity, unit_cost, source, location_id, created_by)
        VALUES (p_tenant, v_org, p_case, v_patient, n.charge_id, n.medication_id, v_need, equipment.last_unit_cost(p_tenant, n.medication_id), 'shortfall', v_loc, p_by);
      END IF;
    END LOOP;

    -- 2. Lô ghi thực tế vượt định mức (vd. dùng thêm 1 bơm tiêm): vẫn trừ, không gắn chi phí.
    FOR u IN
      SELECT lu.usage_id, lu.batch_id, lu.medication_id,
             lu.quantity - COALESCE((SELECT sum(sc.quantity) FROM equipment.supply_consumptions sc WHERE sc.tenant_id = lu.tenant_id AND sc.usage_id = lu.usage_id), 0) AS left_qty
        FROM equipment.supply_lot_usages lu
       WHERE lu.tenant_id = p_tenant AND lu.case_id = p_case AND lu.status = 'active'
       ORDER BY lu.recorded_at, lu.usage_id
    LOOP
      CONTINUE WHEN u.left_qty <= 0;
      v_taken := 0; v_mov := NULL;
      IF v_loc IS NOT NULL THEN SELECT x.taken, x.movement_id INTO v_taken, v_mov FROM equipment._take_lot(p_tenant, v_loc, u.batch_id, u.left_qty, p_case, p_by) x; END IF;
      IF v_taken > 0 THEN
        INSERT INTO equipment.supply_consumptions (tenant_id, organization_id, case_id, patient_id, usage_id, medication_id, batch_id, quantity, unit_cost, source, movement_id, location_id, created_by)
        SELECT p_tenant, v_org, p_case, v_patient, u.usage_id, u.medication_id, u.batch_id, v_taken, bt.unit_cost, 'recorded', v_mov, v_loc, p_by
          FROM pharmacy.batches bt WHERE bt.tenant_id = p_tenant AND bt.batch_id = u.batch_id;
      END IF;
      IF u.left_qty - v_taken > 0 THEN
        INSERT INTO equipment.supply_consumptions (tenant_id, organization_id, case_id, patient_id, usage_id, medication_id, batch_id, quantity, unit_cost, source, location_id, created_by)
        SELECT p_tenant, v_org, p_case, v_patient, u.usage_id, u.medication_id, u.batch_id, u.left_qty - v_taken, bt.unit_cost, 'shortfall', v_loc, p_by
          FROM pharmacy.batches bt WHERE bt.tenant_id = p_tenant AND bt.batch_id = u.batch_id;
      END IF;
    END LOOP;
  END IF;

  RETURN QUERY
    SELECT count(*)::integer, COALESCE(sum(quantity) FILTER (WHERE source = 'shortfall'), 0)::integer, COALESCE(sum(cost), 0)::numeric
      FROM equipment.supply_consumptions WHERE tenant_id = p_tenant AND case_id = p_case;
END
$$;

-- ---------------------------------------------------------------------------
-- B1. Loại thiết bị, thiết bị, mã tài sản
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.device_types (
  type_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  code             text        NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type_id),
  CONSTRAINT device_types_tenant_uk UNIQUE (tenant_id, type_id),
  CONSTRAINT device_types_code_uk UNIQUE (tenant_id, code)
);

CREATE TABLE equipment.asset_counters (
  tenant_id        uuid     NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid     NOT NULL,
  year             smallint NOT NULL CHECK (year BETWEEN 0 AND 99),
  last_value       integer  NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (tenant_id, organization_id, year),
  CONSTRAINT asset_counters_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);
CREATE FUNCTION equipment.asset_counters_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_value <= OLD.last_value THEN RAISE EXCEPTION 'asset counter can only increase' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_counters_guard BEFORE UPDATE ON equipment.asset_counters FOR EACH ROW EXECUTE FUNCTION equipment.asset_counters_guard();

-- Mã tài sản TByy-nnnn-c; c = số kiểm tra Luhn trên yy + nnnn (cùng thuật toán mã bệnh nhân F13).
CREATE FUNCTION equipment.next_asset_code(p_tenant uuid, p_org uuid, p_at timestamptz) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  yy smallint := (extract(year FROM p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::integer % 100)::smallint;
  n integer;
  seq text;
BEGIN
  INSERT INTO equipment.asset_counters AS c (tenant_id, organization_id, year, last_value) VALUES (p_tenant, p_org, yy, 1)
  ON CONFLICT (tenant_id, organization_id, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO n;
  seq := lpad(n::text, 4, '0');
  RETURN 'TB' || lpad(yy::text, 2, '0') || '-' || seq || '-' || patient.luhn_digit(lpad(yy::text, 2, '0') || seq)::text;
END
$$;

CREATE TABLE equipment.devices (
  device_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  asset_code         text        NOT NULL CHECK (asset_code ~ '^TB[0-9]{2}-[0-9]{4,}-[0-9]$'),
  type_id            uuid        NOT NULL,
  name               text        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  manufacturer       text        CHECK (manufacturer IS NULL OR length(manufacturer) <= 120),
  model              text        CHECK (model IS NULL OR length(model) <= 120),
  serial_no          text        CHECK (serial_no IS NULL OR serial_no ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,63}$'),
  service_point_id   uuid,
  risk_class         text        NOT NULL CHECK (risk_class IN ('A', 'B', 'C', 'D')),
  registration_no    text        CHECK (registration_no IS NULL OR length(btrim(registration_no)) BETWEEN 3 AND 80),
  warranty_until     date,
  acquired_on        date,
  in_service_on      date,
  cost               bigint      CHECK (cost IS NULL OR cost BETWEEN 0 AND 100000000000),
  useful_life_months smallint    CHECK (useful_life_months IS NULL OR useful_life_months BETWEEN 12 AND 600),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'broken', 'maintenance', 'retired')),
  status_since       timestamptz NOT NULL DEFAULT now(),
  retired_on         date,
  created_by         uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (device_id),
  CONSTRAINT devices_tenant_uk UNIQUE (tenant_id, device_id),
  CONSTRAINT devices_tenant_org_uk UNIQUE (tenant_id, device_id, organization_id),
  CONSTRAINT devices_asset_uk UNIQUE (tenant_id, asset_code),
  CONSTRAINT devices_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT devices_type_fk FOREIGN KEY (tenant_id, type_id) REFERENCES equipment.device_types (tenant_id, type_id),
  CONSTRAINT devices_sp_fk FOREIGN KEY (tenant_id, service_point_id, organization_id) REFERENCES clinical.service_points (tenant_id, service_point_id, organization_id),
  CONSTRAINT devices_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT devices_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id),
  -- Khấu hao cần đủ nguyên giá + ngày đưa vào dùng + số tháng.
  CONSTRAINT devices_depreciation_ck CHECK ((cost IS NULL) = (useful_life_months IS NULL) AND (cost IS NULL OR in_service_on IS NOT NULL)),
  CONSTRAINT devices_dates_ck CHECK (acquired_on IS NULL OR in_service_on IS NULL OR acquired_on <= in_service_on),
  CONSTRAINT devices_retired_ck CHECK ((status = 'retired') = (retired_on IS NOT NULL))
);
CREATE UNIQUE INDEX devices_serial_uk ON equipment.devices (tenant_id, type_id, lower(COALESCE(manufacturer, '')), lower(COALESCE(model, '')), lower(serial_no))
  WHERE serial_no IS NOT NULL;
CREATE INDEX devices_org_idx ON equipment.devices (tenant_id, organization_id, status);
CREATE FUNCTION equipment.devices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.retired_on IS NOT NULL THEN RAISE EXCEPTION 'device must be registered active' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.organization_id, NEW.asset_code, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.asset_code, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'device identity is immutable' USING ERRCODE = '42501';
  END IF;
  -- Trạng thái / phòng chỉ đổi qua nhật ký (hàm device_events_apply đặt cờ này trong transaction).
  IF (NEW.status, NEW.service_point_id, NEW.retired_on) IS DISTINCT FROM (OLD.status, OLD.service_point_id, OLD.retired_on)
     AND current_setting('hcos.device_event', true) IS DISTINCT FROM NEW.device_id::text THEN
    RAISE EXCEPTION 'device status / location changes only through equipment.device_events' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'retired' THEN RAISE EXCEPTION 'device % is retired', OLD.asset_code USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER devices_a_guard BEFORE INSERT OR UPDATE ON equipment.devices FOR EACH ROW EXECUTE FUNCTION equipment.devices_guard();
CREATE TRIGGER devices_b_version BEFORE UPDATE ON equipment.devices FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- B2. Nhật ký thiết bị (chỉ-thêm): bàn giao đầu ca, báo hỏng, bảo trì, sửa xong, chuyển phòng, thanh lý
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.device_events (
  event_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  device_id         uuid        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('registered', 'handover', 'fault', 'maintenance_start', 'repaired', 'moved', 'retired', 'note')),
  note              text        CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  major_repair      boolean     NOT NULL DEFAULT false,
  from_status       text,
  to_status         text,
  from_service_point uuid,
  to_service_point  uuid,
  via               text        NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'qr', 'system')),
  actor             uuid        NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id),
  CONSTRAINT device_events_device_fk FOREIGN KEY (tenant_id, device_id) REFERENCES equipment.devices (tenant_id, device_id),
  CONSTRAINT device_events_actor_fk FOREIGN KEY (tenant_id, actor) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT device_events_note_ck CHECK (kind NOT IN ('fault', 'maintenance_start', 'repaired', 'retired', 'note') OR note IS NOT NULL),
  CONSTRAINT device_events_major_ck CHECK (NOT major_repair OR kind = 'repaired')
);
CREATE INDEX device_events_device_idx ON equipment.device_events (tenant_id, device_id, occurred_at DESC);

-- Áp sự kiện vào thiết bị (SECURITY DEFINER: role ứng dụng không có quyền UPDATE cột trạng thái).
CREATE FUNCTION equipment.device_events_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, equipment AS $$
DECLARE
  d equipment.devices%ROWTYPE;
  v_to text;
BEGIN
  SELECT * INTO d FROM equipment.devices WHERE tenant_id = NEW.tenant_id AND device_id = NEW.device_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'device % not found', NEW.device_id USING ERRCODE = '23503'; END IF;
  IF d.status = 'retired' THEN RAISE EXCEPTION 'device % is retired', d.asset_code USING ERRCODE = '55000'; END IF;
  NEW.occurred_at := now();
  NEW.from_status := d.status;
  NEW.from_service_point := d.service_point_id;
  v_to := d.status;
  CASE NEW.kind
    WHEN 'registered' THEN
      IF EXISTS (SELECT 1 FROM equipment.device_events WHERE tenant_id = NEW.tenant_id AND device_id = NEW.device_id) THEN
        RAISE EXCEPTION 'device already registered' USING ERRCODE = '55000';
      END IF;
    WHEN 'fault' THEN
      IF d.status NOT IN ('active', 'maintenance') THEN RAISE EXCEPTION 'cannot report fault on % device', d.status USING ERRCODE = '55000'; END IF;
      v_to := 'broken';
    WHEN 'maintenance_start' THEN
      IF d.status NOT IN ('active', 'broken') THEN RAISE EXCEPTION 'cannot start maintenance on % device', d.status USING ERRCODE = '55000'; END IF;
      v_to := 'maintenance';
    WHEN 'repaired' THEN
      IF d.status NOT IN ('broken', 'maintenance') THEN RAISE EXCEPTION 'device is not broken / in maintenance' USING ERRCODE = '55000'; END IF;
      v_to := 'active';
    WHEN 'moved' THEN
      IF NEW.to_service_point IS NOT DISTINCT FROM d.service_point_id THEN RAISE EXCEPTION 'device is already there' USING ERRCODE = '55000'; END IF;
      IF NEW.to_service_point IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM clinical.service_points WHERE tenant_id = NEW.tenant_id AND service_point_id = NEW.to_service_point AND organization_id = d.organization_id) THEN
        RAISE EXCEPTION 'service point is not in the device organization' USING ERRCODE = '23503';
      END IF;
    WHEN 'retired' THEN
      v_to := 'retired';
    ELSE
      NULL; -- handover / note: không đổi trạng thái
  END CASE;
  IF NEW.kind <> 'moved' THEN NEW.to_service_point := d.service_point_id; END IF;
  NEW.to_status := v_to;
  IF v_to IS DISTINCT FROM d.status OR NEW.to_service_point IS DISTINCT FROM d.service_point_id THEN
    PERFORM set_config('hcos.device_event', d.device_id::text, true);
    UPDATE equipment.devices
       SET status = v_to,
           status_since = CASE WHEN v_to IS DISTINCT FROM d.status THEN now() ELSE status_since END,
           service_point_id = NEW.to_service_point,
           retired_on = CASE WHEN v_to = 'retired' THEN (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date ELSE retired_on END,
           updated_by = NEW.actor
     WHERE tenant_id = NEW.tenant_id AND device_id = NEW.device_id;
    PERFORM set_config('hcos.device_event', '', true);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER device_events_apply BEFORE INSERT ON equipment.device_events FOR EACH ROW EXECUTE FUNCTION equipment.device_events_apply();

-- ---------------------------------------------------------------------------
-- B3. Kiểm định / hiệu chuẩn: chế độ áp dụng cho từng máy + các lần thực hiện (chỉ-thêm)
-- ---------------------------------------------------------------------------
--   atkt       Kiểm định an toàn & tính năng kỹ thuật (danh mục TT 05/2022/TT-BYT)
--   do_luong   Kiểm định phương tiện đo (pháp luật đo lường)
--   buc_xa     Kiểm định an toàn bức xạ (thiết bị X-quang…)
--   ap_luc     Kiểm định an toàn thiết bị áp lực (nồi hấp…)
--   hieu_chuan Hiệu chuẩn / bảo dưỡng định kỳ theo nhà sản xuất hoặc quy trình nội bộ
CREATE TABLE equipment.device_regimes (
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  device_id        uuid        NOT NULL,
  regime           text        NOT NULL CHECK (regime IN ('atkt', 'do_luong', 'buc_xa', 'ap_luc', 'hieu_chuan')),
  cycle_months     smallint    NOT NULL CHECK (cycle_months BETWEEN 1 AND 120),
  mandatory        boolean     NOT NULL,
  active           boolean     NOT NULL DEFAULT true,
  updated_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, device_id, regime),
  CONSTRAINT device_regimes_device_fk FOREIGN KEY (tenant_id, device_id) REFERENCES equipment.devices (tenant_id, device_id),
  CONSTRAINT device_regimes_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER device_regimes_version BEFORE UPDATE ON equipment.device_regimes FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

CREATE TABLE equipment.device_inspections (
  inspection_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  device_id        uuid        NOT NULL,
  regime           text        NOT NULL,
  performed_on     date        NOT NULL,
  result           text        NOT NULL CHECK (result IN ('pass', 'fail')),
  valid_until      date        NOT NULL,
  provider         text        NOT NULL CHECK (length(btrim(provider)) BETWEEN 2 AND 200),
  certificate_no   text        CHECK (certificate_no IS NULL OR length(btrim(certificate_no)) BETWEEN 2 AND 80),
  note             text        CHECK (note IS NULL OR length(note) <= 500),
  recorded_by      uuid        NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inspection_id),
  CONSTRAINT device_inspections_regime_fk FOREIGN KEY (tenant_id, device_id, regime) REFERENCES equipment.device_regimes (tenant_id, device_id, regime),
  CONSTRAINT device_inspections_by_fk FOREIGN KEY (tenant_id, recorded_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT device_inspections_dates_ck CHECK (valid_until > performed_on AND valid_until <= performed_on + 3660),
  -- Kết quả đạt phải có số giấy chứng nhận / tem.
  CONSTRAINT device_inspections_cert_ck CHECK (result = 'fail' OR certificate_no IS NOT NULL)
);
CREATE INDEX device_inspections_idx ON equipment.device_inspections (tenant_id, device_id, regime, performed_on DESC);
CREATE FUNCTION equipment.device_inspections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.performed_on > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'inspection date is in the future' USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM equipment.devices WHERE tenant_id = NEW.tenant_id AND device_id = NEW.device_id) = 'retired' THEN
    RAISE EXCEPTION 'device is retired' USING ERRCODE = '55000';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER device_inspections_guard BEFORE INSERT ON equipment.device_inspections FOR EACH ROW EXECUTE FUNCTION equipment.device_inspections_guard();

-- Tình trạng từng chế độ: ok | due_soon (≤ 30 ngày) | overdue | failed | missing (chưa có lần nào) | reinspect (sửa chữa lớn sau lần gần nhất).
CREATE VIEW equipment.regime_status WITH (security_invoker = true) AS
SELECT r.tenant_id, r.device_id, r.regime, r.cycle_months, r.mandatory,
       li.inspection_id, li.performed_on, li.result, li.valid_until, li.provider, li.certificate_no, mr.at AS major_repair_at,
       CASE
         WHEN li.inspection_id IS NULL THEN 'missing'
         WHEN li.result = 'fail' THEN 'failed'
         WHEN mr.at IS NOT NULL THEN 'reinspect'
         WHEN li.valid_until < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN 'overdue'
         WHEN li.valid_until <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30 THEN 'due_soon'
         ELSE 'ok'
       END AS state
  FROM equipment.device_regimes r
  LEFT JOIN LATERAL (
    SELECT i.inspection_id, i.performed_on, i.result, i.valid_until, i.provider, i.certificate_no, i.recorded_at FROM equipment.device_inspections i
     WHERE i.tenant_id = r.tenant_id AND i.device_id = r.device_id AND i.regime = r.regime
     ORDER BY i.performed_on DESC, i.recorded_at DESC LIMIT 1) li ON true
  LEFT JOIN LATERAL (
    SELECT max(e.occurred_at) AS at FROM equipment.device_events e
     WHERE e.tenant_id = r.tenant_id AND e.device_id = r.device_id AND e.kind = 'repaired' AND e.major_repair
       AND li.performed_on IS NOT NULL
       -- Sửa chữa lớn sau ngày kiểm định, hoặc cùng ngày nhưng sau lúc ghi kết quả => phải kiểm định lại.
       AND ((e.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > li.performed_on
            OR ((e.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = li.performed_on AND e.occurred_at > li.recorded_at))) mr ON true
 WHERE r.active;

-- Lý do máy KHÔNG được dùng (rỗng = dùng được). Chế độ không bắt buộc (hiệu chuẩn nội bộ) chỉ cảnh báo, không chặn.
CREATE FUNCTION equipment.device_blockers(p_tenant uuid, p_device uuid) RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(x ORDER BY x), '{}') FROM (
    SELECT 'status:' || d.status AS x FROM equipment.devices d WHERE d.tenant_id = p_tenant AND d.device_id = p_device AND d.status <> 'active'
    UNION ALL
    SELECT 'regime:' || s.regime || ':' || s.state FROM equipment.regime_status s
     WHERE s.tenant_id = p_tenant AND s.device_id = p_device AND s.mandatory AND s.state IN ('missing', 'failed', 'reinspect', 'overdue')
  ) z
$$;

-- ---------------------------------------------------------------------------
-- B4. Dịch vụ cần loại máy => chặn ghi chi phí khi không còn máy dùng được
-- ---------------------------------------------------------------------------
CREATE TABLE equipment.service_requirements (
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  item_id          uuid        NOT NULL,
  type_id          uuid        NOT NULL,
  active           boolean     NOT NULL DEFAULT true,
  updated_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, item_id, type_id),
  CONSTRAINT service_req_item_fk FOREIGN KEY (tenant_id, item_id, organization_id) REFERENCES finance.price_items (tenant_id, item_id, organization_id),
  CONSTRAINT service_req_type_fk FOREIGN KEY (tenant_id, type_id) REFERENCES equipment.device_types (tenant_id, type_id),
  CONSTRAINT service_req_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER service_req_version BEFORE UPDATE ON equipment.service_requirements FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Loại máy dịch vụ cần mà cơ sở KHÔNG còn chiếc nào dùng được.
CREATE FUNCTION equipment.unavailable_types(p_tenant uuid, p_org uuid, p_item uuid) RETURNS TABLE (type_id uuid, code text, name text) LANGUAGE sql STABLE AS $$
  SELECT t.type_id, t.code, t.name
    FROM equipment.service_requirements r JOIN equipment.device_types t ON t.tenant_id = r.tenant_id AND t.type_id = r.type_id
   WHERE r.tenant_id = p_tenant AND r.organization_id = p_org AND r.item_id = p_item AND r.active
     AND NOT EXISTS (
       SELECT 1 FROM equipment.devices d
        WHERE d.tenant_id = r.tenant_id AND d.organization_id = r.organization_id AND d.type_id = r.type_id AND d.status = 'active'
          AND cardinality(equipment.device_blockers(d.tenant_id, d.device_id)) = 0)
$$;

CREATE FUNCTION equipment.charges_device_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  SELECT string_agg(code, ', ') INTO v FROM equipment.unavailable_types(NEW.tenant_id, NEW.organization_id, NEW.item_id);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'no usable device of type % for service %', v, NEW.item_code USING ERRCODE = '55000', HINT = 'DEVICE_UNAVAILABLE';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER charges_0_device_guard BEFORE INSERT ON finance.charges FOR EACH ROW EXECUTE FUNCTION equipment.charges_device_guard();

-- ---------------------------------------------------------------------------
-- C. Chỉ-thêm, RLS fail-closed, quyền
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['equipment.supply_consumptions', 'equipment.supply_shortfall_resolutions', 'equipment.device_events', 'equipment.device_inspections']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation()', replace(t, '.', '_') || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['equipment.supply_settings', 'equipment.supply_norms', 'equipment.supply_lot_usages', 'equipment.supply_consumptions',
                           'equipment.supply_shortfall_resolutions', 'equipment.device_types', 'equipment.asset_counters', 'equipment.devices',
                           'equipment.device_events', 'equipment.device_regimes', 'equipment.device_inspections', 'equipment.service_requirements']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation()', replace(t, '.', '_') || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation()', replace(t, '.', '_') || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO hcos_app
         USING (tenant_id = platform.current_tenant_id())
         WITH CHECK (tenant_id = platform.current_tenant_id())', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON equipment.supply_settings, equipment.supply_norms, equipment.device_regimes, equipment.service_requirements,
  equipment.asset_counters TO hcos_app;
GRANT SELECT, INSERT ON equipment.supply_consumptions, equipment.supply_shortfall_resolutions, equipment.device_types,
  equipment.device_events, equipment.device_inspections TO hcos_app;
GRANT SELECT, INSERT, UPDATE (status, cancelled_by, cancelled_at, cancel_reason) ON equipment.supply_lot_usages TO hcos_app;
-- Thiết bị: KHÔNG có quyền UPDATE status / service_point_id / retired_on (chỉ qua nhật ký).
GRANT SELECT, INSERT ON equipment.devices TO hcos_app;
GRANT UPDATE (type_id, name, manufacturer, model, serial_no, risk_class, registration_no, warranty_until, acquired_on, in_service_on, cost,
  useful_life_months, updated_by) ON equipment.devices TO hcos_app;
GRANT SELECT ON equipment.regime_status TO hcos_app;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA equipment FROM hcos_app, hcos_provisioner;
REVOKE EXECUTE ON FUNCTION equipment.device_events_apply() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION equipment.consume_case(uuid, uuid, uuid), equipment._take_lot(uuid, uuid, uuid, integer, uuid, uuid),
  equipment.last_unit_cost(uuid, uuid), equipment.next_asset_code(uuid, uuid, timestamptz), equipment.device_blockers(uuid, uuid),
  equipment.unavailable_types(uuid, uuid, uuid) TO hcos_app;

COMMIT;
