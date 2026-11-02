import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig } from '@/src/core/config';
import type { AgentInfo, Alert, CallRecord, HubEvent } from '@/src/core/model';
import type { AgentMetrics } from '@/src/core/metrics';
import { renderList, renderLogs, renderWatch } from './render';

export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  color: boolean;
  width: number;
  /** Huỷ để dừng `serve`/`watch` (Ctrl+C). */
  signal?: AbortSignal;
}

interface Snapshot {
  agents: AgentInfo[];
  alerts: Alert[];
  agentMetrics: Record<string, AgentMetrics>;
}

const NOT_RUNNING = 'Server chưa chạy. Bật bằng: acctv serve';
const USAGE = `Dùng: acctv <lệnh> [tuỳ chọn]

  serve [--port N] [--dev]      Bật server + giao diện
  ls [--running]                Liệt kê agent
  watch <id-prefix>             Theo dõi trực tiếp một agent
  logs <id-prefix> [-n 50]      In các call gần nhất của agent

Mọi lệnh nhận --port N (mặc định 4777).`;

class CliError extends Error {}

interface Parsed { positional: string[]; port?: number; dev: boolean; running: boolean; n: number; help: boolean; }

function parseArgs(args: string[]): Parsed {
  const out: Parsed = { positional: [], dev: false, running: false, n: 50, help: false };
  const intArg = (flag: string, v: string | undefined): number => {
    if (v === undefined || !/^\d+$/.test(v)) throw new CliError(`${flag} cần một số nguyên không âm`);
    return Number(v);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') out.port = intArg('--port', args[++i]);
    else if (a === '-n') out.n = intArg('-n', args[++i]);
    else if (a === '--dev') out.dev = true;
    else if (a === '--running') out.running = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('-')) throw new CliError(`Tuỳ chọn không hợp lệ: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

class Api {
  constructor(readonly port: number) {}
  get base(): string { return `http://127.0.0.1:${this.port}`; }

  async get<T>(p: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + p);
    } catch {
      throw new CliError(NOT_RUNNING);
    }
    if (!res.ok) throw new CliError(`Server trả lỗi ${res.status} cho ${p}`);
    return (await res.json()) as T;
  }

  snapshot(): Promise<Snapshot> { return this.get<Snapshot>('/api/snapshot'); }
  calls(id: string, limit: number): Promise<CallRecord[]> {
    return this.get<CallRecord[]>(`/api/agents/${encodeURIComponent(id)}/calls?limit=${Math.min(Math.max(limit, 1), 2000)}`);
  }
}

/** Khớp prefix với sessionId, agentId (phần cuối của id) hoặc id đầy đủ. */
function matchAgents(agents: AgentInfo[], prefix: string): AgentInfo[] {
  const bySession = agents.filter((a) => a.sessionId.startsWith(prefix));
  const sessions = new Set(bySession.map((a) => a.sessionId));
  if (sessions.size === 1) {
    // Prefix chỉ định một phiên: chọn agent gốc, không phải từng subagent.
    const root = bySession.filter((a) => a.parentId === null || !bySession.some((b) => b.id === a.parentId));
    if (root.length === 1) return root;
  }
  const found = new Map<string, AgentInfo>();
  for (const a of bySession) found.set(a.id, a);
  for (const a of agents) {
    const agentPart = a.id.split(':')[2];
    if (a.id.startsWith(prefix) || (agentPart !== undefined && agentPart.startsWith(prefix))) found.set(a.id, a);
  }
  return [...found.values()];
}

function resolveAgent(snap: Snapshot, prefix: string | undefined, io: CliIo): AgentInfo | null {
  if (!prefix) { io.stderr.write('Thiếu id-prefix.\n' + USAGE + '\n'); return null; }
  const m = matchAgents(snap.agents, prefix);
  if (m.length === 0) { io.stderr.write(`Không tìm thấy agent nào khớp "${prefix}".\n`); return null; }
  if (m.length > 1) {
    io.stderr.write(`"${prefix}" khớp ${m.length} agent, hãy gõ dài hơn:\n`);
    io.stderr.write(renderList(m, snap.alerts, io.color) + '\n');
    return null;
  }
  return m[0];
}

