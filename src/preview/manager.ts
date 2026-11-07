import type { HubEvent } from '@/src/core/model';
import { killTree } from '@/src/runner/proc';
import { LoginError, TicketBrowser, findBrowser as defaultFindBrowser } from './browser';
import { LIMITS, formatError, formatResult, redact, validateCaptureArgs, type CaptureErrorCode, type CaptureResult } from './captureArgs';
import { resolveProject, type ProjectPreview } from './config';
import { PreviewServer, PreviewServerError, worktreeSignature, type PreviewServerDeps, type PreviewStatus } from './server';

export type ServerLike = Pick<PreviewServer, 'ensure' | 'stop' | 'status' | 'alive'>;
export type BrowserLike = Pick<TicketBrowser, 'runCapture' | 'close'>;

export interface CaptureRequest { ticketId: string; agentId: string; worktree: string; projectDir: string; mode: 'dev' | 'prod'; outDir: string; args: unknown }

export interface PreviewManagerDeps {
  settings(): { projects: Record<string, ProjectPreview> };
  publish(e: HubEvent): void;
  getMeta(k: string): string | undefined;
  setMeta(k: string, v: string): void;
  makeServer?: (d: PreviewServerDeps) => ServerLike;
  makeBrowser?: (o: ConstructorParameters<typeof TicketBrowser>[0]) => BrowserLike;
  findBrowser?: () => string | null;
  fetchOk?: (url: string) => Promise<boolean>;
  idleMs?: number;
}

interface Waiter { resolve(): void; reject(e: Error): void }
interface Entry {
  ticketId: string;
  worktree: string;
  mode: 'dev' | 'prod';
  project: ProjectPreview;
  server: ServerLike;
  browser: BrowserLike | null;
  browserPort: number | null;
  active: number;
  waiting: Waiter[];
  idle: ReturnType<typeof setTimeout> | null;
  serverPids: number[];
  browserPids: number[];
  stopped: boolean;
}

const MAX_ACTIVE = 2;
const PIDS_KEY = 'previewPids';
const IDLE_MS = 600_000;

class CaptureError extends Error {
  constructor(public code: CaptureErrorCode, msg: string) {
    super(msg);
  }
}

async function defaultFetchOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return r.status < 500;
  } catch {
    return false;
  }
}

export class PreviewManager {
  private entries = new Map<string, Entry>();

  constructor(private d: PreviewManagerDeps) {}

  status(ticketId: string): PreviewStatus | null {
    return this.entries.get(ticketId)?.server.status() ?? null;
  }

  accountsFor(projectDir: string): { name: string; description: string }[] {
    const p = resolveProject(this.d.settings().projects, projectDir);
    return (p?.accounts ?? []).map((a) => ({ name: a.name, description: a.description }));
  }

  defaultMode(projectDir: string): 'dev' | 'prod' {
    return resolveProject(this.d.settings().projects, projectDir)?.defaultMode ?? 'dev';
  }

