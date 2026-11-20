-- HCOS-F12 — Hạ tầng tích hợp: outbox sự kiện, kết nối (Microsoft Teams Workflows, webhook chung có chữ ký HMAC),
-- giao có thử lại, nhật ký từng lần gửi.
--
-- Nguyên tắc:
--  * Outbox ghi CÙNG transaction với thay đổi nghiệp vụ => không mất sự kiện, không gửi sự kiện của transaction đã rollback.
--  * Nội dung gửi ra ngoài KHÔNG chứa định danh bệnh nhân (payload do service dựng từ danh mục trường cho phép).
--  * URL kết nối và bí mật ký được mã hoá AES-256-GCM ở tầng ứng dụng (khoá HCOS_INTEGRATION_KEY, không nằm trong CSDL);
--    CSDL chỉ giữ bản mã + gợi ý đã che để hiển thị.
--  * outbox / delivery_attempts / lịch sử kết nối: chỉ thêm. deliveries chỉ đổi được cột trạng thái giao.
BEGIN;

CREATE SCHEMA integration;
GRANT USAGE ON SCHEMA integration TO hcos_app;

-- ---------------------------------------------------------------------------
-- 1. Kết nối (endpoint)
-- ---------------------------------------------------------------------------
CREATE TABLE integration.endpoints (
  endpoint_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id     uuid        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('teams_workflow', 'webhook')),
  name                text        NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 120),
  -- 'v1:' || base64(iv | tag | bản mã); AAD = tenant_id:endpoint_id:url
  url_ciphertext      text        NOT NULL CHECK (url_ciphertext ~ '^v1:[A-Za-z0-9+/=]+$' AND length(url_ciphertext) BETWEEN 43 AND 4000),
  url_hint            text        NOT NULL CHECK (length(url_hint) BETWEEN 3 AND 200),
  -- Bí mật ký HMAC (chỉ webhook); AAD = tenant_id:endpoint_id:secret
  secret_ciphertext   text        CHECK (secret_ciphertext IS NULL OR (secret_ciphertext ~ '^v1:[A-Za-z0-9+/=]+$' AND length(secret_ciphertext) BETWEEN 43 AND 4000)),
  event_types         text[]      NOT NULL CHECK (
                        cardinality(event_types) BETWEEN 1 AND 10
                        AND event_types <@ ARRAY['decision.event', 'system.alert']::text[]
                      ),
  -- Chỉ gửi sự kiện Decision Engine có mức ưu tiên <= giá trị này (1 = chỉ P1).
  max_priority        smallint    NOT NULL DEFAULT 2 CHECK (max_priority BETWEEN 1 AND 3),
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  paused_reason       text        CHECK (paused_reason IS NULL OR paused_reason IN ('manual', 'auto_failures')),
  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (endpoint_id),
  CONSTRAINT endpoints_tenant_org_uk UNIQUE (tenant_id, endpoint_id, organization_id),
  CONSTRAINT endpoints_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT endpoints_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT endpoints_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT endpoints_secret_ck CHECK ((kind = 'webhook') = (secret_ciphertext IS NOT NULL)),
  CONSTRAINT endpoints_paused_ck CHECK ((status = 'paused') = (paused_reason IS NOT NULL))
);
CREATE UNIQUE INDEX endpoints_name_uk ON integration.endpoints (tenant_id, organization_id, lower(btrim(name))) WHERE status <> 'retired';
CREATE INDEX endpoints_active_idx ON integration.endpoints (tenant_id, organization_id) WHERE status = 'active';

CREATE FUNCTION integration.endpoints_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.organization_id, NEW.kind, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.organization_id, OLD.kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'endpoint organization/kind/creator are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired endpoint cannot be modified' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER endpoints_a_guard   BEFORE UPDATE ON integration.endpoints FOR EACH ROW EXECUTE FUNCTION integration.endpoints_guard();
CREATE TRIGGER endpoints_b_version BEFORE UPDATE ON integration.endpoints FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Sức khoẻ kết nối (bộ giao cập nhật liên tục): tách khỏi endpoints để KHÔNG đổi version của cấu hình
-- (nếu không, người quản lý sửa / tạm dừng một kết nối đang gửi sẽ luôn gặp xung đột phiên bản).
CREATE TABLE integration.endpoint_health (
  tenant_id            uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  endpoint_id          uuid        NOT NULL,
  organization_id      uuid        NOT NULL,
  consecutive_failures integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  PRIMARY KEY (tenant_id, endpoint_id),
  CONSTRAINT endpoint_health_fk FOREIGN KEY (tenant_id, endpoint_id, organization_id) REFERENCES integration.endpoints (tenant_id, endpoint_id, organization_id)
);
CREATE FUNCTION integration.endpoint_health_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.endpoint_id, NEW.organization_id) IS DISTINCT FROM (OLD.tenant_id, OLD.endpoint_id, OLD.organization_id) THEN
    RAISE EXCEPTION 'endpoint_health identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER endpoint_health_guard BEFORE UPDATE ON integration.endpoint_health FOR EACH ROW EXECUTE FUNCTION integration.endpoint_health_guard();

