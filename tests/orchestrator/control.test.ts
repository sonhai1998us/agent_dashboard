import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Alert } from '@/src/core/model';
import * as git from '@/src/git/git';
import { makeEnv, cleanup, validPlan, ids, runOf, openWaits, toRunning, g, type Env } from '../helpers/orchestratorEnv';

let env: Env;
afterEach(() => cleanup(env));

const loop = (agentId: string, level: Alert['level'] = 'critical', active = true, since = 0): Alert => ({
  id: `${agentId}:loop`, agentId, kind: 'loop', level, message: 'lặp 10× Bash', since, active,
});
const ESCALATED = 'ticket chuyển sang cần người dùng quyết';
const runsOf = (e: Env, agentId: string) => e.runs.filter((r) => r.spec.agentId === agentId);
const logs = (e: Env, T: string) => e.tickets.listLog(T).map((l) => l.text);

describe('điều khiển agent', () => {
  beforeEach(() => { env = makeEnv({ delays: { rateLimitMs: [10, 10, 10] } }); });

  it('dừng một agent: chỉ run của nó bị kill; report có state stopped', async () => {
    const { orch, tickets, store } = env;
    const T = await toRunning(env);
    const tools = orch.mcpTools(T);
    const { ctrl, dev1, dev2, qc1 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'Làm b', files: ['src/b.ts'] });
    await tools.spawn_agent({ role: 'qc', task: 'Review', files: [] });
    expect(env.runs).toHaveLength(5);
    await tools.wait_agents({ ids: [dev1, dev2, qc1] });
    runOf(env, ctrl)!.finish({});
    await orch.idle();

    await orch.stopAgent(dev1, 'người dùng dừng');
    await orch.idle();
    expect(runOf(env, dev1)!.killed).toBe(true);
    expect(runOf(env, dev2)!.killed).toBe(false);
    expect(runOf(env, qc1)!.killed).toBe(false);
    expect(runsOf(env, ctrl).every((r) => !r.killed)).toBe(true);
    expect(tickets.getManaged(dev1)).toMatchObject({ state: 'stopped', stopReason: 'người dùng dừng' });
    expect(tickets.getManaged(dev1)!.endedAt).not.toBeNull();
    expect(store.getAgent(dev1)!.status).toBe('ended');
    expect(tickets.getManaged(dev2)!.state).toBe('running');
    expect(tickets.getManaged(qc1)!.state).toBe('running');
    expect(logs(env, T)).toContain(`Dừng ${dev1}: người dùng dừng`);
    expect(env.runs).toHaveLength(5);

    await expect(orch.stopAgent(dev1, 'x')).rejects.toMatchObject({ status: 409 });
    await expect(orch.stopAgent(ctrl, 'x')).rejects.toMatchObject({ status: 409, message: 'Controller: dùng Huỷ ticket' });
    await expect(orch.stopAgent(`acctv:${T}:dev-9`, 'x')).rejects.toMatchObject({ status: 404 });

    runOf(env, dev2)!.finish({ text: 'xong b' });
    runOf(env, qc1)!.finish({ text: 'đạt' });
    await orch.idle();
    const last = env.runs[env.runs.length - 1];
    expect(last.spec.agentId).toBe(ctrl);
    expect(last.spec.prompt).toContain('"stopReason": "người dùng dừng"');
    const rep = JSON.parse((await tools.wait_agents({ ids: [dev1] })).text);
    expect(rep).toEqual([expect.objectContaining({ id: dev1, state: 'stopped', stopReason: 'người dùng dừng' })]);
  });

  it('dừng agent đang xếp hàng: bỏ khỏi hàng, không bao giờ chạy', async () => {
    cleanup(env);
    env = makeEnv({ maxParallel: 1 });
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    const { dev1, dev2 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    await env.orch.stopAgent(dev2, 'người dùng dừng');
    expect(env.tickets.getManaged(dev2)).toMatchObject({ state: 'stopped', stopReason: 'người dùng dừng' });
    expect(env.store.getAgent(dev2)!.status).toBe('ended');
    runOf(env, dev1)!.finish({});
    await env.orch.idle();
    expect(runOf(env, dev2)).toBeUndefined();
  });

  it('cảnh báo lặp critical → tự dừng worker một lần; warn/không active/phiên ngoài thì bỏ qua', async () => {
    const { orch, tickets } = env;
    const T = await toRunning(env);
    const tools = orch.mcpTools(T);
    const { dev1, dev2 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    orch.onAlert(loop(dev2));
    await orch.idle();
    expect(runOf(env, dev2)!.killed).toBe(true);
    expect(tickets.getManaged(dev2)).toMatchObject({ state: 'stopped', stopReason: 'auto-stop: loop' });
    expect(() => orch.onAlert(loop(dev2))).not.toThrow();
    await orch.idle();
    orch.onAlert(loop(dev1, 'warn'));
    orch.onAlert(loop(dev1, 'critical', false));
    orch.onAlert({ ...loop('claude:abc'), agentId: 'claude:abc' });
    orch.onAlert({ ...loop(dev1), kind: 'error_burst' });
    await orch.idle();
    expect(runOf(env, dev1)!.killed).toBe(false);
    expect(tickets.getManaged(dev1)!.state).toBe('running');
  });

  it('Controller lặp vòng → kill lượt, ticket escalated', async () => {
    const { orch, tickets, store } = env;
    const T = await toRunning(env);
    const { ctrl } = ids(T);
    const n = env.runs.length;
    orch.onAlert(loop(ctrl));
    await orch.idle();
    expect(runOf(env, ctrl)!.killed).toBe(true);
    expect(tickets.getTicket(T)).toMatchObject({ status: 'escalated', report: 'Controller lặp vòng (auto-stop: loop)' });
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'stopped', stopReason: 'auto-stop: loop' });
    expect(store.getAgent(ctrl)!.status).toBe('ended');
    expect(env.runs).toHaveLength(n);
  });

  it('rate limit worker: limited, giữ slot, thử lại với resume; hết 3 lần thử → failed', async () => {
    cleanup(env);
    env = makeEnv({ maxParallel: 1, delays: { rateLimitMs: [10, 10, 10] } });
    const { orch, tickets, store } = env;
    const T = await toRunning(env);
    const tools = orch.mcpTools(T);
    const { ctrl, dev1, dev2 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts', 'src/b.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'c', files: ['src/c.ts'] });
    await tools.wait_agents({ ids: [dev1] });
    runOf(env, ctrl)!.finish({});
    await orch.idle();
    const r0 = runOf(env, dev1)!;
    r0.limited(true);
    expect(tickets.getManaged(dev1)!.state).toBe('limited');
    expect(store.getAgent(dev1)!.status).toBe('limited');
    r0.limited(false);
    expect(tickets.getManaged(dev1)!.state).toBe('running');
    expect(store.getAgent(dev1)!.status).toBe('running');

    r0.finish({ rateLimited: true, isError: true, changedFiles: ['src/a.ts'] });
    await orch.idle();
    expect(tickets.getManaged(dev1)!.state).toBe('limited');
    expect(store.getAgent(dev1)!.status).toBe('limited');
    expect(tickets.getManaged(dev2)!.state).toBe('queued');
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(runsOf(env, dev1)).toHaveLength(i + 1));
      const r = runsOf(env, dev1)[i];
      expect(r.spec).toMatchObject({ resume: true, prompt: 'Tiếp tục công việc đang dở.', sessionId: r0.spec.sessionId, cwd: r0.spec.cwd });
      expect(tickets.getManaged(dev1)!.state).toBe('running');
      expect(tickets.getManaged(dev2)!.state).toBe('queued');
      // mỗi tiến trình chỉ báo file nó sửa; --resume không báo lại file của lần trước
      r.finish({ rateLimited: true, isError: true, changedFiles: i === 1 ? [join(r0.spec.cwd, 'src', 'b.ts')] : [] });
      await orch.idle();
    }
    expect(tickets.getManaged(dev1)).toMatchObject({ state: 'failed', stopReason: 'bị giới hạn: hết lượt thử', changedFiles: ['src/a.ts', 'src/b.ts'] });
    const last = runOf(env, ctrl)!;
    expect(last.spec.prompt.startsWith('Các agent đã xong')).toBe(true);
    expect(last.spec.prompt).toMatch(/"changedFiles": \[\s*"src\/a\.ts",\s*"src\/b\.ts"\s*\]/);
    expect(JSON.parse((await tools.wait_agents({ ids: [dev1] })).text)[0].changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(store.getAgent(dev1)!.status).toBe('ended');
    expect(runsOf(env, dev1)).toHaveLength(4);
    expect(runOf(env, dev2)).toBeDefined();
  });

  describe('đang chờ thử lại sau rate limit (fake timers)', () => {
    let T: string;
    let dev1: string;
    beforeEach(async () => {
      T = await toRunning(env);
      dev1 = ids(T).dev1;
      await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      runOf(env, dev1)!.finish({ rateLimited: true, isError: true, text: 'limit' });
      await env.orch.idle();
      expect(vi.getTimerCount()).toBe(1);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('dừng agent → huỷ hẹn giờ, không thử lại nữa', async () => {
      await env.orch.stopAgent(dev1, 'người dùng dừng');
      await env.orch.idle();
      expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'stopped', stopReason: 'người dùng dừng' });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      await env.orch.idle();
      expect(runsOf(env, dev1)).toHaveLength(1);
    });

    it('ticket không còn running khi tới giờ thử lại → không chạy lại, stopped', async () => {
      env.tickets.updateTicket(T, { status: 'escalated' });
      vi.advanceTimersByTime(10);
      await env.orch.idle();
      expect(runsOf(env, dev1)).toHaveLength(1);
      expect(env.tickets.getManaged(dev1)).toMatchObject({ state: 'stopped', stopReason: 'ticket không còn chạy' });
      expect(env.store.getAgent(dev1)!.status).toBe('ended');
    });
  });

  describe('shutdown (dashboard tắt)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('kill worker + lượt Controller đang chạy, huỷ hẹn giờ thử lại, đánh dấu interrupted, sau đó không ghi gì nữa', async () => {
      const { orch, tickets, store } = env;
      const T = await toRunning(env);
      const { ctrl, dev1, dev2 } = ids(T);
      const tools = orch.mcpTools(T);
      await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
      await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      runOf(env, dev1)!.finish({ rateLimited: true, isError: true, text: 'limit' });
      await orch.idle();
      expect(vi.getTimerCount()).toBe(1);
      expect(tickets.getManaged(dev1)!.state).toBe('limited');
      const ctrlRun = runOf(env, ctrl)!;
      const dev2Run = runOf(env, dev2)!;
      expect(ctrlRun.ended || dev2Run.ended).toBe(false);

      await orch.shutdown();
      expect(ctrlRun.killed).toBe(true);
      expect(dev2Run.killed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      for (const id of [ctrl, dev1, dev2]) {
        expect(tickets.getManaged(id)).toMatchObject({ state: 'interrupted', stopReason: 'bị gián đoạn: dashboard tắt' });
        expect(store.getAgent(id)!.status).toBe('ended');
      }
      expect(tickets.getTicket(T)!.status).toBe('running');

      const published = env.published.length;
      const runs = env.runs.length;
      const calls = store.listCalls(dev2).length;
      dev2Run.emit([{ type: 'call_start', call: { id: 'late', agentId: dev2, kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: 'ls', startedAt: 1, tokensIn: null, tokensOut: null } }]);
      dev2Run.limited(true);
      vi.advanceTimersByTime(600_000);
      orch.onAlert({ id: `${dev2}:loop`, agentId: dev2, kind: 'loop', level: 'critical', message: 'x', since: 9, active: true });
      await orch.idle();
      expect(env.published.length).toBe(published);
      expect(env.runs.length).toBe(runs);
      expect(store.listCalls(dev2).length).toBe(calls);
      await orch.shutdown(); // lần hai: không lỗi
    });
  });

  it('rate limit Controller: thử lại cùng message, không tính là nhắc', async () => {
    const { orch, tickets } = env;
    const T = await toRunning(env);
    const { ctrl } = ids(T);
    const r0 = runOf(env, ctrl)!;
    const n = env.runs.length;
    r0.finish({ rateLimited: true, isError: true });
    await orch.idle();
    expect(tickets.getManaged(ctrl)!.state).toBe('limited');
    expect(env.store.getAgent(ctrl)!.status).toBe('limited');
    await vi.waitFor(() => expect(env.runs).toHaveLength(n + 1));
    const r1 = env.runs[n];
    expect(r1.spec).toMatchObject({ agentId: ctrl, resume: true, prompt: r0.spec.prompt });
    expect(tickets.getManaged(ctrl)!.state).toBe('running');
    // 3 lượt thường không gọi tool: vẫn được nhắc đủ 2 lần rồi mới escalated
    r1.finish({});
    await orch.idle();
    expect(env.runs).toHaveLength(n + 2);
    expect(env.runs[n + 1].spec.prompt).toContain('Bạn vừa kết thúc lượt');
    env.runs[n + 1].finish({});
    await orch.idle();
    expect(env.runs).toHaveLength(n + 3);
    env.runs[n + 2].finish({});
    await orch.idle();
    expect(tickets.getTicket(T)!.status).toBe('escalated');
  });

  it('hết vòng: spawn dev bị từ chối, qc vẫn được', async () => {
    const T = await toRunning(env);
    env.tickets.updateTicket(T, { round: 3 });
    const tools = env.orch.mcpTools(T);
    expect(await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] })).toEqual({
      isError: true, text: 'Đã hết 3 vòng; hãy gọi finish với status "escalated" và nêu lỗi còn lại',
    });
    expect((await tools.spawn_agent({ role: 'qc', task: 'r', files: [] })).isError).toBeFalsy();
  });

  it('finish khi còn worker chạy → isError', async () => {
    const T = await toRunning(env);
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    expect(await tools.finish({ status: 'done', report: 'ok' })).toEqual({ isError: true, text: 'Còn agent đang chạy; hãy wait_agents trước khi finish' });
    expect(env.tickets.getTicket(T)!.status).toBe('running');
    // đã dừng nhưng tiến trình chưa thoát hẳn → vẫn tính là còn chạy
    env.fake.deferKill = true;
    await env.orch.stopAgent(ids(T).dev1, 'người dùng dừng');
    expect(runOf(env, ids(T).dev1)!.killed).toBe(true);
    expect(env.tickets.getManaged(ids(T).dev1)!.state).toBe('stopped');
    expect((await tools.finish({ status: 'done', report: 'ok' })).text).toBe('Còn agent đang chạy; hãy wait_agents trước khi finish');
    runOf(env, ids(T).dev1)!.finish({ exitCode: null, killed: true, isError: true });
    await env.orch.idle();
    expect((await tools.finish({ status: 'done', report: 'ok' })).isError).toBeFalsy();
  });

  it('escalate không qua finish dừng mọi worker còn sống', async () => {
    cleanup(env);
    env = makeEnv({ maxParallel: 1, delays: { rateLimitMs: [10, 10, 10] } });
    const { orch, tickets } = env;
    // 1. Controller tự dừng vì lặp: dev-1 đang chạy, dev-2 xếp hàng
    const T = await toRunning(env);
    const { ctrl, dev1, dev2 } = ids(T);
    await orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    orch.onAlert(loop(ctrl));
    await orch.idle();
    expect(tickets.getTicket(T)!.status).toBe('escalated');
    expect(runOf(env, dev1)!.killed).toBe(true);
    for (const id of [dev1, dev2]) expect(tickets.getManaged(id)).toMatchObject({ state: 'stopped', stopReason: ESCALATED });
    expect(runOf(env, dev2)).toBeUndefined();

    // 2. nhắc hết lượt
    const t2 = await toRunning(env);
    const w2 = ids(t2).dev1;
    await orch.mcpTools(t2).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    for (let i = 0; i < 3; i++) {
      runOf(env, ids(t2).ctrl)!.finish({});
      await orch.idle();
    }
    expect(tickets.getTicket(t2)).toMatchObject({ status: 'escalated', report: 'Controller dừng mà không kết luận' });
    expect(runOf(env, w2)!.killed).toBe(true);
    expect(tickets.getManaged(w2)).toMatchObject({ state: 'stopped', stopReason: ESCALATED });

    // 3. Controller hết lượt thử rate limit
    const t3 = await toRunning(env);
    const w3 = ids(t3).dev1;
    await orch.mcpTools(t3).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    for (let i = 0; i < 4; i++) {
      const n = runsOf(env, ids(t3).ctrl).length;
      runOf(env, ids(t3).ctrl)!.finish({ rateLimited: true, isError: true, text: i < 3 ? '' : "You've hit your session limit · resets 1:30pm" });
      await orch.idle();
      if (i < 3) await vi.waitFor(() => expect(runsOf(env, ids(t3).ctrl)).toHaveLength(n + 1));
    }
    // báo cáo nêu nguyên văn lỗi của CLI để người dùng biết khi nào hạn mức mở lại
    expect(tickets.getTicket(t3)).toMatchObject({ status: 'escalated', report: "Controller bị giới hạn: hết lượt thử. Lỗi cuối: You've hit your session limit · resets 1:30pm" });
    expect(tickets.getManaged(ids(t3).ctrl)).toMatchObject({ state: 'failed', stopReason: 'bị giới hạn: hết lượt thử' });
    expect(runOf(env, w3)!.killed).toBe(true);
    expect(tickets.getManaged(w3)).toMatchObject({ state: 'stopped', stopReason: ESCALATED });
  });

  it('escalated → continueTicket → running, maxRounds + 1, lượt mới có chỉ đạo', async () => {
    const { orch, tickets } = env;
    const T = await toRunning(env);
    const { ctrl } = ids(T);
    expect((await orch.mcpTools(T).finish({ status: 'escalated', report: 'kẹt' })).isError).toBeFalsy();
    runOf(env, ctrl)!.finish({});
    await orch.idle();
    await expect(orch.removeWorktree('T-99')).rejects.toMatchObject({ status: 404 });
    const n = env.runs.length;
    const t = await orch.continueTicket(T, 'thử cách khác');
    expect(t).toMatchObject({ status: 'running', maxRounds: 4 });
    await orch.idle();
    expect(env.runs).toHaveLength(n + 1);
    expect(env.runs[n].spec).toMatchObject({ agentId: ctrl, resume: true });
    expect(env.runs[n].spec.prompt).toContain('thử cách khác');
    expect(env.runs[n].spec.prompt).toContain('4 vòng');
    expect(tickets.getManaged(ctrl)!.state).toBe('running');
    await expect(orch.continueTicket(T, 'nữa')).rejects.toMatchObject({ status: 409 });
  });

  it('Controller tự dừng → tiếp tục → vòng lặp mới (since mới) bị tự dừng lại; alert cũ gửi lại bị bỏ qua', async () => {
    const { orch, tickets } = env;
    const T = await toRunning(env);
    const { ctrl } = ids(T);
    orch.onAlert(loop(ctrl, 'critical', true, 100));
    await orch.idle();
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'stopped', stopReason: 'auto-stop: loop' });
    await orch.continueTicket(T, 'thử lại');
    const r = runOf(env, ctrl)!;
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'running', stopReason: null });
    orch.onAlert(loop(ctrl, 'critical', true, 100));
    await orch.idle();
    expect(r.killed).toBe(false);
    expect(tickets.getTicket(T)!.status).toBe('running');
    orch.onAlert(loop(ctrl, 'critical', true, 200));
    await orch.idle();
    expect(r.killed).toBe(true);
    expect(tickets.getTicket(T)).toMatchObject({ status: 'escalated', report: 'Controller lặp vòng (auto-stop: loop)' });
  });

  it('escalated khi chưa duyệt kế hoạch → continueTicket quay về planning', async () => {
    const { orch, tickets } = env;
    const t0 = await orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    for (let i = 0; i < 3; i++) {
      env.runs[env.runs.length - 1].finish({});
      await orch.idle();
    }
    expect(tickets.getTicket(t0.id)!.status).toBe('escalated');
    const n = env.runs.length;
    const t = await orch.continueTicket(t0.id, 'đọc kỹ hơn');
    expect(t).toMatchObject({ status: 'planning', maxRounds: 4, worktree: null });
    expect(env.runs).toHaveLength(n + 1);
    expect(env.runs[n].spec.prompt).toContain('đọc kỹ hơn');
    expect((await orch.mcpTools(t0.id).propose_plan({ plan: validPlan() })).isError).toBeFalsy();
  });

  it('huỷ ticket: dừng mọi agent và lượt Controller, giữ worktree; xoá worktree sau đó', async () => {
    const { orch, tickets } = env;
    const T = await toRunning(env);
    const tools = orch.mcpTools(T);
    const { ctrl, dev1, dev2 } = ids(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.spawn_agent({ role: 'dev', task: 'b', files: ['src/b.ts'] });
    const wt = tickets.getTicket(T)!.worktree!;
    await expect(orch.removeWorktree(T)).rejects.toMatchObject({ status: 409 });
    const n = env.runs.length;
    const t = await orch.cancel(T);
    await orch.idle();
    expect(t.status).toBe('cancelled');
    for (const id of [dev1, dev2]) {
      expect(runOf(env, id)!.killed).toBe(true);
      expect(tickets.getManaged(id)).toMatchObject({ state: 'stopped', stopReason: 'ticket bị huỷ' });
    }
    expect(runOf(env, ctrl)!.killed).toBe(true);
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'stopped', stopReason: 'ticket bị huỷ' });
    expect(env.store.getAgent(ctrl)!.status).toBe('ended');
    expect(env.runs).toHaveLength(n);
    expect(tickets.getTicket(T)!.worktree).toBe(wt);
    expect(existsSync(wt)).toBe(true);
    await expect(orch.cancel(T)).rejects.toMatchObject({ status: 409 });

    // xoá worktree: file chưa commit được snapshot trên nhánh trước khi xoá
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'moi.ts'), 'export const m = 1;\n');
    const branch = tickets.getTicket(T)!.branch!;
    const after = await orch.removeWorktree(T);
    expect(after.worktree).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(g(env.repo, 'log', '-1', '--format=%s', branch).trim()).toBe(`acctv: ${T} trước khi xoá worktree`);
    expect(g(env.repo, 'show', `${branch}:src/moi.ts`)).toContain('export const m');
    expect(logs(env, T).some((l) => l.includes('Đã xoá worktree'))).toBe(true);
    await expect(orch.removeWorktree(T)).rejects.toMatchObject({ status: 409 });
  });

  it('merge nhánh ticket vào nhánh của người dùng: snapshot trước, ghi kết quả; xung đột để người dùng xử lý', async () => {
    const { orch, tickets } = env;
    g(env.repo, 'config', 'user.name', 'Người dùng');
    g(env.repo, 'config', 'user.email', 'me@localhost');
    const main = g(env.repo, 'symbolic-ref', '--short', 'HEAD').trim();
    await expect(orch.mergeTicket('T-99', main)).rejects.toMatchObject({ status: 404 });
    const T = await toRunning(env);
    await expect(orch.mergeTicket(T, main)).rejects.toMatchObject({ status: 409 });
    await orch.cancel(T);
    await orch.idle();
    const { branch, worktree: wt } = tickets.getTicket(T)!;

    const targets = await orch.mergeTargets(T);
    expect(targets).toEqual({ branches: [branch!, main].sort(), current: main, defaultTarget: main });

    // phần dang dở trong worktree cũng được đưa vào
    writeFileSync(join(wt!, 'src', 'moi.ts'), 'export const m = 1;\n');
    const t1 = await orch.mergeTicket(T, main);
    expect(g(env.repo, 'log', '-1', '--format=%s', branch!).trim()).toBe(`acctv: ${T} trước khi merge vào ${main}`);
    expect(t1.merge).toMatchObject({ target: main, result: 'merged', fastForward: true, upToDate: false, head: g(env.repo, 'rev-parse', branch!).trim() });
    expect(existsSync(join(env.repo, 'src', 'moi.ts'))).toBe(true);
    expect(logs(env, T).some((l) => l.startsWith(`Đã merge ${branch} vào ${main}`))).toBe(true);
    expect(t1.status).toBe('cancelled');

    // cả hai bên sửa cùng file → xung đột nằm lại trong thư mục dự án
    writeFileSync(join(env.repo, 'src', 'x.ts'), 'export const x = 2;\n');
    g(env.repo, 'commit', '-qam', 'main sửa x');
    writeFileSync(join(wt!, 'src', 'x.ts'), 'export const x = 3;\n');
    const t2 = await orch.mergeTicket(T, main);
    expect(t2.merge).toMatchObject({ target: main, result: 'conflict', conflicts: ['src/x.ts'] });
    expect(g(env.repo, 'status', '--porcelain')).toContain('UU src/x.ts');
    expect(logs(env, T).some((l) => l.includes('xung đột') && l.includes('src/x.ts'))).toBe(true);

    // git từ chối → 400, giữ kết quả lần trước
    await expect(orch.mergeTicket(T, main)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('merge dở dang') });
    await expect(orch.mergeTicket(T, 'khong-co')).rejects.toMatchObject({ status: 400 });
    expect(tickets.getTicket(T)!.merge!.result).toBe('conflict');
  });

  it('merge: ticket chưa có nhánh → 409', async () => {
    const t0 = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await env.orch.cancel(t0.id);
    await expect(env.orch.mergeTicket(t0.id, 'main')).rejects.toMatchObject({ status: 409 });
    await expect(env.orch.mergeTargets(t0.id)).rejects.toMatchObject({ status: 409 });
  });

  it('huỷ khi Controller đang chờ: Controller stopped, đóng lượt chờ', async () => {
    const { orch, tickets } = env;
    const t0 = await orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await orch.mcpTools(t0.id).propose_plan({ plan: validPlan() });
    env.runs[0].finish({});
    await orch.idle();
    const { ctrl } = ids(t0.id);
    expect(tickets.getManaged(ctrl)!.state).toBe('waiting');
    await orch.cancel(t0.id);
    expect(tickets.getManaged(ctrl)).toMatchObject({ state: 'stopped', stopReason: 'ticket bị huỷ' });
    expect(openWaits(env, ctrl).every((w) => w.endedAt !== null)).toBe(true);
    expect(env.store.getAgent(ctrl)!.status).toBe('ended');
  });
});

