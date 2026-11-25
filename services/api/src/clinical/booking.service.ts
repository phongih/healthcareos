/**
 * HCOS-F7 | Đặt lịch khám online (không tài khoản) + lễ tân check-in cấp số.
 *
 * PublicBookingService (KHÔNG đăng nhập; route /api/public/booking/<slug>):
 *   options   các buổi còn chỗ (hôm nay tới 14 ngày, trừ Chủ nhật; sáng đóng 11:00, chiều đóng 16:00 giờ VN)
 *   create    tạo lịch => trả MÃ ĐẶT LỊCH một lần (DB chỉ lưu SHA-256); giữ chỗ nguyên tử theo sức chứa buổi
 *   lookup    tra theo mã + số điện thoại (cả hai phải khớp); chỉ trả trạng thái / buổi / phòng / tên gọi
 *   cancel    huỷ theo mã + số điện thoại (trước khi buổi bắt đầu kết thúc nhận lịch)
 *   Cổng chỉ GHI: không bao giờ trả hồ sơ bệnh nhân. Cổng được tra theo slug qua hàm DB clinical.booking_portal
 *   (SECURITY DEFINER); mọi thao tác khác chạy dưới tenant context của cơ sở (RLS FORCE), actor audit = service.
 *
 * BookingService (nhân viên, đã đăng nhập):
 *   listForDay / findByCode / getById (booking:read) — kèm hồ sơ cũ có thể trùng (CCCD, họ tên + ngày sinh, SĐT + ngày sinh)
 *   checkIn (queue:issue) — gắn hồ sơ + cấp số vào phòng đã đặt, trong CÙNG transaction
 *   cancel (queue:issue); cấu hình sức chứa + cổng (queue:manage)
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';

import {
  isUuid,
  TenantIsolationError,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type PatientId,
  type Role,
  type TenantContext,
  type TenantId,
  type TenantScopedDb,
  type User,
  type UserId,
} from '../../../../packages/domain/src/s0-contracts';
import { nameKey, normalizePhone } from '../../../../packages/domain/src/person-registry';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessDecision, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import { assertOrganizationAllowed, assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { sameIndex } from '../../../../packages/security/src/pii';
import { ClinicalError, iso, isoOrNull, num, translatePgError } from './encounter.service';
import { PgQueueRepository, PRIORITY_REASONS, type PriorityReason, type QueueTicket, type ServicePoint, type TicketView } from './queue.service';

// ---------------------------------------------------------------------------
// Hằng số / tiện ích thời gian (giờ Việt Nam)
// ---------------------------------------------------------------------------
export type Period = 'morning' | 'afternoon';
export const PERIODS: readonly Period[] = ['morning', 'afternoon'];
/** Giờ đóng nhận lịch trong ngày (phút từ 00:00 giờ VN). */
const CUTOFF: Record<Period, number> = { morning: 11 * 60, afternoon: 16 * 60 };
const BOOKING_DAYS = 14;
const TZ = 'Asia/Ho_Chi_Minh';

export const CONSENT_VERSION = '2026-11';
export const CONSENT_TEXT =
  'Tôi đồng ý để cơ sở khám bệnh thu thập và xử lý họ tên, ngày sinh, giới tính, số điện thoại, số CCCD (nếu cung cấp) ' +
  'và lý do khám của tôi chỉ nhằm mục đích đặt lịch và tiếp nhận khám bệnh, theo quy định của pháp luật về bảo vệ dữ liệu cá nhân. ' +
  'Tôi có thể huỷ lịch bằng mã đặt lịch và số điện thoại.';

/** Ngày (YYYY-MM-DD) và phút trong ngày theo giờ VN. */
export function vnNow(d: Date): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts['weekday']!);
  return { date: `${parts['year']}-${parts['month']}-${parts['day']}`, minutes: Number(parts['hour']) % 24 * 60 + Number(parts['minute']), weekday: wd };
}
const addDays = (date: string, n: number): string => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Buổi còn nhận lịch? (không Chủ nhật; hôm nay: trước giờ đóng; tối đa 14 ngày tới) */
export function periodOpen(date: string, period: Period, now: Date): boolean {
  const v = vnNow(now);
  if (date < v.date || date > addDays(v.date, BOOKING_DAYS)) return false;
  if (weekdayOf(date) === 0) return false;
  return date > v.date || v.minutes < CUTOFF[period];
}

