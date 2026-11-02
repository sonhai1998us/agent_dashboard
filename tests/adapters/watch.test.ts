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
  await w.start(); await w.backfilled();
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
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main')).toBeUndefined();
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  await waitFor(() => store.getAgent('claude:sess-main') !== undefined && store.listCalls('claude:sess-main').length > 0);
});

test('file cũ hơn backfillHours bị bỏ qua', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(mainFile(), old, old);
  const w = claudeWatcher();
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main')).toBeUndefined();
});

test('khởi động lại watcher với cùng DB → không nhân đôi call', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  const w1 = claudeWatcher();
  await w1.start(); await w1.backfilled();
  const before = store.listCalls('claude:sess-main');
  const off = store.getOffset(mainFile());
  expect(off && off.offset > 0).toBe(true);
  await w1.stop();
  const w2 = claudeWatcher();
  await w2.start(); await w2.backfilled();
  expect(store.listCalls('claude:sess-main')).toEqual(before);
  // an appended line after restart is still picked up exactly once
  fs.appendFileSync(mainFile(), JSON.stringify({ type: 'user', timestamp: '2026-11-02T11:00:00.000Z', sessionId: 'sess-main', message: { role: 'user', content: 'tiếp' } }) + '\n');
  await waitFor(() => (store.getOffset(mainFile())?.offset ?? 0) === fs.statSync(mainFile()).size);
  expect(store.listCalls('claude:sess-main')).toEqual(before);
});

test('sessions/<pid>.json với pid = process.pid → agent running; pid chết → ended', async () => {
  fs.writeFileSync(mainFile(), fxClaude('main.jsonl'));
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-main', cwd: 'x', status: 'busy', updatedAt: Date.now() }));
  const w = claudeWatcher();
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main')?.status).toBe('running');
  expect(store.getAgent('claude:sess-main')?.pid).toBe(process.pid);
  await w.stop();
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: 2 ** 22 + 12345, sessionId: 'sess-main' }));
  const w2 = claudeWatcher();
  await w2.start(); await w2.backfilled();
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
  await w1.start(); await w1.backfilled(); await w2.start(); await w2.backfilled();
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
  await w.start(); await w.backfilled();
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
  await w.start(); await w.backfilled();
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
  await w.start(); await w.backfilled();
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
  await w.start(); await w.backfilled();
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
  await w.start(); await w.backfilled();
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
  await w.start(); await w.backfilled();
  expect(store.getAgent('codex:019e5947-01fe-7393-b890-65ac89a98961')?.status).toBe('ended');
});

const recLine = (o: object) => JSON.stringify({ timestamp: new Date().toISOString(), sessionId: 'sess-main', cwd: 'D:/x', ...o }) + '\n';
const userRec = () => recLine({ type: 'user', message: { role: 'user', content: 'hi' } });
const asstRec = (stop: string) => recLine({ type: 'assistant', message: { id: 'm' + Math.random(), role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } });
const sessionFile = (pid: number, status: string) => fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid, sessionId: 'sess-main', status }));
const subDir = () => path.join(cfg.claudeDir, 'projects', 'proj', 'sess-main', 'subagents');

test('Claude main: pid sống + busy → running, idle → idle', async () => {
  fs.writeFileSync(mainFile(), userRec());
  sessionFile(process.pid, 'idle');
  const w = claudeWatcher();
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main')?.status).toBe('idle');
  await w.stop();
  sessionFile(process.pid, 'busy');
  const w2 = claudeWatcher();
  await w2.start(); await w2.backfilled();
  expect(store.getAgent('claude:sess-main')?.status).toBe('running');
});

test('Claude subagent kết thúc bằng end_turn → ended dù pid cha còn sống; bị resume sau end_turn → running', async () => {
  fs.writeFileSync(mainFile(), userRec());
  fs.mkdirSync(subDir(), { recursive: true });
  fs.writeFileSync(path.join(subDir(), 'agent-done.jsonl'), userRec() + asstRec('end_turn'));
  fs.writeFileSync(path.join(subDir(), 'agent-resumed.jsonl'), userRec() + asstRec('end_turn') + userRec());
  fs.writeFileSync(path.join(subDir(), 'agent-working.jsonl'), userRec() + asstRec('tool_use')); // tool_use, no end_turn
  sessionFile(process.pid, 'busy');
  const w = claudeWatcher();
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main:done')?.status).toBe('ended');
  expect(store.getAgent('claude:sess-main:resumed')?.status).toBe('running');
  expect(store.getAgent('claude:sess-main:working')?.status).toBe('running');
});

