import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type Config } from '@/src/core/config';
import { startServer, type RunningServer } from '@/src/server/http';
import { createFakeRunner, type FakeRun } from '@/tests/helpers/fakeRunner';
import { g, validPlan } from '@/tests/helpers/orchestratorEnv';

let tmp: string;
let repo: string;
let cfg: Config;
let srv: RunningServer | undefined;
let runs: FakeRun[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-tickets-'));
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
});

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function start(): Promise<RunningServer> {
  const fake = createFakeRunner();
  runs = fake.runs;
  srv = await startServer({ cfg, withNext: false, watcher: { livenessMs: 200 }, runners: { claude: fake.runner } });
  return srv;
}

const JSON_CT = { 'content-type': 'application/json' };

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = JSON_CT) {
  const r = await fetch(srv!.url + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}
const post = (p: string, body: unknown = {}, headers?: Record<string, string>) => call('POST', p, body, headers);

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const mcp = (ticket: string, token: string, name: string, args: unknown) =>
  post(`/mcp?ticket=${ticket}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { ...JSON_CT, authorization: `Bearer ${token}` });

const lastRun = (agentId: string) => [...runs].reverse().find((r) => r.spec.agentId === agentId)!;

/** Tạo T-1 và đưa tới awaiting_approval bằng propose_plan qua /mcp. */
async function toAwaiting(): Promise<void> {
  const c = await post('/api/tickets', { title: 'Trang đăng nhập', description: 'Làm login', dir: repo });
  expect(c.status).toBe(201);
  const ctrl = await waitFor(() => lastRun('acctv:T-1:controller'));
  const r = await mcp('T-1', ctrl.spec.mcp!.token, 'propose_plan', { plan: validPlan() });
  expect(r.status).toBe(200);
  expect(r.json.result.isError).toBe(false);
  ctrl.finish({});
  await waitFor(async () => (await call('GET', '/api/tickets/T-1')).json.ticket.status === 'awaiting_approval');
}

test('POST /api/tickets: 201 planning; 415; Origin lạ 403; không phải repo 400; validate input', async () => {
  await start();
  const ok = await post('/api/tickets', { title: 'Thêm trang', dir: repo });
  expect(ok.status).toBe(201);
  expect(ok.json).toMatchObject({ id: 'T-1', status: 'planning', title: 'Thêm trang', description: '' });

  expect((await post('/api/tickets', { title: 'x', dir: repo }, {})).status).toBe(415);
  expect((await post('/api/tickets', { title: 'x', dir: repo }, { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await post('/api/tickets', { title: 'x', dir: repo }, { ...JSON_CT, origin: 'http://evil.test' })).status).toBe(403);

  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  const notRepo = await post('/api/tickets', { title: 'x', dir: plain });
  expect(notRepo.status).toBe(400);
  expect(notRepo.json.error).toMatch(/git repo/);

  expect((await post('/api/tickets', { title: '', dir: repo })).status).toBe(400);
  expect((await post('/api/tickets', { title: 'x'.repeat(201), dir: repo })).status).toBe(400);
  expect((await post('/api/tickets', { title: 'x', dir: 'relative/dir' })).status).toBe(400);
  expect((await post('/api/tickets', { title: 'x', dir: repo, description: 5 })).status).toBe(400);
  expect((await post('/api/tickets', '{bad json')).status).toBe(400);
  expect((await post('/api/tickets', [1, 2])).status).toBe(400);
  const badOv = await post('/api/tickets', { title: 'x', dir: repo, overrides: { dev: { model: 'gpt-x', effort: 'turbo' }, boss: {} } });
  expect(badOv.status).toBe(400);
  expect(badOv.json.errors.length).toBe(3);
  const codexCtrl = await post('/api/tickets', { title: 'x', dir: repo, overrides: { controller: { agent: 'codex' } } });
  expect(codexCtrl.status).toBe(400);
  expect(codexCtrl.json.error).toBe('overrides.controller.agent: Controller luôn là claude');
  const goodOv = await post('/api/tickets',{ title: 'y', dir: repo, overrides: { dev: { model: 'claude-haiku-5-5' }, qc: { effort: 'low' } } });
  expect(goodOv.status).toBe(201);
  expect(goodOv.json.overrides).toEqual({ dev: { model: 'claude-haiku-5-5' }, qc: { effort: 'low' } });

  const big = JSON.stringify({ title: 'x', dir: repo, description: 'a'.repeat(1_100_000) });
  expect((await post('/api/tickets', big)).status).toBe(413);

  const list = await call('GET', '/api/tickets');
  expect(list.json.map((t: any) => t.id)).toEqual(['T-2', 'T-1']);
  const one = await call('GET', '/api/tickets/T-1');
  expect(one.json.ticket.id).toBe('T-1');
  expect(one.json.agents.map((a: any) => a.agentId)).toEqual(['acctv:T-1:controller']);
  expect(one.json.log.length).toBeGreaterThan(0);
  expect((await call('GET', '/api/tickets/T-9')).status).toBe(404);
  expect((await call('DELETE', '/api/tickets/T-1')).status).toBe(405);
  expect((await call('GET', '/api/nope')).status).toBe(404);
});

test('duyệt hai lần song song → một 200, một 409; revise/continue/cancel/remove-worktree', async () => {
  await start();
  await toAwaiting();
  expect((await post('/api/tickets/T-1/revise', { feedback: '' })).status).toBe(400);
  const [a, b] = await Promise.all([post('/api/tickets/T-1/approve', {}), post('/api/tickets/T-1/approve', {})]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const won = a.status === 200 ? a : b;
  expect(won.json.status).toBe('running');
  expect(won.json.worktree).toBeTruthy();
  expect((a.status === 409 ? a : b).json.error).toMatch(/chờ duyệt/);
  expect((await post('/api/tickets/T-1/revise', { feedback: 'sửa' })).status).toBe(409);
  expect((await post('/api/tickets/T-1/continue', { guidance: 'tiếp' })).status).toBe(409);
  expect((await post('/api/tickets/T-1/continue', { guidance: 'x'.repeat(5001) })).status).toBe(400);
  // góp ý: chỉ khi ticket đã xong; body sai dạng → 400
  const fb = await post('/api/tickets/T-1/feedback', { text: 'lệch', images: [{ name: 'a.png', type: 'image/png', data: Buffer.from('x').toString('base64') }] });
  expect(fb.status).toBe(409);
  expect(fb.json.error).toMatch(/đã xong/);
  expect((await post('/api/tickets/T-1/feedback', { text: 'x', images: 'a.png' })).status).toBe(400);
  expect((await post('/api/tickets/T-1/feedback', { text: 'x', images: [{ name: 'a.png' }] })).status).toBe(400);
  expect((await post('/api/tickets/T-1/remove-worktree')).status).toBe(409);
  const c = await post('/api/tickets/T-1/cancel');
  expect(c.status).toBe(200);
  expect(c.json.status).toBe('cancelled');
  expect((await post('/api/tickets/T-1/cancel')).status).toBe(409);
  const rm = await post('/api/tickets/T-1/remove-worktree');
  expect(rm.status).toBe(200);
  expect(rm.json.worktree).toBeNull();
  expect((await post('/api/tickets/T-9/cancel')).status).toBe(404);
});

test('stop agent 202 rồi 409; guard endpoint quyết định theo phạm vi; token sai 401; GET /mcp 405', async () => {
  await start();
  await toAwaiting();
  expect((await post('/api/tickets/T-1/approve')).status).toBe(200);
  const ctrl = await waitFor(() => runs.filter((r) => r.spec.agentId === 'acctv:T-1:controller')[1]);
  const sp = await mcp('T-1', ctrl.spec.mcp!.token, 'spawn_agent', { role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
  expect(sp.json.result.isError).toBe(false);
  const dev = await waitFor(() => lastRun('acctv:T-1:dev-1'));

  const guard = (agent: string, token: string, body: unknown) =>
    post(`/api/guard?agent=${encodeURIComponent(agent)}`, body, { ...JSON_CT, authorization: `Bearer ${token}` });
  const allow = await guard('acctv:T-1:dev-1', dev.spec.guard.token, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  expect(allow).toEqual({ status: 200, json: { allow: true } });
  const deny = await guard('acctv:T-1:dev-1', dev.spec.guard.token, { tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } });
  expect(deny.status).toBe(200);
  expect(deny.json.allow).toBe(false);
  expect(deny.json.reason).toMatch(/^\[acctv-guard\] ngoài phạm vi: src\/b\.ts/);
  expect((await guard('acctv:T-1:dev-1', 'wrong', { tool_name: 'Read' })).status).toBe(401);
  expect((await post('/api/guard?agent=acctv:T-1:dev-1', { tool_name: 'Read' })).status).toBe(401);

  expect((await mcp('T-1', 'wrong', 'finish', { status: 'done', report: 'x' })).status).toBe(401);
  expect((await post('/mcp?ticket=T-1', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  expect((await call('GET', '/mcp?ticket=T-1', undefined, {})).status).toBe(405);
  const ctrlAuth = { authorization: `Bearer ${ctrl.spec.mcp!.token}` };
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  expect((await post('/mcp?ticket=T-1', ping, { ...JSON_CT, ...ctrlAuth, origin: 'http://evil.test' })).status).toBe(403);
  expect((await post('/mcp?ticket=T-1', ping, ctrlAuth)).status).toBe(415);
  expect((await post('/mcp?ticket=T-1', ping, { ...JSON_CT, ...ctrlAuth })).status).toBe(200);
  const devAuth = { authorization: `Bearer ${dev.spec.guard.token}` };
  const read = { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } };
  expect((await post('/api/guard?agent=acctv:T-1:dev-1', read, { ...JSON_CT, ...devAuth, origin: 'http://evil.test' })).status).toBe(403);
  expect((await post('/api/guard?agent=acctv:T-1:dev-1', read, devAuth)).status).toBe(415);
  // token sai → 401 trước khi đọc body (body quá cỡ không thành 413)
  const huge = JSON.stringify({ tool_name: 'Write', tool_input: { content: 'x'.repeat(33_000_000) } });
  expect((await post('/api/guard?agent=acctv:T-1:dev-1', huge, { ...JSON_CT, authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await guard('acctv:T-1:dev-2', dev.spec.guard.token, read)).status).toBe(401);
  const note = await post('/mcp?ticket=T-1', { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...JSON_CT, authorization: `Bearer ${ctrl.spec.mcp!.token}` });
  expect(note.status).toBe(202);

  const id = encodeURIComponent('acctv:T-1:dev-1');
  expect(await post(`/api/agents/${id}/stop`)).toEqual({ status: 202, json: { ok: true } });
  expect(dev.killed).toBe(true);
  expect((await post(`/api/agents/${id}/stop`)).status).toBe(409);
  expect((await post(`/api/agents/${encodeURIComponent('acctv:T-1:dev-9')}/stop`)).status).toBe(404);
  const t = await call('GET', '/api/tickets/T-1');
  expect(t.json.agents.find((a: any) => a.agentId === 'acctv:T-1:dev-1')).toMatchObject({ state: 'stopped', stopReason: 'người dùng dừng' });
});

test('settings: PUT sai → 400 errors; hợp lệ → 200 và GET trả lại; capabilities', async () => {
  await start();
  const cur = await call('GET', '/api/settings');
  expect(cur.status).toBe(200);
  expect(cur.json.settings.maxParallel).toBe(3);
  expect(cur.json.thresholds.loopCritical).toBe(10);

  const bad = await call('PUT', '/api/settings', { ...cur.json, settings: { ...cur.json.settings, maxParallel: 0 } });
  expect(bad.status).toBe(400);
  expect(bad.json.errors.some((e: string) => e.includes('maxParallel'))).toBe(true);
  expect((await call('PUT', '/api/settings', cur.json, {})).status).toBe(415);

  const next = { settings: { ...cur.json.settings, maxParallel: 5, maxRounds: 4 }, thresholds: { ...cur.json.thresholds, loopWarn: 4 } };
  const withJunk = {
    ...next, junkTop: 1,
    settings: {
      ...next.settings, junkSettings: true,
      roleDefaults: { ...next.settings.roleDefaults, dev: { ...next.settings.roleDefaults.dev, junkRole: 'x' } },
      allowedModels: { ...next.settings.allowedModels, gemini: ['g'] },
      prices: { 'claude-sonnet-5-5': { in: 3, out: 15, junkPrice: 1 } },
    },
    thresholds: { ...next.thresholds, junkThreshold: 9 },
  };
  const expected = { ...next, settings: { ...next.settings, prices: { 'claude-sonnet-5-5': { in: 3, out: 15 } } } };
  const put = await call('PUT', '/api/settings', withJunk);
  expect(put.status).toBe(200);
  expect(put.json).toEqual(expected);
  const again = await call('GET', '/api/settings');
  expect(again.json).toEqual(expected);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.home, 'config.json'), 'utf8'));
  expect(saved.settings.maxParallel).toBe(5);
  expect({ settings: saved.settings, thresholds: saved.thresholds }).toEqual(expected);
  expect(saved.junkTop).toBeUndefined();

  expect((await call('GET', '/api/capabilities')).json).toEqual({ claude: true, codex: false });
});

test('settings: mật khẩu tài khoản test bị che khi GET; PUT với giá trị che giữ mật khẩu cũ', async () => {
  await start();
  const cur = (await call('GET', '/api/settings')).json;
  const proj = {
    dev: { command: 'next dev -p {port}' }, prod: { build: 'next build', start: 'next start -p {port}' }, defaultMode: 'dev', env: {}, readyPath: '/',
    accounts: [{ name: 'owner', description: 'Chủ', username: 'o@x', password: 'secret-1' }],
  };
  const body = { ...cur, settings: { ...cur.settings, projects: { [repo]: proj } } };
  const put = await call('PUT', '/api/settings', body);
  expect(put.status).toBe(200);
  expect(JSON.stringify(put.json)).not.toContain('secret-1');
  const got = await call('GET', '/api/settings');
  expect(JSON.stringify(got.json)).not.toContain('secret-1');
  expect(got.json.settings.projects[repo].accounts[0].password).toBe('••••');

  const again = await call('PUT', '/api/settings', got.json);
  expect(again.status).toBe(200);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.home, 'config.json'), 'utf8'));
  expect(saved.settings.projects[repo].accounts[0].password).toBe('secret-1');

  const fresh = structuredClone(got.json);
  fresh.settings.projects[repo].accounts.push({ name: 'member', description: '', username: 'm@x', password: '••••' });
  const bad = await call('PUT', '/api/settings', fresh);
  expect(bad.status).toBe(400);
  expect(bad.json.errors.join('\n')).toMatch(/accounts\.member\.password/);
});

test('preview: trạng thái trong GET ticket, nút tắt server, ảnh capture, reset dữ liệu', async () => {
  await start();
  await toAwaiting();
  const t = await call('GET', '/api/tickets/T-1');
  expect(t.json.preview).toBeNull();
  expect((await post('/api/tickets/T-1/preview/stop')).json).toEqual({ ok: true });
  expect((await post('/api/tickets/T-9/preview/stop')).status).toBe(404);

  const dir = path.join(cfg.home, 'runs', 'T-1', 'qc-1', 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  fs.writeFileSync(path.join(dir, '1-home.png'), png);
  fs.writeFileSync(path.join(dir, '2-error-3.png'), png);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'no');
  const list = await call('GET', `/api/agents/${encodeURIComponent('acctv:T-1:qc-1')}/captures`);
  expect(list.status).toBe(200);
  expect(list.json.map((c: any) => c.name).sort()).toEqual(['1-home.png', '2-error-3.png']);
  expect(list.json[0]).toEqual({ name: expect.any(String), file: expect.stringMatching(/^\/api\/captures\/T-1\/qc-1\/\d+-[\w-]+\.png$/), at: expect.any(Number) });
  expect((await call('GET', `/api/agents/${encodeURIComponent('acctv:T-1:nope-1')}/captures`)).json).toEqual([]);
  expect((await call('GET', '/api/agents/bad/captures')).status).toBe(404);

  const img = await fetch(`${srv!.url}/api/captures/T-1/qc-1/1-home.png`);
  expect(img.status).toBe(200);
  expect(img.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await img.arrayBuffer())).toEqual(png);
  for (const p of ['/api/captures/T-1/qc-1/x.txt', '/api/captures/T-1/qc-1/..%2F..%2Fconfig.json', '/api/captures/..%2F..%2Fx/qc-1/1-home.png', '/api/captures/T-1/qc-1/9-none.png']) {
    expect((await fetch(srv!.url + p)).status, p).toBe(404);
  }

  // lịch sử góp ý và ảnh góp ý
  expect((await call('GET', '/api/tickets/T-1/feedback-history')).json).toEqual([]);
  expect((await call('GET', '/api/tickets/T-9/feedback-history')).status).toBe(404);
  const fbDir = path.join(cfg.home, 'runs', 'T-1', 'feedback');
  fs.mkdirSync(fbDir, { recursive: true });
  fs.writeFileSync(path.join(fbDir, '17-1.jpg'), png);
  const shot = await fetch(`${srv!.url}/api/tickets/T-1/feedback-images/17-1.jpg`);
  expect(shot.status).toBe(200);
  expect(shot.headers.get('content-type')).toBe('image/jpeg');
  expect(Buffer.from(await shot.arrayBuffer())).toEqual(png);
  for (const p of ['/api/tickets/T-1/feedback-images/17-2.jpg', '/api/tickets/T-1/feedback-images/x.svg', '/api/tickets/T-1/feedback-images/..%2F..%2Fconfig.json', '/api/tickets/..%2Fx/feedback-images/17-1.jpg']) {
    expect((await fetch(srv!.url + p)).status, p).toBe(404);
  }

  const proj = {
    dev: { command: 'next dev -p {port}' }, prod: { build: 'next build', start: 'next start -p {port}' }, defaultMode: 'dev', env: {}, readyPath: '/',
    accounts: [{ name: 'owner', description: '', username: 'o@x', password: 'pw-42' }],
    db: { resetCommand: `"${process.execPath}" -e "console.log(42); console.log('pw-42')"`, cwd: tmp },
  };
  const cur = (await call('GET', '/api/settings')).json;
  expect((await call('PUT', '/api/settings', { ...cur, settings: { ...cur.settings, projects: { [repo]: proj } } })).status).toBe(200);
  const reset = await post('/api/projects/reset-db', { dir: repo });
  expect(reset.status).toBe(200);
  expect(reset.json.code).toBe(0);
  expect(reset.json.tail).toContain('42');
  expect(reset.json.tail).not.toContain('pw-42');
  expect((await post('/api/projects/reset-db', { dir: tmp })).status).toBe(400);
  expect((await post('/api/projects/reset-db', { dir: repo }, { ...JSON_CT, origin: 'http://evil.example' })).status).toBe(403);
});

test('fs/check và fs/git-init', async () => {
  await start();
  const chk = await call('GET', `/api/fs/check?dir=${encodeURIComponent(repo)}`);
  expect(chk.status).toBe(200);
  expect(chk.json).toMatchObject({ exists: true, isGit: true });
  expect((await call('GET', '/api/fs/check')).status).toBe(400);
  expect((await call('GET', '/api/fs/check?dir=rel')).status).toBe(400);
  expect((await call('GET', `/api/fs/check?dir=${encodeURIComponent(path.join(tmp, 'none'))}`)).json.exists).toBe(false);

  const again = await post('/api/fs/git-init', { dir: repo });
  expect(again.status).toBe(409);
  expect(again.json.error).toBe('Thư mục đã là git repo');
  expect((await post('/api/fs/git-init', { dir: path.join(tmp, 'none') })).status).toBe(400);
  for (const inner of [path.join(cfg.home, 'x'), path.join(cfg.claudeDir, 'projects'), cfg.codexDir]) {
    fs.mkdirSync(inner, { recursive: true });
    const r = await post('/api/fs/git-init', { dir: process.platform === 'win32' ? inner.toUpperCase() : inner });
    expect(r.status).toBe(400);
    expect(fs.existsSync(path.join(inner, '.git'))).toBe(false);
  }
  if (process.platform === 'win32') {
    for (const bad of ['\\foo', '\\\\server\\share\\x', 'D:rel']) {
      expect((await call('GET', `/api/fs/check?dir=${encodeURIComponent(bad)}`)).status).toBe(400);
      expect((await post('/api/fs/git-init', { dir: bad })).status).toBe(400);
    }
  }
  const fresh = path.join(tmp, 'mới tinh');
  fs.mkdirSync(fresh);
  const init = await post('/api/fs/git-init', { dir: fresh });
  expect(init.status).toBe(200);
  expect(init.json).toMatchObject({ exists: true, isGit: true, dirty: false });
  expect(init.json.head).toBeTruthy();
});

test('fs/dirs: duyệt thư mục cho hộp chọn dự án', async () => {
  await start();
  const l = await call('GET', `/api/fs/dirs?dir=${encodeURIComponent(tmp)}`);
  expect(l.status).toBe(200);
  expect(l.json.path).toBe(path.resolve(tmp));
  expect(l.json.entries).toContainEqual({ name: 'Dự án', path: repo, isGit: true });
  const inRepo = await call('GET', `/api/fs/dirs?dir=${encodeURIComponent(repo)}`);
  expect(inRepo.json).toMatchObject({ isGit: true, parent: path.resolve(tmp) });
  expect(inRepo.json.entries.map((e: { name: string }) => e.name)).toEqual(['src']); // .git bị ẩn
  const roots = await call('GET', '/api/fs/dirs');
  expect(roots.status).toBe(200);
  expect(roots.json.path).toBeNull();
  expect(roots.json.entries.length).toBeGreaterThan(0);
  expect((await call('GET', '/api/fs/dirs?dir=rel')).status).toBe(400);
  expect((await call('GET', `/api/fs/dirs?dir=${encodeURIComponent(path.join(tmp, 'none'))}`)).status).toBe(404);
  expect((await post('/api/fs/dirs', {})).status).toBe(405);
});

test('snapshot có tickets/managed/waits/prices; WS nhận event ticket khi trạng thái đổi', async () => {
  const s = await start();
  const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws');
  const got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  try {
    await toAwaiting();
    await waitFor(() => got.find((e) => e.type === 'ticket' && e.ticket.id === 'T-1' && e.ticket.status === 'awaiting_approval'));
    expect(got.some((e) => e.type === 'ticket' && e.ticket.status === 'planning')).toBe(true);
  } finally {
    ws.close();
  }
  const snap = (await call('GET', '/api/snapshot')).json;
  expect(snap.tickets.map((t: any) => t.id)).toEqual(['T-1']);
  expect(snap.managed.map((m: any) => m.agentId)).toEqual(['acctv:T-1:controller']);
  expect(snap.waits.some((w: any) => w.agentId === 'acctv:T-1:controller' && w.kind === 'approval' && w.endedAt === null)).toBe(true);
  expect(snap.prices).toEqual({});
  expect(Array.isArray(snap.agents)).toBe(true);
});

test('worker MCP (?agent=) chỉ có tool của worker (request_user_action, capture); trả lời qua /api/agents/:id/user-action', async () => {
  await start();
  await toAwaiting();
  expect((await post('/api/tickets/T-1/approve')).status).toBe(200);
  const ctrl = await waitFor(() => runs.filter((r) => r.spec.agentId === 'acctv:T-1:controller')[1]);
  await mcp('T-1', ctrl.spec.mcp!.token, 'spawn_agent', { role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
  const dev = await waitFor(() => lastRun('acctv:T-1:dev-1'));
  const id = encodeURIComponent('acctv:T-1:dev-1');
  const devMcp = (token: string, body: unknown) => post(`/mcp?agent=${id}`, body, { ...JSON_CT, authorization: `Bearer ${token}` });

  expect((await devMcp('wrong', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  expect((await devMcp(ctrl.spec.mcp!.token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  const list = await devMcp(dev.spec.guard.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(list.json.result.tools.map((t: any) => t.name)).toEqual(['request_user_action', 'capture']);
  const spawn = await devMcp(dev.spec.guard.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spawn_agent', arguments: {} } });
  expect(spawn.json.result.isError).toBe(true);
  // Controller không dùng được token của nó với tool của worker và ngược lại
  expect((await post(`/mcp?agent=${encodeURIComponent('acctv:T-1:controller')}`, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...JSON_CT, authorization: `Bearer ${ctrl.spec.guard.token}` })).status).toBe(401);

  expect((await post(`/api/agents/${id}/user-action`, { done: true })).status).toBe(409);
  const req = await devMcp(dev.spec.guard.token, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'request_user_action', arguments: { title: 'Đăng nhập twg', message: 'Chạy lệnh', command: 'twg login', url: 'https://example.com/login' } },
  });
  expect(req.json.result.isError).toBe(false);
  const t = await call('GET', '/api/tickets/T-1');
  expect(t.json.agents.find((a: any) => a.agentId === 'acctv:T-1:dev-1').userAction).toMatchObject({ title: 'Đăng nhập twg', url: 'https://example.com/login' });

  expect((await post(`/api/agents/${id}/user-action`, { done: 'yes' })).status).toBe(400);
  expect((await post(`/api/agents/${id}/user-action`, { done: true, note: 'x'.repeat(2001) })).status).toBe(400);
  dev.finish({});
  await waitFor(async () => (await call('GET', '/api/tickets/T-1')).json.agents.find((a: any) => a.agentId === 'acctv:T-1:dev-1').state === 'waiting');
  const ans = await post(`/api/agents/${id}/user-action`, { done: true, note: 'đã đăng nhập' });
  expect(ans.status).toBe(200);
  expect(ans.json).toMatchObject({ agentId: 'acctv:T-1:dev-1', userAction: null });
  const again = await waitFor(() => (lastRun('acctv:T-1:dev-1') !== dev ? lastRun('acctv:T-1:dev-1') : undefined));
  expect(again.spec.resume).toBe(true);
  expect(again.spec.prompt).toContain('đã đăng nhập');
  expect((await post(`/api/agents/${encodeURIComponent('acctv:T-1:dev-9')}/user-action`, { done: true })).status).toBe(404);
});
