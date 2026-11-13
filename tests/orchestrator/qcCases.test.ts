import { describe, it, expect, afterEach } from 'vitest';
import { CAPTURE_TOOL } from '@/src/guard/policy';
import type { DepsResult } from '@/src/orchestrator/installDeps';
import { makeEnv, cleanup, validPlan, runOf, toRunning, type Env } from '../helpers/orchestratorEnv';

let env: Env;
afterEach(() => cleanup(env));

const preview = {
  capture: async () => ({ text: '{"steps":[]}' }),
  runE2e: async () => ({ text: '[e2e] đạt (exit 0)' }),
  stop: async () => {}, stopAll: async () => {}, killOrphans: async () => {},
  accountsFor: () => [], status: () => null, defaultMode: () => 'dev' as const,
};

describe('QC chế độ test case (mode: "cases")', () => {
  it('mode sai: vai khác qc hoặc giá trị lạ → lỗi, không tạo agent', async () => {
    env = makeEnv();
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const before = env.tickets.listManaged(T).length;
    expect((await tools.spawn_agent({ role: 'dev', task: 'x', files: ['src/a.ts'], mode: 'cases' })).isError).toBe(true);
    expect((await tools.spawn_agent({ role: 'qc', task: 'x', files: [], mode: 'abc' })).isError).toBe(true);
    expect(env.tickets.listManaged(T)).toHaveLength(before);
  });

  it('đang cài dependency: QC cases chạy ngay như Explorer, QC thường chờ', async () => {
    let done!: (r: DepsResult) => void;
    const install = () => new Promise<DepsResult>((r) => { done = r; });
    const p = validPlan();
    p.roles.qc = { ...p.roles.qc, count: 2 };
    env = makeEnv({ maxParallel: 5, installDeps: install });
    const T = await toRunning(env, p);
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'qc', task: 'Viết test case', files: [], mode: 'cases' });
    await tools.spawn_agent({ role: 'qc', task: 'Review', files: [] });
    expect(runOf(env, `acctv:${T}:qc-1`)).toBeDefined();
    expect(runOf(env, `acctv:${T}:qc-2`)).toBeUndefined();
    expect(runOf(env, `acctv:${T}:qc-1`)!.spec.prompt).not.toContain('node_modules có thể thiếu');
    done({ ok: true, how: 'install', cmd: 'npm ci', ms: 1, detail: '' });
    await env.orch.idle();
    expect(runOf(env, `acctv:${T}:qc-2`)).toBeDefined();
  });

  it('có preview: QC cases không có capture (tool CLI, MCP worker, prompt); QC thường có', async () => {
    const p = validPlan();
    p.roles.qc = { ...p.roles.qc, count: 2 };
    env = makeEnv({ maxParallel: 5, preview });
    const T = await toRunning(env, p);
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'qc', task: 'Viết test case', files: [], mode: 'cases' });
    await tools.spawn_agent({ role: 'qc', task: 'Review', files: [] });
    const cases = runOf(env, `acctv:${T}:qc-1`)!.spec;
    expect(cases.tools).not.toContain(CAPTURE_TOOL);
    // chỉ đọc: không có Bash để chạy test/build khi node_modules còn đang cài
    expect(cases.tools).not.toContain('Bash');
    expect(cases.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
    expect(env.orch.workerMcpTools(`acctv:${T}:qc-1`).capture).toBeUndefined();
    expect(cases.systemPrompt).not.toMatch(/capture/);
    expect(cases.systemPrompt).toContain('TC-1');
    expect(runOf(env, `acctv:${T}:qc-2`)!.spec.tools).toContain(CAPTURE_TOOL);
  });

  it('qc count 1: QC cases đang chạy chặn QC review; xong thì giao được kèm contextFrom', async () => {
    env = makeEnv({ maxParallel: 5 });
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const qc1 = `acctv:${T}:qc-1`;
    await tools.spawn_agent({ role: 'qc', task: 'Viết test case', files: [], mode: 'cases' });
    const blocked = await tools.spawn_agent({ role: 'qc', task: 'Review', files: [] });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/Đã đủ 1 qc/);
    runOf(env, qc1)!.finish({ text: 'TC-1: đăng nhập đúng mật khẩu → vào trang chủ' });
    await env.orch.idle();
    const ok = await tools.spawn_agent({ role: 'qc', task: 'Review, chạy từng TC', files: [], contextFrom: [qc1] });
    expect(ok.isError).toBeFalsy();
    expect(runOf(env, `acctv:${T}:qc-2`)!.spec.prompt).toContain('TC-1: đăng nhập đúng mật khẩu');
  });

  it('mode rỗng hoặc null = không truyền (QC review thường)', async () => {
    const p = validPlan();
    p.roles.qc = { ...p.roles.qc, count: 2 };
    env = makeEnv({ maxParallel: 5 });
    const T = await toRunning(env, p);
    const tools = env.orch.mcpTools(T);
    expect((await tools.spawn_agent({ role: 'qc', task: 'Review', files: [], mode: '' })).isError).toBeFalsy();
    expect((await tools.spawn_agent({ role: 'dev', task: 'x', files: ['src/a.ts'], mode: null })).isError).toBeFalsy();
    expect(env.tickets.getManaged(`acctv:${T}:qc-1`)!.mode ?? null).toBeNull();
  });

  it('nhãn và mode được lưu; QC thường không có mode', async () => {
    const p = validPlan();
    p.roles.qc = { ...p.roles.qc, count: 2 };
    env = makeEnv({ maxParallel: 5 });
    const T = await toRunning(env, p);
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'qc', task: 'Viết test case', files: [], mode: 'cases' });
    await tools.spawn_agent({ role: 'qc', task: 'Review', files: [] });
    expect(env.store.getAgent(`acctv:${T}:qc-1`)!.label).toBe('QC-1 · test case');
    expect(env.tickets.getManaged(`acctv:${T}:qc-1`)!.mode).toBe('cases');
    expect(env.store.getAgent(`acctv:${T}:qc-2`)!.label).toBe('QC-2');
    expect(env.tickets.getManaged(`acctv:${T}:qc-2`)!.mode ?? null).toBeNull();
  });
});
