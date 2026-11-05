import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '@/src/git/git';
import { createFakeRunner } from '../helpers/fakeRunner';
import { OrchestratorError } from '@/src/orchestrator/orchestrator';
import { makeEnv, cleanup, validPlan, ids, runOf, openWaits, toRunning, g, type Env } from '../helpers/orchestratorEnv';

const CTRL_ALLOWED = [
  'Read', 'Glob', 'Grep', 'mcp__acctv__propose_plan', 'mcp__acctv__spawn_agent', 'mcp__acctv__wait_agents',
  'mcp__acctv__get_agent_log', 'mcp__acctv__finish',
];

let env: Env;
afterEach(() => cleanup(env));

describe('vòng đời ticket', () => {
  beforeEach(() => { env = makeEnv({ maxParallel: 2 }); });

  it('tạo → kế hoạch → duyệt → worker → vòng → finish', async () => {
    const { orch, runs, tickets, store } = env;
    // 1. tạo ticket
    const t0 = await orch.createTicket({ title: 'Trang đăng nhập', description: 'Làm trang login', dir: env.repo });
    const T = t0.id;
    expect(T).toBe('T-1');
    expect(t0.status).toBe('planning');
    expect(t0.maxRounds).toBe(3);
    expect(t0.controllerSessionId).toBe('sid-1');
    const { ctrl, dev1, dev2, qc1 } = ids(T);
    expect(runs).toHaveLength(1);
    expect(runs[0].spec).toMatchObject({ agentId: ctrl, role: 'controller', resume: false, cwd: env.repo, addDirs: [], sessionId: 'sid-1' });
    expect(runs[0].spec.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(runs[0].spec.allowedTools).toEqual(CTRL_ALLOWED);
    expect(runs[0].spec.mcp).not.toBeNull();
    expect(runs[0].spec.mcp!.url).toBe(`http://127.0.0.1:4777/mcp?ticket=${T}`);
    expect(runs[0].spec.systemPrompt.split('\n')[0]).toBe('ROLE: controller');
    expect(runs[0].spec.prompt).toContain('Làm trang login');
    expect(orch.checkMcpToken(T, runs[0].spec.mcp!.token)).toBe(true);
    expect(orch.checkMcpToken(T, 'sai')).toBe(false);
    expect(store.getAgent(ctrl)).toMatchObject({ status: 'running', label: 'Controller', role: 'controller', parentId: null, model: 'claude-opus-5-5', effort: 'xhigh', cwd: env.repo, startedAt: env.clock.t });
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'running', role: 'controller', sessionId: 'sid-1' });

    const tools = orch.mcpTools(T);
    // 2. chưa duyệt thì không spawn
    const early = await tools.spawn_agent({ role: 'dev', task: 'x', files: ['src/a.ts'] });
    expect(early).toEqual({ isError: true, text: 'Kế hoạch chưa được duyệt; chưa được khởi chạy agent' });
    expect(runs).toHaveLength(1);

    // 3. đề xuất kế hoạch
    const pr = await tools.propose_plan({ plan: validPlan() });
    expect(pr.isError).toBeFalsy();
    expect(pr.text).toBe('Đã gửi kế hoạch. Người dùng đang duyệt. Hãy kết thúc lượt ngay bây giờ.');
    expect(tickets.getTicket(T)!.status).toBe('awaiting_approval');
    expect(tickets.listLog(T).map((l) => l.text)).toContain('Controller đề xuất kế hoạch');
    runs[0].finish({ costUsd: 0.5 });
    await orch.idle();
    expect(store.getAgent(ctrl)!.status).toBe('idle');
    expect(tickets.getManaged(ctrl)!.state).toBe('waiting');
    expect(openWaits(env, ctrl)).toEqual([expect.objectContaining({ kind: 'approval', endedAt: null })]);
    expect(runs).toHaveLength(1);

    // 4. duyệt hai lần cùng lúc
    const res = await Promise.allSettled([orch.approve(T), orch.approve(T)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(OrchestratorError);
    expect(rej.reason.status).toBe(409);
    await orch.idle();
    expect(runs).toHaveLength(2);
    const t1 = tickets.getTicket(T)!;
    expect(t1.status).toBe('running');
    expect(t1.branch).toBe('acctv/T-1-trang-dang-nhap');
    expect(t1.baseRef).toMatch(/^[0-9a-f]{40}$/);
    const wt = t1.worktree!;
    expect(existsSync(join(wt, 'src', 'x.ts'))).toBe(true);
    expect(runs[1].spec).toMatchObject({ role: 'controller', resume: true, addDirs: [wt], cwd: env.repo });
    expect(runs[1].spec.prompt.startsWith('Kế hoạch đã được duyệt')).toBe(true);
    expect(runs[1].spec.mcp!.token).not.toBe(runs[0].spec.mcp!.token);
    expect(orch.checkMcpToken(T, runs[0].spec.mcp!.token)).toBe(false);
    expect(openWaits(env, ctrl)).toEqual([]);
    expect(tickets.getManaged(ctrl)!.state).toBe('running');

    // 5. spawn 2 dev + 1 qc, maxParallel = 2
    const d1 = await tools.spawn_agent({ role: 'dev', packageId: 'p1', task: 'Làm a', files: ['src/a.ts'] });
    expect(d1).toEqual({ text: `Đã tạo ${dev1} (dev, claude-sonnet-5-5/high). Dùng wait_agents để chờ.` });
    expect((await tools.spawn_agent({ role: 'dev', packageId: 'p2', task: 'Làm b', files: ['src/b.ts'] })).isError).toBeFalsy();
    expect((await tools.spawn_agent({ role: 'qc', packageId: 'p3', task: 'Review', files: [] })).isError).toBeFalsy();
    expect(runs).toHaveLength(4);
    expect(runOf(env, dev1)!.spec).toMatchObject({
      role: 'dev', cwd: wt, resume: false, addDirs: [], label: 'Dev-1', parentId: ctrl,
      mcp: { url: `http://127.0.0.1:4777/mcp?agent=${encodeURIComponent(dev1)}`, token: expect.any(String) },
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'mcp__acctv__request_user_action'],
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'mcp__acctv__request_user_action'],
    });
    expect(runOf(env, dev1)!.spec.prompt).toContain('src/a.ts');
    expect(runOf(env, dev1)!.spec.systemPrompt.split('\n')[0]).toBe('ROLE: dev');
    expect(runOf(env, dev2)).toBeDefined();
    expect(runOf(env, qc1)).toBeUndefined();
    expect(tickets.getManaged(qc1)).toMatchObject({ state: 'queued', role: 'qc', ordinal: 1, packageId: 'p3' });
    expect(store.getAgent(qc1)).toMatchObject({ status: 'queued', parentId: ctrl, label: 'QC-1', role: 'qc' });
    expect(store.getAgent(dev1)).toMatchObject({ status: 'running', label: 'Dev-1' });
    const w = await tools.wait_agents({ ids: [dev1, dev2, qc1] });
    expect(w.isError).toBeFalsy();
    expect(w.text).toMatch(/^Đang chờ 3 agent/);
    expect(tickets.getTicket(T)!.pendingWait).toEqual([dev1, dev2, qc1]);
    runs[1].finish({ costUsd: 0.25 });
    await orch.idle();
    expect(store.getAgent(ctrl)!.status).toBe('idle');
    expect(openWaits(env, ctrl)).toEqual([expect.objectContaining({ kind: 'agents' })]);
    expect(runs).toHaveLength(4);

    // 6. dev-1 xong → qc-1 chạy; tất cả xong → vòng 1, snapshot, lượt controller mới
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    runOf(env, dev1)!.finish({ text: 'xong a', changedFiles: ['src/a.ts'], costUsd: 0.1 });
    await orch.idle();
    expect(tickets.getManaged(dev1)).toMatchObject({ state: 'done', resultText: 'xong a', changedFiles: ['src/a.ts'], costUsd: 0.1 });
    expect(store.getAgent(dev1)!.status).toBe('ended');
    expect(runs).toHaveLength(5);
    expect(runs[4].spec).toMatchObject({ agentId: qc1, role: 'qc', tools: ['Read', 'Glob', 'Grep', 'Bash', 'mcp__acctv__request_user_action'] });
    expect(tickets.getManaged(qc1)!.state).toBe('running');
    runOf(env, dev2)!.finish({ text: 'xong b', isError: true });
    await orch.idle();
    expect(tickets.getManaged(dev2)!.state).toBe('failed');
    expect(runs).toHaveLength(5);
    expect(tickets.getTicket(T)!.round).toBe(0);
    runOf(env, qc1)!.finish({ text: 'đạt' });
    await orch.idle();
    const t2 = tickets.getTicket(T)!;
    expect(t2.round).toBe(1);
    expect(t2.pendingWait).toBeNull();
    expect(g(env.repo, 'log', '-1', '--format=%s', t2.branch!).trim()).toBe(`acctv: ${T} vòng 1`);
    expect(runs).toHaveLength(6);
    expect(runs[5].spec).toMatchObject({ role: 'controller', resume: true });
    expect(runs[5].spec.prompt.startsWith('Các agent đã xong')).toBe(true);
    expect(runs[5].spec.prompt).toContain('xong a');
    expect(runs[5].spec.prompt).toMatch(/"round":1|vòng 1\/3/);
    expect(openWaits(env, ctrl)).toEqual([]);

    // wait_agents trên agent đã xong: trả báo cáo ngay, không tăng vòng
    const again = await tools.wait_agents({ ids: [dev1] });
    expect(again.isError).toBeFalsy();
    expect(JSON.parse(again.text)).toEqual([expect.objectContaining({ id: dev1, role: 'dev', state: 'done', summary: 'xong a', changedFiles: ['src/a.ts'] })]);
    expect(tickets.getTicket(T)!.round).toBe(1);
    expect(runs).toHaveLength(6);

    // 7. finish
    const f = await tools.finish({ report: 'ok', status: 'done' });
    expect(f).toEqual({ text: 'Đã kết thúc ticket (done). Kết thúc lượt.' });
    const t3 = tickets.getTicket(T)!;
    expect(t3.status).toBe('done');
    expect(t3.report).toBe('ok');
    expect(t3.diffStat).toContain('src/a.ts');
    runs[5].finish({});
    await orch.idle();
    expect(store.getAgent(ctrl)!.status).toBe('ended');
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'done', costUsd: 0.75 });
    expect(runs).toHaveLength(6);
    expect((await tools.finish({ report: 'x', status: 'done' })).isError).toBe(true);

    const types = new Set(env.published.map((e) => e.type));
    for (const k of ['ticket', 'managed', 'wait', 'agent']) expect(types.has(k as never)).toBe(true);
  });

  it('agent event có sessionId được ingest trước khi gọi runner', async () => {
    const T = await toRunning(env);
    const { ctrl, dev1 } = ids(T);
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    for (const id of [ctrl, dev1]) {
      const i = env.order.indexOf(`ingest:${id}`);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(env.order.indexOf(`run:${id}`));
    }
    expect(env.managedAtSpawn).toEqual(env.runs.map(() => true));
  });
});

