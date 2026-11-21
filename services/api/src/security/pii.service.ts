/**
 * HCOS-F16 | Hiện dữ liệu đã mã hoá (quyền riêng + audit), quản lý khoá, mã hoá dữ liệu cũ.
 *
 *   pii:reveal   (lễ tân / điều dưỡng, bác sĩ, quản lý PK)  xem bản rõ MỘT trường của MỘT bản ghi, bắt buộc lý do.
 *                Phạm vi: bản ghi phải thuộc cơ sở mà người xem có quyền (person: có hồ sơ bệnh nhân tại cơ sở đó).
 *                Mỗi lần hiện ghi một bản ghi kiểm toán (không ghi giá trị).
 *   keys:manage  (quản trị hệ thống)  xem khoá, xoay DEK, mã hoá lại, bọc lại bằng KEK mới, xoay khoá blind index,
 *                mã hoá dữ liệu cũ (backfill).
 * Quyền đọc bản ghi (danh sách, hồ sơ) KHÔNG kèm quyền giải mã: dữ liệu đọc ra luôn là dạng che.
 */
import { randomUUID } from 'node:crypto';

import {
  TenantIsolationError,
  type AccessPolicyId,
  type AuditEventId,
  type AuditSink,
  type CorrelationId,
  type Membership,
  type NewAuditEvent,
  type OrganizationId,
  type Role,
  type TenantContext,
  type TenantScopedDb,
  type User,
} from '../../../../packages/domain/src/s0-contracts';
import { ACCESS_POLICY_CATALOG, buildGrants, decideAccess, type AccessGrant, type AccessPolicy, type PolicyAction } from '../../../../packages/security/src/access-policy';
import { asTenantId, isUuid } from '../../../../packages/domain/src/s0-contracts';
import { keyProvider, maskFor, PiiShreddedError, TenantPii, tokenFormat, type KeyPurpose, type PiiDomain, type SubjectKind } from '../../../../packages/security/src/pii';
import { assertSameTenant, requireTenantContext, withTenantTransaction, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, PgClinicalRepository } from '../clinical/encounter.service';

type Permission = 'pii:reveal' | 'keys:manage';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'pii:reveal': ['clinic_staff', 'clinic_admin', 'doctor'],
  'keys:manage': ['tenant_admin'],
};

export type RevealKind = 'person' | 'identifier' | 'booking';
/** Giao diện chỉ biết patientId (FHIR Patient.id): trường của hồ sơ được ánh xạ về person / identifier. */
const PATIENT_FIELDS: Readonly<Record<string, { kind: RevealKind; field: string }>> = {
  phone: { kind: 'person', field: 'phone' },
  email: { kind: 'person', field: 'email' },
  nationalId: { kind: 'identifier', field: 'value' },
};
const FIELDS: Readonly<Record<RevealKind, Readonly<Record<string, { table: string; enc: string; plain: string; domain: PiiDomain }>>>> = {
  person: {
    phone: { table: 'patient.persons', enc: 'phone_enc', plain: 'phone', domain: 'phone' },
    email: { table: 'patient.persons', enc: 'email_enc', plain: 'email', domain: 'email' },
  },
  identifier: { value: { table: 'patient.identifiers', enc: 'value_enc', plain: 'value', domain: 'identifier' } },
  booking: {
    phone: { table: 'clinical.bookings', enc: 'phone_enc', plain: 'phone', domain: 'phone' },
    nationalId: { table: 'clinical.bookings', enc: 'national_id_enc', plain: 'national_id', domain: 'identifier' },
  },
};

