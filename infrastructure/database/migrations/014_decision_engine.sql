-- HCOS-F11 — Decision Engine có kiểm soát: Observe → Detect → Decide → Act.
--
-- Nguyên tắc an toàn (bắt buộc ở tầng CSDL, không chỉ ở code):
--  * Engine CHỈ ghi vào schema `decision` (luật, sự kiện, nhật ký hành động, hộp thông báo, lần chạy).
--    hcos_app có quyền ghi dữ liệu lâm sàng / tài chính / kho cho các nghiệp vụ khác, nên ranh giới này được giữ bằng
--    thiết kế service (DecisionEngineService không có câu lệnh ghi nào ngoài schema decision) + test kiểm tra.
--  * Hành động là danh mục đóng: log_only, notify_<vai trò>, suggest. Gợi ý chỉ là liên kết tới màn hình nghiệp vụ;
--    người dùng bấm "Áp dụng" để mở màn hình đó và tự thao tác bằng quyền của chính mình.
--  * Sự kiện / nhật ký hành động / lần chạy / lịch sử luật: chỉ thêm (không sửa, không xoá).
--  * Sự kiện không chứa tên hay định danh bệnh nhân — chỉ chỉ số và liên kết; xem chi tiết phải qua kiểm soát truy cập
--    bình thường của hồ sơ (có audit).
--  * Luật không xoá cứng: "Xoá" = retired (ẩn), lịch sử vẫn còn để truy vết vì sao một cảnh báo đã được phát ra.
BEGIN;

CREATE SCHEMA decision;
GRANT USAGE ON SCHEMA decision TO hcos_app;

-- ---------------------------------------------------------------------------
-- 1. Luật
-- ---------------------------------------------------------------------------
CREATE TABLE decision.rules (
  rule_id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  name              text        NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 120),
  detector          text        NOT NULL CHECK (detector ~ '^[a-z][a-z_]{2,40}$'),
  -- [{ "metric": "spo2_pct", "op": "<", "value": 92 }, ...] — AND; danh mục chỉ số kiểm ở service theo detector.
  conditions        jsonb       NOT NULL CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) BETWEEN 1 AND 5),
  priority          smallint    NOT NULL CHECK (priority BETWEEN 1 AND 3),
  cooldown_minutes  integer     NOT NULL CHECK (cooldown_minutes BETWEEN 0 AND 43200),
  actions           text[]      NOT NULL CHECK (
                      cardinality(actions) BETWEEN 1 AND 8
                      AND actions <@ ARRAY['log_only', 'suggest', 'notify_doctor', 'notify_clinic_staff', 'notify_cashier',
                                           'notify_pharmacist', 'notify_pharmacy_admin', 'notify_clinic_admin', 'notify_executive']::text[]
                      -- log_only đứng một mình; suggest phải đi kèm ít nhất một notify.
                      AND (NOT ('log_only' = ANY (actions)) OR cardinality(actions) = 1)
                      AND (NOT ('suggest' = ANY (actions)) OR array_to_string(actions, ',') LIKE '%notify\_%')
                    ),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (rule_id),
  CONSTRAINT rules_tenant_org_uk UNIQUE (tenant_id, rule_id, organization_id),
  CONSTRAINT rules_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT rules_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT rules_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE UNIQUE INDEX rules_name_uk ON decision.rules (tenant_id, organization_id, lower(btrim(name))) WHERE status <> 'retired';
CREATE INDEX rules_active_idx ON decision.rules (tenant_id, organization_id) WHERE status = 'active';

CREATE FUNCTION decision.rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.organization_id, NEW.detector, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.organization_id, OLD.detector, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'rule organization/detector/creator are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired rule cannot be modified' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rules_a_guard   BEFORE UPDATE ON decision.rules FOR EACH ROW EXECUTE FUNCTION decision.rules_guard();
CREATE TRIGGER rules_b_version BEFORE UPDATE ON decision.rules FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Lịch sử luật (mỗi phiên bản một dòng), do trigger SECURITY DEFINER ghi: app không chèn / sửa được.
CREATE TABLE decision.rule_versions (
  history_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  rule_id           uuid        NOT NULL,
  version           bigint      NOT NULL,
  name              text        NOT NULL,
  conditions        jsonb       NOT NULL,
  priority          smallint    NOT NULL,
  cooldown_minutes  integer     NOT NULL,
  actions           text[]      NOT NULL,
  status            text        NOT NULL,
  changed_by        uuid,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_versions_uk UNIQUE (tenant_id, rule_id, version)
);
CREATE FUNCTION decision.rules_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, decision AS $$
BEGIN
  INSERT INTO decision.rule_versions (tenant_id, rule_id, version, name, conditions, priority, cooldown_minutes, actions, status, changed_by)
  VALUES (NEW.tenant_id, NEW.rule_id, NEW.version, NEW.name, NEW.conditions, NEW.priority, NEW.cooldown_minutes, NEW.actions, NEW.status,
          COALESCE(NEW.updated_by, NEW.created_by));
  RETURN NULL;
