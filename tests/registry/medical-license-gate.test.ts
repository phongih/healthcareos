/** HCOS | Hàm cổng giấy phép khám chữa bệnh: chỉ 'approved' hoặc môi trường dữ liệu giả mới được qua. */
import { describe, expect, it } from 'vitest';

import { ClinicalError } from '../../services/api/src/clinical/encounter.service';
import { assertMayReceiveRealPatients } from '../../services/api/src/registry/medical-license-gate';

describe('assertMayReceiveRealPatients', () => {
  it("cho qua khi status = 'approved'", () => {
    expect(() => assertMayReceiveRealPatients('approved', false)).not.toThrow();
  });

  it('cho qua ở môi trường dữ liệu giả (trainingEnv) dù chưa duyệt', () => {
    expect(() => assertMayReceiveRealPatients('none', true)).not.toThrow();
    expect(() => assertMayReceiveRealPatients('pending', true)).not.toThrow();
  });

  for (const status of ['none', 'pending', 'rejected', '', 'APPROVED', 'approved ']) {
    it(`chặn khi status = "${status}" ngoài môi trường dữ liệu giả (fail-closed)`, () => {
      let err: unknown = null;
      try {
        assertMayReceiveRealPatients(status, false);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ClinicalError);
      expect(err).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'MEDICAL_LICENSE_REQUIRED' } });
    });
  }
});
