/**
 * HCOS-P0-ENG-001 | Slice S3 | Pharmacy Inventory Service
 * Quản lý danh mục dược, nhập kho, tồn kho theo lô và thuật toán FEFO khi xuất thuốc.
 */
import { randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  type AuditSink,
  type CorrelationId,
  type ISODate,
  type ISODateTime,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import { type EncounterId } from '../../../../packages/domain/src/s1-contracts';
import {
  asBalanceId,
  asBatchId,
  asMedicationId,
  asStockLocationId,
  asStockMovementId,
  asSubstanceId,
  type Batch,
  type BatchId,
  type FefoAllocationItem,
  type FefoAllocationPlan,
  type InventoryBalance,
  type Medication,
  type MedicationId,
  type StockLocation,
  type StockLocationId,
  type StockMovement,
  type Substance,
} from '../../../../packages/domain/src/s3-pharmacy-contracts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export type PharmacyErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'INSUFFICIENT_STOCK'
  | 'EXPIRED_BATCH';

export class PharmacyError extends Error {
  constructor(
    public readonly code: PharmacyErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PharmacyError';
  }
}

// ---------------------------------------------------------------------------
// DTOs & Inputs
// ---------------------------------------------------------------------------
export interface CreateSubstanceInput {
  readonly code: string;
  readonly name: string;
}

export interface CreateMedicationInput {
  readonly substanceId?: string;
  readonly brandName: string;
  readonly genericName?: string;
  readonly strength: string;
  readonly form: string;
  readonly route?: string;
  readonly unitOfMeasure: string;
  readonly barcode?: string;
}

export interface CreateStockLocationInput {
  readonly organizationId: string;
  readonly name: string;
  readonly type: 'main_warehouse' | 'dispensary_counter' | 'ward_cabinet' | 'quarantine';
}

export interface ReceiveStockInput {
  readonly medicationId: string;
  readonly locationId: string;
  readonly batchNumber: string;
  readonly manufacturingDate?: ISODate;
  readonly expiryDate: ISODate;
  readonly unitCost: number;
  readonly quantity: number;
  readonly reason?: string;
}

export interface DispenseMedicationInput {
  readonly medicationId: string;
  readonly locationId: string;
  readonly quantity: number;
  readonly encounterId: string;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Repository Ports
// ---------------------------------------------------------------------------
export interface AvailableBatchBalance {
  readonly balanceId: string;
  readonly batchId: string;
  readonly batchNumber: string;
  readonly expiryDate: ISODate;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly version: number;
}

export interface PharmacyRepository {
  // Substances & Medications
  insertSubstance(s: Substance): Promise<void>;
  findSubstanceByCode(code: string): Promise<Substance | null>;
  insertMedication(m: Medication): Promise<void>;
  findMedication(id: MedicationId): Promise<Medication | null>;

  // Stock Locations
  insertStockLocation(loc: StockLocation): Promise<void>;
  findStockLocation(id: StockLocationId): Promise<StockLocation | null>;

  // Batches & Balances
  findBatch(medicationId: MedicationId, batchNumber: string): Promise<Batch | null>;
  insertBatch(b: Batch): Promise<void>;
  findBalance(locationId: StockLocationId, batchId: BatchId): Promise<InventoryBalance | null>;
  upsertBalance(balance: InventoryBalance): Promise<void>;

  // FEFO Allocation: Khóa dòng FOR UPDATE và trả về các lô còn hạn sử dụng xếp tăng dần theo expiry_date
  lockAvailableBatchesForFefo(
    locationId: StockLocationId,
    medicationId: MedicationId,
  ): Promise<AvailableBatchBalance[]>;

  updateBalanceQuantity(
    balanceId: string,
    quantityOnHand: number,
    expectedVersion: number,
  ): Promise<boolean>;

  // Movements Ledger
  insertStockMovement(m: StockMovement): Promise<void>;
  listStockMovementsByEncounter(encounterId: EncounterId): Promise<StockMovement[]>;
}

export interface PharmacyUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PharmacyRepository) => Promise<T>): Promise<T>;
}

export interface PharmacyServiceDeps {
  readonly uow: PharmacyUnitOfWork;
  readonly audit: AuditSink;
  readonly clock?: () => Date;
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------
export class PharmacyInventoryService {
  private readonly clock: () => Date;

