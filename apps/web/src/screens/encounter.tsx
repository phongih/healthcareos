/** Bác sĩ / điều dưỡng: xem bệnh án một đợt khám, ghi chẩn đoán ICD-10, ghi chỉ số, đóng đợt khám. */
import { useMemo, useState } from 'react';

import { buildIndex } from '../lib/ai/fuzzy';
import { ICD10_COMMON, type IcdEntry } from '../lib/ai/icd10';
import { FuzzyPicker } from '../lib/ai/picker';
import { normalizeSymptoms } from '../lib/ai/symptoms';

import { api } from '../lib/api';
import {
  classLabel, conceptText, entries, fmtDateTime, ICD10, idOf, isRedacted, LOINC, STATUS_LABEL, UCUM, VITALS,
  type Bundle, type FhirCondition, type FhirEncounter, type FhirObservation,
} from '../lib/fhir';
import { can, useSession } from '../lib/session';
import { Card, ErrorBox, Field, Notice, RedactedBadge, useAction, useLoad } from '../lib/ui';
import { SupplyLotsCard } from './equipment';
import { EncounterPrescriptions } from './prescriptions';

type Resource = FhirEncounter | FhirCondition | FhirObservation;

const VERIFICATION: Record<string, string> = {
  confirmed: 'xác định',
  provisional: 'tạm thời',
  differential: 'chẩn đoán phân biệt',
  unconfirmed: 'chưa xác định',
  refuted: 'đã loại trừ',
  'entered-in-error': 'nhập nhầm',
};
const unitLabel = (u: string | undefined): string => VITALS.find((v) => v.unit === u)?.label ?? u ?? '';

