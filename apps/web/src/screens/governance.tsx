/**
 * Quản trị dữ liệu (HCOS-F15): danh mục dữ liệu, cấp độ rủi ro an ninh dữ liệu của hệ thống (cấp CAO NHẤT phát sinh),
 * quy mô dữ liệu, hồ sơ tự đánh giá (bằng chứng) và tải hồ sơ Markdown.
 * Server là nơi quyết định quyền; giao diện chỉ ẩn nút.
 */
import { useMemo, useState } from 'react';

import { api } from '../lib/api';
import { downloadText } from '../lib/download';
import { fmtDateTime } from '../lib/fhir';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, useAction, useLoad } from '../lib/ui';

type Level = 1 | 2 | 3 | 4 | 5;
interface ColumnLabel { level?: Level; category?: string; storage?: string; note: string }
interface TableRow {
  name: string; level: Level; category: string; subject: string; steward: string; retention: string; purpose: string;
  columns?: Record<string, ColumnLabel>;
}
interface Assessment {
  assessmentId: string; catalogVersion: string; computedLevel: Level; declaredLevel: Level; rationale: string;
  assessedByName: string | null; assessedAt: string;
}
interface CatalogView {
  summary: {
    version: string; systemLevel: Level; tables: number; byLevel: Record<string, number>; plaintextSensitive: string[];
    plainByDesign: Array<{ column: string; reason: string }>; encrypted: string[];
  };
  tables: TableRow[];
  scale: Array<{ table: string; label: string; rows: number }>;
  latest: Assessment | null;
  needsAssessment: boolean;
  canAssess: boolean;
  encryption: {
    keys: KeyRow[];
    plaintextRemaining: Array<{ column: string; rows: number }>;
    snapshotsPlaintext: number;
  };
}
interface KeyRow { purpose: 'data' | 'index'; version: number; kekId: string; status: string; createdAt: string }
interface KeyStatus {
  activeKekId: string; configuredKekIds: string[]; keys: KeyRow[]; byDataVersion: Record<string, number>;
  plaintextRemaining: Array<{ column: string; rows: number }>; snapshotsPlaintext: number;
}

const LEVEL_TEXT: Record<Level, string> = {
  1: 'Không hoặc không đáng kể tổn hại',
  2: 'Có thể gây gián đoạn / tổn hại quyền, lợi ích hợp pháp',
  3: 'Có thể gây tổn hại nghiêm trọng đến quyền cá nhân, tổ chức',
  4: 'Tổn hại rất nghiêm trọng trật tự xã hội / nghiêm trọng an ninh quốc gia',
  5: 'Tổn hại đặc biệt nghiêm trọng an ninh quốc gia',
};
const CATEGORY: Record<string, string> = {
  reference: 'Danh mục', internal: 'Vận hành nội bộ', security: 'An ninh / kiểm toán', personal: 'Cá nhân cơ bản',
  personal_sensitive: 'Cá nhân nhạy cảm (sức khoẻ)', financial: 'Tài chính',
};
const SUBJECT: Record<string, string> = { patient: 'Người bệnh', staff: 'Nhân viên', organization: 'Cơ sở', none: '—' };
const STEWARD: Record<string, string> = { clinic_admin: 'Quản lý phòng khám', pharmacy_admin: 'Quản lý kho dược', tenant_admin: 'Quản trị hệ thống' };
const RETENTION: Record<string, string> = {
  medical_record: 'Hồ sơ bệnh án', financial_record: 'Chứng từ tài chính', contact: 'Liên hệ — xoá khi hết mục đích', operational: 'Vận hành ngắn hạn',
  audit_log: 'Nhật ký kiểm toán', security: 'Bí mật / khoá', reference: 'Danh mục',
};
const STORAGE: Record<string, string> = { plain: 'lưu rõ', hashed: 'chỉ lưu băm', encrypted: 'mã hoá', derived: 'khoá dẫn xuất', retired: 'đã bỏ (chỉ còn bản mã)' };
const LevelBadge = ({ l }: { l: Level }) => <span className={`badge lvl-${l}`}>Cấp {l}</span>;

