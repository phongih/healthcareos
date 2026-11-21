/** Lễ tân: tìm / đăng ký bệnh nhân. Chi tiết bệnh nhân: hành chính + danh sách đợt khám + mở đợt khám (bác sĩ). */
import { useState, type FormEvent } from 'react';

import { api, ApiError } from '../lib/api';
import {
  CCCD_SYSTEM, classLabel, cccdOf, emailOf, ENCOUNTER_CLASSES, entries, fmtDate, fmtDateTime, idOf, isRedacted, mrnOf, patientName, phoneOf,
  STATUS_LABEL, type Bundle, type FhirEncounter, type FhirPatient,
} from '../lib/fhir';
import { MrnField, MrnSettingsCard } from '../lib/mrn';
import { Reveal } from '../lib/reveal';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, navigate, Notice, RedactedBadge, useAction, useLoad } from '../lib/ui';
import { IssueTicket } from './queue';
import { ErasurePanel } from './retention';

type Mode = 'mrn' | 'cccd' | 'name';

export function PatientsScreen() {
  const { orgId, roles } = useSession();
  const [mode, setMode] = useState<Mode>('mrn');
  const [q, setQ] = useState({ mrn: '', cccd: '', family: '', given: '', birthdate: '' });
  const [results, setResults] = useState<FhirPatient[] | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const search = useAction(async () => {
    const p = new URLSearchParams({ organization: orgId, _count: '20' });
    if (mode === 'mrn') p.set('mrn', q.mrn.trim());
    if (mode === 'cccd') p.set('identifier', `${CCCD_SYSTEM}|${q.cccd.trim()}`);
    if (mode === 'name') {
      p.set('family', q.family.trim());
      p.set('given', q.given.trim());
      p.set('birthdate', q.birthdate);
    }
    const r = await api<Bundle<FhirPatient>>('GET', `/fhir/Patient?${p.toString()}`);
    setResults(entries(r.data));
  });

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    void search.run();
  };

  return (
    <div className="stack">
      {(roles.has('doctor') || roles.has('clinic_staff')) && <Worklist />}
      <Card
        title="Tìm bệnh nhân"
        actions={can.registerPatient(roles) ? <button onClick={() => setShowRegister((v) => !v)}>{showRegister ? 'Đóng' : '+ Đăng ký mới'}</button> : null}
      >
        <form onSubmit={onSearch} className="row wrap">
          <Field label="Tìm theo">
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="mrn">Mã bệnh nhân (MRN)</option>
              <option value="cccd">Số CCCD</option>
              <option value="name">Họ tên + ngày sinh</option>
            </select>
          </Field>
          {mode === 'mrn' && (
            <Field label="MRN" hint="Gõ hoặc quét mã; thiếu gạch / chữ thường vẫn được">
              <input required value={q.mrn} placeholder="vd. BN26-000123-5" onChange={(e) => setQ({ ...q, mrn: e.target.value })} autoFocus />
            </Field>
          )}
          {mode === 'cccd' && (
            <Field label="CCCD">
              <input required inputMode="numeric" value={q.cccd} onChange={(e) => setQ({ ...q, cccd: e.target.value })} />
            </Field>
          )}
          {mode === 'name' && (
            <>
              <Field label="Họ">
                <input required value={q.family} onChange={(e) => setQ({ ...q, family: e.target.value })} />
              </Field>
              <Field label="Tên đệm và tên">
                <input required value={q.given} onChange={(e) => setQ({ ...q, given: e.target.value })} />
              </Field>
              <Field label="Ngày sinh">
                <input required type="date" value={q.birthdate} onChange={(e) => setQ({ ...q, birthdate: e.target.value })} />
              </Field>
            </>
          )}
          <button type="submit" disabled={search.busy}>
            {search.busy ? 'Đang tìm…' : 'Tìm'}
          </button>
        </form>
        <ErrorBox error={search.error} />
        {results && results.length === 0 && <Notice>Không tìm thấy bệnh nhân phù hợp tại cơ sở này.</Notice>}
        {results && results.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Họ tên</th>
                <th>MRN</th>
                <th>Ngày sinh</th>
                <th>Giới</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`#/patients/${p.id}`)}>
                  <td>
                    {patientName(p)} <RedactedBadge show={isRedacted(p)} />
                  </td>
                  <td>{mrnOf(p)}</td>
                  <td>{fmtDate(p.birthDate)}</td>
                  <td>{genderLabel(p.gender)}</td>
                  <td className="right">Mở →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {showRegister && <RegisterPatient onDone={(id) => navigate(`#/patients/${id}`)} />}
      {(roles.has('clinic_admin') || roles.has('tenant_admin')) && <MrnSettingsCard />}
    </div>
  );
}

const genderLabel = (g: string | undefined): string =>
  ({ male: 'Nam', female: 'Nữ', other: 'Khác', unknown: 'Không rõ' } as Record<string, string>)[g ?? ''] ?? '';

interface WorklistItem {
  encounterId: string; patientId: string; mrn: string; familyName: string; givenName: string; encounterClass: string;
  periodStart: string; reasonText: string | null; reasonRedacted: boolean; practitionerUserId: string; practitionerName: string | null;
}

