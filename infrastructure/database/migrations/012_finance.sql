-- HCOS-F8 — Thu ngân giai đoạn 1 (phòng khám dịch vụ, người bệnh tự trả): bảng giá, hồ sơ thanh toán,
-- chi phí, phiếu thu tạm ứng / thanh toán / phiếu chi hoàn ứng, ca thu ngân có kiểm két.
-- Chưa có BHYT và hoá đơn điện tử (phiếu ở đây là phiếu thu / chi nội bộ).
--
-- Bất biến ở tầng DB:
--  1. Tiền là số nguyên VND (bigint), luôn > 0 trên phiếu; chi phí = số lượng × đơn giá chụp lại lúc ghi (đổi bảng giá
--     không làm đổi chi phí đã ghi).
--  2. Phiếu và chi phí BẤT BIẾN; chỉ được huỷ (phiếu) / gỡ (chi phí) MỘT lần, kèm lý do, khi hồ sơ còn mở.
--     Phiếu chỉ huỷ được khi ca của nó còn mở.
--  3. Phiếu chỉ lập được trong ca ĐANG MỞ của chính người lập, cùng cơ sở; hồ sơ phải đang mở.
--  4. Số phiếu liên tục theo (cơ sở, loại PT/PC, năm), cấp nguyên tử qua bảng đếm; phiếu huỷ vẫn giữ số (không có lỗ).
--  5. Mỗi bệnh nhân một hồ sơ thanh toán đang mở mỗi cơ sở. Tổng hoàn ứng không vượt tổng đã thu.
--     Đóng hồ sơ chỉ khi số dư = 0 (đã thu − đã hoàn − chi phí); kiểm ở cuối transaction.
--  6. Đóng ca: DB tự tính tiền mặt phải có = tiền đầu ca + thu tiền mặt − chi tiền mặt (phiếu hợp lệ của ca),
--     chênh lệch = tiền đếm thực tế − phải có. Ca đã đóng bất biến.
--  7. Không DELETE / TRUNCATE; RLS FORCE theo tenant.
BEGIN;

CREATE SCHEMA IF NOT EXISTS finance;
GRANT USAGE ON SCHEMA finance TO hcos_app;

