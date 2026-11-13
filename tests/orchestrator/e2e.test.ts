import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_TOOL } from '@/src/guard/policy';
import type { E2eRequest } from '@/src/preview/manager';
import { createFakeRunner } from '../helpers/fakeRunner';
import { cleanup, codexPlan, g, makeEnv, runOf, toRunning, validPlan, type Env } from '../helpers/orchestratorEnv';

let env: Env;
afterEach(() => cleanup(env));

function fakePreview() {
  const e2e: E2eRequest[] = [];
  return {
    e2e,
    preview: {
      capture: async () => ({ text: '{"steps":[]}' }),
      runE2e: async (r: E2eRequest) => { e2e.push(r); return { text: '[e2e] đạt (exit 0)\n1 passed' }; },
      stop: async () => {}, stopAll: async () => {}, killOrphans: async () => {},
      accountsFor: () => [], status: () => null, defaultMode: () => 'dev' as const,
    },
  };
}

const plan = () => {
  const p = validPlan();
  p.roles.designer = { ...p.roles.designer, count: 1 };
  p.roles.explorer = { ...p.roles.explorer, count: 1 };
  p.roles.qc = { ...p.roles.qc, count: 2 };
  return p;
};
/** Ticket đang chạy, worktree có (hoặc không) cấu hình Playwright. */
async function start(withConfig: boolean, preview = fakePreview()) {
  env = makeEnv({ maxParallel: 8, preview: preview.preview });
  const T = await toRunning(env, plan());
  if (withConfig) writeFileSync(join(env.tickets.getTicket(T)!.worktree!, 'playwright.config.ts'), 'export default {};\n');
  return { T, tools: env.orch.mcpTools(T), preview };
}
const has = (id: string) => ({
  cli: runOf(env, id)!.spec.tools.includes(E2E_TOOL),
  mcp: 'run_e2e' in env.orch.workerMcpTools(id),
});

describe('tool run_e2e', () => {
  it('có playwright.config: dev và qc review có run_e2e, gọi preview.runE2e đúng ngữ cảnh', async () => {
    const { T, tools, preview } = await start(true);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts', 'e2e/T-1.spec.ts'] });
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    for (const id of [`acctv:${T}:dev-1`, `acctv:${T}:qc-1`]) expect(has(id)).toEqual({ cli: true, mcp: true });
    const r = await env.orch.workerMcpTools(`acctv:${T}:qc-1`).run_e2e({ file: 'e2e/T-1.spec.ts', grep: 'TC-1' });
    expect(r.text).toContain('đạt');
    const t = env.tickets.getTicket(T)!;
    expect(preview.e2e[0]).toEqual({ ticketId: T, agentId: `acctv:${T}:qc-1`, worktree: t.worktree, projectDir: t.dir, mode: 'dev', file: 'e2e/T-1.spec.ts', grep: 'TC-1' });
  });

  it('không có playwright.config: không ai có run_e2e', async () => {
    const { T, tools } = await start(false);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    for (const id of [`acctv:${T}:dev-1`, `acctv:${T}:qc-1`]) expect(has(id)).toEqual({ cli: false, mcp: false });
  });

  it('QC cases, designer, explorer: không có run_e2e', async () => {
    const { T, tools } = await start(true);
    await tools.spawn_agent({ role: 'qc', task: 'TC', files: [], mode: 'cases' });
    await tools.spawn_agent({ role: 'designer', task: 'So', files: [] });
    await tools.spawn_agent({ role: 'explorer', task: 'Tìm', files: [] });
    for (const id of [`acctv:${T}:qc-1`, `acctv:${T}:designer-1`, `acctv:${T}:explorer-1`]) expect(has(id)).toEqual({ cli: false, mcp: false });
  });

  it('runner codex hoặc không có preview: không có run_e2e', async () => {
    const codex = createFakeRunner();
    env = makeEnv({ runners: { codex: codex.runner }, preview: fakePreview().preview });
    env.cfg.settings.allowedModels.codex = ['gpt-x'];
    const T = await toRunning(env, codexPlan('qc'));
    writeFileSync(join(env.tickets.getTicket(T)!.worktree!, 'playwright.config.ts'), '');
    await env.orch.mcpTools(T).spawn_agent({ role: 'qc', task: 'x', files: [] });
    expect(codex.runs.at(-1)!.spec.tools).not.toContain(E2E_TOOL);
    cleanup(env);
    env = makeEnv({ maxParallel: 5 });
    const T2 = await toRunning(env, plan());
    writeFileSync(join(env.tickets.getTicket(T2)!.worktree!, 'playwright.config.ts'), '');
    await env.orch.mcpTools(T2).spawn_agent({ role: 'qc', task: 'x', files: [] });
    expect(has(`acctv:${T2}:qc-1`)).toEqual({ cli: false, mcp: false });
  });

  it('guard: run_e2e cho dev/qc được phép, designer bị chặn', async () => {
    const { T, tools } = await start(true);
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    await tools.spawn_agent({ role: 'designer', task: 'So', files: [] });
    const qc = runOf(env, `acctv:${T}:qc-1`)!.spec;
    const des = runOf(env, `acctv:${T}:designer-1`)!.spec;
    expect(env.orch.guard(`acctv:${T}:qc-1`, qc.guard.token, { tool_name: E2E_TOOL, tool_input: {}, cwd: qc.cwd })).toEqual({ allow: true });
    expect(env.orch.guard(`acctv:${T}:designer-1`, des.guard.token, { tool_name: E2E_TOOL, tool_input: {}, cwd: des.cwd })).toMatchObject({ allow: false });
  });

  it('duyệt plan khi worktree có playwright.config → lượt Controller và prompt Dev có hướng dẫn e2e', async () => {
    // worktree tạo lúc duyệt: cấu hình phải có sẵn trong repo gốc (commit) để worktree mang theo
    env = makeEnv({ maxParallel: 8, preview: fakePreview().preview });
    writeFileSync(join(env.repo, 'playwright.config.ts'), 'export default {};\n');
    g(env.repo, 'add', '-A');
    g(env.repo, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'e2e');
    const T = await toRunning(env, plan());
    expect(runOf(env, `acctv:${T}:controller`)!.spec.prompt).toContain('e2e/<mã ticket>.spec.ts');
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    expect(runOf(env, `acctv:${T}:dev-1`)!.spec.systemPrompt).toContain('run_e2e');
  });

  it('playwright.config xuất hiện sau khi agent đã chạy: tool CLI và MCP vẫn khớp nhau (đều không có)', async () => {
    const { T, tools } = await start(false);
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    writeFileSync(join(env.tickets.getTicket(T)!.worktree!, 'playwright.config.ts'), '');
    expect(has(`acctv:${T}:qc-1`)).toEqual({ cli: false, mcp: false });
  });

  it('giao Dev khi dự án có e2e mà files thiếu e2e/: kết quả spawn nhắc Controller', async () => {
    const { tools } = await start(true);
    expect((await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] })).text).toContain('e2e/<mã ticket>.spec.ts');
    expect((await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts', 'e2e/T-1.spec.ts'] })).text).not.toContain('e2e/<mã ticket>');
  });

  it('agent đã xong → "Agent không còn chạy"', async () => {
    const { T, tools } = await start(true);
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    const id = `acctv:${T}:qc-1`;
    const run = env.orch.workerMcpTools(id).run_e2e;
    runOf(env, id)!.finish({ text: 'xong' });
    await env.orch.idle();
    expect((await run({ file: 'e2e/T-1.spec.ts' })).text).toMatch(/Agent không còn chạy/);
  });
});