async function cmdServe(p: Parsed, io: CliIo): Promise<number> {
  const cfg = loadConfig();
  if (p.port !== undefined) cfg.port = p.port;
  if (!p.dev) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) {
      io.stderr.write('Chưa build giao diện. Chạy: npm run build (hoặc dùng --dev)\n');
      return 1;
    }
  }
  const { startServer } = await import('@/src/server/http');
  let srv: { url: string; close(): Promise<void> };
  try {
    srv = await startServer({ cfg, dev: p.dev, withNext: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    io.stderr.write(code === 'EADDRINUSE' ? `Cổng ${cfg.port} đang bận. Dùng --port N khác.\n` : `Không bật được server: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stdout.write(`Agent CCTV đang chạy tại ${srv.url}\n`);
  await new Promise<void>((resolve) => {
    if (!io.signal) return; // không có tín hiệu dừng: chạy mãi
    if (io.signal.aborted) resolve();
    else io.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await srv.close();
  return 0;
}

async function cmdLs(api: Api, p: Parsed, io: CliIo): Promise<number> {
  const snap = await api.snapshot();
  const agents = p.running ? snap.agents.filter((a) => a.status === 'running') : snap.agents;
  const counts: Record<string, number> = {};
  for (const a of agents) {
    const m = snap.agentMetrics[a.id];
    if (m) counts[a.id] = m.calls;
  }
  io.stdout.write(renderList(agents, snap.alerts, io.color, counts) + '\n');
  return 0;
}

async function cmdLogs(api: Api, p: Parsed, io: CliIo): Promise<number> {
  const agent = resolveAgent(await api.snapshot(), p.positional[1], io);
  if (!agent) return 1;
  const calls = await api.calls(agent.id, p.n);
  const last = calls.slice(0, p.n).reverse(); // API: mới nhất trước → in mới nhất ở cuối
  io.stdout.write(last.length ? renderLogs(last, io.width, io.color) + '\n' : '(chưa có call)\n');
  return 0;
}

const REDRAW_MS = 250;
const CLEAR = '\x1b[2J\x1b[H';

async function cmdWatch(api: Api, p: Parsed, io: CliIo): Promise<number> {
  const snap = await api.snapshot();
  const target = resolveAgent(snap, p.positional[1], io);
  if (!target) return 1;

  const agents = new Map<string, AgentInfo>(snap.agents.map((a) => [a.id, a]));
  const alerts = new Map<string, Alert>(snap.alerts.map((a) => [a.id, a]));
  const calls = new Map<string, CallRecord[]>(); // mới nhất trước
  const loaded = new Set<string>();
  let disconnected = false;

  const loadCalls = async (id: string): Promise<void> => {
    if (loaded.has(id)) return;
    loaded.add(id);
    try {
      const fetched = await api.calls(id, 30);
      const have = calls.get(id) ?? [];
      const ids = new Set(have.map((c) => c.id));
      const merged = [...have, ...fetched.filter((c) => !ids.has(c.id))].sort((a, b) => b.startedAt - a.startedAt);
      calls.set(id, merged);
    } catch { loaded.delete(id); }
  };

  const draw = (): void => {
    const all = [...agents.values()];
    const root = agents.get(target.id) ?? target;
    const text = renderWatch(root, all, Object.fromEntries(calls), [...alerts.values()].filter((a) => a.active), io.width, io.color);
    const banner = disconnected ? `${io.color ? '\x1b[31m' : ''}mất kết nối, đang thử nối lại…${io.color ? '\x1b[0m' : ''}\n` : '';
    io.stdout.write(CLEAR + banner + text + '\n');
  };

  let lastDraw = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (timer || stopped) return;
    const wait = Math.max(0, lastDraw + REDRAW_MS - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      lastDraw = Date.now();
      draw();
    }, wait);
  };

  const subtreeIds = (): string[] => {
    const ids = new Set<string>([target.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of agents.values()) if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) { ids.add(a.id); grew = true; }
    }
    return [...ids];
  };

  const onEvent = (e: HubEvent): void => {
    if (e.type === 'agent') {
      agents.set(e.agent.id, e.agent);
      void loadCalls(e.agent.id).then(schedule);
    } else if (e.type === 'call') {
      const list = calls.get(e.call.agentId) ?? [];
      const i = list.findIndex((c) => c.id === e.call.id);
      if (i >= 0) list[i] = e.call; else list.unshift(e.call);
      list.sort((a, b) => b.startedAt - a.startedAt);
      calls.set(e.call.agentId, list.slice(0, 200));
    } else if (e.type === 'alert') {
      alerts.set(e.alert.id, e.alert);
    }
    schedule();
  };

  const initial = async (): Promise<void> => {
    await Promise.all(subtreeIds().map(loadCalls));
    draw();
    lastDraw = Date.now();
  };
  await initial();

  return new Promise<number>((resolve) => {
    let ws: WebSocket | undefined;
    let retry: NodeJS.Timeout | undefined;
    let delay = 1000;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(retry);
      try { ws?.terminate(); } catch { /* đã đóng */ }
      resolve(0);
    };

    const resync = async (): Promise<void> => {
      try {
        const s = await api.snapshot();
        for (const a of s.agents) agents.set(a.id, a);
        alerts.clear();
        for (const a of s.alerts) alerts.set(a.id, a);
        loaded.clear();
        calls.clear();
        await Promise.all(subtreeIds().map(loadCalls));
      } catch { /* ws sẽ tự báo lỗi nếu server vẫn chết */ }
    };

    const connect = (): void => {
      if (done) return;
      const sock = new WebSocket(`ws://127.0.0.1:${api.port}/ws`);
      ws = sock;
      let opened = false;
      sock.on('open', () => {
        opened = true;
        delay = 1000;
        if (disconnected) {
          disconnected = false;
          void resync().then(schedule);
        }
      });
      sock.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as { type?: string };
          if (msg.type === 'agent' || msg.type === 'call' || msg.type === 'alert') onEvent(msg as HubEvent);
        } catch { /* bỏ qua tin nhắn hỏng */ }
      });
      sock.on('error', () => { /* 'close' sẽ xử lý */ });
      sock.on('close', () => {
        if (done) return;
        if (opened || !disconnected) { disconnected = true; schedule(); }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      });
    };

    if (io.signal?.aborted) { finish(); return; }
    io.signal?.addEventListener('abort', finish, { once: true });
    connect();
  });
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 1;
  }
  const cmd = p.positional[0];
  if (!cmd || p.help || cmd === 'help') { io.stdout.write(USAGE + '\n'); return cmd || p.help ? 0 : 1; }

  try {
    if (cmd === 'serve') return await cmdServe(p, io);
    const api = new Api(p.port ?? loadConfig().port);
    if (cmd === 'ls') return await cmdLs(api, p, io);
    if (cmd === 'logs') return await cmdLogs(api, p, io);
    if (cmd === 'watch') return await cmdWatch(api, p, io);
    io.stderr.write(`Lệnh không biết: ${cmd}\n${USAGE}\n`);
    return 1;
  } catch (err) {
    io.stderr.write(`${err instanceof CliError ? err.message : `Lỗi: ${err instanceof Error ? err.message : String(err)}`}\n`);
    return 1;
  }
}
