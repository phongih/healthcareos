/**
 * HCOS-P0-ENG-001 | IAM | Access policy: kiểm định luật + engine quyết định (thuần, không I/O).
 */
import { describe, expect, it } from 'vitest';

import { asTenantId, asUserId, type AccessPolicyId, type Role } from '../../packages/domain/src/s0-contracts';
import {
  AccessPolicyValidationError,
  canonicalRulesJson,
  decideAccess,
  validateAccessRules,
  type AccessGrant,
  type AccessPolicy,
  type AccessRule,
} from '../../packages/security/src/access-policy';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ME = asUserId(uid(1));
const OTHER = asUserId(uid(2));
const T = asTenantId(uid(9));
const T0 = '2026-01-01T00:00:00.000Z';

const policy = (rules: AccessRule[], over: Partial<AccessPolicy> = {}): AccessPolicy => ({
  tenantId: T, policyId: uid(100 + rules.length) as AccessPolicyId, name: 'p', description: null, status: 'active',
  rules, createdBy: OTHER, createdAt: T0, updatedAt: T0, version: 1, ...over,
});
const grant = (role: Role, p: AccessGrant['policy']): AccessGrant => ({ role, policy: p });
const CHART_ROLES: Role[] = ['doctor', 'clinic_staff', 'pharmacist'];
const OBS_ROLES: Role[] = ['doctor', 'clinic_staff'];
const enc = (practitionerUserId: string, encounterClass = 'ambulatory', status = 'in_progress') => ({ practitionerUserId, encounterClass, status });
const TEMP = { system: 'http://loinc.org', code: '8310-5' };
const HBA1C = { system: 'http://loinc.org', code: '4548-4' };

