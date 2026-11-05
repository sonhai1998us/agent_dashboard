import type { Plan, RoleSpec, WorkPackage, WorkRole } from '@/src/tickets/model';

export type PlanEdit =
  | { type: 'role'; role: WorkRole; patch: Partial<RoleSpec & { count: number }> }
  | { type: 'pkg'; id: string; patch: Partial<Omit<WorkPackage, 'id'>> }
  | { type: 'pkgFiles'; id: string; text: string }
  | { type: 'addPkg'; role: WorkRole } | { type: 'removePkg'; id: string }
  | { type: 'acceptance'; text: string };

export const ROLE_LABEL: Record<WorkRole, string> = { dev: 'Dev', designer: 'Designer', qc: 'QC' };

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export function applyPlanEdit(p: Plan, e: PlanEdit): Plan {
  switch (e.type) {
    case 'role': return { ...p, roles: { ...p.roles, [e.role]: { ...p.roles[e.role], ...e.patch } } };
    case 'pkg': return { ...p, packages: p.packages.map((k) => (k.id === e.id ? { ...k, ...e.patch } : k)) };
    case 'pkgFiles': return { ...p, packages: p.packages.map((k) => (k.id === e.id ? { ...k, files: lines(e.text) } : k)) };
    case 'addPkg': {
      const used = new Set(p.packages.map((k) => k.id));
      let n = 1;
      while (used.has(`p${n}`)) n++;
      return { ...p, packages: [...p.packages, { id: `p${n}`, role: e.role, title: '', task: '', files: [] }] };
    }
    case 'removePkg': return { ...p, packages: p.packages.filter((k) => k.id !== e.id) };
    case 'acceptance': return { ...p, acceptance: lines(e.text) };
  }
}

/** Có sửa gì không (kể cả đổi thứ tự hay file lặp mà planDiff không liệt kê). */
export const planEdited = (before: Plan, after: Plan): boolean => JSON.stringify(before) !== JSON.stringify(after);

export function planDiff(before: Plan, after: Plan): string[] {
  const out: string[] = [];
  for (const role of Object.keys(ROLE_LABEL) as WorkRole[]) {
    const a = before.roles[role], b = after.roles[role], l = ROLE_LABEL[role];
    if (a.count !== b.count) out.push(`${l}: ${a.count} → ${b.count}`);
    for (const k of ['agent', 'model', 'effort'] as const) if (a[k] !== b[k]) out.push(`${l} ${k}: ${a[k]} → ${b[k]}`);
  }
  const bm = new Map(before.packages.map((k) => [k.id, k]));
  const am = new Map(after.packages.map((k) => [k.id, k]));
  for (const k of after.packages) if (!bm.has(k.id)) out.push(`thêm gói ${k.id}${k.title ? `: ${k.title}` : ''}`);
  for (const k of before.packages) if (!am.has(k.id)) out.push(`xoá gói ${k.id}`);
  for (const k of after.packages) {
    const o = bm.get(k.id);
    if (!o) continue;
    if (o.role !== k.role) out.push(`gói ${k.id}: vai ${o.role} → ${k.role}`);
    if (o.title !== k.title) out.push(`gói ${k.id}: đổi tiêu đề`);
    if (o.task !== k.task) out.push(`gói ${k.id}: đổi nội dung task`);
    for (const f of k.files) if (!o.files.includes(f)) out.push(`gói ${k.id}: thêm ${f}`);
    for (const f of o.files) if (!k.files.includes(f)) out.push(`gói ${k.id}: bỏ ${f}`);
  }
  if (before.acceptance.join('\n') !== after.acceptance.join('\n')) out.push('đổi tiêu chí nghiệm thu');
  return out;
}
