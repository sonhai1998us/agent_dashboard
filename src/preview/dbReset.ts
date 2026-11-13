import { spawn } from 'node:child_process';
import { childEnv, killTree } from '@/src/runner/proc';

/** Chạy một lệnh qua shell, gom stdout+stderr (giữ `keep` ký tự cuối), kill cây tiến trình khi quá giờ. */
export function runShell(cmd: string, cwd: string, timeoutMs: number, keep = 4000): Promise<{ code: number | null; tail: string }> {
  return collect(() => spawn(cmd, { cwd, env: childEnv(), shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), timeoutMs, keep);
}

/** Như runShell nhưng không qua shell: tham số đi nguyên văn (an toàn với chuỗi do agent đưa vào). */
export function runArgs(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal, keep = 6000): Promise<{ code: number | null; tail: string }> {
  // nhóm tiến trình riêng (không phải Windows): killTree kill được cả con cháu (trình duyệt) đang giữ pipe
  return collect(() => spawn(cmd, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }), timeoutMs, keep, signal);
}

function collect(start: () => ReturnType<typeof spawn>, timeoutMs: number, keep: number, signal?: AbortSignal): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    let tail = '';
    const add = (b: Buffer) => {
      tail = (tail + b.toString('utf8')).slice(-keep);
    };
    let c: ReturnType<typeof spawn>;
    try {
      c = start();
    } catch (e) {
      resolve({ code: null, tail: e instanceof Error ? e.message : String(e) });
      return;
    }
    c.stdout?.on('data', add);
    c.stderr?.on('data', add);
    let timedOut = false;
    const kill = () => {
      timedOut = true;
      if (c.pid !== undefined) void killTree(c.pid);
    };
    const t = setTimeout(kill, timeoutMs);
    if (signal?.aborted) kill();
    signal?.addEventListener('abort', kill, { once: true });
    c.on('error', (e) => add(Buffer.from(`\n${e.message}\n`)));
    c.on('close', (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', kill);
      if (timedOut) add(Buffer.from(`\n[quá ${Math.round(timeoutMs / 1000)}s, đã dừng lệnh]\n`));
      resolve({ code: timedOut ? null : code, tail });
    });
  });
}
