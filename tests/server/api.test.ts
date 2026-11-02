import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type Config } from '@/src/core/config';
import { startServer } from '@/src/server/http';

let tmp: string;
let cfg: Config;
let srv: { url: string; close(): Promise<void> } | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-api-'));
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

const transcript = () => path.join(cfg.claudeDir, 'projects', 'proj', 'sess-api.jsonl');
const line = (o: unknown) => JSON.stringify(o) + '\n';
const userLine = (ts: number) => line({ type: 'user', timestamp: new Date(ts).toISOString(), sessionId: 'sess-api', cwd: 'D:\Work\demo', isSidechain: false, message: { role: 'user', content: 'hi' } });
const toolLine = (ts: number, id: string) => line({
  type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: 'sess-api', cwd: 'D:\Work\demo', isSidechain: false,
  message: { id: 'msg_' + id, model: 'claude-test', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls ' + id } }] },
});

async function start() {
  srv = await startServer({ cfg, withNext: false, watcher: { livenessMs: 200 } });
  return srv;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function rawGet(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: host ? { host } : {} }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/snapshot trả agent sau khi ghi fixture Claude', async () => {
  const now = Date.now();
  fs.writeFileSync(transcript(), userLine(now - 5000) + toolLine(now - 4000, 'toolu_1'));
  const s = await start();
  const snap = await waitFor(async () => {
    const r = await fetch(s.url + '/api/snapshot');
    const j = await r.json();
    return j.agents.length > 0 ? j : undefined;
  });
  expect(snap.agents[0].id).toBe('claude:sess-api');
  expect(Array.isArray(snap.alerts)).toBe(true);
  expect(snap.metrics).toHaveProperty('okRate1h');
  expect(snap.agentMetrics['claude:sess-api']).toBeTruthy();
  expect(typeof snap.generatedAt).toBe('number');

  const id = encodeURIComponent('claude:sess-api');
  const calls = await (await fetch(`${s.url}/api/agents/${id}/calls?limit=10`)).json();
  expect(calls.some((c: any) => c.id === 'toolu_1')).toBe(true);
  expect((await fetch(`${s.url}/api/agents/${id}/calls?limit=abc`)).status).toBe(400);
  expect((await fetch(`${s.url}/api/agents/${id}/calls?limit=5000`)).status).toBe(400);
  expect((await fetch(`${s.url}/api/agents/${id}/calls?since=x`)).status).toBe(400);
  expect((await fetch(`${s.url}/api/agents/${encodeURIComponent('claude:nope')}/calls`)).status).toBe(404);
});

test('WS nhận {type:"call"} khi có dòng tool_use mới', async () => {
  const now = Date.now();
  fs.writeFileSync(transcript(), userLine(now - 5000));
  const s = await start();
  await waitFor(async () => (await (await fetch(s.url + '/api/snapshot')).json()).agents.length > 0);
  const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws');
  const got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  fs.appendFileSync(transcript(), toolLine(Date.now(), 'toolu_ws'));
  try {
    await waitFor(() => got.find((e) => e.type === 'call' && e.call.id === 'toolu_ws'));
  } finally {
    ws.close();
  }
});

test('Host lạ → 403 (HTTP và WS upgrade)', async () => {
  const s = await start();
  expect((await rawGet(s.url + '/api/snapshot', 'evil.example.com')).status).toBe(403);
  expect((await rawGet(s.url + '/api/snapshot', 'evil.example.com:' + new URL(s.url).port)).status).toBe(403);
  expect((await rawGet(s.url + '/api/snapshot', 'localhost:' + new URL(s.url).port)).status).toBe(200);
  const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws', { headers: { host: 'evil.example.com' } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => reject(new Error('should not open')));
    ws.on('error', () => resolve());
    ws.on('unexpected-response', () => resolve());
  });
});

