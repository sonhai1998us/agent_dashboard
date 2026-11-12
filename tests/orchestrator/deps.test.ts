import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canClone, installDeps, installPlan, type DepsResult } from '@/src/orchestrator/installDeps';
import { makeEnv, cleanup, validPlan, runOf, toRunning, type Env } from '../helpers/orchestratorEnv';

const plan = () => {
  const p = validPlan();
  p.roles.explorer = { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 1 };
  return p;
};

/** Cài giả: test tự quyết lúc nào xong và kết quả. */
function deferred() {
  let resolve!: (r: DepsResult) => void;
  const calls: [string, string][] = [];
  const fn = (dir: string, wt: string) => {
    calls.push([dir, wt]);
    return new Promise<DepsResult>((r) => { resolve = r; });
  };
  return { fn, calls, done: (r: Partial<DepsResult> = {}) => resolve({ ok: true, how: 'install', cmd: 'npm ci', ms: 1000, detail: '', ...r }) };
}

describe('cài dependency cho worktree mới', () => {
  let env: Env;
  afterEach(() => cleanup(env));

  it('Explorer chạy ngay; Dev chờ tới khi cài xong; Controller được báo không giao việc cài', async () => {
    const d = deferred();
    env = makeEnv({ maxParallel: 3, installDeps: d.fn });
    const T = await toRunning(env, plan());
    const t = env.tickets.getTicket(T)!;
    expect(d.calls).toEqual([[env.repo, t.worktree]]);
    expect(runOf(env, `acctv:${T}:controller`)!.spec.prompt).toContain('Dashboard đang cài dependency');
    expect(runOf(env, `acctv:${T}:controller`)!.spec.prompt).not.toContain('chưa cài dependency');

    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'explorer', task: 'Tìm file', files: [] });
    await tools.spawn_agent({ role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
    expect(runOf(env, `acctv:${T}:explorer-1`)).toBeDefined();
    expect(runOf(env, `acctv:${T}:dev-1`)).toBeUndefined();
    expect(env.tickets.getManaged(`acctv:${T}:dev-1`)!.state).toBe('queued');

    d.done();
    await env.orch.idle();
    const dev = runOf(env, `acctv:${T}:dev-1`)!;
    expect(dev).toBeDefined();
    expect(dev.spec.prompt).not.toContain('node_modules có thể thiếu');
    expect(env.tickets.listLog(T).map((l) => l.text)).toContain('Đã cài dependency bằng `npm ci` (1s)');
  });

  it('cài lỗi: worker (trừ Explorer) được báo lỗi trong prompt và không tự cài lại', async () => {
    const d = deferred();
    env = makeEnv({ maxParallel: 3, installDeps: d.fn });
    const T = await toRunning(env, plan());
    d.done({ ok: false, detail: 'npm ERR! network ETIMEDOUT' });
    await env.orch.idle();
    const tools = env.orch.mcpTools(T);
    await tools.spawn_agent({ role: 'explorer', task: 'Tìm file', files: [] });
    await tools.spawn_agent({ role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
    expect(runOf(env, `acctv:${T}:dev-1`)!.spec.prompt).toMatch(/`npm ci` trong worktree nhưng lỗi:\nnpm ERR! network ETIMEDOUT[\s\S]*đừng tự cài lại/);
    expect(runOf(env, `acctv:${T}:explorer-1`)!.spec.prompt).not.toContain('ETIMEDOUT');
  });

  it('không có gì để cài (null): không chờ, không nhắc gì về dependency', async () => {
    env = makeEnv({ maxParallel: 3, installDeps: () => null });
    const T = await toRunning(env, plan());
    const p = runOf(env, `acctv:${T}:controller`)!.spec.prompt;
    expect(p).not.toContain('Dashboard đang cài dependency');
    expect(p).not.toContain('chưa cài dependency');
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'Làm a', files: ['src/a.ts'] });
    expect(runOf(env, `acctv:${T}:dev-1`)).toBeDefined();
  });
});

describe('installDeps (thật)', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const mk = (dir: string, files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
  };

  it('chọn lệnh theo lockfile; không phải dự án Node hoặc đã có node_modules → null', () => {
    root = mkdtempSync(join(tmpdir(), 'acctv-deps-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    expect(installPlan(wt)).toBeNull();
    mk(wt, { 'package.json': '{}' });
    expect(installPlan(wt)).toEqual({ lock: null, cmd: 'npm install' });
    mk(wt, { 'package-lock.json': '{}' });
    expect(installPlan(wt)).toEqual({ lock: 'package-lock.json', cmd: 'npm ci' });
    mk(wt, { 'pnpm-lock.yaml': '' });
    expect(installPlan(wt)?.cmd).toBe('pnpm install --frozen-lockfile');
    mk(wt, { 'node_modules/x/index.js': '' });
    expect(installPlan(wt)).toBeNull();
  });

  it('canClone: lockfile giống hệt và node_modules mới hơn lockfile; không nhân bản monorepo hay node_modules cũ', () => {
    root = mkdtempSync(join(tmpdir(), 'acctv-deps-'));
    const dir = join(root, 'repo');
    const wt = join(root, 'wt');
    mk(dir, { 'package.json': '{}', 'package-lock.json': '{"v":1}', 'node_modules/.package-lock.json': '{}' });
    mk(wt, { 'package.json': '{}', 'package-lock.json': '{"v":1}' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'package-lock.json'), old, old);
    const supported = process.platform === 'darwin' || process.platform === 'linux';
    expect(canClone(dir, wt, 'package-lock.json')).toBe(supported);
    // lockfile khác
    writeFileSync(join(wt, 'package-lock.json'), '{"v":2}');
    expect(canClone(dir, wt, 'package-lock.json')).toBe(false);
    writeFileSync(join(wt, 'package-lock.json'), '{"v":1}');
    // lockfile sửa sau lần cài cuối
    const older = new Date(Date.now() - 120_000);
    utimesSync(join(dir, 'node_modules', '.package-lock.json'), older, older);
    expect(canClone(dir, wt, 'package-lock.json')).toBe(false);
    utimesSync(join(dir, 'node_modules', '.package-lock.json'), new Date(), new Date());
    // monorepo
    writeFileSync(join(wt, 'package.json'), '{"workspaces":["packages/*"]}');
    expect(canClone(dir, wt, 'package-lock.json')).toBe(false);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('nhân bản node_modules của repo gốc', async () => {
    root = mkdtempSync(join(tmpdir(), 'acctv-deps-'));
    const dir = join(root, 'repo');
    const wt = join(root, 'wt');
    mk(dir, { 'package.json': '{}', 'package-lock.json': '{}', 'node_modules/.package-lock.json': '{}', 'node_modules/lib/index.js': 'module.exports = 1;' });
    mk(wt, { 'package.json': '{}', 'package-lock.json': '{}' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'package-lock.json'), old, old);
    const r = await installDeps(dir, wt)!;
    expect(r).toMatchObject({ ok: true, how: 'clone' });
    expect(readFileSync(join(wt, 'node_modules', 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(existsSync(join(dir, 'node_modules', 'lib', 'index.js'))).toBe(true);
  });
});
