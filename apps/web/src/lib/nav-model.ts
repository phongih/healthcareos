/**
 * Giao diện đợt 2 | Danh mục ứng dụng + ghim mặc định + tìm không dấu (TS thuần — dùng được trong test).
 * Chỉ để hiển thị; máy chủ vẫn kiểm tra quyền ở từng API.
 */
import type { IconName } from './icon-names';
import { can, type Role } from './roles';

export type AppKey =
  | 'today' | 'patients' | 'queue' | 'bookings' | 'handover' | 'equipment' | 'pharmacy' | 'finance'
  | 'reports' | 'forecast' | 'decision' | 'staff' | 'review' | 'governance' | 'integrations' | 'admin';

export interface AppDef {
  key: AppKey;
  hash: string;
  label: string;
  group: string;
  icon: IconName;
  /** Từ khoá tìm thêm (không dấu cũng được). */
  keywords: string;
  allowed: (r: ReadonlySet<Role>) => boolean;
  /** Tên route (main.tsx) thuộc ứng dụng này — để tô mục đang mở. */
  routes: readonly string[];
}

/** Nhóm '' = mục chung đứng đầu, không có nhãn nhóm (vd. "Hôm nay"). */
export const GROUPS = ['', 'Tiếp đón', 'Khám & thiết bị', 'Dược', 'Tài chính', 'Báo cáo & cảnh báo', 'Quản trị'] as const;

export const APPS: readonly AppDef[] = [
  { key: 'today', hash: '#/today', label: 'Hôm nay', group: '', icon: 'sun', keywords: 'hom nay tong quan viec can lam workspace', allowed: can.today, routes: ['today'] },
  { key: 'patients', hash: '#/patients', label: 'Bệnh nhân', group: 'Tiếp đón', icon: 'users', keywords: 'ho so dang ky tim benh an dang kham mrn', allowed: can.patients, routes: ['patients', 'patient', 'encounter'] },
  { key: 'queue', hash: '#/queue', label: 'Hàng đợi', group: 'Tiếp đón', icon: 'queue', keywords: 'cap so goi so tv man hinh phong kham', allowed: can.queue, routes: ['queue'] },
  { key: 'bookings', hash: '#/bookings', label: 'Lịch hẹn', group: 'Tiếp đón', icon: 'calendar', keywords: 'dat lich online check-in hen', allowed: can.bookings, routes: ['bookings'] },
  { key: 'handover', hash: '#/handover', label: 'Quầy trả', group: 'Tiếp đón', icon: 'handover', keywords: 'tra thuoc tra ket qua quay', allowed: can.handover, routes: ['handover'] },
  { key: 'equipment', hash: '#/equipment', label: 'Thiết bị & vật tư', group: 'Khám & thiết bị', icon: 'monitor', keywords: 'may bao tri vat tu tieu hao kiem dinh', allowed: can.equipment, routes: ['equipment', 'device'] },
  { key: 'pharmacy', hash: '#/pharmacy', label: 'Dược', group: 'Dược', icon: 'pill', keywords: 'thuoc kho don thuoc cap phat lo han dung', allowed: can.pharmacy, routes: ['pharmacy'] },
  { key: 'finance', hash: '#/finance', label: 'Thu ngân', group: 'Tài chính', icon: 'wallet', keywords: 'thu tien tam ung hoa don phieu thu ca bang gia vietqr', allowed: can.finance, routes: ['finance', 'financeCase', 'financeShift'] },
  { key: 'reports', hash: '#/reports', label: 'Báo cáo', group: 'Báo cáo & cảnh báo', icon: 'chart', keywords: 'doanh thu thong ke luot kham', allowed: can.reports, routes: ['reports'] },
  { key: 'forecast', hash: '#/forecast', label: 'Dự báo', group: 'Báo cáo & cảnh báo', icon: 'trend', keywords: 'du bao tai ton kho qua tai', allowed: can.forecast, routes: ['forecast'] },
  { key: 'decision', hash: '#/decision', label: 'Decision Engine', group: 'Báo cáo & cảnh báo', icon: 'spark', keywords: 'canh bao luat quy tac thong bao', allowed: can.decision, routes: ['decision'] },
  { key: 'staff', hash: '#/staff', label: 'Nhân sự', group: 'Quản trị', icon: 'idcard', keywords: 'nhan vien tai khoan vai tro co so phan quyen', allowed: can.staff, routes: ['staff'] },
  { key: 'review', hash: '#/review', label: 'Duyệt tổ chức', group: 'Quản trị', icon: 'check', keywords: 'duyet to chuc dang ky moi gpkd gia phep', allowed: can.platformReview, routes: ['review'] },
  { key: 'governance', hash: '#/governance', label: 'Quản trị dữ liệu', group: 'Quản trị', icon: 'shield', keywords: 'du lieu ca nhan xoa luu tru nhat ky audit', allowed: can.governance, routes: ['governance'] },
  { key: 'integrations', hash: '#/integrations', label: 'Tích hợp', group: 'Quản trị', icon: 'plug', keywords: 'teams webhook doi tac api', allowed: can.integrations, routes: ['integrations'] },
  { key: 'admin', hash: '#/admin', label: 'Quản trị', group: 'Quản trị', icon: 'gear', keywords: 'cai dat he thong khoa ma hoa', allowed: can.admin, routes: ['admin'] },
];

