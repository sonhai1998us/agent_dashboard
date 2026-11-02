import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig, type Config } from '@/src/core/config';
import { Store } from '@/src/core/store';
import type { HubEvent } from '@/src/core/model';
import { createClaudeWatcher } from '@/src/adapters/claude/watch';
import { createCodexWatcher } from '@/src/adapters/codex/watch';

let tmp: string;
let cfg: Config;
let store: Store;
const closers: Array<() => Promise<void>> = [];

const fxClaude = (n: string) => fs.readFileSync(path.join('tests/fixtures/claude', n));
const mainFile = () => path.join(cfg.claudeDir, 'projects', 'proj', 'sess-main.jsonl');
const subFile = () => path.join(cfg.claudeDir, 'projects', 'proj', 'sess-main', 'subagents', 'agent-ab12.jsonl');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-watch-'));
  cfg = loadConfig({
    ACCTV_HOME: path.join(tmp, 'home'),
    ACCTV_CLAUDE_DIR: path.join(tmp, 'claude'),
    ACCTV_CODEX_DIR: path.join(tmp, 'codex'),
  });
  fs.mkdirSync(cfg.home, { recursive: true });
  fs.mkdirSync(path.join(cfg.claudeDir, 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(cfg.codexDir, 'sessions', '2026', '11', '02'), { recursive: true });
  store = new Store(path.join(cfg.home, 'acctv.db'));
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function claudeWatcher(on: (e: HubEvent[]) => void = () => {}, s = store) {
  const w = createClaudeWatcher(cfg, s, on, { polling: true, livenessMs: 100000 });
  closers.push(() => w.stop());
  return w;
}

test('watcher Claude: ghi fixture vào thư mục tạm → Store có agent + call', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  fs.mkdirSync(path.dirname(subFile()), { recursive: true });
  fs.writeFileSync(subFile(), fxClaude('sub.jsonl'));
  fs.writeFileSync(subFile().replace('.jsonl', '.meta.json'), fxClaude('sub.meta.json'));
  const events: HubEvent[] = [];
  const w = claudeWatcher((e) => events.push(...e));
  await w.start();
  const main = store.getAgent('claude:sess-main');
  expect(main).toBeTruthy();
  expect(store.listCalls('claude:sess-main').length).toBeGreaterThan(0);
  const sub = store.getAgent('claude:sess-main:ab12');
  expect(sub?.parentId).toBe('claude:sess-main');
  expect(sub?.role).toBe('office-dev');
  expect(events.length).toBeGreaterThan(0);
});

test('theo dõi file mới ghi sau khi start (chokidar)', async () => {
  const w = claudeWatcher();
  await w.start();
  expect(store.getAgent('claude:sess-main')).toBeUndefined();
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  await waitFor(() => store.getAgent('claude:sess-main') !== undefined && store.listCalls('claude:sess-main').length > 0);
});

test('file cũ hơn backfillHours bị bỏ qua', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(mainFile(), old, old);
  const w = claudeWatcher();
  await w.start();
  expect(store.getAgent('claude:sess-main')).toBeUndefined();
});

test('khởi động lại watcher với cùng DB → không nhân đôi call', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  const w1 = claudeWatcher();
  await w1.start();
  const before = store.listCalls('claude:sess-main');
  const off = store.getOffset(mainFile());
  expect(off && off.offset > 0).toBe(true);
  await w1.stop();
  const w2 = claudeWatcher();
  await w2.start();
  expect(store.listCalls('claude:sess-main')).toEqual(before);
  // an appended line after restart is still picked up exactly once
  fs.appendFileSync(mainFile(), JSON.stringify({ type: 'user', timestamp: '2026-11-02T11:00:00.000Z', sessionId: 'sess-main', message: { role: 'user', content: 'tiếp' } }) + '\n');
  await waitFor(() => (store.getOffset(mainFile())?.offset ?? 0) === fs.statSync(mainFile()).size);
  expect(store.listCalls('claude:sess-main')).toEqual(before);
});

test('sessions/<pid>.json với pid = process.pid → agent running; pid chết → ended', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-main', cwd: 'x', status: 'idle', updatedAt: Date.now() }));
  const w = claudeWatcher();
  await w.start();
  expect(store.getAgent('claude:sess-main')?.status).toBe('running');
  expect(store.getAgent('claude:sess-main')?.pid).toBe(process.pid);
  await w.stop();
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: 2 ** 22 + 12345, sessionId: 'sess-main' }));
  const w2 = claudeWatcher();
  await w2.start();
  expect(store.getAgent('claude:sess-main')?.status).toBe('ended');
});

