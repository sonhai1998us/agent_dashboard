import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OrchestratorError } from '@/src/orchestrator/orchestrator';
import { handleMcp } from '@/src/orchestrator/mcp';
import { checkTool } from '@/src/guard/policy';
import { createFakeRunner } from '../helpers/fakeRunner';
import { makeEnv, cleanup, ids, runOf, toRunning, type Env } from '../helpers/orchestratorEnv';

let env: Env;
afterEach(() => cleanup(env));

const runsOf = (e: Env, agentId: string) => e.runs.filter((r) => r.spec.agentId === agentId);
const logs = (e: Env, T: string) => e.tickets.listLog(T).map((l) => l.text);
const LOGIN = { title: 'Đăng nhập twg', message: 'Mở PowerShell, chạy lệnh rồi đăng nhập trên trình duyệt.', url: 'https://id.atlassian.com/login', command: 'twg login --site unitysportcorp79' };

/** Ticket đang chạy, dev-1 đang chạy, Controller đang chờ dev-1. */
async function devRunning(e: Env): Promise<{ T: string; dev1: string; ctrl: string }> {
  const T = await toRunning(e);
  const tools = e.orch.mcpTools(T);
  const { dev1, ctrl } = ids(T);
  await tools.spawn_agent({ role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
  await tools.wait_agents({ ids: [dev1] });
  runOf(e, ctrl)!.finish({});
  await e.orch.idle();
  return { T, dev1, ctrl };
}

describe('request_user_action: agent cần người dùng làm gì đó (đăng nhập…)', () => {
  beforeEach(() => { env = makeEnv({ maxParallel: 1 }); });

  it('worker claude có MCP riêng chỉ với request_user_action', async () => {
    const { dev1 } = await devRunning(env);
    const spec = runOf(env, dev1)!.spec;
    expect(spec.mcp?.url).toBe(`http://127.0.0.1:4777/mcp?agent=${encodeURIComponent(dev1)}`);
    expect(spec.mcp?.token).toBe(spec.guard.token);
    expect(spec.tools).toContain('mcp__acctv__request_user_action');
    expect(spec.allowedTools).toContain('mcp__acctv__request_user_action');
    const list = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, env.orch.workerMcpTools(dev1));
    expect((list.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(['request_user_action']);
  });

  it('ghi yêu cầu lên agent, log ticket, bảo agent kết thúc lượt', async () => {
    const { T, dev1 } = await devRunning(env);
    const r = await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/kết thúc lượt/);
    const ua = env.tickets.getManaged(dev1)!.userAction!;
    expect(ua).toMatchObject({ title: LOGIN.title, message: LOGIN.message, url: LOGIN.url, command: LOGIN.command });
    expect(ua.id).toBeTruthy();
    expect(logs(env, T).some((l) => l.includes('cần bạn') && l.includes('Đăng nhập twg'))).toBe(true);
    expect(env.published.some((e) => e.type === 'managed' && e.managed.agentId === dev1 && e.managed.userAction?.title === LOGIN.title)).toBe(true);
  });

  it('kiểm tra đầu vào: thiếu tiêu đề, link không phải http(s), gửi trùng', async () => {
    const { dev1 } = await devRunning(env);
    const tools = env.orch.workerMcpTools(dev1);
    expect((await tools.request_user_action({ message: 'x' })).isError).toBe(true);
    expect((await tools.request_user_action({ title: 'x', message: 'y', url: 'javascript:alert(1)' })).isError).toBe(true);
    expect((await tools.request_user_action({ title: 'x', message: 'y', url: 'file:///C:/x' })).isError).toBe(true);
    expect((await tools.request_user_action({ title: 'x'.repeat(200), message: 'y' })).isError).toBe(true);
    expect((await tools.request_user_action({ title: 'Đăng nhập', message: 'y' })).isError).toBeFalsy();
    expect((await tools.request_user_action(LOGIN)).isError).toBe(true);
  });

  it('agent thoát sau khi gửi: chờ người dùng (không xong), nhả slot, Controller vẫn chờ', async () => {
    const { T, dev1, ctrl } = await devRunning(env);
    const ctrlRuns = runsOf(env, ctrl).length;
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'Làm b', files: ['src/b.ts'] });
    const { dev2 } = ids(T);
    expect(env.tickets.getManaged(dev2)!.state).toBe('queued');
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    runOf(env, dev1)!.finish({ text: 'chờ đăng nhập' });
    await env.orch.idle();
    expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'waiting', endedAt: null });
    expect(env.store.getAgent(dev1)!.status).toBe('idle');
    expect(env.tickets.getManaged(dev2)!.state).toBe('running');
    expect(runsOf(env, ctrl).length).toBe(ctrlRuns);
    expect(env.tickets.getTicket(T)!.pendingWait).toEqual([dev1]);
  });

  it('người dùng bấm xong: agent chạy tiếp trong cùng phiên với lời nhắn; xong thì Controller được gọi', async () => {
    const { T, dev1, ctrl } = await devRunning(env);
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    const first = runOf(env, dev1)!;
    first.finish({ costUsd: 0.1 });
    await env.orch.idle();
    await env.orch.answerUserAction(dev1, { done: true, note: 'đã đăng nhập bằng tài khoản công ty' });
    await env.orch.idle();
    const again = runOf(env, dev1)!;
    expect(again).not.toBe(first);
    expect(again.spec).toMatchObject({ resume: true, sessionId: first.spec.sessionId });
    expect(again.spec.prompt).toContain('Đăng nhập twg');
    expect(again.spec.prompt).toContain('đã đăng nhập bằng tài khoản công ty');
    expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'running', userAction: null });
    expect(logs(env, T).some((l) => l.includes('Người dùng đã làm') && l.includes('Đăng nhập twg'))).toBe(true);
    again.finish({ text: 'xong', costUsd: 0.2 });
    await env.orch.idle();
    expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'done', costUsd: expect.closeTo(0.3, 5) });
    expect(runOf(env, ctrl)!.spec.prompt.startsWith('Các agent đã xong')).toBe(true);
  });

  it('người dùng không làm được: agent chạy tiếp với lời nhắn hoàn tất và báo phần còn thiếu', async () => {
    const { dev1 } = await devRunning(env);
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    await env.orch.answerUserAction(dev1, { done: false, note: '' });
    await env.orch.idle();
    expect(runOf(env, dev1)!.spec.prompt).toMatch(/không làm được/);
  });

  it('trả lời trước khi agent thoát: thoát xong thì chạy tiếp ngay', async () => {
    const { dev1 } = await devRunning(env);
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    await env.orch.answerUserAction(dev1, { done: true });
    await env.orch.idle();
    expect(runsOf(env, dev1)).toHaveLength(1);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    expect(runsOf(env, dev1)).toHaveLength(2);
    expect(runOf(env, dev1)!.spec.resume).toBe(true);
    expect(env.tickets.getManaged(dev1)!.state).toBe('running');
  });

  it('không có yêu cầu đang chờ → 409; agent lạ → 404', async () => {
    const { dev1 } = await devRunning(env);
    await expect(env.orch.answerUserAction(dev1, { done: true })).rejects.toMatchObject({ status: 409 });
    await expect(env.orch.answerUserAction('acctv:T-9:dev-1', { done: true })).rejects.toBeInstanceOf(OrchestratorError);
    await expect(env.orch.answerUserAction('acctv:T-9:dev-1', { done: true })).rejects.toMatchObject({ status: 404 });
  });

  it('dừng agent đang chờ người dùng: bị dừng, yêu cầu bị huỷ, Controller được gọi', async () => {
    const { dev1, ctrl } = await devRunning(env);
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    await env.orch.stopAgent(dev1, 'người dùng dừng');
    await env.orch.idle();
    expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'stopped', userAction: null });
    expect(runOf(env, ctrl)!.spec.prompt.startsWith('Các agent đã xong')).toBe(true);
  });

  it('huỷ ticket khi agent đang chờ người dùng: agent bị dừng', async () => {
    const { T, dev1 } = await devRunning(env);
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    await env.orch.cancel(T);
    await env.orch.idle();
    expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'stopped', userAction: null });
  });

  it('dashboard khởi động lại khi agent đang chờ người dùng: interrupted, yêu cầu bị huỷ', async () => {
    const { dev1 } = await devRunning(env);
    await env.orch.workerMcpTools(dev1).request_user_action(LOGIN);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    const o2 = env.reopen();
    await o2.recover();
    await o2.idle();
    expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'interrupted', userAction: null });
  });

  it('agent đã kết thúc thì không gửi yêu cầu được nữa', async () => {
    const { dev1 } = await devRunning(env);
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    expect((await env.orch.workerMcpTools(dev1).request_user_action(LOGIN)).isError).toBe(true);
  });
});

