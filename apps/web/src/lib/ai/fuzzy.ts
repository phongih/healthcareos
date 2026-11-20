/**
 * HCOS-F11 | Native AI cục bộ — tìm kiếm mờ tiếng Việt, chạy hoàn toàn trong trình duyệt (không gửi dữ liệu đi, dùng được khi mất mạng).
 *
 * Chịu được: gõ không dấu ("viem hong"), sai chính tả 1–2 ký tự ("viem hngo", "paracetamon"), gõ tắt theo chữ đầu
 * ("tha" = tăng huyết áp), viết tắt y khoa thông dụng (từ điển ABBREV), gõ mã ("j069" = J06.9), gõ một phần từ ("viem ph").
 * Điểm số giải thích được: mỗi kết quả trả kèm lý do khớp.
 */

/** Bỏ dấu tiếng Việt, đ → d, chữ thường, chỉ giữ chữ + số, gộp khoảng trắng. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
export const tokens = (s: string): string[] => (s ? fold(s).split(' ').filter(Boolean) : []);

/** Khoảng cách Damerau–Levenshtein (OSA), dừng sớm khi vượt `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

/** Viết tắt y khoa / thuốc thông dụng (đã bỏ dấu) → cụm đầy đủ. */
export const ABBREV: Readonly<Record<string, string>> = {
  tha: 'tang huyet ap', ha: 'huyet ap', dtd: 'dai thao duong', vhh: 'viem hong', vh: 'viem hong', vpq: 'viem phe quan',
  vp: 'viem phoi', vmdu: 'viem mui di ung', vmx: 'viem mui xoang', vdd: 'viem da day', ntt: 'nhiem trung tieu', nkt: 'nhiem khuan tiet nieu',
  nkhh: 'nhiem khuan ho hap', nkhht: 'nhiem khuan ho hap tren', hpq: 'hen phe quan', copd: 'benh phoi tac nghen man tinh', bptnmt: 'benh phoi tac nghen man tinh',
  sxh: 'sot xuat huyet', tcm: 'tay chan mieng', rlth: 'roi loan tieu hoa', rllp: 'roi loan lipid mau', rlch: 'roi loan chuyen hoa',
  gerd: 'trao nguoc da day thuc quan', tndd: 'trao nguoc da day', tmct: 'thieu mau co tim', st: 'suy tim', vkdt: 'viem khop dang thap',
  tvdd: 'thoat vi dia dem', thcs: 'thoai hoa cot song', thk: 'thoai hoa khop', utdt: 'ung thu dai trang', vgb: 'viem gan b', vgc: 'viem gan c',
  ckd: 'benh than man', btm: 'benh than man', nmct: 'nhoi mau co tim', tbmmn: 'tai bien mach mau nao', dq: 'dot quy',
  pcm: 'paracetamol', apap: 'paracetamol', amox: 'amoxicillin', augmentin: 'amoxicillin clavulanic', ibu: 'ibuprofen', ppi: 'omeprazol esomeprazol pantoprazol',
  vtm: 'vitamin', ors: 'oresol', kss: 'khang sinh',
};

export interface Indexed<T> {
  readonly item: T;
  readonly code: string;
  /** Từ của tên + bí danh (đã bỏ dấu). */
  readonly words: string[];
  /** Chữ đầu của tên chính và từng bí danh ("tang huyet ap" → "tha"). */
  readonly initials: string[];
  readonly full: string;
}
export interface Hit<T> {
  readonly item: T;
  readonly score: number;
  readonly why: string;
}

export function buildIndex<T>(items: readonly T[], get: (x: T) => { code?: string; name: string; aliases?: readonly string[] }): Indexed<T>[] {
  return items.map((item) => {
    const g = get(item);
    const names = [g.name, ...(g.aliases ?? [])].map(fold).filter(Boolean);
    return {
      item, code: fold(g.code ?? '').replace(/ /g, ''),
      words: [...new Set(names.flatMap((x) => x.split(' ')))],
      initials: names.map((x) => x.split(' ').map((w) => w[0]).join('')).filter((x) => x.length >= 2),
      full: names.join(' | '),
    };
  });
}

/** Điểm khớp của một từ truy vấn với một từ trong mục. */
function wordScore(q: string, w: string): number {
  if (q === w) return 1;
  if (q.length >= 2 && w.startsWith(q)) return 0.85 + 0.1 * (q.length / w.length);
  if (q.length >= 3) {
    const max = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
    if (max > 0) {
      const d = editDistance(q, w, max);
      if (d <= max) return 0.75 - 0.1 * d;
      // Sai chính tả ở phần đang gõ dở: so với tiền tố cùng độ dài.
      if (w.length > q.length && editDistance(q, w.slice(0, q.length), 1) <= 1) return 0.6;
    }
    if (w.includes(q)) return 0.55;
  }
  return 0;
}

export function search<T>(index: readonly Indexed<T>[], query: string, limit = 8): Hit<T>[] {
  const raw = fold(query);
  if (!raw) return [];
  const compact = raw.replace(/ /g, '');
  // Mở rộng viết tắt: cả cụm (vd. "dau lung") hoặc từng từ.
  const expanded = ABBREV[raw] ?? raw.split(' ').map((t) => ABBREV[t] ?? t).join(' ');
  const qs = expanded.split(' ').filter(Boolean);
  const hits: Hit<T>[] = [];
  for (const e of index) {
    let score = 0;
    let why = '';
    // 1) Mã: "j069" / "j06" / "j06.9".
    if (e.code && /^[a-z][0-9]/.test(compact) && compact.length >= 2) {
      if (e.code === compact) { score = 1.2; why = 'trùng mã'; }
      else if (e.code.startsWith(compact)) { score = 1.05 - 0.02 * (e.code.length - compact.length); why = 'đầu mã'; }
    }
    // 2) Chữ đầu ("tha").
    if (score < 1 && qs.length === 1 && raw.length >= 2 && !ABBREV[raw] && e.initials.includes(raw)) { score = Math.max(score, 0.95); why = 'chữ đầu'; }
    // 3) Từng từ: mọi từ truy vấn phải khớp một từ trong mục.
    if (score < 1) {
      let sum = 0;
      let all = true;
      const picked: string[] = [];
      for (const q of qs) {
        let best = 0;
        let bestW = '';
        for (const w of e.words) {
          const s = wordScore(q, w);
          if (s > best) { best = s; bestW = w; }
          if (best === 1) break;
        }
        if (best === 0) { all = false; break; }
        sum += best;
        picked.push(bestW);
      }
      if (all && qs.length) {
        let s = sum / qs.length;
        // Các từ khớp đứng liền nhau đúng thứ tự trong tên / bí danh => thưởng (kể cả khi gõ sai chính tả).
        if (qs.length > 1 && e.full.split(' | ').some((x) => ` ${x} `.includes(` ${picked.join(' ')} `))) s += 0.1;
        if (s > score) {
          score = s;
          why = expanded !== raw ? `viết tắt → ${expanded}` : s >= 0.99 ? 'trùng từ' : s >= 0.85 ? 'đầu từ' : 'gần đúng (sai chính tả / thiếu dấu)';
        }
      }
    }
    if (score >= 0.5) hits.push({ item: e.item, score: Math.round(score * 100) / 100, why });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
