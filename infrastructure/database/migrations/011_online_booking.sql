-- HCOS-F7 — Đặt lịch khám online (không tài khoản) + lễ tân check-in cấp số.
--
-- Bất biến ở tầng DB:
--  1. Mỗi buổi (phòng, ngày, sáng/chiều) không vượt sức chứa: bộ đếm luôn bằng số lịch còn hiệu lực
--     (constraint trigger hoãn tới cuối transaction).
--  2. Mã đặt lịch chỉ lưu SHA-256; một số điện thoại chỉ có một lịch còn hiệu lực mỗi ngày tại một cơ sở.
--  3. Thông tin người đặt bất biến; trạng thái booked -> checked_in | cancelled | no_show;
--     checked_in phải gắn hồ sơ bệnh nhân + phiếu số cùng cơ sở (FK ghép).
--  4. Cổng công khai chỉ được tra theo slug qua MỘT hàm SECURITY DEFINER trả tenant/cơ sở/tên cơ sở; mọi thao tác
--     khác của cổng chạy dưới tenant context bình thường (RLS FORCE).
--  5. Có lưu thời điểm + phiên bản đồng ý xử lý dữ liệu cá nhân. Không DELETE / TRUNCATE.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Sức chứa đặt online theo buổi của từng phòng (0 = không nhận đặt online)
-- ---------------------------------------------------------------------------
ALTER TABLE clinical.service_points
  ADD COLUMN booking_capacity smallint NOT NULL DEFAULT 0 CHECK (booking_capacity BETWEEN 0 AND 500);

