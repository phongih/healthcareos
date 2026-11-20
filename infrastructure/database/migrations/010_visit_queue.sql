-- HCOS-F6 — Hàng đợi khám theo số thứ tự (theo phòng khám), có ưu tiên, màn hình gọi số.
--
-- Bất biến ở tầng DB:
--  1. Số thứ tự cấp nguyên tử theo (phòng, ngày) qua bảng đếm; không trùng số trong một phòng một ngày.
--  2. Mỗi bệnh nhân chỉ có một phiếu đang chờ / đang được gọi trong một cơ sở mỗi ngày.
--  3. Phiếu thuộc đúng cơ sở của phòng và của hồ sơ bệnh nhân (FK ghép); đợt khám gắn vào phải cùng bệnh nhân.
--  4. Nội dung phiếu bất biến; trạng thái chỉ đi theo các bước hợp lệ; "đang khám" phải gắn đợt khám.
--  5. Ưu tiên theo khoản 2 Điều 3 Luật KCB 2023; cấp cứu xếp trước các ưu tiên khác.
--  6. Màn hình gọi số công khai chỉ đọc qua MỘT hàm (SECURITY DEFINER) bằng khoá hiển thị; chỉ trả số, phòng,
--     trạng thái — không có tên, MRN hay bất kỳ dữ liệu bệnh nhân nào. Khoá chỉ lưu dạng SHA-256.
--  7. Không DELETE / TRUNCATE; RLS FORCE theo tenant.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Phòng khám (điểm phục vụ)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.service_points (
  service_point_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  name             text        NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (service_point_id),
  CONSTRAINT service_points_tenant_id_uk  UNIQUE (tenant_id, service_point_id),
  CONSTRAINT service_points_tenant_org_uk UNIQUE (tenant_id, service_point_id, organization_id),
  CONSTRAINT service_points_code_uk       UNIQUE (tenant_id, organization_id, code),
  CONSTRAINT service_points_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES iam.organizations (tenant_id, organization_id)
);

CREATE FUNCTION clinical.service_points_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'service point organization/code are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER service_points_a_guard   BEFORE UPDATE ON clinical.service_points FOR EACH ROW EXECUTE FUNCTION clinical.service_points_guard();
CREATE TRIGGER service_points_b_version BEFORE UPDATE ON clinical.service_points FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 2. Bộ đếm số thứ tự theo phòng / ngày (cấp số nguyên tử bằng INSERT ... ON CONFLICT DO UPDATE)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.queue_counters (
  tenant_id        uuid    NOT NULL REFERENCES iam.tenants (tenant_id),
  service_point_id uuid    NOT NULL,
  queue_date       date    NOT NULL,
  last_no          integer NOT NULL CHECK (last_no BETWEEN 1 AND 9999),
  PRIMARY KEY (tenant_id, service_point_id, queue_date),
  CONSTRAINT queue_counters_service_point_fk FOREIGN KEY (tenant_id, service_point_id)
    REFERENCES clinical.service_points (tenant_id, service_point_id)
);