describe('huỷ trong lúc duyệt đang tạo worktree', () => {
  const setup = async (createWorktree: typeof git.createWorktree) => {
    env = makeEnv({ git: { createWorktree } });
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    await env.orch.mcpTools(t.id).propose_plan({ plan: validPlan() });
    env.runs[0].finish({});
    await env.orch.idle();
    return t.id;
  };

  it('tạo worktree xong sau khi huỷ → không có lượt approved, ticket vẫn cancelled, worktree được ghi lại', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const T = await setup(async (...a) => { await gate; return git.createWorktree(...a); });
    const approving = env.orch.approve(T);
    await env.orch.cancel(T);
    open();
    await approving.catch(() => {});
    await env.orch.idle();
    expect(env.runs).toHaveLength(1);
    const t = env.tickets.getTicket(T)!;
    expect(t.status).toBe('cancelled');
    expect(t.worktree).not.toBeNull();
    expect(existsSync(t.worktree!)).toBe(true);
  });

  it('tạo worktree lỗi sau khi huỷ → ticket vẫn cancelled', async () => {
    let fail!: (e: Error) => void;
    const gate = new Promise<never>((_, rej) => { fail = rej; });
    gate.catch(() => {}); // có thể bị reject trước khi approve (còn chờ uniqueBranch) gọi tới createWorktree
    const T = await setup(async () => gate);
    const approving = env.orch.approve(T);
    await env.orch.cancel(T);
    fail(new Error('boom'));
    await approving.catch(() => {});
    await env.orch.idle();
    expect(env.tickets.getTicket(T)!.status).toBe('cancelled');
    expect(env.runs).toHaveLength(1);
  });
});

