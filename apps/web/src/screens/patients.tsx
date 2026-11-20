/** Lễ tân: tìm / đăng ký bệnh nhân. Chi tiết bệnh nhân: hành chính + danh sách đợt khám + mở đợt khám (bác sĩ). */
import { useState, type FormEvent } from 'react';

import { api, ApiError } from '../lib/api';
import {
  CCCD_SYSTEM, classLabel, cccdOf, ENCOUNTER_CLASSES, entries, fmtDate, fmtDateTime, idOf, isRedacted, mrnOf, patientName, phoneOf,
  STATUS_LABEL, type Bundle, type FhirEncounter, type FhirPatient,
} from '../lib/fhir';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, navigate, Notice, RedactedBadge, useAction, useLoad } from '../lib/ui';

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
            <Field label="MRN">
              <input required value={q.mrn} onChange={(e) => setQ({ ...q, mrn: e.target.value })} autoFocus />
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
    </div>
  );
}

const genderLabel = (g: string | undefined): string =>
  ({ male: 'Nam', female: 'Nữ', other: 'Khác', unknown: 'Không rõ' } as Record<string, string>)[g ?? ''] ?? '';

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
        { type: { text: 'mrn' }, system: `urn:hcos:mrn:${orgId}`, value: f.mrn.trim() },
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
        <Field label="Mã bệnh nhân (MRN) *" hint="Duy nhất trong cơ sở">
          <input required pattern="[A-Za-z0-9][A-Za-z0-9_.\/\-]{0,63}" value={f.mrn} onChange={set('mrn')} />
        </Field>
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
  const { roles } = useSession();
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
            <dd>{phoneOf(p) || '—'}</dd>
            <dt>CCCD</dt>
            <dd>{cccdOf(p) || '—'}</dd>
            <dt>Trạng thái</dt>
            <dd>{p.active ? 'Đang hoạt động' : 'Ngừng'}</dd>
          </dl>
        </Card>
      )}
      {p && can.openEncounter(roles) && <OpenEncounter patient={p} />}
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
              </tr>
            </thead>
            <tbody>
              {entries(encs.data).map((e) => (
                <tr key={e.id} className="clickable" onClick={() => navigate(`#/encounters/${e.id}`)}>
                  <td>{fmtDateTime(e.period?.start)}</td>
                  <td>{classLabel(e.class?.code)}</td>
                  <td>{STATUS_LABEL[e.status ?? ''] ?? e.status}</td>
                  <td>{isRedacted(e) ? <RedactedBadge show /> : (e.reasonCode?.[0]?.text ?? '—')}</td>
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