test('watcher không bao giờ ghi vào claudeDir/codexDir', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  fs.mkdirSync(path.dirname(subFile()), { recursive: true });
  fs.writeFileSync(subFile(), fxClaude('sub.jsonl'));
  fs.writeFileSync(subFile().replace('.jsonl', '.meta.json'), fxClaude('sub.meta.json'));
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-main' }));
  const codexFile = path.join(cfg.codexDir, 'sessions', '2026', '11', '02', 'rollout-2026-11-02T09-18-10-019e5947-01fe-7393-b890-65ac89a98961.jsonl.zst');
  fs.writeFileSync(codexFile, zlib.zstdCompressSync(fs.readFileSync('tests/fixtures/codex/rollout.jsonl')));
  const snap = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { out.push(`D ${p}`); walk(p); } else out.push(`F ${p} ${fs.statSync(p).mtimeMs} ${fs.statSync(p).size}`);
      }
    };
    walk(cfg.claudeDir); walk(cfg.codexDir);
    return out.sort();
  };
  const before = snap();
  const w1 = claudeWatcher();
  const w2 = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w2.stop());
  await w1.start(); await w2.start();
  expect(store.getAgent('claude:sess-main')).toBeTruthy();
  expect(store.getAgent('codex:019e5947-01fe-7393-b890-65ac89a98961')).toBeTruthy();
  await w1.stop(); await w2.stop();
  expect(snap()).toEqual(before);
});

test('Codex: đọc .jsonl.zst và .jsonl thường; trạng thái idle khi turn đã đóng', async () => {
  const dir = path.join(cfg.codexDir, 'sessions', '2026', '11', '02');
  const raw = fs.readFileSync('tests/fixtures/codex/rollout.jsonl');
  fs.writeFileSync(path.join(dir, 'rollout-2026-11-02T09-18-10-019e5947-01fe-7393-b890-65ac89a98961.jsonl.zst'), zlib.zstdCompressSync(raw));
  fs.writeFileSync(path.join(dir, 'rollout-2026-11-02T09-18-10-019e5948-0000-7000-8000-000000000002.jsonl'), raw.toString().replaceAll('019e5947-01fe-7393-b890-65ac89a98961', '019e5948-0000-7000-8000-000000000002'));
  const w = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w.stop());
  await w.start();
  const a = store.getAgent('codex:019e5947-01fe-7393-b890-65ac89a98961');
  const b = store.getAgent('codex:019e5948-0000-7000-8000-000000000002');
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(store.listCalls(a!.id).length).toBeGreaterThan(0);
  expect(a!.status).toBe('idle');
});

test('file hỏng: cảnh báo một lần, sau đó ghi dữ liệu hợp lệ vào cùng file thì được đọc lại', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dir = path.join(cfg.codexDir, 'sessions', '2026', '11', '02');
  const bad = path.join(dir, 'rollout-2026-11-02T09-18-10-019e5949-0000-7000-8000-000000000003.jsonl.zst');
  fs.writeFileSync(bad, 'not zstd at all');
  const w = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w.stop());
  await w.start();
  expect(warn).toHaveBeenCalledTimes(1);
  fs.appendFileSync(bad, 'more'); // still invalid: retried, but no second warning
  await new Promise((r) => setTimeout(r, 200));
  expect(warn).toHaveBeenCalledTimes(1);
  fs.writeFileSync(bad, zlib.zstdCompressSync(fs.readFileSync('tests/fixtures/codex/rollout.jsonl')));
  await waitFor(() => store.getAgent('codex:019e5947-01fe-7393-b890-65ac89a98961') !== undefined);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('root chưa tồn tại lúc start: tạo sau đó vẫn được theo dõi và đọc file mới; không tạo gì trong claudeDir', async () => {
  fs.rmSync(path.join(cfg.claudeDir, 'projects'), { recursive: true, force: true });
  const w = createClaudeWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100 });
  closers.push(() => w.stop());
  await w.start();
  expect(fs.existsSync(path.join(cfg.claudeDir, 'projects'))).toBe(false);
  fs.mkdirSync(path.dirname(mainFile()), { recursive: true });
  await new Promise((r) => setTimeout(r, 350)); // a liveness tick attaches the watcher
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  await waitFor(() => store.getAgent('claude:sess-main') !== undefined && store.listCalls('claude:sess-main').length > 0);
});