-- Lịch sử cấu hình kết nối (không chứa URL / bí mật): ai đổi gì, khi nào. Ghi bằng trigger SECURITY DEFINER.
CREATE TABLE integration.endpoint_history (
  history_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  endpoint_id       uuid        NOT NULL,
  version           bigint      NOT NULL,
  name              text        NOT NULL,
  url_hint          text        NOT NULL,
  url_changed       boolean     NOT NULL,
  secret_rotated    boolean     NOT NULL,
  event_types       text[]      NOT NULL,
  max_priority      smallint    NOT NULL,
  status            text        NOT NULL,
  paused_reason     text,
  changed_by        uuid,
  changed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoint_history_idx ON integration.endpoint_history (tenant_id, endpoint_id, history_id DESC);
CREATE FUNCTION integration.endpoints_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, integration AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.name, NEW.url_ciphertext, NEW.secret_ciphertext, NEW.event_types, NEW.max_priority, NEW.status)
       IS NOT DISTINCT FROM (OLD.name, OLD.url_ciphertext, OLD.secret_ciphertext, OLD.event_types, OLD.max_priority, OLD.status) THEN
    RETURN NULL;
  END IF;
  INSERT INTO integration.endpoint_history (tenant_id, endpoint_id, version, name, url_hint, url_changed, secret_rotated, event_types, max_priority, status, paused_reason, changed_by)
  VALUES (NEW.tenant_id, NEW.endpoint_id, NEW.version, NEW.name, NEW.url_hint,
          TG_OP = 'UPDATE' AND NEW.url_ciphertext IS DISTINCT FROM OLD.url_ciphertext,
          TG_OP = 'UPDATE' AND NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext,
          NEW.event_types, NEW.max_priority, NEW.status, NEW.paused_reason,
          CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.updated_by END);
  RETURN NULL;
END
$$;
CREATE TRIGGER endpoints_log AFTER INSERT OR UPDATE ON integration.endpoints FOR EACH ROW EXECUTE FUNCTION integration.endpoints_log();
REVOKE EXECUTE ON FUNCTION integration.endpoints_log() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Outbox sự kiện (chỉ thêm)
-- ---------------------------------------------------------------------------
CREATE TABLE integration.outbox (
  event_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  event_type        text        NOT NULL CHECK (event_type IN ('decision.event', 'system.alert', 'integration.test')),
  priority          smallint    NOT NULL CHECK (priority BETWEEN 1 AND 3),
  payload           jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  -- Sự kiện nguồn (vd. decision.events.event_id) để truy vết; không ràng buộc FK vì nguồn khác nhau.
  source_id         uuid,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id),
  CONSTRAINT outbox_tenant_org_uk UNIQUE (tenant_id, event_id, organization_id),
  CONSTRAINT outbox_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);
CREATE INDEX outbox_recent_idx ON integration.outbox (tenant_id, organization_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Giao (mỗi sự kiện × kết nối một dòng) + nhật ký từng lần gửi
-- ---------------------------------------------------------------------------
CREATE TABLE integration.deliveries (
  delivery_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  endpoint_id       uuid        NOT NULL,
  event_id          uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'succeeded', 'dead', 'cancelled')),
  attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  -- Đang gửi: giữ chỗ tới thời điểm này; quá hạn (tiến trình chết giữa chừng) => được nhận lại.
  locked_until      timestamptz,
  last_status_code  integer     CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  last_error        text        CHECK (last_error IS NULL OR last_error ~ '^[A-Z0-9_:]{1,60}$'),
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (delivery_id),
  CONSTRAINT deliveries_uk UNIQUE (tenant_id, event_id, endpoint_id),
  CONSTRAINT deliveries_tenant_org_uk UNIQUE (tenant_id, delivery_id, organization_id),
  CONSTRAINT deliveries_endpoint_fk FOREIGN KEY (tenant_id, endpoint_id, organization_id) REFERENCES integration.endpoints (tenant_id, endpoint_id, organization_id),
  CONSTRAINT deliveries_event_fk FOREIGN KEY (tenant_id, event_id, organization_id) REFERENCES integration.outbox (tenant_id, event_id, organization_id),
  CONSTRAINT deliveries_sending_ck CHECK ((status = 'sending') = (locked_until IS NOT NULL)),
  CONSTRAINT deliveries_done_ck CHECK ((status = 'succeeded') = (delivered_at IS NOT NULL))
);
CREATE INDEX deliveries_due_idx ON integration.deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX deliveries_recent_idx ON integration.deliveries (tenant_id, organization_id, created_at DESC);
CREATE INDEX deliveries_endpoint_idx ON integration.deliveries (tenant_id, endpoint_id, created_at DESC);

