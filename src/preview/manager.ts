import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { HubEvent } from '@/src/core/model';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { childEnv, killTree } from '@/src/runner/proc';
import { runArgs } from './dbReset';
import { LoginError, TicketBrowser, findBrowser as defaultFindBrowser } from './browser';
import { LIMITS, e2eEnvName, formatError, formatResult, redact, validateCaptureArgs, type CaptureErrorCode, type CaptureResult } from './captureArgs';
import { resolveProject, type ProjectPreview } from './config';
import { PreviewServer, PreviewServerError, worktreeSignature, type PreviewServerDeps, type PreviewStatus } from './server';

export type ServerLike = Pick<PreviewServer, 'ensure' | 'stop' | 'status' | 'alive'>;
export type BrowserLike = Pick<TicketBrowser, 'runCapture' | 'close'>;

export interface CaptureRequest { ticketId: string; agentId: string; worktree: string; projectDir: string; mode: 'dev' | 'prod'; outDir: string; args: unknown }
export interface E2eRequest { ticketId: string; agentId: string; worktree: string; projectDir: string; mode: 'dev' | 'prod'; file: unknown; grep?: unknown }
type Exec = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }) => Promise<{ code: number | null; tail: string }>;
export const E2E_TIMEOUT_MS = 600_000;
/** Số ký tự cuối của log e2e được giữ lại. */
export const E2E_TAIL = 6000;

/**
 * CLI của Playwright trong node_modules của worktree; null khi chưa cài (không để npx tự tải bản khác).
 * Đọc trường bin của package.json: `playwright` không export ./cli.
 */
function playwrightCli(worktree: string): string | null {
  const req = createRequire(path.join(worktree, 'package.json'));
  for (const pkg of ['@playwright/test', 'playwright']) {
    try {
      const pj = req.resolve(`${pkg}/package.json`);
      const bin = (JSON.parse(fs.readFileSync(pj, 'utf8')) as { bin?: string | Record<string, string> }).bin;
      const rel = typeof bin === 'string' ? bin : bin?.playwright;
      if (rel) return path.join(path.dirname(pj), rel);
    } catch { /* chưa cài gói này: thử gói tiếp theo */ }
  }
  return null;
}


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
  /** chạy lệnh e2e (mặc định runArgs, không qua shell) */
  exec?: Exec;
}

interface Waiter { resolve(): void; reject(e: Error): void }
interface Entry {
  /** run_e2e đang chạy: không chiếm lượt capture, giữ server khỏi bị tắt vì rảnh, huỷ khi tắt preview */
  e2e?: AbortController | null;
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

