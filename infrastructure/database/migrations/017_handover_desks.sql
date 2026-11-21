-- HCOS-F14 — Quầy trả: dược sĩ soạn (bốc) thuốc, các quầy 1, 2, 3… gọi số để giao thuốc, trả giấy tờ và quyết toán tiền.
--
-- Luồng:
--   BS kết thúc khám (encounter in_progress -> finished)  => DB tự tạo một phiếu trả cho đợt khám đó, GIỮ số thứ tự cũ
--     (vd. N1-007; khám không qua hàng đợi thì cấp số R-001…). Còn thuốc chưa cấp => 'preparing', không => 'ready'.
--   Dược sĩ soạn xong                                       preparing -> ready
--   Quầy rảnh bấm "Gọi tiếp"                                ready -> called (gắn quầy; mỗi quầy tối đa MỘT số đang gọi)
--   Gọi lại / vắng mặt / đưa về hàng chờ                    called -> called | skipped | ready;  skipped -> ready
--   Hoàn tất (đã giao thuốc, trả giấy tờ, số dư thanh toán = 0, hồ sơ thanh toán đóng)   called -> done
--   Huỷ                                                     preparing | ready | skipped -> cancelled
--
-- Bất biến ở tầng DB:
--  1. Một phiếu trả cho mỗi đợt khám; phiếu thuộc đúng cơ sở + bệnh nhân của đợt khám (FK ghép).
--  2. Nội dung phiếu (số, bệnh nhân, đợt khám, ưu tiên) bất biến; trạng thái chỉ đi theo bước hợp lệ.
--  3. Đang gọi / đã xong phải có quầy + người gọi; đã xong phải có người hoàn tất + biên bản giao.
--  4. Màn hình TV đọc qua MỘT hàm SECURITY DEFINER bằng khoá hiển thị sẵn có (F6): chỉ số + quầy, không có dữ liệu bệnh nhân.
--  5. Không DELETE / TRUNCATE; RLS FORCE theo tenant.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Quầy trả
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.handover_desks (
  desk_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  name             text        NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (desk_id),
  CONSTRAINT handover_desks_tenant_id_uk  UNIQUE (tenant_id, desk_id),
  CONSTRAINT handover_desks_tenant_org_uk UNIQUE (tenant_id, desk_id, organization_id),
  CONSTRAINT handover_desks_code_uk       UNIQUE (tenant_id, organization_id, code),
  CONSTRAINT handover_desks_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);
CREATE FUNCTION clinical.handover_desks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'handover desk organization/code are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER handover_desks_a_guard   BEFORE UPDATE ON clinical.handover_desks FOR EACH ROW EXECUTE FUNCTION clinical.handover_desks_guard();
CREATE TRIGGER handover_desks_b_version BEFORE UPDATE ON clinical.handover_desks FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Số dự phòng (R-001…) cho đợt khám không đi qua hàng đợi số thứ tự.
CREATE TABLE clinical.handover_counters (
  tenant_id        uuid    NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid    NOT NULL,
  queue_date       date    NOT NULL,
  last_no          integer NOT NULL CHECK (last_no BETWEEN 1 AND 9999),
  PRIMARY KEY (tenant_id, organization_id, queue_date),
  CONSTRAINT handover_counters_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);

