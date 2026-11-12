import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { childEnv, killTree } from '@/src/runner/proc';
import { loadEnvFiles } from './envFiles';
import type { ProjectPreview } from './config';

export type PreviewState = 'stopped' | 'starting' | 'building' | 'ready' | 'failed';
export interface PreviewStatus { state: PreviewState; mode: 'dev' | 'prod'; port: number | null; error: string | null; logTail: string; envFiles: string[]; startedAt: number | null }
export interface ServerInfo { port: number; mode: 'dev' | 'prod'; startedNow: boolean; buildMs: number | null; envFiles: string[] }

export class PreviewServerError extends Error {
  constructor(public code: 'server_failed', msg: string, public logTail: string) {
    super(msg);
    this.name = 'PreviewServerError';
  }
}

export interface PreviewServerDeps {
  worktree: string;
  projectDir: string;
  project: ProjectPreview;
  mode: 'dev' | 'prod';
  /** chữ ký worktree: HEAD + hash(git diff HEAD) + danh sách untracked */
  signature(): Promise<string>;
  onPids(pids: number[]): void;
  onStatus(s: PreviewStatus): void;
  timeouts?: { readyMs: number; buildMs: number };
}

const LOG_KEEP = 2048;
const POLL_MS = 500;
const DEFAULT_TIMEOUTS = { readyMs: 120_000, buildMs: 600_000 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (e, out) => resolve(e ? '' : out)));

