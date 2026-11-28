/** HCOS | Giấy phép khám chữa bệnh: kiểm tra đầu vào, ánh xạ lỗi DB sang mã lỗi, và danh sách chờ duyệt. */
import { describe, expect, it } from 'vitest';

import { LicenseError, MedicalLicenseService } from '../../services/api/src/platform/medical-license.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Call { sql: string; params: unknown[] }

type Out = { rows: unknown[]; rowCount: number };

function fakePool(handler: (sql: string, params: unknown[]) => { rows: unknown[] } | Error) {
  const calls: Call[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const out = handler(sql, params);
        if (out instanceof Error) throw out;
        return { rows: out.rows, rowCount: out.rows.length } as Out;
      },
      release: () => {},
    }),
  };
  return { pool, calls };
}

describe('MedicalLicenseService.submit', () => {
  it('gọi hàm DB với người gọi, tenant và số giấy phép đã cắt khoảng trắng', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ result: 'OK' }] }));
    const svc = new MedicalLicenseService({ pool });
    await expect(svc.submit('sub-1', TENANT, '  KCB-0001  ')).resolves.toBe('OK');
    expect(calls[0]!.sql).toContain('iam.submit_medical_license');
    expect(calls[0]!.params).toEqual(['sub-1', TENANT, 'KCB-0001']);
  });

  it('map lỗi DB NOT_TENANT_ADMIN và ALREADY_APPROVED sang LicenseError', async () => {
    const svc = new MedicalLicenseService({ pool: fakePool(() => new Error('NOT_TENANT_ADMIN')).pool });
    await expect(svc.submit('sub-x', TENANT, 'KCB-0001')).rejects.toMatchObject({ code: 'NOT_TENANT_ADMIN' });
    const svc2 = new MedicalLicenseService({ pool: fakePool(() => new Error('ERROR: ALREADY_APPROVED')).pool });
    await expect(svc2.submit('sub-x', TENANT, 'KCB-0001')).rejects.toBeInstanceOf(LicenseError);
  });

  it('từ chối tenantId không phải UUID trước khi chạm DB', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    await expect(new MedicalLicenseService({ pool }).submit('sub-1', 'not-a-uuid', 'KCB-0001')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });
});

describe('MedicalLicenseService.getState', () => {
  it('trả trạng thái và đổi thời điểm sang ISO', async () => {
    const { pool } = fakePool(() => ({
      rows: [{ status: 'pending', license_no: 'KCB-0001', note: null, submitted_at: new Date('2026-11-28T04:00:00Z') }],
    }));
    await expect(new MedicalLicenseService({ pool }).getState('sub-1', TENANT)).resolves.toEqual({
      status: 'pending', licenseNo: 'KCB-0001', note: null, submittedAt: '2026-11-28T04:00:00.000Z',
    });
  });

  it('không có dòng trả về nghĩa là không phải tenant_admin', async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    await expect(new MedicalLicenseService({ pool }).getState('sub-1', TENANT)).rejects.toMatchObject({ code: 'NOT_TENANT_ADMIN' });
  });
});

describe('MedicalLicenseService.decide', () => {
  it('trả NOT_PENDING khi hàm DB không trả OK', async () => {
    const { pool } = fakePool(() => ({ rows: [{ result: 'NOT_PENDING' }] }));
    await expect(new MedicalLicenseService({ pool }).decide('op-1', TENANT, 'approve', null)).resolves.toBe('NOT_PENDING');
  });

  it('từ chối decision lạ trước khi chạm DB', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    await expect(new MedicalLicenseService({ pool }).decide('op-1', TENANT, 'maybe', null)).rejects.toMatchObject({ code: 'INVALID_DECISION' });
    expect(calls).toHaveLength(0);
  });

  it('map NOTE_REQUIRED từ DB', async () => {
    const { pool } = fakePool(() => new Error('NOTE_REQUIRED'));
    await expect(new MedicalLicenseService({ pool }).decide('op-1', TENANT, 'reject', 'x')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
  });
});

describe('MedicalLicenseService.listPending', () => {
  it('ánh xạ dòng DB sang camelCase', async () => {
    const { pool } = fakePool(() => ({
      rows: [{ tenant_id: TENANT, name: 'Phòng khám A', slug: 'pka', medical_license_no: 'KCB-0001', contact_phone: '0900000000', submitted_at: null }],
    }));
    await expect(new MedicalLicenseService({ pool }).listPending('op-1')).resolves.toEqual([
      { tenantId: TENANT, name: 'Phòng khám A', slug: 'pka', medicalLicenseNo: 'KCB-0001', contactPhone: '0900000000', submittedAt: null },
    ]);
  });
});