  constructor(private readonly deps: PharmacyServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Đăng ký hoạt chất chuẩn */
  async createSubstance(input: CreateSubstanceInput, ctx: TenantContext): Promise<Substance> {
    const now = this.clock().toISOString() as ISODateTime;
    const substance: Substance = {
      tenantId: ctx.tenantId,
      substanceId: asSubstanceId(randomUUID()),
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.deps.uow.run(ctx, async (repo) => {
      const existing = await repo.findSubstanceByCode(substance.code);
      if (existing) {
        throw new PharmacyError('CONFLICT', `Substance with code ${substance.code} already exists`);
      }
      await repo.insertSubstance(substance);
    });

    return substance;
  }

  /** Đăng ký biệt dược thương mại */
  async createMedication(input: CreateMedicationInput, ctx: TenantContext): Promise<Medication> {
    const now = this.clock().toISOString() as ISODateTime;
    const medication: Medication = {
      tenantId: ctx.tenantId,
      medicationId: asMedicationId(randomUUID()),
      substanceId: input.substanceId ? asSubstanceId(input.substanceId) : undefined,
      brandName: input.brandName.trim(),
      genericName: input.genericName?.trim(),
      strength: input.strength.trim(),
      form: input.form.trim(),
      route: input.route?.trim(),
      unitOfMeasure: input.unitOfMeasure.trim(),
      barcode: input.barcode?.trim(),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.deps.uow.run(ctx, async (repo) => {
      await repo.insertMedication(medication);
    });

    return medication;
  }

  /** Nhập kho theo lô (Receipt) */
  async receiveStock(input: ReceiveStockInput, ctx: TenantContext): Promise<{ batch: Batch; movement: StockMovement }> {
    if (input.quantity <= 0) {
      throw new PharmacyError('VALIDATION', 'Quantity received must be greater than zero');
    }

    const now = this.clock().toISOString() as ISODateTime;
    const medicationId = asMedicationId(input.medicationId);
    const locationId = asStockLocationId(input.locationId);

    return await this.deps.uow.run(ctx, async (repo) => {
      const med = await repo.findMedication(medicationId);
      if (!med) throw new PharmacyError('NOT_FOUND', `Medication ${input.medicationId} not found`);

      const loc = await repo.findStockLocation(locationId);
      if (!loc) throw new PharmacyError('NOT_FOUND', `Stock location ${input.locationId} not found`);

      // 1. Quản lý Batch
      let batch = await repo.findBatch(medicationId, input.batchNumber.trim());
      if (!batch) {
        batch = {
          tenantId: ctx.tenantId,
          batchId: asBatchId(randomUUID()),
          medicationId,
          batchNumber: input.batchNumber.trim(),
          manufacturingDate: input.manufacturingDate,
          expiryDate: input.expiryDate,
          unitCost: input.unitCost,
          createdAt: now,
          updatedAt: now,
        };
        await repo.insertBatch(batch);
      }

      // 2. Cập nhật tồn kho (Inventory Balance)
      const balance = await repo.findBalance(locationId, batch.batchId);
      if (balance) {
        const updatedBalance: InventoryBalance = {
          ...balance,
          quantityOnHand: balance.quantityOnHand + input.quantity,
          version: balance.version + 1,
          updatedAt: now,
        };
        await repo.upsertBalance(updatedBalance);
      } else {
        const newBalance: InventoryBalance = {
          tenantId: ctx.tenantId,
          balanceId: asBalanceId(randomUUID()),
          locationId,
          batchId: batch.batchId,
          quantityOnHand: input.quantity,
          quantityReserved: 0,
          version: 1,
          updatedAt: now,
        };
        await repo.upsertBalance(newBalance);
      }

      // 3. Ghi sổ cái xuất nhập tồn bất biến
      const movement: StockMovement = {
        tenantId: ctx.tenantId,
        movementId: asStockMovementId(randomUUID()),
        destinationLocationId: locationId,
        batchId: batch.batchId,
        quantity: input.quantity,
        movementType: 'receipt',
        reason: input.reason ?? 'Direct warehouse receipt',
        occurredAt: now,
      };
      await repo.insertStockMovement(movement);

      return { batch, movement };
    });
  }

  /**
   * Thuật toán FEFO (First-Expired, First-Out):
   * Tự động trừ kho các lô có hạn dùng gần nhất, đảm bảo tính nguyên tử chống Race Condition bằng khóa dòng.
   */
  async dispenseMedication(
    input: DispenseMedicationInput,
    ctx: TenantContext,
  ): Promise<FefoAllocationPlan> {
    if (input.quantity <= 0) {
      throw new PharmacyError('VALIDATION', 'Quantity to dispense must be greater than zero');
    }

    const now = this.clock().toISOString() as ISODateTime;
    const medicationId = asMedicationId(input.medicationId);
    const locationId = asStockLocationId(input.locationId);

    return await this.deps.uow.run(ctx, async (repo) => {
      const loc = await repo.findStockLocation(locationId);
      if (!loc) {
        throw new PharmacyError('NOT_FOUND', `Stock location ${input.locationId} not found`);
      }

      const med = await repo.findMedication(medicationId);
      if (!med) {
        throw new PharmacyError('NOT_FOUND', `Medication ${input.medicationId} not found`);
      }

      // Khóa dòng các bản ghi tồn kho khả dụng còn hạn dùng, sắp xếp tăng dần theo expiry_date
      const candidateBatches = await repo.lockAvailableBatchesForFefo(locationId, medicationId);

      const totalAvailable = candidateBatches.reduce(
        (sum, b) => sum + (b.quantityOnHand - b.quantityReserved),
        0,
      );

      if (totalAvailable < input.quantity) {
        throw new PharmacyError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock. Requested: ${input.quantity}, Available: ${totalAvailable}`,
          { requested: input.quantity, available: totalAvailable },
        );
      }

      let remainingToAllocate = input.quantity;
      const allocatedItems: FefoAllocationItem[] = [];

      for (const batch of candidateBatches) {
        if (remainingToAllocate <= 0) break;

        const availableInBatch = batch.quantityOnHand - batch.quantityReserved;
        if (availableInBatch <= 0) continue;

        const take = Math.min(availableInBatch, remainingToAllocate);
        const nextQtyOnHand = batch.quantityOnHand - take;

        // Cập nhật số dư với Optimistic Concurrency check (version)
        const updated = await repo.updateBalanceQuantity(batch.balanceId, nextQtyOnHand, batch.version);
        if (!updated) {
          throw new PharmacyError('CONFLICT', `Concurrency conflict updating balance for batch ${batch.batchNumber}`);
        }

        // Ghi sổ cái chuyển động
        const movement: StockMovement = {
          tenantId: ctx.tenantId,
          movementId: asStockMovementId(randomUUID()),
          sourceLocationId: locationId,
          batchId: asBatchId(batch.batchId),
          quantity: take,
          movementType: 'dispense',
          encounterId: input.encounterId as EncounterId,
          reason: input.reason ?? 'Prescription fulfillment',
          occurredAt: now,
        };
        await repo.insertStockMovement(movement);

        allocatedItems.push({
          batchId: asBatchId(batch.batchId),
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          allocatedQuantity: take,
        });

        remainingToAllocate -= take;
      }

      return {
        medicationId,
        requestedQuantity: input.quantity,
        allocatedTotal: input.quantity - remainingToAllocate,
        items: allocatedItems,
        isFullyAllocated: remainingToAllocate === 0,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL Implementation
// ---------------------------------------------------------------------------
import {
  withTenantTransaction,
  type PgPoolLike,
} from '../../../../packages/security/src/tenant-context';

export interface PgClientLike {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export class PgPharmacyRepository implements PharmacyRepository {
  constructor(private readonly db: PgClientLike) {}

  async insertSubstance(s: Substance): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.substances (substance_id, tenant_id, code, name, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [s.substanceId, s.tenantId, s.code, s.name, s.isActive, s.createdAt, s.updatedAt],
    );
  }

  async findSubstanceByCode(code: string): Promise<Substance | null> {
    const res = await this.db.query<{
      substance_id: string;
      tenant_id: string;
      code: string;
      name: string;
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT substance_id, tenant_id, code, name, is_active, created_at, updated_at
       FROM pharmacy.substances
       WHERE code = $1`,
      [code],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      substanceId: asSubstanceId(row.substance_id),
      tenantId: row.tenant_id as Substance['tenantId'],
      code: row.code,
      name: row.name,
      isActive: row.is_active,
      createdAt: row.created_at as ISODateTime,
      updatedAt: row.updated_at as ISODateTime,
    };
  }

  async insertMedication(m: Medication): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.medications (
         medication_id, tenant_id, substance_id, brand_name, generic_name,
         strength, form, route, unit_of_measure, barcode, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        m.medicationId, m.tenantId, m.substanceId ?? null, m.brandName, m.genericName ?? null,
        m.strength, m.form, m.route ?? null, m.unitOfMeasure, m.barcode ?? null,
        m.isActive, m.createdAt, m.updatedAt,
      ],
    );
  }

  async findMedication(id: MedicationId): Promise<Medication | null> {
    const res = await this.db.query<{
      medication_id: string;
      tenant_id: string;
      substance_id: string | null;
      brand_name: string;
      generic_name: string | null;
      strength: string;
      form: string;
      route: string | null;
      unit_of_measure: string;
      barcode: string | null;
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT medication_id, tenant_id, substance_id, brand_name, generic_name,
              strength, form, route, unit_of_measure, barcode, is_active, created_at, updated_at
       FROM pharmacy.medications
       WHERE medication_id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      medicationId: asMedicationId(row.medication_id),
      tenantId: row.tenant_id as Medication['tenantId'],
      substanceId: row.substance_id ? asSubstanceId(row.substance_id) : undefined,
      brandName: row.brand_name,
      genericName: row.generic_name ?? undefined,
      strength: row.strength,
      form: row.form,
      route: row.route ?? undefined,
      unitOfMeasure: row.unit_of_measure,
      barcode: row.barcode ?? undefined,
      isActive: row.is_active,
      createdAt: row.created_at as ISODateTime,
      updatedAt: row.updated_at as ISODateTime,
    };
  }

  async insertStockLocation(loc: StockLocation): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.stock_locations (location_id, tenant_id, organization_id, name, type, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [loc.locationId, loc.tenantId, loc.organizationId, loc.name, loc.type, loc.isActive, loc.createdAt, loc.updatedAt],
    );
  }

  async findStockLocation(id: StockLocationId): Promise<StockLocation | null> {
    const res = await this.db.query<{
      location_id: string;
      tenant_id: string;
      organization_id: string;
      name: string;
      type: StockLocation['type'];
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT location_id, tenant_id, organization_id, name, type, is_active, created_at, updated_at
       FROM pharmacy.stock_locations
       WHERE location_id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      locationId: asStockLocationId(row.location_id),
      tenantId: row.tenant_id as StockLocation['tenantId'],
      organizationId: row.organization_id as StockLocation['organizationId'],
      name: row.name,
      type: row.type,
      isActive: row.is_active,
      createdAt: row.created_at as ISODateTime,
      updatedAt: row.updated_at as ISODateTime,
    };
  }

  async findBatch(medicationId: MedicationId, batchNumber: string): Promise<Batch | null> {
    const res = await this.db.query<{
      batch_id: string;
      tenant_id: string;
      medication_id: string;
      batch_number: string;
      manufacturing_date: string | null;
      expiry_date: string;
      unit_cost: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT batch_id, tenant_id, medication_id, batch_number, manufacturing_date, expiry_date, unit_cost, created_at, updated_at
       FROM pharmacy.batches
       WHERE medication_id = $1 AND batch_number = $2`,
      [medicationId, batchNumber],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      batchId: asBatchId(row.batch_id),
      tenantId: row.tenant_id as Batch['tenantId'],
      medicationId: asMedicationId(row.medication_id),
      batchNumber: row.batch_number,
      manufacturingDate: (row.manufacturing_date ?? undefined) as ISODate | undefined,
      expiryDate: row.expiry_date as ISODate,
      unitCost: Number(row.unit_cost),
      createdAt: row.created_at as ISODateTime,
      updatedAt: row.updated_at as ISODateTime,
    };
  }

  async insertBatch(b: Batch): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.batches (
         batch_id, tenant_id, medication_id, batch_number, manufacturing_date, expiry_date, unit_cost, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        b.batchId, b.tenantId, b.medicationId, b.batchNumber,
        b.manufacturingDate ?? null, b.expiryDate, b.unitCost,
        b.createdAt, b.updatedAt,
      ],
    );
  }

  async findBalance(locationId: StockLocationId, batchId: BatchId): Promise<InventoryBalance | null> {
    const res = await this.db.query<{
      balance_id: string;
      tenant_id: string;
      location_id: string;
      batch_id: string;
      quantity_on_hand: number;
      quantity_reserved: number;
      version: number;
      updated_at: string;
    }>(
      `SELECT balance_id, tenant_id, location_id, batch_id, quantity_on_hand, quantity_reserved, version, updated_at
       FROM pharmacy.inventory_balances
       WHERE location_id = $1 AND batch_id = $2`,
      [locationId, batchId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      balanceId: asBalanceId(row.balance_id),
      tenantId: row.tenant_id as InventoryBalance['tenantId'],
      locationId: asStockLocationId(row.location_id),
      batchId: asBatchId(row.batch_id),
      quantityOnHand: Number(row.quantity_on_hand),
      quantityReserved: Number(row.quantity_reserved),
      version: Number(row.version),
      updatedAt: row.updated_at as ISODateTime,
    };
  }

  async upsertBalance(b: InventoryBalance): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.inventory_balances (
         balance_id, tenant_id, location_id, batch_id, quantity_on_hand, quantity_reserved, version, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, location_id, batch_id) DO UPDATE SET
         quantity_on_hand = EXCLUDED.quantity_on_hand,
         quantity_reserved = EXCLUDED.quantity_reserved,
         version = pharmacy.inventory_balances.version + 1,
         updated_at = EXCLUDED.updated_at`,
      [b.balanceId, b.tenantId, b.locationId, b.batchId, b.quantityOnHand, b.quantityReserved, b.version, b.updatedAt],
    );
  }

  async lockAvailableBatchesForFefo(
    locationId: StockLocationId,
    medicationId: MedicationId,
  ): Promise<AvailableBatchBalance[]> {
    const res = await this.db.query<{
      balance_id: string;
      batch_id: string;
      batch_number: string;
      expiry_date: string;
      quantity_on_hand: number;
      quantity_reserved: number;
      version: number;
    }>(
      `SELECT b.balance_id, b.batch_id, bt.batch_number, bt.expiry_date,
              b.quantity_on_hand, b.quantity_reserved, b.version
       FROM pharmacy.inventory_balances b
       JOIN pharmacy.batches bt ON bt.batch_id = b.batch_id
       WHERE b.location_id = $1
         AND bt.medication_id = $2
         AND bt.expiry_date > CURRENT_DATE
         AND (b.quantity_on_hand - b.quantity_reserved) > 0
       ORDER BY bt.expiry_date ASC
       FOR UPDATE OF b`,
      [locationId, medicationId],
    );

    return res.rows.map((r) => ({
      balanceId: r.balance_id,
      batchId: r.batch_id,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date as ISODate,
      quantityOnHand: Number(r.quantity_on_hand),
      quantityReserved: Number(r.quantity_reserved),
      version: Number(r.version),
    }));
  }

  async updateBalanceQuantity(
    balanceId: string,
    quantityOnHand: number,
    expectedVersion: number,
  ): Promise<boolean> {
    const res = await this.db.query<{ balance_id: string }>(
      `UPDATE pharmacy.inventory_balances
       SET quantity_on_hand = $1,
           version = version + 1,
           updated_at = now()
       WHERE balance_id = $2 AND version = $3
       RETURNING balance_id`,
      [quantityOnHand, balanceId, expectedVersion],
    );
    return (res.rows && res.rows.length > 0) || ((res as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
  }

  async insertStockMovement(m: StockMovement): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.stock_movements (
         movement_id, tenant_id, source_location_id, destination_location_id,
         batch_id, quantity, movement_type, encounter_id, reason, performed_by, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        m.movementId, m.tenantId, m.sourceLocationId ?? null, m.destinationLocationId ?? null,
        m.batchId, m.quantity, m.movementType, m.encounterId ?? null,
        m.reason ?? null, m.performedBy ?? null, m.occurredAt,
      ],
    );
  }

  async listStockMovementsByEncounter(encounterId: EncounterId): Promise<StockMovement[]> {
    const res = await this.db.query<{
      movement_id: string;
      tenant_id: string;
      source_location_id: string | null;
      destination_location_id: string | null;
      batch_id: string;
      quantity: number;
      movement_type: StockMovement['movementType'];
      encounter_id: string | null;
      reason: string | null;
      performed_by: string | null;
      occurred_at: string;
    }>(
      `SELECT movement_id, tenant_id, source_location_id, destination_location_id,
              batch_id, quantity, movement_type, encounter_id, reason, performed_by, occurred_at
       FROM pharmacy.stock_movements
       WHERE encounter_id = $1
       ORDER BY occurred_at ASC`,
      [encounterId],
    );

    return res.rows.map((r) => ({
      movementId: asStockMovementId(r.movement_id),
      tenantId: r.tenant_id as StockMovement['tenantId'],
      sourceLocationId: r.source_location_id ? asStockLocationId(r.source_location_id) : undefined,
      destinationLocationId: r.destination_location_id ? asStockLocationId(r.destination_location_id) : undefined,
      batchId: asBatchId(r.batch_id),
      quantity: Number(r.quantity),
      movementType: r.movement_type,
      encounterId: r.encounter_id ? (r.encounter_id as EncounterId) : undefined,
      reason: r.reason ?? undefined,
      performedBy: r.performed_by ? (r.performed_by as StockMovement['performedBy']) : undefined,
      occurredAt: r.occurred_at as ISODateTime,
    }));
  }
}

export class PgPharmacyUnitOfWork implements PharmacyUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  run<T>(ctx: TenantContext, fn: (repo: PharmacyRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db: TenantScopedDb) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgPharmacyRepository(db));
      },
      ctx,
    );
  }
}
