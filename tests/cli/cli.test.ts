import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '@/src/core/config';
import { startServer } from '@/src/server/http';
import { main, type CliIo } from '@/cli/acctv';

let tmp: string;
let cfg: Config;
let srv: { url: string; close(): Promise<void> } | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-cli-'));
  cfg = { ...loadConfig({
    ACCTV_HOME: path.join(tmp, 'home'),
    ACCTV_CLAUDE_DIR: path.join(tmp, 'claude'),
    ACCTV_CODEX_DIR: path.join(tmp, 'codex'),
  }), port: 0 };
  fs.mkdirSync(cfg.home, { recursive: true });
  fs.mkdirSync(path.join(cfg.claudeDir, 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(cfg.codexDir, 'sessions'), { recursive: true });
});

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o) + '\n';
const transcript = (sid: string) => path.join(cfg.claudeDir, 'projects', 'proj', `${sid}.jsonl`);
const userLine = (sid: string, ts: number) => line({ type: 'user', timestamp: new Date(ts).toISOString(), sessionId: sid, cwd: 'D:\\Work\\demo', isSidechain: false, message: { role: 'user', content: 'hi' } });
const toolLine = (sid: string, ts: number, id: string) => line({
  type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: sid, cwd: 'D:\\Work\\demo', isSidechain: false,
  message: { id: 'msg_' + id, model: 'claude-test', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls ' + id } }] },
});

async function start(): Promise<number> {
  srv = await startServer({ cfg, withNext: false, watcher: { polling: true, livenessMs: 200 } });
  return Number(new URL(srv.url).port);
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function makeIo(signal?: AbortSignal) {
  const state = { out: '', err: '' };
  const io: CliIo = {
    stdout: { write: (s) => { state.out += s; } },
    stderr: { write: (s) => { state.err += s; } },
    color: false, width: 100, signal,
  };
  return { io, state };
}

/** Chạy lệnh lặp lại cho tới khi `ok(state)` đúng (server cần thời gian đọc file). */
async function runUntil(argv: string[], ok: (s: { out: string; err: string }) => boolean) {
  const { io, state } = makeIo();
  let code = -1;
  for (let i = 0; i < 100; i++) {
    state.out = ''; state.err = '';
    code = await main(argv, io);
    if (ok(state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { code, ...state };
}

test('ls khi server không chạy → exit 1 với thông báo hướng dẫn', async () => {
  const { io, state } = makeIo();
  const code = await main(['ls', '--port', '1'], io);
  expect(code).toBe(1);
  expect(state.err).toContain('Server chưa chạy. Bật bằng: acctv serve');
}, 20000);

test('ls --running liệt kê agent đang chạy từ server', async () => {
  const port = await start();
  const now = Date.now();
  fs.writeFileSync(transcript('sess-cli-1111'), userLine('sess-cli-1111', now - 1000) + toolLine('sess-cli-1111', now, 'tu1'));
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-cli-1111', status: 'busy' }));
  fs.writeFileSync(transcript('old-ended-9999'), userLine('old-ended-9999', now - 2000));
  const r = await runUntil(['ls', '--running', '--port', String(port)], (s) => s.out.includes('sess-cli'));
  expect(r.code).toBe(0);
  expect(r.out).toContain('sess-cli');
  expect(r.out).not.toContain('old-ende');
  const all = await runUntil(['ls', '--port', String(port)], (x) => x.out.includes('old-ende'));
  expect(all.out).toContain('old-ende');
}, 20000);

test('logs với prefix trùng nhiều agent → liệt kê và exit 1', async () => {
  const port = await start();
  const now = Date.now();
  fs.writeFileSync(transcript('dup-aaaa'), userLine('dup-aaaa', now));
  fs.writeFileSync(transcript('dup-bbbb'), userLine('dup-bbbb', now));
  const r = await runUntil(['logs', 'dup', '--port', String(port)], (s) => s.err.includes('dup-bbbb'));
  expect(r.code).toBe(1);
  expect(r.err).toContain('dup-aaaa');
  expect(r.err).toContain('dup-bbbb');
}, 20000);

test('logs in call của agent, mới nhất ở cuối và tôn trọng -n', async () => {
  const port = await start();
  const now = Date.now();
  fs.writeFileSync(transcript('log-cccc'), userLine('log-cccc', now - 5000)
    + toolLine('log-cccc', now - 3000, 'first') + toolLine('log-cccc', now - 2000, 'second') + toolLine('log-cccc', now - 1000, 'third'));
  const r = await runUntil(['logs', 'log-c', '-n', '4', '--port', String(port)], (s) => s.out.includes('third'));
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('first');
  expect(r.out.indexOf('second')).toBeGreaterThan(-1);
  expect(r.out.indexOf('third')).toBeGreaterThan(r.out.indexOf('second'));
}, 20000);

test('logs với prefix không khớp agent nào → exit 1', async () => {
  const port = await start();
  const { io, state } = makeIo();
  const code = await main(['logs', 'khong-co', '--port', String(port)], io);
  expect(code).toBe(1);
  expect(state.err).toContain('Không tìm thấy');
}, 20000);

test('watch vẽ cây, thấy call mới xuất hiện và thoát mã 0 khi nhận tín hiệu dừng', async () => {
  const port = await start();
  const now = Date.now();
  fs.writeFileSync(transcript('wat-dddd'), userLine('wat-dddd', now) + toolLine('wat-dddd', now, 'old1'));
  await runUntil(['ls', '--port', String(port)], (s) => s.out.includes('wat-dddd'.slice(0, 8)));
  const ac = new AbortController();
  const { io, state } = makeIo(ac.signal);
  const p = main(['watch', 'wat-d', '--port', String(port)], io);
  await waitFor(() => state.out.includes('ls old1'));
  fs.appendFileSync(transcript('wat-dddd'), toolLine('wat-dddd', Date.now(), 'newcall'));
  await waitFor(() => state.out.includes('ls newcall'));
  ac.abort();
  expect(await p).toBe(0);
}, 20000);
