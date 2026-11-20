/** HCOS-F11 | Native AI cục bộ (web): tìm kiếm mờ ICD-10 / thuốc tiếng Việt và chuẩn hoá triệu chứng. */
import { describe, expect, it } from 'vitest';

import { buildIndex, editDistance, fold, search } from '../../apps/web/src/lib/ai/fuzzy';
import { ICD10_COMMON } from '../../apps/web/src/lib/ai/icd10';
import { normalizeSymptoms } from '../../apps/web/src/lib/ai/symptoms';

const icd = buildIndex(ICD10_COMMON, (x) => x);
const top = (q: string) => search(icd, q, 3).map((h) => h.item.code);

describe('chuẩn hoá chữ', () => {
  it('bỏ dấu, đ → d, chữ thường', () => {
    expect(fold('Đái tháo đường TÝP 2')).toBe('dai thao duong typ 2');
    expect(fold('  Viêm họng—cấp ')).toBe('viem hong cap');
  });
  it('khoảng cách sửa (có hoán vị kề nhau)', () => {
    expect(editDistance('viem', 'veim')).toBe(1);
    expect(editDistance('paracetamon', 'paracetamol')).toBe(1);
    expect(editDistance('abc', 'xyz', 1)).toBe(2);
  });
});

describe('tìm ICD-10 cục bộ', () => {
  it('danh mục: mã duy nhất, định dạng ICD-10', () => {
    const codes = ICD10_COMMON.map((x) => x.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/);
  });
  it('gõ có dấu / không dấu / sai chính tả / tên thường gọi', () => {
    expect(top('viêm họng')[0]).toBe('J02.9');
    expect(top('viem hong')[0]).toBe('J02.9');
    expect(top('veim hong')[0]).toBe('J02.9');
    expect(top('cao huyet ap')[0]).toBe('I10');
    expect(top('dau bao tu')[0]).toBe('K29.7');
    expect(top('tieu duong')).toContain('E11.9');
    expect(top('tay chan mieng')[0]).toBe('B08.4');
    expect(top('soi than')[0]).toBe('N20.0');
  });
  it('mã và viết tắt', () => {
    expect(top('j069')[0]).toBe('J06.9');
    expect(top('J06.9')[0]).toBe('J06.9');
    expect(top('i1')[0]).toBe('I10');
    expect(top('tha')[0]).toBe('I10');
    expect(top('sxh')[0]).toMatch(/^A97/);
    expect(top('nkhht')[0]).toBe('J06.9');
  });
  it('không trả rác cho chuỗi vô nghĩa', () => {
    expect(search(icd, 'qqqqzz')).toEqual([]);
    expect(search(icd, '')).toEqual([]);
  });
});

describe('tìm thuốc cục bộ', () => {
  const meds = buildIndex(
    [
      { id: 1, name: 'Panadol 500mg', aliases: ['paracetamol'] },
      { id: 2, name: 'Augmentin 625mg', aliases: ['amoxicillin clavulanic'] },
      { id: 3, name: 'Omeprazol 20mg', aliases: ['omeprazol'] },
    ],
    (x) => x,
  );
  it('tên biệt dược / hoạt chất / gõ sai / viết tắt', () => {
    expect(search(meds, 'paracetamon')[0]!.item.id).toBe(1);
    expect(search(meds, 'pcm')[0]!.item.id).toBe(1);
    expect(search(meds, 'amox')[0]!.item.id).toBe(2);
    expect(search(meds, 'omep')[0]!.item.id).toBe(3);
  });
});

describe('chuẩn hoá triệu chứng', () => {
  it('nhận triệu chứng, thời gian, nhiệt độ, phủ định; ưu tiên cụm dài', () => {
    const r = normalizeSymptoms('sot cao 39,5 do 3 ngay, ho khan, ko kho tho, dau hong');
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by['fever']).toMatchObject({ negated: false, duration: '3 ngày', value: '39,5 °C', redFlag: true });
    expect(by['dry_cough']?.negated).toBe(false);
    expect(by['cough']).toBeUndefined();
    expect(by['sore_throat']?.codes).toEqual(['J02.9']);
    expect(by['dyspnea']).toMatchObject({ negated: true, redFlag: false });
    // Phủ định nằm cuối danh sách.
    expect(r.at(-1)!.id).toBe('dyspnea');
  });
  it('"họng" không bị hiểu là phủ định; "nhưng" tách mệnh đề', () => {
    const r = normalizeSymptoms('đau họng không sốt nhưng ho có đờm');
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by['sore_throat']?.negated).toBe(false);
    expect(by['fever']?.negated).toBe(true);
    expect(by['wet_cough']?.negated).toBe(false);
  });
  it('dấu hiệu cần chú ý; sai chính tả nhẹ', () => {
    const r = normalizeSymptoms('Đau ngưc trái, chóng mătj');
    expect(r.find((x) => x.id === 'chest_pain')?.redFlag).toBe(true);
    expect(r.some((x) => x.id === 'dizziness')).toBe(true);
    expect(normalizeSymptoms('')).toEqual([]);
  });
});
