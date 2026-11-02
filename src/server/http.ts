import http from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from '@/src/core/config';
import { agentMetrics, globalMetrics, type AgentMetrics } from '@/src/core/metrics';
import type { WatcherOptions } from '@/src/adapters/watchBase';
import { createCore, type Core } from './core';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const METRICS_MS = 5000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function safeUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? '/', 'http://x');
  } catch {
    return null;
  }
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function parseIntParam(v: string | null, def: number, min: number, max: number): number | null {
  if (v === null) return def;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

function liveMetrics(core: Core, now: number) {
  return globalMetrics(
    core.store.listAgents({ since: now - DAY_MS }),
    core.store.recentCalls(now - HOUR_MS),
    core.store.activeAlerts(),
    now,
  );
}

export function attachApi(server: http.Server, core: Core): Handler {
  return (req, res) => {
    const port = (server.address() as { port: number } | null)?.port ?? 0;
    if (!hostAllowed(req.headers.host, port)) { sendJson(res, 403, { error: 'forbidden host' }); return true; }
    const url = safeUrl(req.url);
    if (!url) { sendJson(res, 400, { error: 'bad request url' }); return true; }
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return false;
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }

    try {
      if (url.pathname === '/api/snapshot') {
        const now = Date.now();
        const agents = core.store.listAgents({ since: now - DAY_MS });
        const agentM: Record<string, AgentMetrics> = {};
        for (const a of agents) agentM[a.id] = agentMetrics(a, core.store.listCalls(a.id, { limit: 2000 }), now);
        sendJson(res, 200, {
          generatedAt: now, agents, alerts: core.store.activeAlerts(),
          metrics: liveMetrics(core, now), agentMetrics: agentM,
        });
        return true;
      }
      const m = /^\/api\/agents\/([^/]+)\/calls$/.exec(url.pathname);
      if (m) {
        let id: string;
        try { id = decodeURIComponent(m[1]); } catch { sendJson(res, 400, { error: 'bad agent id' }); return true; }
        const limit = parseIntParam(url.searchParams.get('limit'), 500, 1, 2000);
        const since = parseIntParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
        if (limit === null) { sendJson(res, 400, { error: 'limit must be an integer 1..2000' }); return true; }
        if (since === null) { sendJson(res, 400, { error: 'since must be a non-negative integer (ms)' }); return true; }
        if (!core.store.getAgent(id)) { sendJson(res, 404, { error: 'agent not found' }); return true; }
        sendJson(res, 200, core.store.listCalls(id, { since, limit }));
        return true;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}

function rejectUpgrade(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export interface StartOptions {
  cfg?: Config;
  dev?: boolean;
  withNext?: boolean;
  /** Passed to the file watchers (tests use polling). */
  watcher?: WatcherOptions;
}

export async function startServer(opts: StartOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const cfg = opts.cfg ?? loadConfig();
  const core = await createCore(cfg, opts.watcher);
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let metricsTimer: NodeJS.Timeout | undefined;
  let nextApp: { close(): Promise<void> } | undefined;

  try {
    const api = attachApi(server, core);
    let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | undefined;
    let nextUpgrade: ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) | undefined;

    if (opts.withNext) {
      const dev = opts.dev ?? process.env.NODE_ENV !== 'production';
      const { default: next } = await import('next');
      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      const app = next({ dev, dir: projectRoot, hostname: cfg.host, port: cfg.port });
      await app.prepare();
      nextApp = app;
      nextHandler = app.getRequestHandler();
      nextUpgrade = app.getUpgradeHandler();
    }

    const port = () => (server.address() as { port: number }).port;

    server.on('request', (req, res) => {
      if (api(req, res)) return;
      if (!hostAllowed(req.headers.host, port())) { sendJson(res, 403, { error: 'forbidden host' }); return; }
      if (!nextHandler) { sendJson(res, 404, { error: 'not found' }); return; }
      nextHandler(req, res).catch((err) => {
        console.warn(`[acctv] next handler failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
      });
    });

    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => { /* client vanished */ });
      if (!hostAllowed(req.headers.host, port())) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
      if (!originAllowed(req.headers.origin, port())) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
      const parsed = safeUrl(req.url);
      if (!parsed) { socket.destroy(); return; }
      if (parsed.pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          clients.add(ws);
          ws.on('close', () => clients.delete(ws));
          ws.on('error', () => clients.delete(ws));
        });
      } else if (nextUpgrade) {
        nextUpgrade(req, socket, head).catch(() => socket.destroy());
      } else {
        rejectUpgrade(socket, 404, 'Not Found');
      }
    });

    const broadcast = (payload: unknown): void => {
      const s = JSON.stringify(payload);
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
    };
    const unsub = core.hub.subscribe((e) => broadcast(e));
    metricsTimer = setInterval(() => {
      try {
        const at = Date.now();
        broadcast({ type: 'metrics', metrics: liveMetrics(core, at), at });
      } catch { /* store may be closing */ }
    }, METRICS_MS);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
    });

    let closed = false;
    return {
      url: `http://${cfg.host}:${port()}`,
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(metricsTimer);
        unsub();
        for (const ws of clients) ws.terminate();
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await nextApp?.close().catch(() => {});
        await core.stop();
      },
    };
  } catch (err) {
    clearInterval(metricsTimer);
    wss.close();
    await nextApp?.close().catch(() => {});
    await core.stop();
    throw err;
  }
}