/** Cột mã hoá theo bảng (dùng cho mã hoá lại / xoay khoá index / backfill / thống kê). */
export const SEALED_COLUMNS: ReadonlyArray<{
  table: string; id: string; kind: SubjectKind; plain: string; enc: string; bidx: string | null; hint: string; domain: PiiDomain; extraNull?: string;
}> = [
  { table: 'patient.persons', id: 'person_id', kind: 'person', plain: 'phone', enc: 'phone_enc', bidx: 'phone_bidx', hint: 'phone_hint', domain: 'phone', extraNull: 'phone_key' },
  { table: 'patient.persons', id: 'person_id', kind: 'person', plain: 'email', enc: 'email_enc', bidx: null, hint: 'email_hint', domain: 'email' },
  { table: 'patient.identifiers', id: 'identifier_id', kind: 'identifier', plain: 'value', enc: 'value_enc', bidx: 'value_bidx', hint: 'value_hint', domain: 'identifier' },
  { table: 'clinical.bookings', id: 'booking_id', kind: 'booking', plain: 'phone', enc: 'phone_enc', bidx: 'phone_bidx', hint: 'phone_hint', domain: 'phone' },
  { table: 'clinical.bookings', id: 'booking_id', kind: 'booking', plain: 'national_id', enc: 'national_id_enc', bidx: 'national_id_bidx', hint: 'national_id_hint', domain: 'identifier' },
];

export interface KeyStatus {
  readonly activeKekId: string;
  readonly configuredKekIds: readonly string[];
  readonly keys: ReadonlyArray<{ purpose: KeyPurpose; version: number; kekId: string; status: string; createdAt: string }>;
  /** Số khoá chủ thể theo phiên bản DEK đang bọc chúng (F17). */
  readonly byDataVersion: Readonly<Record<string, number>>;
  /** Số bản mã còn dạng `e1` (DEK tenant, F16) — chuyển sang khoá chủ thể bằng "Mã hoá lại". */
  readonly legacyTenantTokens: number;
  /** Khoá chủ thể: đang dùng / đã huỷ. */
  readonly subjectKeys: { readonly active: number; readonly shredded: number };
  /** Số giá trị còn ở bản rõ (chưa backfill) theo cột. */
  readonly plaintextRemaining: ReadonlyArray<{ column: string; rows: number }>;
  readonly snapshotsPlaintext: number;
}

// ---------------------------------------------------------------------------
// Lõi dùng chung (service + scripts/pii-backfill.ts) — chạy trong transaction của MỘT tenant
// ---------------------------------------------------------------------------
export async function plaintextStats(db: TenantScopedDb): Promise<{ columns: Array<{ column: string; rows: number }>; snapshots: number }> {
  const columns: Array<{ column: string; rows: number }> = [];
  for (const c of SEALED_COLUMNS) {
    const r = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${c.table} WHERE tenant_id = $1 AND ${c.plain} IS NOT NULL`, [db.tenantId]);
    columns.push({ column: `${c.table}.${c.plain}`, rows: Number(r.rows[0]!.n) });
  }
  const s = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM patient.person_merges WHERE tenant_id = $1
        AND (source_snapshot->>'phone' IS NOT NULL OR source_snapshot->>'email' IS NOT NULL
             OR target_snapshot->>'phone' IS NOT NULL OR target_snapshot->>'email' IS NOT NULL)`,
    [db.tenantId],
  );
  return { columns, snapshots: Number(s.rows[0]!.n) };
}

/**
 * Mã hoá dữ liệu cũ: mỗi giá trị bản rõ -> bản mã + index + hint, GIẢI MÃ LẠI để kiểm tra khớp, rồi mới xoá bản rõ.
 * Ảnh chụp gộp hồ sơ: phone/email bản rõ -> khối `contact` đã mã hoá (qua patient.seal_merge_snapshot).
 * Trả số giá trị đã xử lý; gọi lặp tới khi 0.
 */
