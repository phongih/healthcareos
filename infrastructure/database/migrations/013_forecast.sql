-- HCOS-F10 — Dự báo kinh doanh (xác định / thống kê, chạy ngay trên SQL + backend).
--  1. Sức khám tối đa mỗi buổi của từng phòng (để cảnh báo quá tải). NULL = chưa khai báo => không cảnh báo.
--  2. Thông số dự báo theo cơ sở: chi phí cố định / tháng, % chi phí biến đổi (điểm hòa vốn), thời gian chờ hàng
--     (lead time) và mức phục vụ (safety stock) cho điểm đặt hàng lại. Mỗi lần sửa ghi một dòng lịch sử (chỉ thêm).
BEGIN;

ALTER TABLE clinical.service_points
  ADD COLUMN visit_capacity smallint CHECK (visit_capacity BETWEEN 1 AND 500);

CREATE TABLE finance.forecast_settings (
  tenant_id            uuid          NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id      uuid          NOT NULL,
  fixed_costs_monthly  bigint        NOT NULL DEFAULT 0 CHECK (fixed_costs_monthly BETWEEN 0 AND 100000000000),
  variable_cost_pct    numeric(5,2)  NOT NULL DEFAULT 0 CHECK (variable_cost_pct >= 0 AND variable_cost_pct < 100),
  lead_time_days       smallint      NOT NULL DEFAULT 3 CHECK (lead_time_days BETWEEN 1 AND 90),
  service_level_pct    numeric(4,1)  NOT NULL DEFAULT 95 CHECK (service_level_pct IN (90, 95, 97.5, 99)),
  updated_by           uuid,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  version              bigint        NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, organization_id),
  CONSTRAINT forecast_settings_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT forecast_settings_user_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER forecast_settings_version BEFORE UPDATE ON finance.forecast_settings FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Lịch sử thay đổi (chỉ thêm, do trigger ghi — app không ghi trực tiếp được nội dung khác với bản chính).
CREATE TABLE finance.forecast_settings_history (
  history_id           bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            uuid          NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id      uuid          NOT NULL,
  version              bigint        NOT NULL,
  fixed_costs_monthly  bigint        NOT NULL,
  variable_cost_pct    numeric(5,2)  NOT NULL,
  lead_time_days       smallint      NOT NULL,
  service_level_pct    numeric(4,1)  NOT NULL,
  changed_by           uuid,
  changed_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT forecast_settings_history_uk UNIQUE (tenant_id, organization_id, version)
);
-- SECURITY DEFINER: app (hcos_app) không có quyền INSERT vào bảng lịch sử, nên không ghi được dòng lịch sử giả.
CREATE FUNCTION finance.forecast_settings_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, finance AS $$
BEGIN
  INSERT INTO finance.forecast_settings_history (tenant_id, organization_id, version, fixed_costs_monthly, variable_cost_pct, lead_time_days, service_level_pct, changed_by)
  VALUES (NEW.tenant_id, NEW.organization_id, NEW.version, NEW.fixed_costs_monthly, NEW.variable_cost_pct, NEW.lead_time_days, NEW.service_level_pct, NEW.updated_by);
  RETURN NULL;
END
$$;
CREATE TRIGGER forecast_settings_log AFTER INSERT OR UPDATE ON finance.forecast_settings FOR EACH ROW EXECUTE FUNCTION finance.forecast_settings_log();
CREATE FUNCTION finance.forecast_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'forecast settings history is append-only' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER forecast_settings_history_no_update BEFORE UPDATE ON finance.forecast_settings_history FOR EACH ROW EXECUTE FUNCTION finance.forecast_history_guard();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance.forecast_settings', 'finance.forecast_settings_history']
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

GRANT SELECT, INSERT, UPDATE ON finance.forecast_settings TO hcos_app;
GRANT SELECT ON finance.forecast_settings_history TO hcos_app;
REVOKE DELETE, TRUNCATE ON finance.forecast_settings, finance.forecast_settings_history FROM PUBLIC, hcos_app, hcos_provisioner;
REVOKE INSERT, UPDATE ON finance.forecast_settings_history FROM PUBLIC, hcos_app;
REVOKE EXECUTE ON FUNCTION finance.forecast_settings_log() FROM PUBLIC;

COMMIT;
