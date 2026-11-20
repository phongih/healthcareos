-- =============================================================================
-- HCOS-P0-ENG-001 | Platform | Migration 008: khoá idempotency cho thao tác ghi không được lặp (nhập / cấp phát kho)
-- Phụ thuộc: 001_s0_init.sql (iam.users, platform.*), 007_access_policies.sql (iam.forbid_mutation)
--
-- Cách dùng (ứng dụng):
--  * Trong CÙNG transaction với thao tác: INSERT khoá ... ON CONFLICT DO NOTHING. Nếu một transaction khác đang giữ
--    cùng khoá, PostgreSQL chờ nó kết thúc: commit => xung đột (đọc lại kết quả đã lưu), rollback => chèn được.
--  * Làm việc, rồi UPDATE response trong cùng transaction. Thao tác lỗi => rollback => khoá biến mất => gửi lại sẽ chạy lại.
--  * Không gian khoá theo (tenant, người gọi, scope): người khác không đọc được kết quả bằng khoá của bạn.
--  * request_hash và response bất biến sau khi ghi; không DELETE (dọn dẹp theo hạn là việc vận hành, ngoài app).
-- =============================================================================

BEGIN;

CREATE TABLE platform.idempotency_keys (
  tenant_id      uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  actor_user_id  uuid        NOT NULL,
  scope          text        NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_.:]{2,63}$'),
  idem_key       text        NOT NULL CHECK (idem_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash   text        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  PRIMARY KEY (tenant_id, actor_user_id, scope, idem_key),
  CONSTRAINT idempotency_keys_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT idempotency_keys_completion CHECK ((response IS NULL) = (completed_at IS NULL))
);
CREATE INDEX idempotency_keys_created_idx ON platform.idempotency_keys (created_at);

CREATE OR REPLACE FUNCTION platform.guard_idempotency_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.idem_key IS DISTINCT FROM OLD.idem_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'idempotency key identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.response IS NOT NULL THEN
    RAISE EXCEPTION 'idempotency key % already completed', OLD.idem_key USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER idempotency_keys_guard
  BEFORE UPDATE ON platform.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION platform.guard_idempotency_key();
CREATE TRIGGER idempotency_keys_no_delete
  BEFORE DELETE ON platform.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION iam.forbid_mutation();
CREATE TRIGGER idempotency_keys_no_truncate
  BEFORE TRUNCATE ON platform.idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION iam.forbid_mutation();

ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.idempotency_keys TO hcos_app
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON platform.idempotency_keys TO hcos_app;
REVOKE DELETE, TRUNCATE ON platform.idempotency_keys FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
