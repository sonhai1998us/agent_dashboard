import http from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from '@/src/core/config';
import type { WatcherOptions } from '@/src/adapters/watchBase';
import { createCore, type Core, type Runners } from './core';
import { handleApi, liveMetrics, originAllowed, sendJson } from './routes';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

const METRICS_MS = 5000;

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

/** Nhận `/api/*` và `/mcp` (route ở routes.ts); path khác trả false để giao cho Next. */
export function attachApi(server: http.Server, core: Core): Handler {
  return (req, res) => {
    const port = (server.address() as { port: number } | null)?.port ?? 0;
    if (!hostAllowed(req.headers.host, port)) { sendJson(res, 403, { error: 'forbidden host' }); return true; }
    const url = safeUrl(req.url);
    if (!url) { sendJson(res, 400, { error: 'bad request url' }); return true; }
    const p = url.pathname;
    if (p !== '/mcp' && p !== '/api' && !p.startsWith('/api/')) return false;
    void handleApi(req, res, url, core, port);
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
  /** Runner thay cho CLI thật (test). Không truyền: dò `claude` trên máy. */
  runners?: Runners;
}

export interface RunningServer {
  url: string;
  /** Resolves when the background backfill of existing logs has finished. */
  backfilled: Promise<void>;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const cfg = opts.cfg ?? loadConfig();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let metricsTimer: NodeJS.Timeout | undefined;
  let nextApp: { close(): Promise<void> } | undefined;
  let core: Core | undefined;

  // Requests that arrive while the core / Next are still being set up wait for this.
  let markReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => { markReady = r; });
  let onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => {};
  let onUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void = (_r, socket) => socket.destroy();
  server.on('request', (req, res) => {
    void ready.then((ok) => {
      if (ok) onRequest(req, res);
      else sendJson(res, 503, { error: 'server is shutting down' });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* client vanished */ });
    void ready.then((ok) => (ok ? onUpgrade(req, socket, head) : socket.destroy()));
  });

  // Bind the port before touching the DB: a second instance must fail here, never wipe the live DB.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
  });
  const port = () => (server.address() as { port: number }).port;

  try {
    core = await createCore(cfg, opts.watcher, { runners: opts.runners, port });
    const c = core;
    const api = attachApi(server, c);
    let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | undefined;
    let nextUpgrade: ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) | undefined;

    if (opts.withNext) {
      const dev = opts.dev ?? process.env.NODE_ENV !== 'production';
      const { default: next } = await import('next');
      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      const app = next({ dev, dir: projectRoot, hostname: cfg.host, port: port() });
      await app.prepare();
      nextApp = app;
      nextHandler = app.getRequestHandler();
      nextUpgrade = app.getUpgradeHandler();
    }

    onRequest = (req, res) => {
      if (api(req, res)) return;
      if (!hostAllowed(req.headers.host, port())) { sendJson(res, 403, { error: 'forbidden host' }); return; }
      if (!nextHandler) { sendJson(res, 404, { error: 'not found' }); return; }
      nextHandler(req, res).catch((err) => {
        console.warn(`[acctv] next handler failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
      });
    };

    onUpgrade = (req, socket, head) => {
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
    };

    const broadcast = (payload: unknown): void => {
      const s = JSON.stringify(payload);
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
    };
    const unsub = c.hub.subscribe((e) => broadcast(e));
    metricsTimer = setInterval(() => {
      try {
        const at = Date.now();
        broadcast({ type: 'metrics', metrics: liveMetrics(c, at), at });
      } catch { /* store may be closing */ }
    }, METRICS_MS);
    markReady(true);

    let closed = false;
    return {
      url: `http://${cfg.host}:${port()}`,
      backfilled: c.backfilled(),
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
        await c.stop();
      },
    };
  } catch (err) {
    markReady(false);
    clearInterval(metricsTimer);
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await nextApp?.close().catch(() => {});
    await core?.stop();
    throw err;
  }
}
