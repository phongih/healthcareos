/** Phiên làm việc: người dùng (/api/me), organization đang chọn, vai trò tại organization đó. */
import { createContext, useContext } from 'react';

export type Role =
  | 'doctor' | 'pharmacist' | 'patient' | 'clinic_staff' | 'cashier' | 'clinic_admin' | 'pharmacy_admin' | 'executive' | 'tenant_admin' | 'system';

export interface Me {
  user: { userId: string; displayName: string | null; email: string | null };
  memberships: Array<{
    membershipId: string;
    organization: { organizationId: string; name: string; type: string };
    role: Role;
    accessPolicyId: string | null;
  }>;
}

export interface Session {
  me: Me;
  orgId: string;
  setOrgId: (id: string) => void;
  /** Vai trò tại organization đang chọn (tenant_admin tính ở mọi organization). */
  roles: ReadonlySet<Role>;
  /** Có ít nhất một membership bị access policy giới hạn tại organization đang chọn. */
  restricted: boolean;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionContext missing');
  return s;
}

export function organizationsOf(me: Me): Array<{ organizationId: string; name: string }> {
  const m = new Map<string, string>();
  for (const x of me.memberships) if (x.role !== 'tenant_admin') m.set(x.organization.organizationId, x.organization.name);
  for (const x of me.memberships) if (!m.has(x.organization.organizationId)) m.set(x.organization.organizationId, x.organization.name);
  return [...m].map(([organizationId, name]) => ({ organizationId, name }));
}

export function rolesAt(me: Me, orgId: string): Set<Role> {
  return new Set(me.memberships.filter((m) => m.organization.organizationId === orgId || m.role === 'tenant_admin').map((m) => m.role));
}

export const ROLE_LABEL: Record<Role, string> = {
  doctor: 'Bác sĩ',
  pharmacist: 'Dược sĩ',
  patient: 'Bệnh nhân',
  clinic_staff: 'Điều dưỡng / lễ tân',
  cashier: 'Thu ngân',
  clinic_admin: 'Quản lý phòng khám',
  pharmacy_admin: 'Quản lý kho dược',
  executive: 'Ban giám đốc',
  tenant_admin: 'Quản trị hệ thống',
  system: 'Hệ thống',
};

/** Menu nào hiện với vai trò nào — CHỈ để hiển thị; server mới là nơi quyết định quyền. */
export const can = {
  patients: (r: ReadonlySet<Role>) => ['clinic_staff', 'clinic_admin', 'doctor', 'pharmacist'].some((x) => r.has(x as Role)),
  registerPatient: (r: ReadonlySet<Role>) => ['clinic_staff', 'clinic_admin', 'doctor'].some((x) => r.has(x as Role)),
  openEncounter: (r: ReadonlySet<Role>) => r.has('doctor'),
  pharmacy: (r: ReadonlySet<Role>) => r.has('pharmacist') || r.has('pharmacy_admin'),
  admin: (r: ReadonlySet<Role>) => r.has('tenant_admin'),
  queue: (r: ReadonlySet<Role>) => ['doctor', 'clinic_staff', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  issueTicket: (r: ReadonlySet<Role>) => r.has('clinic_staff') || r.has('clinic_admin'),
  finance: (r: ReadonlySet<Role>) => ['clinic_staff', 'cashier', 'clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  reports: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  forecast: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin', 'pharmacy_admin'].some((x) => r.has(x as Role)),
  bookings: (r: ReadonlySet<Role>) => ['clinic_staff', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  integrations: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  decision: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  handover: (r: ReadonlySet<Role>) => ['pharmacist', 'clinic_staff', 'cashier', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  handoverManage: (r: ReadonlySet<Role>) => r.has('clinic_admin') || r.has('tenant_admin'),
  notifications: (r: ReadonlySet<Role>) =>
    ['doctor', 'pharmacist', 'clinic_staff', 'cashier', 'clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
};
