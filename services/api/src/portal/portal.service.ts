/**
 * HCOS-F20 | Cổng bệnh nhân.
 *
 * Xác thực tách biệt khỏi nhân viên: người bệnh không phải iam.users, không có JWT. Đăng nhập 2 bước bằng OTP:
 *   1. SĐT (blind index F16, đúng MỘT hồ sơ) hoặc mã BN + ngày sinh  =>  luôn trả "đã gửi" (không lộ hồ sơ có / không);
 *      không khớp => tạo thử thách mồi (không mã) để thời gian và hình dạng phản hồi như thật.
 *   2. Mã 6 số (HMAC bằng khoá chỉ mục F16, không lưu mã rõ) => token phiên ngẫu nhiên (chỉ lưu SHA-256).
 *   Giới hạn: tối đa 3 lần gửi / 15 phút cho cùng định danh; sai 5 lần (cộng dồn 30 phút) => khoá 30 phút; mỗi thử thách sai tối đa 5.
 *   Phiên: tối đa 12 giờ, nhàn rỗi 30 phút thì hết.
 *
 * ĐỌC: transaction `SET LOCAL ROLE hcos_portal` + app.portal_person_ids => RLS CSDL chỉ trả hồ sơ của bản thân + người phụ thuộc còn
 * hiệu lực; đợt khám đã kết thúc; chẩn đoán / chỉ số / đơn thuốc của đợt đó. Service KHÔNG tự lọc thay CSDL.
 * GHI (vai hcos_app, sau khi kiểm person thuộc phiên): đặt / huỷ lịch, đổi SĐT (OTP tới số mới), email, yêu cầu đính chính, yêu cầu xoá (F17),
 * link chia sẻ một đợt khám (24 giờ, PIN 6 số, sai 5 lần khoá). Không ghi bệnh án.
 * Audit: actor = service 'patient-portal', personId = người đăng nhập; payload chỉ id.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  isUuid, type AuditEventId, type AuditSink, type CorrelationId, type NewAuditEvent, type OrganizationId, type TenantContext, type TenantId, type TenantScopedDb,
} from '../../../../packages/domain/src/s0-contracts';
import { maskEmail, maskPhone, normalizePhoneVn, TenantPii } from '../../../../packages/security/src/pii';
import { withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { CONSENT_TEXT, CONSENT_VERSION, periodOpen, PgBookingRepository, type Period, type PublicBookingService } from '../clinical/booking.service';
import { ClinicalError, iso, isoOrNull, num, PgClinicalRepository } from '../clinical/encounter.service';
import type { RetentionService } from '../governance/retention.service';
import { MrnError, normalizeMrnQuery } from '../registry/mrn';
import type { OtpSender } from './otp-sender';

/** Lỗi của cổng (mang mã HTTP + lý do cho giao diện). */
export class PortalError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string, readonly retryAfterSec: number | null = null) {
    super(message);
    this.name = 'PortalError';
  }
}

export const OTP_TTL_MS = 5 * 60_000;
export const SEND_LIMIT = 3;
export const SEND_WINDOW_MIN = 15;
export const FAIL_LIMIT = 5;
export const LOCK_MIN = 30;
export const SESSION_MAX_MS = 12 * 3_600_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SHARE_TTL_MS = 24 * 3_600_000;
const TOKEN_PREFIX = 'hpt_';
const SHARE_PREFIX = 'hps_';

