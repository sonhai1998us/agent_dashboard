import { matchEntry } from '@/src/guard/policy';
import type { Settings } from '@/src/core/config';
import type { AgentKind, Effort, Plan, RoleSpec, TicketStatus, WorkRole } from './model';

export type TicketEvent = 'start_planning' | 'plan_proposed' | 'approve' | 'revise' | 'finish_done' | 'finish_escalated' | 'continue' | 'continue_planning' | 'feedback' | 'cancel';

const TABLE: Record<string, TicketStatus> = {
  'draft:start_planning': 'planning',
  'planning:plan_proposed': 'awaiting_approval',
  'planning:finish_escalated': 'escalated',
  'awaiting_approval:approve': 'running',
  'awaiting_approval:revise': 'planning',
  'running:finish_done': 'done',
  'running:finish_escalated': 'escalated',
  'escalated:continue': 'running',
  'escalated:continue_planning': 'planning',
  // người dùng xem kết quả, góp ý: Controller lập kế hoạch sửa trên cùng worktree
  'done:feedback': 'planning',
  'planning:cancel': 'cancelled',
  'awaiting_approval:cancel': 'cancelled',
  'running:cancel': 'cancelled',
  'escalated:cancel': 'cancelled',
};

export function transition(from: TicketStatus, ev: TicketEvent): TicketStatus | null {
  return TABLE[`${from}:${ev}`] ?? null;
}

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const WORK_ROLES: WorkRole[] = ['explorer', 'dev', 'designer', 'qc'];
const AGENTS: AgentKind[] = ['claude', 'codex'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const COUNT_MAX: Record<WorkRole, number> = { explorer: 3, dev: 6, designer: 3, qc: 3 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function badPath(f: unknown): boolean {
  if (!isStr(f) || !f.trim()) return true;
  const n = f.replace(/\\/g, '/');
  return n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..');
}

export function validatePlan(raw: unknown, s: Settings): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['kế hoạch phải là một đối tượng'] };

  if (!isStr(raw.summary) || !raw.summary.trim()) errors.push('summary: không được rỗng');
  if (!DIFFICULTIES.includes(raw.difficulty as string)) errors.push('difficulty: phải là easy, medium hoặc hard');

  const packages: Plan['packages'] = [];
  if (!Array.isArray(raw.packages) || raw.packages.length < 1) errors.push('packages: cần ít nhất một gói');
  else {
    const seen = new Set<string>();
    raw.packages.forEach((p, i) => {
      const at = `packages[${i}]`;
      if (!isObj(p)) return void errors.push(`${at}: gói phải là một đối tượng`);
      if (!isStr(p.id) || !p.id.trim()) errors.push(`${at}.id: không được rỗng`);
      else if (seen.has(p.id)) errors.push(`${at}.id: "${p.id}" bị trùng`);
      else seen.add(p.id);
      if (!WORK_ROLES.includes(p.role as WorkRole)) errors.push(`${at}.role: phải là explorer, dev, designer hoặc qc`);
      const files = Array.isArray(p.files) ? p.files : [];
      if (p.files !== undefined && !Array.isArray(p.files)) errors.push(`${at}.files: phải là mảng chuỗi`);
      else {
        if (p.role === 'dev' && files.length < 1) errors.push(`${at}.files: gói dev phải có ít nhất một file`);
        files.forEach((f, j) => {
          if (badPath(f)) errors.push(`${at}.files[${j}]: phải là đường dẫn tương đối, không chứa ".."`);
        });
      }
      packages.push({
        id: isStr(p.id) ? p.id : '',
        role: p.role as WorkRole,
        title: isStr(p.title) ? p.title : '',
        task: isStr(p.task) ? p.task : '',
        files: files.filter(isStr),
      });
    });
  }

  const rolesRaw = isObj(raw.roles) ? raw.roles : {};
  if (!isObj(raw.roles)) errors.push('roles: thiếu');
  const roles = {} as Plan['roles'];
  for (const r of WORK_ROLES) {
    const o = rolesRaw[r];
    const def = s.roleDefaults[r];
    if (o === undefined && r !== 'dev') {
      roles[r] = { ...def, count: 0 };
      continue;
    }
    if (!isObj(o)) {
      if (isObj(raw.roles)) errors.push(`roles.${r}: thiếu`);
      roles[r] = { ...def, count: 0 };
      continue;
    }
    const at = `roles.${r}`;
    const [min, max] = [r === 'dev' ? 1 : 0, COUNT_MAX[r]];
    if (!Number.isInteger(o.count) || (o.count as number) < min || (o.count as number) > max) errors.push(`${at}.count: phải là số nguyên từ ${min} đến ${max}`);
    if (!AGENTS.includes(o.agent as AgentKind)) errors.push(`${at}.agent: phải là claude hoặc codex`);
    else {
      const list = s.allowedModels[o.agent as AgentKind] ?? [];
      const m = o.model;
      const emptyOk = o.agent === 'codex' && (m === '' || m === undefined);
      if (!emptyOk && (!isStr(m) || !list.includes(m))) errors.push(`${at}.model: "${String(m)}" không nằm trong danh sách cho phép của ${String(o.agent)}`);
    }
    if (!EFFORTS.includes(o.effort as Effort)) errors.push(`${at}.effort: phải là low, medium, high, xhigh hoặc max`);
    roles[r] = { agent: o.agent as AgentKind, model: isStr(o.model) ? o.model : '', effort: o.effort as Effort, count: o.count as number } as RoleSpec & { count: number };
  }

  const acceptance = Array.isArray(raw.acceptance) ? raw.acceptance : [];
  if (acceptance.length < 1 || !acceptance.every((a) => isStr(a) && a.trim())) errors.push('acceptance: cần ít nhất một dòng, mỗi dòng không rỗng');

  let preview: Plan['preview'];
  if (raw.preview !== undefined && raw.preview !== null) {
    const m = isObj(raw.preview) ? raw.preview.mode : undefined;
    if (m === 'dev' || m === 'prod') preview = { mode: m };
    else errors.push('preview.mode: phải là dev hoặc prod');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { summary: raw.summary as string, difficulty: raw.difficulty as Plan['difficulty'], packages, roles, acceptance: acceptance as string[], ...(preview ? { preview } : {}) } };
}

export function filesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => matchEntry(x, y) || matchEntry(y, x)));
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'ticket';
}

export function branchName(ticketId: string, title: string): string {
  return `acctv/${ticketId}-${slugify(title)}`;
}
