/**
 * HCOS-F20 | Phía nhân viên của cổng bệnh nhân.
 *   portal:manage    lễ tân / điều dưỡng, quản lý — lập (sau khi xác minh giấy tờ tại quầy) / thu hồi liên kết người giám hộ;
 *                    xem số phiên đang mở, đăng xuất mọi thiết bị của người bệnh.
 *   portal:requests  lễ tân / điều dưỡng, quản lý — xem và xử lý yêu cầu đính chính gửi từ cổng.
 * Yêu cầu xoá gửi từ cổng đi thẳng vào quy trình F17 (thẻ Lưu giữ & xoá dữ liệu).
 */
import { isUuid, type AuditSink, type OrganizationId, type Role, type TenantContext } from '../../../../packages/domain/src/s0-contracts';
import { requireTenantContext, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, isoOrNull, num } from '../clinical/encounter.service';
import { GovernanceBase, optStr, str, type GovRepo, type Principal } from '../governance/governance-base';
import { MrnError, normalizeMrnQuery } from '../registry/mrn';

type Permission = 'portal:manage' | 'portal:requests';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = {
  'portal:manage': ['clinic_staff', 'clinic_admin', 'tenant_admin'],
  'portal:requests': ['clinic_staff', 'clinic_admin', 'tenant_admin'],
};
export const RELATIONSHIPS = ['parent', 'legal_guardian', 'child', 'spouse', 'sibling', 'other'] as const;

const uuid = (v: unknown, f: string): string => {
  if (typeof v !== 'string' || !isUuid(v)) throw new ClinicalError('VALIDATION', `${f} must be a UUID`);
  return v.toLowerCase();
};
const vnToday = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);

/* eslint-disable @typescript-eslint/no-explicit-any */
export class PortalAdminService extends GovernanceBase<Permission> {
  constructor(deps: { pool: PgPoolLike; audit: AuditSink; clock?: () => Date }) {
    super(deps, PERMISSIONS, 'PatientPortal');
  }

