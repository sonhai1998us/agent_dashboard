import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { DEFAULT_SETTINGS, loadConfig, type Config } from '@/src/core/config';
import { startServer, type RunningServer } from '@/src/server/http';
import { cliRunners } from '@/src/server/core';
import { validatePlan } from '@/src/tickets/flow';
import { g } from '@/tests/helpers/orchestratorEnv';
import { Store } from '@/src/core/store';
import { TicketStore } from '@/src/tickets/store';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fakeClaude = path.join(fixtures, 'fake-claude.mjs');

let tmp: string;
let repo: string;
let cfg: Config;
let srv: RunningServer | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-e2e-'));
  cfg = { ...loadConfig({
    ACCTV_HOME: path.join(tmp, 'home'),
    ACCTV_CLAUDE_DIR: path.join(tmp, 'claude'),
    ACCTV_CODEX_DIR: path.join(tmp, 'codex'),
  }), port: 0 };
  fs.mkdirSync(path.join(cfg.claudeDir, 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(path.join(cfg.codexDir, 'sessions'), { recursive: true });
  repo = path.join(tmp, 'Dự án e2e');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  g(repo, 'init', '-q');
  g(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  g(repo, 'add', '-A');
  g(repo, '-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');
});

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  delete process.env.FAKE_CLAUDE_SCRIPT;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const plan = {
  summary: 'Sửa a', difficulty: 'easy',
  packages: [{ id: 'p1', role: 'dev', title: 'A', task: 'Sửa src/a.ts', files: ['src/a.ts'] }],
  roles: {
    dev: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 1 },
    designer: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 0 },
    qc: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 0 },
  },
  acceptance: ['a đổi'],
};

const scenario = {
  controller: [
    { when: 'Kế hoạch đã được duyệt', steps: [
      { mcp: 'spawn_agent', args: { role: 'dev', packageId: 'p1', task: 'Sửa src/a.ts', files: ['src/a.ts'] } },
      { mcp: 'wait_agents', args: { ids: ['acctv:T-1:dev-1'] } },
    ] },
    { when: 'Các agent đã xong', steps: [{ mcp: 'finish', args: { status: 'done', report: 'Đã sửa src/a.ts' } }] },
    { steps: [{ mcp: 'propose_plan', args: { plan } }] },
  ],
  dev: [
    { steps: [
      { hook: { tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } } },
      { hook: { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } } },
    ] },
  ],
};