CREATE FUNCTION integration.deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.organization_id, NEW.endpoint_id, NEW.event_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.organization_id, OLD.endpoint_id, OLD.event_id, OLD.created_at) THEN
    RAISE EXCEPTION 'delivery identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'finished delivery cannot change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deliveries_a_guard   BEFORE UPDATE ON integration.deliveries FOR EACH ROW EXECUTE FUNCTION integration.deliveries_guard();
CREATE TRIGGER deliveries_b_version BEFORE UPDATE ON integration.deliveries FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

CREATE TABLE integration.delivery_attempts (
  attempt_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  delivery_id       uuid        NOT NULL,
  attempt_no        integer     NOT NULL CHECK (attempt_no BETWEEN 1 AND 20),
  started_at        timestamptz NOT NULL,
  duration_ms       integer     NOT NULL CHECK (duration_ms >= 0),
  status_code       integer     CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  outcome           text        NOT NULL CHECK (outcome IN ('success', 'retry', 'dead')),
  error_code        text        CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_:]{1,60}$'),
  -- 'manual' = bấm Gửi thử / Gửi lại.
  trigger           text        NOT NULL CHECK (trigger IN ('dispatcher', 'manual')),
  actor_user_id     uuid,
  CONSTRAINT attempts_delivery_fk FOREIGN KEY (tenant_id, delivery_id, organization_id) REFERENCES integration.deliveries (tenant_id, delivery_id, organization_id),
  CONSTRAINT attempts_user_fk FOREIGN KEY (tenant_id, actor_user_id) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT attempts_uk UNIQUE (tenant_id, delivery_id, attempt_no)
);
CREATE INDEX attempts_recent_idx ON integration.delivery_attempts (tenant_id, organization_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Bộ giao: lấy các lượt giao đến hạn của MỌI tenant (chỉ trả khoá, không trả nội dung).
-- ---------------------------------------------------------------------------
CREATE FUNCTION integration.due_deliveries(p_now timestamptz, p_limit integer)
RETURNS TABLE (tenant_id uuid, organization_id uuid, delivery_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.tenant_id, d.organization_id, d.delivery_id
    FROM integration.deliveries d
    JOIN integration.endpoints e ON e.tenant_id = d.tenant_id AND e.endpoint_id = d.endpoint_id
    JOIN iam.tenants t ON t.tenant_id = d.tenant_id
   WHERE ((d.status = 'pending' AND d.next_attempt_at <= p_now) OR (d.status = 'sending' AND d.locked_until < p_now))
     AND e.status = 'active' AND t.status = 'active'
   ORDER BY d.next_attempt_at
   LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;
REVOKE ALL ON FUNCTION integration.due_deliveries(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.due_deliveries(timestamptz, integer) TO hcos_app;

-- ---------------------------------------------------------------------------
-- 5. Chỉ thêm / không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
CREATE FUNCTION integration.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration.endpoints', 'integration.endpoint_health', 'integration.endpoint_history', 'integration.outbox', 'integration.deliveries', 'integration.delivery_attempts']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation()', replace(t, '.', '_') || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation()', replace(t, '.', '_') || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO hcos_app
         USING (tenant_id = platform.current_tenant_id())
         WITH CHECK (tenant_id = platform.current_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['integration.endpoint_history', 'integration.outbox', 'integration.delivery_attempts']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION integration.append_only()', replace(t, '.', '_') || '_no_update', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON integration.endpoints, integration.endpoint_health, integration.deliveries TO hcos_app;
GRANT SELECT, INSERT ON integration.outbox, integration.delivery_attempts TO hcos_app;
GRANT SELECT ON integration.endpoint_history TO hcos_app;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA integration FROM PUBLIC, hcos_app, hcos_provisioner;
REVOKE INSERT, UPDATE ON integration.endpoint_history FROM PUBLIC, hcos_app;
REVOKE UPDATE ON integration.outbox, integration.delivery_attempts FROM PUBLIC, hcos_app;

COMMIT;
