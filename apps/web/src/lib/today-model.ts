/** Giao diện đợt 3 | Hàm thuần cho màn "Hôm nay" (dùng được trong test). */

export interface QueuePoint { servicePointId: string; code: string; name: string; isActive: boolean }
export interface QueueTicket { ticketId: string; servicePointId: string; displayNo: string; status: string; calledAt: string | null }

export function todayVN(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** "Nguyễn Thị Lan (Lễ tân)" => "Lan". */
export function firstName(displayName: string | null | undefined): string {
  const parts = (displayName ?? '').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Ô tìm một dòng: 12 chữ số = CCCD, còn lại = mã bệnh nhân (máy chủ tự chuẩn hoá gạch / chữ thường). */
export function searchParamsFor(q: string): { mode: 'cccd' | 'mrn'; value: string } {
  const v = q.trim();
  return /^\d{12}$/.test(v) ? { mode: 'cccd', value: v } : { mode: 'mrn', value: v };
}

/** Tóm tắt hàng đợi theo phòng: số đang gọi / đang khám gần nhất + số người chờ. */
export function summarizeQueue<P extends QueuePoint, T extends QueueTicket>(points: P[], tickets: T[]): Array<{ point: P; waiting: number; current: T | null }> {
  return points
    .filter((p) => p.isActive)
    .map((p) => {
      const mine = tickets.filter((t) => t.servicePointId === p.servicePointId);
      const current = mine
        .filter((t) => t.status === 'called' || t.status === 'in_service')
        .sort((a, b) => (b.calledAt ?? '').localeCompare(a.calledAt ?? ''))[0];
      return { point: p, waiting: mine.filter((t) => t.status === 'waiting').length, current: current ?? null };
    });
}