export async function backfillBatch(db: TenantScopedDb, pii: TenantPii, limit = 500): Promise<number> {
  let done = 0;
  for (const c of SEALED_COLUMNS) {
    if (done >= limit) break;
    const r = await db.query<Record<string, string>>(
      `SELECT ${c.id} AS id, ${c.plain} AS v FROM ${c.table} WHERE tenant_id = $1 AND ${c.plain} IS NOT NULL ORDER BY ${c.id} LIMIT ${limit - done} FOR UPDATE`,
      [db.tenantId],
    );
    for (const row of r.rows) {
      const plain = row['v']!;
      const subject = { kind: c.kind, id: String(row['id']) };
      const p = await pii.protect(c.domain, plain, subject);
      if ((await pii.open(c.domain, p.enc!, subject)) !== plain) throw new ClinicalError('INVALID_STATE', 'Backfill verification failed', { reason: 'BACKFILL_VERIFY_FAILED' });
      const sets = [`${c.enc} = $3`, `${c.hint} = $4`, `${c.plain} = NULL`];
      const params: unknown[] = [db.tenantId, row['id'], p.enc, p.hint];
      if (c.bidx) {
        params.push(p.bidx);
        sets.push(`${c.bidx} = $${params.length}`);
      }
      if (c.extraNull) sets.push(`${c.extraNull} = NULL`);
      await db.query(`UPDATE ${c.table} SET ${sets.join(', ')} WHERE tenant_id = $1 AND ${c.id} = $2`, params);
      done++;
    }
  }
  // Ảnh chụp gộp hồ sơ.
  if (done < limit) {
    const m = await db.query<Record<string, string>>(
      `SELECT merge_id, source_person_id AS sp, target_person_id AS tp, source_snapshot::text AS s, target_snapshot::text AS t FROM patient.person_merges WHERE tenant_id = $1
          AND (source_snapshot->>'phone' IS NOT NULL OR source_snapshot->>'email' IS NOT NULL
               OR target_snapshot->>'phone' IS NOT NULL OR target_snapshot->>'email' IS NOT NULL)
        ORDER BY merge_id LIMIT ${limit - done}`,
      [db.tenantId],
    );
    for (const row of m.rows) {
      const seal = async (raw: string | null, personId: string): Promise<Record<string, unknown> | null> => {
        if (raw === null) return null;
        const snap = JSON.parse(raw) as Record<string, unknown>;
        const subject = { kind: 'person' as const, id: personId };
        const ph = await pii.protect('phone', (snap['phone'] as string | null | undefined) ?? null, subject);
        const em = await pii.protect('email', (snap['email'] as string | null | undefined) ?? null, subject);
        return { ...snap, phone: null, email: null, contact: { phoneEnc: ph.enc, phoneBidx: ph.bidx, phoneHint: ph.hint, emailEnc: em.enc, emailHint: em.hint } };
      };
      await db.query('SELECT patient.seal_merge_snapshot($1, $2::jsonb, $3::jsonb)', [
        row['merge_id'], JSON.stringify(await seal(row['s'] ?? null, String(row['sp']))),
        row['t'] === null || row['t'] === undefined ? null : JSON.stringify(await seal(row['t'], String(row['tp']))),
      ]);
      done++;
    }
  }
  return done;
}

/**
 * "Mã hoá lại" (F17): (1) chuyển bản mã `e1` (DEK tenant, F16) sang khoá chủ thể `s1` — kể cả khối liên hệ trong ảnh chụp gộp hồ sơ;
 * (2) bọc lại các khoá chủ thể còn dùng DEK cũ bằng DEK hiện hành (dữ liệu không cần mã hoá lại). Trả số mục đã xử lý; gọi lặp tới khi 0.
 */
