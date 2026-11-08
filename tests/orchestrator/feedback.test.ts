import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, cleanup, validPlan, ids, runOf, toRunning, g, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => cleanup(env));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const img = (name = 'a.png', type = 'image/png', data = PNG) => ({ name, type, data });
const logs = (T: string) => env.tickets.listLog(T).map((l) => l.text);

/** Ticket chạy xong: Dev sửa một file, Controller finish done. */
async function toDone(): Promise<string> {
  const T = await toRunning(env);
  const wt = env.tickets.getTicket(T)!.worktree!;
  writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
  expect((await env.orch.mcpTools(T).finish({ status: 'done', report: 'xong' })).isError).toBeFalsy();
  runOf(env, ids(T).ctrl)!.finish({});
  await env.orch.idle();
  expect(env.tickets.getTicket(T)!.status).toBe('done');
  return T;
}

describe('góp ý để làm tiếp cho ticket đã xong', () => {
  it('kiểm tra đầu vào', async () => {
    await expect(env.orch.feedback('T-99', 'x', [])).rejects.toMatchObject({ status: 404 });
    const T = await toRunning(env);
    await expect(env.orch.feedback(T, 'x', [])).rejects.toMatchObject({ status: 409 });
    await env.orch.mcpTools(T).finish({ status: 'done', report: 'xong' });
    await env.orch.idle();
    await expect(env.orch.feedback(T, '  ', [])).rejects.toMatchObject({ status: 400 });
    await expect(env.orch.feedback(T, 'x', [img('a.svg', 'image/svg+xml')])).rejects.toMatchObject({ status: 400 });
    await expect(env.orch.feedback(T, 'x', Array.from({ length: 7 }, () => img()))).rejects.toMatchObject({ status: 400 });
    await expect(env.orch.feedback(T, 'x', [img('big.png', 'image/png', Buffer.alloc(5 * 1024 * 1024 + 1))])).rejects.toMatchObject({ status: 400 });
    expect(env.tickets.getTicket(T)!.status).toBe('done');
  });

  it('lưu ảnh, Controller lập kế hoạch sửa; duyệt xong làm tiếp trên cùng worktree và nhánh', async () => {
    const T = await toDone();
    const before = env.tickets.getTicket(T)!;
    const { ctrl } = ids(T);
    const n = env.runs.length;

    const t = await env.orch.feedback(T, 'Nút tắt tiếng chồng lên chữ', [img('chup 1.png'), img('b.jpg', 'image/jpeg')]);
    expect(t.status).toBe('planning');
    const dir = join(env.cfg.home, 'runs', T, 'feedback');
    const prompt = env.runs[n].spec.prompt;
    expect(env.runs[n].spec.agentId).toBe(ctrl);
    expect(prompt).toContain('Nút tắt tiếng chồng lên chữ');
    expect(prompt).toContain('propose_plan');
    const shots = prompt.split('\n').filter((l) => l.startsWith('- ') && l.includes(dir)).map((l) => l.slice(2));
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatch(/\.png$/);
    expect(shots[1]).toMatch(/\.jpg$/);
    expect(readFileSync(shots[0]).equals(PNG)).toBe(true);
    expect(logs(T)).toContain('Người dùng góp ý để làm tiếp (2 ảnh)');

    // chỉ ảnh, không chữ cũng được — nhưng ticket đang lập kế hoạch thì không nhận góp ý mới
    await expect(env.orch.feedback(T, '', [img()])).rejects.toMatchObject({ status: 409 });

    expect((await env.orch.mcpTools(T).propose_plan({ plan: validPlan() })).isError).toBeFalsy();
    env.runs[n].finish({});
    await env.orch.idle();
    expect(env.tickets.getTicket(T)!.status).toBe('awaiting_approval');
    const m = env.runs.length;
    const after = await env.orch.approve(T);
    expect(after).toMatchObject({ status: 'running', branch: before.branch, worktree: before.worktree, maxRounds: before.round + env.cfg.settings.maxRounds });
    expect(existsSync(join(before.worktree!, 'src', 'a.ts'))).toBe(true);
    const approved = env.runs[m].spec.prompt;
    expect(approved).toContain('Kế hoạch sửa đã được duyệt');
    expect(approved).toContain(before.worktree!);
    expect(approved).not.toContain('chưa cài dependency');

    // Dev mới đọc được ảnh góp ý
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'sửa nút', files: ['src/a.ts'] });
    const dev = [...env.runs].reverse().find((r) => r.spec.role === 'dev')!;
    const read = env.orch.guard(dev.spec.agentId, dev.spec.guard.token, { tool_name: 'Read', tool_input: { file_path: shots[0] }, cwd: dev.spec.cwd });
    expect(read).toEqual({ allow: true });

    // Dev có thư mục nháp riêng ngoài worktree: tạo sẵn, đọc/ghi được, được chỉ trong prompt
    const scratch = join(env.cfg.home, 'runs', T, dev.spec.agentId.split(':')[2], 'scratch');
    expect(existsSync(scratch)).toBe(true);
    expect(dev.spec.addDirs).toContain(scratch);
    expect(dev.spec.systemPrompt).toContain(`Thư mục nháp riêng: ${scratch}`);
    const gd = (tool_name: string, file_path: string) => env.orch.guard(dev.spec.agentId, dev.spec.guard.token, { tool_name, tool_input: { file_path }, cwd: dev.spec.cwd });
    expect(gd('Write', join(scratch, 'stills', 'a.png'))).toEqual({ allow: true });
    expect(gd('Read', join(scratch, 'stills', 'a.png'))).toEqual({ allow: true });
  });

  it('worktree đã bị xoá: tạo lại từ nhánh cũ khi duyệt kế hoạch sửa', async () => {
    const T = await toDone();
    const { branch, worktree: wt } = env.tickets.getTicket(T)!;
    await env.orch.removeWorktree(T);
    expect(existsSync(wt!)).toBe(false);
    const n = env.runs.length;
    await env.orch.feedback(T, 'sửa tiếp', []);
    await env.orch.mcpTools(T).propose_plan({ plan: validPlan() });
    runOf(env, ids(T).ctrl)!.finish({});
    await env.orch.idle();
    const m = env.runs.length;
    const t = await env.orch.approve(T);
    expect(n).toBeLessThan(m);
    expect(t).toMatchObject({ status: 'running', branch, worktree: wt });
    expect(g(wt!, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(branch);
    expect(existsSync(join(wt!, 'src', 'a.ts'))).toBe(true);
    expect(env.runs[m].spec.prompt).toContain('chưa cài dependency');
  });
});
