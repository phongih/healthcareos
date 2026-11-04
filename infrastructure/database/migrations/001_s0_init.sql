-- =============================================================================
-- HCOS-P0-ENG-001 | Slice S0 | Platform Kernel, Identity & Tenant Isolation
-- Migration 001: iam / patient / platform
-- Target: PostgreSQL 14+
--
-- Quy ước:
--  * Mọi bảng đều có tenant_id (NOT NULL) và được bảo vệ bằng Row-Level Security (FORCE).
--  * Ứng dụng phải set tenant trong transaction: SELECT set_config('app.tenant_id', '<uuid>', true);
--    Không có tenant context => current_tenant_id() = NULL => mọi policy đều trả 0 dòng (fail-closed).
--  * Optimistic concurrency: cột `version` tự tăng bởi trigger. Ứng dụng cập nhật theo mẫu
--      UPDATE ... SET ... WHERE <pk> = $1 AND tenant_id = $2 AND version = $3;
--    0 dòng bị ảnh hưởng => xung đột phiên bản (HTTP 409).
--  * platform.audit_events là append-only (chặn UPDATE/DELETE/TRUNCATE) + hash-chain theo tenant.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Roles (NOLOGIN; gán cho login role tương ứng ở tầng hạ tầng)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hcos_app') THEN
    CREATE ROLE hcos_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hcos_provisioner') THEN
    CREATE ROLE hcos_provisioner NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS patient;
CREATE SCHEMA IF NOT EXISTS platform;

GRANT USAGE ON SCHEMA iam, patient, platform TO hcos_app, hcos_provisioner;

-- ---------------------------------------------------------------------------
-- 1. Platform helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Trigger: tenant_id bất biến + tự tăng version + cập nhật updated_at.
CREATE OR REPLACE FUNCTION platform.guard_and_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable (table %.%)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  NEW.version    := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. IAM
-- ---------------------------------------------------------------------------
CREATE TABLE iam.tenants (
  tenant_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL,
  name        text        NOT NULL,
  status      text        NOT NULL DEFAULT 'active'
              CHECK (status IN ('provisioning', 'active', 'suspended', 'closed')),
  region      text        NOT NULL DEFAULT 'vn',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT tenants_code_uk UNIQUE (code),
  CONSTRAINT tenants_code_fmt CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,62}$')
);

CREATE TABLE iam.organizations (
  organization_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  parent_organization_id uuid,
  type                   text        NOT NULL
                         CHECK (type IN ('hospital_group', 'clinic', 'pharmacy_chain', 'pharmacy_store', 'department', 'headquarters')),
  code                   text        NOT NULL,
  name                   text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (organization_id),
  CONSTRAINT organizations_tenant_org_uk  UNIQUE (tenant_id, organization_id),
  CONSTRAINT organizations_tenant_code_uk UNIQUE (tenant_id, code),
  -- Cha và con bắt buộc cùng tenant
  CONSTRAINT organizations_parent_fk FOREIGN KEY (tenant_id, parent_organization_id)
    REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT organizations_no_self_parent CHECK (parent_organization_id IS DISTINCT FROM organization_id)
);
CREATE INDEX organizations_tenant_parent_idx ON iam.organizations (tenant_id, parent_organization_id);

-- patient.persons đặt trước iam.users vì users có thể trỏ tới person (tài khoản Patient App).
CREATE TABLE patient.persons (
  person_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  given_name            text        NOT NULL,
  family_name           text        NOT NULL,
  birth_date            date,
  sex                   text        CHECK (sex IN ('male', 'female', 'other', 'unknown')),
  phone                 text,
  email                 text,
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'deceased', 'inactive')),
  merged_into_person_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (person_id),
  CONSTRAINT persons_tenant_person_uk UNIQUE (tenant_id, person_id),
  CONSTRAINT persons_merge_fk FOREIGN KEY (tenant_id, merged_into_person_id)
    REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT persons_merge_consistency CHECK (
    (status = 'merged') = (merged_into_person_id IS NOT NULL)
  )
);
CREATE INDEX persons_tenant_name_idx ON patient.persons (tenant_id, family_name, given_name);

