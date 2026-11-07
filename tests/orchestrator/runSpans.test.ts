import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeEnv, cleanup, ids, runOf, toRunning, openSpans, allSpans, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => cleanup(env));

const kinds = (env: Env, id: string) => allSpans(env, id).map((w) => w.kind);

describe('khoảng khởi động của lượt chạy', () => {
  it('mở lúc spawn, đóng ở dòng đầu tiên tiến trình gửi về', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const { ctrl } = ids(t.id);
    const start = env.clock.t;
    expect(openSpans(env, ctrl)).toEqual([expect.objectContaining({ kind: 'startup', startedAt: start, endedAt: null })]);
    env.clock.t += 7000;
    runOf(env, ctrl)!.emit([{ type: 'activity', agentId: ctrl, at: env.clock.t }]);
    expect(openSpans(env, ctrl)).toEqual([]);
    expect(allSpans(env, ctrl)).toEqual([expect.objectContaining({ kind: 'startup', startedAt: start, endedAt: start + 7000 })]);
    // dòng sau không mở/đóng thêm gì
    runOf(env, ctrl)!.emit([{ type: 'activity', agentId: ctrl, at: env.clock.t + 1 }]);
    expect(kinds(env, ctrl)).toEqual(['startup']);
    expect(env.published.some((e) => e.type === 'wait' && e.wait.kind === 'startup' && e.wait.endedAt !== null)).toBe(true);
  });

  it('tiến trình kết thúc mà chưa gửi gì: khoảng khởi động đóng lúc kết thúc', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const { ctrl } = ids(t.id);
    env.clock.t += 3000;
    runOf(env, ctrl)!.finish({ isError: true, text: 'boom' });
    await env.orch.idle();
    const s = allSpans(env, ctrl).find((w) => w.kind === 'startup')!;
    expect(s.endedAt).not.toBeNull();
    expect(openSpans(env, ctrl).filter((w) => w.kind === 'startup').length).toBeLessThanOrEqual(1); // lượt thử lại có thể mở khoảng mới
  });

  it('worker cũng có khoảng khởi động', async () => {
    const T = await toRunning(env);
    const { dev1 } = ids(T);
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    expect(openSpans(env, dev1)).toEqual([expect.objectContaining({ kind: 'startup' })]);
    runOf(env, dev1)!.emit([{ type: 'activity', agentId: dev1, at: env.clock.t }]);
    expect(openSpans(env, dev1)).toEqual([]);
  });
});

describe('khoảng gián đoạn khi dashboard khởi động lại', () => {
  it('tắt rồi bật: từ event cuối của lượt đang chạy tới lúc dashboard chạy lại', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const { ctrl } = ids(t.id);
    env.clock.t += 2000;
    runOf(env, ctrl)!.emit([{ type: 'activity', agentId: ctrl, at: env.clock.t }]);
    const last = env.clock.t;
    env.clock.t += 28_000;
    await env.orch.shutdown();
    expect(openSpans(env, ctrl)).toEqual([expect.objectContaining({ kind: 'interrupted', startedAt: last, endedAt: null })]);

    env.clock.t += 60_000;
    const back = env.clock.t;
    const orch2 = env.reopen();
    await orch2.recover();
    await orch2.idle();
    const gap = allSpans(env, ctrl).find((w) => w.kind === 'interrupted')!;
    expect(gap).toMatchObject({ startedAt: last, endedAt: back });
    // lượt gọi lại có khoảng khởi động mới, mở từ lúc dashboard chạy lại
    expect(openSpans(env, ctrl)).toEqual([expect.objectContaining({ kind: 'startup', startedAt: back })]);
  });

  it('tắt khi đang khởi động: khoảng khởi động đóng lúc tắt', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const { ctrl } = ids(t.id);
    env.clock.t += 4000;
    await env.orch.shutdown();
    expect(allSpans(env, ctrl).find((w) => w.kind === 'startup')).toMatchObject({ endedAt: env.clock.t });
  });

  it('dashboard chết đột ngột (không qua shutdown): gián đoạn từ event cuối tới lúc recover', async () => {
    const T = await toRunning(env);
    const { dev1 } = ids(T);
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    env.clock.t += 1000;
    runOf(env, dev1)!.emit([{ type: 'activity', agentId: dev1, at: env.clock.t }]);
    const last = env.clock.t;
    env.clock.t += 90_000;
    const orch2 = env.reopen();
    await orch2.recover();
    await orch2.idle();
    expect(allSpans(env, dev1).find((w) => w.kind === 'interrupted')).toMatchObject({ startedAt: last, endedAt: env.clock.t });
    expect(openSpans(env, dev1)).toEqual([]);
  });

  it('tool call đang chạy lúc bị ngắt được đóng (lỗi, kèm lý do) thay vì mở mãi', async () => {
    const t = await env.orch.createTicket({ title: 'x', description: 'y', dir: env.repo });
    const { ctrl } = ids(t.id);
    runOf(env, ctrl)!.emit([{ type: 'call_start', call: { id: 'b1', agentId: ctrl, kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: 'npm run build', startedAt: env.clock.t, tokensIn: null, tokensOut: null } }]);
    env.clock.t += 5000;
    await env.orch.shutdown();
    expect(env.store.listCalls(ctrl).find((c) => c.id === 'b1')).toMatchObject({ endedAt: env.clock.t, ok: false, errorPreview: 'bị gián đoạn: dashboard tắt' });
  });
});