test('server chỉ listen 127.0.0.1', async () => {
  const s = await start();
  expect(new URL(s.url).hostname).toBe('127.0.0.1');
  expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

function rawRequest(url: string, p: string): Promise<{ status?: number; closed: boolean }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET' }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, closed: false });
    });
    req.on('error', () => resolve({ closed: true }));
    req.end();
  });
}

test('URL malformed (//, //a:b) không làm sập server', async () => {
  const s = await start();
  for (const p of ['//', '//a:b']) {
    const r = await rawRequest(s.url, p);
    expect(r.closed || r.status === 400).toBe(true);
  }
  // upgrade with malformed path
  const u = new URL(s.url);
  const result = await new Promise<string>((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '//a:b', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (_r, sock) => { sock.destroy(); resolve('upgraded'); });
    req.on('response', (res) => { res.resume(); resolve('status ' + res.statusCode); });
    req.on('error', () => resolve('closed'));
    req.end();
  });
  expect(result).not.toBe('upgraded');
  expect((await fetch(s.url + '/api/snapshot')).status).toBe(200);
});

test('WS: Origin lạ bị từ chối; không Origin / cùng Origin được nhận', async () => {
  const s = await start();
  const wsUrl = s.url.replace('http', 'ws') + '/ws';
  const open = (headers?: Record<string, string>) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(wsUrl, { headers });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', () => resolve(false));
  });
  expect(await open({ Origin: 'http://evil.example.com' })).toBe(false);
  expect(await open({ Origin: 'http://127.0.0.1:1' })).toBe(false);
  expect(await open()).toBe(true);
  expect(await open({ Origin: s.url })).toBe(true);
  expect(await open({ Origin: 'http://localhost:' + new URL(s.url).port })).toBe(true);
});

test('snapshot dùng cửa sổ backfillHours: agent 48h tuổi hiện khi 72h, ẩn khi 24h', async () => {
  const old = Date.now() - 48 * 3600_000;
  for (const [hours, visible] of [[72, true], [24, false]] as const) {
    fs.writeFileSync(transcript(), userLine(old) + toolLine(old + 1000, 'toolu_old'));
    cfg.backfillHours = hours;
    const s = await start();
    await waitFor(async () => (await (await fetch(`${s.url}/api/agents/${encodeURIComponent('claude:sess-api')}/calls`)).status) === 200);
    const snap = await (await fetch(s.url + '/api/snapshot')).json();
    expect(snap.agents.some((a: any) => a.id === 'claude:sess-api')).toBe(visible);
    await s.close();
    srv = undefined;
    fs.rmSync(cfg.home, { recursive: true, force: true });
    fs.mkdirSync(cfg.home, { recursive: true });
  }
});

test('server trả /api/snapshot ngay khi backfill lớn còn đang chạy; log tiến độ backfill', async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    const N = 400;
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      const sid = `bulk-${String(i).padStart(4, '0')}`;
      const body = Array.from({ length: 40 }, (_, k) => line({ type: 'user', timestamp: new Date(now - 60_000 + k).toISOString(), sessionId: sid, cwd: 'D:/Work/bulk', message: { role: 'user', content: 'x'.repeat(200) } })).join('');
      fs.writeFileSync(path.join(cfg.claudeDir, 'projects', 'proj', `${sid}.jsonl`), body);
    }
    const s = await start();
    let done = false;
    const backfilled = (s as unknown as { backfilled: Promise<void> }).backfilled;
    void backfilled.then(() => { done = true; });
    const r = await fetch(s.url + '/api/snapshot');
    expect(r.status).toBe(200);
    const early = await r.json();
    expect(done).toBe(false);
    expect(early.agents.length).toBeLessThan(N);
    await backfilled;
    const late = await (await fetch(s.url + '/api/snapshot')).json();
    expect(late.agents.length).toBe(N);
    expect(logs.some((l) => l.startsWith('[acctv] backfill:') && l.includes(`${N}/${N}`))).toBe(true);
  } finally {
    console.log = origLog;
  }
}, 60000);
