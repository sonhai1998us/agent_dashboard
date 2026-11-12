import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSession } from '@/src/core/purge';
import { makeEnv, cleanup, ids, toRunning, g, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => cleanup(env));

/** transcript claude giả: `<sid>.jsonl` và một subagent trong `<sid>/subagents/` */
function transcript(e: Env, sid: string): { file: string; sub: string } {
  const dir = join(e.cfg.claudeDir, 'projects', '-Users-me-proj');
  mkdirSync(join(dir, sid, 'subagents'), { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  const sub = join(dir, sid, 'subagents', 'agent-a.jsonl');
  writeFileSync(file, '{}\n');
  writeFileSync(sub, '{}\n');
  return { file, sub };
}

describe('xoá ticket', () => {
  it('chặn khi chưa kết thúc; dryRun liệt kê và cảnh báo commit chưa merge; xoá thật dọn worktree, nhánh, runs, transcript, DB', async () => {
    const { orch, tickets, store } = env;
    const T = await toRunning(env);
    const { ctrl } = ids(T);
    expect((await orch.deleteTicket(T, true)).blocked).toMatch(/chưa kết thúc/);
    await orch.cancel(T);
    await orch.idle();
    const { branch, worktree: wt } = tickets.getTicket(T)!;
    writeFileSync(join(wt!, 'src', 'moi.ts'), 'export const m = 1;\n');
    g(wt!, 'add', '-A');
    g(wt!, '-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'chỉ có trên nhánh ticket');
    const { file } = transcript(env, tickets.getManaged(ctrl)!.sessionId);
    store.setOffset(file, 3, 1);
    const runs = join(env.cfg.home, 'runs', T);
    mkdirSync(runs, { recursive: true });

    const dry = await orch.deleteTicket(T, true);
    expect(dry.blocked).toBeNull();
    expect(dry.what).toEqual(expect.arrayContaining([`nhánh ${branch}`, `worktree ${wt}`, `thư mục ${runs}`, '2 file transcript']));
    expect(dry.warning).toMatch(/1 commit chưa nằm trong nhánh local nào khác/);
    expect(existsSync(wt!) && existsSync(file) && !!tickets.getTicket(T)).toBe(true);

    const res = await orch.deleteTicket(T, false);
    expect(res.errors).toEqual([]);
    for (const p of [wt!, runs, file, file.slice(0, -'.jsonl'.length)]) expect(existsSync(p)).toBe(false);
    expect(g(env.repo, 'branch', '--list', branch!).trim()).toBe('');
    expect(g(env.repo, 'worktree', 'list')).not.toContain(wt!);
    expect(tickets.getTicket(T)).toBeUndefined();
    expect(tickets.listManaged(T)).toEqual([]);
    expect(tickets.listLog(T)).toEqual([]);
    expect(store.getAgent(ctrl)).toBeUndefined();
    expect(store.getOffset(file)).toBeUndefined();
    expect(env.published.at(-1)).toMatchObject({ type: 'removed', ticketIds: [T], agentIds: expect.arrayContaining([ctrl]) });
    expect((await orch.deleteTicket(T, true)).blocked).toMatch(/Không tìm thấy/);
  });
});

describe('xoá phiên', () => {
  it('chặn phiên đang chạy hoặc không phải phiên gốc; xoá transcript, subagent, offset và dữ liệu', () => {
    const { store, hub, cfg } = env;
    const sid = '11111111-2222-3333-4444-555555555555';
    const id = `claude:${sid}`;
    store.applyEvent({ type: 'agent', agent: { id, source: 'claude', sessionId: sid, status: 'running', cwd: '/x' } });
    store.applyEvent({ type: 'agent', agent: { id: `${id}:a1`, source: 'claude', sessionId: sid, parentId: id, status: 'ended' } });
    const { file, sub } = transcript(env, sid);
    store.setOffset(file, 10, 1);
    store.setOffset(sub, 5, 1);
    const d = { store, hub, cfg };

    expect(deleteSession(d, id, true).blocked).toBe('Phiên đang chạy');
    store.setAgentStatus(id, 'idle');
    expect(deleteSession(d, `${id}:a1`, true).blocked).toBe('Không tìm thấy phiên');
    const dry = deleteSession(d, id, true);
    expect(dry).toMatchObject({ blocked: null, what: ['2 file transcript', 'dữ liệu trên dashboard'] });
    expect(existsSync(file)).toBe(true);

    expect(deleteSession(d, id, false).errors).toEqual([]);
    expect(existsSync(file) || existsSync(sub)).toBe(false);
    expect(store.getAgent(id) ?? store.getAgent(`${id}:a1`)).toBeUndefined();
    expect(store.getOffset(file) ?? store.getOffset(sub)).toBeUndefined();
    expect(env.published.at(-1)).toMatchObject({ type: 'removed', ticketIds: [], agentIds: expect.arrayContaining([id, `${id}:a1`]) });
  });

  it('dropAgentTree chỉ xoá đúng cây: acctv:T-1 không đụng acctv:T-10', () => {
    const { store } = env;
    for (const id of ['acctv:T-1:controller', 'acctv:T-1:dev-1', 'acctv:T-10:controller']) {
      store.applyEvent({ type: 'agent', agent: { id, source: 'claude', sessionId: id } });
    }
    expect(store.dropAgentTree('acctv:T-1').sort()).toEqual(['acctv:T-1:controller', 'acctv:T-1:dev-1']);
    expect(store.getAgent('acctv:T-10:controller')).toBeDefined();
  });
});