describe('validateAccessRules', () => {
  it('chấp nhận luật hợp lệ và chuẩn hoá (bỏ trùng)', () => {
    const r = validateAccessRules([
      { action: 'observation:write', criteria: { codes: ['http://loinc.org|8310-5', 'http://loinc.org|8310-5'] }, readonlyFields: ['effectiveAt'] },
      { action: 'encounter:read', criteria: { practitioner: 'self', encounterStatus: ['in_progress'] }, hiddenFields: ['encounter.reasonText'] },
    ]);
    expect(r[0]).toEqual({ action: 'observation:write', criteria: { codes: ['http://loinc.org|8310-5'] }, readonlyFields: ['effectiveAt'] });
    expect(r[1]!.criteria).toEqual({ practitioner: 'self', encounterStatus: ['in_progress'] });
  });

  it.each([
    [[], 'rules'],
    ['x', 'rules'],
    [[{ action: 'chart:delete' }], 'rules[0].action'],
    [[{ action: 'encounter:read', extra: 1 }], 'rules[0].extra'],
    [[{ action: 'patient:read', criteria: { practitioner: 'self' } }], 'rules[0].criteria.practitioner'],
    [[{ action: 'encounter:read', criteria: { practitioner: 'anyone' } }], 'rules[0].criteria.practitioner'],
    [[{ action: 'encounter:read', criteria: {} }], 'rules[0].criteria'],
    [[{ action: 'encounter:read', criteria: { encounterClass: ['spaceship'] } }], 'rules[0].criteria.encounterClass[0]'],
    [[{ action: 'condition:write', criteria: { codes: ['J06.9'] } }], 'rules[0].criteria.codes[0]'],
    [[{ action: 'condition:write', criteria: { codes: [] } }], 'rules[0].criteria.codes'],
    [[{ action: 'patient:read', hiddenFields: ['person.ssn'] }], 'rules[0].hiddenFields[0]'],
    [[{ action: 'encounter:create', hiddenFields: ['periodStart'] }], 'rules[0].hiddenFields'],
    [[{ action: 'encounter:read', readonlyFields: ['status'] }], 'rules[0].readonlyFields'],
  ] as Array<[unknown, string]>)('từ chối luật sai, chỉ đúng chỗ (%s)', (raw, path) => {
    let err: unknown;
    try {
      validateAccessRules(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AccessPolicyValidationError);
    expect((err as AccessPolicyValidationError).path).toBe(path);
  });

  it('giới hạn số luật', () => {
    expect(() => validateAccessRules(Array.from({ length: 51 }, () => ({ action: 'patient:read' })))).toThrow(AccessPolicyValidationError);
  });

  it('canonicalRulesJson không phụ thuộc thứ tự khoá', () => {
    const a = canonicalRulesJson([{ action: 'encounter:read', criteria: { practitioner: 'self', encounterClass: ['virtual'] } }]);
    const b = canonicalRulesJson([{ criteria: { encounterClass: ['virtual'], practitioner: 'self' }, action: 'encounter:read' } as AccessRule]);
    expect(a).toBe(b);
  });
});

describe('decideAccess', () => {
  it('không có vai trò phù hợp => ROLE (policy không cấp thêm quyền)', () => {
    const p = policy([{ action: 'observation:write' }]);
    expect(decideAccess([grant('pharmacist', p)], 'observation:write', OBS_ROLES, { callerUserId: ME })).toEqual({ allowed: false, reason: 'ROLE' });
  });

  it('membership không gắn policy => cho phép đầy đủ (tương thích ngược)', () => {
    const d = decideAccess([grant('doctor', null)], 'encounter:read', CHART_ROLES, { callerUserId: ME, encounter: enc(OTHER) });
    expect(d).toMatchObject({ allowed: true, policyIds: [] });
    if (d.allowed) expect(d.hiddenFields.size).toBe(0);
  });

  it('policy không có luật cho action => ACCESS_POLICY', () => {
    const p = policy([{ action: 'patient:read' }]);
    expect(decideAccess([grant('doctor', p)], 'encounter:read', CHART_ROLES, { callerUserId: ME, encounter: enc(ME) }))
      .toEqual({ allowed: false, reason: 'ACCESS_POLICY' });
  });

  it('practitioner=self chỉ khớp đợt khám của chính mình; thiếu dữ kiện encounter => không khớp', () => {
    const p = policy([{ action: 'encounter:read', criteria: { practitioner: 'self' } }]);
    expect(decideAccess([grant('doctor', p)], 'encounter:read', CHART_ROLES, { callerUserId: ME, encounter: enc(ME) }).allowed).toBe(true);
    expect(decideAccess([grant('doctor', p)], 'encounter:read', CHART_ROLES, { callerUserId: ME, encounter: enc(OTHER) }).allowed).toBe(false);
    expect(decideAccess([grant('doctor', p)], 'encounter:read', CHART_ROLES, { callerUserId: ME }).allowed).toBe(false);
  });

  it('encounterClass / encounterStatus', () => {
    const p = policy([{ action: 'encounter:read', criteria: { encounterClass: ['emergency'], encounterStatus: ['in_progress'] } }]);
    const f = (cls: string, st: string) => decideAccess([grant('clinic_staff', p)], 'encounter:read', CHART_ROLES, { callerUserId: ME, encounter: enc(OTHER, cls, st) }).allowed;
    expect(f('emergency', 'in_progress')).toBe(true);
    expect(f('emergency', 'finished')).toBe(false);
    expect(f('ambulatory', 'in_progress')).toBe(false);
    const create = policy([{ action: 'encounter:create', criteria: { encounterClass: ['virtual'] } }]);
    expect(decideAccess([grant('doctor', create)], 'encounter:create', ['doctor'], { callerUserId: ME, encounterClass: 'virtual' }).allowed).toBe(true);
    expect(decideAccess([grant('doctor', create)], 'encounter:create', ['doctor'], { callerUserId: ME, encounterClass: 'inpatient' }).allowed).toBe(false);
  });

  it('codes: mã cụ thể và wildcard theo hệ mã', () => {
    const exact = policy([{ action: 'observation:write', criteria: { codes: ['http://loinc.org|8310-5'] } }]);
    const wild = policy([{ action: 'observation:write', criteria: { codes: ['http://loinc.org|*'] } }]);
    const ask = (p: AccessPolicy, code: typeof TEMP) => decideAccess([grant('clinic_staff', p)], 'observation:write', OBS_ROLES, { callerUserId: ME, code }).allowed;
    expect(ask(exact, TEMP)).toBe(true);
    expect(ask(exact, HBA1C)).toBe(false);
    expect(ask(wild, HBA1C)).toBe(true);
    expect(ask(wild, { system: 'http://snomed.info/sct', code: '386725007' })).toBe(false);
  });

  it("policy 'unavailable' hoặc retired => không có quyền qua membership đó (không rơi về mặc định)", () => {
    expect(decideAccess([grant('doctor', 'unavailable')], 'patient:read', CHART_ROLES, { callerUserId: ME }).allowed).toBe(false);
    const retired = policy([{ action: 'patient:read' }], { status: 'retired' });
    expect(decideAccess([grant('doctor', retired)], 'patient:read', CHART_ROLES, { callerUserId: ME }).allowed).toBe(false);
  });

  it('trường bị che = GIAO giữa các luật/membership cho phép; một membership không policy thắng tuyệt đối', () => {
    const p1 = policy([{ action: 'patient:read', hiddenFields: ['identifiers', 'person.phone'] }]);
    const p2 = policy([{ action: 'patient:read', hiddenFields: ['person.phone', 'person.birthDate'] }, { action: 'encounter:read' }]);
    const d = decideAccess([grant('clinic_staff', p1), grant('pharmacist', p2)], 'patient:read', CHART_ROLES, { callerUserId: ME });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect([...d.hiddenFields]).toEqual(['person.phone']);
      expect(d.policyIds).toEqual([p1.policyId, p2.policyId]);
    }
    const withPlain = decideAccess([grant('clinic_staff', p1), grant('doctor', null)], 'patient:read', CHART_ROLES, { callerUserId: ME });
    if (withPlain.allowed) expect(withPlain.hiddenFields.size).toBe(0);
  });

  it('luật không khớp điều kiện không đóng góp trường bị che/khoá', () => {
    const p = policy([
      { action: 'observation:write', criteria: { codes: ['http://loinc.org|8310-5'] }, readonlyFields: ['effectiveAt', 'status'] },
      { action: 'observation:write', criteria: { practitioner: 'self' } },
    ]);
    const mine = decideAccess([grant('doctor', p)], 'observation:write', OBS_ROLES, { callerUserId: ME, encounter: enc(ME), code: TEMP });
    if (mine.allowed) expect(mine.readonlyFields.size).toBe(0); // luật 2 (không khoá) cũng khớp => giao rỗng
    const others = decideAccess([grant('doctor', p)], 'observation:write', OBS_ROLES, { callerUserId: ME, encounter: enc(OTHER), code: TEMP });
    if (others.allowed) expect([...others.readonlyFields].sort()).toEqual(['effectiveAt', 'status']);
  });
});
