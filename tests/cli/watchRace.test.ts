import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WebSocket của CLI nối chậm: mọi sự kiện server phát trước khi socket mở đều bị mất.
vi.mock('ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('ws')>();
  const { EventEmitter } = await import('node:events');
  class SlowWebSocket extends EventEmitter {
    private inner: InstanceType<typeof real.WebSocket> | undefined;
    private dead = false;
    constructor(url: string) {
      super();
      setTimeout(() => {
        if (this.dead) return;
        const ws = new real.WebSocket(url);
        this.inner = ws;
        for (const ev of ['open', 'message', 'error', 'close']) ws.on(ev, (...a: unknown[]) => this.emit(ev, ...a));
      }, 800);
    }
    terminate(): void { this.dead = true; this.inner?.terminate(); }
  }
  return { ...real, WebSocket: SlowWebSocket };
});

const { loadConfig } = await import('@/src/core/config');
const { startServer } = await import('@/src/server/http');
const { main } = await import('@/cli/acctv');

let tmp: string;
let srv: { url: string; close(): Promise<void> } | undefined;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-race-')); });
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('watch: call ghi trong lúc WebSocket chưa mở vẫn hiện ra (đồng bộ lại sau khi socket mở)', async () => {
  const cfg = { ...loadConfig({ ACCTV_HOME: path.join(tmp, 'home'), ACCTV_CLAUDE_DIR: path.join(tmp, 'claude'), ACCTV_CODEX_DIR: path.join(tmp, 'codex') }), port: 0 };
  const proj = path.join(cfg.claudeDir, 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 'race-eeee.jsonl');
  const rec = (ts: number, id: string) => JSON.stringify({
    type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: 'race-eeee', cwd: 'D:/Work/demo',
    message: { id: 'msg_' + id, model: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls ' + id } }] },
  }) + '\n';
  fs.writeFileSync(f, rec(Date.now(), 'old1'));
  srv = await startServer({ cfg, withNext: false, watcher: { livenessMs: 200 } });
  await (srv as unknown as { backfilled: Promise<void> }).backfilled;
  const port = new URL(srv.url).port;
  const ac = new AbortController();
  let out = '';
  const io = { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => {} }, color: false, width: 100, signal: ac.signal };
  const p = main(['watch', 'race-e', '--port', port], io);
  const t0 = Date.now();
  while (!out.includes('ls old1')) {
    if (Date.now() - t0 > 10000) throw new Error('never drew old1');
    await new Promise((r) => setTimeout(r, 20));
  }
  fs.appendFileSync(f, rec(Date.now(), 'mid1')); // server đọc và phát trước khi socket của CLI mở
  const t1 = Date.now();
  while (!out.includes('ls mid1')) {
    if (Date.now() - t1 > 8000) { ac.abort(); await p; throw new Error('watch never showed mid1'); }
    await new Promise((r) => setTimeout(r, 50));
  }
  ac.abort();
  expect(await p).toBe(0);
}, 60000);
