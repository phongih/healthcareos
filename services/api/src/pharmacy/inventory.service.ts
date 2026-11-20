/**
 * HCOS-P0-ENG-001 | Slice S3 | Pharmacy Inventory Service
 * Quản lý danh mục dược, nhập kho, tồn kho theo lô và thuật toán FEFO khi xuất thuốc.
 *
 * Phân quyền (giống clinical, fail-closed):
 *  - Vai trò lấy từ iam.memberships CÒN HIỆU LỰC (không tin `roles` trong JWT).
 *  - Danh mục thuốc là của tenant: membership tại bất kỳ organization nào trong phạm vi token.
 *  - Kho / tồn kho / nhập / xuất: membership TẠI organization sở hữu vị trí kho.
 *  - Access policy (migration 007) trên membership chỉ thu hẹp thêm (vd. chỉ được thao tác tủ trực).
 *  - Cấp phát: đợt khám phải cùng organization với kho và chưa bị huỷ / nhập nhầm.
 */
import { randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  type AccessPolicyId,
  type AuditSink,
  type CorrelationId,
  type ISODate,
  type ISODateTime,
  type NewAuditEvent,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type Membership,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import {
  ACCESS_POLICY_CATALOG,
  buildGrants,
  decideAccess,
  isMembershipActive,
  type AccessDecision,
  type AccessPolicy,
  type PolicyAction,
} from '../../../../packages/security/src/access-policy';
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

/** Một dòng tồn kho tại vị trí (lô + thuốc). */
export interface StockLine {
  readonly batchId: BatchId;
  readonly batchNumber: string;
  readonly expiryDate: ISODate;
  readonly medicationId: MedicationId;
  readonly brandName: string;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  /** null khi access policy che `unitCost`. */
  readonly unitCost: number | null;
}

export interface EncounterRef {
  readonly organizationId: OrganizationId;
  readonly patientId: string;
  readonly status: string;
}

export interface PharmacyRepository {
  // Principal (vai trò từ DB + policy)
  findUserBySubject(subject: string): Promise<User | null>;
  listMemberships(userId: UserId): Promise<Membership[]>;
  findAccessPolicies(ids: readonly AccessPolicyId[]): Promise<AccessPolicy[]>;
  findEncounterRef(id: EncounterId): Promise<EncounterRef | null>;

  // Đọc
  listMedications(q: { readonly activeOnly: boolean; readonly limit: number }): Promise<Medication[]>;
  listStockLocations(organizationId: OrganizationId): Promise<StockLocation[]>;
  listStockAtLocation(locationId: StockLocationId): Promise<StockLine[]>;

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
  /** false nếu (tenant, thuốc, số lô) đã tồn tại (tạo song song): gọi findBatch lại. */
  insertBatch(b: Batch): Promise<boolean>;
  findBalance(locationId: StockLocationId, batchId: BatchId): Promise<InventoryBalance | null>;
  /**
   * Cộng dồn nguyên tử trong SQL (tạo dòng nếu chưa có). KHÔNG ghi đè từ số đã đọc:
   * ghi đè làm mất cập nhật khi nhập chạy song song với xuất.
   */
  increaseBalance(
    tenantId: TenantContext['tenantId'],
    locationId: StockLocationId,
    batchId: BatchId,
    quantity: number,
    at: ISODateTime,
  ): Promise<void>;

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

  // Audit ghi trong cùng giao dịch với thay đổi (như clinical): rollback thì audit thành công cũng không còn.
  appendAudit(ev: NewAuditEvent): Promise<void>;
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
// Authorization
// ---------------------------------------------------------------------------
type Permission =
  | 'pharmacy:catalog:read'
  | 'pharmacy:catalog:write'
  | 'pharmacy:location:write'
  | 'pharmacy:stock:read'
  | 'pharmacy:stock:receive'
  | 'pharmacy:stock:dispense';

const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'pharmacy:catalog:read': ['pharmacist', 'pharmacy_admin', 'doctor', 'clinic_staff'],
  'pharmacy:catalog:write': ['pharmacist', 'pharmacy_admin'],
  'pharmacy:location:write': ['pharmacy_admin'],
  'pharmacy:stock:read': ['pharmacist', 'pharmacy_admin'],
  'pharmacy:stock:receive': ['pharmacist', 'pharmacy_admin'],
  'pharmacy:stock:dispense': ['pharmacist'],
};

type PharmacyAction = Extract<PolicyAction, `pharmacy:${string}`>;
type AllowedDecision = Extract<AccessDecision, { allowed: true }>;

/** Phạm vi organization của thao tác: cả tenant (trong phạm vi token) hoặc một organization cụ thể. */
type Scope = { readonly kind: 'tenant' } | { readonly kind: 'organization'; readonly organizationId: OrganizationId };

/** Cổng phân quyền mà mỗi thao tác PHẢI gọi đúng một lần (sau khi biết organization của tài nguyên). */
type Gate = (scope: Scope, facts?: { readonly locationType?: string }) => Promise<{ user: User; decision: AllowedDecision }>;

const MAX_LIST = 200;

const MAX_QTY = 2_147_483_647; // integer của PostgreSQL
const MAX_UNIT_COST = 99_999_999_999; // numeric(15,4)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireQuantity(q: unknown, what: string): number {
  if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > MAX_QTY) {
    throw new PharmacyError('VALIDATION', `${what} must be a positive integer`);
  }
  return q;
}