test('ticket chạy hết vòng với fake Claude CLI thật: duyệt qua HTTP, guard chặn ngoài phạm vi, done', async () => {
  const scriptFile = path.join(tmp, 'scenario.json');
  fs.writeFileSync(scriptFile, JSON.stringify(scenario));
  process.env.FAKE_CLAUDE_SCRIPT = scriptFile;
  const runners = cliRunners(cfg, { ACCTV_CLAUDE_CMD: JSON.stringify({ command: process.execPath, prefixArgs: [fakeClaude] }) });
  expect(runners.claude).toBeTruthy();
  srv = await startServer({ cfg, withNext: false, watcher: { livenessMs: 200 }, runners });
  const s = srv;
  const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws');
  const events: any[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const get = async (p: string) => (await fetch(s.url + p)).json();
  const post = (p: string, body: unknown = {}) =>
    fetch(s.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    expect((await post('/api/tickets', { title: 'Sửa a', description: 'đổi a', dir: repo })).status).toBe(201);
    await waitFor(async () => (await get('/api/tickets/T-1')).ticket.status === 'awaiting_approval', 20000, 'awaiting_approval');
    expect((await post('/api/tickets/T-1/approve')).status).toBe(200);
    const final = await waitFor(async () => {
      const j = await get('/api/tickets/T-1');
      // finish được gọi giữa lượt: chờ cả tiến trình Controller thoát
      const ended = j.agents.every((a: any) => ['done', 'failed', 'stopped', 'interrupted'].includes(a.state));
      return ['done', 'escalated', 'cancelled'].includes(j.ticket.status) && ended ? j : undefined;
    }, 20000, 'ticket kết thúc');
    expect(final.ticket.status).toBe('done');
    expect(final.ticket.report).toBe('Đã sửa src/a.ts');
    expect(final.ticket.round).toBe(1);
    expect(final.agents.map((a: any) => [a.agentId, a.state])).toEqual([['acctv:T-1:controller', 'done'], ['acctv:T-1:dev-1', 'done']]);

    const calls = await get(`/api/agents/${encodeURIComponent('acctv:T-1:dev-1')}/calls`);
    const edits = calls.filter((c: any) => c.name === 'Edit');
    expect(edits.length).toBe(2);
    expect(edits.some((c: any) => c.ok === false && c.errorPreview?.startsWith('[acctv-guard] ngoài phạm vi: src/b.ts'))).toBe(true);
    expect(edits.some((c: any) => c.ok === true)).toBe(true);
    expect(events.some((e) => e.type === 'alert' && e.alert.kind === 'guard' && e.alert.agentId === 'acctv:T-1:dev-1')).toBe(true);

    // transcript mà Claude thật sẽ ghi cho các session này phải bị watcher bỏ qua; một session ngoài ticket thì không
    const sessions: string[] = final.agents.map((a: any) => a.sessionId);
    const now = Date.now();
    const line = (sid: string) => JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(), sessionId: sid, cwd: repo, message: { role: 'user', content: 'hi' } }) + '\n';
    for (const sid of [...sessions, 'outside-session']) fs.writeFileSync(path.join(cfg.claudeDir, 'projects', 'proj', `${sid}.jsonl`), line(sid));
    const snap = await waitFor(async () => {
      const j = await get('/api/snapshot');
      return j.agents.some((a: any) => a.id === 'claude:outside-session') ? j : undefined;
    }, 10000, 'watcher thấy session ngoài ticket');
    const claudeIds = snap.agents.map((a: any) => a.id).filter((id: string) => id.startsWith('claude:'));
    for (const sid of sessions) expect(claudeIds.filter((id: string) => id.includes(sid))).toEqual([]);
    expect(snap.agents.filter((a: any) => a.id.startsWith('acctv:T-1:')).length).toBe(2);
  } finally {
    ws.close();
  }
}, 60000);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('close() kill tiến trình agent đang chạy (worker sleep) và đánh dấu interrupted', async () => {
  const scriptFile = path.join(tmp, 'scenario.json');
  fs.writeFileSync(scriptFile, JSON.stringify({
    controller: [
      { when: 'Kế hoạch đã được duyệt', steps: [
        { mcp: 'spawn_agent', args: { role: 'dev', task: 'Sửa src/a.ts', files: ['src/a.ts'] } },
        { mcp: 'wait_agents', args: { ids: ['acctv:{ticket}:dev-1'] } },
      ] },
      { steps: [{ mcp: 'propose_plan', args: { plan } }] },
    ],
    dev: [{ steps: [{ sleep: 60000 }] }],
  }));
  process.env.FAKE_CLAUDE_SCRIPT = scriptFile;
  srv = await startServer({
    cfg, withNext: false, watcher: { livenessMs: 200 },
    runners: cliRunners(cfg, { ACCTV_CLAUDE_CMD: JSON.stringify({ command: process.execPath, prefixArgs: [fakeClaude] }) }),
  });
  const s = srv;
  const get = async (p: string) => (await fetch(s.url + p)).json();
  const post = (p: string, body: unknown = {}) =>
    fetch(s.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/api/tickets', { title: 'Sửa a', dir: repo })).status).toBe(201);
  await waitFor(async () => (await get('/api/tickets/T-1')).ticket.status === 'awaiting_approval', 20000, 'awaiting_approval');
  expect((await post('/api/tickets/T-1/approve')).status).toBe(200);
  const pid = await waitFor(async () => {
    const snap = await get('/api/snapshot');
    const a = snap.agents.find((x: any) => x.id === 'acctv:T-1:dev-1');
    const m = snap.managed.find((x: any) => x.agentId === 'acctv:T-1:dev-1');
    return m?.state === 'running' && typeof a?.pid === 'number' ? (a.pid as number) : undefined;
  }, 20000, 'dev-1 chạy');
  expect(alive(pid)).toBe(true);

  await s.close();
  srv = undefined;
  await waitFor(() => !alive(pid), 10000, 'tiến trình dev-1 chết');

  const store = new Store(path.join(cfg.home, 'acctv.db'));
  try {
    expect(new TicketStore(store).getManaged('acctv:T-1:dev-1')).toMatchObject({ state: 'interrupted', stopReason: 'bị gián đoạn: dashboard tắt' });
    expect(store.getAgent('acctv:T-1:dev-1')!.status).toBe('ended');
  } finally {
    store.close();
  }
}, 60000);

test('demo-scenario.json: kế hoạch hợp lệ, đủ lượt cho Controller và worker', () => {
  const demo = JSON.parse(fs.readFileSync(path.join(fixtures, 'demo-scenario.json'), 'utf8'));
  const propose = demo.controller.flatMap((t: any) => t.steps).find((s: any) => s.mcp === 'propose_plan');
  const v = validatePlan(propose.args.plan, DEFAULT_SETTINGS);
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(v.plan.packages.filter((p) => p.role === 'dev').length).toBe(2);
  expect(v.plan.packages.filter((p) => p.role === 'qc').length).toBe(1);
  const mcps = demo.controller.flatMap((t: any) => t.steps.map((s: any) => s.mcp));
  expect(mcps).toEqual(expect.arrayContaining(['spawn_agent', 'wait_agents', 'finish']));
  for (const role of ['dev', 'qc']) expect(demo[role][0].steps.some((s: any) => s.sleep === 20000)).toBe(true);
});

test('cliRunners: ACCTV_CLAUDE_CMD sai báo lỗi rõ; claudePath trỏ tới file có thật → có runner claude', () => {
  expect(() => cliRunners(cfg, { ACCTV_CLAUDE_CMD: 'nope' })).toThrow(/ACCTV_CLAUDE_CMD/);
  expect(() => cliRunners(cfg, { ACCTV_CLAUDE_CMD: JSON.stringify({ command: '', prefixArgs: [] }) })).toThrow(/ACCTV_CLAUDE_CMD/);
  expect(() => cliRunners(cfg, { ACCTV_CLAUDE_CMD: JSON.stringify({ command: 'x', prefixArgs: [1] }) })).toThrow(/ACCTV_CLAUDE_CMD/);
  expect(cliRunners(cfg, { ACCTV_CLAUDE_CMD: JSON.stringify({ command: process.execPath }) }).claude).toBeTruthy();
  expect(cliRunners({ ...cfg, settings: { ...cfg.settings, claudePath: process.execPath } }, {}).claude).toBeTruthy();
});
