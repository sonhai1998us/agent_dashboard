import { spawn } from 'node:child_process';
import { childEnv, killTree } from '@/src/runner/proc';

/** Chạy một lệnh qua shell, gom stdout+stderr (giữ `keep` ký tự cuối), kill cây tiến trình khi quá giờ. */
export function runShell(cmd: string, cwd: string, timeoutMs: number, keep = 4000): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    let tail = '';
    const add = (b: Buffer) => {
      tail = (tail + b.toString('utf8')).slice(-keep);
    };
    let c;
    try {
      c = spawn(cmd, { cwd, env: childEnv(), shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, tail: e instanceof Error ? e.message : String(e) });
      return;
    }
    c.stdout?.on('data', add);
    c.stderr?.on('data', add);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      if (c.pid !== undefined) void killTree(c.pid);
    }, timeoutMs);
    c.on('error', (e) => add(Buffer.from(`\n${e.message}\n`)));
    c.on('close', (code) => {
      clearTimeout(t);
      if (timedOut) add(Buffer.from(`\n[quá ${Math.round(timeoutMs / 1000)}s, đã dừng lệnh]\n`));
      resolve({ code: timedOut ? null : code, tail });
    });
  });
}