  /** Thẻ "Cổng bệnh nhân" trên trang hồ sơ: liên kết giám hộ (hai chiều), phiên đang mở, yêu cầu đính chính của người này. */
  async patientPanel(patientIdIn: unknown, ctx: TenantContext = requireTenantContext()) {
    const patientId = uuid(patientIdIn, 'patientId');
    return this.run(ctx, 'portal.panel.read', async (repo) => {
      const pt = await this.patient(repo, patientId);
      const { p, g } = await this.at(repo, ctx, pt.org);
      this.need(g, p.user, 'portal:manage');
      const links = (await repo.tdb.query<any>(
        `SELECT g.link_id, g.guardian_person_id, g.dependent_person_id, g.relationship, g.valid_until::text AS valid_until, g.status, g.note, g.verified_at, g.revoked_at,
                g.revoke_reason, vu.display_name AS verified_by_name,
                gp.family_name AS g_family, gp.given_name AS g_given, dp.family_name AS d_family, dp.given_name AS d_given,
                (SELECT mrn FROM patient.patients x WHERE x.tenant_id = g.tenant_id AND x.person_id = g.guardian_person_id ORDER BY (x.organization_id = $3) DESC LIMIT 1) AS g_mrn,
                (SELECT mrn FROM patient.patients x WHERE x.tenant_id = g.tenant_id AND x.person_id = g.dependent_person_id ORDER BY (x.organization_id = $3) DESC LIMIT 1) AS d_mrn
           FROM patient.guardian_links g
           JOIN patient.persons gp ON gp.tenant_id = g.tenant_id AND gp.person_id = g.guardian_person_id
           JOIN patient.persons dp ON dp.tenant_id = g.tenant_id AND dp.person_id = g.dependent_person_id
           LEFT JOIN iam.users vu ON vu.tenant_id = g.tenant_id AND vu.user_id = g.verified_by
          WHERE g.tenant_id = $1 AND (g.guardian_person_id = $2 OR g.dependent_person_id = $2) ORDER BY g.status, g.verified_at DESC`,
        [repo.tenantId, pt.personId, pt.org])).rows;
      const today = vnToday(this.clock());
      const sessions = num((await repo.tdb.query<any>(
        `SELECT count(*) AS n FROM portal.sessions WHERE tenant_id = $1 AND person_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [repo.tenantId, pt.personId])).rows[0]?.n);
      const requests = (await repo.tdb.query<any>(
        `SELECT request_id, message, status, resolution_note, created_at, resolved_at FROM portal.requests WHERE tenant_id = $1 AND person_id = $2 ORDER BY created_at DESC LIMIT 20`,
        [repo.tenantId, pt.personId])).rows.map(mapRequest);
      return {
        personId: pt.personId,
        links: links.map((x: any) => {
          const asGuardian = x.guardian_person_id === pt.personId;
          return {
            linkId: x.link_id, role: asGuardian ? 'guardian' : 'dependent', relationship: x.relationship, validUntil: String(x.valid_until).slice(0, 10),
            status: x.status === 'active' && String(x.valid_until).slice(0, 10) <= today ? 'expired' : x.status, note: x.note ?? null,
            other: asGuardian ? { name: `${x.d_family ?? ''} ${x.d_given ?? ''}`.trim(), mrn: x.d_mrn ?? null } : { name: `${x.g_family ?? ''} ${x.g_given ?? ''}`.trim(), mrn: x.g_mrn ?? null },
            verifiedAt: iso(x.verified_at), verifiedByName: x.verified_by_name ?? null, revokedAt: isoOrNull(x.revoked_at), revokeReason: x.revoke_reason ?? null,
          };
        }),
        activeSessions: sessions,
        requests,
        canResolve: this.allowed(g, p.user, 'portal:requests'),
      };
    });
  }

  /** Lập liên kết: người giám hộ (tìm theo mã BN) — người phụ thuộc (hồ sơ đang mở). Nhân viên xác nhận đã kiểm giấy tờ tại quầy. */
  async link(input: { dependentPatientId: unknown; guardianMrn: unknown; relationship: unknown; validUntil?: unknown; note?: unknown; verified: unknown }, ctx: TenantContext = requireTenantContext()) {
    const dependentPatientId = uuid(input.dependentPatientId, 'dependentPatientId');
    if (!(RELATIONSHIPS as readonly unknown[]).includes(input.relationship)) throw new ClinicalError('VALIDATION', `relationship must be one of ${RELATIONSHIPS.join(', ')}`);
    if (input.verified !== true) throw new ClinicalError('VALIDATION', 'Confirm that identity and relationship documents were checked at the desk', { reason: 'VERIFICATION_REQUIRED' });
    let mrn: string;
    try {
      mrn = normalizeMrnQuery(str(input.guardianMrn, 1, 64, 'guardianMrn'));
    } catch (e) {
      if (e instanceof MrnError) throw new ClinicalError('VALIDATION', e.message, { reason: e.reason });
      throw e;
    }
    const until = input.validUntil === undefined || input.validUntil === null || input.validUntil === '' ? null : String(input.validUntil);
    if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new ClinicalError('VALIDATION', 'validUntil must be YYYY-MM-DD');
    const note = optStr(input.note, 300, 'note');
    return this.run(ctx, 'portal.guardian.link', async (repo) => {
      const dep = await this.patient(repo, dependentPatientId);
      const { p, g } = await this.at(repo, ctx, dep.org);
      this.need(g, p.user, 'portal:manage');
      const gr = (await repo.tdb.query<any>(
        `SELECT pt.person_id FROM patient.patients pt JOIN patient.persons ps ON ps.tenant_id = pt.tenant_id AND ps.person_id = pt.person_id
          WHERE pt.tenant_id = $1 AND pt.organization_id = $2 AND upper(pt.mrn) = upper($3) AND ps.erased_at IS NULL`, [repo.tenantId, dep.org, mrn])).rows[0];
      if (!gr) throw new ClinicalError('NOT_FOUND', 'Guardian patient code not found in this clinic', { reason: 'GUARDIAN_NOT_FOUND' });
      if (gr.person_id === dep.personId) throw new ClinicalError('VALIDATION', 'A person cannot be their own guardian', { reason: 'SELF_LINK' });
      const minor = (await repo.tdb.query<any>(
        `SELECT (birth_date + interval '18 years')::date::text AS adult FROM patient.persons WHERE tenant_id = $1 AND person_id = $2`, [repo.tenantId, dep.personId])).rows[0]?.adult as string | null;
      const today = vnToday(this.clock());
      const isMinor = minor !== null && minor !== undefined && minor > today;
      // Trẻ em: hết hạn ngày tròn 18 tuổi (CSDL cũng ép). Người lớn (vd. cha mẹ già): bắt buộc ngày hết hạn do lễ tân nhập.
      const validUntil = isMinor ? (until !== null && until < minor! ? until : minor!) : until;
      if (validUntil === null) throw new ClinicalError('VALIDATION', 'Adult dependent: enter an end date for the link', { reason: 'VALID_UNTIL_REQUIRED' });
      let id: string;
      try {
        id = (await repo.tdb.query<any>(
          `INSERT INTO patient.guardian_links (tenant_id, guardian_person_id, dependent_person_id, relationship, valid_until, note, verified_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING link_id`, [repo.tenantId, gr.person_id, dep.personId, input.relationship, validUntil, note, p.user.userId])).rows[0].link_id;
      } catch (e) {
        const c = (e as { code?: string }).code;
        if (c === '23505') throw new ClinicalError('CONFLICT', 'This guardian link already exists', { reason: 'LINK_EXISTS' });
        if (c === '23514') throw new ClinicalError('VALIDATION', (e as Error).message, { reason: 'LINK_INVALID' });
        throw e;
      }
      await repo.appendAudit({ ...this.event(ctx, 'portal.guardian.link', 'success', p.user, { linkId: id, relationship: input.relationship, validUntil }, id, dep.org), personId: dep.personId as never });
      return { linkId: id, validUntil };
    });
  }

  async revokeLink(linkIdIn: unknown, input: { reason: unknown }, ctx: TenantContext = requireTenantContext()) {
    const id = uuid(linkIdIn, 'linkId');
    const reason = str(input.reason, 3, 300, 'reason');
    return this.run(ctx, 'portal.guardian.revoke', async (repo) => {
      const l = (await repo.tdb.query<any>(
        `SELECT g.status, g.dependent_person_id, (SELECT organization_id FROM patient.patients x WHERE x.tenant_id = g.tenant_id AND x.person_id = g.dependent_person_id LIMIT 1) AS org
           FROM patient.guardian_links g WHERE g.tenant_id = $1 AND g.link_id = $2`, [repo.tenantId, id])).rows[0];
      if (!l) throw new ClinicalError('NOT_FOUND', 'Link not found');
      const { p, g } = await this.at(repo, ctx, l.org);
      this.need(g, p.user, 'portal:manage');
      if (l.status !== 'active') throw new ClinicalError('CONFLICT', 'Link already revoked', { reason: 'LINK_REVOKED' });
      await repo.tdb.query(`UPDATE patient.guardian_links SET status = 'revoked', revoked_by = $3, revoked_at = now(), revoke_reason = $4 WHERE tenant_id = $1 AND link_id = $2`,
        [repo.tenantId, id, p.user.userId, reason]);
      await repo.appendAudit({ ...this.event(ctx, 'portal.guardian.revoke', 'success', p.user, { linkId: id }, id, l.org), personId: l.dependent_person_id as never });
      return { linkId: id, status: 'revoked' };
    });
  }

  /** Đăng xuất mọi thiết bị của người bệnh (vd. mất điện thoại). */
  async revokeSessions(patientIdIn: unknown, ctx: TenantContext = requireTenantContext()) {
    const patientId = uuid(patientIdIn, 'patientId');
    return this.run(ctx, 'portal.sessions.revoke', async (repo) => {
      const pt = await this.patient(repo, patientId);
      const { p, g } = await this.at(repo, ctx, pt.org);
      this.need(g, p.user, 'portal:manage');
      const r = await repo.tdb.query(`UPDATE portal.sessions SET revoked_at = now(), revoked_reason = 'staff' WHERE tenant_id = $1 AND person_id = $2 AND revoked_at IS NULL RETURNING session_id`,
        [repo.tenantId, pt.personId]);
      await repo.appendAudit({ ...this.event(ctx, 'portal.sessions.revoke', 'success', p.user, { count: r.rows.length }, null, pt.org), personId: pt.personId as never });
      return { revoked: r.rows.length };
    });
  }

  async listRequests(q: { organizationId: unknown; status?: unknown }, ctx: TenantContext = requireTenantContext()) {
    const org = uuid(q.organizationId, 'organizationId') as OrganizationId;
    const status = q.status === 'all' ? null : 'open';
    return this.run(ctx, 'portal.requests.read', async (repo) => {
      const { p, g } = await this.at(repo, ctx, org);
      this.need(g, p.user, 'portal:requests');
      const rows = (await repo.tdb.query<any>(
        `SELECT r.request_id, r.message, r.status, r.resolution_note, r.created_at, r.resolved_at, r.person_id, ps.family_name, ps.given_name,
                (SELECT x.patient_id FROM patient.patients x WHERE x.tenant_id = r.tenant_id AND x.person_id = r.person_id AND x.organization_id = r.organization_id LIMIT 1) AS patient_id,
                (SELECT x.mrn FROM patient.patients x WHERE x.tenant_id = r.tenant_id AND x.person_id = r.person_id AND x.organization_id = r.organization_id LIMIT 1) AS mrn,
                r.submitted_by_person_id <> r.person_id AS by_guardian, u.display_name AS resolved_by_name
           FROM portal.requests r JOIN patient.persons ps ON ps.tenant_id = r.tenant_id AND ps.person_id = r.person_id
           LEFT JOIN iam.users u ON u.tenant_id = r.tenant_id AND u.user_id = r.resolved_by
          WHERE r.tenant_id = $1 AND r.organization_id = $2 ${status ? "AND r.status = 'open'" : ''} ORDER BY r.created_at DESC LIMIT 100`, [repo.tenantId, org])).rows;
      return {
        requests: rows.map((x: any) => ({
          ...mapRequest(x), patientId: x.patient_id ?? null, mrn: x.mrn ?? null, name: `${x.family_name ?? ''} ${x.given_name ?? ''}`.trim(),
          byGuardian: x.by_guardian === true || x.by_guardian === 't', resolvedByName: x.resolved_by_name ?? null,
        })),
        canResolve: this.allowed(g, p.user, 'portal:requests'),
      };
    });
  }

  async resolveRequest(idIn: unknown, input: { status: unknown; note: unknown }, ctx: TenantContext = requireTenantContext()) {
    const id = uuid(idIn, 'requestId');
    if (input.status !== 'resolved' && input.status !== 'rejected') throw new ClinicalError('VALIDATION', "status must be 'resolved' or 'rejected'");
    const note = str(input.note, 5, 1000, 'note');
    return this.run(ctx, 'portal.request.resolve', async (repo) => {
      const r = (await repo.tdb.query<any>(`SELECT organization_id, status, person_id FROM portal.requests WHERE tenant_id = $1 AND request_id = $2`, [repo.tenantId, id])).rows[0];
      if (!r) throw new ClinicalError('NOT_FOUND', 'Request not found');
      const { p, g } = await this.at(repo, ctx, r.organization_id);
      this.need(g, p.user, 'portal:requests');
      if (r.status !== 'open') throw new ClinicalError('CONFLICT', 'Request already closed', { reason: 'REQUEST_CLOSED' });
      await repo.tdb.query(`UPDATE portal.requests SET status = $3, resolved_by = $4, resolved_at = now(), resolution_note = $5 WHERE tenant_id = $1 AND request_id = $2`,
        [repo.tenantId, id, input.status, p.user.userId, note]);
      await repo.appendAudit({ ...this.event(ctx, 'portal.request.resolve', 'success', p.user, { requestId: id, status: input.status }, id, r.organization_id), personId: r.person_id as never });
      return { requestId: id, status: input.status };
    });
  }

  // ---- nội bộ -------------------------------------------------------------------
  private async patient(repo: GovRepo, patientId: string): Promise<{ org: OrganizationId; personId: string }> {
    const x = (await repo.tdb.query<any>(`SELECT organization_id, person_id FROM patient.patients WHERE tenant_id = $1 AND patient_id = $2`, [repo.tenantId, patientId])).rows[0];
    if (!x) throw new ClinicalError('NOT_FOUND', 'Patient not found');
    return { org: x.organization_id, personId: x.person_id };
  }
  private async at(repo: GovRepo, ctx: TenantContext, org: OrganizationId): Promise<{ p: Principal; g: Awaited<ReturnType<Principal['at']>> }> {
    const p = await this.principal(repo, ctx);
    if (!ctx.allowedOrganizationIds.includes(org)) throw new ClinicalError('NOT_FOUND', 'Not found');
    return { p, g: await p.at(org) };
  }
}
const mapRequest = (x: any) => ({
  requestId: x.request_id, message: x.message, status: x.status as 'open' | 'resolved' | 'rejected', resolutionNote: x.resolution_note ?? null,
  createdAt: iso(x.created_at), resolvedAt: isoOrNull(x.resolved_at),
});
/* eslint-enable @typescript-eslint/no-explicit-any */