-- Năm theo giờ Việt Nam (đánh số phiếu).
CREATE FUNCTION finance.vn_year() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT extract(year FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh'))::integer
$$;

-- ---------------------------------------------------------------------------
-- 1. Cài đặt thu ngân theo cơ sở
-- ---------------------------------------------------------------------------
CREATE TABLE finance.settings (
  tenant_id          uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id    uuid        NOT NULL,
  deposit_default    bigint      NOT NULL DEFAULT 500000 CHECK (deposit_default BETWEEN 0 AND 100000000),
  -- Tài khoản nhận chuyển khoản (VietQR). Cả ba cùng có hoặc cùng trống.
  bank_bin           text        CHECK (bank_bin ~ '^[0-9]{6}$'),
  bank_account       text        CHECK (bank_account ~ '^[0-9A-Za-z]{4,19}$'),
  bank_account_name  text        CHECK (bank_account_name ~ '^[A-Z0-9 ]{2,50}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, organization_id),
  CONSTRAINT settings_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT settings_bank_all_or_none CHECK ((bank_bin IS NULL) = (bank_account IS NULL) AND (bank_bin IS NULL) = (bank_account_name IS NULL))
);
CREATE TRIGGER settings_version BEFORE UPDATE ON finance.settings FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 2. Bảng giá dịch vụ
-- ---------------------------------------------------------------------------
CREATE TABLE finance.price_items (
  item_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{1,19}$'),
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  category         text        NOT NULL CHECK (category IN ('exam', 'procedure', 'lab', 'imaging', 'drug', 'other')),
  unit_price       bigint      NOT NULL CHECK (unit_price BETWEEN 0 AND 1000000000),
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (item_id),
  CONSTRAINT price_items_tenant_org_uk UNIQUE (tenant_id, item_id, organization_id),
  CONSTRAINT price_items_code_uk UNIQUE (tenant_id, organization_id, code),
  CONSTRAINT price_items_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);
CREATE FUNCTION finance.price_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id, NEW.code, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.code, OLD.created_at) THEN
    RAISE EXCEPTION 'price item organization/code are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER price_items_a_guard   BEFORE UPDATE ON finance.price_items FOR EACH ROW EXECUTE FUNCTION finance.price_items_guard();
CREATE TRIGGER price_items_b_version BEFORE UPDATE ON finance.price_items FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 3. Ca thu ngân
-- ---------------------------------------------------------------------------
CREATE TABLE finance.cashier_shifts (
  shift_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_float    bigint      NOT NULL CHECK (opening_float BETWEEN 0 AND 1000000000),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  counted_cash     bigint      CHECK (counted_cash BETWEEN 0 AND 100000000000),
  expected_cash    bigint,
  cash_difference  bigint      GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  close_note       text        CHECK (length(close_note) <= 500),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (shift_id),
  CONSTRAINT shifts_tenant_org_uk UNIQUE (tenant_id, shift_id, organization_id),
  CONSTRAINT shifts_org_fk  FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id),
  CONSTRAINT shifts_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT shifts_closed_ck CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL)),
  CONSTRAINT shifts_open_ck   CHECK (status <> 'open' OR (closed_at IS NULL AND counted_cash IS NULL AND expected_cash IS NULL))
);
CREATE UNIQUE INDEX shifts_one_open_per_user_uk ON finance.cashier_shifts (tenant_id, organization_id, user_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 4. Hồ sơ thanh toán (một lượt khám / một lần đến)
-- ---------------------------------------------------------------------------
CREATE TABLE finance.billing_cases (
  case_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by        uuid        NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_by        uuid,
  closed_at        timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (case_id),
  CONSTRAINT cases_tenant_org_uk UNIQUE (tenant_id, case_id, organization_id),
  CONSTRAINT cases_patient_fk FOREIGN KEY (tenant_id, patient_id, organization_id)
    REFERENCES patient.patients (tenant_id, patient_id, organization_id),
  CONSTRAINT cases_opened_by_fk FOREIGN KEY (tenant_id, opened_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT cases_closed_by_fk FOREIGN KEY (tenant_id, closed_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT cases_closed_ck CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE UNIQUE INDEX cases_one_open_per_patient_uk ON finance.billing_cases (tenant_id, organization_id, patient_id) WHERE status = 'open';
CREATE INDEX cases_open_idx ON finance.billing_cases (tenant_id, organization_id, opened_at) WHERE status = 'open';

CREATE FUNCTION finance.billing_cases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id, NEW.patient_id, NEW.opened_by, NEW.opened_at) IS DISTINCT FROM (OLD.organization_id, OLD.patient_id, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'billing case identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'billing case is closed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cases_a_guard   BEFORE UPDATE ON finance.billing_cases FOR EACH ROW EXECUTE FUNCTION finance.billing_cases_guard();
CREATE TRIGGER cases_b_version BEFORE UPDATE ON finance.billing_cases FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- Khoá hồ sơ (FOR SHARE) và yêu cầu đang mở: chặn ghi chi phí / phiếu vào hồ sơ đang được đóng đồng thời.
CREATE FUNCTION finance.require_open_case(p_tenant uuid, p_case uuid, p_org uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM finance.billing_cases
   WHERE tenant_id = p_tenant AND case_id = p_case AND organization_id = p_org FOR SHARE;
  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'billing case % is not open', p_case USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Chi phí
-- ---------------------------------------------------------------------------
CREATE TABLE finance.charges (
  charge_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  case_id          uuid        NOT NULL,
  item_id          uuid        NOT NULL,
  item_code        text        NOT NULL,
  description      text        NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 200),
  quantity         integer     NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price       bigint      NOT NULL CHECK (unit_price BETWEEN 0 AND 1000000000),
  amount           bigint      GENERATED ALWAYS AS (quantity::bigint * unit_price) STORED,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  created_by       uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_by        uuid,
  voided_at        timestamptz,
  void_reason      text        CHECK (length(btrim(void_reason)) BETWEEN 3 AND 300),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (charge_id),
  CONSTRAINT charges_case_fk FOREIGN KEY (tenant_id, case_id, organization_id) REFERENCES finance.billing_cases (tenant_id, case_id, organization_id),
  CONSTRAINT charges_item_fk FOREIGN KEY (tenant_id, item_id, organization_id) REFERENCES finance.price_items (tenant_id, item_id, organization_id),
  CONSTRAINT charges_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT charges_voided_by_fk FOREIGN KEY (tenant_id, voided_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT charges_voided_ck CHECK ((status = 'voided') = (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX charges_case_idx ON finance.charges (tenant_id, case_id);

CREATE FUNCTION finance.charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'charge must be created active' USING ERRCODE = '55000';
    END IF;
    PERFORM finance.require_open_case(NEW.tenant_id, NEW.case_id, NEW.organization_id);
    RETURN NEW;
  END IF;
  -- amount là cột GENERATED (NULL trong BEFORE trigger) nên không so sánh.
  IF (NEW.organization_id, NEW.case_id, NEW.item_id, NEW.item_code, NEW.description, NEW.quantity, NEW.unit_price, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.case_id, OLD.item_id, OLD.item_code, OLD.description, OLD.quantity, OLD.unit_price, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'charge content is immutable' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'voided') THEN
    RAISE EXCEPTION 'charge can only be voided once' USING ERRCODE = '55000';
  END IF;
  PERFORM finance.require_open_case(NEW.tenant_id, NEW.case_id, NEW.organization_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER charges_a_guard   BEFORE INSERT OR UPDATE ON finance.charges FOR EACH ROW EXECUTE FUNCTION finance.charges_guard();
CREATE TRIGGER charges_b_version BEFORE UPDATE ON finance.charges FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 6. Phiếu thu (PT: tạm ứng, thanh toán) / phiếu chi (PC: hoàn ứng)
-- ---------------------------------------------------------------------------
CREATE TABLE finance.receipt_counters (
  tenant_id        uuid    NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid    NOT NULL,
  series           text    NOT NULL CHECK (series IN ('PT', 'PC')),
  year             integer NOT NULL CHECK (year BETWEEN 2020 AND 2200),
  last_no          integer NOT NULL CHECK (last_no BETWEEN 1 AND 999999),
  PRIMARY KEY (tenant_id, organization_id, series, year),
  CONSTRAINT receipt_counters_org_fk FOREIGN KEY (tenant_id, organization_id) REFERENCES iam.organizations (tenant_id, organization_id)
);

CREATE TABLE finance.receipts (
  receipt_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES iam.tenants (tenant_id),
  organization_id  uuid        NOT NULL,
  case_id          uuid        NOT NULL,
  shift_id         uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('deposit', 'payment', 'refund')),
  series           text        NOT NULL CHECK (series IN ('PT', 'PC')),
  year             integer     NOT NULL,
  seq              integer     NOT NULL CHECK (seq BETWEEN 1 AND 999999),
  receipt_no       text        GENERATED ALWAYS AS (series || year::text || '-' || lpad(seq::text, 6, '0')) STORED,
  method           text        NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'card')),
  amount           bigint      NOT NULL CHECK (amount BETWEEN 1 AND 10000000000),
  reference        text        CHECK (length(btrim(reference)) BETWEEN 4 AND 100),
  payer_name       text        CHECK (length(btrim(payer_name)) BETWEEN 2 AND 200),
  status           text        NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'cancelled')),
  created_by       uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_by     uuid,
  cancelled_at     timestamptz,
  cancel_reason    text        CHECK (length(btrim(cancel_reason)) BETWEEN 5 AND 300),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (receipt_id),
  CONSTRAINT receipts_no_uk UNIQUE (tenant_id, organization_id, series, year, seq),
  CONSTRAINT receipts_case_fk  FOREIGN KEY (tenant_id, case_id, organization_id) REFERENCES finance.billing_cases (tenant_id, case_id, organization_id),
  CONSTRAINT receipts_shift_fk FOREIGN KEY (tenant_id, shift_id, organization_id) REFERENCES finance.cashier_shifts (tenant_id, shift_id, organization_id),
  CONSTRAINT receipts_created_by_fk   FOREIGN KEY (tenant_id, created_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT receipts_cancelled_by_fk FOREIGN KEY (tenant_id, cancelled_by) REFERENCES iam.users (tenant_id, user_id),
  CONSTRAINT receipts_series_ck CHECK ((kind = 'refund') = (series = 'PC')),
  -- Chuyển khoản / thẻ phải có mã tham chiếu (nội dung chuyển khoản, mã chuẩn chi POS) để đối soát.
  CONSTRAINT receipts_reference_ck CHECK (method = 'cash' OR reference IS NOT NULL),
  CONSTRAINT receipts_cancelled_ck CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX receipts_case_idx  ON finance.receipts (tenant_id, case_id);
CREATE INDEX receipts_shift_idx ON finance.receipts (tenant_id, shift_id);

CREATE FUNCTION finance.require_own_open_shift(p_tenant uuid, p_shift uuid, p_org uuid, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_user   uuid;
BEGIN
  SELECT status, user_id INTO v_status, v_user FROM finance.cashier_shifts
   WHERE tenant_id = p_tenant AND shift_id = p_shift AND organization_id = p_org FOR SHARE;
  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'cashier shift % is not open', p_shift USING ERRCODE = '55000';
  END IF;
  IF v_user IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'receipt must be made in the cashier''s own shift' USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE FUNCTION finance.receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'valid' THEN
      RAISE EXCEPTION 'receipt must be created valid' USING ERRCODE = '55000';
    END IF;
    PERFORM finance.require_own_open_shift(NEW.tenant_id, NEW.shift_id, NEW.organization_id, NEW.created_by);
    PERFORM finance.require_open_case(NEW.tenant_id, NEW.case_id, NEW.organization_id);
    RETURN NEW;
  END IF;
  -- receipt_no là cột GENERATED (NULL trong BEFORE trigger) nên không so sánh.
  IF (NEW.organization_id, NEW.case_id, NEW.shift_id, NEW.kind, NEW.series, NEW.year, NEW.seq, NEW.method, NEW.amount, NEW.reference,
      NEW.payer_name, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.case_id, OLD.shift_id, OLD.kind, OLD.series, OLD.year, OLD.seq, OLD.method, OLD.amount, OLD.reference,
      OLD.payer_name, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'receipt content is immutable' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = 'valid' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'receipt can only be cancelled once' USING ERRCODE = '55000';
  END IF;
  -- Huỷ phiếu: chỉ trong ca còn mở (của người lập phiếu), hồ sơ còn mở.
  PERFORM finance.require_own_open_shift(NEW.tenant_id, NEW.shift_id, NEW.organization_id, NEW.cancelled_by);
  PERFORM finance.require_open_case(NEW.tenant_id, NEW.case_id, NEW.organization_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER receipts_a_guard   BEFORE INSERT OR UPDATE ON finance.receipts FOR EACH ROW EXECUTE FUNCTION finance.receipts_guard();
CREATE TRIGGER receipts_b_version BEFORE UPDATE ON finance.receipts FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 7. Ràng buộc số dư (kiểm ở cuối transaction)
-- ---------------------------------------------------------------------------
CREATE FUNCTION finance.assert_case(p_tenant uuid, p_case uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status   text;
  v_in       bigint;
  v_out      bigint;
  v_charges  bigint;
BEGIN
  SELECT status INTO v_status FROM finance.billing_cases WHERE tenant_id = p_tenant AND case_id = p_case;
  SELECT COALESCE(sum(amount) FILTER (WHERE kind <> 'refund'), 0), COALESCE(sum(amount) FILTER (WHERE kind = 'refund'), 0)
    INTO v_in, v_out
    FROM finance.receipts WHERE tenant_id = p_tenant AND case_id = p_case AND status = 'valid';
  SELECT COALESCE(sum(amount), 0) INTO v_charges FROM finance.charges WHERE tenant_id = p_tenant AND case_id = p_case AND status = 'active';
  IF v_out > v_in THEN
    RAISE EXCEPTION 'refunds (%) exceed money received (%) for case %', v_out, v_in, p_case USING ERRCODE = '23514';
  END IF;
  IF v_status = 'closed' AND v_in - v_out - v_charges <> 0 THEN
    RAISE EXCEPTION 'case % closed with non-zero balance %', p_case, v_in - v_out - v_charges USING ERRCODE = '23514';
  END IF;
END
$$;
CREATE FUNCTION finance.assert_case_t() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM finance.assert_case(NEW.tenant_id, NEW.case_id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER receipts_case_ct AFTER INSERT OR UPDATE ON finance.receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.assert_case_t();
CREATE CONSTRAINT TRIGGER charges_case_ct AFTER INSERT OR UPDATE ON finance.charges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.assert_case_t();
CREATE CONSTRAINT TRIGGER cases_balance_ct AFTER UPDATE ON finance.billing_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.assert_case_t();

-- ---------------------------------------------------------------------------
-- 8. Đóng ca: DB tự tính tiền mặt phải có
-- ---------------------------------------------------------------------------
CREATE FUNCTION finance.shifts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'shift must be created open' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- cash_difference là cột GENERATED (NULL trong BEFORE trigger) nên không so sánh.
  IF (NEW.organization_id, NEW.user_id, NEW.opening_float, NEW.opened_at) IS DISTINCT FROM (OLD.organization_id, OLD.user_id, OLD.opening_float, OLD.opened_at) THEN
    RAISE EXCEPTION 'shift identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'shift is closed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'closed' THEN
    NEW.closed_at := now();
    -- Không tin số app gửi lên: tính lại từ phiếu hợp lệ của ca (truy vấn mới thấy cả phiếu vừa commit ở giao dịch khác).
    SELECT NEW.opening_float
         + COALESCE(sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0)
      INTO NEW.expected_cash
      FROM finance.receipts
     WHERE tenant_id = NEW.tenant_id AND shift_id = NEW.shift_id AND status = 'valid' AND method = 'cash';
  ELSIF NEW.expected_cash IS DISTINCT FROM OLD.expected_cash OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash THEN
    RAISE EXCEPTION 'cash count is recorded only when closing the shift' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shifts_a_guard   BEFORE INSERT OR UPDATE ON finance.cashier_shifts FOR EACH ROW EXECUTE FUNCTION finance.shifts_guard();
CREATE TRIGGER shifts_b_version BEFORE UPDATE ON finance.cashier_shifts FOR EACH ROW EXECUTE FUNCTION platform.guard_and_bump_version();

-- ---------------------------------------------------------------------------
-- 9. Không xoá; RLS fail-closed; quyền
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance.settings', 'finance.price_items', 'finance.cashier_shifts', 'finance.billing_cases', 'finance.charges',
                           'finance.receipt_counters', 'finance.receipts']
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

GRANT SELECT, INSERT, UPDATE ON finance.settings, finance.price_items, finance.cashier_shifts, finance.billing_cases, finance.charges,
  finance.receipt_counters, finance.receipts TO hcos_app;
REVOKE DELETE, TRUNCATE ON finance.settings, finance.price_items, finance.cashier_shifts, finance.billing_cases, finance.charges,
  finance.receipt_counters, finance.receipts FROM PUBLIC, hcos_app, hcos_provisioner;
GRANT EXECUTE ON FUNCTION finance.vn_year() TO hcos_app;

COMMIT;
