-- STAGING ONLY — dữ liệu giả. Chạy bằng superuser (postgres) trên DB hcos. Idempotent.
-- external_subject = `sub` của Keycloak (user id cố định trong hcos-realm.json).
BEGIN;
INSERT INTO iam.tenants (tenant_id, code, name, status)
VALUES ('00000000-0000-4000-8000-0000000000a1', 'staging-demo', 'Staging Demo Tenant', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO iam.organizations (organization_id, tenant_id, type, code, name)
VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'clinic', 'demo-clinic', 'Phòng khám Demo')
ON CONFLICT DO NOTHING;

INSERT INTO iam.users (user_id, tenant_id, external_subject, email, display_name) VALUES
 ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', 'bacsi.demo@example.invalid',   'Bác sĩ Demo'),
 ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c2', 'dieuduong.demo@example.invalid','Điều dưỡng Demo'),
 ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c3', 'quantri.demo@example.invalid',  'Quản trị Demo')
ON CONFLICT DO NOTHING;

INSERT INTO iam.memberships (tenant_id, user_id, organization_id, role) VALUES
 ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', 'doctor'),
 ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b1', 'clinic_staff'),
 ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000b1', 'clinic_admin')
ON CONFLICT DO NOTHING;
COMMIT;