  /** Chạy một file e2e (Playwright) của worktree trên server preview: BASE_URL trỏ vào server, tài khoản test qua env. */
  async runE2e(req: E2eRequest): Promise<{ text: string; isError?: boolean }> {
    const project = resolveProject(this.d.settings().projects, req.projectDir);
    const secrets = (project?.accounts ?? []).map((a) => a.password);
    const fail = (code: CaptureErrorCode, msg: string) => ({ isError: true, text: redact(formatError(code, msg, undefined, 'e2e'), secrets) });
    if (!project) return fail('not_configured', `Dự án ${req.projectDir} chưa cấu hình server preview (Settings > Dự án).`);
    const f = req.file;
    const norm = typeof f === 'string' ? path.posix.normalize(f.replace(/\\/g, '/')) : '';
    if (typeof f !== 'string' || path.isAbsolute(f) || norm !== f.replace(/\\/g, '/') || !norm.startsWith('e2e/') || !/\.spec\.(ts|js)$/.test(norm)) {
      return fail('invalid_args', 'file phải là đường dẫn tương đối trong e2e/, đuôi .spec.ts hoặc .spec.js');
    }
    if (!fs.existsSync(path.join(req.worktree, norm))) return fail('invalid_args', `không có file ${norm} trong worktree`);
    const g = req.grep;
    if (g !== undefined && (typeof g !== 'string' || g.length > 200 || /[\r\n]/.test(g))) return fail('invalid_args', 'grep phải là chuỗi một dòng, tối đa 200 ký tự');
    const cli = playwrightCli(req.worktree);
    if (!cli) return fail('not_configured', 'worktree chưa cài @playwright/test (node_modules): cài dependency của dự án trước rồi chạy lại');
    const e = this.entry(req, project);
    if (e.e2e) return fail('busy_cancelled', 'đang có một run_e2e khác của ticket này; chờ nó xong rồi chạy lại');
    const ac = new AbortController();
    e.e2e = ac;
    if (e.idle) clearTimeout(e.idle);
    e.idle = null;
    try {
      let port: number;
      try {
        const info = await e.server.ensure();
        port = info.port;
        // next dev biên dịch trang lúc mở lần đầu: test đầu tiên dễ quá timeout 30s của Playwright
        if (info.startedNow && info.mode === 'dev') await (this.d.warm ?? defaultWarm)(`http://localhost:${port}/`);
      } catch (err) {
        const tail = err instanceof PreviewServerError && err.logTail ? `\nLog cuối của server:\n${err.logTail}` : '';
        return fail('server_failed', `${err instanceof Error ? err.message : String(err)}${tail}`);
      }
      if (e.stopped) return fail('busy_cancelled', 'server preview đã bị tắt');
      const env: NodeJS.ProcessEnv = { ...childEnv(), BASE_URL: `http://localhost:${port}` };
      const byVar = new Map<string, string[]>();
      for (const a of project.accounts) byVar.set(e2eEnvName(a.name), [...(byVar.get(e2eEnvName(a.name)) ?? []), a.name]);
      const clash = [...byVar].filter(([, names]) => names.length > 1);
      for (const a of project.accounts) {
        const v = e2eEnvName(a.name);
        if (byVar.get(v)!.length > 1) continue; // trùng tên biến: không đoán tài khoản nào đúng
        env[`E2E_${v}_USER`] = a.username;
        env[`E2E_${v}_PASS`] = a.password;
      }
      const warn = clash.map(([v, names]) => `Cảnh báo: tài khoản ${names.join(', ')} trùng biến E2E_${v}_*: không đặt biến nào; đổi tên một tài khoản trong Settings.\n`).join('');
      const args = [cli, 'test', norm, '--reporter=line', ...(typeof g === 'string' && g ? ['--grep', g] : [])];
      const exec: Exec = this.d.exec ?? ((cmd, a, o) => runArgs(cmd, a, o.cwd, o.env, o.timeoutMs, o.signal, E2E_TAIL));
      const r = await exec(process.execPath, args, { cwd: req.worktree, env, timeoutMs: E2E_TIMEOUT_MS, signal: ac.signal });
      // log bị cắt ở đầu: dòng đầu có thể là mẩu mật khẩu mà redact không nhận ra
      const tail = r.tail.length >= E2E_TAIL ? r.tail.slice(r.tail.indexOf('\n') + 1) : r.tail;
      if (ac.signal.aborted) return fail('busy_cancelled', 'server preview đã bị tắt (ticket kết thúc hoặc người dùng tắt)');
      if (r.code === null) return fail('run_failed', `playwright quá ${E2E_TIMEOUT_MS / 1000}s hoặc không chạy được\n${warn}${tail}`);
      const text = `[e2e] ${r.code === 0 ? 'đạt' : 'lỗi'} (exit ${r.code})\n${warn}${tail}`;
      return r.code === 0 ? { text: redact(text, secrets) } : { isError: true, text: redact(text, secrets) };
    } finally {
      if (e.e2e === ac) e.e2e = null;
      this.idleLater(e);
    }
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
    e.e2e?.abort();
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

  private entry(req: Pick<CaptureRequest, 'ticketId' | 'worktree' | 'mode' | 'projectDir'>, project: ProjectPreview): Entry {
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
    this.idleLater(e);
  }

  private idleLater(e: Entry): void {
    if (e.active === 0 && !e.e2e && !e.stopped) {
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