export async function reencryptBatch(db: TenantScopedDb, pii: TenantPii, limit = 500): Promise<number> {
  let done = 0;
  for (const c of SEALED_COLUMNS) {
    if (done >= limit) break;
    const r = await db.query<Record<string, string>>(
      `SELECT ${c.id} AS id, ${c.enc} AS e FROM ${c.table}
        WHERE tenant_id = $1 AND ${c.enc} LIKE 'e1.%' ORDER BY ${c.id} LIMIT ${limit - done} FOR UPDATE`,
      [db.tenantId],
    );
    for (const row of r.rows) {
      const subject = { kind: c.kind, id: String(row['id']) };
      const plain = await pii.open(c.domain, row['e']!);
      const fresh = await pii.seal(c.domain, plain, subject);
      if ((await pii.open(c.domain, fresh, subject)) !== plain) throw new ClinicalError('INVALID_STATE', 'Re-encryption verification failed', { reason: 'BACKFILL_VERIFY_FAILED' });
      await db.query(`UPDATE ${c.table} SET ${c.enc} = $3 WHERE tenant_id = $1 AND ${c.id} = $2`, [db.tenantId, row['id'], fresh]);
      done++;
    }
  }
  if (done < limit) {
    const m = await db.query<Record<string, string>>(
      `SELECT merge_id, source_person_id AS sp, target_person_id AS tp, source_snapshot::text AS s, target_snapshot::text AS t FROM patient.person_merges
        WHERE tenant_id = $1 AND (source_snapshot::text LIKE '%"e1.%' OR target_snapshot::text LIKE '%"e1.%') ORDER BY merge_id LIMIT ${limit - done}`,
      [db.tenantId],
    );
    for (const row of m.rows) {
      const redo = async (raw: string | null | undefined, personId: string): Promise<Record<string, unknown> | null> => {
        if (raw === null || raw === undefined) return null;
        const snap = JSON.parse(raw) as Record<string, unknown>;
        const c = snap['contact'] as Record<string, string | null> | undefined;
        if (!c) return snap;
        const out = { ...c };
        for (const [k, domain] of [['phoneEnc', 'phone'], ['emailEnc', 'email']] as const) {
          const v = c[k];
          if (v && tokenFormat(v) === 'e1') out[k] = await pii.seal(domain, await pii.open(domain, v), { kind: 'person', id: personId });
        }
        return { ...snap, contact: out };
      };
      const sNew = await redo(row['s'], String(row['sp']));
      const tNew = await redo(row['t'], String(row['tp']));
      await db.query('SELECT patient.seal_merge_snapshot($1, $2::jsonb, $3::jsonb)', [row['merge_id'], JSON.stringify(sNew), tNew === null ? null : JSON.stringify(tNew)]);
      done++;
    }
  }
  if (done < limit) done += await pii.rewrapSubjectKeys(limit - done);
  return done;
}

/** Xoay khoá blind index: tạo khoá index mới rồi tính lại MỌI index trong cùng transaction (nguyên tử). */
/**
 * Backfill toàn bộ một tenant (dùng cho scripts/pii-backfill.ts lúc triển khai): lặp theo lô tới khi hết,
 * ghi một sự kiện audit 'pii.backfill' (chỉ số đếm) và trả về số bản rõ còn lại (phải = 0).
 */
export async function backfillTenant(
  pool: PgPoolLike, tenant: string, log: (m: string) => void = () => {},
): Promise<{ encrypted: number; remaining: number; converted: number; legacyRemaining: number; stats: Awaited<ReturnType<typeof plaintextStats>> }> {
  const ctx: TenantContext = Object.freeze({
    tenantId: asTenantId(tenant), userSubject: 'service:pii-backfill', userId: null, personId: null, activeOrganizationId: null,
    allowedOrganizationIds: Object.freeze([]), roles: Object.freeze([]), tokenId: null, correlationId: randomUUID() as CorrelationId,
  });
  let total = 0;
  for (;;) {
    const n = await withTenantTransaction(pool, async (db) => backfillBatch(db, new TenantPii(db), 500), ctx);
    total += n;
    if (n === 0) break;
    log(`  ${tenant}: +${n} (tổng ${total})`);
  }
  // F17: chuyển bản mã e1 (DEK tenant) sang khoá theo chủ thể (s1) + bọc lại khoá chủ thể còn dùng DEK cũ.
  let converted = 0;
  for (;;) {
    const n = await withTenantTransaction(pool, async (db) => reencryptBatch(db, new TenantPii(db), 500), ctx);
    converted += n;
    if (n === 0) break;
    log(`  ${tenant}: chuyển sang khoá theo người +${n} (tổng ${converted})`);
  }
  let legacyRemaining = 0;
  const stats = await withTenantTransaction(pool, async (db) => {
    const st = await plaintextStats(db);
    legacyRemaining = (await new Repo(db).countByVersion()).legacy;
    await db.query(
      `INSERT INTO platform.audit_events (tenant_id, actor_type, actor_id, action, resource_type, outcome, correlation_id, payload)
       VALUES ($1, 'service', 'pii-backfill', 'pii.backfill', 'TenantKey', 'success', $2, $3::jsonb)`,
      [tenant, ctx.correlationId, JSON.stringify({ encrypted: total, converted, legacyRemaining, remaining: st })],
    );
    return st;
  }, ctx);
  return { encrypted: total, remaining: stats.columns.reduce((a, c) => a + c.rows, 0) + stats.snapshots, converted, legacyRemaining, stats };
}

