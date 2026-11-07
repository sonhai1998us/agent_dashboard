import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/src/core/config';
import { branchName, filesOverlap, slugify, transition, validatePlan, type TicketEvent } from '@/src/tickets/flow';
import type { TicketStatus } from '@/src/tickets/model';

const S = DEFAULT_SETTINGS;
const spec = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' };
const good = () => ({
  summary: 'Làm trang đăng nhập',
  difficulty: 'medium',
  packages: [
    { id: 'p1', role: 'dev', title: 'UI', task: 'làm UI', files: ['src/login/**'] },
    { id: 'p2', role: 'qc', title: 'Kiểm', task: 'kiểm', files: [] },
  ],
  roles: { dev: { ...spec, count: 2 }, designer: { ...spec, count: 1 }, qc: { ...spec, count: 1 } },
  acceptance: ['đăng nhập được'],
});
const errs = (p: unknown) => {
  const r = validatePlan(p, S);
  return r.ok ? [] : r.errors;
};
const mut = (f: (p: any) => void) => {
  const p: any = good();
  f(p);
  return errs(p);
};
const has = (list: string[], s: string) => list.some((e) => e.includes(s));

describe('transition', () => {
  const rows: [TicketStatus, TicketEvent, TicketStatus][] = [
    ['draft', 'start_planning', 'planning'],
    ['planning', 'plan_proposed', 'awaiting_approval'],
    ['planning', 'finish_escalated', 'escalated'],
    ['awaiting_approval', 'approve', 'running'],
    ['awaiting_approval', 'revise', 'planning'],
    ['running', 'finish_done', 'done'],
    ['running', 'finish_escalated', 'escalated'],
    ['escalated', 'continue', 'running'],
    ['escalated', 'continue_planning', 'planning'],
    ['planning', 'cancel', 'cancelled'],
    ['awaiting_approval', 'cancel', 'cancelled'],
    ['running', 'cancel', 'cancelled'],
    ['escalated', 'cancel', 'cancelled'],
  ];
  it.each(rows)('%s + %s -> %s', (f, e, t) => expect(transition(f, e)).toBe(t));
  it('cặp không hợp lệ trả null', () => {
    expect(transition('draft', 'approve')).toBeNull();
    expect(transition('done', 'cancel')).toBeNull();
    expect(transition('draft', 'cancel')).toBeNull();
    expect(transition('cancelled', 'continue')).toBeNull();
  });
});