describe('guard và token MCP của worker', () => {
  beforeEach(() => { env = makeEnv(); });

  it('worker được gọi request_user_action, không được gọi tool của Controller', async () => {
    const { dev1 } = await devRunning(env);
    const spec = runOf(env, dev1)!.spec;
    const tok = spec.guard.token;
    expect(env.orch.checkWorkerMcpToken(dev1, tok)).toBe(true);
    expect(env.orch.checkWorkerMcpToken(dev1, 'sai')).toBe(false);
    expect(env.orch.guard(dev1, tok, { tool_name: 'mcp__acctv__request_user_action', tool_input: LOGIN })).toEqual({ allow: true });
    expect(env.orch.guard(dev1, tok, { tool_name: 'mcp__acctv__spawn_agent', tool_input: {} })).toMatchObject({ allow: false });
  });

  it('policy: controller không có request_user_action', () => {
    const p = { role: 'controller' as const, root: '/x', readRoots: [], allowedFiles: [], denyBash: [], checkCommands: [] };
    expect(checkTool(p, 'mcp__acctv__request_user_action', {}, '/x').allow).toBe(true); // controller vẫn được mọi tool acctv (MCP của nó không có tool này)
  });

  it('worker codex không có MCP (codex chưa hỗ trợ)', async () => {
    cleanup(env);
    const codex = createFakeRunner();
    env = makeEnv({ runners: { codex: codex.runner } });
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    env.cfg.settings.allowedModels.codex = ['gpt-x'];
    const r = await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'], agent: 'codex', model: 'gpt-x' });
    expect(r.isError).toBeFalsy();
    const run = codex.runs[codex.runs.length - 1];
    expect(run.spec.mcp).toBeNull();
    expect(run.spec.tools).not.toContain('mcp__acctv__request_user_action');
  });
});