-- ---------------------------------------------------------------------------
-- 2. Cổng đặt lịch (mỗi cơ sở một cổng, đường dẫn /app/#/book/<slug>)
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.booking_portals (
  portal_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  slug               text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  is_active          boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (portal_id),
  CONSTRAINT booking_portals_slug_uk UNIQUE (slug),
  CONSTRAINT booking_portals_org_uk  UNIQUE (tenant_id, organization_id),
  CONSTRAINT booking_portals_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT booking_portals_creator_fk FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES iam.users (tenant_id, user_id)
);

CREATE FUNCTION clinical.booking_portals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['is_active', 'version', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_active', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'booking portal slug/organization are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_portals_a_guard   BEFORE UPDATE ON clinical.booking_portals FOR EACH ROW EXECUTE FUNCTION clinical.booking_portals_guard();
CREATE TRIGGER booking_portals_b_version BEFORE UPDATE ON clinical.booking_portals FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 3. Bộ đếm chỗ đã đặt theo buổi
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.booking_counters (
  tenant_id        uuid    NOT NULL REFERENCES iam.tenants (tenant_id),
  service_point_id uuid    NOT NULL,
  visit_date       date    NOT NULL,
  period           text    NOT NULL CHECK (period IN ('morning', 'afternoon')),
  booked           integer NOT NULL CHECK (booked >= 0),
  PRIMARY KEY (tenant_id, service_point_id, visit_date, period),
  CONSTRAINT booking_counters_sp_fk FOREIGN KEY (tenant_id, service_point_id) REFERENCES clinical.service_points (tenant_id, service_point_id)
);

-- ---------------------------------------------------------------------------
-- 4. Lịch hẹn
-- ---------------------------------------------------------------------------
CREATE TABLE clinical.bookings (
  booking_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  service_point_id   uuid        NOT NULL,
  visit_date         date        NOT NULL,
  period             text        NOT NULL CHECK (period IN ('morning', 'afternoon')),
  code_hash          bytea       NOT NULL CHECK (length(code_hash) = 32),
  family_name        text        NOT NULL CHECK (length(family_name) BETWEEN 1 AND 100),
  given_name         text        NOT NULL CHECK (length(given_name) BETWEEN 1 AND 100),
  birth_date         date        NOT NULL CHECK (birth_date >= DATE '1900-01-01'),
  sex                text        NOT NULL CHECK (sex IN ('male', 'female', 'other', 'unknown')),
  phone              text        NOT NULL CHECK (phone ~ '^0[0-9]{9}$'),
  national_id        text        CHECK (national_id IS NULL OR national_id ~ '^[0-9]{12}$'),
  reason             text        CHECK (reason IS NULL OR length(reason) <= 500),
  consent_version    text        NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 20),
  consent_at         timestamptz NOT NULL,
  status             text        NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'checked_in', 'cancelled', 'no_show')),
  patient_id         uuid,
  ticket_id          uuid,
  checked_in_by      uuid,
  checked_in_at      timestamptz,
  cancelled_by       text        CHECK (cancelled_by IS NULL OR cancelled_by IN ('patient', 'staff')),
  cancelled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (booking_id),
  CONSTRAINT bookings_tenant_id_uk UNIQUE (tenant_id, booking_id),
  CONSTRAINT bookings_code_uk UNIQUE (code_hash),
  CONSTRAINT bookings_sp_fk FOREIGN KEY (tenant_id, service_point_id, organization_id)
    REFERENCES clinical.service_points (tenant_id, service_point_id, organization_id),
  CONSTRAINT bookings_patient_fk FOREIGN KEY (tenant_id, patient_id, organization_id)
    REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT bookings_ticket_fk FOREIGN KEY (tenant_id, ticket_id) REFERENCES clinical.queue_tickets (tenant_id, ticket_id),
  CONSTRAINT bookings_checkin_user_fk FOREIGN KEY (tenant_id, checked_in_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT bookings_checked_in_ck CHECK (status <> 'checked_in' OR (patient_id IS NOT NULL AND ticket_id IS NOT NULL AND checked_in_at IS NOT NULL)),
  CONSTRAINT bookings_cancelled_ck CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX bookings_one_per_phone_day_uk ON clinical.bookings (tenant_id, organization_id, visit_date, phone) WHERE status = 'booked';
CREATE INDEX bookings_day_idx ON clinical.bookings (tenant_id, organization_id, visit_date, status);

CREATE FUNCTION clinical.bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'patient_id', 'ticket_id', 'checked_in_by', 'checked_in_at', 'cancelled_by', 'cancelled_at', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'patient_id', 'ticket_id', 'checked_in_by', 'checked_in_at', 'cancelled_by', 'cancelled_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'booking details are immutable' USING ERRCODE = '42501';
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
CREATE TRIGGER bookings_a_guard   BEFORE UPDATE ON clinical.bookings FOR EACH ROW EXECUTE FUNCTION clinical.bookings_guard();
CREATE TRIGGER bookings_b_version BEFORE UPDATE ON clinical.bookings FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Bộ đếm = số lịch còn hiệu lực (booked + checked_in) của buổi đó; kiểm ở cuối transaction.
CREATE FUNCTION clinical.assert_booking_counter(p_tenant uuid, p_sp uuid, p_date date, p_period text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_counter bigint;
  v_actual  bigint;
BEGIN
  SELECT COALESCE(MAX(booked), 0) INTO v_counter FROM clinical.booking_counters
   WHERE tenant_id = p_tenant AND service_point_id = p_sp AND visit_date = p_date AND period = p_period;
  SELECT count(*) INTO v_actual FROM clinical.bookings
   WHERE tenant_id = p_tenant AND service_point_id = p_sp AND visit_date = p_date AND period = p_period
     AND status IN ('booked', 'checked_in');
  IF v_counter <> v_actual THEN
    RAISE EXCEPTION 'booking counter mismatch (sp %, %, %): counter=% actual=%', p_sp, p_date, p_period, v_counter, v_actual
      USING ERRCODE = '23514';
  END IF;
END
$$;
CREATE FUNCTION clinical.bookings_counter_t() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM clinical.assert_booking_counter(NEW.tenant_id, NEW.service_point_id, NEW.visit_date, NEW.period);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER bookings_counter_ct AFTER INSERT OR UPDATE ON clinical.bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clinical.bookings_counter_t();
CREATE CONSTRAINT TRIGGER booking_counters_ct AFTER INSERT OR UPDATE ON clinical.booking_counters
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clinical.bookings_counter_t();

-- ---------------------------------------------------------------------------
-- 5. Tra cổng theo slug (cho route công khai, chưa có tenant context)
-- ---------------------------------------------------------------------------
CREATE FUNCTION clinical.booking_portal(p_slug text)
RETURNS TABLE (tenant_id uuid, organization_id uuid, organization_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.tenant_id, p.organization_id, o.name
    FROM clinical.booking_portals p
    JOIN iam.organizations o ON o.tenant_id = p.tenant_id AND o.organization_id = p.organization_id
    JOIN iam.tenants t ON t.tenant_id = p.tenant_id
   WHERE p.slug = p_slug AND p.is_active AND t.status = 'active'
$$;
REVOKE ALL ON FUNCTION clinical.booking_portal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.booking_portal(text) TO hcos_app;

-- ---------------------------------------------------------------------------
-- 6. Không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical.booking_portals', 'clinical.booking_counters', 'clinical.bookings']
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

GRANT SELECT, INSERT, UPDATE ON clinical.booking_portals, clinical.booking_counters, clinical.bookings TO hcos_app;
REVOKE DELETE, TRUNCATE ON clinical.booking_portals, clinical.booking_counters, clinical.bookings FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