export async function rotateIndexKey(db: TenantScopedDb, pii: TenantPii): Promise<{ version: number; recomputed: number }> {
  // Khoá tất cả bảng liên quan để không có ghi xen giữa (index cũ / mới lẫn lộn).
  await db.query('LOCK TABLE patient.persons, patient.identifiers, clinical.bookings IN SHARE ROW EXCLUSIVE MODE');
  const version = await pii.rotate('index');
  let n = 0;
  for (const c of SEALED_COLUMNS) {
    if (!c.bidx) continue;
    const r = await db.query<Record<string, string>>(`SELECT ${c.id} AS id, ${c.enc} AS e FROM ${c.table} WHERE tenant_id = $1 AND ${c.enc} IS NOT NULL`, [db.tenantId]);
    for (const row of r.rows) {
      const idx = await pii.index(c.domain, await pii.open(c.domain, row['e']!, { kind: c.kind, id: String(row['id']) }));
      await db.query(`UPDATE ${c.table} SET ${c.bidx} = $3 WHERE tenant_id = $1 AND ${c.id} = $2`, [db.tenantId, row['id'], idx]);
      n++;
    }
  }
  return { version, recomputed: n };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class Repo extends PgClinicalRepository {
  constructor(readonly tdb: TenantScopedDb) {
    super(tdb);
  }
  get codec(): TenantPii {
    return this.pii;
  }
  /** Cơ sở mà bản ghi thuộc về (person: các cơ sở có hồ sơ bệnh nhân). */
  async scope(kind: RevealKind, id: string): Promise<{ orgs: OrganizationId[]; personId: string | null } | null> {
    if (kind === 'booking') {
      const r = await this.tdb.query<{ organization_id: OrganizationId }>(`SELECT organization_id FROM clinical.bookings WHERE tenant_id = $1 AND booking_id = $2`, [this.tdb.tenantId, id]);
      return r.rows[0] ? { orgs: [r.rows[0].organization_id], personId: null } : null;
    }
    let personId = id;
    if (kind === 'identifier') {
      const r = await this.tdb.query<{ person_id: string }>(`SELECT person_id FROM patient.identifiers WHERE tenant_id = $1 AND identifier_id = $2`, [this.tdb.tenantId, id]);
      if (!r.rows[0]) return null;
      personId = r.rows[0].person_id;
    } else {
      const r = await this.tdb.query(`SELECT 1 FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [this.tdb.tenantId, id]);
      if (!r.rows[0]) return null;
    }
    const p = await this.tdb.query<{ organization_id: OrganizationId }>(
      `SELECT DISTINCT organization_id FROM patient.patients WHERE tenant_id = $1 AND person_id = $2`,
      [this.tdb.tenantId, personId],
    );
    return { orgs: p.rows.map((x) => x.organization_id), personId };
  }
  /** patientId -> (person | identifier CCCD đang hiệu lực); null nếu không có. */
  async resolvePatient(patientId: string, field: string): Promise<{ kind: RevealKind; id: string } | null> {
    const m = PATIENT_FIELDS[field];
    if (!m) return null;
    const r = await this.tdb.query<{ person_id: string; identifier_id: string | null }>(
      `SELECT pt.person_id,
              (SELECT i.identifier_id FROM patient.identifiers i
                WHERE i.tenant_id = pt.tenant_id AND i.person_id = pt.person_id AND i.type = 'national_id' AND i.status = 'active'
                ORDER BY i.created_at DESC LIMIT 1) AS identifier_id
         FROM patient.patients pt WHERE pt.tenant_id = $1 AND pt.patient_id = $2`,
      [this.tdb.tenantId, patientId],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (m.kind === 'person') return { kind: 'person', id: row.person_id };
    return row.identifier_id ? { kind: 'identifier', id: row.identifier_id } : null;
  }
  async sealedValue(f: { table: string; enc: string; plain: string }, idCol: string, id: string): Promise<{ enc: string | null; plain: string | null; erased: boolean } | null> {
    const r = await this.tdb.query<Record<string, string | null>>(
      `SELECT ${f.enc} AS e, ${f.plain} AS p, erased_at AS x FROM ${f.table} WHERE tenant_id = $1 AND ${idCol} = $2`,
      [this.tdb.tenantId, id],
    );
    return r.rows[0] ? { enc: r.rows[0]['e'] ?? null, plain: r.rows[0]['p'] ?? null, erased: r.rows[0]['x'] !== null && r.rows[0]['x'] !== undefined } : null;
  }
  async countByVersion(): Promise<{ byDataVersion: Record<string, number>; legacy: number; active: number; shredded: number }> {
    const out: Record<string, number> = {};
    let legacy = 0;
    for (const c of SEALED_COLUMNS) {
      const r = await this.tdb.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${c.table} WHERE tenant_id = $1 AND ${c.enc} LIKE 'e1.%'`, [this.tdb.tenantId]);
      legacy += Number(r.rows[0]!.n);
    }
    const sn = await this.tdb.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM patient.person_merges WHERE tenant_id = $1 AND (source_snapshot::text LIKE '%"e1.%' OR target_snapshot::text LIKE '%"e1.%')`,
      [this.tdb.tenantId],
    );
    legacy += Number(sn.rows[0]!.n);
    const k = await this.tdb.query<{ v: string | number; status: string; n: string | number }>(
      `SELECT dek_version AS v, status, count(*) AS n FROM keyvault.subject_keys WHERE tenant_id = $1 GROUP BY 1, 2`,
      [this.tdb.tenantId],
    );
    let active = 0;
    let shredded = 0;
    for (const x of k.rows) {
      if (x.status === 'active') {
        out[String(x.v)] = (out[String(x.v)] ?? 0) + Number(x.n);
        active += Number(x.n);
      } else shredded += Number(x.n);
    }
    return { byDataVersion: out, legacy, active, shredded };
  }
}

const ID_COL: Readonly<Record<RevealKind, string>> = { person: 'person_id', identifier: 'identifier_id', booking: 'booking_id' };

export class PiiService {
  private readonly clock: () => Date;
  constructor(private readonly deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async reveal(input: { kind: unknown; id: unknown; field: unknown; reason: unknown }, ctx: TenantContext = requireTenantContext()): Promise<{ value: string | null }> {
    return this.run(ctx, 'pii.reveal', async (repo) => {
      let kind = input.kind as RevealKind | 'patient';
      let field = String(input.field);
      if (kind !== 'patient' && !(kind in FIELDS)) throw new ClinicalError('VALIDATION', 'kind must be patient | person | identifier | booking');
      if (kind === 'patient' ? !PATIENT_FIELDS[field] : !FIELDS[kind][field]) throw new ClinicalError('VALIDATION', 'Unknown field for this kind');
      if (typeof input.id !== 'string' || !isUuid(input.id)) throw new ClinicalError('VALIDATION', 'id must be a UUID');
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length < 5 || reason.length > 200) throw new ClinicalError('VALIDATION', 'reason must be 5-200 characters', { reason: 'REASON_REQUIRED' });
      let id = input.id.toLowerCase();
      if (kind === 'patient') {
        const t = await repo.resolvePatient(id, field);
        if (!t) throw new ClinicalError('NOT_FOUND', 'Record not found');
        ({ kind, id } = t);
        field = PATIENT_FIELDS[field]!.field;
      }
      const f = FIELDS[kind][field]!;
      const scope = await repo.scope(kind, id);
      if (!scope) throw new ClinicalError('NOT_FOUND', 'Record not found');
      // Chỉ xét cơ sở người dùng đang được phép trong token; cần quyền pii:reveal tại ít nhất một cơ sở của bản ghi.
      const orgs = scope.orgs.filter((o) => ctx.allowedOrganizationIds.includes(o));
      const user = await this.user(repo, ctx);
      let allowedAt: OrganizationId | null = null;
      for (const org of orgs) {
        if (this.allowed(await this.grants(repo, user, org), user, 'pii:reveal')) {
          allowedAt = org;
          break;
        }
      }
      if (!allowedAt) throw new ClinicalError('FORBIDDEN', 'Missing permission pii:reveal for this record');
      const sealed = await repo.sealedValue(f, ID_COL[kind], id);
      if (!sealed) throw new ClinicalError('NOT_FOUND', 'Record not found');
      if (sealed.erased) throw new ClinicalError('NOT_FOUND', 'Data has been erased', { reason: 'PII_ERASED' });
      const subject = { kind: (kind === 'booking' ? 'booking' : kind === 'identifier' ? 'identifier' : 'person') as SubjectKind, id };
      let value: string | null;
      try {
        value = sealed.enc ? await repo.codec.open(f.domain, sealed.enc, subject) : sealed.plain;
      } catch (e) {
        if (e instanceof PiiShreddedError) throw new ClinicalError('NOT_FOUND', 'Data has been erased', { reason: 'PII_ERASED' });
        throw e;
      }
      await repo.appendAudit(this.event(ctx, 'pii.reveal', allowedAt, 'success', user, {
        kind, recordId: id, field, reason, ...(scope.personId ? { personId: scope.personId } : {}),
      }, kind === 'booking' ? 'Booking' : 'Person', id));
      return { value };
    });
  }

  async keys(ctx: TenantContext = requireTenantContext()): Promise<KeyStatus> {
    return this.admin(ctx, 'pii.keys.read', async (repo) => {
      const rows = await repo.codec.listKeys();
      const stats = await plaintextStats(repo.tdb);
      const kp = keyProvider();
      return {
        activeKekId: kp.activeKekId,
        configuredKekIds: kp.kekIds(),
        keys: rows.map((r) => ({ purpose: r.purpose, version: r.version, kekId: r.kekId, status: r.status, createdAt: r.createdAt })),
        ...(await repo.countByVersion().then((c) => ({ byDataVersion: c.byDataVersion, legacyTenantTokens: c.legacy, subjectKeys: { active: c.active, shredded: c.shredded } }))),
        plaintextRemaining: stats.columns,
        snapshotsPlaintext: stats.snapshots,
      };
    });
  }

  async rotate(purpose: unknown, ctx: TenantContext = requireTenantContext()): Promise<{ purpose: KeyPurpose; version: number; recomputed?: number }> {
    if (purpose !== 'data' && purpose !== 'index') throw new ClinicalError('VALIDATION', "purpose must be 'data' or 'index'");
    return this.admin(ctx, `pii.keys.rotate.${purpose}`, async (repo) => {
      if (purpose === 'data') return { purpose, version: await repo.codec.rotate('data') };
      const r = await rotateIndexKey(repo.tdb, repo.codec);
      return { purpose, version: r.version, recomputed: r.recomputed };
    });
  }

  async reencrypt(limit: unknown, ctx: TenantContext = requireTenantContext()): Promise<{ reencrypted: number }> {
    const n = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    return this.admin(ctx, 'pii.keys.reencrypt', async (repo) => ({ reencrypted: await reencryptBatch(repo.tdb, repo.codec, n) }));
  }

  async rewrap(ctx: TenantContext = requireTenantContext()): Promise<{ rewrapped: number; kekId: string }> {
    return this.admin(ctx, 'pii.keys.rewrap', async (repo) => ({ rewrapped: await repo.codec.rewrapAll(), kekId: keyProvider().activeKekId }));
  }

  async backfill(limit: unknown, ctx: TenantContext = requireTenantContext()): Promise<{ encrypted: number }> {
    const n = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    return this.admin(ctx, 'pii.backfill', async (repo) => ({ encrypted: await backfillBatch(repo.tdb, repo.codec, n) }));
  }

  // ---- nội bộ -------------------------------------------------------------------
  private async admin<T extends object>(ctx: TenantContext, action: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
    return this.run(ctx, action, async (repo) => {
      const user = await this.user(repo, ctx);
      const now = this.clock().getTime();
      const valid = (await repo.listMemberships(user.userId)).filter(
        (m: Membership) => m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
      );
      const grants = await buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>);
      if (!this.allowed(grants, user, 'keys:manage')) throw new ClinicalError('FORBIDDEN', 'Missing permission keys:manage');
      const out = await fn(repo);
      if (action !== 'pii.keys.read') await repo.appendAudit(this.event(ctx, action, null, 'success', user, { ...(out as Record<string, unknown>) }, 'TenantKey', null));
      return out;
    });
  }
  private async user(repo: Repo, ctx: TenantContext): Promise<User> {
    const user = await repo.findUserBySubject(ctx.userSubject);
    if (!user || user.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
    assertSameTenant(user, ctx);
    return user;
  }
  private async grants(repo: Repo, user: User, org: OrganizationId): Promise<readonly AccessGrant[]> {
    const now = this.clock().getTime();
    const valid = (await repo.listMemberships(user.userId)).filter(
      (m: Membership) => m.organizationId === org && m.status === 'active' && Date.parse(m.validFrom) <= now && (m.validTo === null || Date.parse(m.validTo) > now),
    );
    return buildGrants(valid, user.tenantId, (ids: readonly AccessPolicyId[]) => repo.findAccessPolicies(ids) as Promise<AccessPolicy[]>);
  }
  private allowed(grants: readonly AccessGrant[], user: User, perm: Permission): boolean {
    return decideAccess(grants, perm as PolicyAction, PERMISSIONS[ACCESS_POLICY_CATALOG[perm as PolicyAction].basePermission as Permission], { callerUserId: user.userId }).allowed;
  }
  private event(
    ctx: TenantContext, action: string, org: OrganizationId | null, outcome: NewAuditEvent['outcome'], user: User | null, payload: Record<string, unknown>,
    resourceType = 'PII', resourceId: string | null = null,
  ): NewAuditEvent {
    return {
      eventId: randomUUID() as AuditEventId, tenantId: ctx.tenantId, actor: { type: 'user', id: user?.userId ?? ctx.userSubject }, organizationId: org, action,
      resourceType, resourceId, personId: null, patientId: null, outcome, correlationId: ctx.correlationId as CorrelationId, sourceIp: null, userAgent: null, payload,
    };
  }
  private async run<T>(ctx: TenantContext, action: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
    try {
      return await withTenantTransaction(
        this.deps.pool,
        async (db) => {
          await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userSubject]);
          return fn(new Repo(db));
        },
        ctx,
      );
    } catch (e) {
      const code = e instanceof ClinicalError || e instanceof TenantIsolationError ? e.code : 'INTERNAL';
      const outcome: NewAuditEvent['outcome'] = (e instanceof ClinicalError && e.code === 'FORBIDDEN') || e instanceof TenantIsolationError ? 'denied' : 'failure';
      try {
        await this.deps.audit.record(this.event(ctx, action, null, outcome, null, { code }));
      } catch {
        /* bỏ qua */
      }
      throw e;
    }
  }
}

/** Gợi ý che tính lại (dùng cho test). */
export const hintOf = maskFor;
