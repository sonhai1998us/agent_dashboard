import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
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
  /** gọi trước một URL để next dev biên dịch sẵn (lỗi bị bỏ qua) */
  warm?: (url: string) => Promise<void>;
  idleMs?: number;
  /** thời điểm máy khởi động (ms); pid lưu ở lần khởi động khác không còn là tiến trình của mình */
  bootTime?: () => number;
  /** tên file chạy của pid, null nếu không còn */
  procName?: (pid: number) => Promise<string | null>;
  kill?: (pid: number) => Promise<void>;
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
  serverKey: string;
  browserStale: boolean;
}

const MAX_ACTIVE = 2;
const PIDS_KEY = 'previewPids';
const BOOT_KEY = 'previewBoot';
/** sai số khi tính thời điểm khởi động từ uptime */
const BOOT_SLACK_MS = 120_000;
/** chỉ kill tiến trình có tên như server preview (shell, node, trình quản lý gói) hoặc trình duyệt headless */
const ORPHAN_NAMES = /^(node|cmd|sh|bash|pnpm|npm|yarn|bun|chrome|msedge|chrome-headless-shell|chromium)(\.exe)?$/i;
const IDLE_MS = 600_000;
/** next dev biên dịch trang lần đầu khi được mở: trên Windows app vừa có thể mất 10–30s */
const DEV_NAV_MS = 60_000;

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

const serverKey = (p: ProjectPreview): string => JSON.stringify([p.dev, p.prod, p.env, p.readyPath]);
const browserKey = (p: ProjectPreview): string => JSON.stringify([p.login ?? null, p.accounts]);

function defaultBootTime(): number {
  return Math.round(Date.now() - os.uptime() * 1000);
}

/** Tên file chạy của pid (Windows: tasklist; nơi khác: ps). */
function defaultProcName(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (e, out) => {
        const m = !e && /^"([^"]+)","(\d+)"/m.exec(out);
        resolve(m && Number(m[2]) === pid ? m[1] : null);
      });
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (e, out) => resolve(e ? null : path.basename(out.trim()) || null));
    }
  });
}

async function defaultWarm(url: string): Promise<void> {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DEV_NAV_MS) });
  } catch {
    // chỉ để biên dịch sẵn
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
      if (info.startedNow && info.mode === 'dev' && e.project.login) await (this.d.warm ?? defaultWarm)(`http://localhost:${info.port}${e.project.login.path}`);
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
    // entry mới của cùng ticket (vd. đổi chế độ) đã ghi pid của nó: không xoá
    if (!this.entries.has(ticketId)) this.savePids(ticketId, []);
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
    const boot = Number(this.d.getMeta(BOOT_KEY));
    const now = (this.d.bootTime ?? defaultBootTime)();
    // máy đã khởi động lại (hoặc không rõ): pid cũ có thể đã được cấp cho tiến trình khác của người dùng
    if (pids.length && Number.isFinite(boot) && Math.abs(now - boot) <= BOOT_SLACK_MS) {
      const name = this.d.procName ?? defaultProcName;
      const kill = this.d.kill ?? killTree;
      await Promise.allSettled(pids.map(async (p) => {
        const n = await name(p).catch(() => null);
        if (n && ORPHAN_NAMES.test(n)) await kill(p);
      }));
    }
    this.d.setMeta(PIDS_KEY, '{}');
  }

  private entry(req: CaptureRequest, project: ProjectPreview): Entry {
    const cur = this.entries.get(req.ticketId);
    const sKey = serverKey(project);
    if (cur && cur.worktree === req.worktree && cur.mode === req.mode && cur.serverKey === sKey) {
      // người dùng sửa tài khoản / form đăng nhập trong Settings: trình duyệt (và phiên đăng nhập) phải tạo lại
      if (browserKey(project) !== browserKey(cur.project)) cur.browserStale = true;
      cur.project = project;
      return cur;
    }
    // đổi worktree, chế độ hay lệnh/env của server: bật lại server
    if (cur) void this.stop(req.ticketId);
    const e: Entry = {
      ticketId: req.ticketId, worktree: req.worktree, mode: req.mode, project, server: null as unknown as ServerLike, browser: null, browserPort: null,
      active: 0, waiting: [], idle: null, serverPids: [], browserPids: [], stopped: false, serverKey: sKey, browserStale: false,
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
    if (e.browser && e.browserPort === port && !e.browserStale) return e.browser;
    e.browserStale = false;
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
      navTimeoutMs: e.mode === 'dev' ? DEV_NAV_MS : LIMITS.stepMs,
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
    if (pids.length) this.d.setMeta(BOOT_KEY, String((this.d.bootTime ?? defaultBootTime)()));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`quá ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