describe('recover sau khi dashboard khởi động lại', () => {
  beforeEach(() => { env = makeEnv(); });

  it('agent đang chạy → interrupted; ticket chờ agent được gọi lại; awaiting_approval giữ nguyên', async () => {
    const { tickets, store } = env;
    const T = await toRunning(env);
    const { ctrl, dev1 } = ids(T);
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.wait_agents({ ids: [dev1] });
    runOf(env, ctrl)!.finish({});
    await env.orch.idle();
    expect(tickets.getManaged(ctrl)!.state).toBe('waiting');

    const t2 = await env.orch.createTicket({ title: 'Hai', description: 'b', dir: env.repo });
    await env.orch.mcpTools(t2.id).propose_plan({ plan: validPlan() });
    runOf(env, ids(t2.id).ctrl)!.finish({});
    await env.orch.idle();
    expect(tickets.getTicket(t2.id)!.status).toBe('awaiting_approval');

    const orch2 = env.reopen();
    const n = env.runs.length;
    await orch2.recover();
    await orch2.idle();
    expect(tickets.getManaged(dev1)).toMatchObject({ state: 'interrupted', stopReason: 'bị gián đoạn: dashboard khởi động lại' });
    expect(store.getAgent(dev1)!.status).toBe('ended');
    expect(env.runs).toHaveLength(n + 1);
    const r = env.runs[n];
    expect(r.spec).toMatchObject({ agentId: ctrl, resume: true });
    expect(r.spec.prompt.startsWith('Các agent đã xong')).toBe(true);
    expect(r.spec.prompt).toContain('"state": "interrupted"');
    expect(tickets.getTicket(T)!.pendingWait).toBeNull();
    expect(tickets.getTicket(t2.id)!.status).toBe('awaiting_approval');
    expect(tickets.getManaged(ids(t2.id).ctrl)!.state).toBe('waiting');

    await orch2.recover();
    await orch2.idle();
    expect(env.runs).toHaveLength(n + 1);
  });

  it('dừng giữa lúc duyệt (running, chưa có worktree) → quay lại awaiting_approval, mở lại lượt chờ duyệt', async () => {
    cleanup(env);
    env = makeEnv({ git: { createWorktree: () => new Promise<never>(() => {}) } });
    const t0 = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const T = t0.id;
    const { ctrl } = ids(T);
    await env.orch.mcpTools(T).propose_plan({ plan: validPlan() });
    env.runs[0].finish({});
    await env.orch.idle();
    void env.orch.approve(T);
    expect(env.tickets.getTicket(T)).toMatchObject({ status: 'running', worktree: null });
    const orch2 = env.reopen();
    const n = env.runs.length;
    await orch2.recover();
    await orch2.idle();
    expect(env.tickets.getTicket(T)!.status).toBe('awaiting_approval');
    expect(env.tickets.getTicket(T)!.plan).not.toBeNull();
    expect(env.tickets.getManaged(ctrl)!.state).toBe('waiting');
    expect(openWaits(env, ctrl).filter((w) => w.endedAt === null)).toEqual([expect.objectContaining({ kind: 'approval' })]);
    expect(env.runs).toHaveLength(n);
  });

  it('Controller đang chạy (running hoặc planning) → interrupted rồi lượt restarted', async () => {
    const { tickets } = env;
    const T = await toRunning(env);
    const t2 = await env.orch.createTicket({ title: 'Hai', description: 'b', dir: env.repo });
    const orch2 = env.reopen();
    const n = env.runs.length;
    await orch2.recover();
    await orch2.idle();
    const fresh = env.runs.slice(n);
    expect(fresh.map((r) => r.spec.agentId).sort()).toEqual([ids(T).ctrl, ids(t2.id).ctrl].sort());
    for (const r of fresh) {
      expect(r.spec.prompt.startsWith('Dashboard vừa khởi động lại')).toBe(true);
      expect(r.spec.resume).toBe(true);
    }
    expect(tickets.getManaged(ids(T).ctrl)!.state).toBe('running');
    expect(env.tickets.listLog(T).some((l) => l.text.includes('khởi động lại'))).toBe(true);
  });

  it('Controller waiting mà không còn pendingWait (dừng giữa lúc đánh thức) → lượt restarted', async () => {
    const T = await toRunning(env);
    const { ctrl, dev1 } = ids(T);
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    await tools.wait_agents({ ids: [dev1] });
    runOf(env, ctrl)!.finish({});
    await env.orch.idle();
    expect(env.tickets.getManaged(ctrl)!.state).toBe('waiting');
    // checkWait đã xoá pendingWait rồi dashboard tắt trước khi lượt agentsDone kịp chạy
    env.tickets.updateTicket(T, { pendingWait: null, round: 1 });
    const orch2 = env.reopen();
    const n = env.runs.length;
    await orch2.recover();
    await orch2.idle();
    expect(env.runs).toHaveLength(n + 1);
    expect(env.runs[n].spec).toMatchObject({ agentId: ctrl, resume: true });
    expect(env.runs[n].spec.prompt.startsWith('Dashboard vừa khởi động lại')).toBe(true);
    expect(env.tickets.getManaged(ctrl)!.state).toBe('running');
  });
});