export function GovernanceScreen() {
  const cat = useLoad(() => api<CatalogView>('GET', '/api/governance/catalog').then((r) => r.data), []);
  const history = useLoad(() => api<{ assessments: Assessment[] }>('GET', '/api/governance/assessments').then((r) => r.data.assessments), []);
  const [level, setLevel] = useState<'all' | Level>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const dl = useAction(async () => {
    const r = await api<{ markdown: string }>('GET', '/api/governance/dossier');
    downloadText(`ho-so-cap-do-an-ninh-du-lieu-${new Date().toISOString().slice(0, 10)}.md`, r.data.markdown);
  });

  const v = cat.data;
  const rows = useMemo(
    () =>
      (v?.tables ?? [])
        .filter((t) => (level === 'all' || t.level === level) && (!q.trim() || `${t.name} ${t.purpose}`.toLowerCase().includes(q.trim().toLowerCase())))
        .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)),
    [v, level, q],
  );

  if (cat.error) return <ErrorBox error={cat.error} />;
  if (!v) return <p className="muted">Đang tải…</p>;
  const s = v.summary;

  return (
    <div className="stack">
      <Card title="Cấp độ rủi ro an ninh dữ liệu của hệ thống" actions={<button className="link" disabled={dl.busy} onClick={() => void dl.run()}>Tải hồ sơ tự đánh giá (.md)</button>}>
        <div className="row wrap top">
          <div className="gov-level">
            <div className="gl-no">Cấp {s.systemLevel}</div>
            <div className="muted small">tính từ danh mục</div>
          </div>
          <div className="stack small-gap">
            <div><strong>{LEVEL_TEXT[s.systemLevel]}</strong></div>
            <div className="muted">
              Hệ thống xử lý nhiều cấp độ phải đáp ứng yêu cầu bảo vệ theo <strong>cấp cao nhất phát sinh</strong> (Luật An ninh dữ liệu, hiệu lực 01/7/2027).
              Cấp độ rủi ro không thay thế phân loại dữ liệu cốt lõi / quan trọng theo pháp luật về dữ liệu.
            </div>
            <div className="muted small">Phiên bản danh mục <code>{s.version.slice(0, 12)}</code> · {s.tables} bảng · cấp 1: {s.byLevel['1']} · cấp 2: {s.byLevel['2']} · cấp 3: {s.byLevel['3']} · cấp 4: {s.byLevel['4']} · cấp 5: {s.byLevel['5']}</div>
          </div>
        </div>
        {v.latest ? (
          <Notice kind={v.needsAssessment ? 'warn' : 'ok'}>
            Chủ quản đã xác định <strong>cấp {v.latest.declaredLevel}</strong> lúc {fmtDateTime(v.latest.assessedAt)} ({v.latest.assessedByName ?? '—'}).
            {v.needsAssessment ? ' Danh mục đã thay đổi sau lần này — cần đánh giá lại.' : ' Khớp phiên bản danh mục hiện tại.'}
          </Notice>
        ) : (
          <Notice kind="warn">Chưa có lần xác định cấp độ nào được ghi nhận{v.canAssess ? ' — ghi ở thẻ "Hồ sơ tự đánh giá" bên dưới.' : ' — nhờ quản trị hệ thống ghi nhận.'}</Notice>
        )}
        <ErrorBox error={dl.error} />
      </Card>

      <div className="grid2 top">
        <Card title="Quy mô dữ liệu">
          <table>
            <tbody>
              {v.scale.map((r) => (
                <tr key={r.table}><td>{r.label}</td><td className="right">{r.rows.toLocaleString('vi-VN')}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Chỉ đếm dữ liệu của chủ quản này. Quy mô tích tụ là một căn cứ khi xét lên cấp cao hơn.</p>
        </Card>
        <Card title={`Cột nhạy cảm còn lưu dạng rõ (${s.plaintextSensitive.length})`}>
          <p className="muted small">Cột cá nhân / sức khoẻ cấp ≥ 3 chưa mã hoá theo trường — kế hoạch F16b (họ tên, ngày sinh, dữ liệu lâm sàng). Hiện được bảo vệ bằng RLS + phân quyền.</p>
          <div className="gov-cols">
            {s.plaintextSensitive.map((c) => <code key={c}>{c}</code>)}
          </div>
          {s.plainByDesign.length > 0 && (
            <>
              <p className="muted small">Lưu rõ có chủ đích:</p>
              <ul className="small">
                {s.plainByDesign.map((x) => <li key={x.column}><code>{x.column}</code> — {x.reason}</li>)}
              </ul>
            </>
          )}
        </Card>
      </div>

      <EncryptionCard v={v} onChange={cat.reload} />

      <Card title={`Danh mục dữ liệu (${rows.length}/${v.tables.length} bảng)`}>
        <div className="row wrap">
          <Field label="Cấp độ">
            <select value={String(level)} onChange={(e) => setLevel(e.target.value === 'all' ? 'all' : (Number(e.target.value) as Level))}>
              <option value="all">Tất cả</option>
              {[3, 2, 1].map((l) => <option key={l} value={l}>Cấp {l}</option>)}
            </select>
          </Field>
          <Field label="Tìm bảng / mục đích">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="vd. persons, đơn thuốc" />
          </Field>
        </div>
        <table className="gov-table">
          <thead><tr><th>Bảng</th><th>Cấp</th><th>Nhóm</th><th>Chủ thể</th><th>Người chịu trách nhiệm</th><th>Lưu trữ</th><th>Mục đích</th></tr></thead>
          <tbody>
            {rows.flatMap((t) => {
              const cols = Object.entries(t.columns ?? {});
              const main = (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                    {cols.length > 0 && (
                      <div><button className="link small" onClick={() => setOpen(open === t.name ? null : t.name)}>{open === t.name ? 'Ẩn' : `${cols.length} cột gắn nhãn riêng`}</button></div>
                    )}
                  </td>
                  <td><LevelBadge l={t.level} /></td>
                  <td>{CATEGORY[t.category] ?? t.category}</td>
                  <td>{SUBJECT[t.subject] ?? t.subject}</td>
                  <td>{STEWARD[t.steward] ?? t.steward}</td>
                  <td>{RETENTION[t.retention] ?? t.retention}</td>
                  <td>{t.purpose}</td>
                </tr>
              );
              if (open !== t.name) return [main];
              return [
                main,
                <tr key={`${t.name}-cols`} className="gov-cols-row">
                  <td colSpan={7}>
                    <table>
                      <thead><tr><th>Cột</th><th>Cấp</th><th>Nhóm</th><th>Lưu</th><th>Ghi chú</th></tr></thead>
                      <tbody>
                        {cols.map(([c, l]) => (
                          <tr key={c}>
                            <td><code>{c}</code></td>
                            <td><LevelBadge l={l.level ?? t.level} /></td>
                            <td>{CATEGORY[l.category ?? t.category]}</td>
                            <td>{STORAGE[l.storage ?? 'plain']}</td>
                            <td>{l.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
        <p className="muted small">Danh mục nằm trong mã nguồn; CI chặn mọi bảng / cột cá nhân mới chưa được gắn nhãn.</p>
      </Card>

      <Card title="Hồ sơ tự đánh giá">
        {v.canAssess && <AssessForm computed={s.systemLevel} onDone={() => { cat.reload(); history.reload(); }} />}
        <ErrorBox error={history.error} />
        {history.data && history.data.length === 0 && <p className="muted">Chưa có hồ sơ nào.</p>}
        {history.data && history.data.length > 0 && (
          <table>
            <thead><tr><th>Lúc</th><th>Người xác định</th><th>Tính được</th><th>Xác định</th><th>Phiên bản danh mục</th><th>Căn cứ</th></tr></thead>
            <tbody>
              {history.data.map((a) => (
                <tr key={a.assessmentId}>
                  <td>{fmtDateTime(a.assessedAt)}</td>
                  <td>{a.assessedByName ?? '—'}</td>
                  <td><LevelBadge l={a.computedLevel} /></td>
                  <td><LevelBadge l={a.declaredLevel} /></td>
                  <td><code>{a.catalogVersion.slice(0, 12)}</code>{a.catalogVersion !== s.version && <div className="muted small">cũ</div>}</td>
                  <td>{a.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function AssessForm({ computed, onDone }: { computed: Level; onDone: () => void }) {
  const [declared, setDeclared] = useState<Level>(computed);
  const [rationale, setRationale] = useState('');
  const save = useAction(async () => {
    await api('POST', '/api/governance/assessments', { body: { declaredLevel: declared, rationale } });
    setRationale('');
    onDone();
  });
  return (
    <form className="stack small-gap" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <div className="row wrap">
        <Field label="Cấp độ chủ quản xác định" hint={`Không thấp hơn cấp ${computed} tính từ danh mục`}>
          <select value={declared} onChange={(e) => setDeclared(Number(e.target.value) as Level)}>
            {([1, 2, 3, 4, 5] as Level[]).filter((l) => l >= computed).map((l) => <option key={l} value={l}>Cấp {l}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Căn cứ (20–4000 ký tự)" hint="vd. loại dữ liệu xử lý, quy mô, phạm vi cơ sở, có / không dữ liệu cốt lõi, quan trọng">
        <textarea rows={3} value={rationale} maxLength={4000} onChange={(e) => setRationale(e.target.value)} />
      </Field>
      <div className="row wrap">
        <button type="submit" disabled={save.busy || rationale.trim().length < 20}>Ghi nhận cấp độ</button>
      </div>
      <ErrorBox error={save.error} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// HCOS-F16: mã hoá theo trường — bằng chứng (mọi người xem tab) + thao tác khoá (chỉ quản trị hệ thống).
// ---------------------------------------------------------------------------
const PURPOSE: Record<string, string> = { data: 'Dữ liệu (DEK)', index: 'Blind index' };

function EncryptionCard({ v, onChange }: { v: CatalogView; onChange: () => void }) {
  const { roles } = useSession();
  const manage = can.keysManage(roles);
  const ks = useLoad(() => (manage ? api<KeyStatus>('GET', '/api/keys').then((r) => r.data) : Promise.resolve(null)), [manage]);
  const [msg, setMsg] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    ks.reload();
    onChange();
  };
  const loop = async (path: string, field: 'reencrypted' | 'encrypted'): Promise<number> => {
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const r = await api<Record<string, number>>('POST', path, { body: { limit: 500 } });
      const n = r.data[field] ?? 0;
      total += n;
      if (n === 0) break;
    }
    return total;
  };
  const act = useAction(async (what: 'rotate-data' | 'rotate-index' | 'reencrypt' | 'rewrap' | 'backfill') => {
    setMsg(null);
    if (what === 'rotate-data' || what === 'rotate-index') {
      const purpose = what === 'rotate-data' ? 'data' : 'index';
      const warn = purpose === 'data'
        ? 'Tạo DEK phiên bản mới: dữ liệu ghi mới dùng khoá mới; dữ liệu cũ vẫn đọc được cho tới khi "Mã hoá lại". Tiếp tục?'
        : 'Xoay khoá blind index: khoá các bảng liên quan và tính lại mọi index trong một giao dịch (vài giây với dữ liệu nhỏ). Tiếp tục?';
      if (!confirm(warn)) return;
      const r = await api<{ version: number; recomputed?: number }>('POST', '/api/keys/rotate', { body: { purpose } });
      done(`${PURPOSE[purpose]}: phiên bản ${r.data.version}${r.data.recomputed !== undefined ? ` — tính lại ${r.data.recomputed} index` : ''}.`);
    } else if (what === 'reencrypt') {
      done(`Đã mã hoá lại ${await loop('/api/keys/reencrypt', 'reencrypted')} giá trị bằng DEK đang dùng.`);
    } else if (what === 'backfill') {
      done(`Đã mã hoá ${await loop('/api/keys/backfill', 'encrypted')} giá trị còn bản rõ.`);
    } else {
      const r = await api<{ rewrapped: number; kekId: string }>('POST', '/api/keys/rewrap', {});
      done(`Đã bọc lại ${r.data.rewrapped} khoá bằng KEK ${r.data.kekId}.`);
    }
  });
  const e = v.encryption;
  const left = e.plaintextRemaining.reduce((a, c) => a + c.rows, 0) + e.snapshotsPlaintext;
  const k = ks.data;
  const oldVersions = k ? Object.keys(k.byDataVersion).filter((x) => !k.keys.some((y) => y.purpose === 'data' && y.status === 'active' && String(y.version) === x)) : [];
  const staleKek = k ? k.keys.some((y) => y.kekId !== k.activeKekId) : false;

  return (
    <Card title={`Mã hoá theo trường (${v.summary.encrypted.length} cột)`}>
      <p className="muted small">
        Envelope encryption AES-256-GCM: mỗi chủ quản có DEK riêng, được bọc bằng KEK nằm <strong>ngoài CSDL</strong> (biến môi trường của máy chủ ứng dụng).
        Người chỉ đọc được CSDL / bản sao lưu thấy bản mã và DEK đã bọc — không có khoá để mở. Tìm kiếm / chống trùng dùng blind index (HMAC, khoá riêng).
        Xem bản rõ cần quyền <code>pii:reveal</code> + lý do, mỗi lần đều ghi nhật ký.
      </p>
      {left === 0 ? (
        <Notice kind="ok">Không còn giá trị nào lưu bản rõ trong các cột đã mã hoá.</Notice>
      ) : (
        <Notice kind="warn">
          Còn {left} giá trị bản rõ chưa mã hoá ({[...e.plaintextRemaining.filter((c) => c.rows > 0).map((c) => `${c.column}: ${c.rows}`), ...(e.snapshotsPlaintext ? [`ảnh chụp gộp hồ sơ: ${e.snapshotsPlaintext}`] : [])].join(' · ')}).
          {manage ? ' Bấm "Mã hoá dữ liệu cũ".' : ' Nhờ quản trị hệ thống chạy mã hoá dữ liệu cũ.'}
        </Notice>
      )}
      <div className="row wrap top">
        <table>
          <thead><tr><th>Khoá</th><th>Phiên bản</th><th>KEK</th><th>Trạng thái</th><th>Tạo lúc</th></tr></thead>
          <tbody>
            {e.keys.length === 0 && <tr><td colSpan={5} className="muted">Chưa có khoá (tạo tự động ở lần ghi đầu tiên).</td></tr>}
            {e.keys.map((x) => (
              <tr key={`${x.purpose}-${x.version}`} className={x.status === 'active' ? '' : 'muted-row'}>
                <td>{PURPOSE[x.purpose] ?? x.purpose}</td><td>{x.version}</td><td><code>{x.kekId}</code></td>
                <td>{x.status === 'active' ? 'đang dùng' : 'đã thay'}</td><td>{fmtDateTime(x.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="gov-cols">
          {v.summary.encrypted.map((c) => <code key={c}>{c}</code>)}
        </div>
      </div>
      {manage && (
        <div className="stack small-gap">
          {k && (
            <div className="muted small">
              KEK đang dùng <code>{k.activeKekId}</code> (cấu hình: {k.configuredKekIds.join(', ')}) · giá trị theo phiên bản DEK:{' '}
              {Object.entries(k.byDataVersion).map(([ver, n]) => `v${ver}: ${n}`).join(' · ') || '—'}
            </div>
          )}
          {oldVersions.length > 0 && <Notice kind="warn">Còn giá trị dùng DEK cũ ({oldVersions.map((x) => `v${x}`).join(', ')}) — bấm "Mã hoá lại".</Notice>}
          {staleKek && <Notice kind="warn">Có DEK còn bọc bằng KEK cũ — bấm "Bọc lại bằng KEK mới" trước khi gỡ KEK cũ khỏi cấu hình.</Notice>}
          <div className="row wrap">
            <button disabled={act.busy || left === 0} onClick={() => void act.run('backfill')}>Mã hoá dữ liệu cũ</button>
            <button className="secondary" disabled={act.busy} onClick={() => void act.run('rotate-data')}>Xoay DEK</button>
            <button className="secondary" disabled={act.busy || oldVersions.length === 0} onClick={() => void act.run('reencrypt')}>Mã hoá lại</button>
            <button className="secondary" disabled={act.busy || !staleKek} onClick={() => void act.run('rewrap')}>Bọc lại bằng KEK mới</button>
            <button className="secondary" disabled={act.busy} onClick={() => void act.run('rotate-index')}>Xoay khoá blind index</button>
          </div>
          {msg && <Notice kind="ok">{msg}</Notice>}
          <ErrorBox error={act.error ?? ks.error} />
          <p className="muted small">Đổi KEK: thêm KEK mới vào đầu <code>HCOS_KEKS</code> (giữ KEK cũ phía sau), khởi động lại API, bấm "Bọc lại", rồi mới gỡ KEK cũ.</p>
        </div>
      )}
    </Card>
  );
}
