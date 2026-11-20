/**
 * HCOS-F11 | Native AI cục bộ — chuẩn hoá triệu chứng từ ghi chú tự do (tiếng Việt, có / không dấu, sai chính tả nhẹ, viết tắt).
 *
 *   "sot cao 39 do 3 ngay, ho khan, ko kho tho, dau hong"
 *     → Sốt (39 °C, 3 ngày) · Ho khan · Đau họng · KHÔNG: Khó thở   + gợi ý mã R50.9 / R05 / J02.9
 *
 * Chạy trong trình duyệt, không gửi gì đi. Chỉ là GỢI Ý cho bác sĩ chọn — không tự ghi chẩn đoán, không lưu ghi chú.
 * Dấu hiệu cần chú ý (khó thở, đau ngực, ngất, co giật, sốt ≥ 39,5 °C) được đánh dấu riêng.
 */
import { editDistance, fold } from './fuzzy';

export interface SymptomConcept {
  readonly id: string;
  readonly label: string;
  readonly synonyms: readonly string[];
  readonly codes: readonly string[];
  readonly redFlag?: boolean;
}
export interface FoundSymptom {
  readonly id: string;
  readonly label: string;
  readonly negated: boolean;
  readonly duration: string | null;
  readonly value: string | null;
  readonly evidence: string;
  readonly codes: readonly string[];
  readonly redFlag: boolean;
}

const c = (id: string, label: string, codes: string[], synonyms: string[], redFlag = false): SymptomConcept => ({ id, label, codes, synonyms, redFlag });

export const SYMPTOMS: readonly SymptomConcept[] = [
  c('fever', 'Sốt', ['R50.9'], ['sốt', 'nóng sốt', 'sốt cao', 'sốt nhẹ', 'phát sốt', 'người nóng']),
  c('chills', 'Ớn lạnh / rét run', [], ['ớn lạnh', 'rét run', 'lạnh run']),
  c('dry_cough', 'Ho khan', ['R05'], ['ho khan']),
  c('wet_cough', 'Ho có đờm', ['R05'], ['ho đờm', 'ho có đờm', 'ho đàm', 'ho có đàm', 'khạc đờm']),
  c('cough', 'Ho', ['R05'], ['ho', 'ho nhiều', 'ho kéo dài']),
  c('sore_throat', 'Đau họng', ['J02.9'], ['đau họng', 'rát họng', 'viêm họng', 'nuốt đau']),
  c('runny_nose', 'Sổ mũi / nghẹt mũi', ['J00'], ['sổ mũi', 'chảy mũi', 'chảy nước mũi', 'nghẹt mũi', 'ngạt mũi', 'hắt hơi']),
  c('dyspnea', 'Khó thở', ['R06.0'], ['khó thở', 'thở mệt', 'hụt hơi', 'thở dốc', 'thở gấp', 'tức thở'], true),
  c('chest_pain', 'Đau ngực', ['R07.4'], ['đau ngực', 'tức ngực', 'nặng ngực'], true),
  c('palpitation', 'Hồi hộp', ['R00.2'], ['hồi hộp', 'đánh trống ngực', 'tim đập nhanh']),
  c('headache', 'Đau đầu', ['R51'], ['đau đầu', 'nhức đầu', 'nặng đầu']),
  c('dizziness', 'Chóng mặt', ['R42'], ['chóng mặt', 'choáng', 'hoa mắt', 'xây xẩm']),
  c('syncope', 'Ngất', ['R55'], ['ngất', 'xỉu', 'ngất xỉu', 'lịm đi'], true),
  c('seizure', 'Co giật', ['R56.8'], ['co giật', 'lên cơn giật'], true),
  c('epigastric_pain', 'Đau thượng vị', ['R10.1', 'K29.7'], ['đau thượng vị', 'đau dạ dày', 'đau bao tử', 'đau trên rốn']),
  c('abdominal_pain', 'Đau bụng', ['R10.4'], ['đau bụng', 'quặn bụng']),
  c('nausea', 'Buồn nôn / nôn', ['R11'], ['buồn nôn', 'nôn', 'ói', 'nôn ói', 'mắc ói']),
  c('diarrhea', 'Tiêu chảy', ['A09'], ['tiêu chảy', 'đi ngoài', 'đi lỏng', 'phân lỏng', 'đi cầu nhiều']),
  c('constipation', 'Táo bón', ['K59.0'], ['táo bón', 'bón']),
  c('heartburn', 'Ợ chua / ợ nóng', ['K21.9'], ['ợ chua', 'ợ nóng', 'ợ hơi', 'nóng rát thượng vị']),
  c('dysuria', 'Tiểu buốt / rát', ['R30.0', 'N39.0'], ['tiểu buốt', 'tiểu rát', 'tiểu đau', 'đái buốt', 'tiểu gắt']),
  c('hematuria', 'Tiểu máu', ['R31'], ['tiểu máu', 'đái máu', 'nước tiểu đỏ']),
  c('rash', 'Phát ban', ['R21'], ['phát ban', 'nổi ban', 'nổi mẩn', 'mẩn đỏ', 'ban đỏ']),
  c('hives', 'Mề đay', ['L50.9'], ['mề đay', 'mày đay', 'nổi mề đay']),
  c('itch', 'Ngứa', ['L29.9'], ['ngứa', 'ngứa ngáy']),
  c('fatigue', 'Mệt mỏi', ['R53'], ['mệt mỏi', 'mệt', 'uể oải', 'đuối sức']),
  c('myalgia', 'Đau mỏi người', ['M79.1'], ['đau mỏi người', 'đau nhức người', 'đau cơ', 'nhức mỏi']),
  c('back_pain', 'Đau lưng', ['M54.5'], ['đau lưng', 'đau thắt lưng', 'mỏi lưng']),
  c('neck_pain', 'Đau cổ / vai gáy', ['M54.2'], ['đau cổ', 'đau vai gáy', 'mỏi cổ', 'cứng cổ']),
  c('joint_pain', 'Đau khớp', ['M25.5'], ['đau khớp', 'nhức khớp', 'đau gối', 'sưng khớp']),
  c('edema', 'Phù', ['R60.0'], ['phù', 'sưng phù', 'phù chân', 'sưng chân']),
  c('red_eye', 'Đỏ mắt', ['H10.9'], ['đỏ mắt', 'đau mắt đỏ', 'mắt đỏ', 'ghèn mắt', 'chảy ghèn']),
  c('ear_pain', 'Đau tai', ['H66.9'], ['đau tai', 'chảy mủ tai', 'ù tai']),
  c('toothache', 'Đau răng', ['K02.9'], ['đau răng', 'nhức răng']),
  c('mouth_ulcer', 'Loét miệng', ['K12.0'], ['nhiệt miệng', 'loét miệng', 'lở miệng']),
  c('nosebleed', 'Chảy máu cam', ['R04.0'], ['chảy máu cam', 'chảy máu mũi']),
  c('anorexia', 'Chán ăn', ['R63.0'], ['chán ăn', 'biếng ăn', 'ăn kém']),
  c('weight_loss', 'Sụt cân', ['R63.4'], ['sụt cân', 'gầy sút', 'giảm cân']),
  c('insomnia', 'Mất ngủ', ['G47.0'], ['mất ngủ', 'khó ngủ', 'ngủ kém']),
];

