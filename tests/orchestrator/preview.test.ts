import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_TOOL } from '@/src/guard/policy';
import type { CaptureRequest } from '@/src/preview/manager';
import { createFakeRunner } from '../helpers/fakeRunner';
import { cleanup, codexPlan, makeEnv, runOf, toRunning, validPlan, type Env } from '../helpers/orchestratorEnv';

let env: Env;
afterEach(() => cleanup(env));

function fakePreview(defaultMode: 'dev' | 'prod' = 'dev') {
  const calls = { capture: [] as CaptureRequest[], stop: [] as string[], stopAll: 0, killOrphans: 0 };
  return {
    calls,
    preview: {
      capture: async (r: CaptureRequest) => {
        calls.capture.push(r);
        return { text: '{"steps":[]}' };
      },
      stop: async (t: string) => {
        calls.stop.push(t);
      },
      stopAll: async () => {
        calls.stopAll++;
      },
      killOrphans: async () => {
        calls.killOrphans++;
      },
      accountsFor: () => [{ name: 'owner', description: 'Chủ' }],
      status: () => null,
      defaultMode: () => defaultMode,
    },
  };
}

const reviewPlan = (mode?: 'dev' | 'prod') => {
  const p = validPlan() as ReturnType<typeof validPlan> & { preview?: { mode: 'dev' | 'prod' } };
  p.roles.designer = { ...p.roles.designer, count: 1 };
  if (mode) p.preview = { mode };
  return p;
};