export interface RequestMeta {
  readonly ip: string;
  readonly userAgent: string | null;
}
interface PortalRef {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
  readonly slug: string;
}
interface Session {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly sessionId: string;
  readonly personId: string;
}
export interface Profile {
  readonly personId: string;
  readonly name: string;
  readonly birthDate: string | null;
  readonly sex: string | null;
  readonly mrns: string[];
  readonly relationship: string | null;
  readonly validUntil: string | null;
  readonly self: boolean;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sixDigits = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
const newToken = (prefix: string): string => prefix + randomBytes(32).toString('base64url');
const vnToday = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (msg: string, reason = 'INVALID'): never => {
  throw new PortalError(422, reason, msg);
};
const uuidOr = (v: unknown, field: string): string => (typeof v === 'string' && isUuid(v) ? v.toLowerCase() : bad(`${field} must be a UUID`));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { readonly tenantId: string; query(sql: string, params?: readonly unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };
export class PortalService {
  private readonly clock: () => Date;
  constructor(
    private readonly deps: {
      pool: PgPoolLike; audit: AuditSink; sender: OtpSender; publicBooking: Pick<PublicBookingService, 'options' | 'create'>;
      retention: Pick<RetentionService, 'requestFromPortal'>; clock?: () => Date;
    },
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.deps.sender.channel !== 'none';
  }

  // =========================================================================
  // Công khai: thông tin cổng, đăng nhập
  // =========================================================================
  async info(slug: string): Promise<{ organizationName: string; enabled: boolean; training: boolean } | null> {
    const ref = await this.ref(slug);
    return ref ? { organizationName: ref.organizationName, enabled: this.enabled, training: this.deps.sender.channel === 'training' } : null;
  }

  /** Bước 1: gửi OTP. Phản hồi giống nhau dù có hồ sơ hay không (trừ mã thực tập ở môi trường dữ liệu giả). */
  async start(slug: string, input: Record<string, unknown>, meta: RequestMeta): Promise<{ challengeId: string; expiresInSec: number; trainingCode?: string }> {
    const ref = await this.ref(slug);
    if (!ref) throw new PortalError(404, 'NOT_FOUND', 'Portal not found');
    if (!this.enabled) throw new PortalError(503, 'PORTAL_DISABLED', 'Patient portal login is not enabled');
    const method = input['method'];
    let identifier: string;
    let lookup: { phone: string } | { mrn: string; birthDate: string };
    if (method === 'phone') {
      const phone = normalizePhoneVn(str(input['phone'], 20));
      if (!phone) bad('Invalid phone number', 'PHONE_INVALID');
      identifier = `phone:${phone}`;
      lookup = { phone: phone! };
    } else if (method === 'mrn') {
      let mrn: string;
      try {
        mrn = normalizeMrnQuery(str(input['mrn'], 64));
      } catch (e) {
        throw new PortalError(422, e instanceof MrnError ? e.reason : 'MRN_INVALID', 'Invalid patient code');
      }
      const birth = str(input['birthDate'], 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) bad('birthDate must be YYYY-MM-DD', 'BIRTHDATE_INVALID');
      identifier = `mrn:${mrn.toUpperCase()}|${birth}`;
      lookup = { mrn, birthDate: birth };
    } else {
      return bad("method must be 'phone' or 'mrn'");
    }
    const out = await this.tx(ref.tenantId, ref.organizationId, async (db, pii) => {
      const target = await pii.mac('portal-login', identifier);
      const ipMac = await pii.mac('ip', meta.ip);
      await this.assertNotLocked(db, ref.tenantId, target);
      const sent = num((await db.query(
        `SELECT count(*) AS n FROM portal.otp_challenges WHERE tenant_id = $1 AND target_bidx = $2 AND purpose = 'login' AND created_at > now() - make_interval(mins => $3)`,
        [ref.tenantId, target, SEND_WINDOW_MIN])).rows[0]?.n);
      if (sent >= SEND_LIMIT) throw new PortalError(429, 'OTP_THROTTLED', 'Too many codes requested; wait 15 minutes', SEND_WINDOW_MIN * 60);
      const person = await this.findPerson(db, pii, ref, lookup);
      const id = randomUUID();
      const code = sixDigits();
      const expires = new Date(this.clock().getTime() + OTP_TTL_MS);
      if (person) await this.assertVendor(db);
      await db.query(
        `INSERT INTO portal.otp_challenges (challenge_id, tenant_id, organization_id, person_id, purpose, code_mac, target_bidx, channel, vendor_id, ip_mac, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'login', $5, $6, $7, $8, $9, $10, $11)`,
        [id, ref.tenantId, ref.organizationId, person?.personId ?? null, person ? await pii.mac('otp', `${id}|${code}`) : null, target,
          this.deps.sender.channel, this.deps.sender.vendorId, ipMac, expires.toISOString(), this.clock().toISOString()],
      );
      await this.audit(db, ref.tenantId, ref.organizationId, person?.personId ?? null, 'portal.otp.request', 'success', { challengeId: id, method, matched: Boolean(person) });
      return { id, code, person };
    });
    let delivered = false;
    if (out.person?.phone) {
      delivered = await this.deps.sender.send({ to: out.person.phone, code: out.code, purpose: 'login', organizationName: ref.organizationName }).catch(() => false);
    }
    return {
      challengeId: out.id, expiresInSec: OTP_TTL_MS / 1000,
      ...(this.deps.sender.channel === 'training' && delivered ? { trainingCode: out.code } : {}),
    };
  }

  /** Bước 2: nhập mã => token phiên. */
  async verify(slug: string, input: Record<string, unknown>, meta: RequestMeta): Promise<{ token: string; expiresAt: string }> {
    const ref = await this.ref(slug);
    if (!ref) throw new PortalError(404, 'NOT_FOUND', 'Portal not found');
    const challengeId = uuidOr(input['challengeId'], 'challengeId');
    const code = str(input['code'], 10);
    if (!/^\d{6}$/.test(code)) bad('Code must be 6 digits', 'OTP_FORMAT');
    const result = await this.tx(ref.tenantId, ref.organizationId, async (db, pii) => {
      const c = (await db.query(
        `SELECT challenge_id, person_id, code_mac, target_bidx, attempts, failed_attempts, expires_at, consumed_at, purpose FROM portal.otp_challenges
          WHERE tenant_id = $1 AND challenge_id = $2 AND organization_id = $3 FOR UPDATE`, [ref.tenantId, challengeId, ref.organizationId])).rows[0];
      if (!c || c.purpose !== 'login') return { ok: false as const, reason: 'OTP_INVALID', left: 0 };
      await this.assertNotLocked(db, ref.tenantId, c.target_bidx);
      if (c.consumed_at || Date.parse(iso(c.expires_at)) <= this.clock().getTime() || num(c.attempts) >= FAIL_LIMIT) {
        return { ok: false as const, reason: 'OTP_EXPIRED', left: 0 };
      }
      const good = c.code_mac !== null && c.code_mac === (await pii.mac('otp', `${challengeId}|${code}`));
      if (!good) {
        await db.query(`UPDATE portal.otp_challenges SET attempts = attempts + 1, failed_attempts = failed_attempts + 1 WHERE tenant_id = $1 AND challenge_id = $2`, [ref.tenantId, challengeId]);
        await this.audit(db, ref.tenantId, ref.organizationId, c.person_id ?? null, 'portal.otp.verify', 'denied', { challengeId });
        return { ok: false as const, reason: 'OTP_INVALID', left: FAIL_LIMIT - num(c.attempts) - 1 };
      }
      const person = (await db.query(`SELECT erased_at, status FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [ref.tenantId, c.person_id])).rows[0];
      if (!person || person.erased_at || person.status !== 'active') return { ok: false as const, reason: 'OTP_INVALID', left: 0 };
      await db.query(`UPDATE portal.otp_challenges SET attempts = attempts + 1, consumed_at = now() WHERE tenant_id = $1 AND challenge_id = $2`, [ref.tenantId, challengeId]);
      const token = newToken(TOKEN_PREFIX);
      const sid = randomUUID();
      const now = this.clock();
      const expires = new Date(now.getTime() + SESSION_MAX_MS);
      await db.query(
        `INSERT INTO portal.sessions (session_id, tenant_id, organization_id, person_id, token_hash, challenge_id, ip_mac, user_agent, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)`,
        [sid, ref.tenantId, ref.organizationId, c.person_id, sha256(token), challengeId, await pii.mac('ip', meta.ip), meta.userAgent?.slice(0, 120) ?? null,
          now.toISOString(), expires.toISOString()],
      );
      await this.audit(db, ref.tenantId, ref.organizationId, c.person_id, 'portal.login', 'success', { sessionId: sid });
      return { ok: true as const, token, expiresAt: expires.toISOString() };
    });
    if (!result.ok) {
      throw new PortalError(result.reason === 'OTP_EXPIRED' ? 410 : 401, result.reason, result.reason === 'OTP_EXPIRED' ? 'Code expired; request a new one' : `Wrong code (${Math.max(0, result.left)} tries left)`);
    }
    return { token: result.token, expiresAt: result.expiresAt };
  }

  // =========================================================================
  // Trong phiên
  // =========================================================================
  async logout(token: string): Promise<{ ok: true }> {
    const s = await this.session(token);
    await this.tx(s.tenantId, s.organizationId, async (db) => {
      await db.query(`UPDATE portal.sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE tenant_id = $1 AND session_id = $2 AND revoked_at IS NULL`, [s.tenantId, s.sessionId]);
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.logout', 'success', { sessionId: s.sessionId });
    });
    return { ok: true };
  }

  async me(token: string): Promise<{ organizationName: string; profiles: Profile[]; contact: { phoneHint: string | null; emailHint: string | null }; training: boolean }> {
    const s = await this.session(token);
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const deps = await this.dependents(db, s);
      const ids = [s.personId, ...deps.map((d) => d.personId)];
      const base = await this.read(db, ids, async () => {
        const persons = (await db.query(
          `SELECT p.person_id, p.family_name, p.given_name, p.birth_date::text AS birth_date, p.sex, p.phone_hint, p.email_hint,
                  ARRAY(SELECT pt.mrn FROM patient.patients pt WHERE pt.tenant_id = p.tenant_id AND pt.person_id = p.person_id ORDER BY pt.registered_at) AS mrns
             FROM patient.persons p WHERE p.tenant_id = $1`, [s.tenantId])).rows;
        const org = (await db.query(`SELECT name FROM iam.organizations WHERE tenant_id = $1 AND organization_id = $2`, [s.tenantId, s.organizationId])).rows[0];
        return { persons, orgName: String(org?.name ?? '') };
      });
      const byId = new Map(base.persons.map((p: any) => [p.person_id, p]));
      const profile = (id: string, rel: string | null, until: string | null): Profile | null => {
        const p: any = byId.get(id);
        if (!p) return null;
        return {
          personId: id, name: `${p.family_name ?? ''} ${p.given_name ?? ''}`.trim(), birthDate: p.birth_date ?? null, sex: p.sex ?? null,
          mrns: Array.isArray(p.mrns) ? p.mrns : String(p.mrns ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean),
          relationship: rel, validUntil: until, self: id === s.personId,
        };
      };
      const self: any = byId.get(s.personId);
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.me', 'success', { profiles: ids.length });
      return {
        organizationName: base.orgName,
        profiles: [profile(s.personId, null, null), ...deps.map((d) => profile(d.personId, d.relationship, d.validUntil))].filter((x): x is Profile => x !== null),
        contact: { phoneHint: self?.phone_hint ?? null, emailHint: self?.email_hint ?? null },
        training: this.deps.sender.channel === 'training',
      };
    });
  }

  /** Tổng quan một hồ sơ: đợt khám đã kết thúc, lịch hẹn, phiếu thu. */
  async overview(token: string, personIdIn: unknown) {
    const s = await this.session(token);
    const pid = uuidOr(personIdIn, 'personId');
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const ids = await this.allowedIds(db, s, pid);
      const data = await this.read(db, ids, async () => {
        const encounters = (await db.query(
          `SELECT e.encounter_id, e.period_start, e.period_end, e.encounter_class, o.name AS org_name, u.display_name AS practitioner,
                  (SELECT string_agg(c.display, '; ' ORDER BY c.recorded_at) FROM clinical.conditions c WHERE c.tenant_id = e.tenant_id AND c.encounter_id = e.encounter_id) AS diagnoses,
                  (SELECT count(*) FROM clinical.prescriptions r WHERE r.tenant_id = e.tenant_id AND r.encounter_id = e.encounter_id) AS prescriptions
             FROM clinical.encounters e JOIN patient.patients pt ON pt.tenant_id = e.tenant_id AND pt.patient_id = e.patient_id
             LEFT JOIN iam.organizations o ON o.tenant_id = e.tenant_id AND o.organization_id = e.organization_id
             LEFT JOIN iam.users u ON u.tenant_id = e.tenant_id AND u.user_id = e.practitioner_user_id
            WHERE e.tenant_id = $1 AND pt.person_id = $2 ORDER BY e.period_start DESC LIMIT 100`, [s.tenantId, pid])).rows;
        const bookings = (await db.query(
          `SELECT b.booking_id, b.visit_date::text AS visit_date, b.period, b.status, sp.name AS room, b.portal_person_id
             FROM clinical.bookings b JOIN clinical.service_points sp ON sp.tenant_id = b.tenant_id AND sp.service_point_id = b.service_point_id
            WHERE b.tenant_id = $1 AND (b.portal_person_id = $2 OR b.patient_id IN (SELECT patient_id FROM patient.patients WHERE person_id = $2))
            ORDER BY b.visit_date DESC, b.period LIMIT 50`, [s.tenantId, pid])).rows;
        const receipts = (await db.query(
          `SELECT r.receipt_no, r.kind, r.method, r.amount, r.created_at FROM finance.receipts r JOIN finance.billing_cases c ON c.tenant_id = r.tenant_id AND c.case_id = r.case_id
             JOIN patient.patients pt ON pt.tenant_id = c.tenant_id AND pt.patient_id = c.patient_id
            WHERE r.tenant_id = $1 AND pt.person_id = $2 ORDER BY r.created_at DESC LIMIT 100`, [s.tenantId, pid])).rows;
        return { encounters, bookings, receipts };
      });
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.overview', 'success', { subjectPersonId: pid });
      const now = this.clock();
      return {
        encounters: data.encounters.map((e: any) => ({
          encounterId: e.encounter_id, start: iso(e.period_start), end: isoOrNull(e.period_end), class: e.encounter_class, organizationName: e.org_name ?? null,
          practitioner: e.practitioner ?? null, diagnoses: e.diagnoses ?? null, prescriptions: num(e.prescriptions),
        })),
        bookings: data.bookings.map((b: any) => ({
          bookingId: b.booking_id, visitDate: String(b.visit_date).slice(0, 10), period: b.period as Period, status: b.status, room: b.room,
          viaPortal: b.portal_person_id !== null, cancellable: b.status === 'booked' && periodOpen(String(b.visit_date).slice(0, 10), b.period, now),
        })),
        receipts: data.receipts.map((r: any) => ({ receiptNo: r.receipt_no, kind: r.kind, method: r.method, amount: num(r.amount), at: iso(r.created_at) })),
      };
    });
  }

  async encounter(token: string, personIdIn: unknown, encounterIdIn: unknown) {
    const s = await this.session(token);
    const pid = uuidOr(personIdIn, 'personId');
    const eid = uuidOr(encounterIdIn, 'encounterId');
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const ids = await this.allowedIds(db, s, pid);
      const d = await this.read(db, ids, () => this.encounterDetail(db, s.tenantId, pid, eid));
      if (!d) throw new PortalError(404, 'NOT_FOUND', 'Encounter not found');
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.encounter.read', 'success', { subjectPersonId: pid, encounterId: eid });
      return d;
    });
  }

  // ---- lịch hẹn -----------------------------------------------------------
  async bookingOptions(token: string) {
    const s = await this.session(token);
    const slug = await this.slugOf(s);
    const o = await this.deps.publicBooking.options(slug);
    if (!o) throw new PortalError(404, 'NOT_FOUND', 'Online booking is not open');
    return o;
  }

  async book(token: string, input: Record<string, unknown>) {
    const s = await this.session(token);
    const pid = uuidOr(input['personId'], 'personId');
    if (input['consent'] !== true) bad('Consent is required', 'CONSENT_REQUIRED');
    const slug = await this.slugOf(s);
    // Thông tin hành chính lấy từ hồ sơ (vai hcos_app, sau khi kiểm person thuộc phiên); SĐT: của người đặt (bản thân / người giám hộ).
    const person = await this.tx(s.tenantId, s.organizationId, async (db, pii) => {
      await this.allowedIds(db, s, pid);
      const p = (await db.query(`SELECT person_id, family_name, given_name, birth_date::text AS birth_date, sex FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [s.tenantId, pid])).rows[0];
      const phone = await this.phoneOf(db, pii, s.tenantId, s.personId);
      return { ...p, phone };
    });
    if (!person.phone) throw new PortalError(409, 'PHONE_MISSING', 'Your record has no phone number');
    if (!person.birth_date) throw new PortalError(409, 'BIRTHDATE_MISSING', 'Record has no birth date; ask the front desk');
    const r = await this.deps.publicBooking.create(slug, {
      servicePointId: str(input['servicePointId'], 40), visitDate: str(input['visitDate'], 10), period: str(input['period'], 10),
      familyName: person.family_name ?? '', givenName: person.given_name ?? '', birthDate: String(person.birth_date).slice(0, 10),
      sex: person.sex ?? 'unknown', phone: person.phone, nationalId: null, reason: str(input['reason'], 300) || null, consent: true, consentVersion: CONSENT_VERSION,
    }, { portalPersonId: pid });
    if (!r) throw new PortalError(404, 'NOT_FOUND', 'Online booking is not open');
    await this.tx(s.tenantId, s.organizationId, (db) => this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.booking.create', 'success', { subjectPersonId: pid }));
    return r;
  }

  async cancelBooking(token: string, input: Record<string, unknown>) {
    const s = await this.session(token);
    const pid = uuidOr(input['personId'], 'personId');
    const bid = uuidOr(input['bookingId'], 'bookingId');
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const ids = await this.allowedIds(db, s, pid);
      // Thấy được qua RLS cổng = của person này.
      const visible = await this.read(db, ids, async () => (await db.query(
        `SELECT 1 FROM clinical.bookings b WHERE b.tenant_id = $1 AND b.booking_id = $2
            AND (b.portal_person_id = $3 OR b.patient_id IN (SELECT patient_id FROM patient.patients WHERE person_id = $3))`, [s.tenantId, bid, pid])).rows.length > 0);
      if (!visible) throw new PortalError(404, 'NOT_FOUND', 'Booking not found');
      const repo = new PgBookingRepository(db as unknown as TenantScopedDb);
      const b = await repo.findBooking(bid);
      if (!b || b.status !== 'booked' || !periodOpen(b.visitDate, b.period, this.clock())) throw new PortalError(409, 'NOT_CANCELLABLE', 'This booking can no longer be cancelled');
      const saved = await repo.updateBookingStatus(bid, 'cancelled', { cancelledBy: 'patient' });
      if (!saved) throw new PortalError(409, 'BOOKING_CHANGED', 'Booking changed; reload');
      await repo.releaseSlot(b.servicePointId, b.visitDate, b.period);
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.booking.cancel', 'success', { subjectPersonId: pid, bookingId: bid });
      return { bookingId: bid, status: 'cancelled' };
    });
  }

  // ---- liên hệ ------------------------------------------------------------
  async startPhoneChange(token: string, input: Record<string, unknown>, meta: RequestMeta): Promise<{ challengeId: string; expiresInSec: number; trainingCode?: string }> {
    const s = await this.session(token);
    const phone = normalizePhoneVn(str(input['phone'], 20));
    if (!phone) bad('Invalid phone number', 'PHONE_INVALID');
    const ref = await this.refOf(s);
    const out = await this.tx(s.tenantId, s.organizationId, async (db, pii) => {
      const target = await pii.index('phone', phone!);
      const sent = num((await db.query(
        `SELECT count(*) AS n FROM portal.otp_challenges WHERE tenant_id = $1 AND purpose = 'phone_change' AND (target_bidx = $2 OR person_id = $3) AND created_at > now() - make_interval(mins => $4)`,
        [s.tenantId, target, s.personId, SEND_WINDOW_MIN])).rows[0]?.n);
      if (sent >= SEND_LIMIT) throw new PortalError(429, 'OTP_THROTTLED', 'Too many codes requested; wait 15 minutes', SEND_WINDOW_MIN * 60);
      await this.assertVendor(db);
      const id = randomUUID();
      const code = sixDigits();
      const enc = await pii.seal('phone', phone!, { kind: 'person', id: s.personId });
      await db.query(
        `INSERT INTO portal.otp_challenges (challenge_id, tenant_id, organization_id, person_id, purpose, session_id, code_mac, target_enc, target_bidx, target_hint, channel, vendor_id, ip_mac, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'phone_change', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, s.tenantId, s.organizationId, s.personId, s.sessionId, await pii.mac('otp', `${id}|${code}`), enc, target, maskPhone(phone!), this.deps.sender.channel,
          this.deps.sender.vendorId, await pii.mac('ip', meta.ip), new Date(this.clock().getTime() + OTP_TTL_MS).toISOString(), this.clock().toISOString()],
      );
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.phone.request', 'success', { challengeId: id });
      return { id, code };
    });
    const delivered = await this.deps.sender.send({ to: phone!, code: out.code, purpose: 'phone_change', organizationName: ref.organizationName }).catch(() => false);
    return { challengeId: out.id, expiresInSec: OTP_TTL_MS / 1000, ...(this.deps.sender.channel === 'training' && delivered ? { trainingCode: out.code } : {}) };
  }

  async confirmPhoneChange(token: string, input: Record<string, unknown>): Promise<{ phoneHint: string }> {
    const s = await this.session(token);
    const cid = uuidOr(input['challengeId'], 'challengeId');
    const code = str(input['code'], 10);
    if (!/^\d{6}$/.test(code)) bad('Code must be 6 digits', 'OTP_FORMAT');
    const r = await this.tx(s.tenantId, s.organizationId, async (db, pii) => {
      const c = (await db.query(
        `SELECT code_mac, target_enc, target_bidx, target_hint, attempts, expires_at, consumed_at FROM portal.otp_challenges
          WHERE tenant_id = $1 AND challenge_id = $2 AND purpose = 'phone_change' AND session_id = $3 AND person_id = $4 FOR UPDATE`,
        [s.tenantId, cid, s.sessionId, s.personId])).rows[0];
      if (!c || c.consumed_at || num(c.attempts) >= FAIL_LIMIT || Date.parse(iso(c.expires_at)) <= this.clock().getTime()) return { ok: false as const, reason: 'OTP_EXPIRED' };
      if (c.code_mac !== (await pii.mac('otp', `${cid}|${code}`))) {
        await db.query(`UPDATE portal.otp_challenges SET attempts = attempts + 1, failed_attempts = failed_attempts + 1 WHERE tenant_id = $1 AND challenge_id = $2`, [s.tenantId, cid]);
        return { ok: false as const, reason: 'OTP_INVALID' };
      }
      await db.query(`UPDATE portal.otp_challenges SET attempts = attempts + 1, consumed_at = now(), target_enc = NULL WHERE tenant_id = $1 AND challenge_id = $2`, [s.tenantId, cid]);
      await db.query(`UPDATE patient.persons SET phone_enc = $3, phone_bidx = $4, phone_hint = $5 WHERE tenant_id = $1 AND person_id = $2`,
        [s.tenantId, s.personId, c.target_enc, c.target_bidx, c.target_hint]);
      // Đổi SĐT đăng nhập => thu hồi các phiên khác của người này.
      await db.query(`UPDATE portal.sessions SET revoked_at = now(), revoked_reason = 'phone_changed' WHERE tenant_id = $1 AND person_id = $2 AND session_id <> $3 AND revoked_at IS NULL`,
        [s.tenantId, s.personId, s.sessionId]);
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.phone.change', 'success', { challengeId: cid });
      return { ok: true as const, hint: String(c.target_hint) };
    });
    if (!r.ok) throw new PortalError(r.reason === 'OTP_EXPIRED' ? 410 : 401, r.reason, r.reason === 'OTP_EXPIRED' ? 'Code expired' : 'Wrong code');
    return { phoneHint: r.hint };
  }

  async setEmail(token: string, input: Record<string, unknown>): Promise<{ emailHint: string | null }> {
    const s = await this.session(token);
    const raw = str(input['email'], 200);
    const email = raw === '' ? null : raw.toLowerCase();
    if (email !== null && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) bad('Invalid email', 'EMAIL_INVALID');
    return this.tx(s.tenantId, s.organizationId, async (db, pii) => {
      const enc = email ? await pii.seal('email', email, { kind: 'person', id: s.personId }) : null;
      await db.query(`UPDATE patient.persons SET email_enc = $3, email_hint = $4 WHERE tenant_id = $1 AND person_id = $2`,
        [s.tenantId, s.personId, enc, email ? maskEmail(email) : null]);
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.email.change', 'success', { cleared: email === null });
      return { emailHint: email ? maskEmail(email) : null };
    });
  }

  // ---- yêu cầu ------------------------------------------------------------
  async submitCorrection(token: string, input: Record<string, unknown>) {
    const s = await this.session(token);
    const pid = uuidOr(input['personId'], 'personId');
    const message = str(input['message'], 2000);
    if (message.length < 10) bad('Describe the error (at least 10 characters)', 'MESSAGE_TOO_SHORT');
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      await this.allowedIds(db, s, pid);
      const open = num((await db.query(`SELECT count(*) AS n FROM portal.requests WHERE tenant_id = $1 AND submitted_by_person_id = $2 AND status = 'open'`, [s.tenantId, s.personId])).rows[0]?.n);
      if (open >= 5) throw new PortalError(429, 'TOO_MANY_OPEN', 'You already have 5 open requests');
      const id = randomUUID();
      await db.query(
        `INSERT INTO portal.requests (request_id, tenant_id, organization_id, person_id, submitted_by_person_id, kind, message) VALUES ($1, $2, $3, $4, $5, 'correction', $6)`,
        [id, s.tenantId, s.organizationId, pid, s.personId, message],
      );
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.correction.submit', 'success', { requestId: id, subjectPersonId: pid });
      return { requestId: id, status: 'open' };
    });
  }

  async requestErasure(token: string, input: Record<string, unknown>) {
    const s = await this.session(token);
    const pid = uuidOr(input['personId'], 'personId');
    const note = str(input['note'], 500) || null;
    const patientId = await this.tx(s.tenantId, s.organizationId, async (db) => {
      await this.allowedIds(db, s, pid);
      const r = (await db.query(`SELECT patient_id FROM patient.patients WHERE tenant_id = $1 AND person_id = $2 ORDER BY (organization_id = $3) DESC, registered_at LIMIT 1`,
        [s.tenantId, pid, s.organizationId])).rows[0];
      return r?.patient_id as string | undefined;
    });
    if (!patientId) throw new PortalError(404, 'NOT_FOUND', 'No patient record');
    try {
      return await this.deps.retention.requestFromPortal({ patientId, submittedByPersonId: s.personId, note }, this.ctx(s.tenantId, s.organizationId));
    } catch (e) {
      if (e instanceof ClinicalError) throw new PortalError(409, String(e.details?.['reason'] ?? e.code), e.message);
      throw e;
    }
  }

  async myRequests(token: string) {
    const s = await this.session(token);
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const ids = await this.allowedIds(db, s, s.personId);
      const corrections = (await db.query(
        `SELECT request_id, person_id, message, status, resolution_note, created_at, resolved_at FROM portal.requests WHERE tenant_id = $1 AND person_id = ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 50`,
        [s.tenantId, ids])).rows.map((r: any) => ({
        requestId: r.request_id, personId: r.person_id, message: r.message, status: r.status, resolutionNote: r.resolution_note ?? null, createdAt: iso(r.created_at), resolvedAt: isoOrNull(r.resolved_at),
      }));
      const erasures = (await db.query(
        `SELECT request_id, person_id, status, decision_note, requested_at, decided_at, deferred_until FROM governance.erasure_requests WHERE tenant_id = $1 AND person_id = ANY($2::uuid[]) ORDER BY requested_at DESC LIMIT 20`,
        [s.tenantId, ids])).rows.map((r: any) => ({
        requestId: r.request_id, personId: r.person_id, status: r.status, decisionNote: r.decision_note ?? null, requestedAt: iso(r.requested_at),
        decidedAt: isoOrNull(r.decided_at), deferredUntil: isoOrNull(r.deferred_until),
      }));
      return { corrections, erasures };
    });
  }

  // ---- chia sẻ -----------------------------------------------------------
  async createShare(token: string, input: Record<string, unknown>): Promise<{ shareToken: string; pin: string; expiresAt: string }> {
    const s = await this.session(token);
    const pid = uuidOr(input['personId'], 'personId');
    const eid = uuidOr(input['encounterId'], 'encounterId');
    return this.tx(s.tenantId, s.organizationId, async (db, pii) => {
      const ids = await this.allowedIds(db, s, pid);
      const seen = await this.read(db, ids, async () => (await db.query(`SELECT 1 FROM clinical.encounters WHERE tenant_id = $1 AND encounter_id = $2`, [s.tenantId, eid])).rows.length > 0);
      if (!seen) throw new PortalError(404, 'NOT_FOUND', 'Encounter not found');
      const active = num((await db.query(`SELECT count(*) AS n FROM portal.shares WHERE tenant_id = $1 AND person_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [s.tenantId, pid])).rows[0]?.n);
      if (active >= 5) throw new PortalError(429, 'TOO_MANY_SHARES', 'At most 5 active links; revoke one first');
      const shareToken = newToken(SHARE_PREFIX);
      const pin = sixDigits();
      const id = randomUUID();
      const now = this.clock();
      const expires = new Date(now.getTime() + SHARE_TTL_MS);
      await db.query(
        `INSERT INTO portal.shares (share_id, tenant_id, organization_id, person_id, encounter_id, token_hash, pin_mac, created_by_person_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, s.tenantId, s.organizationId, pid, eid, sha256(shareToken), await pii.mac('share-pin', `${id}|${pin}`), s.personId, now.toISOString(), expires.toISOString()],
      );
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.share.create', 'success', { shareId: id, subjectPersonId: pid, encounterId: eid });
      return { shareToken, pin, expiresAt: expires.toISOString() };
    });
  }

  async listShares(token: string) {
    const s = await this.session(token);
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const ids = await this.allowedIds(db, s, s.personId);
      return (await db.query(
        `SELECT s.share_id, s.person_id, s.encounter_id, s.created_at, s.expires_at, s.revoked_at, s.views, s.failed_attempts,
                (SELECT max(v.viewed_at) FROM portal.share_views v WHERE v.tenant_id = s.tenant_id AND v.share_id = s.share_id AND v.outcome = 'ok') AS last_view
           FROM portal.shares s WHERE s.tenant_id = $1 AND s.person_id = ANY($2::uuid[]) ORDER BY s.created_at DESC LIMIT 30`, [s.tenantId, ids])).rows.map((r: any) => ({
        shareId: r.share_id, personId: r.person_id, encounterId: r.encounter_id, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), revokedAt: isoOrNull(r.revoked_at),
        views: num(r.views), locked: num(r.failed_attempts) >= FAIL_LIMIT, lastViewAt: isoOrNull(r.last_view),
        state: r.revoked_at ? 'revoked' : num(r.failed_attempts) >= FAIL_LIMIT ? 'locked' : Date.parse(iso(r.expires_at)) <= this.clock().getTime() ? 'expired' : 'active',
      }));
    });
  }

  async revokeShare(token: string, shareIdIn: unknown) {
    const s = await this.session(token);
    const sid = uuidOr(shareIdIn, 'shareId');
    return this.tx(s.tenantId, s.organizationId, async (db) => {
      const ids = await this.allowedIds(db, s, s.personId);
      const r = await db.query(`UPDATE portal.shares SET revoked_at = now() WHERE tenant_id = $1 AND share_id = $2 AND person_id = ANY($3::uuid[]) AND revoked_at IS NULL RETURNING share_id`, [s.tenantId, sid, ids]);
      if (r.rows.length === 0) throw new PortalError(404, 'NOT_FOUND', 'Share not found or already revoked');
      await this.audit(db, s.tenantId, s.organizationId, s.personId, 'portal.share.revoke', 'success', { shareId: sid });
      return { shareId: sid, revoked: true };
    });
  }

  /** Công khai: bác sĩ tuyến trên mở link + nhập PIN. */
  async viewShare(shareToken: string, pinIn: unknown, meta: RequestMeta) {
    if (typeof shareToken !== 'string' || !shareToken.startsWith(SHARE_PREFIX) || shareToken.length > 80) throw new PortalError(404, 'NOT_FOUND', 'Link not found');
    const pin = str(pinIn, 10);
    if (!/^\d{6}$/.test(pin)) bad('PIN must be 6 digits', 'PIN_FORMAT');
    const hit = await this.lookup<{ tenant_id: TenantId; share_id: string }>('SELECT tenant_id, share_id FROM portal.share_by_token($1)', [sha256(shareToken)]);
    if (!hit) throw new PortalError(404, 'NOT_FOUND', 'Link not found');
    const r = await this.tx(hit.tenant_id, null, async (db, pii) => {
      const sh = (await db.query(`SELECT * FROM portal.shares WHERE tenant_id = $1 AND share_id = $2 FOR UPDATE`, [hit.tenant_id, hit.share_id])).rows[0];
      const ipMac = await pii.mac('ip', meta.ip);
      const log = (outcome: string) => db.query(`INSERT INTO portal.share_views (tenant_id, share_id, outcome, ip_mac) VALUES ($1, $2, $3, $4)`, [hit.tenant_id, hit.share_id, outcome, ipMac]);
      const erased = (await db.query(`SELECT erased_at FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [hit.tenant_id, sh.person_id])).rows[0]?.erased_at;
      const fail = async (outcome: string, status: number, reason: string) => {
        await log(outcome);
        return { ok: false as const, status, reason };
      };
      if (sh.revoked_at) return fail('revoked', 410, 'SHARE_REVOKED');
      if (erased) return fail('erased', 410, 'SHARE_REVOKED');
      if (Date.parse(iso(sh.expires_at)) <= this.clock().getTime()) return fail('expired', 410, 'SHARE_EXPIRED');
      if (num(sh.failed_attempts) >= FAIL_LIMIT) return fail('locked', 423, 'SHARE_LOCKED');
      if (sh.pin_mac !== (await pii.mac('share-pin', `${hit.share_id}|${pin}`))) {
        await db.query(`UPDATE portal.shares SET failed_attempts = failed_attempts + 1 WHERE tenant_id = $1 AND share_id = $2`, [hit.tenant_id, hit.share_id]);
        return fail('bad_pin', 401, num(sh.failed_attempts) + 1 >= FAIL_LIMIT ? 'SHARE_LOCKED' : 'PIN_INVALID');
      }
      await db.query(`UPDATE portal.shares SET views = views + 1 WHERE tenant_id = $1 AND share_id = $2`, [hit.tenant_id, hit.share_id]);
      await log('ok');
      const detail = await this.read(db, [sh.person_id], () => this.encounterDetail(db, hit.tenant_id, sh.person_id, sh.encounter_id, true));
      await this.audit(db, hit.tenant_id, sh.organization_id, null, 'portal.share.view', 'success', { shareId: hit.share_id, encounterId: sh.encounter_id });
      return { ok: true as const, detail, expiresAt: iso(sh.expires_at) };
    });
    if (!r.ok) throw new PortalError(r.status, r.reason, r.reason);
    if (!r.detail) throw new PortalError(404, 'NOT_FOUND', 'Link not found');
    return { ...r.detail, expiresAt: r.expiresAt };
  }

  // =========================================================================
  // Nội bộ
  // =========================================================================
  /** Chi tiết một đợt khám (gọi bên trong read => RLS cổng). */
  private async encounterDetail(db: Db, tenant: string, pid: string, eid: string, forShare = false) {
    const e = (await db.query(
      `SELECT e.encounter_id, e.period_start, e.period_end, e.encounter_class, e.reason_text, o.name AS org_name, u.display_name AS practitioner,
              p.family_name, p.given_name, p.birth_date::text AS birth_date, p.sex, pt.mrn
         FROM clinical.encounters e JOIN patient.patients pt ON pt.tenant_id = e.tenant_id AND pt.patient_id = e.patient_id
         JOIN patient.persons p ON p.tenant_id = pt.tenant_id AND p.person_id = pt.person_id
         LEFT JOIN iam.organizations o ON o.tenant_id = e.tenant_id AND o.organization_id = e.organization_id
         LEFT JOIN iam.users u ON u.tenant_id = e.tenant_id AND u.user_id = e.practitioner_user_id
        WHERE e.tenant_id = $1 AND e.encounter_id = $2 AND pt.person_id = $3`, [tenant, eid, pid])).rows[0];
    if (!e) return null;
    const conditions = (await db.query(
      `SELECT code, display, verification_status, clinical_status FROM clinical.conditions WHERE tenant_id = $1 AND encounter_id = $2 ORDER BY recorded_at`, [tenant, eid])).rows;
    const observations = (await db.query(
      `SELECT o.code, o.display, o.value_numeric, o.value_unit, o.value_string, o.effective_at FROM clinical.observations o
        WHERE o.tenant_id = $1 AND o.encounter_id = $2
          AND NOT EXISTS (SELECT 1 FROM clinical.observations n WHERE n.tenant_id = o.tenant_id AND n.supersedes_observation_id = o.observation_id)
        ORDER BY o.effective_at, o.display`,
      [tenant, eid])).rows;
    const items = (await db.query(
      `SELECT r.prescription_id, r.prescribed_at, r.note, i.line_no, m.brand_name, m.strength, m.form, i.dose_quantity, i.dose_unit, i.frequency_per_day, i.duration_days,
              i.instructions, i.quantity_prescribed, m.unit_of_measure
         FROM clinical.prescriptions r JOIN clinical.prescription_items i ON i.tenant_id = r.tenant_id AND i.prescription_id = r.prescription_id
         LEFT JOIN pharmacy.medications m ON m.tenant_id = i.tenant_id AND m.medication_id = i.medication_id
        WHERE r.tenant_id = $1 AND r.encounter_id = $2 ORDER BY r.prescribed_at, i.line_no`, [tenant, eid])).rows;
    return {
      encounterId: e.encounter_id, start: iso(e.period_start), end: isoOrNull(e.period_end), class: e.encounter_class, reason: e.reason_text ?? null,
      organizationName: e.org_name ?? null, practitioner: e.practitioner ?? null,
      patient: { name: `${e.family_name ?? ''} ${e.given_name ?? ''}`.trim(), birthDate: e.birth_date ?? null, sex: e.sex ?? null, mrn: forShare ? null : e.mrn },
      diagnoses: conditions.map((c: any) => ({ code: c.code, display: c.display, verification: c.verification_status })),
      observations: observations.map((o: any) => ({
        code: o.code, display: o.display, value: o.value_numeric !== null && o.value_numeric !== undefined ? Number(o.value_numeric) : null, unit: o.value_unit ?? null,
        text: o.value_string ?? null, at: iso(o.effective_at),
      })),
      medications: items.map((i: any) => ({
        name: `${i.brand_name ?? ''} ${i.strength ?? ''}`.trim(), form: i.form ?? null, dose: `${Number(i.dose_quantity)} ${i.dose_unit}`, perDay: num(i.frequency_per_day),
        days: num(i.duration_days), quantity: num(i.quantity_prescribed), unit: i.unit_of_measure ?? null, instructions: i.instructions ?? null,
      })),
    };
  }

  /** Chạy `fn` dưới vai hcos_portal với danh sách person cho phép (RLS CSDL lọc), rồi trả về vai ứng dụng. */
  private async read<T>(db: Db, personIds: readonly string[], fn: () => Promise<T>): Promise<T> {
    await db.query('SET LOCAL ROLE hcos_portal');
    try {
      await db.query("SELECT set_config('app.portal_person_ids', $1, true)", [`{${personIds.join(',')}}`]);
      return await fn();
    } finally {
      // Lỗi trong fn làm transaction hỏng => bỏ qua lỗi dọn dẹp, giữ lỗi gốc (transaction sẽ rollback).
      await db.query("SELECT set_config('app.portal_person_ids', '', true)").catch(() => undefined);
      await db.query('RESET ROLE').catch(() => undefined);
    }
  }

  /** Bản thân + người phụ thuộc còn hiệu lực (liên kết đang hoạt động, chưa quá hạn, chưa bị xoá dữ liệu). */
  private async dependents(db: Db, s: Session): Promise<Array<{ personId: string; relationship: string; validUntil: string }>> {
    const today = vnToday(this.clock());
    return (await db.query(
      `SELECT g.dependent_person_id, g.relationship, g.valid_until::text AS valid_until FROM patient.guardian_links g
         JOIN patient.persons p ON p.tenant_id = g.tenant_id AND p.person_id = g.dependent_person_id
        WHERE g.tenant_id = $1 AND g.guardian_person_id = $2 AND g.status = 'active' AND g.valid_until > $3::date AND p.erased_at IS NULL
        ORDER BY p.birth_date DESC NULLS LAST`, [s.tenantId, s.personId, today])).rows.map((r: any) => ({
      personId: r.dependent_person_id, relationship: r.relationship, validUntil: String(r.valid_until).slice(0, 10),
    }));
  }
  /** Danh sách person cho phép; ném 404 nếu `pid` không thuộc phiên. */
  private async allowedIds(db: Db, s: Session, pid: string): Promise<string[]> {
    const ids = [s.personId, ...(await this.dependents(db, s)).map((d) => d.personId)];
    if (!ids.includes(pid)) throw new PortalError(404, 'NOT_FOUND', 'Profile not found');
    return ids;
  }

  private async session(token: string): Promise<Session> {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 80) throw new PortalError(401, 'SESSION_INVALID', 'Sign in again');
    const row = await this.lookup<any>('SELECT tenant_id, organization_id, session_id, person_id, last_seen_at, expires_at FROM portal.session_by_token($1)', [sha256(token)]);
    if (!row) throw new PortalError(401, 'SESSION_INVALID', 'Sign in again');
    const now = this.clock().getTime();
    const s: Session = { tenantId: row.tenant_id, organizationId: row.organization_id, sessionId: row.session_id, personId: row.person_id };
    const idle = now - Date.parse(iso(row.last_seen_at));
    if (idle > SESSION_IDLE_MS) {
      await this.tx(s.tenantId, s.organizationId, (db) => db.query(
        `UPDATE portal.sessions SET revoked_at = now(), revoked_reason = 'expired' WHERE tenant_id = $1 AND session_id = $2 AND revoked_at IS NULL`, [s.tenantId, s.sessionId]));
      throw new PortalError(401, 'SESSION_EXPIRED', 'Session expired; sign in again');
    }
    if (idle > 60_000) {
      await this.tx(s.tenantId, s.organizationId, (db) => db.query(`UPDATE portal.sessions SET last_seen_at = now() WHERE tenant_id = $1 AND session_id = $2`, [s.tenantId, s.sessionId]));
    }
    return s;
  }

  private async findPerson(db: Db, pii: TenantPii, ref: PortalRef, q: { phone: string } | { mrn: string; birthDate: string }): Promise<{ personId: string; phone: string | null } | null> {
    let rows: any[];
    if ('phone' in q) {
      rows = (await db.query(
        `SELECT person_id FROM patient.persons WHERE tenant_id = $1 AND phone_bidx = $2 AND erased_at IS NULL AND status = 'active' LIMIT 2`,
        [ref.tenantId, await pii.index('phone', q.phone)])).rows;
      // Nhiều người dùng chung SĐT (người nhà): không đoán — đăng nhập bằng mã BN + ngày sinh.
      if (rows.length !== 1) return null;
      return { personId: rows[0].person_id, phone: q.phone };
    }
    rows = (await db.query(
      `SELECT p.person_id FROM patient.patients pt JOIN patient.persons p ON p.tenant_id = pt.tenant_id AND p.person_id = pt.person_id
        WHERE pt.tenant_id = $1 AND pt.organization_id = $2 AND upper(pt.mrn) = upper($3) AND p.birth_date = $4::date AND p.erased_at IS NULL AND p.status = 'active'`,
      [ref.tenantId, ref.organizationId, q.mrn, q.birthDate])).rows;
    if (rows.length !== 1) return null;
    const phone = await this.phoneOf(db, pii, ref.tenantId, rows[0].person_id);
    return phone ? { personId: rows[0].person_id, phone } : null;
  }
  private async phoneOf(db: Db, pii: TenantPii, tenant: string, personId: string): Promise<string | null> {
    const r = (await db.query(`SELECT phone_enc FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [tenant, personId])).rows[0];
    if (!r?.phone_enc) return null;
    try {
      return await pii.open('phone', r.phone_enc, { kind: 'person', id: personId });
    } catch {
      return null;
    }
  }
  private async assertNotLocked(db: Db, tenant: string, target: string | null): Promise<void> {
    if (!target) return;
    const r = (await db.query(
      `SELECT COALESCE(sum(failed_attempts), 0) AS f, max(created_at) AS last FROM portal.otp_challenges
        WHERE tenant_id = $1 AND target_bidx = $2 AND created_at > now() - make_interval(mins => $3)`, [tenant, target, LOCK_MIN])).rows[0];
    if (num(r?.f) >= FAIL_LIMIT) throw new PortalError(423, 'LOGIN_LOCKED', `Too many wrong codes; try again in ${LOCK_MIN} minutes`, LOCK_MIN * 60);
  }
  /** Kênh nhà cung cấp: chỉ gửi khi nhà cung cấp còn được duyệt cho dữ liệu cá nhân (sổ F18). */
  private async assertVendor(db: Db): Promise<void> {
    if (this.deps.sender.channel !== 'vendor') return;
    const ok = (await db.query(`SELECT governance.vendor_cleared($1, 'personal') AS ok`, [this.deps.sender.vendorId])).rows[0]?.ok;
    if (!(ok === true || ok === 't')) throw new PortalError(503, 'VENDOR_NOT_CLEARED', 'The messaging provider is not approved for personal data');
  }

  private async ref(slug: string): Promise<PortalRef | null> {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) return null;
    const x = await this.lookup<any>('SELECT tenant_id, organization_id, organization_name FROM clinical.booking_portal($1)', [slug]);
    return x ? { tenantId: x.tenant_id, organizationId: x.organization_id, organizationName: x.organization_name, slug } : null;
  }
  private async slugOf(s: Session): Promise<string> {
    const slug = await this.tx(s.tenantId, s.organizationId, async (db) =>
      (await db.query(`SELECT slug FROM clinical.booking_portals WHERE tenant_id = $1 AND organization_id = $2 AND is_active`, [s.tenantId, s.organizationId])).rows[0]?.slug as string | undefined);
    if (!slug) throw new PortalError(404, 'NOT_FOUND', 'Online booking is not open');
    return slug;
  }
  private async refOf(s: Session): Promise<PortalRef> {
    const ref = await this.ref(await this.slugOf(s));
    if (!ref) throw new PortalError(404, 'NOT_FOUND', 'Portal not found');
    return ref;
  }
  private async lookup<T>(sql: string, params: unknown[]): Promise<T | null> {
    const c = await this.deps.pool.connect();
    try {
      const r = (await c.query(sql, params)) as { rows: T[] };
      return r.rows[0] ?? null;
    } finally {
      c.release();
    }
  }
  private ctx(tenant: TenantId, org: OrganizationId | null): TenantContext {
    return Object.freeze({
      tenantId: tenant, userSubject: 'service:patient-portal', userId: null, personId: null, activeOrganizationId: org,
      allowedOrganizationIds: Object.freeze(org ? [org] : []), roles: Object.freeze([]), tokenId: null, correlationId: randomUUID() as CorrelationId,
    });
  }
  private async tx<T>(tenant: TenantId, org: OrganizationId | null, fn: (db: Db, pii: TenantPii) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.deps.pool, async (db: TenantScopedDb) => {
      await db.query("SELECT set_config('app.user_id', 'service:patient-portal', true)");
      return fn(db as unknown as Db, new TenantPii(db));
    }, this.ctx(tenant, org));
  }
  private async audit(db: Db, tenant: string, org: string | null, personId: string | null, action: string, outcome: NewAuditEvent['outcome'], payload: Record<string, unknown>): Promise<void> {
    const ev: NewAuditEvent = {
      eventId: randomUUID() as AuditEventId, tenantId: tenant as TenantId, actor: { type: 'service', id: 'patient-portal' }, organizationId: (org ?? null) as OrganizationId | null,
      action, resourceType: 'PatientPortal', resourceId: null, personId: (personId ?? null) as never, patientId: null, outcome,
      correlationId: randomUUID() as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
    await new PgClinicalRepository(db as unknown as TenantScopedDb).appendAudit(ev);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export { CONSENT_TEXT, CONSENT_VERSION };