  async capture(req: CaptureRequest): Promise<{ text: string; isError?: boolean }> {
    const project = resolveProject(this.d.settings().projects, req.projectDir);
    const secrets = (project?.accounts ?? []).map((a) => a.password);
    const fail = (code: CaptureErrorCode, msg: string) => ({ isError: true, text: redact(formatError(code, msg), secrets) });
    if (!project) return fail('not_configured', `Dự án ${req.projectDir} chưa cấu hình server preview (Settings > Dự án) và không nhận ra Next.js trong package.json.`);
    const v = validateCaptureArgs(req.args, project.accounts.map((a) => a.name), req.worktree);
    if (!v.ok) return fail('invalid_args', v.error);
    const args = v.args;
    if (args.as && project.backend) {
      const ok = await (this.d.fetchOk ?? defaultFetchOk)(project.backend.healthUrl);
      if (!ok) return fail('backend_down', `Backend không phản hồi tại ${project.backend.healthUrl}. Gọi request_user_action nhờ người dùng bật backend.`);
    }
    const e = this.entry(req, project);
    try {
      await this.acquire(e);
    } catch (err) {
      return fail('busy_cancelled', err instanceof Error ? err.message : String(err));
    }
    try {
      let info;
      try {
        info = await e.server.ensure();
      } catch (err) {
        const tail = err instanceof PreviewServerError && err.logTail ? `\nLog cuối của server:\n${err.logTail}` : '';
        throw new CaptureError('server_failed', `${err instanceof Error ? err.message : String(err)}${tail}`);
      }
      if (e.stopped) throw new CaptureError('busy_cancelled', 'server preview đã bị tắt');
      const browser = await this.browserFor(e, info.port);
      let r: Omit<CaptureResult, 'server'>;
      try {
        r = await withTimeout(browser.runCapture(args, req.outDir, req.worktree), LIMITS.totalMs + 15_000);
      } catch (err) {
        if (err instanceof LoginError) throw new CaptureError('login_failed', `${err.message}${err.shot ? `\nẢnh trang đăng nhập: ${err.shot}` : ''}`);
        throw new CaptureError('server_failed', `trình duyệt lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
      const result: CaptureResult = { server: { mode: info.mode, port: info.port, startedNow: info.startedNow, buildMs: info.buildMs, envFiles: info.envFiles }, ...r };
      return { text: formatResult(redact(result, secrets)) };
    } catch (err) {
      if (err instanceof CaptureError) return fail(err.code, err.message);
      return fail('server_failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.release(e);
    }
  }

  async stop(ticketId: string): Promise<void> {
    const e = this.entries.get(ticketId);
    if (!e) return;
    this.entries.delete(ticketId);
    e.stopped = true;
    if (e.idle) clearTimeout(e.idle);
    e.idle = null;
    for (const w of e.waiting.splice(0)) w.reject(new Error('server preview đã bị tắt (ticket kết thúc hoặc người dùng tắt)'));
    const b = e.browser;
    e.browser = null;
    await Promise.allSettled([b?.close(), e.server.stop()]);
    e.serverPids = [];
    e.browserPids = [];
    this.savePids(ticketId, []);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((t) => this.stop(t)));
  }

  async killOrphans(): Promise<void> {
    let saved: Record<string, number[]> = {};
    try {
      saved = JSON.parse(this.d.getMeta(PIDS_KEY) ?? '{}');
    } catch {
      saved = {};
    }
    const pids = Object.values(saved).flat().filter((p) => Number.isInteger(p) && p > 0);
    await Promise.allSettled(pids.map((p) => killTree(p)));
    this.d.setMeta(PIDS_KEY, '{}');
  }

  private entry(req: CaptureRequest, project: ProjectPreview): Entry {
    const cur = this.entries.get(req.ticketId);
    if (cur && cur.worktree === req.worktree && cur.mode === req.mode) {
      cur.project = project;
      return cur;
    }
    if (cur) void this.stop(req.ticketId);
    const e: Entry = {
      ticketId: req.ticketId, worktree: req.worktree, mode: req.mode, project, server: null as unknown as ServerLike, browser: null, browserPort: null,
      active: 0, waiting: [], idle: null, serverPids: [], browserPids: [], stopped: false,
    };
    const deps: PreviewServerDeps = {
      worktree: req.worktree, projectDir: req.projectDir, project, mode: req.mode,
      signature: () => worktreeSignature(req.worktree),
      onPids: (pids) => {
        e.serverPids = pids;
        if (!e.stopped) this.savePids(req.ticketId, [...e.serverPids, ...e.browserPids]);
      },
      onStatus: (s) => this.d.publish({ type: 'preview', ticketId: req.ticketId, preview: s }),
    };
    e.server = (this.d.makeServer ?? ((x) => new PreviewServer(x)))(deps);
    this.entries.set(req.ticketId, e);
    return e;
  }

  private async browserFor(e: Entry, port: number): Promise<BrowserLike> {
    if (e.browser && e.browserPort === port) return e.browser;
    if (e.browser) {
      const old = e.browser;
      e.browser = null;
      e.browserPids = [];
      await old.close().catch(() => {});
    }
    const exe = (this.d.findBrowser ?? defaultFindBrowser)();
    if (!exe) throw new CaptureError('server_failed', 'Không tìm thấy Chrome hoặc Edge trên máy (đặt biến ACCTV_BROWSER nếu cài ở chỗ khác).');
    const b = (this.d.makeBrowser ?? ((o) => new TicketBrowser(o)))({
      executablePath: exe, origin: `http://localhost:${port}`, login: e.project.login, accounts: e.project.accounts,
      onPid: (pid) => {
        e.browserPids = [pid];
        if (!e.stopped) this.savePids(e.ticketId, [...e.serverPids, ...e.browserPids]);
      },
    });
    e.browser = b;
    e.browserPort = port;
    return b;
  }

  private acquire(e: Entry): Promise<void> {
    if (e.idle) clearTimeout(e.idle);
    e.idle = null;
    if (e.active < MAX_ACTIVE) {
      e.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => e.waiting.push({ resolve: () => { e.active++; resolve(); }, reject }));
  }

  private release(e: Entry): void {
    if (e.stopped) return;
    e.active--;
    const next = e.waiting.shift();
    if (next) return next.resolve();
    if (e.active === 0) {
      e.idle = setTimeout(() => void this.stop(e.ticketId), this.d.idleMs ?? IDLE_MS);
      e.idle.unref?.();
    }
  }

  private savePids(ticketId: string, pids: number[]): void {
    let all: Record<string, number[]> = {};
    try {
      all = JSON.parse(this.d.getMeta(PIDS_KEY) ?? '{}');
    } catch {
      all = {};
    }
    if (pids.length) all[ticketId] = pids;
    else delete all[ticketId];
    this.d.setMeta(PIDS_KEY, JSON.stringify(all));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`quá ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