describe('capture và Figma trong orchestrator', () => {
  it('designer có capture + ToolSearch + MCP người dùng; qc có capture; dev có capture; không có preview thì không có capture', { timeout: 20000 }, async () => {
    const f = fakePreview();
    env = makeEnv({ maxParallel: 5, preview: f.preview });
    const T = await toRunning(env, reviewPlan());
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'designer', task: 'So Figma', files: [] });
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    const des = runOf(env, `acctv:${T}:designer-1`)!.spec;
    const qc = runOf(env, `acctv:${T}:qc-1`)!.spec;
    const dev = runOf(env, `acctv:${T}:dev-1`)!.spec;
    expect(des.tools).toEqual(expect.arrayContaining(['ToolSearch', CAPTURE_TOOL]));
    expect(des.userMcp).toBe(true);
    expect(qc.tools).toContain(CAPTURE_TOOL);
    expect(qc.userMcp).toBeUndefined();
    expect(dev.tools).toContain(CAPTURE_TOOL);

    const tok = des.guard.token;
    expect(env.orch.guard(`acctv:${T}:designer-1`, tok, { tool_name: 'mcp__claude_ai_Figma__get_design_context', tool_input: {}, cwd: des.cwd })).toEqual({ allow: true, decide: true });
    expect(env.orch.guard(`acctv:${T}:qc-1`, qc.guard.token, { tool_name: 'mcp__claude_ai_Figma__get_design_context', tool_input: {}, cwd: qc.cwd })).toMatchObject({ allow: false });
    expect(env.orch.guard(`acctv:${T}:qc-1`, qc.guard.token, { tool_name: CAPTURE_TOOL, tool_input: {}, cwd: qc.cwd })).toEqual({ allow: true });

    cleanup(env);
    env = makeEnv({ maxParallel: 5 });
    const T2 = await toRunning(env, reviewPlan());
    await env.orch.mcpTools(T2).spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    expect(runOf(env, `acctv:${T2}:qc-1`)!.spec.tools).not.toContain(CAPTURE_TOOL);
    expect(Object.keys(env.orch.workerMcpTools(`acctv:${T2}:qc-1`))).toEqual(['request_user_action']);
  });

  it('worker codex không có capture', async () => {
    const f = fakePreview();
    const codex = createFakeRunner();
    env = makeEnv({ runners: { codex: codex.runner }, preview: f.preview });
    env.cfg.settings.allowedModels.codex = ['gpt-x'];
    const T = await toRunning(env, codexPlan('qc'));
    await env.orch.mcpTools(T).spawn_agent({ role: 'qc', task: 'x', files: [] });
    expect(codex.runs.at(-1)!.spec.tools).not.toContain(CAPTURE_TOOL);
  });

  it('tool capture chuyển đúng ngữ cảnh; mode theo kế hoạch rồi theo dự án; Read được ảnh của mình, không đọc ảnh agent khác', { timeout: 20000 }, async () => {
    const f = fakePreview('prod');
    env = makeEnv({ maxParallel: 5, preview: f.preview });
    const T = await toRunning(env, reviewPlan());
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    await tools.spawn_agent({ role: 'designer', task: 'So', files: [] });
    const qcId = `acctv:${T}:qc-1`;
    const mcp = env.orch.workerMcpTools(qcId);
    expect(Object.keys(mcp).sort()).toEqual(['capture', 'request_user_action']);
    const r = await mcp.capture({ steps: [{ goto: '/' }] });
    expect(r.text).toBe('{"steps":[]}');
    const t = env.tickets.getTicket(T)!;
    const outDir = join(env.cfg.home, 'runs', T, 'qc-1', 'captures');
    expect(f.calls.capture[0]).toEqual({ ticketId: T, agentId: qcId, worktree: t.worktree, projectDir: t.dir, mode: 'prod', outDir, args: { steps: [{ goto: '/' }] } });

    const qc = runOf(env, qcId)!.spec;
    expect(qc.systemPrompt).toContain('`owner`: Chủ');
    expect(qc.systemPrompt).toContain(`acctv-${T}-`);
    expect(qc.systemPrompt).toContain('Chế độ server: prod');
    expect(env.orch.guard(qcId, qc.guard.token, { tool_name: 'Read', tool_input: { file_path: join(outDir, '1-home.png') }, cwd: qc.cwd })).toEqual({ allow: true });
    const other = join(env.cfg.home, 'runs', T, 'designer-1', 'captures', '1-x.png');
    expect(env.orch.guard(qcId, qc.guard.token, { tool_name: 'Read', tool_input: { file_path: other }, cwd: qc.cwd })).toMatchObject({ allow: false });

    cleanup(env);
    const g = fakePreview('prod');
    env = makeEnv({ maxParallel: 5, preview: g.preview });
    const T2 = await toRunning(env, reviewPlan('dev'));
    await env.orch.mcpTools(T2).spawn_agent({ role: 'qc', task: 'Kiểm', files: [] });
    await env.orch.workerMcpTools(`acctv:${T2}:qc-1`).capture({ steps: [{ goto: '/' }] });
    expect(g.calls.capture[0].mode).toBe('dev');
  });

  it('finish, cancel, shutdown và recover dọn server preview', async () => {
    const f = fakePreview();
    env = makeEnv({ maxParallel: 5, preview: f.preview });
    const T = await toRunning(env, reviewPlan());
    const fin = await env.orch.mcpTools(T).finish({ report: 'xong', status: 'done' });
    expect(fin.isError).toBeFalsy();
    expect(f.calls.stop).toContain(T);
    const T2 = await toRunning(env, reviewPlan());
    await env.orch.cancel(T2);
    expect(f.calls.stop).toContain(T2);
    await env.orch.recover();
    await env.orch.recover();
    expect(f.calls.killOrphans).toBe(1);
    await env.orch.shutdown();
    expect(f.calls.stopAll).toBe(1);
  });

  it('next-env.d.ts do server preview sinh ra không bị báo ngoài phạm vi', async () => {
    const f = fakePreview();
    env = makeEnv({ maxParallel: 5, preview: f.preview });
    const T = await toRunning(env, reviewPlan());
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    const dev1 = `acctv:${T}:dev-1`;
    await tools.wait_agents({ ids: [dev1] });
    runOf(env, `acctv:${T}:controller`)!.finish({});
    await env.orch.idle();
    const wt = env.tickets.getTicket(T)!.worktree!;
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(wt, 'next-env.d.ts'), '/// <reference types="next" />\n');
    runOf(env, dev1)!.finish({ text: 'xong' });
    await env.orch.idle();
    const last = env.runs.at(-1)!.spec;
    expect(last.role).toBe('controller');
    expect(last.prompt).not.toContain('next-env.d.ts');
    expect(env.tickets.listLog(T).map((l) => l.text).join('\n')).not.toMatch(/ngoài phạm vi kế hoạch.*next-env/);
  });
});