// (Không có "hong": trùng với "họng" sau khi bỏ dấu.)
const NEGATORS = new Set(['khong', 'ko', 'k', 'kh', 'chua', 'het', 'hok', 'khg']);
const UNIT: Record<string, string> = { ngay: 'ngày', hom: 'ngày', tuan: 'tuần', thang: 'tháng', gio: 'giờ', h: 'giờ', nam: 'năm' };

interface Pattern { readonly concept: SymptomConcept; readonly words: string[] }
const PATTERNS: Pattern[] = SYMPTOMS.flatMap((s) => s.synonyms.map((x) => ({ concept: s, words: fold(x).split(' ') })))
  // Cụm dài trước ("ho khan" thắng "ho").
  .sort((a, b) => b.words.length - a.words.length || b.words.join('').length - a.words.join('').length);

const sameWord = (t: string, w: string): boolean => t === w || (w.length >= 5 && t.length >= 4 && editDistance(t, w, 1) <= 1);

/** Tách ghi chú thành các mệnh đề (dấu phẩy, chấm phẩy, xuống dòng, "và" / "kèm" / "nhưng" / "còn") rồi nhận dạng trong từng mệnh đề;
 *  từ phủ định ("không", "ko", "chưa", "hết"…) phủ định các triệu chứng sau nó trong cùng mệnh đề. */
export function normalizeSymptoms(text: string): FoundSymptom[] {
  const out = new Map<string, FoundSymptom>();
  const clauses = text.replace(/(\d)[,.](\d)/g, '$1#$2').split(/[,.;\n+/]|(?:^|\s)(?:và|va|kèm|kem|nhưng|nhung|còn|con)(?=\s|$)/i).map((x) => x.replace(/#/g, '.')).map((x) => x.trim()).filter(Boolean);
  for (const clause of clauses) {
    const toks = fold(clause.replace(/(\d)\.(\d)/g, '$1dot$2')).split(' ').filter(Boolean).map((t) => t.replace(/(\d)dot(\d)/g, '$1.$2'));
    let negateRest = false;
    const used = new Set<number>();
    for (let i = 0; i < toks.length; i++) {
      if (NEGATORS.has(toks[i]!)) negateRest = true;
      if (used.has(i)) continue;
      for (const p of PATTERNS) {
        if (i + p.words.length > toks.length) continue;
        if (!p.words.every((w, k) => (w.length <= 3 ? toks[i + k] === w : sameWord(toks[i + k]!, w)))) continue;
        const after = toks.slice(i + p.words.length, i + p.words.length + 6);
        const k = after.findIndex((t, j) => /^\d{1,3}$/.test(t) && UNIT[after[j + 1] ?? ''] !== undefined);
        const dur = k >= 0 ? `${after[k]} ${UNIT[after[k + 1]!]}` : / tu hom qua( |$)/.test(` ${after.join(' ')}`) ? '1 ngày' : null;
        const val = p.concept.id === 'fever' ? (after.find((t) => /^(3[5-9]|4[0-2])(\.\d)?$/.test(t)) ?? null) : null;
        const negated = negateRest;
        const key = p.concept.id;
        const prev = out.get(key);
        const redFlag = !!p.concept.redFlag || (p.concept.id === 'fever' && val !== null && Number(val) >= 39.5);
        if (!prev || (prev.negated && !negated)) {
          out.set(key, {
            id: key, label: p.concept.label, negated, duration: dur ?? prev?.duration ?? null, value: val ? `${val.replace('.', ',')} °C` : prev?.value ?? null,
            evidence: clause.slice(0, 80), codes: p.concept.codes, redFlag: redFlag && !negated,
          });
        }
        for (let k = 0; k < p.words.length; k++) used.add(i + k);
        break;
      }
    }
  }
  // "Ho" chung bị bỏ nếu đã có ho khan / ho đờm.
  if (out.has('cough') && (out.has('dry_cough') || out.has('wet_cough'))) out.delete('cough');
  return [...out.values()].sort((a, b) => Number(a.negated) - Number(b.negated) || Number(b.redFlag) - Number(a.redFlag));
}
