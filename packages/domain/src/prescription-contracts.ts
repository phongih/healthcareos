/**
 * HCOS-F5 — Kê đơn thuốc (đơn ngoại trú).
 *
 * Một đơn thuộc đúng một đợt khám; mỗi dòng là một thuốc trong danh mục với liều mỗi lần, số lần/ngày, số ngày
 * (các trường bắt buộc ghi trên đơn theo TT 26/2025/TT-BYT) và số lượng cấp. Dược sĩ cấp phát theo từng dòng;
 * số đã cấp luôn khớp sổ cái kho (ràng buộc ở DB, migration 009).
 */
import type { Brand, OrganizationId, PatientId, TenantId, UserId } from './s0-contracts';
import type { EncounterId } from './s1-contracts';
import type { MedicationId } from './s3-pharmacy-contracts';

export type PrescriptionId = Brand<string, 'PrescriptionId'>;
export type PrescriptionItemId = Brand<string, 'PrescriptionItemId'>;
export const asPrescriptionId = (s: string): PrescriptionId => s.toLowerCase() as PrescriptionId;
export const asPrescriptionItemId = (s: string): PrescriptionItemId => s.toLowerCase() as PrescriptionItemId;

export type PrescriptionStatus = 'active' | 'completed' | 'cancelled' | 'entered_in_error';
export const PRESCRIPTION_STATUSES: readonly PrescriptionStatus[] = ['active', 'completed', 'cancelled', 'entered_in_error'];

export interface Prescription {
  readonly tenantId: TenantId;
  readonly prescriptionId: PrescriptionId;
  readonly organizationId: OrganizationId;
  readonly encounterId: EncounterId;
  readonly patientId: PatientId;
  readonly prescriberUserId: UserId;
  readonly status: PrescriptionStatus;
  readonly note: string | null;
  readonly prescribedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface PrescriptionItem {
  readonly tenantId: TenantId;
  readonly itemId: PrescriptionItemId;
  readonly prescriptionId: PrescriptionId;
  readonly lineNo: number;
  readonly medicationId: MedicationId;
  /** Liều mỗi lần, vd 1, 0.5, 2. */
  readonly doseQuantity: number;
  /** Đơn vị liều, vd "viên", "gói", "ml". */
  readonly doseUnit: string;
  readonly frequencyPerDay: number;
  readonly durationDays: number;
  /** Cách dùng, vd "uống sau ăn". */
  readonly instructions: string | null;
  /** Số lượng cấp theo đơn vị tồn kho của thuốc. */
  readonly quantityPrescribed: number;
  readonly quantityDispensed: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface NewPrescriptionItemInput {
  readonly medicationId: string;
  readonly doseQuantity: number;
  readonly doseUnit: string;
  readonly frequencyPerDay: number;
  readonly durationDays: number;
  readonly quantity: number;
  readonly instructions?: string | null;
}

export interface NewPrescriptionInput {
  readonly encounterId: string;
  readonly note?: string | null;
  readonly items: readonly NewPrescriptionItemInput[];
}

/** Thông tin thuốc kèm theo dòng đơn để hiển thị (không cần gọi thêm API danh mục). */
export interface PrescribedMedication {
  readonly medicationId: MedicationId;
  readonly brandName: string;
  readonly genericName: string | null;
  readonly strength: string;
  readonly form: string;
  readonly unitOfMeasure: string;
}

export interface PrescriptionView {
  readonly prescription: Prescription;
  readonly items: ReadonlyArray<PrescriptionItem & { readonly medication: PrescribedMedication }>;
  readonly prescriber: { readonly userId: UserId; readonly displayName: string | null };
  /** Chỉ có trong hàng đợi của dược sĩ (danh sách đơn theo organization). */
  readonly patient?: { readonly patientId: PatientId; readonly mrn: string; readonly familyName: string; readonly givenName: string };
}

export const PRESCRIPTION_LIMITS = {
  maxItems: 20,
  maxDose: 1000,
  maxFrequencyPerDay: 24,
  maxDurationDays: 180,
  maxQuantity: 100000,
  noteMax: 1000,
  instructionsMax: 500,
  doseUnitMax: 32,
} as const;

/** Số lượng gợi ý = liều × lần/ngày × ngày, làm tròn lên (dùng khi đơn vị liều = đơn vị tồn kho). */
export const suggestedQuantity = (dose: number, perDay: number, days: number): number => Math.ceil(dose * perDay * days - 1e-9);