test('file lớn nhiều chunk: offset được lưu sau chunk đầu và cuối cùng bằng kích thước file', async () => {
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 1000 + i).toISOString(), sessionId: 'sess-main', cwd: 'D:/x', message: { role: 'user', content: 'dòng ' + i + ' ' + 'z'.repeat(40) } }));
  fs.writeFileSync(mainFile(), lines.join('\n') + '\n');
  const size = fs.statSync(mainFile()).size;
  const seen: number[] = [];
  const w = createClaudeWatcher(cfg, store, () => seen.push(store.getOffset(mainFile())?.offset ?? -1), { polling: true, livenessMs: 100000, chunkBytes: 20000 });
  closers.push(() => w.stop());
  await w.start();
  expect(seen.length).toBeGreaterThan(2);
  expect(seen[0]).toBeGreaterThan(0);
  expect(seen[0]).toBeLessThan(size);
  expect(store.getOffset(mainFile())).toEqual({ offset: size, lines: 1500 });
});

test('dòng độc: applyEvent ném một lần → bỏ qua dòng đó, các dòng sau vẫn được đọc, offset tới cuối, cảnh báo một lần', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ts = (i: number) => new Date(Date.now() - 10000 + i).toISOString();
  const rec = (i: number) => JSON.stringify({ type: 'user', timestamp: ts(i), sessionId: 'sess-main', cwd: 'D:/x', message: { role: 'user', content: 'm' + i } });
  fs.writeFileSync(mainFile(), [rec(1), rec(2), rec(3), rec(4)].join('\n') + '\n');
  const orig = store.applyEvent.bind(store);
  let calls = 0;
  vi.spyOn(store, 'applyEvent').mockImplementation((e) => {
    calls++;
    if (calls === 2) throw new Error('poison');
    return orig(e);
  });
  const w = claudeWatcher();
  await w.start();
  expect(store.getOffset(mainFile())).toEqual({ offset: fs.statSync(mainFile()).size, lines: 4 });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('sess-main.jsonl');
  expect(String(warn.mock.calls[0][0])).toContain('byte');
  expect(calls).toBeGreaterThan(3);
  expect(store.getAgent('claude:sess-main')).toBeTruthy();
});

test('Codex: file không ghi quá 30 phút → ended', async () => {
  const dir = path.join(cfg.codexDir, 'sessions', '2026', '11', '02');
  const f = path.join(dir, 'rollout-2026-11-02T09-18-10-019e5947-01fe-7393-b890-65ac89a98961.jsonl');
  fs.writeFileSync(f, fs.readFileSync('tests/fixtures/codex/rollout.jsonl'));
  const old = new Date(Date.now() - 31 * 60_000);
  fs.utimesSync(f, old, old);
  const w = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w.stop());
  await w.start();
  expect(store.getAgent('codex:019e5947-01fe-7393-b890-65ac89a98961')?.status).toBe('ended');
});

test('Claude: subagent chỉ running nếu lastEventAt trong 10 phút gần nhất', async () => {
  const line = (ageMs: number) => JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - ageMs).toISOString(), sessionId: 'sess-main', cwd: 'D:/x', message: { role: 'user', content: 'hi' } }) + '\n';
  fs.writeFileSync(mainFile(), line(1000));
  const subDir = path.join(cfg.claudeDir, 'projects', 'proj', 'sess-main', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-fresh.jsonl'), line(60_000));
  fs.writeFileSync(path.join(subDir, 'agent-stale.jsonl'), line(20 * 60_000));
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-main' }));
  const w = claudeWatcher();
  await w.start();
  expect(store.getAgent('claude:sess-main')?.status).toBe('running');
  expect(store.getAgent('claude:sess-main:fresh')?.status).toBe('running');
  expect(store.getAgent('claude:sess-main:stale')?.status).toBe('ended');
});

test('stop() dọn timer và handle của watcher', async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length;
  const before = timeouts();
  const w = createClaudeWatcher(cfg, store, () => {}, { polling: true, livenessMs: 50 });
  const w2 = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 50 });
  await w.start(); await w2.start();
  expect(timeouts()).toBeGreaterThan(before);
  await w.stop(); await w2.stop();
  await new Promise((r) => setTimeout(r, 150));
  expect(timeouts()).toBeLessThanOrEqual(before);
});
