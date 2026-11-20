/** HCOS-F11 | Hàm thuần của Decision Engine: kiểm luật theo danh mục, so điều kiện (fail-closed), cooldown, thống kê bất thường. */
import { describe, expect, it } from 'vitest';

import { DETECTORS, matches, rolesSeeing, validateRule } from '../../services/api/src/decision/catalog';
import { decide, type Candidate } from '../../services/api/src/decision/decision.service';
import { mad, median, poissonZ, robustZ } from '../../services/api/src/decision/stats';

const ok = { name: 'SpO2 thấp', detector: 'vital_abnormal', conditions: [{ metric: 'spo2_pct', op: '<', value: 92 }], actions: ['notify_doctor', 'suggest'], priority: 1, cooldownMinutes: 60 };

describe('danh mục luật', () => {
  it('luật hợp lệ không có lỗi; mọi bộ phát hiện có chỉ số và vai trò nhận', () => {
    expect(validateRule(ok)).toEqual([]);
    for (const d of DETECTORS) {
      expect(d.metrics.length).toBeGreaterThan(0);
      expect(d.targets.length).toBeGreaterThan(0);
    }
  });
  it('từ chối: bộ lạ, chỉ số của bộ khác, phép so lạ, giá trị không hữu hạn, trường thừa', () => {
    expect(validateRule({ ...ok, detector: 'x' }).length).toBeGreaterThan(0);
    expect(validateRule({ ...ok, conditions: [{ metric: 'held_vnd', op: '>', value: 1 }] }).join()).toMatch(/not a metric/);
    expect(validateRule({ ...ok, conditions: [{ metric: 'spo2_pct', op: '=~', value: 1 }] }).join()).toMatch(/op must/);
    expect(validateRule({ ...ok, conditions: [{ metric: 'spo2_pct', op: '<', value: Infinity }] }).join()).toMatch(/finite/);
    expect(validateRule({ ...ok, conditions: [{ metric: 'spo2_pct', op: '<', value: 1, sql: 'x' }] }).join()).toMatch(/unknown fields/);
    expect(validateRule({ ...ok, conditions: [] }).join()).toMatch(/1\.\.5/);
  });
  it('hành động: log_only đứng một mình; suggest cần notify; vai trò nhận theo nội dung', () => {
    expect(validateRule({ ...ok, actions: ['log_only', 'notify_doctor'] }).join()).toMatch(/log_only/);
    expect(validateRule({ ...ok, actions: ['suggest'] }).join()).toMatch(/suggest requires/);
    expect(validateRule({ ...ok, actions: ['notify_cashier'] }).join()).toMatch(/not allowed/);
    expect(validateRule({ ...ok, actions: ['notify_doctor', 'notify_doctor'] }).join()).toMatch(/distinct/);
    expect(validateRule({ ...ok, actions: ['delete_patient'] }).join()).toMatch(/unknown action/);
    expect(validateRule({ ...ok, detector: 'cash_difference', conditions: [{ metric: 'abs_difference_vnd', op: '>=', value: 1 }], actions: ['notify_pharmacist'] }).join()).toMatch(/not allowed/);
    expect(rolesSeeing('clinic_admin')).toEqual(['clinic_admin', 'tenant_admin']);
    expect(rolesSeeing('doctor')).toEqual(['doctor']);
  });
  it('so điều kiện: AND; thiếu / null / NaN chỉ số => không khớp', () => {
    const c = [{ metric: 'a', op: '>=' as const, value: 1 }, { metric: 'b', op: '!=' as const, value: 0 }];
    expect(matches(c, { a: 1, b: 2 })).toBe(true);
    expect(matches(c, { a: 1, b: 0 })).toBe(false);
    expect(matches(c, { a: 1 })).toBe(false);
    expect(matches(c, { a: null, b: 1 })).toBe(false);
    expect(matches(c, { a: NaN, b: 1 })).toBe(false);
  });
});

describe('quyết định + cooldown', () => {
  const cand = (k: string, v: number): Candidate => ({ subjectKey: k, metrics: { x: v }, title: k, detail: null, link: null });
  const rule = { conditions: [{ metric: 'x', op: '>' as const, value: 5 }], cooldownMinutes: 60 };
  it('chỉ báo ứng viên khớp; đối tượng đã báo trong cooldown bị chặn; hết cooldown báo lại; có giới hạn số sự kiện', () => {
    const now = Date.parse('2026-11-20T03:00:00Z');
    const last = new Map([['a', now - 30 * 60_000], ['b', now - 61 * 60_000]]);
    const d = decide(rule, [cand('a', 9), cand('b', 9), cand('c', 9), cand('d', 1)], last, now);
    expect(d.fire.map((c) => c.subjectKey)).toEqual(['b', 'c']);
    expect(d.suppressed).toBe(1);
    const many = Array.from({ length: 5 }, (_, i) => cand(`k${i}`, 9));
    expect(decide(rule, many, new Map(), now, 3)).toMatchObject({ capped: 2 });
    expect(decide({ ...rule, cooldownMinutes: 0 }, [cand('a', 9)], last, now).fire.length).toBe(1);
  });
});

describe('thống kê bất thường (Native AI phía máy chủ)', () => {
  it('trung vị / MAD', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });
  it('robust z: một ngày đột biến trong lịch sử không làm "mù" phát hiện; thiếu lịch sử => null; lịch sử hằng không chia 0', () => {
    expect(robustZ(30, [10, 11, 9, 10, 12, 10, 60, 11])).toBeGreaterThan(5);
    expect(robustZ(10, [10, 11, 9])).toBeNull();
    const z = robustZ(15, [10, 10, 10, 10]);
    expect(z).not.toBeNull();
    expect(Number.isFinite(z!)).toBe(true);
    expect(z!).toBeGreaterThan(0);
    expect(robustZ(10, [10, 10, 10, 10])).toBe(0);
  });
  it('z Poisson cho dữ liệu đếm', () => {
    expect(poissonZ(12, 4)).toBe(4);
    expect(poissonZ(1, 0)).toBe(1);
  });
});