const handbackRec = (id: string) => recLine({ type: 'assistant', message: { id: 'm' + Math.random(), role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'SubagentHandback', input: { message: 'done' } }] } });
const toolResultRec = (id: string) => recLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('Claude subagent kết thúc bằng SubagentHandback → ended dù pid cha còn sống; resume sau handback → running', async () => {
  fs.writeFileSync(mainFile(), userRec());
  fs.mkdirSync(subDir(), { recursive: true });
  fs.writeFileSync(path.join(subDir(), 'agent-handed.jsonl'), userRec() + asstRec('tool_use') + handbackRec('hb1') + toolResultRec('hb1'));
  fs.writeFileSync(path.join(subDir(), 'agent-again.jsonl'), userRec() + handbackRec('hb2') + toolResultRec('hb2') + userRec());
  const writeRec = recLine({ type: 'assistant', message: { id: 'mw', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w3', name: 'Write', input: {} }] } });
  fs.writeFileSync(path.join(subDir(), 'agent-multi.jsonl'), userRec() + writeRec + handbackRec('hb3') + toolResultRec('w3') + toolResultRec('hb3'));
  fs.writeFileSync(path.join(subDir(), 'agent-multi2.jsonl'), userRec() + writeRec + handbackRec('hb4') + toolResultRec('w3') + toolResultRec('hb4') + userRec());
  sessionFile(process.pid, 'busy');
  const w = claudeWatcher();
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main:handed')?.status).toBe('ended');
  expect(store.getAgent('claude:sess-main:again')?.status).toBe('running');
  expect(store.getAgent('claude:sess-main:multi')?.status).toBe('ended');
  expect(store.getAgent('claude:sess-main:multi2')?.status).toBe('running');
});

test('Claude: cha chết → các subagent chưa ended bị hạ xuống ended', async () => {
  fs.writeFileSync(mainFile(), userRec());
  fs.mkdirSync(subDir(), { recursive: true });
  fs.writeFileSync(path.join(subDir(), 'agent-resumed.jsonl'), userRec() + asstRec('end_turn') + userRec());
  sessionFile(process.pid, 'busy');
  const w = createClaudeWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100 });
  closers.push(() => w.stop());
  await w.start(); await w.backfilled();
  expect(store.getAgent('claude:sess-main:resumed')?.status).toBe('running');
  sessionFile(2 ** 22 + 12345, 'busy');
  await waitFor(() => store.getAgent('claude:sess-main:resumed')?.status === 'ended');
  expect(store.getAgent('claude:sess-main')?.status).toBe('ended');
});

test('stop() dọn timer và handle của watcher', async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length;
  const before = timeouts();
  const w = createClaudeWatcher(cfg, store, () => {}, { polling: true, livenessMs: 50 });
  const w2 = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 50 });
  await w.start(); await w.backfilled(); await w2.start(); await w2.backfilled();
  expect(timeouts()).toBeGreaterThan(before);
  await w.stop(); await w2.stop();
  await new Promise((r) => setTimeout(r, 150));
  expect(timeouts()).toBeLessThanOrEqual(before);
});

const codexDir = () => path.join(cfg.codexDir, 'sessions', '2026', '11', '02');
const codexRec = (ts: number, type: string, payload: object) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type, payload }) + '\n';
const codexFile = (uuid: string) => path.join(codexDir(), `rollout-2026-11-02T09-18-10-${uuid}.jsonl`);

test('Codex: turn đang mở, 6 phút không ghi → vẫn running và long_tool bật cho call đang mở', async () => {
  const { DetectEngine } = await import('@/src/detect/engine');
  const uuid = '019e5950-0000-7000-8000-000000000010';
  const t0 = Date.now() - 6 * 60_000;
  fs.writeFileSync(codexFile(uuid), codexRec(t0, 'session_meta', { id: uuid, cwd: 'D:/Work/x' })
    + codexRec(t0 + 1, 'event_msg', { type: 'task_started' })
    + codexRec(t0 + 2, 'response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"npm run build"}', call_id: 'call_long' }));
  const old = new Date(t0 + 2);
  fs.utimesSync(codexFile(uuid), old, old);
  const w = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w.stop());
  await w.start(); await w.backfilled();
  expect(store.getAgent(`codex:${uuid}`)?.status).toBe('running');
  new DetectEngine(store, cfg, () => {}).tick(Date.now());
  expect(store.activeAlerts()).toContainEqual(expect.objectContaining({ agentId: `codex:${uuid}`, kind: 'long_tool', active: true }));
});

test('Codex: turn đã đóng → idle dù file vừa ghi', async () => {
  const uuid = '019e5951-0000-7000-8000-000000000011';
  const t0 = Date.now() - 1000;
  fs.writeFileSync(codexFile(uuid), codexRec(t0, 'session_meta', { id: uuid }) + codexRec(t0 + 1, 'event_msg', { type: 'task_started' }) + codexRec(t0 + 2, 'event_msg', { type: 'task_complete' }));
  const w = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w.stop());
  await w.start(); await w.backfilled();
  expect(store.getAgent(`codex:${uuid}`)?.status).toBe('idle');
});

test('Codex: ctx resumed (chưa thấy task_*) → running nếu file ghi trong 120s, idle nếu cũ hơn', async () => {
  const fresh = '019e5952-0000-7000-8000-000000000012';
  const stale = '019e5953-0000-7000-8000-000000000013';
  const t0 = Date.now() - 10 * 60_000;
  for (const u of [fresh, stale]) {
    fs.writeFileSync(codexFile(u), codexRec(t0, 'session_meta', { id: u }) + codexRec(t0 + 1, 'event_msg', { type: 'task_started' }) + codexRec(t0 + 2, 'event_msg', { type: 'task_complete' }));
  }
  const w1 = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  await w1.start(); await w1.backfilled();
  await w1.stop();
  expect(store.getAgent(`codex:${fresh}`)?.status).toBe('idle');
  // tiếp tục ghi khi server tắt: lượt mới đã bắt đầu trước offset đã lưu? không biết → dựa vào mtime
  for (const u of [fresh, stale]) fs.appendFileSync(codexFile(u), codexRec(Date.now() - 1000, 'response_item', { type: 'function_call', name: 'shell_command', arguments: '{}', call_id: 'c-' + u }));
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(codexFile(stale), old, old);
  const w2 = createCodexWatcher(cfg, store, () => {}, { polling: true, livenessMs: 100000 });
  closers.push(() => w2.stop());
  await w2.start(); await w2.backfilled();
  expect(store.getAgent(`codex:${fresh}`)?.status).toBe('running');
  expect(store.getAgent(`codex:${stale}`)?.status).toBe('idle');
});
