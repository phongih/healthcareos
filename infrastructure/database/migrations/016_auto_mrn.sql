-- HCOS-F13 — Mã bệnh nhân (MRN) tự sinh: <TIỀN TỐ><YY>-<NNNNNN>-<C>, vd. BN26-000123-7.
--  * CSDL cấp số theo (cơ sở, năm đăng ký theo giờ Việt Nam); khoá dòng bộ đếm => hai lễ tân bấm cùng lúc không trùng.
--  * C = số kiểm tra Luhn trên 8 chữ số YYNNNNNN: gõ sai 1 chữ số hoặc đảo 2 chữ số kề nhau (trừ 09↔90) bị phát hiện.
--  * Mã không chứa thông tin cá nhân. Mã đã cấp không đổi (MRN của hồ sơ cũ giữ nguyên).
--  * Mã cũ (chuyển từ sổ giấy / phần mềm cũ) chỉ được nhập khi quản lý bật allow_legacy, và không được có dạng mã tự sinh.
BEGIN;

CREATE TABLE patient.mrn_settings (
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  prefix           text        NOT NULL DEFAULT 'BN' CHECK (prefix ~ '^[A-Z]{1,4}$'),
  allow_legacy     boolean     NOT NULL DEFAULT false,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, organization_id),
  CONSTRAINT mrn_settings_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT mrn_settings_user_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE TRIGGER mrn_settings_version BEFORE UPDATE ON patient.mrn_settings FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

CREATE TABLE patient.mrn_counters (
  tenant_id        uuid     NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid     NOT NULL,
  year             smallint NOT NULL CHECK (year BETWEEN 0 AND 99),
  last_value       integer  NOT NULL CHECK (last_value BETWEEN 1 AND 999999),
  PRIMARY KEY (tenant_id, organization_id, year),
  CONSTRAINT mrn_counters_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);
-- Bộ đếm chỉ tăng.
CREATE FUNCTION patient.mrn_counters_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_value <= OLD.last_value OR (NEW.tenant_id, NEW.organization_id, NEW.year) IS DISTINCT FROM (OLD.tenant_id, OLD.organization_id, OLD.year) THEN
    RAISE EXCEPTION 'mrn counter can only increase' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mrn_counters_guard BEFORE UPDATE ON patient.mrn_counters FOR EACH ROW EXECUTE FUNCTION patient.mrn_counters_guard();

-- Số kiểm tra Luhn của một chuỗi chữ số.
CREATE FUNCTION patient.luhn_digit(p_digits text) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  s integer := 0;
  d integer;
  i integer;
  dbl boolean := true;
BEGIN
  IF p_digits !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'luhn_digit needs digits' USING ERRCODE = '22023';
  END IF;
  FOR i IN REVERSE length(p_digits)..1 LOOP
    d := substr(p_digits, i, 1)::integer;
    IF dbl THEN
      d := d * 2;
      IF d > 9 THEN d := d - 9; END IF;
    END IF;
    s := s + d;
    dbl := NOT dbl;
  END LOOP;
  RETURN (10 - s % 10) % 10;
END
$$;

-- Cấp mã tiếp theo cho cơ sở (chạy với quyền người gọi => RLS áp dụng).
CREATE FUNCTION patient.next_mrn(p_tenant uuid, p_org uuid, p_at timestamptz) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  yy smallint := (extract(year FROM p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::integer % 100)::smallint;
  n integer;
  pfx text;
  digits text;
BEGIN
  INSERT INTO patient.mrn_counters AS c (tenant_id, organization_id, year, last_value)
  VALUES (p_tenant, p_org, yy, 1)
  ON CONFLICT (tenant_id, organization_id, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO n;
  SELECT prefix INTO pfx FROM patient.mrn_settings WHERE tenant_id = p_tenant AND organization_id = p_org;
  digits := lpad(yy::text, 2, '0') || lpad(n::text, 6, '0');
  RETURN COALESCE(pfx, 'BN') || lpad(yy::text, 2, '0') || '-' || lpad(n::text, 6, '0') || '-' || patient.luhn_digit(digits)::text;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient.mrn_settings', 'patient.mrn_counters']
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
END
$$;

GRANT SELECT, INSERT, UPDATE ON patient.mrn_settings, patient.mrn_counters TO hcos_app;
REVOKE DELETE, TRUNCATE ON patient.mrn_settings, patient.mrn_counters FROM PUBLIC, hcos_app;
GRANT EXECUTE ON FUNCTION patient.luhn_digit(text), patient.next_mrn(uuid, uuid, timestamptz) TO hcos_app;

COMMIT;
