/**
 * HCOS-F18 | Xuất dữ liệu qua máy chủ + nhật ký xuất.
 *
 * Mọi file ra khỏi hệ thống (Excel báo cáo, hồ sơ tự đánh giá, văn bản trả lời yêu cầu xoá) do MÁY CHỦ tạo:
 *  - quyền đọc dữ liệu kiểm tra bởi chính service nguồn (finance / governance / retention) — xuất không mở rộng quyền;
 *  - file có dữ liệu cá nhân => bắt buộc mục đích (5–300 ký tự); thiếu => 422 PURPOSE_REQUIRED, trình duyệt hỏi rồi gửi lại;
 *  - mỗi file có dấu nhận diện (người xuất, thời điểm, mã xuất) và được ghi governance.data_exports:
 *    ai, cơ sở, bộ dữ liệu, bộ lọc, số dòng, có dữ liệu cá nhân, mục đích, tên file, kích thước, SHA-256 — KHÔNG lưu nội dung;
 *  - tra cứu được bằng SHA-256: file rò rỉ ra ngoài => biết ai xuất, khi nào, để làm gì.
 */
import { createHash, randomUUID } from 'node:crypto';

import { isUuid, type AuditSink, type OrganizationId, type Role, type TenantContext } from '../../../../packages/domain/src/s0-contracts';
import { reportSheets, type ReportData } from '../../../../packages/exports/src/report-sheets';
import { buildXlsx, type SheetSpec } from '../../../../packages/exports/src/xlsx';
import { requireTenantContext, type PgPoolLike } from '../../../../packages/security/src/tenant-context';
import { ClinicalError, iso, num } from '../clinical/encounter.service';
import type { FinanceService } from '../finance/finance.service';
import type { GovernanceService } from './governance.service';
import { GovernanceBase, optStr } from './governance-base';
import type { RetentionService } from './retention.service';

type Permission = 'export:audit';
const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = { 'export:audit': ['clinic_admin', 'executive', 'tenant_admin'] };

export const DATASETS = {
  finance_report: { label: 'Báo cáo tài chính (Excel)', personal: 'Có thể có họ tên người bệnh còn công nợ' },
  governance_dossier: { label: 'Hồ sơ tự đánh giá cấp độ (Markdown)', personal: 'Không' },
  erasure_letter: { label: 'Văn bản trả lời yêu cầu xoá (Markdown)', personal: 'Có mã bệnh nhân' },
} as const;
export type Dataset = keyof typeof DATASETS;

export interface ExportFile {
  readonly exportId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly rowCount: number;
  readonly containsPersonal: boolean;
  readonly base64: string;
}
export interface ExportRecord {
  readonly exportId: string;
  readonly organizationId: string | null;
  readonly dataset: string;
  readonly params: Record<string, unknown>;
  readonly rowCount: number;
  readonly containsPersonal: boolean;
  readonly purpose: string | null;
  readonly fileName: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly exportedByName: string | null;
  readonly exportedAt: string;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MD = 'text/markdown; charset=utf-8';
const vnTime = (d: Date) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' }).format(d);

export class ExportService extends GovernanceBase<Permission> {
  constructor(
    private readonly src: {
      pool: PgPoolLike; audit: AuditSink; clock?: () => Date;
      finance: Pick<FinanceService, 'report'>; governance: Pick<GovernanceService, 'dossier'>; retention: Pick<RetentionService, 'letter'>;
    },
  ) {
    super(src, PERMISSIONS, 'DataExport');
  }

