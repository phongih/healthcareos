BEGIN;

-- 1. Khởi tạo schema Dược
CREATE SCHEMA IF NOT EXISTS pharmacy;

-- 2. Danh mục hoạt chất (ATC code / Generic)
CREATE TABLE pharmacy.substances (
    substance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_substances_tenant_code UNIQUE (tenant_id, code)
);

-- 3. Danh mục biệt dược / thuốc thương mại
CREATE TABLE pharmacy.medications (
    medication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    substance_id uuid REFERENCES pharmacy.substances(substance_id),
    brand_name text NOT NULL,
    generic_name text,
    strength text NOT NULL,
    form text NOT NULL,
    route text,
    unit_of_measure text NOT NULL,
    barcode text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Vị trí kho & quầy tủ trực
CREATE TABLE pharmacy.stock_locations (
    location_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL CHECK (type IN ('main_warehouse', 'dispensary_counter', 'ward_cabinet', 'quarantine')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Quản lý Lô & Hạn sử dụng (FEFO Core)
CREATE TABLE pharmacy.batches (
    batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    medication_id uuid NOT NULL REFERENCES pharmacy.medications(medication_id),
    batch_number text NOT NULL,
    manufacturing_date date,
    expiry_date date NOT NULL,
    unit_cost numeric(15, 4) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_batches_tenant_medication_batch UNIQUE (tenant_id, medication_id, batch_number)
);

CREATE INDEX idx_batches_fefo ON pharmacy.batches (tenant_id, medication_id, expiry_date ASC);

-- 6. Tồn kho khả dụng theo từng vị trí & từng lô
CREATE TABLE pharmacy.inventory_balances (
    balance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL REFERENCES pharmacy.stock_locations(location_id),
    batch_id uuid NOT NULL REFERENCES pharmacy.batches(batch_id),
    quantity_on_hand integer NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    quantity_reserved integer NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventory_location_batch UNIQUE (tenant_id, location_id, batch_id),
    CONSTRAINT chk_quantity_available CHECK (quantity_on_hand >= quantity_reserved)
);

-- 7. Sổ cái xuất nhập tồn bất biến (Immutable Stock Movements Ledger)
CREATE TABLE pharmacy.stock_movements (
    movement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_location_id uuid REFERENCES pharmacy.stock_locations(location_id),
    destination_location_id uuid REFERENCES pharmacy.stock_locations(location_id),
    batch_id uuid NOT NULL REFERENCES pharmacy.batches(batch_id),
    quantity integer NOT NULL CHECK (quantity > 0),
    movement_type text NOT NULL CHECK (movement_type IN ('receipt', 'transfer', 'dispense', 'adjustment', 'disposal')),
    encounter_id uuid REFERENCES clinical.encounters(encounter_id),
    reason text,
    performed_by uuid,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_movements_tenant_batch ON pharmacy.stock_movements (tenant_id, batch_id);
CREATE INDEX idx_stock_movements_encounter ON pharmacy.stock_movements (encounter_id) WHERE encounter_id IS NOT NULL;

-- 8. Thiết lập Row-Level Security (RLS) theo tenant_isolation
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'pharmacy.substances',
    'pharmacy.medications',
    'pharmacy.stock_locations',
    'pharmacy.batches',
    'pharmacy.inventory_balances',
    'pharmacy.stock_movements'
  ])
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

-- 9. Phân quyền Role hcos_app
GRANT USAGE ON SCHEMA pharmacy TO hcos_app;
GRANT SELECT, INSERT, UPDATE ON pharmacy.substances,
                                pharmacy.medications,
                                pharmacy.stock_locations,
                                pharmacy.batches,
                                pharmacy.inventory_balances TO hcos_app;

GRANT SELECT, INSERT ON pharmacy.stock_movements TO hcos_app;

REVOKE DELETE, TRUNCATE ON pharmacy.substances,
                           pharmacy.medications,
                           pharmacy.stock_locations,
                           pharmacy.batches,
                           pharmacy.inventory_balances,
                           pharmacy.stock_movements FROM PUBLIC, hcos_app, hcos_provisioner;

REVOKE UPDATE ON pharmacy.stock_movements FROM PUBLIC, hcos_app, hcos_provisioner;

COMMIT;
