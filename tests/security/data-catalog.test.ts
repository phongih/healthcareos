/**
 * HCOS-F15 | Danh mục dữ liệu: quy tắc kiểm tra, cấp độ hệ thống = cấp cao nhất, phiên bản danh mục.
 * (Đối chiếu với CSDL thật nằm ở tests/integration/data-catalog-pg.integration.test.ts.)
 */
import { describe, expect, it } from 'vitest';

import { catalogVersion, checkCatalog, DATA_CATALOG, labelOf, summarize, systemLevel, type TableLabel } from '../../packages/security/src/data-catalog';

const base: TableLabel = { level: 2, category: 'internal', subject: 'none', steward: 'clinic_admin', retention: 'operational', purpose: 'x' };

describe('Danh mục dữ liệu', () => {
  it('cấp độ hệ thống = cấp CAO NHẤT phát sinh (kể cả cấp ghi ở cột)', () => {
    expect(systemLevel({ a: base, b: { ...base, level: 1 } })).toBe(2);
    expect(systemLevel({ a: { ...base, level: 4, columns: { c: { level: 4, note: '' } } } })).toBe(4);
    expect(systemLevel()).toBe(3);
  });

  it('kiểm tra: bảng chưa gắn nhãn, nhãn thừa, cột không tồn tại, cột cá nhân chưa gắn nhãn riêng, cột cao hơn bảng', () => {
    const cat: Record<string, TableLabel> = {
      'x.people': { ...base, level: 3, subject: 'patient', columns: { phone: { level: 3, note: '' }, gone: { note: '' } } },
      'x.ops': { ...base, columns: { secret: { level: 3, note: '' } } },
      'x.old': base,
    };
    const schema = new Map<string, string[]>([
      ['x.people', ['id', 'phone', 'email', 'given_name', 'created_at']],
      ['x.ops', ['id', 'secret', 'note']],
      ['x.new', ['id']],
    ]);
    const kinds = checkCatalog(schema, cat).map((p) => `${p.kind}:${p.table}${p.column ? '.' + p.column : ''}`).sort();
    expect(kinds).toEqual([
      'COLUMN_ABOVE_TABLE:x.ops.secret',
      'STALE_COLUMN:x.people.gone',
      'STALE_TABLE:x.old',
      'UNLABELED_PERSONAL_COLUMN:x.people.email',
      'UNLABELED_PERSONAL_COLUMN:x.people.given_name',
      'UNLABELED_TABLE:x.new',
    ]);
    // Bảng không có dữ liệu của người (subject 'none'): cột 'note' không bắt buộc nhãn riêng.
    expect(kinds.some((k) => k.endsWith('x.ops.note'))).toBe(false);
  });

  it('nhãn hiệu lực: cột thừa hưởng bảng, ghi đè khi có', () => {
    expect(labelOf('patient.persons', 'phone')).toMatchObject({ level: 3, category: 'personal', explicit: true, storage: 'retired' });
    expect(labelOf('patient.persons', 'phone_enc')).toMatchObject({ level: 3, storage: 'encrypted' });
    expect(labelOf('patient.persons', 'created_at')).toMatchObject({ level: 3, explicit: false });
    expect(labelOf('integration.endpoints', 'url_ciphertext')?.storage).toBe('encrypted');
    expect(labelOf('nope.table')).toBeNull();
  });

  it('phiên bản danh mục ổn định theo nội dung (thứ tự khoá không ảnh hưởng), đổi một nhãn => đổi phiên bản', () => {
    const a = { t: { ...base } };
    const reordered = { t: { purpose: 'x', retention: 'operational', steward: 'clinic_admin', subject: 'none', category: 'internal', level: 2 } as TableLabel };
    expect(catalogVersion(a)).toBe(catalogVersion(reordered));
    expect(catalogVersion({ t: { ...base, level: 3 } })).not.toBe(catalogVersion(a));
    expect(catalogVersion()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('danh mục thật: không có cột cao hơn bảng; dữ liệu sức khoẻ ở cấp 3; danh sách cột nhạy cảm còn lưu rõ có SĐT / CCCD', () => {
    const problems = checkCatalog(new Map(Object.keys(DATA_CATALOG).map((t) => [t, Object.keys(DATA_CATALOG[t]!.columns ?? {})])));
    expect(problems).toEqual([]);
    for (const t of ['clinical.encounters', 'clinical.conditions', 'clinical.observations', 'clinical.prescriptions']) expect(DATA_CATALOG[t]!.level).toBe(3);
    const s = summarize();
    // HCOS-F16: SĐT / email / số giấy tờ đã mã hoá; cột bản rõ cũ 'retired' không còn trong danh sách việc.
    expect(s.encrypted).toContain('patient.persons.phone_enc');
    expect(s.encrypted).toContain('patient.identifiers.value_enc');
    expect(s.encrypted).toContain('clinical.bookings.national_id_enc');
    expect(s.plaintextSensitive).not.toContain('patient.persons.phone');
    expect(s.plaintextSensitive).not.toContain('patient.identifiers.value');
    expect(s.plaintextSensitive).toContain('patient.persons.given_name'); // F16b
    expect(s.plainByDesign.map((x) => x.column)).toContain('patient.patients.mrn');
    expect(s.plaintextSensitive).not.toContain('integration.endpoints.url_ciphertext');
  });
});