  async create(input: { dataset: unknown; params?: unknown; purpose?: unknown }, ctx: TenantContext = requireTenantContext()): Promise<ExportFile> {
    if (typeof input.dataset !== 'string' || !(input.dataset in DATASETS)) throw new ClinicalError('VALIDATION', `dataset must be one of ${Object.keys(DATASETS).join(', ')}`);
    const dataset = input.dataset as Dataset;
    const params = (input.params ?? {}) as Record<string, unknown>;
    if (typeof params !== 'object' || Array.isArray(params)) throw new ClinicalError('VALIDATION', 'params must be an object');
    const purpose = optStr(input.purpose, 300, 'purpose');
    if (purpose !== null && purpose.length < 5) throw new ClinicalError('VALIDATION', 'purpose must be 5–300 characters', { reason: 'PURPOSE_REQUIRED' });
    const id = randomUUID();
    const at = this.clock();
    // 1. Lấy dữ liệu qua service nguồn (kiểm tra quyền + audit đọc của chính nó).
    let content: Uint8Array;
    let fileName: string;
    let contentType: string;
    let rows: number;
    let personal: boolean;
    let org: string | null = null;
    let cleanParams: Record<string, unknown>;
    const who = await this.run(ctx, 'export.prepare', async (repo) => {
      const u = await repo.findUserBySubject(ctx.userSubject);
      if (!u || u.status !== 'active') throw new ClinicalError('FORBIDDEN', 'Caller is not an active user');
      return u;
    });
    const stamp = `Xuất từ HealthcareOS bởi ${who.displayName ?? who.userId} lúc ${vnTime(at)} — mã xuất ${id}. Chỉ dùng cho mục đích đã ghi; không chuyển tiếp.`;
    if (dataset === 'finance_report') {
      const o = typeof params['organizationId'] === 'string' ? params['organizationId'] : '';
      const q = { organizationId: o, from: typeof params['from'] === 'string' ? params['from'] : undefined, to: typeof params['to'] === 'string' ? params['to'] : undefined };
      const data = (await this.src.finance.report(q as never, ctx)) as unknown as ReportData;
      org = o;
      cleanParams = { organizationId: o, from: data.from, to: data.to };
      const orgName = await this.run(ctx, 'export.prepare', async (repo) =>
        String((await repo.tdb.query<{ name: string }>('SELECT name FROM iam.organizations WHERE tenant_id = $1 AND organization_id = $2', [repo.tenantId, o])).rows[0]?.name ?? ''));
      const sheets: SheetSpec[] = reportSheets(data, orgName).map((sh) => ({ ...sh, title: [...(sh.title ?? []), stamp] }));
      sheets.push({
        name: 'Thông tin xuất', columns: [{ header: 'Mục', width: 24 }, { header: 'Giá trị', width: 80 }],
        rows: [['Mã xuất', id], ['Người xuất', who.displayName ?? who.userId], ['Thời điểm', vnTime(at)], ['Mục đích', purpose ?? '—'], ['Bộ lọc', `${data.from} → ${data.to}`],
          ['Lưu ý', 'File có thể chứa dữ liệu cá nhân. Lưu, chia sẻ, huỷ theo quy định bảo vệ dữ liệu cá nhân của cơ sở.']],
      });
      content = buildXlsx(sheets);
      rows = sheets.reduce((a, s) => a + s.rows.length, 0);
      personal = (data.openCases?.cases?.length ?? 0) > 0;
      fileName = `bao-cao-tai-chinh_${data.from}_${data.to}.xlsx`;
      contentType = XLSX;
    } else if (dataset === 'governance_dossier') {
      const md = await this.src.governance.dossier(ctx);
      content = new TextEncoder().encode(`${md}\n---\n_${stamp}_\n`);
      cleanParams = {};
      rows = md.split('\n').filter((l) => l.startsWith('| `')).length;
      personal = false;
      fileName = `ho-so-cap-do-an-ninh-du-lieu-${at.toISOString().slice(0, 10)}.md`;
      contentType = MD;
    } else {
      const rid = params['requestId'];
      if (typeof rid !== 'string' || !isUuid(rid)) throw new ClinicalError('VALIDATION', 'params.requestId must be a UUID');
      const md = await this.src.retention.letter(rid, ctx);
      content = new TextEncoder().encode(`${md}\n---\n_${stamp}_\n`);
      cleanParams = { requestId: rid.toLowerCase() };
      rows = 1;
      personal = true;
      fileName = `tra-loi-yeu-cau-xoa-${rid.slice(0, 8)}.md`;
      contentType = MD;
    }
    if (personal && purpose === null) {
      throw new ClinicalError('VALIDATION', 'This export contains personal data: state the purpose', { reason: 'PURPOSE_REQUIRED' });
    }
    // 2. Ghi sổ xuất (cùng lúc với trả file: ghi lỗi thì KHÔNG trả file).
    const sha256 = createHash('sha256').update(content).digest('hex');
    await this.run(ctx, 'export.create', async (repo) => {
      const u = (await repo.findUserBySubject(ctx.userSubject))!;
      await repo.tdb.query(
        `INSERT INTO governance.data_exports (export_id, tenant_id, organization_id, dataset, params, row_count, contains_personal, purpose, file_name, content_type, byte_size, sha256, exported_by, exported_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, repo.tenantId, org, dataset, JSON.stringify(cleanParams), rows, personal, purpose, fileName, contentType, content.byteLength, sha256, u.userId, at.toISOString()],
      );
      await repo.appendAudit(this.event(ctx, 'export.create', 'success', u, { exportId: id, dataset, rows, containsPersonal: personal, sha256 }, id, org as OrganizationId | null));
    });
    return { exportId: id, fileName, contentType, sha256, byteSize: content.byteLength, rowCount: rows, containsPersonal: personal, base64: Buffer.from(content).toString('base64') };
  }

  /** Nhật ký xuất (không có nội dung file). `sha256` = tra cứu một file cụ thể. */
  async list(q: { sha256?: unknown; limit?: unknown }, ctx: TenantContext = requireTenantContext()): Promise<ExportRecord[]> {
    const sha = typeof q.sha256 === 'string' && q.sha256 ? q.sha256.toLowerCase() : null;
    if (sha !== null && !/^[0-9a-f]{64}$/.test(sha)) throw new ClinicalError('VALIDATION', 'sha256 must be 64 hex characters');
    const limit = typeof q.limit === 'number' && Number.isInteger(q.limit) && q.limit > 0 && q.limit <= 500 ? q.limit : 100;
    return this.run(ctx, 'export.audit', async (repo) => {
      const p = await this.principal(repo, ctx);
      this.need(p.grants, p.user, 'export:audit');
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const r = await repo.tdb.query<any>(
        `SELECT x.*, u.display_name AS exported_by_name FROM governance.data_exports x LEFT JOIN iam.users u ON u.tenant_id = x.tenant_id AND u.user_id = x.exported_by
          WHERE x.tenant_id = $1 ${sha ? 'AND x.sha256 = $2' : ''} ORDER BY x.exported_at DESC LIMIT ${limit}`,
        sha ? [repo.tenantId, sha] : [repo.tenantId],
      );
      return r.rows.map((x: any) => ({
        exportId: x.export_id, organizationId: x.organization_id ?? null, dataset: x.dataset, params: typeof x.params === 'string' ? JSON.parse(x.params) : x.params,
        rowCount: num(x.row_count), containsPersonal: x.contains_personal === true || x.contains_personal === 't', purpose: x.purpose ?? null, fileName: x.file_name,
        byteSize: num(x.byte_size), sha256: x.sha256, exportedByName: x.exported_by_name ?? null, exportedAt: iso(x.exported_at),
      }));
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
  }
}
