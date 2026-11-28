/**
 * Màn "Hôm nay" cho dược sĩ: đơn thuốc còn thiếu số lượng cấp phát, hàng soạn thuốc đang chờ, và lối tắt sang Dược / Quầy trả.
 * Chỉ đọc qua các API sẵn có (GET prescriptions?status=active, GET handover); cấp phát và soạn thuốc làm ở màn Dược và Quầy trả.
 * Tự làm mới 30 giây một lần khi tab đang mở.
 */
import { useEffect } from 'react';

import { api } from '../lib/api';
import { fmtDateTime } from '../lib/fhir';
import { useSession } from '../lib/session';
import { Card, ErrorBox, Notice, useLoad } from '../lib/ui';
import { HANDOVER_STATUS, type Handover } from './handover';
import type { RxView } from './prescriptions';

const REFRESH_MS = 30_000;
const longDate = () => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

/** Đơn còn ít nhất một dòng thuốc chưa cấp đủ. */
const pendingLines = (v: RxView) => v.items.filter((i) => i.quantityDispensed < i.quantityPrescribed);

export function PharmacistToday() {
  const { me, orgId } = useSession();

  const rx = useLoad(
    () => api<{ prescriptions: RxView[] }>('GET', `/api/prescriptions?organization=${orgId}&status=active`).then((r) => r.data.prescriptions),
    [orgId],
  );
  const handovers = useLoad(
    () => api<{ handovers: Handover[] }>('GET', `/api/handover?organization=${orgId}`).then((r) => r.data.handovers),
    [orgId],
  );

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      rx.reload();
      handovers.reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const toDispense = (rx.data ?? []).map((v) => ({ v, lines: pendingLines(v) })).filter((x) => x.lines.length > 0);
  // Việc của dược sĩ: hàng cần thuốc đang soạn (chưa bấm "Soạn xong").
  const preparing = (handovers.data ?? []).filter((h) => h.needsMedication && h.status === 'preparing');
  const err = rx.error ?? handovers.error;

  return (
    <div className="stack">
      <Card title={`Hôm nay · ${longDate()}`}>
        <p className="muted">Chào {me.user.displayName ?? 'dược sĩ'}. Màn này chỉ đọc; cấp phát làm ở màn Dược, soạn thuốc ở màn Quầy trả.</p>
        <ErrorBox error={err} />
        <div className="row wrap">
          <div><strong>{toDispense.length}</strong> đơn còn thiếu thuốc</div>
          <div><strong>{preparing.length}</strong> hàng soạn thuốc đang chờ</div>
          <div><strong>{rx.data?.length ?? 0}</strong> đơn thuốc đang hiệu lực</div>
        </div>
        <p>
          <a href="#/pharmacy">Mở màn Dược</a> · <a href="#/handover">Mở Quầy trả</a>
        </p>
      </Card>

      <Card title={`Đơn còn thiếu thuốc (${toDispense.length})`}>
        {rx.data && toDispense.length === 0 && <Notice>Không có đơn nào còn thiếu thuốc.</Notice>}
        {toDispense.length > 0 && (
          <table>
            <thead><tr><th>Bệnh nhân</th><th>Mã BN</th><th>Kê lúc</th><th>Người kê</th><th>Thuốc còn thiếu</th></tr></thead>
            <tbody>
              {toDispense.map(({ v, lines }) => (
                <tr key={v.prescription.prescriptionId}>
                  <td>{v.patient ? `${v.patient.familyName} ${v.patient.givenName}` : '—'}</td>
                  <td className="mono">{v.patient?.mrn ?? '—'}</td>
                  <td className="nowrap">{fmtDateTime(v.prescription.prescribedAt)}</td>
                  <td>{v.prescriber.displayName ?? '—'}</td>
                  <td>
                    {lines.map((i) => (
                      <div key={i.itemId}>
                        {i.medication.brandName} {i.medication.strength}: còn {i.quantityPrescribed - i.quantityDispensed} / {i.quantityPrescribed} {i.medication.unitOfMeasure}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={`Hàng soạn thuốc (${preparing.length})`}>
        {handovers.data && preparing.length === 0 && <Notice>Không có hàng soạn thuốc nào đang chờ.</Notice>}
        {preparing.length > 0 && (
          <table>
            <thead><tr><th>Số</th><th>Bệnh nhân</th><th>Mã BN</th><th>Trạng thái</th></tr></thead>
            <tbody>
              {preparing.map((h) => (
                <tr key={h.handoverId}>
                  <td className="mono">{h.displayNo}</td>
                  <td>{h.patient.familyName} {h.patient.givenName}</td>
                  <td className="mono">{h.patient.mrn}</td>
                  <td>{HANDOVER_STATUS[h.status] ?? h.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