describe('slugify / branchName', () => {
  it('bỏ dấu, đ, ký tự lạ', () => {
    expect(slugify('Trang đăng nhập — Bước 2!')).toBe('trang-dang-nhap-buoc-2');
    expect(slugify('ĐẸP')).toBe('dep');
    expect(slugify('***')).toBe('ticket');
  });
  it('cắt 40 ký tự, không để dấu - cuối', () => {
    const s = slugify('a'.repeat(39) + ' bbbb');
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
  it('branchName', () => expect(branchName('T-12', 'Sửa lỗi')).toBe('acctv/T-12-sua-loi'));
});

describe('validatePlan', () => {
  it('kế hoạch hợp lệ qua', () => expect(validatePlan(good(), S).ok).toBe(true));
  it('preview.mode tuỳ chọn: dev/prod giữ lại, giá trị lạ bị từ chối, thiếu thì undefined', () => {
    const r = validatePlan({ ...good(), preview: { mode: 'prod' } }, S);
    expect(r.ok && r.plan.preview).toEqual({ mode: 'prod' });
    expect(has(errs({ ...good(), preview: { mode: 'x' } }), 'preview.mode')).toBe(true);
    expect(has(errs({ ...good(), preview: 'prod' }), 'preview.mode')).toBe(true);
    const none = validatePlan(good(), S);
    expect(none.ok && none.plan.preview).toBeUndefined();
    expect(none.ok && 'preview' in none.plan).toBe(false);
  });
  it('thiếu designer/qc thì điền count 0 + roleDefaults', () => {
    const p: any = good();
    delete p.roles.designer;
    delete p.roles.qc;
    const r = validatePlan(p, S);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.roles.designer).toEqual({ ...S.roleDefaults.designer, count: 0 });
      expect(r.plan.roles.qc).toEqual({ ...S.roleDefaults.qc, count: 0 });
    }
  });
  it('không phải đối tượng', () => expect(errs(null).length).toBe(1));
  it('summary rỗng', () => expect(has(mut((p) => (p.summary = '  ')), 'summary')).toBe(true));
  it('difficulty sai', () => expect(has(mut((p) => (p.difficulty = 'x')), 'difficulty')).toBe(true));
  it('packages rỗng', () => expect(has(mut((p) => (p.packages = [])), 'packages')).toBe(true));
  it('id trùng', () => expect(has(mut((p) => (p.packages[1].id = 'p1')), 'packages[1].id')).toBe(true));
  it('role sai', () => expect(has(mut((p) => (p.packages[0].role = 'controller')), 'packages[0].role')).toBe(true));
  it('dev thiếu files', () => expect(mut((p) => (p.packages[0].files = []))).toContain('packages[0].files: gói dev phải có ít nhất một file'));
  it('files có ..', () => expect(has(mut((p) => (p.packages[0].files = ['a/../b'])), 'packages[0].files[0]')).toBe(true));
  it('files tuyệt đối', () => {
    expect(has(mut((p) => (p.packages[0].files = ['/etc/x'])), 'files[0]')).toBe(true);
    expect(has(mut((p) => (p.packages[0].files = ['C:\\x'])), 'files[0]')).toBe(true);
  });
  it('count dev ngoài 1..6', () => {
    expect(has(mut((p) => (p.roles.dev.count = 0)), 'roles.dev.count')).toBe(true);
    expect(has(mut((p) => (p.roles.dev.count = 7)), 'roles.dev.count')).toBe(true);
  });
  it('count designer/qc ngoài 0..3', () => {
    expect(has(mut((p) => (p.roles.designer.count = 4)), 'roles.designer.count')).toBe(true);
    expect(has(mut((p) => (p.roles.qc.count = -1)), 'roles.qc.count')).toBe(true);
  });
  it('agent sai', () => expect(has(mut((p) => (p.roles.dev.agent = 'gpt')), 'roles.dev.agent')).toBe(true));
  it('model ngoài danh sách', () => expect(has(mut((p) => (p.roles.dev.model = 'nope')), 'roles.dev.model')).toBe(true));
  it('claude model rỗng bị lỗi', () => expect(has(mut((p) => (p.roles.dev.model = '')), 'roles.dev.model')).toBe(true));
  it('codex: model rỗng được, model lạ khi danh sách rỗng thì lỗi', () => {
    expect(mut((p) => (p.roles.dev = { agent: 'codex', model: '', effort: 'high', count: 1 }))).toEqual([]);
    expect(has(mut((p) => (p.roles.dev = { agent: 'codex', model: 'x', effort: 'high', count: 1 })), 'roles.dev.model')).toBe(true);
    const s2 = { ...S, allowedModels: { ...S.allowedModels, codex: ['gpt-x'] } };
    const p: any = good();
    p.roles.dev = { agent: 'codex', model: 'gpt-x', effort: 'high', count: 1 };
    expect(validatePlan(p, s2).ok).toBe(true);
  });
  it('effort sai', () => expect(has(mut((p) => (p.roles.dev.effort = 'ultra')), 'roles.dev.effort')).toBe(true));
  it('acceptance rỗng', () => expect(has(mut((p) => (p.acceptance = [])), 'acceptance')).toBe(true));
});

describe('filesOverlap', () => {
  it('khác file', () => expect(filesOverlap(['src/a.ts'], ['src/b.ts'])).toBe(false));
  it('glob khớp file', () => {
    expect(filesOverlap(['src/**'], ['src/x/y.ts'])).toBe(true);
    expect(filesOverlap(['src/x/y.ts'], ['src/**'])).toBe(true);
  });
  it('chuẩn hoá \\ và hoa thường', () => expect(filesOverlap(['SRC\\A.ts'], ['src/a.ts'])).toBe(true));
  it('* không vượt qua /', () => expect(filesOverlap(['src/*.ts'], ['src/x/y.ts'])).toBe(false));
  it('mục không có glob là cả thư mục', () => {
    expect(filesOverlap(['src/a'], ['src/a/b.ts'])).toBe(true);
    expect(filesOverlap(['src/a/b.ts'], ['src/a/'])).toBe(true);
    expect(filesOverlap(['src/a'], ['src/ab.ts'])).toBe(false);
  });
});
