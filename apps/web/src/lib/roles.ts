/** Vai trò + menu theo vai trò (TS thuần, không React — dùng được cả trong test). CHỈ để hiển thị; máy chủ mới quyết định quyền. */
export type Role =
  | 'doctor' | 'pharmacist' | 'patient' | 'clinic_staff' | 'cashier' | 'clinic_admin' | 'pharmacy_admin' | 'executive' | 'tenant_admin' | 'system';

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
  /** F21: nhân sự & cơ sở (quản lý cơ sở: cơ sở mình; quản trị hệ thống: mọi nơi). */
  staff: (r: ReadonlySet<Role>) => r.has('clinic_admin') || r.has('tenant_admin'),
  /** F18: duyệt tổ chức đăng ký mới — chỉ hiển thị cho quản trị hệ thống; máy chủ kiểm tra người vận hành. */
  platformReview: (r: ReadonlySet<Role>) => r.has('tenant_admin'),
  queue: (r: ReadonlySet<Role>) => ['doctor', 'clinic_staff', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  issueTicket: (r: ReadonlySet<Role>) => r.has('clinic_staff') || r.has('clinic_admin'),
  finance: (r: ReadonlySet<Role>) => ['clinic_staff', 'cashier', 'clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  reports: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  forecast: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin', 'pharmacy_admin'].some((x) => r.has(x as Role)),
  bookings: (r: ReadonlySet<Role>) => ['clinic_staff', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  integrations: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  decision: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  handover: (r: ReadonlySet<Role>) => ['pharmacist', 'clinic_staff', 'cashier', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  governance: (r: ReadonlySet<Role>) => ['clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  /** F16: xem bản rõ SĐT / email / CCCD (server kiểm tra pii:reveal tại cơ sở của bản ghi). */
  revealPii: (r: ReadonlySet<Role>) => ['clinic_staff', 'clinic_admin', 'doctor'].some((x) => r.has(x as Role)),
  keysManage: (r: ReadonlySet<Role>) => r.has('tenant_admin'),
  /** F17: lập yêu cầu xoá dữ liệu theo đề nghị người bệnh (cần người thứ hai duyệt). */
  erasureRequest: (r: ReadonlySet<Role>) => r.has('clinic_staff') || r.has('clinic_admin'),
  retention: (r: ReadonlySet<Role>) => ['clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  handoverManage: (r: ReadonlySet<Role>) => r.has('clinic_admin') || r.has('tenant_admin'),
  /** F19: thiết bị & vật tư (server kiểm tra equipment:* / supply:* tại cơ sở). */
  equipment: (r: ReadonlySet<Role>) =>
    ['doctor', 'clinic_staff', 'pharmacy_admin', 'clinic_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
  supplies: (r: ReadonlySet<Role>) => ['pharmacy_admin', 'clinic_admin', 'executive', 'tenant_admin', 'cashier'].some((x) => r.has(x as Role)),
  /** F20: cổng bệnh nhân — liên kết giám hộ, phiên, yêu cầu đính chính (server kiểm tra portal:manage / portal:requests). */
  /** Giao diện đợt 3: màn "Hôm nay" (hiện có workspace lễ tân / điều dưỡng). */
  today: (r: ReadonlySet<Role>) => r.has('clinic_staff') || r.has('doctor') || r.has('cashier'),
  portalManage: (r: ReadonlySet<Role>) => ['clinic_staff', 'clinic_admin', 'tenant_admin'].some((x) => r.has(x as Role)),
  recordLot: (r: ReadonlySet<Role>) => r.has('doctor') || r.has('clinic_staff'),
  notifications: (r: ReadonlySet<Role>) =>
    ['doctor', 'pharmacist', 'clinic_staff', 'cashier', 'clinic_admin', 'pharmacy_admin', 'executive', 'tenant_admin'].some((x) => r.has(x as Role)),
};