describe('các trường hợp riêng', () => {
  beforeEach(() => { env = makeEnv(); });

  it('spawn dev trùng file với dev đang chạy → isError', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    expect((await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/**'] })).isError).toBeFalsy();
    const r = await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/a.ts'] });
    expect(r).toEqual({ isError: true, text: `Trùng file với ${ids(T).dev1} đang chạy; hãy chờ nó xong hoặc chia lại file` });
    expect(env.tickets.listManaged(T).filter((m) => m.role === 'dev')).toHaveLength(1);
    // qc không bị kiểm trùng file
    expect((await tools.spawn_agent({ role: 'qc', task: 'c', files: ['src/a.ts'] })).isError).toBeFalsy();
    // dev-1 xong thì giao được
    runOf(env, ids(T).dev1)!.finish({});
    await env.orch.idle();
    expect((await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/a.ts'] })).text).toContain(`acctv:${T}:dev-2`);
  });

  it('spawn: model ngoài danh sách, codex chưa cài, ưu tiên tham số', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const bad = await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'], model: 'gpt-x' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('gpt-x');
    const codex = await tools.spawn_agent({ role: 'qc', task: 'a', files: [], agent: 'codex', model: '' });
    expect(codex).toEqual({ isError: true, text: 'Codex CLI chưa được cài trên máy' });
    const ok = await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'], model: 'claude-haiku-5-5', effort: 'low' });
    expect(ok.text).toContain('(dev, claude-haiku-5-5/low)');
    expect(runOf(env, ids(T).dev1)!.spec).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(env.tickets.listManaged(T)).toHaveLength(2);
  });

  it('worker codex: khi biết thread id thì xoá bản codex:<thread> do watcher ghi sớm', async () => {
    const fake = createFakeRunner();
    env = makeEnv({ maxParallel: 2, runners: { codex: fake.runner } });
    const T = await toRunning(env);
    env.store.applyEvent({ type: 'agent', agent: { id: 'codex:thr-9', source: 'codex', sessionId: 'thr-9' } });
    expect(env.store.getAgent('codex:thr-9')).toBeTruthy();
    env.cfg.settings.allowedModels.codex = ['gpt-x'];
    const r = await env.orch.mcpTools(T).spawn_agent({ role: 'qc', task: 'a', files: [], agent: 'codex', model: 'gpt-x' });
    expect(r.isError).toBeFalsy();
    fake.runs[0].emit([{ type: 'agent', agent: { id: ids(T).qc1, source: 'codex', sessionId: 'thr-9' } }]);
    expect(env.store.getAgent('codex:thr-9')).toBeFalsy();
    expect(env.store.getAgent(ids(T).qc1)).toBeTruthy();
  });

  it('Controller kết thúc 3 lượt liên tiếp mà không gọi tool → escalated', async () => {
    const { orch, runs, tickets } = env;
    const t = await orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    runs[0].finish({});
    await orch.idle();
    expect(runs).toHaveLength(2);
    expect(runs[1].spec.prompt).toContain('finish');
    expect(runs[1].spec.resume).toBe(true);
    runs[1].finish({});
    await orch.idle();
    expect(runs).toHaveLength(3);
    runs[2].finish({});
    await orch.idle();
    expect(runs).toHaveLength(3);
    const e = tickets.getTicket(t.id)!;
    expect(e.status).toBe('escalated');
    expect(e.report).toBe('Controller dừng mà không kết luận');
    expect(env.store.getAgent(ids(t.id).ctrl)!.status).toBe('ended');
  });

  it('propose_plan sai → isError có tên trường, ticket vẫn planning', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const plan = { ...validPlan(), summary: '' } as Record<string, unknown>;
    delete plan.acceptance;
    const r = await env.orch.mcpTools(t.id).propose_plan({ plan });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('summary');
    expect(r.text).toContain('acceptance');
    expect(r.text.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(env.tickets.getTicket(t.id)!.status).toBe('planning');
    expect(env.tickets.getTicket(t.id)!.plan).toBeNull();
  });

  it('propose_plan ngoài planning → isError', async () => {
    const T = await toRunning(env);
    const r = await env.orch.mcpTools(T).propose_plan({ plan: validPlan() });
    expect(r).toEqual({ isError: true, text: 'Chỉ đề xuất kế hoạch khi ticket đang lập kế hoạch' });
  });

  it('createTicket: không phải git, thiếu Claude CLI', async () => {
    const plain = join(env.root, 'plain');
    mkdirSync(plain);
    await expect(env.orch.createTicket({ title: 'x', description: 'y', dir: plain })).rejects.toMatchObject({ status: 400, message: 'Thư mục không phải git repo' });
    cleanup(env);
    env = makeEnv({ runners: { claude: null } });
    await expect(env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo })).rejects.toMatchObject({ status: 400, message: 'Không tìm thấy Claude CLI' });
    expect(env.tickets.listTickets()).toEqual([]);
  });

  it('approve trong lúc lượt đề xuất còn chạy → lượt duyệt xếp hàng, không chạy song song', async () => {
    const { orch, runs } = env;
    const t = await orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await orch.mcpTools(t.id).propose_plan({ plan: validPlan() });
    await orch.approve(t.id);
    await orch.idle();
    expect(runs).toHaveLength(1);
    runs[0].finish({});
    await orch.idle();
    expect(runs).toHaveLength(2);
    expect(runs[1].spec.prompt.startsWith('Kế hoạch đã được duyệt')).toBe(true);
    expect(env.tickets.getManaged(ids(t.id).ctrl)!.state).toBe('running');
  });

  it('approve: 404, plan sửa sai → 400; revise → planning, lượt góp ý', async () => {
    const { orch, runs, tickets } = env;
    await expect(orch.approve('T-99')).rejects.toMatchObject({ status: 404 });
    const t = await orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await expect(orch.revise(t.id, 'thêm test')).rejects.toMatchObject({ status: 409 });
    await orch.mcpTools(t.id).propose_plan({ plan: validPlan() });
    runs[0].finish({});
    await orch.idle();
    await expect(orch.approve(t.id, { ...validPlan(), packages: [] } as never)).rejects.toMatchObject({ status: 400 });
    expect(tickets.getTicket(t.id)!.status).toBe('awaiting_approval');
    const r = await orch.revise(t.id, 'thêm test');
    expect(r.status).toBe('planning');
    expect(r.feedback).toBe('thêm test');
    await orch.idle();
    expect(runs).toHaveLength(2);
    expect(runs[1].spec.prompt.startsWith('Người dùng góp ý')).toBe(true);
    expect(runs[1].spec.prompt).toContain('thêm test');
    expect(openWaits(env, ids(t.id).ctrl)).toEqual([]);
  });

  it('approve với plan đã sửa dùng plan mới', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await env.orch.mcpTools(t.id).propose_plan({ plan: validPlan() });
    env.runs[0].finish({});
    await env.orch.idle();
    const edited = validPlan();
    edited.roles.dev.model = 'claude-haiku-5-5';
    await env.orch.approve(t.id, edited as never);
    await env.orch.idle();
    expect(env.tickets.getTicket(t.id)!.plan!.roles.dev.model).toBe('claude-haiku-5-5');
    await env.orch.mcpTools(t.id).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    expect(runOf(env, ids(t.id).dev1)!.spec.model).toBe('claude-haiku-5-5');
  });

  it('wait_agents: id lạ → isError', async () => {
    const T = await toRunning(env);
    const r = await env.orch.mcpTools(T).wait_agents({ ids: ['acctv:T-9:dev-1'] });
    expect(r.isError).toBe(true);
    expect((await env.orch.mcpTools(T).wait_agents({ ids: [ids(T).ctrl] })).isError).toBe(true);
  });

  it('get_agent_log và báo cáo đếm guard', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { dev1 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    const at = env.clock.t;
    const call = (id: string, name: string, input: string, startedAt: number) => ({
      type: 'call_start' as const,
      call: { id, agentId: dev1, kind: 'tool' as const, name, inputHash: id, inputPreview: input, startedAt, tokensIn: null, tokensOut: null },
    });
    const end = (id: string, ok: boolean, err: string | null) => ({ type: 'call_end' as const, agentId: dev1, callId: id, endedAt: at + 5000, ok, errorPreview: err });
    const scope = '[acctv-guard] ngoài phạm vi: src/b.ts';
    runOf(env, dev1)!.emit([
      call('c1', 'Read', 'src/a.ts', at), end('c1', true, null),
      call('c2', 'Edit', 'src/b.ts', at + 1000), end('c2', false, scope),
      call('c3', 'Edit', 'src/b.ts', at + 2000), end('c3', false, scope),
      call('c4', 'Bash', 'git push', at + 3000), end('c4', false, '[acctv-guard] lệnh bị cấm (git push)'),
      call('c5', 'Bash', 'npm test', at + 4000),
    ]);
    const log = await tools.get_agent_log({ id: dev1 });
    const lines = log.text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d ✓ Read src\/a\.ts$/);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d ✗ Edit src\/b\.ts → \[acctv-guard\] ngoài phạm vi: src\/b\.ts$/);
    expect(lines[4]).toMatch(/^\d\d:\d\d:\d\d … Bash npm test$/);
    expect((await tools.get_agent_log({ id: dev1, limit: 2 })).text.split('\n')).toHaveLength(2);
    expect((await tools.get_agent_log({ id: 'acctv:T-9:dev-1' })).isError).toBe(true);

    runOf(env, dev1)!.finish({ text: 'x'.repeat(5000) });
    await env.orch.idle();
    const [rep] = JSON.parse((await tools.wait_agents({ ids: [dev1] })).text);
    expect(rep).toMatchObject({ calls: 4, errors: 3, guardBlocks: 3, scopeViolations: 2, topError: scope, state: 'done', stopReason: null });
    expect(rep.summary).toHaveLength(4000);
  });

  it('guard: token sai → null; chặn ngoài phạm vi, không có scope', async () => {
    const T = await toRunning(env);
    const { dev1, ctrl } = ids(T);
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    const run = runOf(env, dev1)!;
    const wt = env.tickets.getTicket(T)!.worktree!;
    const tok = run.spec.guard.token;
    expect(env.orch.guard(dev1, 'sai', {})).toBeNull();
    expect(env.orch.guard('acctv:T-9:dev-1', tok, {})).toBeNull();
    expect(env.orch.guard(dev1, tok, { tool_name: 'Edit', tool_input: { file_path: join(wt, 'src', 'a.ts') }, cwd: wt })).toEqual({ allow: true });
    const d = env.orch.guard(dev1, tok, { tool_name: 'Edit', tool_input: { file_path: join(wt, 'src', 'b.ts') }, cwd: wt });
    expect(d).toEqual({ allow: false, reason: expect.stringMatching(/^\[acctv-guard\] ngoài phạm vi:/) });
    expect(env.orch.guard(dev1, tok, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: wt })).toMatchObject({ allow: false });
    // controller: đọc được thư mục dự án và worktree, không chạy Bash
    const ct = runOf(env, ctrl)!.spec.guard.token;
    expect(env.orch.guard(ctrl, ct, { tool_name: 'Read', tool_input: { file_path: join(wt, 'src', 'x.ts') }, cwd: env.repo })).toEqual({ allow: true });
    expect(env.orch.guard(ctrl, ct, { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: env.repo })).toMatchObject({ allow: false });
    // run xong thì token hết hiệu lực
    run.finish({});
    await env.orch.idle();
    expect(env.orch.guard(dev1, tok, { tool_name: 'Read', tool_input: { file_path: join(wt, 'src', 'a.ts') }, cwd: wt })).toBeNull();
  });

  it('lượt Controller kết thúc khi approve còn tạo worktree → không nhắc, chờ rồi chạy lượt duyệt', async () => {
    cleanup(env);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    env = makeEnv({ git: { createWorktree: async (...a: Parameters<typeof git.createWorktree>) => { await gate; return git.createWorktree(...a); } } });
    const { orch, runs } = env;
    const t = await orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const { ctrl } = ids(t.id);
    await orch.mcpTools(t.id).propose_plan({ plan: validPlan() });
    const approving = orch.approve(t.id);
    runs[0].finish({});
    await orch.idle();
    expect(runs).toHaveLength(1);
    expect(env.tickets.getManaged(ctrl)!.state).toBe('waiting');
    expect(openWaits(env, ctrl)).toEqual([expect.objectContaining({ kind: 'approval' })]);
    open();
    await approving;
    await orch.idle();
    expect(runs).toHaveLength(2);
    expect(runs[1].spec.prompt.startsWith('Kế hoạch đã được duyệt')).toBe(true);
    expect(runs[1].spec.addDirs).toEqual([env.tickets.getTicket(t.id)!.worktree]);
    expect(openWaits(env, ctrl)).toEqual([]);
  });

  it('approve: tạo worktree lỗi → 400, quay lại chờ duyệt, wait duyệt vẫn mở, không có lượt mới', async () => {
    cleanup(env);
    env = makeEnv({ git: { createWorktree: async () => { throw new Error('boom'); } } });
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await env.orch.mcpTools(t.id).propose_plan({ plan: validPlan() });
    env.runs[0].finish({});
    await env.orch.idle();
    await expect(env.orch.approve(t.id)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('boom') });
    await env.orch.idle();
    const cur = env.tickets.getTicket(t.id)!;
    expect(cur).toMatchObject({ status: 'awaiting_approval', worktree: null, branch: null });
    expect(cur.plan).toEqual(validPlan());
    expect(openWaits(env, ids(t.id).ctrl)).toEqual([expect.objectContaining({ kind: 'approval' })]);
    expect(env.runs).toHaveLength(1);
  });

  it('ticket đã kết thúc: bỏ message xếp hàng, Controller không chạy lượt mới', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { ctrl, dev1 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.wait_agents({ ids: [dev1] });
    runOf(env, dev1)!.finish({ text: 'xong' });
    await env.orch.idle(); // lượt agentsDone xếp hàng vì lượt duyệt còn chạy
    expect(env.runs).toHaveLength(3);
    await tools.finish({ report: 'ok', status: 'done' });
    runOf(env, ctrl)!.finish({});
    await env.orch.idle();
    expect(env.runs).toHaveLength(3);
    expect(env.store.getAgent(ctrl)!.status).toBe('ended');
  });

  it('worker xếp hàng trước khi ticket rời running thì không bao giờ chạy', async () => {
    cleanup(env);
    env = makeEnv({ maxParallel: 1 });
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { dev1, dev2 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    expect(env.tickets.getManaged(dev2)!.state).toBe('queued');
    // finish/cancel/escalate đều dừng worker trước; ở đây chỉnh thẳng DB để kiểm lớp chặn cuối trong startWorker
    env.tickets.updateTicket(T, { status: 'escalated' });
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    expect(runOf(env, dev2)).toBeUndefined();
    expect(env.tickets.getManaged(dev2)).toMatchObject({ state: 'stopped', stopReason: 'ticket không còn chạy' });
    expect(env.store.getAgent(dev2)!.status).toBe('ended');
  });

  it('lượt đầu không spawn được → lượt sau resume: false; có tiến trình rồi mới resume', async () => {
    env.fake.spawnFailures = 1;
    await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await env.orch.idle();
    expect(env.runs).toHaveLength(2);
    expect(env.runs[0].spec.resume).toBe(false);
    expect(env.runs[1].spec.resume).toBe(false);
    env.runs[1].finish({});
    await env.orch.idle();
    expect(env.runs[2].spec.resume).toBe(true);
  });

  it('file Dev ghi bằng Bash: changedFiles lấy từ git, file ngoài phạm vi được báo cho Controller', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { dev1 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.wait_agents({ ids: [dev1] });
    env.runs[1].finish({});
    await env.orch.idle();
    const wt = env.tickets.getTicket(T)!.worktree!;
    // ghi thẳng ra đĩa, không qua Edit/Write: runner không biết file nào đổi
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(wt, 'src', 'x.ts'), 'export const x = 2;\n');
    writeFileSync(join(wt, 'evil.txt'), 'x');
    runOf(env, dev1)!.finish({ text: 'xong', changedFiles: [] });
    await env.orch.idle();
    expect(env.tickets.getManaged(dev1)!.changedFiles.slice().sort()).toEqual(['evil.txt', 'src/a.ts', 'src/x.ts']);
    expect(env.tickets.listLog(T).map((l) => l.text).some((l) => /ngoài phạm vi/.test(l) && l.includes('evil.txt') && l.includes('src/x.ts') && !l.includes('src/a.ts'))).toBe(true);
    const last = env.runs[env.runs.length - 1];
    expect(last.spec.role).toBe('controller');
    expect(last.spec.prompt).toMatch(/ngoài phạm vi/);
    expect(last.spec.prompt).toContain('evil.txt');
  });

  it('hai Dev song song: file git chia theo phạm vi từng Dev; không có file lạ thì không cảnh báo', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { dev1, dev2 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    await tools.wait_agents({ ids: [dev1, dev2] });
    env.runs[1].finish({});
    await env.orch.idle();
    const wt = env.tickets.getTicket(T)!.worktree!;
    writeFileSync(join(wt, 'src', 'a.ts'), 'a');
    writeFileSync(join(wt, 'src', 'b.ts'), 'b');
    runOf(env, dev1)!.finish({});
    runOf(env, dev2)!.finish({});
    await env.orch.idle();
    expect(env.tickets.getManaged(dev1)!.changedFiles).toEqual(['src/a.ts']);
    expect(env.tickets.getManaged(dev2)!.changedFiles).toEqual(['src/b.ts']);
    expect(env.tickets.listLog(T).map((l) => l.text).some((l) => /ngoài phạm vi/.test(l))).toBe(false);
    expect(env.runs[env.runs.length - 1].spec.prompt).not.toMatch(/ngoài phạm vi/);
  });

  it('wait chỉ có qc: không tăng vòng, không commit snapshot', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { qc1 } = ids(T);
    await tools.spawn_agent({ role: 'qc', task: 'review', files: [] });
    await tools.wait_agents({ ids: [qc1] });
    env.runs[1].finish({});
    await env.orch.idle();
    runOf(env, qc1)!.finish({ text: 'đạt' });
    await env.orch.idle();
    const t = env.tickets.getTicket(T)!;
    expect(t.round).toBe(0);
    expect(t.pendingWait).toBeNull();
    expect(g(env.repo, 'log', '-1', '--format=%s', t.branch!).trim()).toBe('first');
    const last = env.runs[env.runs.length - 1];
    expect(last.spec.prompt.startsWith('Các agent đã xong')).toBe(true);
    expect(last.spec.prompt).toContain('vòng 0/3');
  });

  it('hàng đợi FIFO toàn hệ thống theo maxParallel', async () => {
    cleanup(env);
    env = makeEnv({ maxParallel: 1 });
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { dev1, dev2, qc1 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    await tools.spawn_agent({ role: 'qc', task: 'c', files: [] });
    expect([dev1, dev2, qc1].map((id) => env.tickets.getManaged(id)!.state)).toEqual(['running', 'queued', 'queued']);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    expect([dev1, dev2, qc1].map((id) => env.tickets.getManaged(id)!.state)).toEqual(['done', 'running', 'queued']);
    runOf(env, dev2)!.finish({});
    await env.orch.idle();
    expect(env.tickets.getManaged(qc1)!.state).toBe('running');
  });
});

describe('bản sửa sau review cuối', () => {
  beforeEach(() => { env = makeEnv({ delays: { rateLimitMs: [10, 10, 10] } }); });
  const failingHook = (repo: string) => writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook-chan >&2\nexit 1\n', { mode: 0o755 });

  it('spawn: vai có count 0 trong kế hoạch bị từ chối; đủ số lượng thì phải chờ', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    expect(await tools.spawn_agent({ role: 'designer', task: 'ui', files: [] })).toEqual({ isError: true, text: 'Kế hoạch đã duyệt không có vai designer' });
    expect((await tools.spawn_agent({ role: 'qc', task: 'r', files: [] })).isError).toBeFalsy();
    expect(await tools.spawn_agent({ role: 'qc', task: 'r2', files: [] })).toEqual({ isError: true, text: 'Đã đủ 1 qc theo kế hoạch đã duyệt; hãy chờ wait_agents' });
    expect((await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] })).isError).toBeFalsy();
    expect((await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] })).isError).toBeFalsy();
    expect((await tools.spawn_agent({ role: 'dev', task: 'c', files: ['src/c.ts'] })).text).toBe('Đã đủ 2 dev theo kế hoạch đã duyệt; hãy chờ wait_agents');
    // đã dừng nhưng tiến trình chưa thoát vẫn tính
    env.fake.deferKill = true;
    await env.orch.stopAgent(ids(T).qc1, 'người dùng dừng');
    expect((await tools.spawn_agent({ role: 'qc', task: 'r2', files: [] })).isError).toBe(true);
    runOf(env, ids(T).qc1)!.finish({ killed: true, isError: true });
    await env.orch.idle();
    expect((await tools.spawn_agent({ role: 'qc', task: 'r2', files: [] })).text).toContain(`acctv:${T}:qc-2`);
  });

  it('createTicket: thư mục trong ACCTV_HOME, ~/.claude hoặc ~/.codex → 400', async () => {
    for (const base of [env.cfg.home, env.cfg.claudeDir, env.cfg.codexDir]) {
      const d = join(base, 'repo');
      mkdirSync(d, { recursive: true });
      g(d, 'init', '-q');
      for (const dir of [d, process.platform === 'win32' ? d.toUpperCase() : d]) {
        await expect(env.orch.createTicket({ title: 'x', description: '', dir })).rejects.toMatchObject({
          status: 400, message: 'Không được tạo ticket trong thư mục của dashboard, Claude hoặc Codex',
        });
      }
    }
    expect(env.tickets.listTickets()).toEqual([]);
  });

  it('nhánh acctv/<T>-<slug> đã có (ACCTV_HOME mới) → thêm hậu tố -2', async () => {
    g(env.repo, 'branch', 'acctv/T-1-trang-dang-nhap');
    const T = await toRunning(env);
    expect(env.tickets.getTicket(T)!).toMatchObject({ status: 'running', branch: 'acctv/T-1-trang-dang-nhap-2' });
    expect(g(env.repo, 'branch', '--list', 'acctv/T-1-trang-dang-nhap-2')).toContain('acctv/T-1-trang-dang-nhap-2');
  });

  it('pre-commit hook lỗi: snapshot vòng ghi log lỗi, Controller vẫn được đánh thức', async () => {
    failingHook(env.repo);
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { ctrl, dev1 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.wait_agents({ ids: [dev1] });
    runOf(env, ctrl)!.finish({});
    await env.orch.idle();
    const wt = env.tickets.getTicket(T)!.worktree!;
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    runOf(env, dev1)!.finish({ text: 'xong' });
    await env.orch.idle();
    expect(env.tickets.listLog(T).map((l) => l.text).some((l) => l.startsWith('Snapshot vòng 1 lỗi:'))).toBe(true);
    expect(env.tickets.getTicket(T)!.round).toBe(1);
    expect(runOf(env, ctrl)!.spec.prompt.startsWith('Các agent đã xong')).toBe(true);
    expect(env.tickets.getManaged(ctrl)!.state).toBe('running');
  });

  it('xoá worktree: snapshot lỗi và worktree còn thay đổi → 409, worktree giữ nguyên', async () => {
    const T = await toRunning(env);
    await env.orch.cancel(T);
    await env.orch.idle();
    const wt = env.tickets.getTicket(T)!.worktree!;
    failingHook(env.repo);
    writeFileSync(join(wt, 'src', 'moi.ts'), 'export const m = 1;\n');
    await expect(env.orch.removeWorktree(T)).rejects.toMatchObject({
      status: 409, message: 'Không commit được snapshot; worktree còn thay đổi chưa lưu. Xử lý rồi thử lại, hoặc xoá thủ công.',
    });
    expect(existsSync(join(wt, 'src', 'moi.ts'))).toBe(true);
    expect(env.tickets.getTicket(T)!.worktree).toBe(wt);
    // hết thay đổi → không cần commit, xoá được dù hook vẫn lỗi
    g(wt, 'reset', '-q', '--hard');
    g(wt, 'clean', '-fdq');
    expect((await env.orch.removeWorktree(T)).worktree).toBeNull();
    expect(existsSync(wt)).toBe(false);
  });

  it('codex worker bị giới hạn: thử lại bằng thread id thật của Codex', async () => {
    const fake = createFakeRunner();
    cleanup(env);
    env = makeEnv({ runners: { codex: fake.runner }, delays: { rateLimitMs: [10, 10, 10] } });
    env.cfg.settings.allowedModels.codex = ['gpt-x'];
    const T = await toRunning(env);
    const { qc1 } = ids(T);
    await env.orch.mcpTools(T).spawn_agent({ role: 'qc', task: 'r', files: [], agent: 'codex', model: 'gpt-x' });
    const r0 = fake.runs[0];
    expect(r0.spec.sessionId).toBe('sid-2');
    r0.emit([{ type: 'agent', agent: { id: qc1, source: 'codex', sessionId: 'thr-9' } }]);
    expect(env.tickets.getManaged(qc1)!.sessionId).toBe('thr-9');
    r0.finish({ rateLimited: true, isError: true, sessionId: 'thr-9' });
    await env.orch.idle();
    await vi.waitFor(() => expect(fake.runs).toHaveLength(2));
    expect(fake.runs[1].spec).toMatchObject({ resume: true, sessionId: 'thr-9' });
    // chỉ có RunResult (không có agent event) cũng đủ
    fake.runs[1].finish({ rateLimited: true, isError: true, sessionId: 'thr-10' });
    await env.orch.idle();
    await vi.waitFor(() => expect(fake.runs).toHaveLength(3));
    expect(fake.runs[2].spec.sessionId).toBe('thr-10');
    expect(env.tickets.getManaged(qc1)!.sessionId).toBe('thr-10');
  });
});
