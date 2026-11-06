import { describe, it, expect } from 'vitest';
import { systemPrompt, workerPrompt, turn, listPreview } from '@/src/orchestrator/prompts';
import { DEFAULT_SETTINGS } from '@/src/core/config';
import type { Plan, Role, Ticket } from '@/src/tickets/model';

const plan: Plan = {
  summary: 'Thêm trang đăng nhập', difficulty: 'medium', acceptance: ['Đăng nhập được', 'Test xanh'],
  packages: [{ id: 'p1', role: 'dev', title: 'Form', task: 'Viết form', files: ['src/login.tsx'] }],
  roles: {
    explorer: { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 0 },
    dev: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 1 },
    designer: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 0 },
    qc: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 1 },
  },
};
const ctx = { worktree: 'D:\\wt\\app-T-1', files: ['src/a.ts'], denyBash: DEFAULT_SETTINGS.denyBash };

describe('systemPrompt', () => {
  it('dòng đầu là ROLE: <role>', () => {
    for (const r of ['controller', 'dev', 'designer', 'qc'] as Role[]) {
      expect(systemPrompt(r, ctx).split('\n')[0]).toBe(`ROLE: ${r}`);
    }
  });

  it('Controller nêu đủ 5 tool', () => {
    const p = systemPrompt('controller', { worktree: null, files: [], denyBash: [] });
    for (const t of ['propose_plan', 'spawn_agent', 'wait_agents', 'get_agent_log', 'finish']) expect(p).toContain(t);
  });

  it('Dev cấm git commit, có danh sách lệnh cấm dễ đọc và file được sửa', () => {
    const p = systemPrompt('dev', ctx);
    expect(p).toContain('git commit');
    expect(p).toContain('src/a.ts');
    expect(p).toContain('npm link');
    expect(p).not.toContain('\\b');
  });

  it('QC báo cáo đạt / không đạt', () => {
    expect(systemPrompt('qc', ctx)).toContain('đạt / không đạt');
    expect(systemPrompt('designer', ctx)).toContain('đạt / không đạt');
  });
});

describe('workerPrompt', () => {
  it('có task, từng file, worktree và tiêu chí nghiệm thu', () => {
    const p = workerPrompt({ task: 'Viết form đăng nhập', files: ['src/login.tsx', 'src/login.test.tsx'], role: 'dev' }, plan, 'D:\\Dự án\\wt');
    expect(p).toContain('Viết form đăng nhập');
    expect(p).toContain('src/login.tsx');
    expect(p).toContain('src/login.test.tsx');
    expect(p).toContain('D:\\Dự án\\wt');
    expect(p).toContain('Đăng nhập được');
  });
});

describe('turn', () => {
  const t = { id: 'T-1', title: 'Trang login', description: 'Làm trang login', dir: 'D:\\app', overrides: {} } as unknown as Ticket;

  it('câu mở đầu cố định', () => {
    expect(turn.first(t)).toContain('Trang login');
    expect(turn.first(t)).toContain('propose_plan');
    expect(turn.approved(plan, 'D:\\wt').startsWith('Kế hoạch đã được duyệt')).toBe(true);
    expect(turn.approved(plan, 'D:\\wt')).toContain('D:\\wt');
    expect(turn.approved(plan, 'D:\\wt')).toMatch(/chưa cài dependency: Dev đầu tiên cần cài trong worktree \(vd\. `npm ci` hoặc `npm install`\)/);
    expect(turn.revised('thêm test').startsWith('Người dùng góp ý')).toBe(true);
    expect(turn.revised('thêm test')).toContain('thêm test');
    expect(turn.restarted().startsWith('Dashboard vừa khởi động lại')).toBe(true);
    expect(turn.continued('thử cách khác', 4)).toContain('thử cách khác');
    expect(turn.nudge()).toContain('finish');
  });

  it('agentsDone có vòng và báo cáo', () => {
    const s = turn.agentsDone([{
      id: 'acctv:T-1:dev-1', role: 'dev', state: 'done', stopReason: null, summary: 'xong a', changedFiles: ['src/a.ts'],
      calls: 3, errors: 0, guardBlocks: 0, scopeViolations: 0, topError: null,
    }], 1, 3);
    expect(s.startsWith('Các agent đã xong')).toBe(true);
    expect(s).toContain('vòng 1/3');
    expect(s).toContain('xong a');
  });

  it('agentsDone cảnh báo file ngoài phạm vi chỉ khi có', () => {
    expect(turn.agentsDone([], 1, 3)).not.toContain('CẢNH BÁO');
    const s = turn.agentsDone([], 1, 3, ['evil.txt', 'package-lock.json']);
    expect(s).toContain('CẢNH BÁO');
    expect(s).toContain('evil.txt, package-lock.json');
  });

  it('listPreview cắt ở 50 file', () => {
    const many = Array.from({ length: 53 }, (_, i) => 'f' + i);
    expect(listPreview(many)).toMatch(/f49 … và 3 file khác$/);
    expect(listPreview(['a', 'b'])).toBe('a, b');
  });

  it('Dev được dặn sửa file bằng Edit/Write, không ghi file bằng Bash', () => {
    const p = systemPrompt('dev', { worktree: 'wt', files: ['a.ts'], denyBash: [] });
    expect(p).toMatch(/bằng Edit hoặc Write, không ghi file bằng lệnh Bash/);
  });
});

describe('lệnh nền trong prompt worker', () => {
  it('Dev và QC đều được dặn không chạy lệnh nền', () => {
    for (const r of ['dev', 'qc', 'designer'] as const) {
      expect(systemPrompt(r, { worktree: 'wt', files: [], denyBash: [] })).toMatch(/run_in_background bị chặn/);
    }
  });
});

describe('request_user_action trong prompt worker', () => {
  it('Dev, QC, Designer được dặn dùng request_user_action khi cần người dùng đăng nhập', () => {
    for (const r of ['dev', 'qc', 'designer'] as const) {
      expect(systemPrompt(r, { worktree: 'wt', files: [], denyBash: [] })).toMatch(/gọi tool request_user_action/);
    }
    expect(systemPrompt('controller', { worktree: 'wt', files: [], denyBash: [] })).not.toMatch(/request_user_action/);
  });
});

describe('dặn agent làm nhanh', () => {
  const ctx = { worktree: 'W', files: ['a.ts'], denyBash: [] };
  it('Dev: kiểm tra một lần, build chỉ khi cần, không cài lại dependency', () => {
    const s = systemPrompt('dev', ctx);
    expect(s).toMatch(/Kiểm tra một lần sau khi sửa xong/);
    expect(s).toMatch(/Chỉ chạy build toàn dự án khi task hoặc tiêu chí nghiệm thu yêu cầu, và chỉ một lần/);
    expect(s).toMatch(/Không cài lại dependency/);
  });
  it('Controller: task đủ spec cho vòng đầu; lỗi nhẹ không mở vòng mới', () => {
    const s = systemPrompt('controller', ctx);
    expect(s).toMatch(/làm đúng ngay vòng đầu/);
    expect(s).toMatch(/Lỗi nhẹ .* không mở vòng mới/);
    expect(turn.agentsDone([], 1, 3)).toMatch(/lỗi nhẹ ghi vào báo cáo cuối, không mở vòng mới/);
  });
});