function requireText(v: unknown, what: string, max = 200): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length === 0 || t.length > max) throw new PharmacyError('VALIDATION', `${what} is required (max ${max} chars)`);
  return t;
}

function requireDate(v: unknown, what: string): ISODate {
  if (typeof v !== 'string' || !DATE_RE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new PharmacyError('VALIDATION', `${what} must be a valid YYYY-MM-DD date`);
  }
  return v as ISODate;
}

interface Outcome<T> {
  readonly value: T;
  readonly resourceId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

function requireUuid(v: unknown, what: string): string {
  if (!isUuid(v)) throw new PharmacyError('VALIDATION', `${what} must be a UUID`);
  return v.toLowerCase();
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------
export class PharmacyInventoryService {
  private readonly clock: () => Date;

  constructor(private readonly deps: PharmacyServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  // ---- Đọc ---------------------------------------------------------------
  /** Danh mục thuốc của tenant (tối đa 200). */
  async listMedications(q: { readonly activeOnly?: boolean; readonly limit?: number }, ctx: TenantContext): Promise<Medication[]> {
    return this.exec(ctx, 'pharmacy:catalog:read', 'pharmacy.medication.list', 'pharmacy.medication', async (repo, gate) => {
      await gate({ kind: 'tenant' });
      const limit = q.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new PharmacyError('VALIDATION', `limit must be 1..${MAX_LIST}`);
      const meds = await repo.listMedications({ activeOnly: q.activeOnly ?? true, limit });
      for (const m of meds) assertTenant(m, ctx);
      return { value: meds, resourceId: null, payload: { count: meds.length } };
    });
  }

  async getMedication(id: string, ctx: TenantContext): Promise<Medication> {
    return this.exec(ctx, 'pharmacy:catalog:read', 'pharmacy.medication.read', 'pharmacy.medication', async (repo, gate) => {
      await gate({ kind: 'tenant' });
      const med = await repo.findMedication(asMedicationId(requireUuid(id, 'medicationId')));
      if (!med) throw new PharmacyError('NOT_FOUND', 'Medication not found');
      assertTenant(med, ctx);
      return { value: med, resourceId: med.medicationId, payload: {} };
    });
  }

  async listStockLocations(organizationId: string, ctx: TenantContext): Promise<StockLocation[]> {
    return this.exec(ctx, 'pharmacy:stock:read', 'pharmacy.location.list', 'pharmacy.location', async (repo, gate) => {
      const org = requireUuid(organizationId, 'organizationId') as OrganizationId;
      await gate({ kind: 'organization', organizationId: org });
      const locs = (await repo.listStockLocations(org)).filter((l) => l.organizationId === org);
      for (const l of locs) assertTenant(l, ctx);
      return { value: locs, resourceId: null, payload: { organizationId: org, count: locs.length } };
    });
  }

  /** Tồn kho theo lô tại một vị trí (lô hết hạn vẫn hiện để xử lý huỷ). */
  async getStock(locationId: string, ctx: TenantContext): Promise<{ location: StockLocation; lines: StockLine[]; redacted: string[] }> {
    return this.exec(ctx, 'pharmacy:stock:read', 'pharmacy.stock.read', 'pharmacy.location', async (repo, gate) => {
      const loc = await this.loadLocation(repo, ctx, requireUuid(locationId, 'locationId'));
      const { decision } = await gate({ kind: 'organization', organizationId: loc.organizationId }, { locationType: loc.type });
      const hideCost = decision.hiddenFields.has('unitCost');
      const lines = (await repo.listStockAtLocation(loc.locationId)).map((l) => (hideCost ? { ...l, unitCost: null } : l));
      return {
        value: { location: loc, lines, redacted: hideCost ? ['unitCost'] : [] },
        resourceId: loc.locationId,
        payload: { lineCount: lines.length, ...policyAudit(decision) },
      };
    });
  }

  // ---- Danh mục ----------------------------------------------------------
  /** Đăng ký hoạt chất chuẩn */
  async createSubstance(input: CreateSubstanceInput, ctx: TenantContext): Promise<Substance> {
    return this.exec(ctx, 'pharmacy:catalog:write', 'pharmacy.substance.create', 'pharmacy.substance', async (repo, gate) => {
      const { decision } = await gate({ kind: 'tenant' });
      const now = this.clock().toISOString() as ISODateTime;
      const substance: Substance = {
        tenantId: ctx.tenantId,
        substanceId: asSubstanceId(randomUUID()),
        code: requireText(input.code, 'Substance code', 64).toUpperCase(),
        name: requireText(input.name, 'Substance name'),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      const existing = await repo.findSubstanceByCode(substance.code);
      if (existing) {
        throw new PharmacyError('CONFLICT', `Substance with code ${substance.code} already exists`);
      }
      await repo.insertSubstance(substance);
      return { value: substance, resourceId: substance.substanceId, payload: { code: substance.code, ...policyAudit(decision) } };
    });
  }

  /** Đăng ký biệt dược thương mại */
  async createMedication(input: CreateMedicationInput, ctx: TenantContext): Promise<Medication> {
    return this.exec(ctx, 'pharmacy:catalog:write', 'pharmacy.medication.create', 'pharmacy.medication', async (repo, gate) => {
      const { decision } = await gate({ kind: 'tenant' });
      if (input.substanceId !== undefined && !isUuid(input.substanceId)) {
        throw new PharmacyError('VALIDATION', 'substanceId must be a UUID');
      }
      const now = this.clock().toISOString() as ISODateTime;
      const medication: Medication = {
        tenantId: ctx.tenantId,
        medicationId: asMedicationId(randomUUID()),
        substanceId: input.substanceId ? asSubstanceId(input.substanceId) : undefined,
        brandName: requireText(input.brandName, 'brandName'),
        genericName: input.genericName?.trim() || undefined,
        strength: requireText(input.strength, 'strength', 64),
        form: requireText(input.form, 'form', 64),
        route: input.route?.trim() || undefined,
        unitOfMeasure: requireText(input.unitOfMeasure, 'unitOfMeasure', 32),
        barcode: input.barcode?.trim() || undefined,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      await repo.insertMedication(medication);
      return {
        value: medication,
        resourceId: medication.medicationId,
        payload: { substanceId: medication.substanceId ?? null, ...policyAudit(decision) },
      };
    });
  }

  /** Tạo vị trí kho / quầy / tủ trực TẠI organization mà người gọi có vai trò pharmacy_admin. */
  async createStockLocation(input: CreateStockLocationInput, ctx: TenantContext): Promise<StockLocation> {
    return this.exec(ctx, 'pharmacy:location:write', 'pharmacy.location.create', 'pharmacy.location', async (repo, gate) => {
      const org = requireUuid(input.organizationId, 'organizationId') as OrganizationId;
      if (!(LOCATION_TYPES as readonly string[]).includes(input.type)) {
        throw new PharmacyError('VALIDATION', `type must be one of: ${LOCATION_TYPES.join(', ')}`);
      }
      const { decision } = await gate({ kind: 'organization', organizationId: org }, { locationType: input.type });
      const now = this.clock().toISOString() as ISODateTime;
      const loc: StockLocation = {
        tenantId: ctx.tenantId,
        locationId: asStockLocationId(randomUUID()),
        organizationId: org,
        name: requireText(input.name, 'name'),
        type: input.type,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      await repo.insertStockLocation(loc);
      return {
        value: loc,
        resourceId: loc.locationId,
        payload: { organizationId: loc.organizationId, type: loc.type, ...policyAudit(decision) },
      };
    });
  }

  // ---- Nhập / xuất -------------------------------------------------------
  /** Nhập kho theo lô (Receipt) */
  async receiveStock(input: ReceiveStockInput, ctx: TenantContext): Promise<{ batch: Batch; movement: StockMovement }> {
    return this.exec(ctx, 'pharmacy:stock:receive', 'pharmacy.stock.receive', 'pharmacy.batch', async (repo, gate) => {
      if (!isUuid(input.medicationId) || !isUuid(input.locationId)) {
        throw new PharmacyError('VALIDATION', 'medicationId and locationId must be UUIDs');
      }
      const loc = await this.loadLocation(repo, ctx, input.locationId);
      const { user, decision } = await gate({ kind: 'organization', organizationId: loc.organizationId }, { locationType: loc.type });
      if (!loc.isActive) throw new PharmacyError('VALIDATION', 'Stock location is inactive', { reason: 'INACTIVE_LOCATION' });

      const quantity = requireQuantity(input.quantity, 'Quantity received');
      const batchNumber = requireText(input.batchNumber, 'batchNumber', 64);
      const expiryDate = requireDate(input.expiryDate, 'expiryDate');
      const manufacturingDate =
        input.manufacturingDate === undefined ? undefined : requireDate(input.manufacturingDate, 'manufacturingDate');
      if (manufacturingDate !== undefined && manufacturingDate >= expiryDate) {
        throw new PharmacyError('VALIDATION', 'manufacturingDate must be before expiryDate');
      }
      if (typeof input.unitCost !== 'number' || !Number.isFinite(input.unitCost) || input.unitCost < 0 || input.unitCost > MAX_UNIT_COST) {
        throw new PharmacyError('VALIDATION', 'unitCost must be a non-negative number');
      }
      const unitCost = Math.round(input.unitCost * 10000) / 10000; // numeric(15,4)

      const now = this.clock().toISOString() as ISODateTime;
      const today = now.slice(0, 10);
      if (expiryDate <= today) {
        throw new PharmacyError('EXPIRED_BATCH', `Batch ${batchNumber} is expired or expires today`, { expiryDate });
      }
      const medicationId = asMedicationId(input.medicationId);
      const locationId = loc.locationId;

      const med = await repo.findMedication(medicationId);
      if (!med) throw new PharmacyError('NOT_FOUND', `Medication ${input.medicationId} not found`);
      if (!med.isActive) throw new PharmacyError('VALIDATION', 'Medication is inactive', { reason: 'INACTIVE_MEDICATION' });

      // 1. Quản lý Batch: lô đã có thì thuộc tính phải khớp (không âm thầm bỏ qua hạn dùng/giá mới)
      let batch = await repo.findBatch(medicationId, batchNumber);
      if (!batch) {
        const created: Batch = {
          tenantId: ctx.tenantId,
          batchId: asBatchId(randomUUID()),
          medicationId,
          batchNumber,
          manufacturingDate,
          expiryDate,
          unitCost,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = await repo.insertBatch(created);
        batch = inserted ? created : await repo.findBatch(medicationId, batchNumber); // tạo song song
        if (!batch) throw new PharmacyError('CONFLICT', 'Batch could not be created', { reason: 'BATCH_RACE' });
      }
      if (
        batch.expiryDate !== expiryDate ||
        (batch.manufacturingDate ?? undefined) !== manufacturingDate ||
        Math.round(batch.unitCost * 10000) / 10000 !== unitCost
      ) {
        throw new PharmacyError('CONFLICT', `Batch ${batchNumber} already exists with different attributes`, {
          reason: 'BATCH_ATTRIBUTE_MISMATCH',
        });
      }
      // 2. Cộng tồn kho nguyên tử trong SQL (không đọc-rồi-ghi đè)
      await repo.increaseBalance(ctx.tenantId, locationId, batch.batchId, quantity, now);

      // 3. Ghi sổ cái xuất nhập tồn bất biến
      const movement: StockMovement = {
        tenantId: ctx.tenantId,
        movementId: asStockMovementId(randomUUID()),
        destinationLocationId: locationId,
        batchId: batch.batchId,
        quantity,
        movementType: 'receipt',
        reason: input.reason ?? 'Direct warehouse receipt',
        performedBy: user.userId,
        occurredAt: now,
      };
      await repo.insertStockMovement(movement);

      return {
        value: { batch, movement },
        resourceId: batch.batchId,
        payload: { medicationId, locationId, batchNumber, quantity, ...policyAudit(decision) },
      };
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
    return this.exec(ctx, 'pharmacy:stock:dispense', 'pharmacy.stock.dispense', 'pharmacy.medication', async (repo, gate) => {
      if (!isUuid(input.medicationId) || !isUuid(input.locationId) || !isUuid(input.encounterId)) {
        throw new PharmacyError('VALIDATION', 'medicationId, locationId and encounterId must be UUIDs');
      }
      const loc = await this.loadLocation(repo, ctx, input.locationId);
      const { user, decision } = await gate({ kind: 'organization', organizationId: loc.organizationId }, { locationType: loc.type });
      const quantity = requireQuantity(input.quantity, 'Quantity to dispense');

      const now = this.clock().toISOString() as ISODateTime;
      const medicationId = asMedicationId(input.medicationId);
      const locationId = loc.locationId;

      if (!loc.isActive) throw new PharmacyError('VALIDATION', 'Stock location is inactive', { reason: 'INACTIVE_LOCATION' });
      if (loc.type === 'quarantine') {
        throw new PharmacyError('VALIDATION', 'Cannot dispense from a quarantine location', { reason: 'QUARANTINE_LOCATION' });
      }

      // Đợt khám: cùng tenant (RLS), cùng organization với kho, không bị huỷ / nhập nhầm.
      const enc = await repo.findEncounterRef(input.encounterId.toLowerCase() as EncounterId);
      if (!enc) throw new PharmacyError('VALIDATION', 'Encounter not found', { reason: 'REFERENCE_NOT_FOUND' });
      if (enc.organizationId !== loc.organizationId) {
        throw new PharmacyError('VALIDATION', 'Encounter belongs to a different organization than the stock location', {
          reason: 'ENCOUNTER_ORG_MISMATCH',
        });
      }
      if (enc.status === 'cancelled' || enc.status === 'entered_in_error') {
        throw new PharmacyError('VALIDATION', `Encounter is ${enc.status}`, { reason: 'ENCOUNTER_NOT_ACTIVE' });
      }

      const med = await repo.findMedication(medicationId);
      if (!med) {
        throw new PharmacyError('NOT_FOUND', `Medication ${input.medicationId} not found`);
      }
      if (!med.isActive) throw new PharmacyError('VALIDATION', 'Medication is inactive', { reason: 'INACTIVE_MEDICATION' });

      // Khóa dòng các bản ghi tồn kho khả dụng còn hạn dùng, sắp xếp tăng dần theo expiry_date
      const candidateBatches = await repo.lockAvailableBatchesForFefo(locationId, medicationId);

      const totalAvailable = candidateBatches.reduce(
        (sum, b) => sum + (b.quantityOnHand - b.quantityReserved),
        0,
      );

      if (totalAvailable < quantity) {
        throw new PharmacyError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock. Requested: ${quantity}, Available: ${totalAvailable}`,
          { requested: quantity, available: totalAvailable },
        );
      }

      let remainingToAllocate = quantity;
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
          encounterId: input.encounterId.toLowerCase() as EncounterId,
          reason: input.reason ?? 'Prescription fulfillment',
          performedBy: user.userId,
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

      const plan: FefoAllocationPlan = {
        medicationId,
        requestedQuantity: quantity,
        allocatedTotal: quantity - remainingToAllocate,
        items: allocatedItems,
        isFullyAllocated: remainingToAllocate === 0,
      };
      return {
        value: plan,
        resourceId: medicationId,
        payload: {
          locationId,
          encounterId: input.encounterId,
          quantity,
          batches: allocatedItems.map((i) => ({ batchId: i.batchId, quantity: i.allocatedQuantity })),
          ...policyAudit(decision),
        },
      };
    });
  }

  /** Các lần cấp phát của một đợt khám (để đối chiếu / in phiếu). */
  async listDispensesByEncounter(encounterId: string, ctx: TenantContext): Promise<StockMovement[]> {
    return this.exec(ctx, 'pharmacy:stock:read', 'pharmacy.dispense.list', 'pharmacy.movement', async (repo, gate) => {
      const enc = await repo.findEncounterRef(requireUuid(encounterId, 'encounterId') as EncounterId);
      if (!enc) throw new PharmacyError('NOT_FOUND', 'Encounter not found');
      await gate({ kind: 'organization', organizationId: enc.organizationId });
      const moves = (await repo.listStockMovementsByEncounter(encounterId.toLowerCase() as EncounterId)).filter((m) => m.movementType === 'dispense');
      for (const m of moves) assertTenant(m, ctx);
      return { value: moves, resourceId: encounterId, payload: { count: moves.length } };
    });
  }

  // -------------------------------------------------------------------------
  // Nội bộ: phân quyền + giao dịch + audit (thành công: cùng giao dịch; từ chối/lỗi: ghi riêng)
  // -------------------------------------------------------------------------
  private async loadLocation(repo: PharmacyRepository, ctx: TenantContext, id: string): Promise<StockLocation> {
    const loc = await repo.findStockLocation(asStockLocationId(id));
    if (!loc) throw new PharmacyError('NOT_FOUND', `Stock location ${id} not found`);
    assertTenant(loc, ctx);
    return loc;
  }

  private async exec<T>(
    ctx: TenantContext,
    action: PharmacyAction,
    auditAction: string,
    resourceType: string,
    work: (repo: PharmacyRepository, gate: Gate) => Promise<Outcome<T>>,
  ): Promise<T> {
    let auditOrg: OrganizationId | null = ctx.activeOrganizationId;
    let actor: string = ctx.userSubject;
    try {
      return await this.deps.uow.run(ctx, async (repo) => {
        const user = await repo.findUserBySubject(ctx.userSubject);
        if (!user || user.status !== 'active') throw new PharmacyError('FORBIDDEN', 'Caller is not an active user');
        assertTenant(user, ctx);
        actor = user.userId;
        const now = this.clock().getTime();
        const active = (await repo.listMemberships(user.userId)).filter((m) => isMembershipActive(m, now));
        const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
        const roles = PERMISSIONS[perm];

        // Chặn sớm: không có vai trò phù hợp ở bất kỳ organization nào trong phạm vi => 403 trước mọi truy vấn khác.
        if (!active.some((m) => roles.includes(m.role) && ctx.allowedOrganizationIds.includes(m.organizationId))) {
          throw new PharmacyError('FORBIDDEN', `Missing permission ${perm}`);
        }

        let called = false;
        const gate: Gate = async (scope, facts = {}) => {
          if (called) throw new Error('authorization gate invoked twice');
          called = true;
          let eligible: Membership[];
          if (scope.kind === 'organization') {
            if (!ctx.allowedOrganizationIds.includes(scope.organizationId)) {
              throw new PharmacyError('FORBIDDEN', 'Organization is outside the caller scope');
            }
            auditOrg = scope.organizationId;
            eligible = active.filter((m) => m.organizationId === scope.organizationId);
          } else {
            eligible = active.filter((m) => ctx.allowedOrganizationIds.includes(m.organizationId));
          }
          const grants = await buildGrants(eligible, ctx.tenantId, (ids) => repo.findAccessPolicies(ids));
          const d = decideAccess(grants, action, roles, { callerUserId: user.userId, ...facts });
          if (!d.allowed) {
            if (d.reason === 'ROLE') throw new PharmacyError('FORBIDDEN', `Missing permission ${perm}`);
            throw new PharmacyError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
          }
          return { user, decision: d };
        };

        const out = await work(repo, gate);
        if (!called) throw new Error(`authorization gate was not invoked for ${auditAction}`);
        await repo.appendAudit(this.event(ctx, actor, auditOrg, auditAction, resourceType, out.resourceId, 'success', out.payload));
        return out.value;
      });
    } catch (e) {
      await this.auditFailure(ctx, actor, auditOrg, auditAction, resourceType, e);
      throw e;
    }
  }

  private event(
    ctx: TenantContext,
    actor: string,
    organizationId: OrganizationId | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    outcome: NewAuditEvent['outcome'],
    payload: Readonly<Record<string, unknown>>,
  ): NewAuditEvent {
    return {
      tenantId: ctx.tenantId,
      actor: { type: 'user', id: actor },
      organizationId,
      action,
      resourceType,
      resourceId,
      personId: null,
      patientId: null,
      outcome,
      correlationId: ctx.correlationId,
      sourceIp: null,
      userAgent: null,
      payload,
    };
  }

  private async auditFailure(
    ctx: TenantContext,
    actor: string,
    organizationId: OrganizationId | null,
    action: string,
    resourceType: string,
    e: unknown,
  ): Promise<void> {
    let code = 'INTERNAL';
    let outcome: NewAuditEvent['outcome'] = 'failure';
    if (e instanceof PharmacyError) {
      code = e.code;
      if (e.code === 'FORBIDDEN') outcome = 'denied';
    } else if (e instanceof TenantIsolationError) {
      code = e.code;
      outcome = 'denied';
    }
    const reason = e instanceof PharmacyError && typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
    try {
      await this.deps.audit.record(
        this.event(ctx, actor, organizationId, action, resourceType, null, outcome, { code, ...(reason ? { reason } : {}) }),
      );
    } catch {
      /* audit lỗi không được thay đổi kết quả gốc */
    }
  }
}

const LOCATION_TYPES = ['main_warehouse', 'dispensary_counter', 'ward_cabinet', 'quarantine'] as const;

function assertTenant(r: { readonly tenantId: string }, ctx: TenantContext): void {
  if (r.tenantId !== ctx.tenantId) {
    throw new TenantIsolationError('RESOURCE_TENANT_MISMATCH', 'Resource belongs to a different tenant', 403);
  }
}

function policyAudit(d: AllowedDecision): Record<string, unknown> {
  if (d.policyIds.length === 0) return {};
  return { accessPolicyIds: d.policyIds, ...(d.hiddenFields.size > 0 ? { redacted: [...d.hiddenFields].sort() } : {}) };
}

// ---------------------------------------------------------------------------
// PostgreSQL Implementation
// ---------------------------------------------------------------------------
import {
  withTenantTransaction,
  type PgPoolLike,
} from '../../../../packages/security/src/tenant-context';
import {
  ACCESS_POLICY_COLS,
  MEMBERSHIP_COLS,
  USER_COLS,
  mapAccessPolicy,
  mapMembership,
  mapUser,
} from '../clinical/encounter.service';

export interface PgClientLike {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export class PgPharmacyRepository implements PharmacyRepository {
  constructor(private readonly db: PgClientLike) {}

  // ---- Principal ----------------------------------------------------------
  // Tenant = tenant của transaction (RLS); thêm điều kiện tường minh để không phụ thuộc riêng vào RLS.
  async findUserBySubject(subject: string): Promise<User | null> {
    const r = await this.db.query(
      `SELECT ${USER_COLS} FROM iam.users WHERE tenant_id = platform.current_tenant_id() AND external_subject = $1`,
      [subject],
    );
    return r.rows[0] ? mapUser(r.rows[0]) : null;
  }

  async listMemberships(userId: UserId): Promise<Membership[]> {
    const r = await this.db.query(
      `SELECT ${MEMBERSHIP_COLS} FROM iam.memberships WHERE tenant_id = platform.current_tenant_id() AND user_id = $1`,
      [userId],
    );
    return r.rows.map(mapMembership);
  }

  async findAccessPolicies(ids: readonly AccessPolicyId[]): Promise<AccessPolicy[]> {
    if (ids.length === 0) return [];
    const r = await this.db.query(
      `SELECT ${ACCESS_POLICY_COLS} FROM iam.access_policies
        WHERE tenant_id = platform.current_tenant_id() AND policy_id = ANY($1::uuid[])`,
      [`{${ids.join(',')}}`],
    );
    return r.rows.map(mapAccessPolicy).filter((p): p is AccessPolicy => p !== null);
  }

  async findEncounterRef(id: EncounterId): Promise<EncounterRef | null> {
    const r = await this.db.query<{ organization_id: string; patient_id: string; status: string }>(
      `SELECT organization_id, patient_id, status FROM clinical.encounters
        WHERE tenant_id = platform.current_tenant_id() AND encounter_id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row ? { organizationId: row.organization_id as OrganizationId, patientId: row.patient_id, status: row.status } : null;
  }

  // ---- Đọc ----------------------------------------------------------------
  async listMedications(q: { readonly activeOnly: boolean; readonly limit: number }): Promise<Medication[]> {
    const r = await this.db.query<{ medication_id: string }>(
      `SELECT medication_id FROM pharmacy.medications
        WHERE tenant_id = platform.current_tenant_id() AND ($1::boolean = false OR is_active)
        ORDER BY brand_name, medication_id LIMIT $2`,
      [q.activeOnly, q.limit],
    );
    const out: Medication[] = [];
    for (const row of r.rows) {
      const m = await this.findMedication(asMedicationId(row.medication_id));
      if (m) out.push(m);
    }
    return out;
  }

  async listStockLocations(organizationId: OrganizationId): Promise<StockLocation[]> {
    const r = await this.db.query<{ location_id: string }>(
      `SELECT location_id FROM pharmacy.stock_locations
        WHERE tenant_id = platform.current_tenant_id() AND organization_id = $1 ORDER BY name, location_id`,
      [organizationId],
    );
    const out: StockLocation[] = [];
    for (const row of r.rows) {
      const l = await this.findStockLocation(asStockLocationId(row.location_id));
      if (l) out.push(l);
    }
    return out;
  }

  async listStockAtLocation(locationId: StockLocationId): Promise<StockLine[]> {
    const r = await this.db.query<{
      batch_id: string; batch_number: string; expiry_date: string; medication_id: string; brand_name: string;
      quantity_on_hand: number; quantity_reserved: number; unit_cost: string;
    }>(
      `SELECT b.batch_id, bt.batch_number, bt.expiry_date::text AS expiry_date, bt.medication_id, m.brand_name,
              b.quantity_on_hand, b.quantity_reserved, bt.unit_cost
         FROM pharmacy.inventory_balances b
         JOIN pharmacy.batches bt ON bt.tenant_id = b.tenant_id AND bt.batch_id = b.batch_id
         JOIN pharmacy.medications m ON m.tenant_id = bt.tenant_id AND m.medication_id = bt.medication_id
        WHERE b.tenant_id = platform.current_tenant_id() AND b.location_id = $1 AND b.quantity_on_hand > 0
        ORDER BY m.brand_name, bt.expiry_date, bt.batch_id`,
      [locationId],
    );
    return r.rows.map((x) => ({
      batchId: asBatchId(x.batch_id),
      batchNumber: x.batch_number,
      expiryDate: x.expiry_date as ISODate,
      medicationId: asMedicationId(x.medication_id),
      brandName: x.brand_name,
      quantityOnHand: Number(x.quantity_on_hand),
      quantityReserved: Number(x.quantity_reserved),
      unitCost: Number(x.unit_cost),
    }));
  }

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

  async insertBatch(b: Batch): Promise<boolean> {
    const res = await this.db.query<{ batch_id: string }>(
      `INSERT INTO pharmacy.batches (
         batch_id, tenant_id, medication_id, batch_number, manufacturing_date, expiry_date, unit_cost, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, medication_id, batch_number) DO NOTHING
       RETURNING batch_id`,
      [
        b.batchId, b.tenantId, b.medicationId, b.batchNumber,
        b.manufacturingDate ?? null, b.expiryDate, b.unitCost,
        b.createdAt, b.updatedAt,
      ],
    );
    return res.rows.length > 0;
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

  async increaseBalance(
    tenantId: TenantContext['tenantId'],
    locationId: StockLocationId,
    batchId: BatchId,
    quantity: number,
    at: ISODateTime,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO pharmacy.inventory_balances (tenant_id, location_id, batch_id, quantity_on_hand, quantity_reserved, version, updated_at)
       VALUES ($1, $2, $3, $4, 0, 1, $5)
       ON CONFLICT (tenant_id, location_id, batch_id) DO UPDATE SET
         quantity_on_hand = pharmacy.inventory_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
         version = pharmacy.inventory_balances.version + 1,
         updated_at = EXCLUDED.updated_at`,
      [tenantId, locationId, batchId, quantity, at],
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
       ORDER BY bt.expiry_date ASC, bt.batch_id ASC
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

  async appendAudit(ev: NewAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO platform.audit_events
         (tenant_id, actor_type, actor_id, organization_id, action, resource_type, resource_id,
          person_id, patient_id, outcome, correlation_id, source_ip, user_agent, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [ev.tenantId, ev.actor.type, ev.actor.id, ev.organizationId, ev.action, ev.resourceType, ev.resourceId,
       ev.personId, ev.patientId, ev.outcome, ev.correlationId, ev.sourceIp, ev.userAgent, JSON.stringify(ev.payload)],
    );
  }
}

export class PgPharmacyUnitOfWork implements PharmacyUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}

  async run<T>(ctx: TenantContext, fn: (repo: PharmacyRepository) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(
        this.pool,
        async (db: TenantScopedDb) => {
          await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
          return fn(new PgPharmacyRepository(db));
        },
        ctx,
      );
    } catch (e) {
      return translatePgError(e);
    }
  }
}

/**
 * Lỗi của PostgreSQL (kể cả lỗi ràng buộc hoãn phát sinh lúc COMMIT) -> PharmacyError có mã ổn định.
 * Không lộ tên bảng/giá trị ra ngoài ngoài `constraint`.
 */
export function translatePgError(e: unknown): never {
  if (e instanceof PharmacyError || e instanceof TenantIsolationError) throw e;
  const err = e as { code?: unknown; constraint?: unknown };
  const code = typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
  const constraint = typeof err?.constraint === 'string' ? err.constraint : undefined;
  switch (code) {
    case '23505':
      throw new PharmacyError('CONFLICT', 'Conflicting record', { reason: 'UNIQUE_VIOLATION', constraint });
    case '23503':
      throw new PharmacyError('VALIDATION', 'Referenced record not found', { reason: 'REFERENCE_NOT_FOUND', constraint });
    case '23514':
      throw new PharmacyError('CONFLICT', 'Inventory invariant violated', { reason: 'INVARIANT_VIOLATION', constraint });
    case '55000':
      throw new PharmacyError('CONFLICT', 'Record is immutable', { reason: 'IMMUTABLE' });
    case '42501':
      throw new PharmacyError('FORBIDDEN', 'Operation rejected by data-layer policy');
    default:
      throw e;
  }
}