/**
 * Danh sách đang khám của cơ sở: các đợt khám chưa kết thúc (bác sĩ mặc định chỉ xem đợt của mình).
 * Server lọc theo quyền / access policy; chỉ có MRN + họ tên, không có CCCD hay liên lạc.
 */
function Worklist() {
  const { orgId, roles, me } = useSession();
  const isDoctor = roles.has('doctor');
  const [mineOnly, setMineOnly] = useState(isDoctor);
  const wl = useLoad(
    () => api<{ items: WorklistItem[]; filtered: number }>('GET', `/api/worklist?organization=${orgId}`).then((r) => r.data),
    [orgId],
  );
  const all = wl.data?.items ?? [];
  const items = mineOnly ? all.filter((i) => i.practitionerUserId === me.user.userId) : all;
  return (
    <Card
      title={`Đang khám${wl.data ? ` (${items.length})` : ''}`}
      actions={
        <div className="row">
          {isDoctor && (
            <select aria-label="Phạm vi" value={mineOnly ? 'mine' : 'all'} onChange={(e) => setMineOnly(e.target.value === 'mine')}>
              <option value="mine">Của tôi</option>
              <option value="all">Cả phòng khám</option>
            </select>
          )}
          <button className="link" onClick={wl.reload}>
            Tải lại
          </button>
        </div>
      }
    >
      <ErrorBox error={wl.error} />
      {wl.loading && !wl.data && <p className="muted">Đang tải…</p>}
      {wl.data && items.length === 0 && (
        <p className="muted">
          {mineOnly
            ? 'Bạn không có đợt khám nào đang mở. Tìm bệnh nhân bên dưới để mở đợt khám mới, hoặc chọn "Cả phòng khám".'
            : 'Không có đợt khám nào đang mở.'}
        </p>
      )}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Bắt đầu</th>
              <th>Bệnh nhân</th>
              <th>MRN</th>
              <th>Lý do khám</th>
              <th>Bác sĩ</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.encounterId} className="clickable" onClick={() => navigate(`#/encounters/${i.encounterId}`)}>
                <td>{fmtDateTime(i.periodStart)}</td>
                <td>
                  <a href={`#/encounters/${i.encounterId}`}>
                    {i.familyName} {i.givenName}
                  </a>
                </td>
                <td>{i.mrn}</td>
                <td>{i.reasonRedacted ? <RedactedBadge show /> : (i.reasonText ?? '—')}</td>
                <td>{i.practitionerUserId === me.user.userId ? <strong>Bạn</strong> : (i.practitionerName ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {wl.data && wl.data.filtered > 0 && <p className="muted">{wl.data.filtered} đợt khám bị ẩn theo access policy của bạn.</p>}
    </Card>
  );
}

function RegisterPatient({ onDone }: { onDone: (patientId: string) => void }) {
  const { orgId } = useSession();
  const [f, setF] = useState({ family: '', given: '', birthDate: '', gender: 'unknown', phone: '', cccd: '', mrn: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useAction(async () => {
    const body: FhirPatient = {
      resourceType: 'Patient',
      name: [{ family: f.family.trim(), given: f.given.trim().split(/\s+/).filter(Boolean) }],
      gender: f.gender,
      ...(f.birthDate ? { birthDate: f.birthDate } : {}),
      ...(f.phone.trim() ? { telecom: [{ system: 'phone', value: f.phone.trim() }] } : {}),
      identifier: [
        // Bỏ trống => hệ thống tự sinh mã (HCOS-F13).
        ...(f.mrn.trim() ? [{ type: { text: 'mrn' }, system: `urn:hcos:mrn:${orgId}`, value: f.mrn.trim() }] : []),
        ...(f.cccd.trim() ? [{ type: { text: 'national_id' }, system: CCCD_SYSTEM, value: f.cccd.trim() }] : []),
      ],
      managingOrganization: { reference: `Organization/${orgId}` },
    };
    const r = await api<FhirPatient>('POST', '/fhir/Patient', { body });
    onDone(r.data.id!);
  });

  const conflict = save.error instanceof ApiError && save.error.status === 409;
  return (
    <Card title="Đăng ký bệnh nhân mới">
      <form
        className="grid2"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <Field label="Họ *">
          <input required value={f.family} onChange={set('family')} />
        </Field>
        <Field label="Tên đệm và tên *">
          <input required value={f.given} onChange={set('given')} />
        </Field>
        <Field label="Ngày sinh">
          <input type="date" value={f.birthDate} onChange={set('birthDate')} />
        </Field>
        <Field label="Giới">
          <select value={f.gender} onChange={set('gender')}>
            <option value="male">Nam</option>
            <option value="female">Nữ</option>
            <option value="other">Khác</option>
            <option value="unknown">Không rõ</option>
          </select>
        </Field>
        <Field label="Số điện thoại">
          <input inputMode="tel" value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label="CCCD">
          <input inputMode="numeric" value={f.cccd} onChange={set('cccd')} />
        </Field>
        <MrnField value={f.mrn} onChange={(v) => setF({ ...f, mrn: v })} />
        <div className="actions">
          <button type="submit" disabled={save.busy}>
            {save.busy ? 'Đang lưu…' : 'Đăng ký'}
          </button>
        </div>
      </form>
      {conflict ? (
        <div className="alert warn">
          Không đăng ký được: có thể bệnh nhân đã có hồ sơ (trùng MRN, trùng CCCD, hoặc trùng họ tên + ngày sinh). Hãy tìm bệnh nhân trước khi tạo mới.
        </div>
      ) : (
        <ErrorBox error={save.error} />
      )}
    </Card>
  );
}

export function PatientDetail({ id }: { id: string }) {
  const { roles, me } = useSession();
  const patient = useLoad(() => api<FhirPatient>('GET', `/fhir/Patient/${id}`).then((r) => r.data), [id]);
  const encs = useLoad(() => api<Bundle<FhirEncounter>>('GET', `/fhir/Encounter?patient=${id}`).then((r) => r.data), [id]);
  const p = patient.data;

  return (
    <div className="stack">
      <a href="#/patients" className="back">
        ← Tìm bệnh nhân
      </a>
      <ErrorBox error={patient.error} />
      {p && (
        <Card title={patientName(p)} actions={<RedactedBadge show={isRedacted(p)} what="một số thông tin hành chính" />}>
          <dl className="kv">
            <dt>MRN</dt>
            <dd>{mrnOf(p)}</dd>
            <dt>Ngày sinh</dt>
            <dd>{fmtDate(p.birthDate) || '—'}</dd>
            <dt>Giới</dt>
            <dd>{genderLabel(p.gender) || '—'}</dd>
            <dt>Điện thoại</dt>
            <dd><Reveal masked={phoneOf(p)} target={{ kind: 'patient', id: p.id!, field: 'phone' }} allowed={can.revealPii(roles)} /></dd>
            {emailOf(p) && (
              <>
                <dt>Email</dt>
                <dd><Reveal masked={emailOf(p)} target={{ kind: 'patient', id: p.id!, field: 'email' }} allowed={can.revealPii(roles)} /></dd>
              </>
            )}
            <dt>CCCD</dt>
            <dd><Reveal masked={cccdOf(p)} target={{ kind: 'patient', id: p.id!, field: 'nationalId' }} allowed={can.revealPii(roles)} /></dd>
            <dt>Trạng thái</dt>
            <dd>{p.active ? 'Đang hoạt động' : 'Ngừng'}</dd>
          </dl>
        </Card>
      )}
      {p && can.issueTicket(roles) && <IssueTicket patientId={p.id!} patientName={patientName(p)} birthDate={p.birthDate} />}
      {p && can.openEncounter(roles) && <OpenEncounter patient={p} />}
      {p && <ErasurePanel patientId={p.id!} />}
      <Card title="Các đợt khám">
        <ErrorBox error={encs.error} />
        {encs.loading && <p className="muted">Đang tải…</p>}
        {encs.data && entries(encs.data).length === 0 && <p className="muted">Chưa có đợt khám nào bạn được xem.</p>}
        {encs.data && entries(encs.data).length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Bắt đầu</th>
                <th>Loại</th>
                <th>Trạng thái</th>
                <th>Lý do khám</th>
                <th>Bác sĩ</th>
              </tr>
            </thead>
            <tbody>
              {entries(encs.data).map((e) => (
                <tr key={e.id} className="clickable" onClick={() => navigate(`#/encounters/${e.id}`)}>
                  <td>{fmtDateTime(e.period?.start)}</td>
                  <td>{classLabel(e.class?.code)}</td>
                  <td>{STATUS_LABEL[e.status ?? ''] ?? e.status}</td>
                  <td>{isRedacted(e) ? <RedactedBadge show /> : (e.reasonCode?.[0]?.text ?? '—')}</td>
                  <td>{idOf(e.participant?.[0]?.individual) === me.user.userId ? <strong>Bạn</strong> : <span className="muted">khác</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function OpenEncounter({ patient }: { patient: FhirPatient }) {
  const [cls, setCls] = useState<string>('AMB');
  const [reason, setReason] = useState('');
  const open = useAction(async () => {
    const body: FhirEncounter = {
      resourceType: 'Encounter',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls },
      subject: { reference: `Patient/${patient.id}` },
      serviceProvider: { reference: `Organization/${idOf(patient.managingOrganization)}` },
      ...(reason.trim() ? { reasonCode: [{ text: reason.trim() }] } : {}),
    };
    const r = await api<FhirEncounter>('POST', '/fhir/Encounter', { body });
    navigate(`#/encounters/${r.data.id}`);
  });
  return (
    <Card title="Mở đợt khám">
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void open.run();
        }}
      >
        <Field label="Loại khám">
          <select value={cls} onChange={(e) => setCls(e.target.value)}>
            {ENCOUNTER_CLASSES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lý do khám">
          <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <button type="submit" disabled={open.busy}>
          {open.busy ? 'Đang mở…' : 'Mở đợt khám'}
        </button>
      </form>
      <ErrorBox error={open.error} />
    </Card>
  );
}
