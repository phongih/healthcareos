-- HCOS-F15 — Hồ sơ tự đánh giá cấp độ rủi ro an ninh dữ liệu (Luật An ninh dữ liệu 2026).
--
-- Danh mục dữ liệu (nhãn cấp độ / nhóm / chủ quản / mục đích / thời hạn) nằm trong mã nguồn
-- (packages/security/src/data-catalog.ts) và được CI đối chiếu với CSDL sau mọi migration.
-- Bảng này lưu BẰNG CHỨNG mỗi lần chủ quản dữ liệu xác định cấp độ của hệ thống:
--  * cấp độ tính từ danh mục (cấp cao nhất phát sinh) và phiên bản danh mục (SHA-256) dùng để tính;
--  * cấp độ chủ quản xác định — KHÔNG được thấp hơn cấp tính được (luật cấm cố ý xác định cấp thấp hơn quy định);
--  * căn cứ, quy mô dữ liệu tại thời điểm đánh giá, người đánh giá, thời điểm.
-- Chỉ thêm: không sửa, không xoá; RLS FORCE theo tenant.
BEGIN;

CREATE SCHEMA IF NOT EXISTS governance;
GRANT USAGE ON SCHEMA governance TO hcos_app;

CREATE TABLE governance.risk_assessments (
  assessment_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  catalog_version  text        NOT NULL CHECK (catalog_version ~ '^[0-9a-f]{64}$'),
  computed_level   smallint    NOT NULL CHECK (computed_level BETWEEN 1 AND 5),
  declared_level   smallint    NOT NULL CHECK (declared_level BETWEEN 1 AND 5),
  summary          jsonb       NOT NULL,
  rationale        text        NOT NULL CHECK (length(rationale) BETWEEN 20 AND 4000),
  assessed_by      uuid        NOT NULL,
  assessed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id),
  CONSTRAINT risk_assessments_not_below_ck CHECK (declared_level >= computed_level),
  CONSTRAINT risk_assessments_user_fk FOREIGN KEY (tenant_id, assessed_by) REFERENCES iam.users (tenant_id, user_id)
);
CREATE INDEX risk_assessments_tenant_idx ON governance.risk_assessments (tenant_id, assessed_at DESC);

CREATE TRIGGER risk_assessments_no_update BEFORE UPDATE ON governance.risk_assessments FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER risk_assessments_no_delete BEFORE DELETE ON governance.risk_assessments FOR EACH ROW EXECUTE FUNCTION clinical.forbid_mutation();
CREATE TRIGGER risk_assessments_no_truncate BEFORE TRUNCATE ON governance.risk_assessments FOR EACH STATEMENT EXECUTE FUNCTION clinical.forbid_mutation();

ALTER TABLE governance.risk_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.risk_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance.risk_assessments TO hcos_app
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT ON governance.risk_assessments TO hcos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON governance.risk_assessments FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