-- ---------------------------------------------------------------------------
-- 3. Phiếu số thứ tự
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.queue_tickets (
  ticket_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  service_point_id   uuid        NOT NULL,
  patient_id         uuid        NOT NULL,
  queue_date         date        NOT NULL,
  ticket_no          integer     NOT NULL CHECK (ticket_no BETWEEN 1 AND 9999),
  priority_reason    text        CHECK (priority_reason IN
                       ('emergency', 'child_under_6', 'pregnant', 'severe_disability', 'elderly_75', 'revolutionary_merit')),
  priority_rank      smallint    GENERATED ALWAYS AS (
                       CASE WHEN priority_reason = 'emergency' THEN 2 WHEN priority_reason IS NOT NULL THEN 1 ELSE 0 END
                     ) STORED,
  status             text        NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting', 'called', 'in_service', 'skipped', 'cancelled')),
  called_count       integer     NOT NULL DEFAULT 0 CHECK (called_count >= 0),
  called_at          timestamptz,
  called_by_user_id  uuid,
  encounter_id       uuid,
  issued_by_user_id  uuid        NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (ticket_id),
  CONSTRAINT queue_tickets_tenant_id_uk UNIQUE (tenant_id, ticket_id),
  CONSTRAINT queue_tickets_number_uk UNIQUE (tenant_id, service_point_id, queue_date, ticket_no),
  CONSTRAINT queue_tickets_service_point_fk FOREIGN KEY (tenant_id, service_point_id, organization_id)
    REFERENCES clinical.service_points (tenant_id, service_point_id, organization_id),
  CONSTRAINT queue_tickets_patient_fk FOREIGN KEY (tenant_id, patient_id, organization_id)
    REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT queue_tickets_encounter_fk FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES clinical.encounters (tenant_id, encounter_id, patient_id),
  CONSTRAINT queue_tickets_issuer_fk FOREIGN KEY (tenant_id, issued_by_user_id) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT queue_tickets_caller_fk FOREIGN KEY (tenant_id, called_by_user_id) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT queue_tickets_in_service_ck CHECK (status <> 'in_service' OR encounter_id IS NOT NULL),
  CONSTRAINT queue_tickets_called_by_ck CHECK (status NOT IN ('called', 'in_service') OR called_by_user_id IS NOT NULL)
);
-- Một bệnh nhân chỉ có một phiếu còn hiệu lực (chờ / đang gọi / vắng mặt) trong một cơ sở mỗi ngày.
CREATE UNIQUE INDEX queue_tickets_one_active_uk ON clinical.queue_tickets (tenant_id, organization_id, patient_id, queue_date)
  WHERE status IN ('waiting', 'called', 'skipped');
CREATE INDEX queue_tickets_next_idx ON clinical.queue_tickets (tenant_id, service_point_id, queue_date, status, priority_rank DESC, ticket_no);

