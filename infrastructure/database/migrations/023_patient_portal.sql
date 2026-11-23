-- HCOS-F20 — Cổng bệnh nhân (#/portal).
--
--  * Xác thực tách biệt: người bệnh không phải iam.users. Đăng nhập bằng OTP (SĐT, hoặc mã BN + ngày sinh); phiên là token ngẫu nhiên
--    (chỉ lưu SHA-256) trong portal.sessions. Token phiên không phải JWT => mọi route nội bộ /api/* và /fhir/* tự từ chối.
--  * ĐỌC dữ liệu: service chạy `SET LOCAL ROLE hcos_portal` + app.portal_person_ids (bản thân + người phụ thuộc còn hiệu lực).
--    hcos_portal chỉ có SELECT và chính sách RLS riêng: chỉ hồ sơ của các person đó; đợt khám ĐÃ KẾT THÚC; chẩn đoán / chỉ số / đơn thuốc
--    của đợt đó (bỏ mục nhập nhầm / huỷ); thuốc (không vật tư); phiếu thu hợp lệ. Không có policy => không thấy gì (fail-closed).
--  * GHI: chỉ việc hành chính (đặt / huỷ lịch, đổi SĐT có OTP, email), yêu cầu đính chính (portal.requests), yêu cầu xoá (F17,
--    channel 'portal'), link chia sẻ. Không ghi bệnh án.
--  * Người giám hộ: patient.guardian_links do lễ tân lập + xác minh tại quầy; phụ thuộc là trẻ em => tự hết hạn ngày tròn 18 tuổi.
BEGIN;

CREATE SCHEMA portal;
GRANT USAGE ON SCHEMA portal TO hcos_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hcos_portal') THEN
    CREATE ROLE hcos_portal NOLOGIN NOINHERIT;
  END IF;
END
$$;
-- Ứng dụng chỉ "đổi vai" sang hcos_portal trong transaction đọc của cổng; không thừa hưởng quyền / chính sách của nó.
GRANT hcos_portal TO hcos_app WITH INHERIT FALSE, SET TRUE;

-- Danh sách person của phiên cổng (đặt bằng set_config(..., true) trong transaction).
CREATE FUNCTION portal.person_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.portal_person_ids', true), '')::uuid[], '{}'::uuid[])
$$;

-- ---------------------------------------------------------------------------
-- 1. Người giám hộ
-- ---------------------------------------------------------------------------
CREATE TABLE patient.guardian_links (
  link_id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  guardian_person_id   uuid        NOT NULL,
  dependent_person_id  uuid        NOT NULL,
  relationship         text        NOT NULL CHECK (relationship IN ('parent', 'legal_guardian', 'child', 'spouse', 'sibling', 'other')),
  valid_until          date        NOT NULL,
  note                 text        CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 300),
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_by          uuid        NOT NULL,
  verified_at          timestamptz NOT NULL DEFAULT now(),
  revoked_by           uuid,
  revoked_at           timestamptz,
  revoke_reason        text        CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 300),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (link_id),
  CONSTRAINT guardian_links_tenant_uk UNIQUE (tenant_id, link_id),
  CONSTRAINT guardian_links_guardian_fk FOREIGN KEY (tenant_id, guardian_person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT guardian_links_dependent_fk FOREIGN KEY (tenant_id, dependent_person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT guardian_links_verified_fk FOREIGN KEY (tenant_id, verified_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT guardian_links_revoked_fk FOREIGN KEY (tenant_id, revoked_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT guardian_links_self_ck CHECK (guardian_person_id <> dependent_person_id),
  CONSTRAINT guardian_links_revoke_ck CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE UNIQUE INDEX guardian_links_active_uk ON patient.guardian_links (tenant_id, guardian_person_id, dependent_person_id) WHERE status = 'active';
CREATE INDEX guardian_links_guardian_idx ON patient.guardian_links (tenant_id, guardian_person_id) WHERE status = 'active';
CREATE INDEX guardian_links_dependent_idx ON patient.guardian_links (tenant_id, dependent_person_id);

CREATE FUNCTION patient.guardian_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_birth date;
  v_adult date;
  v_today date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'link must be created active' USING ERRCODE = '23514'; END IF;
    SELECT birth_date INTO v_birth FROM patient.persons WHERE tenant_id = NEW.tenant_id AND person_id = NEW.dependent_person_id;
    v_adult := (v_birth + interval '18 years')::date;
    -- Người phụ thuộc là trẻ em: hết hạn đúng ngày tròn 18 tuổi (không kéo dài hơn).
    IF v_birth IS NOT NULL AND v_adult > v_today THEN
      NEW.valid_until := LEAST(NEW.valid_until, v_adult);
    END IF;
    IF NEW.valid_until <= v_today THEN RAISE EXCEPTION 'link would already be expired' USING ERRCODE = '23514'; END IF;
    -- Người lớn (vd. cha mẹ già, uỷ quyền): tối đa 10 năm rồi xác minh lại. Trẻ em: đã chặn ở ngày tròn 18 tuổi (có thể xa hơn 10 năm).
    IF NOT (v_birth IS NOT NULL AND v_adult > v_today) AND NEW.valid_until > v_today + 3660 THEN
      RAISE EXCEPTION 'link validity is at most 10 years' USING ERRCODE = '23514';
    END IF;
    NEW.verified_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.guardian_person_id, NEW.dependent_person_id, NEW.relationship, NEW.valid_until, NEW.note, NEW.verified_by, NEW.verified_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.guardian_person_id, OLD.dependent_person_id, OLD.relationship, OLD.valid_until, OLD.note, OLD.verified_by, OLD.verified_at) THEN
    RAISE EXCEPTION 'guardian link content is immutable (revoke and create a new one)' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'link already revoked' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guardian_links_a_guard BEFORE INSERT OR UPDATE ON patient.guardian_links FOR EACH ROW EXECUTE FUNCTION patient.guardian_links_guard();
CREATE TRIGGER guardian_links_b_version BEFORE UPDATE ON patient.guardian_links FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 2. OTP + phiên
-- ---------------------------------------------------------------------------
CREATE TABLE portal.otp_challenges (
  challenge_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  person_id        uuid,                         -- NULL = không khớp ai (chống dò: vẫn trả về như thật)
  purpose          text        NOT NULL CHECK (purpose IN ('login', 'phone_change')),
  session_id       uuid,                         -- phone_change: gắn với phiên đang đăng nhập
  code_mac         text,                         -- HMAC (khoá chỉ mục F16, bọc bằng KEK) của mã 6 số; không lưu mã rõ
  target_enc       text,                         -- phone_change: SĐT mới (bản mã khoá người), xoá sau khi dùng / hết hạn
  target_bidx      text,
  target_hint      text,
  channel          text        NOT NULL CHECK (channel IN ('training', 'vendor', 'none')),
  vendor_id        uuid,
  ip_mac           text        NOT NULL,
  attempts         smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  failed_attempts  smallint    NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id),
  CONSTRAINT otp_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT otp_person_fk FOREIGN KEY (tenant_id, person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT otp_shape_ck CHECK ((person_id IS NULL) = (code_mac IS NULL)),
  CONSTRAINT otp_phone_change_ck CHECK (purpose <> 'phone_change' OR (session_id IS NOT NULL AND target_bidx IS NOT NULL)),
  CONSTRAINT otp_expiry_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX otp_person_idx ON portal.otp_challenges (tenant_id, person_id, created_at DESC);
CREATE INDEX otp_ip_idx ON portal.otp_challenges (tenant_id, ip_mac, created_at DESC);
CREATE INDEX otp_target_idx ON portal.otp_challenges (tenant_id, target_bidx, created_at DESC) WHERE target_bidx IS NOT NULL;
CREATE FUNCTION portal.otp_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.challenge_id, NEW.tenant_id, NEW.organization_id, NEW.person_id, NEW.purpose, NEW.session_id, NEW.code_mac, NEW.target_bidx, NEW.target_hint,
      NEW.channel, NEW.vendor_id, NEW.ip_mac, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.challenge_id, OLD.tenant_id, OLD.organization_id, OLD.person_id, OLD.purpose, OLD.session_id, OLD.code_mac, OLD.target_bidx, OLD.target_hint,
      OLD.channel, OLD.vendor_id, OLD.ip_mac, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'otp challenge is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.failed_attempts < OLD.failed_attempts THEN RAISE EXCEPTION 'attempt counters only increase' USING ERRCODE = '42501'; END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN RAISE EXCEPTION 'already consumed' USING ERRCODE = '55000'; END IF;
  IF NEW.target_enc IS NOT NULL AND NEW.target_enc IS DISTINCT FROM OLD.target_enc THEN RAISE EXCEPTION 'target can only be cleared' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER otp_guard BEFORE UPDATE ON portal.otp_challenges FOR EACH ROW EXECUTE FUNCTION portal.otp_guard();

CREATE TABLE portal.sessions (
  session_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  person_id        uuid        NOT NULL,
  token_hash       text        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  challenge_id     uuid        NOT NULL,
  ip_mac           text        NOT NULL,
  user_agent       text        CHECK (user_agent IS NULL OR length(user_agent) <= 120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text        CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'phone_changed', 'erased', 'staff', 'expired')),
  PRIMARY KEY (session_id),
  CONSTRAINT sessions_token_uk UNIQUE (token_hash),
  CONSTRAINT sessions_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT sessions_person_fk FOREIGN KEY (tenant_id, person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT sessions_expiry_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours'),
  CONSTRAINT sessions_revoke_ck CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_person_idx ON portal.sessions (tenant_id, person_id) WHERE revoked_at IS NULL;
CREATE FUNCTION portal.sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.session_id, NEW.tenant_id, NEW.organization_id, NEW.person_id, NEW.token_hash, NEW.challenge_id, NEW.ip_mac, NEW.user_agent, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.session_id, OLD.tenant_id, OLD.organization_id, OLD.person_id, OLD.token_hash, OLD.challenge_id, OLD.ip_mac, OLD.user_agent, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'session is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_reason) THEN
    RAISE EXCEPTION 'session already revoked' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sessions_guard BEFORE UPDATE ON portal.sessions FOR EACH ROW EXECUTE FUNCTION portal.sessions_guard();

-- Tra phiên theo hash token (route cổng chưa có tenant context). Chỉ trả phiên còn hiệu lực.
CREATE FUNCTION portal.session_by_token(p_hash text)
RETURNS TABLE (tenant_id uuid, organization_id uuid, session_id uuid, person_id uuid, last_seen_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.tenant_id, s.organization_id, s.session_id, s.person_id, s.last_seen_at, s.expires_at
    FROM portal.sessions s JOIN iam.tenants t ON t.tenant_id = s.tenant_id
    JOIN patient.persons p ON p.tenant_id = s.tenant_id AND p.person_id = s.person_id
   WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND t.status = 'active' AND p.erased_at IS NULL AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION portal.session_by_token(text) FROM PUBLIC;

-- F17: xoá dữ liệu người bệnh => thu hồi ngay mọi phiên cổng + link chia sẻ của người đó (cùng transaction với việc xoá).
CREATE FUNCTION portal.on_person_erased() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE portal.sessions SET revoked_at = now(), revoked_reason = 'erased'
   WHERE tenant_id = NEW.tenant_id AND person_id = NEW.person_id AND revoked_at IS NULL;
  UPDATE portal.shares SET revoked_at = now()
   WHERE tenant_id = NEW.tenant_id AND (person_id = NEW.person_id OR created_by_person_id = NEW.person_id) AND revoked_at IS NULL;
  -- Nội dung người bệnh tự viết (có thể chứa thông tin sức khoẻ) => thay bằng nhãn; giữ trạng thái / ngày để đối soát.
  UPDATE portal.requests SET message = '[đã xoá theo yêu cầu xoá dữ liệu]'
   WHERE tenant_id = NEW.tenant_id AND (person_id = NEW.person_id OR submitted_by_person_id = NEW.person_id);
  RETURN NEW;
END
$$;
GRANT EXECUTE ON FUNCTION portal.session_by_token(text) TO hcos_app;

-- ---------------------------------------------------------------------------
-- 3. Yêu cầu đính chính (ticket cho lễ tân / quản lý)
-- ---------------------------------------------------------------------------
CREATE TABLE portal.requests (
  request_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id        uuid        NOT NULL,
  person_id              uuid        NOT NULL,            -- hồ sơ được nói tới
  submitted_by_person_id uuid        NOT NULL,            -- người gửi (có thể là người giám hộ)
  kind                   text        NOT NULL CHECK (kind IN ('correction')),
  message                text        NOT NULL CHECK (length(btrim(message)) BETWEEN 10 AND 2000),
  status                 text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  resolved_by            uuid,
  resolved_at            timestamptz,
  resolution_note        text        CHECK (resolution_note IS NULL OR length(btrim(resolution_note)) BETWEEN 5 AND 1000),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (request_id),
  CONSTRAINT requests_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT requests_person_fk FOREIGN KEY (tenant_id, person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT requests_submitter_fk FOREIGN KEY (tenant_id, submitted_by_person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT requests_resolver_fk FOREIGN KEY (tenant_id, resolved_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT requests_resolve_ck CHECK ((status = 'open') = (resolved_by IS NULL) AND (resolved_by IS NULL) = (resolved_at IS NULL) AND (status = 'open' OR resolution_note IS NOT NULL))
);
CREATE INDEX requests_open_idx ON portal.requests (tenant_id, organization_id, created_at) WHERE status = 'open';
CREATE FUNCTION portal.requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- F17: chỉ hàm xoá dữ liệu được thay nội dung (bằng nhãn cố định), xem portal.on_person_erased.
  IF governance.in_erasure() THEN RETURN NEW; END IF;
  IF (NEW.request_id, NEW.tenant_id, NEW.organization_id, NEW.person_id, NEW.submitted_by_person_id, NEW.kind, NEW.message, NEW.created_at)
     IS DISTINCT FROM (OLD.request_id, OLD.tenant_id, OLD.organization_id, OLD.person_id, OLD.submitted_by_person_id, OLD.kind, OLD.message, OLD.created_at) THEN
    RAISE EXCEPTION 'request content is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'request already closed' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER requests_a_guard BEFORE UPDATE ON portal.requests FOR EACH ROW EXECUTE FUNCTION portal.requests_guard();
CREATE TRIGGER requests_b_version BEFORE UPDATE ON portal.requests FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 4. Link chia sẻ một đợt khám (24 giờ, PIN 6 số, sai 5 lần khoá)
-- ---------------------------------------------------------------------------
CREATE TABLE portal.shares (
  share_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id      uuid        NOT NULL,
  person_id            uuid        NOT NULL,
  encounter_id         uuid        NOT NULL,
  token_hash           text        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  pin_mac              text        NOT NULL,
  created_by_person_id uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  failed_attempts      smallint    NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  views                integer     NOT NULL DEFAULT 0 CHECK (views >= 0),
  revoked_at           timestamptz,
  PRIMARY KEY (share_id),
  CONSTRAINT shares_tenant_uk UNIQUE (tenant_id, share_id),
  CONSTRAINT shares_token_uk UNIQUE (token_hash),
  CONSTRAINT shares_person_fk FOREIGN KEY (tenant_id, person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT shares_creator_fk FOREIGN KEY (tenant_id, created_by_person_id) REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT shares_encounter_fk FOREIGN KEY (tenant_id, encounter_id) REFERENCES clinical.encounters (tenant_id, encounter_id),
  CONSTRAINT shares_expiry_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX shares_person_idx ON portal.shares (tenant_id, person_id, created_at DESC);
CREATE FUNCTION portal.shares_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.share_id, NEW.tenant_id, NEW.organization_id, NEW.person_id, NEW.encounter_id, NEW.token_hash, NEW.pin_mac, NEW.created_by_person_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.share_id, OLD.tenant_id, OLD.organization_id, OLD.person_id, OLD.encounter_id, OLD.token_hash, OLD.pin_mac, OLD.created_by_person_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'share is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.failed_attempts < OLD.failed_attempts OR NEW.views < OLD.views THEN RAISE EXCEPTION 'counters only increase' USING ERRCODE = '42501'; END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'share already revoked' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shares_guard BEFORE UPDATE ON portal.shares FOR EACH ROW EXECUTE FUNCTION portal.shares_guard();
-- Chỉ được chia sẻ đợt khám đã kết thúc của chính person.
CREATE FUNCTION portal.shares_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM clinical.encounters e JOIN patient.patients p ON p.tenant_id = e.tenant_id AND p.patient_id = e.patient_id
     WHERE e.tenant_id = NEW.tenant_id AND e.encounter_id = NEW.encounter_id AND e.status = 'finished' AND p.person_id = NEW.person_id) THEN
    RAISE EXCEPTION 'only a finished encounter of this person can be shared' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shares_insert_guard BEFORE INSERT ON portal.shares FOR EACH ROW EXECUTE FUNCTION portal.shares_insert_guard();
CREATE TRIGGER persons_portal_erased AFTER UPDATE OF erased_at ON patient.persons
  FOR EACH ROW WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL) EXECUTE FUNCTION portal.on_person_erased();

CREATE FUNCTION portal.share_by_token(p_hash text) RETURNS TABLE (tenant_id uuid, share_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.tenant_id, s.share_id FROM portal.shares s JOIN iam.tenants t ON t.tenant_id = s.tenant_id
   WHERE s.token_hash = p_hash AND t.status = 'active'
$$;
REVOKE ALL ON FUNCTION portal.share_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.share_by_token(text) TO hcos_app;

CREATE TABLE portal.share_views (
  view_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  share_id   uuid        NOT NULL,
  outcome    text        NOT NULL CHECK (outcome IN ('ok', 'bad_pin', 'expired', 'locked', 'revoked', 'erased')),
  ip_mac     text        NOT NULL,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id),
  CONSTRAINT share_views_share_fk FOREIGN KEY (tenant_id, share_id) REFERENCES portal.shares (tenant_id, share_id)
);
CREATE INDEX share_views_share_idx ON portal.share_views (tenant_id, share_id, viewed_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Lịch đặt qua cổng gắn person; yêu cầu xoá qua cổng (F17)
-- ---------------------------------------------------------------------------
ALTER TABLE clinical.bookings ADD COLUMN portal_person_id uuid;
ALTER TABLE clinical.bookings ADD CONSTRAINT bookings_portal_person_fk FOREIGN KEY (tenant_id, portal_person_id) REFERENCES patient.persons (tenant_id, person_id);
CREATE INDEX bookings_portal_person_idx ON clinical.bookings (tenant_id, portal_person_id) WHERE portal_person_id IS NOT NULL;
-- Chỉ đặt được lúc tạo, từ transaction của cổng (biến app.portal_booking_person); sau đó bất biến (bookings_guard có sẵn).
CREATE FUNCTION clinical.bookings_portal_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.portal_person_id := NULLIF(current_setting('app.portal_booking_person', true), '')::uuid;
  RETURN NEW;
END
$$;
CREATE TRIGGER bookings_0_portal_person BEFORE INSERT ON clinical.bookings FOR EACH ROW EXECUTE FUNCTION clinical.bookings_portal_person();

ALTER TABLE governance.erasure_requests DROP CONSTRAINT erasure_requests_channel_check;
ALTER TABLE governance.erasure_requests
  ADD CONSTRAINT erasure_requests_channel_check CHECK (channel IN ('counter', 'written', 'email', 'phone', 'portal')),
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD COLUMN portal_person_id uuid,
  ADD CONSTRAINT erasure_requests_portal_fk FOREIGN KEY (tenant_id, portal_person_id) REFERENCES patient.persons (tenant_id, person_id),
  -- Qua cổng: không có nhân viên lập (người bệnh / người giám hộ tự lập); kênh khác: bắt buộc nhân viên lập.
  ADD CONSTRAINT erasure_requests_requester_ck CHECK ((channel = 'portal') = (requested_by IS NULL) AND (channel = 'portal') = (portal_person_id IS NOT NULL));
-- portal_person_id là trường bất biến (bổ sung vào danh sách của guard F17).
CREATE OR REPLACE FUNCTION governance.erasure_requests_portal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.portal_person_id IS DISTINCT FROM OLD.portal_person_id THEN RAISE EXCEPTION 'portal_person_id is immutable' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER erasure_requests_portal_guard BEFORE UPDATE ON governance.erasure_requests FOR EACH ROW EXECUTE FUNCTION governance.erasure_requests_portal_guard();

-- ---------------------------------------------------------------------------
-- 6. RLS, chỉ-thêm, quyền cho bảng mới
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient.guardian_links', 'portal.otp_challenges', 'portal.sessions', 'portal.requests', 'portal.shares', 'portal.share_views']
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
CREATE TRIGGER share_views_append_only BEFORE UPDATE ON portal.share_views FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
GRANT SELECT, INSERT, UPDATE ON patient.guardian_links, portal.otp_challenges, portal.sessions, portal.requests, portal.shares TO hcos_app;
GRANT SELECT, INSERT ON portal.share_views TO hcos_app;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA portal FROM hcos_app, hcos_provisioner;
REVOKE DELETE, TRUNCATE ON patient.guardian_links FROM hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 7. Vai đọc của cổng: chỉ SELECT + chính sách theo person
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform, patient, clinical, finance, pharmacy, iam, portal TO hcos_portal;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id(), portal.person_ids() TO hcos_portal;
GRANT SELECT ON patient.persons, patient.patients, clinical.encounters, clinical.conditions, clinical.observations, clinical.prescriptions,
  clinical.prescription_items, clinical.bookings, clinical.service_points, finance.billing_cases, finance.receipts, pharmacy.medications TO hcos_portal;
GRANT SELECT (tenant_id, organization_id, name) ON iam.organizations TO hcos_portal;
GRANT SELECT (tenant_id, user_id, display_name) ON iam.users TO hcos_portal;

CREATE POLICY portal_read ON patient.persons FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND person_id = ANY (portal.person_ids()) AND erased_at IS NULL);
CREATE POLICY portal_read ON patient.patients FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND person_id = ANY (portal.person_ids()));
-- Đợt khám: CHỈ đã kết thúc (không lộ đợt đang mở / ghi chép dở).
CREATE POLICY portal_read ON clinical.encounters FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND status = 'finished'
         AND patient_id IN (SELECT p.patient_id FROM patient.patients p WHERE p.person_id = ANY (portal.person_ids())));
CREATE POLICY portal_read ON clinical.conditions FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND verification_status NOT IN ('entered_in_error', 'refuted')
         AND encounter_id IN (SELECT e.encounter_id FROM clinical.encounters e));
CREATE POLICY portal_read ON clinical.observations FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND status IN ('final', 'amended', 'corrected')
         AND encounter_id IN (SELECT e.encounter_id FROM clinical.encounters e));
CREATE POLICY portal_read ON clinical.prescriptions FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND status IN ('active', 'completed')
         AND encounter_id IN (SELECT e.encounter_id FROM clinical.encounters e));
CREATE POLICY portal_read ON clinical.prescription_items FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND prescription_id IN (SELECT r.prescription_id FROM clinical.prescriptions r));
CREATE POLICY portal_read ON pharmacy.medications FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND item_kind = 'drug');
CREATE POLICY portal_read ON clinical.bookings FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND erased_at IS NULL
         AND (portal_person_id = ANY (portal.person_ids())
              OR patient_id IN (SELECT p.patient_id FROM patient.patients p WHERE p.person_id = ANY (portal.person_ids()))));
CREATE POLICY portal_read ON clinical.service_points FOR SELECT TO hcos_portal USING (tenant_id = platform.current_tenant_id());
CREATE POLICY portal_read ON iam.organizations FOR SELECT TO hcos_portal USING (tenant_id = platform.current_tenant_id());
CREATE POLICY portal_read ON iam.users FOR SELECT TO hcos_portal USING (tenant_id = platform.current_tenant_id());
CREATE POLICY portal_read ON finance.billing_cases FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id()
         AND patient_id IN (SELECT p.patient_id FROM patient.patients p WHERE p.person_id = ANY (portal.person_ids())));
CREATE POLICY portal_read ON finance.receipts FOR SELECT TO hcos_portal
  USING (tenant_id = platform.current_tenant_id() AND status = 'valid' AND case_id IN (SELECT c.case_id FROM finance.billing_cases c));

COMMIT;
