import { describe, expect, test } from 'vitest';
import type { Plan } from '@/src/tickets/model';
import { applyPlanEdit, planDiff } from '@/app/lib/planEdit';

const spec = { agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'high' as const };
const plan = (): Plan => ({
  summary: 's', difficulty: 'easy',
  packages: [{ id: 'p1', role: 'dev', title: 'A', task: 't', files: ['a.ts'] }, { id: 'p3', role: 'dev', title: 'B', task: 't', files: [] }],
  roles: { dev: { ...spec, count: 2 }, designer: { ...spec, count: 0 }, qc: { ...spec, count: 1 } },
  acceptance: ['ok'],
});

describe('applyPlanEdit', () => {
  test('role count', () => {
    const p = applyPlanEdit(plan(), { type: 'role', role: 'dev', patch: { count: 3 } });
    expect(p.roles.dev.count).toBe(3);
    expect(p.roles.qc.count).toBe(1);
  });
  test('pkgFiles trims and drops blanks', () => {
    const p = applyPlanEdit(plan(), { type: 'pkgFiles', id: 'p1', text: 'a.ts\n\n b.ts ' });
    expect(p.packages[0].files).toEqual(['a.ts', 'b.ts']);
  });
  test('addPkg uses an unused id', () => {
    const p = applyPlanEdit(plan(), { type: 'addPkg', role: 'qc' });
    expect(p.packages.map((k) => k.id)).toEqual(['p1', 'p3', 'p2']);
    expect(p.packages[2].role).toBe('qc');
  });
  test('removePkg', () => {
    expect(applyPlanEdit(plan(), { type: 'removePkg', id: 'p1' }).packages.map((k) => k.id)).toEqual(['p3']);
  });
  test('acceptance by line', () => {
    expect(applyPlanEdit(plan(), { type: 'acceptance', text: 'x\n\ny ' }).acceptance).toEqual(['x', 'y']);
  });
});

describe('planDiff', () => {
  test('count change', () => {
    expect(planDiff(plan(), applyPlanEdit(plan(), { type: 'role', role: 'dev', patch: { count: 3 } }))).toEqual(['Dev: 2 → 3']);
  });
  test('no change', () => expect(planDiff(plan(), plan())).toEqual([]));
  test('file added', () => {
    const after = applyPlanEdit(plan(), { type: 'pkgFiles', id: 'p1', text: 'a.ts\nsrc/x.ts' });
    expect(planDiff(plan(), after)).toEqual(['gói p1: thêm src/x.ts']);
  });
});
