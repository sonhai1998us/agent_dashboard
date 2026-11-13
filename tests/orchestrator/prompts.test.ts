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

  it('QC/Designer thấy danh sách lệnh kiểm tra được phép, dễ đọc; vai khác không thấy', () => {
    const c = { ...ctx, checkCommands: DEFAULT_SETTINGS.checkCommands };
    for (const r of ['qc', 'designer'] as const) {
      const p = systemPrompt(r, c);
      expect(p).toContain('Chỉ các lệnh Bash khớp mẫu sau được chạy');
      expect(p).toContain('`git (status|diff|log|show)`');
      expect(p).toContain('`(npm|pnpm|yarn|bun) (run )?(test|lint|build|typecheck|check|preview)`');
      expect(p).toMatch(/dùng Read, Grep, Glob thay cho cat, ls, grep, git grep/);
      expect(p).not.toContain('\\s');
    }
    for (const r of ['dev', 'controller'] as const) expect(systemPrompt(r, c)).not.toContain('Chỉ các lệnh Bash khớp mẫu sau được chạy');
  });

  it('QC báo cáo đạt / không đạt', () => {
    expect(systemPrompt('qc', ctx)).toContain('đạt / không đạt');
    expect(systemPrompt('designer', ctx)).toContain('đạt / không đạt');
  });
});

