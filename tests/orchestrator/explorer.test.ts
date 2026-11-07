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
    expect(run.spec.tools).toEqual(['Read', 'Glob', 'Grep', 'ToolSearch', 'mcp__acctv__request_user_action']);
    expect(run.spec.userMcp).toBe(true);
    expect(run.spec.inheritUser).toBeUndefined();
    // tool đọc của MCP người dùng: guard cho phép tường minh; tool ghi bị chặn
    const tok = run.spec.guard.token;
    expect(env.orch.guard(id, tok, { tool_name: 'mcp__claude_ai_Figma__get_design_context', tool_input: {}, cwd: run.spec.cwd })).toEqual({ allow: true, decide: true });
    expect(env.orch.guard(id, tok, { tool_name: 'mcp__claude_ai_Figma__use_figma', tool_input: {}, cwd: run.spec.cwd })).toMatchObject({ allow: false });
    expect(env.orch.guard(id, tok, { tool_name: 'Read', tool_input: { file_path: join(run.spec.cwd, 'src', 'a.ts') }, cwd: run.spec.cwd })).toEqual({ allow: true });
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

  it('settings.readRoots: worker được đọc thêm thư mục ngoài worktree, không được ghi', async () => {
    const extra = join(env.repo, '..', 'preview_frame');
    env.cfg.settings.readRoots = [extra];
    const T = await toRunning(env, explorerPlan());
    await env.orch.mcpTools(T).spawn_agent({ role: 'explorer', task: 'Xem ảnh preview', files: [] });
    const id = `acctv:${T}:explorer-1`;
    const run = runOf(env, id)!;
    const g = (tool_name: string, tool_input: unknown) => env.orch.guard(id, run.spec.guard.token, { tool_name, tool_input, cwd: run.spec.cwd });
    expect(g('Read', { file_path: join(extra, 'ui-preview-login.png') })).toEqual({ allow: true });
    expect(g('Grep', { pattern: 'x', path: extra })).toEqual({ allow: true });
    expect(g('Read', { file_path: join(env.repo, '..', 'khac', 'a.png') })).toMatchObject({ allow: false });
    expect(g('Edit', { file_path: join(extra, 'a.ts') })).toMatchObject({ allow: false });
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

describe('guard: tool MCP của người dùng cho Explorer', () => {
  const p = () => ({ role: 'explorer' as const, root: 'R', readRoots: [], allowedFiles: [], denyBash: [], checkCommands: [] });
  it('chỉ tool đọc, không tool ghi/commit, không MCP của dashboard', () => {
    for (const t of ['mcp__claude_ai_Figma__get_design_context', 'mcp__claude_ai_Figma__get_metadata', 'mcp__claude_ai_Figma__get_screenshot', 'mcp__claude_ai_Figma__whoami', 'mcp__claude_ai_Figma__search_design_system', 'mcp__claude_ai_Figma__create_session', 'mcp__jira__list_issues']) {
      expect(checkTool(p(), t, {}, 'R')).toEqual({ allow: true, explicit: true });
    }
    for (const t of ['mcp__claude_ai_Figma__use_figma', 'mcp__claude_ai_Figma__upload_assets', 'mcp__claude_ai_Figma__download_assets', 'mcp__claude_ai_Figma__send_code_to_figma', 'mcp__github__push_files', 'mcp__acctv__spawn_agent', 'WebFetch']) {
      expect(checkTool(p(), t, {}, 'R').allow).toBe(false);
    }
    expect(checkTool(p(), 'ToolSearch', { query: 'figma' }, 'R')).toEqual({ allow: true, explicit: true });
    // vai khác không được
    expect(checkTool({ ...p(), role: 'dev' }, 'mcp__claude_ai_Figma__get_metadata', {}, 'R').allow).toBe(false);
    expect(checkTool({ ...p(), role: 'qc' }, 'ToolSearch', {}, 'R').allow).toBe(false);
  });
});