export async function worktreeSignature(worktree: string): Promise<string> {
  const [head, diff, untracked] = await Promise.all([
    git(worktree, ['rev-parse', 'HEAD']),
    git(worktree, ['diff', 'HEAD']),
    git(worktree, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const h = createHash('sha1').update(head).update('\0').update(diff).update('\0');
  for (const f of untracked.split('\n').filter(Boolean)) {
    let st = '';
    try {
      const s = fs.statSync(path.join(worktree, f));
      st = `${s.size}:${s.mtimeMs}`;
    } catch {
      // vừa bị xoá
    }
    h.update(`${f}\0${st}\n`);
  }
  return h.digest('hex');
}

/** Biến môi trường cho server: kế thừa của dashboard (trừ NODE_ENV), rồi file env của dự án, rồi env cấu hình, rồi PORT. */
function serverEnv(vars: Record<string, string>, project: ProjectPreview, port: number): Record<string, string | undefined> {
  // next tự đặt NODE_ENV theo lệnh; NODE_ENV của dashboard (production/test) làm next dev chạy sai
  return { ...childEnv(), ...vars, ...project.env, PORT: String(port) };
}

export class PreviewServer {
  private child: ChildProcess | null = null;
  private building: ChildProcess | null = null;
  private exited = true;
  private builtSig: string | null = null;
  /** .next/BUILD_ID sau lần build của chính server preview; null nếu không đọc được (distDir khác) */
  private builtId: string | null = null;
  private pending: Promise<ServerInfo> | null = null;
  private gen = 0;
  private log = '';
  private st: PreviewStatus;
  private timeouts: { readyMs: number; buildMs: number };

  constructor(private d: PreviewServerDeps) {
    this.st = { state: 'stopped', mode: d.mode, port: null, error: null, logTail: '', envFiles: [], startedAt: null };
    this.timeouts = d.timeouts ?? DEFAULT_TIMEOUTS;
  }

  status(): PreviewStatus {
    return { ...this.st, logTail: this.log, envFiles: [...this.st.envFiles] };
  }

  alive(): boolean {
    return !!this.child && !this.exited;
  }

  ensure(): Promise<ServerInfo> {
    if (this.pending) return this.pending;
    const p = this.doEnsure().finally(() => {
      if (this.pending === p) this.pending = null;
    });
    this.pending = p;
    return p;
  }

  async stop(): Promise<void> {
    this.gen++;
    const kids = [this.building, this.child].filter((c): c is ChildProcess => !!c);
    this.building = null;
    this.child = null;
    this.exited = true;
    this.builtSig = null;
    this.builtId = null;
    await Promise.all(kids.map((c) => this.kill(c)));
    this.emitPids();
    this.set({ state: 'stopped', port: null, error: null, startedAt: null });
  }

  private info(startedNow: boolean, buildMs: number | null): ServerInfo {
    return { port: this.st.port!, mode: this.d.mode, startedNow, buildMs, envFiles: [...this.st.envFiles] };
  }

  private async doEnsure(): Promise<ServerInfo> {
    const gen = this.gen;
    const { mode, project } = this.d;
    if (this.alive() && this.st.state === 'ready') {
      if (mode === 'dev') return this.info(false, null);
      // build khác (vd. agent chạy pnpm build) ghi đè thư mục build đang được next start phục vụ → build lại
      if ((await this.d.signature()) === this.builtSig && (this.builtId === null || this.readBuildId() === this.builtId)) return this.info(false, null);
    }
    try {
      if (this.child) {
        const old = this.child;
        this.child = null;
        await this.kill(old);
        this.emitPids();
      }
      this.check(gen);
      const t0 = Date.now();
      const { vars, files } = loadEnvFiles(this.d.projectDir, mode);
      const port = await freePort();
      const env = serverEnv(vars, project, port);
      this.log = '';
      this.set({ envFiles: files, port: null, error: null, startedAt: null });
      let buildMs: number | null = null;
      if (mode === 'prod') {
        const sig = await this.d.signature();
        this.check(gen);
        this.set({ state: 'building' });
        await this.runBuild(project.prod.build, env, gen);
        this.builtSig = sig;
        this.builtId = this.readBuildId();
        buildMs = Date.now() - t0;
      }
      this.check(gen);
      this.set({ state: 'starting' });
      const cmd = (mode === 'dev' ? project.dev.command : project.prod.start).replaceAll('{port}', String(port));
      const child = this.spawn(cmd, env);
      this.child = child;
      this.exited = false;
      child.once('exit', () => {
        if (this.child !== child) return;
        this.exited = true;
        if (this.st.state === 'ready') this.set({ state: 'failed', error: 'server preview đã thoát' });
      });
      this.emitPids();
      await this.waitReady(port, child, gen);
      this.set({ state: 'ready', port, startedAt: Date.now() });
      return this.info(true, buildMs);
    } catch (e) {
      const err = e instanceof PreviewServerError ? e : new PreviewServerError('server_failed', e instanceof Error ? e.message : String(e), this.log);
      if (gen === this.gen) this.set({ state: 'failed', error: err.message });
      throw err;
    }
  }

  private readBuildId(): string | null {
    try {
      return fs.readFileSync(path.join(this.d.worktree, '.next', 'BUILD_ID'), 'utf8').trim();
    } catch {
      return null;
    }
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new PreviewServerError('server_failed', 'server preview đã bị tắt', this.log);
  }

  private spawn(cmd: string, env: Record<string, string | undefined>): ChildProcess {
    const c = spawn(cmd, { cwd: this.d.worktree, env: env as NodeJS.ProcessEnv, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b: Buffer) => {
      this.log = (this.log + b.toString('utf8')).slice(-LOG_KEEP);
    };
    c.stdout?.on('data', add);
    c.stderr?.on('data', add);
    c.on('error', (e) => add(Buffer.from(`\n${e.message}\n`)));
    return c;
  }

  private runBuild(cmd: string, env: Record<string, string | undefined>, gen: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = this.spawn(cmd, env);
      this.building = c;
      this.emitPids();
      const timer = setTimeout(() => {
        void this.kill(c);
        reject(new PreviewServerError('server_failed', `build không xong sau ${Math.round(this.timeouts.buildMs / 1000)}s`, this.log));
      }, this.timeouts.buildMs);
      c.once('exit', (code) => {
        clearTimeout(timer);
        if (this.building === c) this.building = null;
        this.emitPids();
        if (gen !== this.gen) return reject(new PreviewServerError('server_failed', 'server preview đã bị tắt', this.log));
        if (code === 0) resolve();
        else reject(new PreviewServerError('server_failed', `build lỗi (mã ${code})`, this.log));
      });
    });
  }

  private async waitReady(port: number, child: ChildProcess, gen: number): Promise<void> {
    const deadline = Date.now() + this.timeouts.readyMs;
    const url = `http://localhost:${port}${this.d.project.readyPath}`;
    while (Date.now() < deadline) {
      this.check(gen);
      if (this.exited || this.child !== child) throw new PreviewServerError('server_failed', `server preview thoát (mã ${child.exitCode ?? '?'})`, this.log);
      try {
        const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        if (r.status < 500) return;
      } catch {
        // chưa nghe
      }
      await sleep(POLL_MS);
    }
    this.child = null;
    await this.kill(child);
    this.emitPids();
    throw new PreviewServerError('server_failed', `server preview không sẵn sàng sau ${Math.round(this.timeouts.readyMs / 1000)}s`, this.log);
  }

  private kill(c: ChildProcess): Promise<void> {
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return Promise.resolve();
    const gone = new Promise<void>((r) => {
      c.once('exit', () => r());
      setTimeout(r, 5000);
    });
    return killTree(c.pid).then(() => gone);
  }

  private emitPids(): void {
    this.d.onPids([this.child, this.building].flatMap((c) => (c && c.pid !== undefined && c.exitCode === null ? [c.pid] : [])));
  }

  private set(p: Partial<PreviewStatus>): void {
    this.st = { ...this.st, ...p };
    this.d.onStatus(this.status());
  }
}