// Mã đặt lịch: 8 ký tự, hiển thị dạng XXXX-XXXX.
// Bảng ký tự KHÔNG có nguyên âm (A E I O U Y), D và W: máy quét QR ở quầy thường gõ như bàn phím, nếu máy tính lễ tân đang bật
// bộ gõ tiếng Việt (Telex / VNI) thì chữ sau nguyên âm (s f r x j, chữ số), "dd", "w" sẽ bị biến thành dấu => sai mã.
// Không có nguyên âm thì bộ gõ không đổi gì. Cũng bỏ các ký tự dễ nhầm (0/O, 1/I/L).
const ALPHABET = 'BCFGHJKMNPQRSTVXZ23456789';
/** Mã đã phát trước khi đổi bảng ký tự (HCOS-F7 bản đầu) vẫn tra được. */
const LEGACY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newBookingCode = (): string => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
export const normalizeCode = (raw: string): string | null => {
  const c = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every((ch) => LEGACY_ALPHABET.includes(ch)) ? c : null;
};
export const formatCode = (c: string): string => `${c.slice(0, 4)}-${c.slice(4)}`;
const codeHash = (c: string): Buffer => createHash('sha256').update(c, 'utf8').digest();

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------
export type BookingStatus = 'booked' | 'checked_in' | 'cancelled' | 'no_show';
export interface Booking {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly organizationId: OrganizationId;
  readonly servicePointId: string;
  readonly visitDate: string;
  readonly period: Period;
  readonly familyName: string;
  readonly givenName: string;
  readonly birthDate: string;
  readonly sex: 'male' | 'female' | 'other' | 'unknown';
  /** HCOS-F16: khi đọc từ CSDL là dạng che (091****678); bản rõ chỉ có ở đầu vào. */
  readonly phone: string;
  readonly nationalId: string | null;
  /** Blind index (so khớp hồ sơ cũ, tra cứu công khai). */
  readonly phoneIndex?: string | null;
  readonly nationalIdIndex?: string | null;
  readonly reason: string | null;
  readonly consentVersion: string;
  readonly consentAt: string;
  readonly status: BookingStatus;
  readonly patientId: PatientId | null;
  readonly ticketId: string | null;
  readonly checkedInAt: string | null;
  readonly cancelledBy: 'patient' | 'staff' | null;
  readonly createdAt: string;
  readonly version: number;
}
export interface BookingView extends Booking {
  readonly servicePointCode: string;
  readonly servicePointName: string;
  /** F17: đã ẩn danh (hết hạn lưu / xoá theo yêu cầu) — mọi trường định danh trống. */
  readonly erasedAt?: string | null;
}
export type MatchKind = 'national_id' | 'phone_birthdate' | 'name_birthdate' | 'phone';
const MATCH_ORDER: readonly MatchKind[] = ['national_id', 'phone_birthdate', 'name_birthdate', 'phone'];
export interface PatientCandidate {
  readonly patientId: PatientId;
  readonly mrn: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly birthDate: string | null;
  /** Theo độ tin cậy giảm dần: CCCD > SĐT + ngày sinh > họ tên + ngày sinh > chỉ SĐT (có thể là người nhà dùng chung số). */
  readonly matchedBy: ReadonlyArray<MatchKind>;
}
export interface BookingPortal {
  readonly portalId: string;
  readonly organizationId: OrganizationId;
  readonly slug: string;
  readonly isActive: boolean;
  readonly version: number;
}
export interface PublicOptions {
  readonly organizationName: string;
  readonly consentVersion: string;
  readonly consentText: string;
  readonly rooms: ReadonlyArray<{ servicePointId: string; code: string; name: string }>;
  readonly slots: ReadonlyArray<{ servicePointId: string; date: string; period: Period; remaining: number }>;
}
export interface PublicCreateInput {
  readonly servicePointId: string;
  readonly visitDate: string;
  readonly period: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly birthDate: string;
  readonly sex: string;
  readonly phone: string;
  readonly nationalId?: string | null;
  readonly reason?: string | null;
  readonly consent: boolean;
  readonly consentVersion: string;
  /** Trường bẫy bot: người thật không thấy, phải để trống. */
  readonly website?: string;
}
export interface PublicBookingResult {
  readonly code: string;
  readonly visitDate: string;
  readonly period: Period;
  readonly servicePointName: string;
  readonly organizationName: string;
}
export interface PublicLookupResult {
  readonly status: BookingStatus;
  readonly visitDate: string;
  readonly period: Period;
  readonly servicePointName: string;
  readonly givenName: string;
}

// ---------------------------------------------------------------------------
// Repository (dùng chung cho cổng công khai và nhân viên)
// ---------------------------------------------------------------------------
const B_COLS =
  "b.booking_id, b.tenant_id, b.organization_id, b.service_point_id, b.visit_date::text AS visit_date, b.period, " +
  "COALESCE(b.family_name, '(đã ẩn danh)') AS family_name, COALESCE(b.given_name, '') AS given_name, " +
  "COALESCE(b.birth_date::text, '') AS birth_date, COALESCE(b.sex, 'unknown') AS sex, b.erased_at, " +
  'COALESCE(b.phone_hint, keyvault.mask_phone(b.phone)) AS phone, ' +
  'COALESCE(b.national_id_hint, keyvault.mask_identifier(b.national_id)) AS national_id, b.phone_bidx, b.national_id_bidx, ' +
  'b.reason, b.consent_version, b.consent_at, b.status, b.patient_id, b.ticket_id, ' +
  'b.checked_in_at, b.cancelled_by, b.created_at, b.version, sp.code AS sp_code, sp.name AS sp_name';