/** Ghim mặc định theo vai trò (vai trò đứng trước được ưu tiên khi người dùng có nhiều vai trò). */
const ROLE_PINS: ReadonlyArray<[Role, AppKey[]]> = [
  ['tenant_admin', ['patients', 'queue', 'reports', 'staff']],
  ['clinic_admin', ['patients', 'queue', 'reports', 'staff']],
  ['executive', ['reports', 'forecast', 'finance', 'decision']],
  ['doctor', ['patients', 'queue', 'equipment']],
  ['clinic_staff', ['today', 'patients', 'queue', 'bookings']],
  ['pharmacy_admin', ['pharmacy', 'forecast', 'equipment', 'handover']],
  ['pharmacist', ['pharmacy', 'handover', 'patients']],
  ['cashier', ['finance', 'handover']],
];
export const MAX_PINS = 4;

export function allowedApps(roles: ReadonlySet<Role>): AppDef[] {
  return APPS.filter((a) => a.allowed(roles));
}

export function defaultPins(roles: ReadonlySet<Role>): AppKey[] {
  const allowed = new Set(allowedApps(roles).map((a) => a.key));
  const first = ROLE_PINS.find(([r]) => roles.has(r));
  const out = (first?.[1] ?? []).filter((k) => allowed.has(k));
  for (const a of APPS) if (out.length < MAX_PINS && allowed.has(a.key) && !out.includes(a.key)) out.push(a.key);
  return out.slice(0, MAX_PINS);
}

/** Bỏ dấu tiếng Việt + chữ thường, để tìm "thu ngan" ra "Thu ngân". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
}

export function matchApps(apps: readonly AppDef[], q: string): AppDef[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [...apps];
  // Mỗi từ gõ phải là ĐẦU của một từ trong tên / nhóm / từ khoá ("kho" khớp "kho", không khớp "tài khoản").
  // Có ứng dụng khớp ĐÚNG cả từ thì chỉ trả các ứng dụng đó (gõ đủ "kho" => Dược, Dự báo; không lẫn "khoá", "khoản").
  const hayOf = (a: AppDef) => `${fold(a.label)} ${a.keywords} ${fold(a.group)}`.split(/[\s&/-]+/);
  const exact = apps.filter((a) => words.every((w) => hayOf(a).includes(w)));
  if (exact.length) return exact;
  return apps.filter((a) => words.every((w) => hayOf(a).some((h) => h.startsWith(w))));
}