describe('systemPrompt: capture, Figma, dữ liệu QC', () => {
  const preview = { mode: 'prod' as const, accounts: [{ name: 'owner', description: 'Chủ workspace' }, { name: 'member', description: 'Thành viên' }], capture: true, ticketId: 'T-5' };
  const c = { worktree: 'W', files: [], denyBash: [], checkCommands: [], preview };

  it('mọi vai có capture: dặn không tự chạy next, liệt kê tài khoản, chế độ server, lỗi môi trường', () => {
    for (const r of ['dev', 'designer', 'qc'] as const) {
      const p = systemPrompt(r, c);
      expect(p).toContain('Dùng tool capture để xem trang đang chạy; không tự chạy next dev, next start hay next build.');
      expect(p).toContain('Tài khoản test (dùng as: "<name>"):\n- `owner`: Chủ workspace\n- `member`: Thành viên');
      expect(p).toContain('Chế độ server: prod');
      expect(p).toContain('Lỗi [capture:backend_down], [capture:login_failed], [capture:server_failed] là lỗi môi trường, không phải lỗi của Dev');
      expect(p).not.toMatch(/password|mật khẩu của tài khoản/i);
    }
  });

  it('chế độ prod: dặn không build song song vì capture đã build; dev thì không nói', () => {
    expect(systemPrompt('qc', c)).toContain('Chế độ prod: capture đã tự build và chạy bản build');
    expect(systemPrompt('qc', { ...c, preview: { ...preview, mode: 'dev' } })).not.toContain('Chế độ prod:');
  });

  it('Designer so Figma bằng số; QC theo quy tắc dữ liệu', () => {
    const d = systemPrompt('designer', c);
    for (const s of ['get_design_context', 'excludeScreenshot', 'get_variable_defs', 'measure ở đúng viewport của frame', 'lệch tối đa ±1px', 'màu phải khớp đúng (hoặc khớp token)', 'file:dòng', 'đường dẫn ảnh']) expect(d).toContain(s);
    const q = systemPrompt('qc', c);
    for (const s of ['tên bắt đầu bằng `acctv-T-5-`', 'không sửa hay xoá dữ liệu seed', 'thử quyền trên dữ liệu seed', 'dọn dữ liệu đã tạo', 'Request ghi']) expect(q).toContain(s);
    expect(systemPrompt('dev', c)).not.toContain('acctv-T-5-');
  });

  it('QC chế độ cases: viết TC từ tiêu chí nghiệm thu, không review, không capture, không lệnh kiểm tra', () => {
    const p = systemPrompt('qc', { ...c, mode: 'cases', checkCommands: ['pnpm test'] });
    expect(p.split('\n')[0]).toBe('ROLE: qc');
    expect(p).toContain('TC-1');
    expect(p).toMatch(/tiêu chí nghiệm thu/);
    expect(p).not.toMatch(/review phần Dev vừa làm/);
    expect(p).not.toMatch(/capture/);
    expect(p).not.toContain('pnpm test');
  });

  it('QC review và Dev dùng test case TC-… khi có trong ngữ cảnh', () => {
    expect(systemPrompt('qc', ctx)).toMatch(/từng TC/);
    expect(systemPrompt('dev', ctx)).toMatch(/từng TC/);
  });

  it('Controller: QC cases song song Explorer, Dev nhận test case, QC review chạy từng TC; Figma → explorer bắt buộc', () => {
    const p = systemPrompt('controller', ctx);
    expect(p).toContain('mode: "cases"');
    expect(p).toMatch(/song song với Explorer/);
    expect(p).toMatch(/từng TC/);
    expect(p).toMatch(/Figma[^\n]*explorer count ≥ 1 là bắt buộc/);
    expect(p).toContain('Chờ các agent vừa giao xong');
    expect(p).not.toContain('Chờ cả hai xong');
    expect(p).toMatch(/contextFrom tối đa 5 agent/);
    // vòng sau: Dev mới vẫn nhận danh sách TC
    expect(p).toMatch(/contextFrom: \[id QC\/Designer, id QC cases\]/);
  });

  it('không có capture (codex hoặc không có server preview): nói rõ; explorer không nhắc capture', () => {
    const p = systemPrompt('qc', { ...c, preview: { ...preview, capture: false } });
    expect(p).toContain('Không có tool capture');
    expect(p).not.toContain('Tài khoản test');
    expect(systemPrompt('explorer', c)).not.toMatch(/capture/);
    expect(systemPrompt('qc', { worktree: 'W', files: [], denyBash: [] })).not.toMatch(/capture/);
  });

  it('Controller: giao Designer kèm fileKey/nodeId và viewport; preview.mode prod khi cần', () => {
    const p = systemPrompt('controller', { worktree: null, files: [], denyBash: [] });
    expect(p).toContain('fileKey/nodeId');
    expect(p).toMatch(/viewport/);
    expect(p).toMatch(/preview\.mode.*prod.*SSR, redirect, middleware hay header/);
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
    expect(turn.approved(plan, 'D:\\wt', { deps: 'manual' })).toMatch(/chưa cài dependency: Dev đầu tiên cần cài trong worktree \(vd\. `npm ci` hoặc `npm install`\)/);
    expect(turn.approved(plan, 'D:\\wt', { again: true, deps: null })).toMatch(/^Kế hoạch sửa đã được duyệt\. Làm tiếp trên cùng nhánh/);
    expect(turn.approved(plan, 'D:\\wt', { again: true, deps: null })).not.toContain('chưa cài dependency');
    expect(turn.approved(plan, 'D:\\wt', { deps: 'auto' })).toMatch(/Dashboard đang cài dependency.*Đừng giao việc cài dependency/);
    expect(turn.approved(plan, 'D:\\wt', { deps: 'auto' })).toMatch(/Explorer và QC mode: "cases" chạy được ngay/);
    expect(turn.approved(plan, 'D:\\wt', { deps: 'auto' })).not.toContain('chưa cài dependency');
    const fb = turn.feedback('nút lệch', ['D:\\h\\runs\\T-1\\feedback\\1-1.png'], 'D:\\h\\runs\\T-1\\feedback');
    expect(fb).toContain('nút lệch');
    expect(fb).toContain('- D:\\h\\runs\\T-1\\feedback\\1-1.png');
    expect(fb).toContain('propose_plan');
    expect(turn.feedback('chỉ chữ', [], 'D:\\x')).not.toContain('Ảnh chụp');
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
  it('worker được chỉ thư mục nháp; Controller thì không', () => {
    for (const r of ['dev', 'qc', 'designer', 'explorer'] as const) {
      const p = systemPrompt(r, { worktree: 'wt', files: [], denyBash: [], scratch: 'D:\\h\\runs\\T-1\\x\\scratch' });
      expect(p, r).toContain('Thư mục nháp riêng: D:\\h\\runs\\T-1\\x\\scratch');
    }
    expect(systemPrompt('controller', { worktree: 'wt', files: [], denyBash: [] })).not.toContain('Thư mục nháp');
  });
  it('video/ảnh nhiều bản: làm 1 bản mẫu, người dùng duyệt rồi mới làm tiếp', () => {
    expect(systemPrompt('controller', { worktree: 'wt', files: [], denyBash: [] })).toMatch(/chỉ làm 1 bản mẫu trước; ghi trong task rằng Dev dừng lại xin người dùng duyệt bản mẫu/);
    expect(systemPrompt('dev', { worktree: 'wt', files: ['a.ts'], denyBash: [] })).toMatch(/render 1 bản mẫu trước, rồi gọi request_user_action \(title "Duyệt bản mẫu"/);
  });
  it('Dev được dặn không cho python đọc stdin', () => {
    expect(systemPrompt('dev', { worktree: 'wt', files: ['a.ts'], denyBash: [] })).toMatch(/python trên máy này treo khi stdin rỗng/);
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