-- ---------------------------------------------------------------------------
-- 2. Phiếu trả
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.handover_tickets (
  handover_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  patient_id         uuid        NOT NULL,
  encounter_id       uuid        NOT NULL,
  queue_date         date        NOT NULL,
  display_no         text        NOT NULL CHECK (display_no ~ '^[A-Z0-9]{1,6}-[0-9]{3,4}$'),
  priority_rank      smallint    NOT NULL DEFAULT 0 CHECK (priority_rank BETWEEN 0 AND 2),
  needs_medication   boolean     NOT NULL,
  status             text        NOT NULL CHECK (status IN ('preparing', 'ready', 'called', 'skipped', 'done', 'cancelled')),
  ready_at           timestamptz,
  prepared_by        uuid,
  prep_note          text        CHECK (prep_note IS NULL OR length(prep_note) BETWEEN 1 AND 500),
  desk_id            uuid,
  called_count       integer     NOT NULL DEFAULT 0 CHECK (called_count >= 0),
  called_at          timestamptz,
  called_by          uuid,
  completed_by       uuid,
  completed_at       timestamptz,
  checklist          jsonb,
  note               text        CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (handover_id),
  CONSTRAINT handover_tickets_tenant_id_uk UNIQUE (tenant_id, handover_id),
  CONSTRAINT handover_tickets_encounter_uk UNIQUE (tenant_id, encounter_id),
  CONSTRAINT handover_tickets_encounter_fk FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, patient_id),
  CONSTRAINT handover_tickets_encounter_org_fk FOREIGN KEY (tenant_id, encounter_id, organization_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, organization_id),
  CONSTRAINT handover_tickets_patient_fk FOREIGN KEY (tenant_id, patient_id, organization_id)
    REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT handover_tickets_desk_fk FOREIGN KEY (tenant_id, desk_id, organization_id)
    REFERENCES clinical.handover_desks (tenant_id, desk_id, organization_id),
  CONSTRAINT handover_tickets_prepared_by_fk  FOREIGN KEY (tenant_id, prepared_by)  REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT handover_tickets_called_by_fk    FOREIGN KEY (tenant_id, called_by)    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT handover_tickets_completed_by_fk FOREIGN KEY (tenant_id, completed_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT handover_tickets_ready_ck  CHECK (status = 'preparing' OR status = 'cancelled' OR ready_at IS NOT NULL),
  CONSTRAINT handover_tickets_called_ck CHECK (status NOT IN ('called', 'done') OR (desk_id IS NOT NULL AND called_by IS NOT NULL AND called_at IS NOT NULL)),
  CONSTRAINT handover_tickets_done_ck   CHECK ((status = 'done') = (completed_by IS NOT NULL AND completed_at IS NOT NULL AND checklist IS NOT NULL))
);
-- Mỗi quầy chỉ gọi một số tại một thời điểm.
CREATE UNIQUE INDEX handover_tickets_one_called_per_desk_uk ON clinical.handover_tickets (tenant_id, desk_id) WHERE status = 'called';
CREATE INDEX handover_tickets_today_idx ON clinical.handover_tickets (tenant_id, organization_id, queue_date, status, priority_rank DESC, ready_at);