CREATE FUNCTION clinical.queue_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- priority_rank là cột sinh (GENERATED): trong BEFORE trigger chưa được tính (NULL) nên không so; nó suy ra từ priority_reason.
  IF (to_jsonb(NEW) - ARRAY['status', 'called_count', 'called_at', 'called_by_user_id', 'encounter_id', 'version', 'updated_at', 'priority_rank'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'called_count', 'called_at', 'called_by_user_id', 'encounter_id', 'version', 'updated_at', 'priority_rank']) THEN
    RAISE EXCEPTION 'queue ticket content is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.called_count < OLD.called_count THEN
    RAISE EXCEPTION 'called_count cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF OLD.encounter_id IS NOT NULL AND NEW.encounter_id IS DISTINCT FROM OLD.encounter_id THEN
    RAISE EXCEPTION 'ticket encounter cannot change' USING ERRCODE = '55000';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (
      ('waiting', 'called'), ('waiting', 'cancelled'),
      ('called', 'called'), ('called', 'in_service'), ('called', 'skipped'), ('called', 'waiting'),
      ('skipped', 'waiting'), ('skipped', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'illegal queue ticket transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  -- Gọi (lần đầu hoặc gọi lại) phải tăng số lần gọi.
  IF NEW.status = 'called' AND NEW.called_count <= OLD.called_count THEN
    RAISE EXCEPTION 'calling a ticket must increment called_count' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER queue_tickets_a_guard   BEFORE UPDATE ON clinical.queue_tickets FOR EACH ROW EXECUTE FUNCTION clinical.queue_tickets_guard();
CREATE TRIGGER queue_tickets_b_version BEFORE UPDATE ON clinical.queue_tickets FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 4. Màn hình gọi số công khai (khoá hiển thị, chỉ lưu SHA-256)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.queue_displays (
  display_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  name               text        NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  key_hash           bytea       NOT NULL CHECK (length(key_hash) = 32),
  is_active          boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (display_id),
  CONSTRAINT queue_displays_key_uk UNIQUE (key_hash),
  CONSTRAINT queue_displays_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT queue_displays_creator_fk FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES iam.users (tenant_id, user_id)
);

CREATE FUNCTION clinical.queue_displays_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['is_active', 'version', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_active', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'queue display is immutable (revoke and create a new one)' USING ERRCODE = '42501';
  END IF;
  IF OLD.is_active = false AND NEW.is_active = true THEN
    RAISE EXCEPTION 'revoked display cannot be re-activated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER queue_displays_a_guard   BEFORE UPDATE ON clinical.queue_displays FOR EACH ROW EXECUTE FUNCTION clinical.queue_displays_guard();
CREATE TRIGGER queue_displays_b_version BEFORE UPDATE ON clinical.queue_displays FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Ngày làm việc của hàng đợi theo giờ Việt Nam.
CREATE FUNCTION clinical.queue_today() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
$$;

-- Dữ liệu cho màn hình gọi số. Chỉ đọc; chỉ trả số thứ tự, mã/tên phòng, trạng thái, mức ưu tiên, thời điểm gọi.
-- SECURITY DEFINER (chủ sở hữu là role chạy migration): hàm tự lọc theo tenant + organization của khoá.
CREATE FUNCTION clinical.queue_board(p_key text)
RETURNS TABLE (
  display_name text, organization_name text, kind text, service_point_code text, service_point_name text,
  ticket_no integer, priority_rank smallint, called_count integer, called_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  d clinical.queue_displays%ROWTYPE;
  v_org text;
BEGIN
  IF p_key IS NULL OR length(p_key) < 32 OR length(p_key) > 128 THEN
    RETURN;
  END IF;
  SELECT * INTO d FROM clinical.queue_displays WHERE key_hash = sha256(convert_to(p_key, 'UTF8')) AND is_active;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT o.name INTO v_org FROM iam.organizations o WHERE o.tenant_id = d.tenant_id AND o.organization_id = d.organization_id;

  -- Dòng 'meta' luôn có khi khoá hợp lệ (để phân biệt "khoá sai" với "chưa có ai").
  RETURN QUERY SELECT d.name, v_org, 'meta'::text, NULL::text, NULL::text, NULL::integer, NULL::smallint, NULL::integer, NULL::timestamptz;

  RETURN QUERY
  SELECT d.name, v_org, 'called'::text, sp.code, sp.name, t.ticket_no, t.priority_rank, t.called_count, t.called_at
    FROM clinical.queue_tickets t
    JOIN clinical.service_points sp ON sp.tenant_id = t.tenant_id AND sp.service_point_id = t.service_point_id
   WHERE t.tenant_id = d.tenant_id AND t.organization_id = d.organization_id
     AND t.queue_date = clinical.queue_today() AND t.status = 'called'
   ORDER BY t.called_at DESC
   LIMIT 12;

  RETURN QUERY
  SELECT d.name, v_org, 'waiting'::text, x.code, x.name, x.ticket_no, x.priority_rank, 0, NULL::timestamptz
    FROM (
      SELECT sp.code, sp.name, t.ticket_no, t.priority_rank,
             row_number() OVER (PARTITION BY t.service_point_id ORDER BY t.priority_rank DESC, t.ticket_no) AS rn
        FROM clinical.queue_tickets t
        JOIN clinical.service_points sp ON sp.tenant_id = t.tenant_id AND sp.service_point_id = t.service_point_id
       WHERE t.tenant_id = d.tenant_id AND t.organization_id = d.organization_id
         AND t.queue_date = clinical.queue_today() AND t.status = 'waiting' AND sp.is_active
    ) x
   WHERE x.rn <= 5
   ORDER BY x.code, x.rn;
END
$$;
REVOKE ALL ON FUNCTION clinical.queue_board(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.queue_board(text) TO hcos_app;

-- ---------------------------------------------------------------------------
-- 5. Không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical.service_points', 'clinical.queue_counters', 'clinical.queue_tickets', 'clinical.queue_displays']
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

GRANT SELECT, INSERT, UPDATE ON clinical.service_points, clinical.queue_counters, clinical.queue_tickets, clinical.queue_displays TO hcos_app;
REVOKE DELETE, TRUNCATE ON clinical.service_points, clinical.queue_counters, clinical.queue_tickets, clinical.queue_displays
  FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