END
$$;
CREATE TRIGGER rules_log AFTER INSERT OR UPDATE ON decision.rules FOR EACH ROW EXECUTE FUNCTION decision.rules_log();
REVOKE EXECUTE ON FUNCTION decision.rules_log() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Lần chạy (Job Status) — ghi một dòng khi kết thúc (thành công hoặc lỗi).
-- ---------------------------------------------------------------------------
CREATE TABLE decision.job_runs (
  run_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  trigger           text        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  triggered_by      uuid,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  status            text        NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  rules_evaluated   integer     NOT NULL DEFAULT 0 CHECK (rules_evaluated >= 0),
  candidates        integer     NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  events_created    integer     NOT NULL DEFAULT 0 CHECK (events_created >= 0),
  suppressed        integer     NOT NULL DEFAULT 0 CHECK (suppressed >= 0),
  -- [{ "detector": "...", "ms": 12, "candidates": 3, "error": null }]
  detail            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(detail) = 'array'),
  error_code        text        CHECK (error_code IS NULL OR length(error_code) <= 60),
  PRIMARY KEY (run_id),
  CONSTRAINT job_runs_tenant_uk UNIQUE (tenant_id, run_id, organization_id),
  CONSTRAINT job_runs_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT job_runs_user_fk FOREIGN KEY (tenant_id, triggered_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT job_runs_time_ck CHECK (finished_at >= started_at),
  CONSTRAINT job_runs_manual_ck CHECK ((trigger = 'manual') = (triggered_by IS NOT NULL))
);
CREATE INDEX job_runs_recent_idx ON decision.job_runs (tenant_id, organization_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Sự kiện (Detect + Decide) — chỉ số, không có định danh bệnh nhân.
-- ---------------------------------------------------------------------------
CREATE TABLE decision.events (
  event_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  rule_id           uuid        NOT NULL,
  rule_version      bigint      NOT NULL,
  run_id            uuid        NOT NULL,
  detector          text        NOT NULL,
  -- Khoá đối tượng để tính cooldown (vd. 'encounter:<uuid>:59408-5', 'med:<uuid>', 'room:<uuid>:2026-11-21:morning').
  subject_key       text        NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 200),
  priority          smallint    NOT NULL CHECK (priority BETWEEN 1 AND 3),
  title             text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail            text        CHECK (detail IS NULL OR length(detail) <= 1000),
  metrics           jsonb       NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  -- Liên kết nội bộ tới màn hình nghiệp vụ (hash route), không phải URL ngoài.
  link              text        CHECK (link IS NULL OR link ~ '^#/[A-Za-z0-9/_?=&.:-]{0,200}$'),
  detected_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id),
  CONSTRAINT events_tenant_org_uk UNIQUE (tenant_id, event_id, organization_id),
  CONSTRAINT events_rule_fk FOREIGN KEY (tenant_id, rule_id, organization_id) REFERENCES decision.rules (tenant_id, rule_id, organization_id),
  CONSTRAINT events_run_fk  FOREIGN KEY (tenant_id, run_id, organization_id) REFERENCES decision.job_runs (tenant_id, run_id, organization_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX events_cooldown_idx ON decision.events (tenant_id, rule_id, subject_key, detected_at DESC);
CREATE INDEX events_recent_idx   ON decision.events (tenant_id, organization_id, detected_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Nhật ký hành động (Act) — mỗi hành động của một sự kiện một dòng; chỉ thêm.
--    Gồm cả hành động của con người trên thông báo (handled / applied / dismissed).
-- ---------------------------------------------------------------------------
CREATE TABLE decision.action_log (
  action_id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  event_id          uuid        NOT NULL,
  action            text        NOT NULL CHECK (action ~ '^(log_only|suggest|notify_[a-z_]+|human_(handled|applied|dismissed|reopened))$'),
  actor_type        text        NOT NULL CHECK (actor_type IN ('engine', 'user')),
  actor_user_id     uuid,
  outcome           text        NOT NULL CHECK (outcome IN ('done', 'skipped')),
  note              text        CHECK (note IS NULL OR length(note) <= 300),
  at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_log_event_fk FOREIGN KEY (tenant_id, event_id, organization_id) REFERENCES decision.events (tenant_id, event_id, organization_id),
  CONSTRAINT action_log_user_fk FOREIGN KEY (tenant_id, actor_user_id) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT action_log_actor_ck CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL))
);
CREATE INDEX action_log_recent_idx ON decision.action_log (tenant_id, organization_id, at DESC);