export function EncounterScreen({ id }: { id: string }) {
  const { roles, me } = useSession();
  const chart = useLoad(() => api<Bundle<Resource>>('GET', `/fhir/Encounter/${id}/$everything`).then((r) => r.data), [id]);
  const all = entries(chart.data);
  const enc = all.find((r): r is FhirEncounter => r.resourceType === 'Encounter');
  const conditions = all.filter((r): r is FhirCondition => r.resourceType === 'Condition');
  const observations = all.filter((r): r is FhirObservation => r.resourceType === 'Observation');
  const open = enc?.status === 'in-progress';
  const patientId = idOf(enc?.subject);
  const bundleRedacted = isRedacted(chart.data);

  const close = useAction(async () => {
    if (!enc?.meta?.versionId) return;
    if (!confirm('Kết thúc đợt khám? Sau khi đóng không ghi thêm chẩn đoán / chỉ số được nữa.')) return;
    await api('POST', `/fhir/Encounter/${id}/$close`, { headers: { 'if-match': `W/"${enc.meta.versionId}"` } });
    chart.reload();
  });

  return (
    <div className="stack">
      {patientId && (
        <a href={`#/patients/${patientId}`} className="back">
          ← Hồ sơ bệnh nhân
        </a>
      )}
      <ErrorBox error={chart.error} />
      {chart.loading && !chart.data && <p className="muted">Đang tải…</p>}
      {enc && (
        <Card
          title={`Đợt khám — ${classLabel(enc.class?.code)}`}
          actions={
            open && roles.has('doctor') ? (
              <button className="danger" onClick={() => void close.run()} disabled={close.busy}>
                Kết thúc đợt khám
              </button>
            ) : null
          }
        >
          <dl className="kv">
            <dt>Trạng thái</dt>
            <dd>{STATUS_LABEL[enc.status ?? ''] ?? enc.status}</dd>
            <dt>Bắt đầu</dt>
            <dd>{fmtDateTime(enc.period?.start)}</dd>
            {enc.period?.end && (
              <>
                <dt>Kết thúc</dt>
                <dd>{fmtDateTime(enc.period.end)}</dd>
              </>
            )}
            <dt>Lý do khám</dt>
            <dd>{isRedacted(enc) ? <RedactedBadge show /> : (enc.reasonCode?.[0]?.text ?? '—')}</dd>
          </dl>
          <ErrorBox error={close.error} />
        </Card>
      )}

      {enc && (
        <Card title="Chẩn đoán">
          {bundleRedacted && conditions.length === 0 ? (
            <Notice>Có thể có chẩn đoán bị che theo access policy của bạn.</Notice>
          ) : conditions.length === 0 ? (
            <p className="muted">Chưa có chẩn đoán.</p>
          ) : (
            <ul className="list">
              {conditions.map((c) => (
                <li key={c.id}>
                  <strong>{conceptText(c.code)}</strong>
                  <span className="muted"> · {VERIFICATION[c.verificationStatus?.coding?.[0]?.code ?? ''] ?? c.verificationStatus?.coding?.[0]?.code}</span>
                </li>
              ))}
            </ul>
          )}
          {open && roles.has('doctor') && <AddCondition encounter={enc} onDone={chart.reload} />}
        </Card>
      )}

      {enc && (
        <Card title="Chỉ số / kết quả">
          {observations.length === 0 ? (
            <p className="muted">Chưa có chỉ số.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Thời điểm</th>
                  <th>Chỉ số</th>
                  <th>Giá trị</th>
                </tr>
              </thead>
              <tbody>
                {observations.map((o) => (
                  <tr key={o.id}>
                    <td>{fmtDateTime(o.effectiveDateTime)}</td>
                    <td>{o.code?.coding?.[0]?.display ?? conceptText(o.code)}</td>
                    <td>{o.valueQuantity ? `${o.valueQuantity.value} ${unitLabel(o.valueQuantity.unit)}` : (o.valueString ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {open && (roles.has('doctor') || roles.has('clinic_staff')) && <AddObservation encounter={enc} onDone={chart.reload} />}
        </Card>
      )}

      {enc && (roles.has('doctor') || roles.has('pharmacist')) && (
        <EncounterPrescriptions
          encounterId={id}
          open={open}
          isPractitioner={roles.has('doctor') && idOf(enc.participant?.[0]?.individual) === me.user.userId}
        />
      )}

      {enc && open && patientId && can.recordLot(roles) && <SupplyLotsCard patientId={patientId} />}
    </div>
  );
}

function AddCondition({ encounter, onDone }: { encounter: FhirEncounter; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [display, setDisplay] = useState('');
  const save = useAction(async () => {
    const body: FhirCondition & { subject: unknown; encounter: unknown } = {
      resourceType: 'Condition',
      subject: encounter.subject,
      encounter: { reference: `Encounter/${encounter.id}` },
      code: { coding: [{ system: ICD10, code: code.trim().toUpperCase(), display: display.trim() || undefined }] },
    };
    await api('POST', '/fhir/Condition', { body });
    setCode('');
    setDisplay('');
    onDone();
  });
  const pick = (x: IcdEntry) => {
    setCode(x.code);
    setDisplay(x.name);
  };
  return (
    <form
      className="sub stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
    >
      <div className="ai-note">
        Gợi ý mã từ <strong>danh mục ICD-10 rút gọn — chưa kiểm định</strong> (chưa đối chiếu QĐ 4469/QĐ-BYT); bác sĩ tự chọn và chịu trách nhiệm mã cuối cùng.
      </div>
      <div className="row wrap">
        <FuzzyPicker
          index={ICD_INDEX}
          label="Tìm mã ICD-10 (gõ không dấu, viết tắt, tên thường gọi)"
          placeholder="vd. viem hong, tha, dau bao tu, j06…"
          render={(x) => (
            <>
              <strong className="mono">{x.code}</strong> {x.name}
            </>
          )}
          onPick={pick}
        />
      </div>
      <SymptomAssist onPick={pick} />
      <div className="row wrap">
      <Field label="Mã ICD-10">
        <input required pattern="[A-Za-z][0-9][0-9A-Za-z](\.[0-9A-Za-z]{1,4})?" placeholder="J06.9" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Tên chẩn đoán">
        <input value={display} maxLength={500} onChange={(e) => setDisplay(e.target.value)} />
      </Field>
      <button type="submit" disabled={save.busy}>
        Thêm chẩn đoán
      </button>
      </div>
      <ErrorBox error={save.error} />
    </form>
  );
}

const ICD_INDEX = buildIndex(ICD10_COMMON, (x) => x);
const ICD_BY_CODE = new Map(ICD10_COMMON.map((x) => [x.code, x]));

/**
 * Native AI cục bộ: bác sĩ gõ nhanh triệu chứng (tự do, không dấu cũng được) => nhận dạng triệu chứng, thời gian, phủ định,
 * dấu hiệu cần chú ý, và gợi ý mã. Ghi chú KHÔNG được lưu và không gửi đi đâu; bấm một mã chỉ điền vào ô, bác sĩ vẫn phải bấm "Thêm".
 */
function SymptomAssist({ onPick }: { onPick: (x: IcdEntry) => void }) {
  const [text, setText] = useState('');
  const found = useMemo(() => normalizeSymptoms(text), [text]);
  const present = found.filter((f) => !f.negated);
  const absent = found.filter((f) => f.negated);
  const codes = [...new Set(present.flatMap((f) => f.codes))].map((c) => ICD_BY_CODE.get(c)).filter((x): x is IcdEntry => !!x);
  return (
    <div className="symptom-assist">
      <Field label="Ghi nhanh triệu chứng để gợi ý mã (không lưu, xử lý ngay trên máy)">
        <textarea rows={2} maxLength={1000} placeholder="vd. sot cao 39 do 3 ngay, ho khan, ko kho tho" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="ai-note">Bộ chuẩn hoá triệu chứng: <strong>gợi ý — chưa kiểm định lâm sàng</strong>. Không dùng để phân loại cấp cứu.</div>
      {found.length > 0 && (
        <div className="stack small-gap">
          <div className="chips">
            {present.map((f) => (
              <span key={f.id} className={`chip${f.redFlag ? ' chip-flag' : ''}`} title={f.evidence}>
                {f.redFlag && '⚠ '}
                {f.label}
                {f.value && ` · ${f.value}`}
                {f.duration && ` · ${f.duration}`}
              </span>
            ))}
            {absent.map((f) => (
              <span key={f.id} className="chip chip-neg" title={f.evidence}>
                không {f.label.toLowerCase()}
              </span>
            ))}
          </div>
          {present.some((f) => f.redFlag) && <Notice kind="warn">Có dấu hiệu cần chú ý — đánh giá lâm sàng ngay.</Notice>}
          {codes.length > 0 && (
            <div className="chips">
              <span className="muted small">Gợi ý mã:</span>
              {codes.map((x) => (
                <button type="button" key={x.code} className="secondary chip-btn" onClick={() => onPick(x)}>
                  {x.code} {x.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddObservation({ encounter, onDone }: { encounter: FhirEncounter; onDone: () => void }) {
  const [code, setCode] = useState<string>(VITALS[0].code);
  const [value, setValue] = useState('');
  const v = VITALS.find((x) => x.code === code) ?? VITALS[0];
  const save = useAction(async () => {
    const n = Number(value.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error('Giá trị phải là số');
    await api('POST', '/fhir/Observation', {
      body: {
        resourceType: 'Observation',
        status: 'final',
        subject: encounter.subject,
        encounter: { reference: `Encounter/${encounter.id}` },
        code: { coding: [{ system: LOINC, code: v.code, display: v.display }] },
        valueQuantity: { value: n, unit: v.unit, system: UCUM, code: v.unit },
      },
    });
    setValue('');
    onDone();
  });
  return (
    <form
      className="row wrap sub"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
    >
      <Field label="Chỉ số">
        <select value={code} onChange={(e) => setCode(e.target.value)}>
          {VITALS.map((x) => (
            <option key={x.code} value={x.code}>
              {x.display}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Giá trị (${v.label})`}>
        <input required inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <button type="submit" disabled={save.busy}>
        Ghi chỉ số
      </button>
      <ErrorBox error={save.error} />
    </form>
  );
}