CREATE FUNCTION clinical.handover_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable constant text[] := ARRAY['status', 'ready_at', 'prepared_by', 'prep_note', 'desk_id', 'called_count', 'called_at', 'called_by',
                                   'completed_by', 'completed_at', 'checklist', 'note', 'version', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'handover ticket content is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'handover ticket is %', OLD.status USING ERRCODE = '55000';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (
      ('preparing', 'ready'), ('preparing', 'cancelled'),
      ('ready', 'called'), ('ready', 'cancelled'),
      ('called', 'called'), ('called', 'skipped'), ('called', 'ready'), ('called', 'done'),
      ('skipped', 'ready'), ('skipped', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'illegal handover transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF NEW.called_count < OLD.called_count THEN
    RAISE EXCEPTION 'called_count cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'called' AND NEW.called_count <= OLD.called_count THEN
    RAISE EXCEPTION 'calling a handover ticket must increment called_count' USING ERRCODE = '55000';
  END IF;
  -- Người soạn thuốc / thời điểm sẵn sàng ghi một lần.
  IF OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at THEN
    RAISE EXCEPTION 'ready_at cannot change once set' USING ERRCODE = '55000';
  END IF;
  IF OLD.prepared_by IS NOT NULL AND NEW.prepared_by IS DISTINCT FROM OLD.prepared_by THEN
    RAISE EXCEPTION 'prepared_by cannot change once set' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER handover_tickets_a_guard   BEFORE UPDATE ON clinical.handover_tickets FOR EACH ROW EXECUTE FUNCTION clinical.handover_tickets_guard();
CREATE TRIGGER handover_tickets_b_version BEFORE UPDATE ON clinical.handover_tickets FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 3. BS kết thúc khám => tự tạo phiếu trả (trong CÙNG transaction đóng đợt khám)
-- ---------------------------------------------------------------------------
CREATE FUNCTION clinical.handover_on_encounter_finished() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_code    text;
  v_no      integer;
  v_rank    smallint := 0;
  v_items   integer;
  v_open    integer;
  v_date    date := clinical.queue_today();
BEGIN
  -- Khám từ xa: không có quầy trả. Đợt khám cũ (bắt đầu trước 24 giờ, vd. nhập bù / đóng muộn) không đưa vào hàng chờ hôm nay.
  IF NEW.encounter_class = 'virtual' OR NEW.period_start < now() - interval '24 hours' THEN
    RETURN NULL;
  END IF;
  SELECT sp.code, t.ticket_no, t.priority_rank INTO v_code, v_no, v_rank
    FROM clinical.queue_tickets t
    JOIN clinical.service_points sp ON sp.tenant_id = t.tenant_id AND sp.service_point_id = t.service_point_id
   WHERE t.tenant_id = NEW.tenant_id AND t.encounter_id = NEW.encounter_id
   ORDER BY t.issued_at DESC LIMIT 1;
  IF v_code IS NULL THEN
    INSERT INTO clinical.handover_counters (tenant_id, organization_id, queue_date, last_no)
    VALUES (NEW.tenant_id, NEW.organization_id, v_date, 1)
    ON CONFLICT (tenant_id, organization_id, queue_date) DO UPDATE SET last_no = clinical.handover_counters.last_no + 1
    RETURNING 'R', last_no INTO v_code, v_no;
    v_rank := CASE WHEN NEW.encounter_class = 'emergency' THEN 2 ELSE 0 END;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE i.quantity_dispensed < i.quantity_prescribed AND p.status = 'active')
    INTO v_items, v_open
    FROM clinical.prescriptions p
    JOIN clinical.prescription_items i ON i.tenant_id = p.tenant_id AND i.prescription_id = p.prescription_id
   WHERE p.tenant_id = NEW.tenant_id AND p.encounter_id = NEW.encounter_id AND p.status IN ('active', 'completed');

  INSERT INTO clinical.handover_tickets
    (tenant_id, organization_id, patient_id, encounter_id, queue_date, display_no, priority_rank, needs_medication, status, ready_at)
  VALUES
    (NEW.tenant_id, NEW.organization_id, NEW.patient_id, NEW.encounter_id, v_date,
     v_code || '-' || lpad(v_no::text, 3, '0'), COALESCE(v_rank, 0), v_items > 0,
     CASE WHEN v_open > 0 THEN 'preparing' ELSE 'ready' END,
     CASE WHEN v_open > 0 THEN NULL ELSE now() END)
  ON CONFLICT (tenant_id, encounter_id) DO NOTHING;
  RETURN NULL;
END
$$;
CREATE TRIGGER encounters_z_handover AFTER UPDATE OF status ON clinical.encounters
  FOR EACH ROW WHEN (OLD.status = 'in_progress' AND NEW.status = 'finished')
  EXECUTE FUNCTION clinical.handover_on_encounter_finished();

-- ---------------------------------------------------------------------------
-- 4. Màn hình TV: số đang gọi ra quầy, số chờ gọi, số đang soạn thuốc (dùng khoá hiển thị F6)
-- ---------------------------------------------------------------------------
CREATE FUNCTION clinical.handover_board(p_key text)
RETURNS TABLE (kind text, display_no text, desk_code text, desk_name text, priority_rank smallint, called_count integer, called_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  d clinical.queue_displays%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) < 32 OR length(p_key) > 128 THEN
    RETURN;
  END IF;
  SELECT * INTO d FROM clinical.queue_displays WHERE key_hash = sha256(convert_to(p_key, 'UTF8')) AND is_active;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'called'::text, h.display_no, k.code, k.name, h.priority_rank, h.called_count, h.called_at
    FROM clinical.handover_tickets h
    JOIN clinical.handover_desks k ON k.tenant_id = h.tenant_id AND k.desk_id = h.desk_id
   WHERE h.tenant_id = d.tenant_id AND h.organization_id = d.organization_id
     AND h.queue_date = clinical.queue_today() AND h.status = 'called'
   ORDER BY h.called_at DESC
   LIMIT 12;

  RETURN QUERY
  SELECT h.status, h.display_no, NULL::text, NULL::text, h.priority_rank, 0, NULL::timestamptz
    FROM clinical.handover_tickets h
   WHERE h.tenant_id = d.tenant_id AND h.organization_id = d.organization_id
     AND h.queue_date = clinical.queue_today() AND h.status IN ('ready', 'preparing')
   ORDER BY h.status DESC, h.priority_rank DESC, COALESCE(h.ready_at, h.created_at)
   LIMIT 40;
END
$$;
REVOKE ALL ON FUNCTION clinical.handover_board(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.handover_board(text) TO hcos_app;

-- ---------------------------------------------------------------------------
-- 5. Không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical.handover_desks', 'clinical.handover_counters', 'clinical.handover_tickets']
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

GRANT SELECT, INSERT, UPDATE ON clinical.handover_desks, clinical.handover_counters, clinical.handover_tickets TO hcos_app;
REVOKE DELETE, TRUNCATE ON clinical.handover_desks, clinical.handover_counters, clinical.handover_tickets
  FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