-- ---------------------------------------------------------------------------
-- 5. Hộp thông báo theo vai trò × cơ sở. Chỉ được đổi trạng thái xử lý.
-- ---------------------------------------------------------------------------
CREATE TABLE decision.notifications (
  notification_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id   uuid        NOT NULL,
  event_id          uuid        NOT NULL,
  target_role       text        NOT NULL CHECK (target_role IN ('doctor', 'clinic_staff', 'cashier', 'pharmacist', 'pharmacy_admin', 'clinic_admin', 'executive')),
  has_suggestion    boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  suggestion_status text        CHECK (suggestion_status IS NULL OR suggestion_status IN ('pending', 'applied', 'dismissed')),
  handled_by        uuid,
  handled_at        timestamptz,
  handled_note      text        CHECK (handled_note IS NULL OR length(handled_note) <= 300),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (notification_id),
  CONSTRAINT notifications_event_role_uk UNIQUE (tenant_id, event_id, target_role),
  CONSTRAINT notifications_event_fk FOREIGN KEY (tenant_id, event_id, organization_id) REFERENCES decision.events (tenant_id, event_id, organization_id),
  CONSTRAINT notifications_user_fk FOREIGN KEY (tenant_id, handled_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT notifications_handled_ck CHECK ((status = 'handled') = (handled_by IS NOT NULL AND handled_at IS NOT NULL)),
  CONSTRAINT notifications_suggestion_ck CHECK (has_suggestion = (suggestion_status IS NOT NULL)),
  -- Áp dụng / bỏ qua gợi ý là một cách xử lý thông báo.
  CONSTRAINT notifications_suggestion_handled_ck CHECK (suggestion_status IS DISTINCT FROM 'applied' AND suggestion_status IS DISTINCT FROM 'dismissed' OR status = 'handled')
);
CREATE INDEX notifications_inbox_idx ON decision.notifications (tenant_id, organization_id, target_role, status, created_at DESC);

CREATE FUNCTION decision.notifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'suggestion_status', 'handled_by', 'handled_at', 'handled_note', 'updated_at', 'version'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'suggestion_status', 'handled_by', 'handled_at', 'handled_note', 'updated_at', 'version']) THEN
    RAISE EXCEPTION 'notification content is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notifications_a_guard   BEFORE UPDATE ON decision.notifications FOR EACH ROW EXECUTE FUNCTION decision.notifications_guard();
CREATE TRIGGER notifications_b_version BEFORE UPDATE ON decision.notifications FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 6. Bộ lập lịch: danh sách cơ sở có luật đang bật (tenant đang hoạt động). Không trả dữ liệu nào khác.
-- ---------------------------------------------------------------------------
CREATE FUNCTION decision.due_organizations()
RETURNS TABLE (tenant_id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT r.tenant_id, r.organization_id
    FROM decision.rules r
    JOIN iam.tenants t ON t.tenant_id = r.tenant_id
    JOIN iam.organizations o ON o.tenant_id = r.tenant_id AND o.organization_id = r.organization_id
   WHERE r.status = 'active' AND t.status = 'active' AND o.status = 'active'
$$;
REVOKE ALL ON FUNCTION decision.due_organizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision.due_organizations() TO hcos_app;

-- ---------------------------------------------------------------------------
-- 7. Chỉ thêm / không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
CREATE FUNCTION decision.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['decision.rules', 'decision.rule_versions', 'decision.job_runs', 'decision.events', 'decision.action_log', 'decision.notifications']
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
  FOREACH t IN ARRAY ARRAY['decision.rule_versions', 'decision.job_runs', 'decision.events', 'decision.action_log']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION decision.append_only()',
                   replace(t, '.', '_') || '_no_update', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON decision.rules, decision.notifications TO hcos_app;
GRANT SELECT, INSERT ON decision.job_runs, decision.events, decision.action_log TO hcos_app;
GRANT SELECT ON decision.rule_versions TO hcos_app;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA decision FROM PUBLIC, hcos_app, hcos_provisioner;
REVOKE INSERT, UPDATE ON decision.rule_versions FROM PUBLIC, hcos_app;
REVOKE UPDATE ON decision.job_runs, decision.events, decision.action_log FROM PUBLIC, hcos_app;

COMMIT;
