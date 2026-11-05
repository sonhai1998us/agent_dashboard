import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '@/src/core/config';
import { startServer, type RunningServer } from '@/src/server/http';
import { main } from '@/cli/acctv';
import { createFakeRunner, type FakeRun } from '@/tests/helpers/fakeRunner';
import { g, validPlan } from '@/tests/helpers/orchestratorEnv';

let tmp: string;
let repo: string;
let cfg: Config;
let srv: RunningServer | undefined;
let runs: FakeRun[];
let port: number;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-clit-'));
  cfg = { ...loadConfig({
    ACCTV_HOME: path.join(tmp, 'home'),
    ACCTV_CLAUDE_DIR: path.join(tmp, 'claude'),
    ACCTV_CODEX_DIR: path.join(tmp, 'codex'),
  }), port: 0 };
  fs.mkdirSync(path.join(cfg.claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(cfg.codexDir, 'sessions'), { recursive: true });
  repo = path.join(tmp, 'Dự án');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  g(repo, 'init', '-q');
  g(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'src', 'x.ts'), 'export const x = 1;\n');
  g(repo, 'add', '-A');
  g(repo, '-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');
  const fake = createFakeRunner();
  runs = fake.runs;
  srv = await startServer({ cfg, withNext: false, watcher: { livenessMs: 200 }, runners: { claude: fake.runner } });
  port = Number(new URL(srv.url).port);
});

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function cli(...args: string[]) {
  let out = '', err = '';
  const code = await main([...args, '--port', String(port)], { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, color: false, width: 100 });
  return { code, out, err };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const lastRun = (id: string) => [...runs].reverse().find((r) => r.spec.agentId === id);
const mcp = (token: string, name: string, args: unknown) =>
  fetch(`${srv!.url}/mcp?ticket=T-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

test('new, plan, ls, approve (lần hai 409), stop, plan không có ticket', async () => {
  const n = await cli('new', 'Trang đăng nhập', '--dir', repo, '--desc', 'Làm login');
  expect(n.code).toBe(0);
  expect(n.out).toContain('T-1 đã tạo · đang lập kế hoạch');

  expect((await cli('plan', 'T-1')).out).toContain('T-1 chưa có kế hoạch (trạng thái: đang lập kế hoạch)');

  const ctrl = await waitFor(() => lastRun('acctv:T-1:controller'));
  expect((await mcp(ctrl.spec.mcp!.token, 'propose_plan', { plan: validPlan() })).status).toBe(200);
  ctrl.finish({});
  await waitFor(async () => (await cli('plan', 'T-1')).out.includes('Dev ×2'));
  expect((await cli('plan', 'T-1')).out).toContain('src/a.ts');

  const ls = await cli('ls');
  expect(ls.out).toContain('Ticket');
  expect(ls.out).toContain('chờ duyệt');
  expect(ls.out).toContain('Phiên ngoài ticket');

  expect((await cli('approve', 'T-1')).code).toBe(0);
  const again = await cli('approve', 'T-1');
  expect(again.code).toBe(1);
  expect(again.err).toContain('chờ duyệt');

  const ctrl2 = await waitFor(() => runs.filter((x) => x.spec.agentId === 'acctv:T-1:controller')[1]);
  expect((await mcp(ctrl2.spec.mcp!.token, 'spawn_agent', { role: 'dev', task: 'Làm a', files: ['src/a.ts'] })).status).toBe(200);
  await waitFor(() => lastRun('acctv:T-1:dev-1'));
  const st = await cli('stop', 'T-1/dev-1');
  expect(st.code).toBe(0);
  expect(st.out).toContain('Đã dừng Dev-1, kết quả trả về Controller');

  const miss = await cli('plan', 'T-9');
  expect(miss.code).toBe(1);
  expect(miss.err).toMatch(/404|không tìm thấy/i);
});

test('new thiếu --dir, revise thiếu góp ý', async () => {
  expect((await cli('new', 'x')).code).toBe(1);
  expect((await cli('revise', 'T-1')).code).toBe(1);
});