/* eslint-disable @typescript-eslint/no-explicit-any */
const mapBooking = (r: any): BookingView => ({
  tenantId: r.tenant_id, bookingId: r.booking_id, organizationId: r.organization_id, servicePointId: r.service_point_id,
  visitDate: String(r.visit_date), period: r.period, familyName: r.family_name, givenName: r.given_name, birthDate: String(r.birth_date),
  sex: r.sex, phone: r.phone, nationalId: r.national_id ?? null, phoneIndex: r.phone_bidx ?? null, nationalIdIndex: r.national_id_bidx ?? null,
  reason: r.reason ?? null, consentVersion: r.consent_version,
  consentAt: iso(r.consent_at), status: r.status, patientId: r.patient_id ?? null, ticketId: r.ticket_id ?? null,
  checkedInAt: isoOrNull(r.checked_in_at), cancelledBy: r.cancelled_by ?? null, createdAt: iso(r.created_at), version: num(r.version),
  servicePointCode: r.sp_code, servicePointName: r.sp_name, erasedAt: isoOrNull(r.erased_at),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgBookingRepository extends PgQueueRepository {
  constructor(db: TenantScopedDb) {
    super(db);
  }

  /** HCOS-F20: lịch tạo tiếp theo trong transaction này là của person đặt qua cổng bệnh nhân. */
  async markPortalPerson(personId: string): Promise<void> {
    await this.db.query("SELECT set_config('app.portal_booking_person', $1, true)", [personId]);
  }

  async listBookableServicePoints(organizationId: OrganizationId): Promise<ServicePoint[]> {
    return (await this.listServicePoints(organizationId)).filter((sp) => sp.isActive && sp.bookingCapacity > 0);
  }

  async countersBetween(organizationId: OrganizationId, from: string, to: string): Promise<Array<{ servicePointId: string; date: string; period: Period; booked: number }>> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT c.service_point_id, c.visit_date::text AS visit_date, c.period, c.booked
         FROM clinical.booking_counters c JOIN clinical.service_points sp ON sp.tenant_id = c.tenant_id AND sp.service_point_id = c.service_point_id
        WHERE c.tenant_id = $1 AND sp.organization_id = $2 AND c.visit_date BETWEEN $3::date AND $4::date`,
      [this.t, organizationId, from, to],
    );
    return r.rows.map((x) => ({ servicePointId: x['service_point_id'] as string, date: x['visit_date'] as string, period: x['period'] as Period, booked: num(x['booked']) }));
  }

  /** Giữ một chỗ nguyên tử; false nếu buổi đã đầy. */
  async reserveSlot(servicePointId: string, date: string, period: Period, capacity: number): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO clinical.booking_counters (tenant_id, service_point_id, visit_date, period, booked) VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (tenant_id, service_point_id, visit_date, period)
       DO UPDATE SET booked = clinical.booking_counters.booked + 1 WHERE clinical.booking_counters.booked < $5
       RETURNING booked`,
      [this.t, servicePointId, date, period, capacity],
    );
    return r.rows.length > 0;
  }

  async releaseSlot(servicePointId: string, date: string, period: Period): Promise<void> {
    await this.db.query(
      `UPDATE clinical.booking_counters SET booked = booked - 1
        WHERE tenant_id = $1 AND service_point_id = $2 AND visit_date = $3 AND period = $4 AND booked > 0`,
      [this.t, servicePointId, date, period],
    );
  }

  /** HCOS-F16: blind index SĐT (tra cứu công khai bằng mã + SĐT). */
  indexPhone(phone: string): Promise<string> {
    return this.pii.index('phone', phone);
  }

  /** HCOS-F16: giải mã SĐT / CCCD của lịch hẹn — CHỈ dùng nội bộ khi tạo hồ sơ từ lịch hẹn (không trả ra API). */
  async openContact(id: string): Promise<{ phone: string | null; nationalId: string | null }> {
    const r = await this.db.query<Record<string, string | null>>(
      `SELECT phone, national_id, phone_enc, national_id_enc FROM clinical.bookings WHERE tenant_id = $1 AND booking_id = $2`,
      [this.t, id],
    );
    const x = r.rows[0];
    if (!x) return { phone: null, nationalId: null };
    return {
      phone: x['phone_enc'] ? await this.pii.open('phone', x['phone_enc'], { kind: 'booking', id }) : (x['phone'] ?? null),
      nationalId: x['national_id_enc'] ? await this.pii.open('identifier', x['national_id_enc'], { kind: 'booking', id }) : (x['national_id'] ?? null),
    };
  }

  async insertBooking(b: Booking, hash: Buffer): Promise<void> {
    // HCOS-F16/F17: SĐT và CCCD chỉ lưu bản mã, bằng khoá riêng của lịch hẹn (huỷ khoá khi ẩn danh / xoá theo yêu cầu).
    const phone = await this.pii.protect('phone', b.phone, { kind: 'booking', id: b.bookingId });
    const nid = await this.pii.protect('identifier', b.nationalId, { kind: 'booking', id: b.bookingId });
    try {
      await this.db.query(
        `INSERT INTO clinical.bookings (booking_id, tenant_id, organization_id, service_point_id, visit_date, period, code_hash, family_name, given_name,
           birth_date, sex, phone_enc, phone_bidx, phone_hint, national_id_enc, national_id_bidx, national_id_hint, reason, consent_version, consent_at)
         VALUES ($1, $2, $3, $4, $5, $6, decode($7, 'hex'), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [b.bookingId, b.tenantId, b.organizationId, b.servicePointId, b.visitDate, b.period, hash.toString('hex'), b.familyName, b.givenName,
         b.birthDate, b.sex, phone.enc, phone.bidx, phone.hint, nid.enc, nid.bidx, nid.hint, b.reason, b.consentVersion, b.consentAt],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async findBookingByCode(organizationId: OrganizationId, hash: Buffer): Promise<BookingView | null> {
    const r = await this.db.query(
      `SELECT ${B_COLS} FROM clinical.bookings b JOIN clinical.service_points sp ON sp.tenant_id = b.tenant_id AND sp.service_point_id = b.service_point_id
        WHERE b.tenant_id = $1 AND b.organization_id = $2 AND b.code_hash = decode($3, 'hex')`,
      [this.t, organizationId, hash.toString('hex')],
    );
    return r.rows[0] ? mapBooking(r.rows[0]) : null;
  }

  async findBooking(id: string): Promise<BookingView | null> {
    const r = await this.db.query(
      `SELECT ${B_COLS} FROM clinical.bookings b JOIN clinical.service_points sp ON sp.tenant_id = b.tenant_id AND sp.service_point_id = b.service_point_id
        WHERE b.tenant_id = $1 AND b.booking_id = $2`,
      [this.t, id],
    );
    return r.rows[0] ? mapBooking(r.rows[0]) : null;
  }

  async listBookingsForDay(organizationId: OrganizationId, date: string): Promise<BookingView[]> {
    const r = await this.db.query(
      `SELECT ${B_COLS} FROM clinical.bookings b JOIN clinical.service_points sp ON sp.tenant_id = b.tenant_id AND sp.service_point_id = b.service_point_id
        WHERE b.tenant_id = $1 AND b.organization_id = $2 AND b.visit_date = $3
        ORDER BY CASE b.period WHEN 'morning' THEN 0 ELSE 1 END, sp.code, b.created_at LIMIT 500`,
      [this.t, organizationId, date],
    );
    return r.rows.map(mapBooking);
  }

  async updateBookingStatus(
    id: string,
    to: 'checked_in' | 'cancelled',
    f: { patientId?: string; ticketId?: string; checkedInBy?: string; cancelledBy?: 'patient' | 'staff' },
  ): Promise<BookingView | null> {
    const r = await this.db.query(
      `UPDATE clinical.bookings SET status = $3,
              patient_id = COALESCE($4::uuid, patient_id), ticket_id = COALESCE($5::uuid, ticket_id),
              checked_in_by = COALESCE($6::uuid, checked_in_by), checked_in_at = CASE WHEN $3 = 'checked_in' THEN now() ELSE checked_in_at END,
              cancelled_by = COALESCE($7, cancelled_by), cancelled_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE cancelled_at END
        WHERE tenant_id = $1 AND booking_id = $2 AND status = 'booked'
        RETURNING booking_id`,
      [this.t, id, to, f.patientId ?? null, f.ticketId ?? null, f.checkedInBy ?? null, f.cancelledBy ?? null],
    );
    return r.rows.length ? this.findBooking(id) : null;
  }

  /**
   * Hồ sơ cũ có thể là cùng người, xếp theo độ tin cậy: CCCD, SĐT + ngày sinh, họ tên + ngày sinh (không phân biệt dấu,
   * thứ tự họ/tên), chỉ SĐT. Khoá tên / SĐT dùng cùng hàm chuẩn hoá với Person Registry.
   */
  async findCandidates(organizationId: OrganizationId, b: Booking): Promise<PatientCandidate[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `WITH c AS (
         SELECT pt.patient_id, pt.mrn, ps.family_name, ps.given_name, ps.birth_date,
                ($3::text IS NOT NULL AND EXISTS (SELECT 1 FROM patient.identifiers i WHERE i.tenant_id = ps.tenant_id AND i.person_id = ps.person_id
                   AND i.type = 'national_id' AND i.status = 'active' AND i.value_bidx = $3)) AS by_id,
                ($6::text IS NOT NULL AND ps.phone_bidx = $6 AND ps.birth_date = $5::date) AS by_phone_dob,
                (ps.name_key = $4 AND ps.birth_date = $5::date) AS by_name,
                ($6::text IS NOT NULL AND ps.phone_bidx = $6) AS by_phone
           FROM patient.patients pt JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
          WHERE pt.tenant_id = $1 AND pt.organization_id = $2 AND pt.status = 'active' AND ps.status = 'active')
       SELECT patient_id, mrn, family_name, given_name, birth_date::text AS birth_date, by_id, by_phone_dob, by_name, by_phone
         FROM c WHERE by_id OR by_phone_dob OR by_name OR by_phone
        ORDER BY by_id DESC, by_phone_dob DESC, by_name DESC, by_phone DESC, mrn
        LIMIT 10`,
      [this.t, organizationId, b.nationalIdIndex ?? null, nameKey(b.givenName, b.familyName), b.birthDate, b.phoneIndex ?? null],
    );
    const t = (v: unknown) => v === true || v === 't';
    return r.rows.map((x) => {
      const hit: Record<MatchKind, boolean> = {
        national_id: t(x['by_id']), phone_birthdate: t(x['by_phone_dob']), name_birthdate: t(x['by_name']), phone: t(x['by_phone']) && !t(x['by_phone_dob']),
      };
      return {
        patientId: x['patient_id'] as PatientId, mrn: x['mrn'] as string, familyName: x['family_name'] as string, givenName: x['given_name'] as string,
        birthDate: (x['birth_date'] as string | null) ?? null, matchedBy: MATCH_ORDER.filter((k) => hit[k]),
      };
    });
  }

  async setBookingCapacity(servicePointId: string, capacity: number, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE clinical.service_points SET booking_capacity = $1 WHERE tenant_id = $2 AND service_point_id = $3 AND version = $4 RETURNING service_point_id`,
      [capacity, this.t, servicePointId, expectedVersion],
    );
    return r.rows.length > 0;
  }

  async findPortal(organizationId: OrganizationId): Promise<BookingPortal | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT portal_id, organization_id, slug, is_active, version FROM clinical.booking_portals WHERE tenant_id = $1 AND organization_id = $2`,
      [this.t, organizationId],
    );
    const x = r.rows[0];
    return x ? { portalId: x['portal_id'] as string, organizationId, slug: x['slug'] as string, isActive: x['is_active'] === true || x['is_active'] === 't', version: num(x['version']) } : null;
  }

  async insertPortal(p: BookingPortal & { tenantId: string; createdBy: UserId }): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO clinical.booking_portals (portal_id, tenant_id, organization_id, slug, created_by_user_id) VALUES ($1, $2, $3, $4, $5)`,
        [p.portalId, p.tenantId, p.organizationId, p.slug, p.createdBy],
      );
    } catch (e) {
      translatePgError(e);
    }
  }

  async setPortalActive(portalId: string, isActive: boolean, expectedVersion: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE clinical.booking_portals SET is_active = $1 WHERE tenant_id = $2 AND portal_id = $3 AND version = $4 RETURNING portal_id`,
      [isActive, this.t, portalId, expectedVersion],
    );
    return r.rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Kiểm tra dữ liệu người đặt
// ---------------------------------------------------------------------------
const NAME_RE = /^[\p{L}][\p{L} .'-]{0,99}$/u;
function validatePublicInput(i: PublicCreateInput, now: Date): Omit<Booking, 'tenantId' | 'bookingId' | 'organizationId' | 'status' | 'patientId' | 'ticketId' | 'checkedInAt' | 'cancelledBy' | 'createdAt' | 'version' | 'consentAt'> {
  const bad = (m: string, reason = 'INVALID_INPUT'): never => {
    throw new ClinicalError('VALIDATION', m, { reason });
  };
  if (i.website) bad('Rejected', 'REJECTED');
  if (i.consent !== true || i.consentVersion !== CONSENT_VERSION) bad('Consent is required', 'CONSENT_REQUIRED');
  if (typeof i.servicePointId !== 'string' || !isUuid(i.servicePointId)) bad('servicePointId must be a UUID');
  if (!(PERIODS as readonly string[]).includes(i.period)) bad('period must be morning or afternoon');
  if (typeof i.visitDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(i.visitDate)) bad('visitDate must be YYYY-MM-DD');
  const fam = String(i.familyName ?? '').trim().replace(/\s+/g, ' ');
  const giv = String(i.givenName ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(fam) || !NAME_RE.test(giv)) bad('Invalid name');
  const dob = String(i.birthDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob < '1900-01-01' || dob > vnNow(now).date) bad('Invalid birthDate');
  if (!['male', 'female', 'other', 'unknown'].includes(i.sex)) bad('Invalid sex');
  const phone = normalizePhone(i.phone);
  if (!phone || !/^0\d{9}$/.test(phone)) bad('Phone must be a 10-digit Vietnamese number', 'INVALID_PHONE');
  const nid = i.nationalId === undefined || i.nationalId === null || String(i.nationalId).trim() === '' ? null : String(i.nationalId).replace(/\s/g, '');
  if (nid !== null && !/^\d{12}$/.test(nid)) bad('CCCD must be 12 digits', 'INVALID_NATIONAL_ID');
  const reason = i.reason === undefined || i.reason === null ? null : String(i.reason).trim() || null;
  if (reason !== null && reason.length > 500) bad('reason too long');
  return {
    servicePointId: i.servicePointId.toLowerCase(), visitDate: i.visitDate, period: i.period as Period, familyName: fam, givenName: giv, birthDate: dob,
    sex: i.sex as Booking['sex'], phone: phone!, nationalId: nid, reason, consentVersion: CONSENT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Cổng công khai
// ---------------------------------------------------------------------------
interface PortalRef {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
}

export class PublicBookingService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async options(slug: string): Promise<PublicOptions | null> {
    const portal = await this.portal(slug);
    if (!portal) return null;
    return this.tx(portal, 'public.booking.options', async (repo) => {
      const now = this.clock();
      const today = vnNow(now).date;
      const last = addDays(today, BOOKING_DAYS);
      const rooms = await repo.listBookableServicePoints(portal.organizationId);
      const counters = await repo.countersBetween(portal.organizationId, today, last);
      const used = new Map(counters.map((c) => [`${c.servicePointId}|${c.date}|${c.period}`, c.booked]));
      const slots: Array<{ servicePointId: string; date: string; period: Period; remaining: number }> = [];
      for (let d = 0; d <= BOOKING_DAYS; d++) {
        const date = addDays(today, d);
        for (const period of PERIODS) {
          if (!periodOpen(date, period, now)) continue;
          for (const r of rooms) {
            const remaining = Math.max(0, r.bookingCapacity - (used.get(`${r.servicePointId}|${date}|${period}`) ?? 0));
            slots.push({ servicePointId: r.servicePointId, date, period, remaining });
          }
        }
      }
      return {
        value: {
          organizationName: portal.organizationName, consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT,
          rooms: rooms.map((r) => ({ servicePointId: r.servicePointId, code: r.code, name: r.name })), slots,
        },
        audit: null,
      };
    });
  }

  /** `opts.portalPersonId` (HCOS-F20): lịch đặt từ cổng bệnh nhân — gắn person (trigger đọc biến transaction). */
  async create(slug: string, input: PublicCreateInput, opts: { portalPersonId?: string } = {}): Promise<PublicBookingResult | null> {
    const portal = await this.portal(slug);
    if (!portal) return null;
    const now = this.clock();
    const v = validatePublicInput(input, now);
    if (!periodOpen(v.visitDate, v.period, now)) throw new ClinicalError('VALIDATION', 'This session is not open for booking', { reason: 'SESSION_CLOSED' });
    return this.tx(portal, 'public.booking.create', async (repo) => {
      const room = (await repo.listBookableServicePoints(portal.organizationId)).find((r) => r.servicePointId === v.servicePointId);
      if (!room) throw new ClinicalError('VALIDATION', 'Room is not open for online booking', { reason: 'ROOM_NOT_BOOKABLE' });
      if (!(await repo.reserveSlot(room.servicePointId, v.visitDate, v.period, room.bookingCapacity))) {
        throw new ClinicalError('CONFLICT', 'This session is fully booked', { reason: 'SESSION_FULL' });
      }
      if (opts.portalPersonId) await repo.markPortalPerson(opts.portalPersonId);
      const code = newBookingCode();
      const booking: Booking = {
        ...v, tenantId: portal.tenantId, bookingId: randomUUID(), organizationId: portal.organizationId, status: 'booked', patientId: null, ticketId: null,
        checkedInAt: null, cancelledBy: null, consentAt: now.toISOString(), createdAt: now.toISOString(), version: 1,
      };
      await repo.insertBooking(booking, codeHash(code)); // CONFLICT: PHONE_ALREADY_BOOKED
      return {
        value: { code: formatCode(code), visitDate: v.visitDate, period: v.period, servicePointName: room.name, organizationName: portal.organizationName },
        audit: { resourceId: booking.bookingId, payload: { servicePointId: room.servicePointId, visitDate: v.visitDate, period: v.period } },
      };
    });
  }

  async lookup(slug: string, code: string, phone: string): Promise<PublicLookupResult | null> {
    const portal = await this.portal(slug);
    const c = normalizeCode(code);
    const p = normalizePhone(phone);
    if (!portal || !c || !p) return null;
    return this.tx(portal, 'public.booking.lookup', async (repo) => {
      const b = await repo.findBookingByCode(portal.organizationId, codeHash(c));
      if (!b || !sameIndex(b.phoneIndex, await repo.indexPhone(p))) return { value: null, audit: null };
      return { value: { status: b.status, visitDate: b.visitDate, period: b.period, servicePointName: b.servicePointName, givenName: b.givenName }, audit: null };
    });
  }

  async cancel(slug: string, code: string, phone: string): Promise<PublicLookupResult | null> {
    const portal = await this.portal(slug);
    const c = normalizeCode(code);
    const p = normalizePhone(phone);
    if (!portal || !c || !p) return null;
    return this.tx(portal, 'public.booking.cancel', async (repo) => {
      const b = await repo.findBookingByCode(portal.organizationId, codeHash(c));
      if (!b || !sameIndex(b.phoneIndex, await repo.indexPhone(p))) return { value: null, audit: null };
      if (b.status !== 'booked') throw new ClinicalError('INVALID_STATE', `Booking is ${b.status}`, { reason: 'NOT_CANCELLABLE' });
      if (!periodOpen(b.visitDate, b.period, this.clock())) throw new ClinicalError('INVALID_STATE', 'Session already closed', { reason: 'NOT_CANCELLABLE' });
      const saved = await repo.updateBookingStatus(b.bookingId, 'cancelled', { cancelledBy: 'patient' });
      if (!saved) throw new ClinicalError('CONFLICT', 'Booking changed concurrently', { reason: 'BOOKING_CHANGED' });
      await repo.releaseSlot(b.servicePointId, b.visitDate, b.period);
      return {
        value: { status: saved.status, visitDate: saved.visitDate, period: saved.period, servicePointName: saved.servicePointName, givenName: saved.givenName },
        audit: { resourceId: b.bookingId, payload: {} },
      };
    });
  }

  private async portal(slug: string): Promise<PortalRef | null> {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) return null;
    const c = await this.deps.pool.connect();
    try {
      const r = (await c.query('SELECT tenant_id, organization_id, organization_name FROM clinical.booking_portal($1)', [slug])) as { rows: Array<Record<string, unknown>> };
      const x = r.rows[0];
      return x ? { tenantId: x['tenant_id'] as TenantId, organizationId: x['organization_id'] as OrganizationId, organizationName: x['organization_name'] as string } : null;
    } finally {
      c.release();
    }
  }

  private ctx(p: PortalRef): TenantContext {
    return Object.freeze({
      tenantId: p.tenantId, userSubject: 'service:public-booking', userId: null, personId: null, activeOrganizationId: p.organizationId,
      allowedOrganizationIds: Object.freeze([p.organizationId]), roles: Object.freeze([]), tokenId: null, correlationId: randomUUID() as CorrelationId,
    });
  }

  private async tx<T>(
    p: PortalRef,
    action: string,
    fn: (repo: PgBookingRepository) => Promise<{ value: T; audit: { resourceId: string; payload: Record<string, unknown> } | null }>,
  ): Promise<T> {
    const ctx = this.ctx(p);
    const event = (outcome: NewAuditEvent['outcome'], resourceId: string | null, payload: Record<string, unknown>): NewAuditEvent => ({
      eventId: randomUUID() as AuditEventId, tenantId: p.tenantId, actor: { type: 'service', id: 'public-booking' }, organizationId: p.organizationId,
      action, resourceType: 'Booking', resourceId, personId: null, patientId: null, outcome, correlationId: ctx.correlationId, sourceIp: null, userAgent: null, payload,
    });
    try {
      return await withTenantTransaction(
        this.deps.pool,
        async (db) => {
          await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
          const repo = new PgBookingRepository(db);
          const r = await fn(repo);
          if (r.audit) await repo.appendAudit(event('success', r.audit.resourceId, r.audit.payload));
          return r.value;
        },
        ctx,
      );
    } catch (e) {
      if (e instanceof ClinicalError) {
        const reason = typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
        try {
          await this.deps.audit.record(event('failure', null, { code: e.code, ...(reason ? { reason } : {}) }));
        } catch {
          /* bỏ qua */
        }
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Nhân viên
// ---------------------------------------------------------------------------
type Permission = 'booking:read' | 'queue:issue' | 'queue:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'booking:read': ['clinic_staff', 'clinic_admin'],
  'queue:issue': ['clinic_staff', 'clinic_admin'],
  'queue:manage': ['clinic_admin', 'tenant_admin'],
};
type AllowedDecision = Extract<AccessDecision, { allowed: true }>;
interface Principal { readonly user: User; readonly grants: readonly AccessGrant[] }
interface AuditMeta { readonly action: string; readonly resourceId?: string; readonly patientId?: PatientId; readonly organizationId?: OrganizationId }

export interface BookingUnitOfWork {
  run<T>(ctx: TenantContext, fn: (repo: PgBookingRepository) => Promise<T>): Promise<T>;
}
export class PgBookingUnitOfWork implements BookingUnitOfWork {
  constructor(private readonly pool: PgPoolLike) {}
  run<T>(ctx: TenantContext, fn: (repo: PgBookingRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      this.pool,
      async (db) => {
        await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
        return fn(new PgBookingRepository(db));
      },
      ctx,
    );
  }
}

/** Tạo người bệnh + hồ sơ tại cơ sở (Person Registry) — tiêm từ ngoài để tái dùng kiểm tra trùng / cấp MRN. */
export type PatientRegistrar = (
  input: {
    organizationId: OrganizationId;
    mrn?: string;
    person: { givenName: string; familyName: string; birthDate: string; sex: Booking['sex']; phone: string | null; identifiers: Array<{ type: 'national_id'; system: string; value: string }> };
  },
  ctx: TenantContext,
) => Promise<{ patient: { patientId: string; mrn: string } }>;

export const CCCD_SYSTEM = 'https://moh.gov.vn/cccd';

export class BookingService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { uow: BookingUnitOfWork; audit: AuditSink; clock?: () => Date; registrar?: PatientRegistrar }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * HCOS-F16: tạo hồ sơ người bệnh từ lịch hẹn MÀ KHÔNG đưa SĐT / CCCD bản rõ ra trình duyệt. Server giải mã trong bộ nhớ rồi
   * chuyển cho Person Registry (kiểm tra trùng, cấp MRN, mã hoá lại). Quyền: như check-in (queue:issue).
   */
  async registerPatient(bookingId: string, input: { mrn?: string | null }, ctx: TenantContext = requireTenantContext()): Promise<{ patientId: string; mrn: string }> {
    if (!this.deps.registrar) throw new ClinicalError('INVALID_STATE', 'Patient registration is not configured');
    const prepared = await this.tx(ctx, { action: 'booking.register_patient', resourceId: bookingId }, async (repo) => {
      const b = await this.loadBooking(repo, ctx, bookingId);
      const p = await this.principal(repo, ctx, b.organizationId);
      this.decide(p, 'queue:issue');
      if (b.status !== 'booked') throw new ClinicalError('INVALID_STATE', `Booking is ${b.status}`, { reason: 'BOOKING_NOT_ACTIVE' });
      const contact = await repo.openContact(b.bookingId);
      await repo.appendAudit(this.event(ctx, { action: 'booking.register_patient', resourceId: b.bookingId, organizationId: b.organizationId }, 'success', p.user, {
        decrypted: ['phone', ...(contact.nationalId ? ['nationalId'] : [])], purpose: 'create_patient_record',
      }));
      return { b, contact };
    });
    const { b, contact } = prepared;
    const mrn = typeof input.mrn === 'string' && input.mrn.trim() ? input.mrn.trim() : undefined;
    const r = await this.deps.registrar(
      {
        organizationId: b.organizationId,
        ...(mrn ? { mrn } : {}),
        person: {
          givenName: b.givenName, familyName: b.familyName, birthDate: b.birthDate, sex: b.sex, phone: contact.phone,
          identifiers: contact.nationalId ? [{ type: 'national_id', system: CCCD_SYSTEM, value: contact.nationalId }] : [],
        },
      },
      ctx,
    );
    return { patientId: r.patient.patientId, mrn: r.patient.mrn };
  }

  async listForDay(q: { organizationId: string; date?: string }, ctx: TenantContext = requireTenantContext()): Promise<BookingView[]> {
    return this.tx(ctx, { action: 'booking.list' }, async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      const date = q.date ?? vnNow(this.clock()).date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ClinicalError('VALIDATION', 'date must be YYYY-MM-DD');
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'booking:read');
      const list = (await repo.listBookingsForDay(org, date)).filter((b) => b.organizationId === org);
      for (const b of list) assertSameTenant(b as never, ctx);
      await repo.appendAudit(this.event(ctx, { action: 'booking.list', organizationId: org }, 'success', p.user, { date, count: list.length }));
      return list;
    });
  }

  async findByCode(q: { organizationId: string; code: string }, ctx: TenantContext = requireTenantContext()): Promise<{ booking: BookingView; candidates: PatientCandidate[] } | null> {
    return this.tx(ctx, { action: 'booking.find' }, async (repo) => {
      const org = this.orgOf(q.organizationId, ctx);
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'booking:read');
      const c = normalizeCode(q.code);
      if (!c) throw new ClinicalError('VALIDATION', 'Invalid booking code', { reason: 'INVALID_CODE' });
      const b = await repo.findBookingByCode(org, codeHash(c));
      await repo.appendAudit(this.event(ctx, { action: 'booking.find', organizationId: org, ...(b ? { resourceId: b.bookingId } : {}) }, 'success', p.user, { found: !!b }));
      if (!b) return null;
      assertSameTenant(b as never, ctx);
      return { booking: b, candidates: b.status === 'booked' ? await repo.findCandidates(org, b) : [] };
    });
  }

  /** Mở lịch từ danh sách trong ngày (khi người bệnh quên mã): cùng dữ liệu như tra theo mã. */
  async getById(bookingId: string, ctx: TenantContext = requireTenantContext()): Promise<{ booking: BookingView; candidates: PatientCandidate[] }> {
    return this.tx(ctx, { action: 'booking.read', resourceId: bookingId }, async (repo) => {
      const b = await this.loadBooking(repo, ctx, bookingId);
      const p = await this.principal(repo, ctx, b.organizationId);
      this.decide(p, 'booking:read');
      await repo.appendAudit(this.event(ctx, { action: 'booking.read', resourceId: b.bookingId, organizationId: b.organizationId }, 'success', p.user, {}));
      return { booking: b, candidates: b.status === 'booked' ? await repo.findCandidates(b.organizationId, b) : [] };
    });
  }

  async checkIn(bookingId: string, input: { patientId: string; priorityReason?: string | null }, ctx: TenantContext = requireTenantContext()): Promise<{ booking: BookingView; ticket: TicketView }> {
    return this.tx(ctx, { action: 'booking.check_in', resourceId: bookingId }, async (repo) => {
      const b = await this.loadBooking(repo, ctx, bookingId);
      const p = await this.principal(repo, ctx, b.organizationId);
      this.decide(p, 'queue:issue');
      const reason = input.priorityReason ?? null;
      if (reason !== null && !(PRIORITY_REASONS as readonly string[]).includes(reason)) throw new ClinicalError('VALIDATION', 'Unknown priorityReason');
      if (b.status !== 'booked') throw new ClinicalError('INVALID_STATE', `Booking is ${b.status}`, { reason: 'BOOKING_NOT_ACTIVE' });
      if (b.visitDate !== vnNow(this.clock()).date) throw new ClinicalError('INVALID_STATE', `Booking is for ${b.visitDate}`, { reason: 'NOT_VISIT_DAY' });
      if (typeof input.patientId !== 'string' || !isUuid(input.patientId)) throw new ClinicalError('VALIDATION', 'patientId must be a UUID');
      const patient = await repo.findPatient(input.patientId.toLowerCase() as PatientId);
      if (!patient) throw new ClinicalError('NOT_FOUND', 'Patient not found');
      assertSameTenant(patient, ctx);
      if (patient.organizationId !== b.organizationId) throw new ClinicalError('VALIDATION', 'Patient is not registered at this organization', { reason: 'PATIENT_ORG_MISMATCH' });
      if (patient.status !== 'active') throw new ClinicalError('INVALID_STATE', 'Patient record is not active');
      const sp = await repo.findServicePoint(b.servicePointId);
      if (!sp || !sp.isActive) throw new ClinicalError('INVALID_STATE', 'Service point is inactive', { reason: 'SERVICE_POINT_INACTIVE' });

      const { ticketNo, queueDate } = await repo.nextTicketNumber(sp.servicePointId);
      const now = this.clock().toISOString();
      const ticket: QueueTicket = {
        tenantId: ctx.tenantId, ticketId: randomUUID(), organizationId: b.organizationId, servicePointId: sp.servicePointId, patientId: patient.patientId,
        queueDate, ticketNo, priorityReason: reason as PriorityReason | null, priorityRank: reason === 'emergency' ? 2 : reason ? 1 : 0, status: 'waiting',
        calledCount: 0, calledAt: null, calledByUserId: null, encounterId: null, issuedByUserId: p.user.userId, issuedAt: now, updatedAt: now, version: 1,
      };
      await repo.insertTicket(ticket); // CONFLICT: PATIENT_ALREADY_QUEUED
      const saved = await repo.updateBookingStatus(b.bookingId, 'checked_in', { patientId: patient.patientId, ticketId: ticket.ticketId, checkedInBy: p.user.userId });
      if (!saved) throw new ClinicalError('CONFLICT', 'Booking changed concurrently', { reason: 'BOOKING_CHANGED' });
      const view = (await repo.listTodayTickets(b.organizationId, sp.servicePointId, 300)).find((t) => t.ticketId === ticket.ticketId);
      if (!view) throw new ClinicalError('NOT_FOUND', 'Ticket not found');
      await repo.appendAudit(
        this.event(ctx, { action: 'booking.check_in', resourceId: b.bookingId, patientId: patient.patientId, organizationId: b.organizationId }, 'success', p.user, {
          ticketId: ticket.ticketId, servicePointId: sp.servicePointId, ticketNo,
        }),
      );
      return { booking: saved, ticket: view };
    });
  }

  async cancel(bookingId: string, ctx: TenantContext = requireTenantContext()): Promise<BookingView> {
    return this.tx(ctx, { action: 'booking.cancel', resourceId: bookingId }, async (repo) => {
      const b = await this.loadBooking(repo, ctx, bookingId);
      const p = await this.principal(repo, ctx, b.organizationId);
      this.decide(p, 'queue:issue');
      if (b.status !== 'booked') throw new ClinicalError('INVALID_STATE', `Booking is ${b.status}`, { reason: 'BOOKING_NOT_ACTIVE' });
      const saved = await repo.updateBookingStatus(b.bookingId, 'cancelled', { cancelledBy: 'staff' });
      if (!saved) throw new ClinicalError('CONFLICT', 'Booking changed concurrently', { reason: 'BOOKING_CHANGED' });
      await repo.releaseSlot(b.servicePointId, b.visitDate, b.period);
      await repo.appendAudit(this.event(ctx, { action: 'booking.cancel', resourceId: b.bookingId, organizationId: b.organizationId }, 'success', p.user, {}));
      return saved;
    });
  }

  async setBookingCapacity(servicePointId: string, capacity: number, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<ServicePoint> {
    return this.tx(ctx, { action: 'booking.capacity', resourceId: servicePointId }, async (repo) => {
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > 500) throw new ClinicalError('VALIDATION', 'capacity must be 0-500');
      if (typeof servicePointId !== 'string' || !isUuid(servicePointId)) throw new ClinicalError('VALIDATION', 'servicePointId must be a UUID');
      const sp = await repo.findServicePoint(servicePointId.toLowerCase());
      if (!sp) throw new ClinicalError('NOT_FOUND', 'Service point not found');
      assertSameTenant(sp as never, ctx);
      assertOrganizationAllowed(sp.organizationId, ctx);
      const p = await this.principal(repo, ctx, sp.organizationId);
      this.decide(p, 'queue:manage');
      if (!(await repo.setBookingCapacity(sp.servicePointId, capacity, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Service point version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, { action: 'booking.capacity', resourceId: sp.servicePointId, organizationId: sp.organizationId }, 'success', p.user, { capacity }));
      return (await repo.findServicePoint(sp.servicePointId))!;
    });
  }

  async getPortal(organizationId: string, ctx: TenantContext = requireTenantContext()): Promise<BookingPortal | null> {
    return this.tx(ctx, { action: 'booking.portal.read' }, async (repo) => {
      const org = this.orgOf(organizationId, ctx);
      this.decideAny(await this.principal(repo, ctx, org), ['queue:manage', 'booking:read']);
      return repo.findPortal(org);
    });
  }

  async createPortal(input: { organizationId: string; slug: string }, ctx: TenantContext = requireTenantContext()): Promise<BookingPortal> {
    return this.tx(ctx, { action: 'booking.portal.create' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      const slug = String(input.slug ?? '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) throw new ClinicalError('VALIDATION', 'slug must be 3-40 chars a-z, 0-9, -');
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'queue:manage');
      const portal: BookingPortal = { portalId: randomUUID(), organizationId: org, slug, isActive: true, version: 1 };
      await repo.insertPortal({ ...portal, tenantId: ctx.tenantId, createdBy: p.user.userId }); // CONFLICT: PORTAL_EXISTS / SLUG_TAKEN
      await repo.appendAudit(this.event(ctx, { action: 'booking.portal.create', resourceId: portal.portalId, organizationId: org }, 'success', p.user, { slug }));
      return portal;
    });
  }

  async setPortalActive(input: { organizationId: string; isActive: boolean }, expectedVersion: number, ctx: TenantContext = requireTenantContext()): Promise<BookingPortal> {
    return this.tx(ctx, { action: 'booking.portal.update' }, async (repo) => {
      const org = this.orgOf(input.organizationId, ctx);
      if (typeof input.isActive !== 'boolean') throw new ClinicalError('VALIDATION', 'isActive must be boolean');
      const p = await this.principal(repo, ctx, org);
      this.decide(p, 'queue:manage');
      const cur = await repo.findPortal(org);
      if (!cur) throw new ClinicalError('NOT_FOUND', 'Portal not found');
      if (!(await repo.setPortalActive(cur.portalId, input.isActive, expectedVersion))) {
        throw new ClinicalError('CONFLICT', 'Portal version does not match', { reason: 'VERSION_CONFLICT' });
      }
      await repo.appendAudit(this.event(ctx, { action: 'booking.portal.update', resourceId: cur.portalId, organizationId: org }, 'success', p.user, { isActive: input.isActive }));
      return (await repo.findPortal(org))!;
    });
  }

  // ---- nội bộ ----
  private async loadBooking(repo: PgBookingRepository, ctx: TenantContext, id: string): Promise<BookingView> {
    if (typeof id !== 'string' || !isUuid(id)) throw new ClinicalError('VALIDATION', 'booking id must be a UUID');
    const b = await repo.findBooking(id.toLowerCase());
    if (!b) throw new ClinicalError('NOT_FOUND', 'Booking not found');
    assertSameTenant(b as never, ctx);
    assertOrganizationAllowed(b.organizationId, ctx);
    return b;
  }
  private orgOf(raw: string, ctx: TenantContext): OrganizationId {
    if (typeof raw !== 'string' || !isUuid(raw)) throw new ClinicalError('VALIDATION', 'organization must be a UUID');
    const org = raw.toLowerCase() as OrganizationId;
    assertOrganizationAllowed(org, ctx);
    return org;
  }
  private async principal(repo: PgBookingRepository, ctx: TenantContext, organizationId: OrganizationId): Promise<Principal> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) => m.organizationId === organizationId && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return { user, grants: await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>) };
  }
  private decide(p: Principal, action: PolicyAction): AllowedDecision {
    const perm = ACCESS_POLICY_CATALOG[action].basePermission as Permission;
    const d = decideAccess(p.grants, action, PERMISSIONS[perm], { callerUserId: p.user.userId });
    if (!d.allowed) {
      if (d.reason === 'ROLE') throw new ClinicalError('FORBIDDEN', `Missing permission ${perm}`);
      throw new ClinicalError('FORBIDDEN', `Access policy does not permit ${action}`, { reason: 'ACCESS_POLICY' });
    }
    return d;
  }
  private decideAny(p: Principal, actions: PolicyAction[]): AllowedDecision {
    let last: unknown;
    for (const a of actions) {
      try {
        return this.decide(p, a);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
  private event(ctx: TenantContext, meta: AuditMeta, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject },
      organizationId: meta.organizationId ?? null, action: meta.action, resourceType: 'Booking', resourceId: meta.resourceId ?? null,
      personId: null, patientId: meta.patientId ?? null, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async tx<T>(ctx: TenantContext, meta: AuditMeta, fn: (repo: PgBookingRepository) => Promise<T>): Promise<T> {
    try {
      return await this.deps.uow.run(ctx, fn);
    } catch (e) {
      let code = 'INTERNAL';
      let outcome: NewAuditEvent['outcome'] = 'failure';
      if (e instanceof ClinicalError) {
        code = e.code;
        if (e.code === 'FORBIDDEN') outcome = 'denied';
      } else if (e instanceof TenantIsolationError) {
        code = e.code;
        outcome = 'denied';
      }
      const reason = e instanceof ClinicalError && typeof e.details?.['reason'] === 'string' ? e.details['reason'] : undefined;
      try {
        await this.deps.audit.record(this.event(ctx, meta, outcome, null, { code, ...(reason ? { reason } : {}) }));
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }
}

