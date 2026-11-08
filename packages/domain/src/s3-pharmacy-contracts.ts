/**
 * HCOS-P0-ENG-001 | Slice S3 | Pharmacy domain contracts & FHIR R4 mappings
 * Quản lý hoạt chất, biệt dược, kho tủ trực, tồn kho theo lô (FEFO) và xuất nhập tồn.
 */
import {
  isUuid,
  type Brand,
  type ISODate,
  type ISODateTime,
  type OrganizationId,
  type PatientId,
  type TenantScoped,
  type Timestamped,
  type UserId,
  type Versioned,
} from './s0-contracts';
import { type EncounterId } from './s1-contracts';

// ---------------------------------------------------------------------------
// Branded Identifiers
// ---------------------------------------------------------------------------
export type SubstanceId = Brand<string, 'SubstanceId'>;
export type MedicationId = Brand<string, 'MedicationId'>;
export type StockLocationId = Brand<string, 'StockLocationId'>;
export type BatchId = Brand<string, 'BatchId'>;
export type BalanceId = Brand<string, 'BalanceId'>;
export type StockMovementId = Brand<string, 'StockMovementId'>;

const mk = <T extends string>(label: string) => (v: string): T => {
  if (!isUuid(v)) throw new TypeError(`Invalid ${label} (uuid expected): ${v}`);
  return v as unknown as T;
};

export const asSubstanceId = mk<SubstanceId>('SubstanceId');
export const asMedicationId = mk<MedicationId>('MedicationId');
export const asStockLocationId = mk<StockLocationId>('StockLocationId');
export const asBatchId = mk<BatchId>('BatchId');
export const asBalanceId = mk<BalanceId>('BalanceId');
export const asStockMovementId = mk<StockMovementId>('StockMovementId');

// ---------------------------------------------------------------------------
// Domain Enums & Value Objects
// ---------------------------------------------------------------------------
export type StockLocationType = 'main_warehouse' | 'dispensary_counter' | 'ward_cabinet' | 'quarantine';

export type StockMovementType = 'receipt' | 'transfer' | 'dispense' | 'adjustment' | 'disposal';

export interface Substance extends TenantScoped, Timestamped {
  readonly substanceId: SubstanceId;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface Medication extends TenantScoped, Timestamped {
  readonly medicationId: MedicationId;
  readonly substanceId?: SubstanceId;
  readonly brandName: string;
  readonly genericName?: string;
  readonly strength: string;
  readonly form: string;
  readonly route?: string;
  readonly unitOfMeasure: string;
  readonly barcode?: string;
  readonly isActive: boolean;
}

export interface StockLocation extends TenantScoped, Timestamped {
  readonly locationId: StockLocationId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly type: StockLocationType;
  readonly isActive: boolean;
}

export interface Batch extends TenantScoped, Timestamped {
  readonly batchId: BatchId;
  readonly medicationId: MedicationId;
  readonly batchNumber: string;
  readonly manufacturingDate?: ISODate;
  readonly expiryDate: ISODate;
  readonly unitCost: number;
}

export interface InventoryBalance extends TenantScoped, Versioned {
  readonly balanceId: BalanceId;
  readonly locationId: StockLocationId;
  readonly batchId: BatchId;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly updatedAt: ISODateTime;
}

export interface StockMovement extends TenantScoped {
  readonly movementId: StockMovementId;
  readonly sourceLocationId?: StockLocationId;
  readonly destinationLocationId?: StockLocationId;
  readonly batchId: BatchId;
  readonly quantity: number;
  readonly movementType: StockMovementType;
  readonly encounterId?: EncounterId;
  readonly reason?: string;
  readonly performedBy?: UserId;
  readonly occurredAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// FEFO Allocation Types
// ---------------------------------------------------------------------------
export interface FefoAllocationItem {
  readonly batchId: BatchId;
  readonly batchNumber: string;
  readonly expiryDate: ISODate;
  readonly allocatedQuantity: number;
}

export interface FefoAllocationPlan {
  readonly medicationId: MedicationId;
  readonly requestedQuantity: number;
  readonly allocatedTotal: number;
  readonly items: readonly FefoAllocationItem[];
  readonly isFullyAllocated: boolean;
}

// ---------------------------------------------------------------------------
// FHIR R4 Minimal Mappings
// ---------------------------------------------------------------------------
export interface FhirMedication {
  readonly resourceType: 'Medication';
  readonly id?: string;
  readonly code?: {
    readonly coding?: ReadonlyArray<{
      readonly system?: string;
      readonly code?: string;
      readonly display?: string;
    }>;
    readonly text?: string;
  };
  readonly form?: {
    readonly text?: string;
  };
}

export interface FhirMedicationDispense {
  readonly resourceType: 'MedicationDispense';
  readonly id?: string;
  readonly status: 'completed' | 'in-progress' | 'cancelled';
  readonly medicationReference: {
    readonly reference: string; // Medication/<id>
  };
  readonly subject: {
    readonly reference: string; // Patient/<id>
  };
  readonly context?: {
    readonly reference: string; // Encounter/<id>
  };
  readonly quantity?: {
    readonly value: number;
    readonly unit: string;
  };
  readonly dosageInstruction?: ReadonlyArray<{
    readonly text?: string;
  }>;
}
