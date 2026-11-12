import { spawn, execFile } from 'node:child_process';
import { PassThrough, type Writable } from 'node:stream';

export interface Proc {
  pid: number | null;
  onLine(fn: (line: string) => void): void;
  exit: Promise<{ code: number | null; signal: string | null }>;
  stdin: Writable;
  stderr(): string;
  exited(): boolean;
}

const MAX_LINE = 8 * 1024 * 1024;
const STDERR_KEEP = 4096;
export const OVERFLOW = '\u0000overflow';

/**
 * Môi trường cho tiến trình con chạy trong dự án của người dùng (agent, lệnh cài, server preview): của dashboard trừ NODE_ENV.
 * NODE_ENV=production của dashboard làm jest lỗi ("act is not supported in production builds"), npm ci / yarn install bỏ devDependencies.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const { NODE_ENV: _drop, ...env } = process.env;
  return env as NodeJS.ProcessEnv; // kiểu ProcessEnv (Next mở rộng) bắt buộc NODE_ENV
}

export function startProcess(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Proc {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env ?? childEnv(), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stdin = new PassThrough();
    stdin.resume();
    return { pid: null, onLine: () => {}, exit: Promise.resolve({ code: null, signal: null }), stdin, stderr: () => msg.slice(-STDERR_KEEP), exited: () => true };
  }
  let exited = false;
  const listeners: Array<(l: string) => void> = [];
  const emit = (l: string) => { for (const fn of listeners) fn(l); };
  let buf = '';
  let skipping = false;
  let errTail = '';

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    let s = chunk;
    for (;;) {
      const i = s.indexOf('\n');
      if (i < 0) {
        if (skipping) return;
        buf += s;
        if (buf.length > MAX_LINE) { buf = ''; skipping = true; emit(OVERFLOW); }
        return;
      }
      const part = s.slice(0, i);
      s = s.slice(i + 1);
      if (skipping) { skipping = false; continue; }
      const line = buf + part;
      buf = '';
      if (line.length > MAX_LINE) { emit(OVERFLOW); continue; }
      const t = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (t) emit(t);
    }
  });
  child.stdout!.on('end', () => {
    if (!skipping && buf) emit(buf.endsWith('\r') ? buf.slice(0, -1) : buf);
    buf = '';
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (c: string) => { errTail = (errTail + c).slice(-STDERR_KEEP); });
  child.stdin!.on('error', () => {});

  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    let settled = false;
    const fin = (code: number | null, signal: string | null) => { if (!settled) { settled = true; exited = true; resolve({ code, signal }); } };
    child.on('error', (e) => { errTail = (errTail + String(e.message)).slice(-STDERR_KEEP); fin(null, null); });
    child.on('close', (code, signal) => fin(code, signal));
  });

  return {
    pid: child.pid ?? null,
    onLine: (fn) => { listeners.push(fn); },
    exit,
    stdin: child.stdin!,
    stderr: () => errTail,
    exited: () => exited,
  };
}

export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    resolve();
  });
}