CREATE TABLE iam.users (
  user_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  external_subject text        NOT NULL,            -- `sub` từ IdP (OIDC)
  email            text,
  display_name     text        NOT NULL,
  person_id        uuid,                            -- chỉ có khi user là bệnh nhân/người dùng cá nhân
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'locked', 'disabled')),
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (user_id),
  CONSTRAINT users_tenant_user_uk    UNIQUE (tenant_id, user_id),
  CONSTRAINT users_tenant_subject_uk UNIQUE (tenant_id, external_subject),
  CONSTRAINT users_person_fk FOREIGN KEY (tenant_id, person_id)
    REFERENCES patient.persons (tenant_id, person_id)
);
CREATE UNIQUE INDEX users_tenant_email_uk ON iam.users (tenant_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE iam.memberships (
  membership_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  user_id         uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  role            text        NOT NULL CHECK (role IN (
                    'doctor', 'pharmacist', 'patient', 'clinic_staff', 'cashier',
                    'clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin', 'system')),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (membership_id),
  CONSTRAINT memberships_tenant_membership_uk UNIQUE (tenant_id, membership_id),
  CONSTRAINT memberships_user_org_role_uk UNIQUE (tenant_id, user_id, organization_id, role),
  CONSTRAINT memberships_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT memberships_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT memberships_validity CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX memberships_tenant_user_idx ON iam.memberships (tenant_id, user_id);
CREATE INDEX memberships_tenant_org_idx  ON iam.memberships (tenant_id, organization_id);

-- ---------------------------------------------------------------------------
-- 3. PATIENT (person_id = danh tính con người; patient_id = hồ sơ bệnh nhân tại 1 organization)
-- ---------------------------------------------------------------------------
CREATE TABLE patient.patients (
  patient_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  person_id       uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  mrn             text        NOT NULL,             -- Medical Record Number, duy nhất trong organization
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deceased', 'entered_in_error')),
  registered_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (patient_id),
  CONSTRAINT patients_tenant_patient_uk UNIQUE (tenant_id, patient_id),
  CONSTRAINT patients_org_mrn_uk        UNIQUE (tenant_id, organization_id, mrn),
  CONSTRAINT patients_person_org_uk     UNIQUE (tenant_id, person_id, organization_id),
  CONSTRAINT patients_person_fk FOREIGN KEY (tenant_id, person_id)
    REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT patients_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES iam.organizations (tenant_id, organization_id)
);
CREATE INDEX patients_tenant_person_idx ON patient.patients (tenant_id, person_id);

CREATE TABLE patient.identifiers (
  identifier_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  person_id     uuid        NOT NULL,
  patient_id    uuid,                                -- NULL = định danh cấp person (CCCD, BHYT...)
  type          text        NOT NULL CHECK (type IN ('national_id', 'health_insurance', 'passport', 'mrn', 'phone', 'external')),
  system        text        NOT NULL,                -- URI namespace, vd: urn:oid:... / https://moh.gov.vn/cccd
  value         text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'entered_in_error')),
  period_start  date,
  period_end    date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (identifier_id),
  CONSTRAINT identifiers_person_fk FOREIGN KEY (tenant_id, person_id)
    REFERENCES patient.persons (tenant_id, person_id),
  CONSTRAINT identifiers_patient_fk FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patient.patients (tenant_id, patient_id),
  CONSTRAINT identifiers_period CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
CREATE UNIQUE INDEX identifiers_active_system_value_uk
  ON patient.identifiers (tenant_id, system, value) WHERE status = 'active';
CREATE INDEX identifiers_tenant_person_idx  ON patient.identifiers (tenant_id, person_id);
CREATE INDEX identifiers_tenant_patient_idx ON patient.identifiers (tenant_id, patient_id) WHERE patient_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. PLATFORM: audit (append-only, hash-chain) & transactional outbox
-- ---------------------------------------------------------------------------
CREATE TABLE platform.audit_events (
  event_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text        NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
  actor_id         text        NOT NULL,
  organization_id  uuid,
  action           text        NOT NULL,                -- vd: patient.read, patient.create, auth.denied
  resource_type    text        NOT NULL,
  resource_id      text,
  person_id        uuid,
  patient_id       uuid,
  outcome          text        NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  correlation_id   text        NOT NULL,
  source_ip        inet,
  user_agent       text,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash        bytea       NOT NULL,                -- do trigger gán
  event_hash       bytea       NOT NULL,                -- do trigger gán
  version          smallint    NOT NULL DEFAULT 1 CHECK (version = 1),   -- schema version của envelope
  PRIMARY KEY (event_id),
  CONSTRAINT audit_tenant_event_uk UNIQUE (tenant_id, event_id)
) ;
CREATE INDEX audit_tenant_time_idx     ON platform.audit_events (tenant_id, occurred_at DESC);
CREATE INDEX audit_tenant_resource_idx ON platform.audit_events (tenant_id, resource_type, resource_id);
CREATE INDEX audit_tenant_patient_idx  ON platform.audit_events (tenant_id, patient_id) WHERE patient_id IS NOT NULL;

-- Đầu chuỗi hash theo tenant. Chỉ truy cập qua trigger (SECURITY DEFINER).
CREATE TABLE platform.audit_chain_heads (
  tenant_id  uuid  PRIMARY KEY REFERENCES iam.tenants (tenant_id),
  last_hash  bytea NOT NULL
);
REVOKE ALL ON platform.audit_chain_heads FROM PUBLIC, hcos_app, hcos_provisioner;

CREATE OR REPLACE FUNCTION platform.audit_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$
DECLARE
  v_prev bytea;
BEGIN
  -- Khởi tạo đầu chuỗi (idempotent) rồi khoá dòng để tuần tự hoá ghi audit trong cùng tenant.
  INSERT INTO platform.audit_chain_heads (tenant_id, last_hash)
  VALUES (NEW.tenant_id, '\x00'::bytea)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT last_hash INTO v_prev
  FROM platform.audit_chain_heads
  WHERE tenant_id = NEW.tenant_id
  FOR UPDATE;

  NEW.prev_hash := v_prev;
  NEW.event_hash := sha256(
    convert_to(
      concat_ws('|',
        NEW.event_id::text,
        NEW.tenant_id::text,
        to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        NEW.actor_type, NEW.actor_id, COALESCE(NEW.organization_id::text, ''),
        NEW.action, NEW.resource_type, COALESCE(NEW.resource_id, ''),
        COALESCE(NEW.person_id::text, ''), COALESCE(NEW.patient_id::text, ''),
        NEW.outcome, NEW.correlation_id, NEW.payload::text
      ), 'UTF8')
    || v_prev
  );

  UPDATE platform.audit_chain_heads SET last_hash = NEW.event_hash WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_events_hash_chain
  BEFORE INSERT ON platform.audit_events
  FOR EACH ROW EXECUTE FUNCTION platform.audit_events_before_insert();

CREATE OR REPLACE FUNCTION platform.audit_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform.audit_events is append-only (% blocked)', TG_OP
    USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON platform.audit_events
  FOR EACH ROW EXECUTE FUNCTION platform.audit_events_immutable();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON platform.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform.audit_events_immutable();

CREATE TABLE platform.outbox_events (
  outbox_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  aggregate_type text        NOT NULL,
  aggregate_id   text        NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  headers        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed', 'dead')),
  attempts       integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_tenant_outbox_uk UNIQUE (tenant_id, outbox_id)
);
CREATE INDEX outbox_pending_idx ON platform.outbox_events (available_at) WHERE status IN ('pending', 'failed');
CREATE INDEX outbox_tenant_agg_idx ON platform.outbox_events (tenant_id, aggregate_type, aggregate_id);

-- ---------------------------------------------------------------------------
-- 5. Version/tenant guard triggers cho mọi bảng có thể UPDATE
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'iam.tenants', 'iam.organizations', 'iam.users', 'iam.memberships',
    'patient.persons', 'patient.patients', 'patient.identifiers',
    'platform.outbox_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version()',
      replace(t, '.', '_') || '_guard_version', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Row-Level Security (fail-closed) + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'iam.tenants', 'iam.organizations', 'iam.users', 'iam.memberships',
    'patient.persons', 'patient.patients', 'patient.identifiers',
    'platform.audit_events', 'platform.outbox_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO hcos_app
         USING (tenant_id = platform.current_tenant_id())
         WITH CHECK (tenant_id = platform.current_tenant_id())', t);
  END LOOP;
END
$$;

-- Provisioner được tạo/đọc tenant mới (chưa có tenant context). Chỉ trên bảng tenants.
CREATE POLICY provisioner_all ON iam.tenants TO hcos_provisioner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON iam.tenants TO hcos_provisioner;
GRANT SELECT                 ON iam.tenants TO hcos_app;
GRANT SELECT, INSERT, UPDATE ON iam.organizations, iam.users, iam.memberships,
                                patient.persons, patient.patients, patient.identifiers,
                                platform.outbox_events TO hcos_app;
-- Audit: chỉ INSERT + SELECT. Không cấp UPDATE/DELETE/TRUNCATE.
GRANT SELECT, INSERT ON platform.audit_events TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_events FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
