import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, loadConfig } from '@/src/core/config';
import { validatePlan } from '@/src/tickets/flow';
import { checkTool } from '@/src/guard/policy';
import { systemPrompt } from '@/src/orchestrator/prompts';
import { TOOL_DEFS } from '@/src/orchestrator/mcp';
import { makeEnv, cleanup, validPlan, runOf, toRunning, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv({ maxParallel: 3 }); });
afterEach(() => cleanup(env));

const explorerPlan = () => {
  const p = validPlan();
  p.roles.explorer = { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 1 };
  return p;
};

describe('vai explorer', () => {
  it('mặc định là Haiku high; kế hoạch thiếu explorer → count 0', () => {
    expect(DEFAULT_SETTINGS.roleDefaults.explorer).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'high' });
    expect(loadConfig({ ACCTV_HOME: join(env.repo, 'khong-co') }).settings.roleDefaults.explorer.model).toBe('claude-haiku-5-5');
    const p = validPlan() as Record<string, any>;
    delete p.roles.explorer;
    const v = validatePlan(p, env.cfg.settings);
    expect(v.ok && v.plan.roles.explorer).toEqual({ ...DEFAULT_SETTINGS.roleDefaults.explorer, count: 0 });
  });

  it('spawn explorer: chỉ đọc, không tính vòng, model theo kế hoạch', async () => {
    const T = await toRunning(env, explorerPlan());
    const r = await env.orch.mcpTools(T).spawn_agent({ role: 'explorer', task: 'Tìm file trang login', files: [] });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('(explorer, claude-haiku-5-5/high)');
    const id = `acctv:${T}:explorer-1`;
    const run = runOf(env, id)!;
    expect(run.spec.tools).toEqual(['Read', 'Glob', 'Grep', 'mcp__acctv__request_user_action']);
    expect(run.spec.systemPrompt).toMatch(/^ROLE: explorer\n\nBạn là Explorer/);
    expect(env.store.getAgent(id)).toMatchObject({ label: 'Explorer-1', role: 'explorer' });
    // không có vai trong kế hoạch → không giao được
    const T2 = await toRunning(env);
    expect((await env.orch.mcpTools(T2).spawn_agent({ role: 'explorer', task: 'x', files: [] })).text).toMatch(/không có vai explorer/);

    await env.orch.mcpTools(T).wait_agents({ ids: [id] });
    run.finish({ text: 'File cần sửa: src/login.ts' });
    await env.orch.idle();
    expect(env.tickets.getTicket(T)!.round).toBe(0); // chỉ vòng có Dev mới được tính
  });

  it('guard: explorer không sửa file, chỉ chạy lệnh kiểm tra', () => {
    const p = {
      role: 'explorer' as const, root: env.repo, readRoots: [], allowedFiles: ['src/**'],
      denyBash: [], checkCommands: DEFAULT_SETTINGS.checkCommands.map((s) => new RegExp(s, 'i')),
    };
    expect(checkTool(p, 'Read', { file_path: join(env.repo, 'src', 'a.ts') }, env.repo).allow).toBe(true);
    expect(checkTool(p, 'Edit', { file_path: join(env.repo, 'src', 'a.ts') }, env.repo).allow).toBe(false);
    expect(checkTool(p, 'Bash', { command: 'rm x' }, env.repo).allow).toBe(false);
  });

  it('MCP và prompt Controller biết vai explorer', () => {
    const spawn = TOOL_DEFS.find((d) => d.name === 'spawn_agent')!.inputSchema as any;
    expect(spawn.properties.role.enum).toContain('explorer');
    const plan = TOOL_DEFS.find((d) => d.name === 'propose_plan')!.inputSchema as any;
    expect(plan.properties.plan.properties.roles.required).toContain('explorer');
    expect(systemPrompt('controller', { worktree: null, files: [], denyBash: [] })).toMatch(/Explorer/);
  });
});
