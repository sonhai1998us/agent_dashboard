import { writeRunFiles, buildClaudeArgs } from './claudeArgs';
import { newStreamCtx, parseStreamLine } from './streamJson';
import { startProcess, killTree, OVERFLOW } from './proc';
import { hookCommand } from '@/src/guard/policy';
import type { Runner, RunResult } from './types';

/** Đã có dòng `result` mà tiến trình chưa thoát sau ngần này thì tắt cả cây tiến trình (vd. tiến trình cháu treo giữ stdio). */
export const REAP_AFTER_RESULT_MS = 10_000;

export function createClaudeRunner(opts: {
  command: string; prefixArgs?: string[]; nodePath?: string; guardScript: string; reapAfterResultMs?: number;
}): Runner {
  const reapMs = opts.reapAfterResultMs ?? REAP_AFTER_RESULT_MS;
  return (spec, sink) => {
    const hook = hookCommand(opts.nodePath ?? process.execPath, opts.guardScript, spec.guard.port, spec.agentId, spec.guard.token);
    const files = writeRunFiles(spec, hook);
    const proc = startProcess(opts.command, [...(opts.prefixArgs ?? []), ...buildClaudeArgs(spec, files)], { cwd: spec.cwd });
    const ctx = newStreamCtx(spec);
    let sessionId = spec.sessionId;
    let result: { isError: boolean; text: string; costUsd: number | null; rateLimited: boolean } | null = null;
    let killed = false;
    let reaped = false;
    let reapTimer: NodeJS.Timeout | undefined;

    const stopTree = async (pid: number): Promise<void> => {
      await killTree(pid);
      let timer: NodeJS.Timeout | undefined;
      const ok = await Promise.race([
        proc.exit.then(() => true),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(false), 5000); }),
      ]);
      clearTimeout(timer);
      if (!ok && !proc.exited()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    };

    proc.onLine((line) => {
      if (line === OVERFLOW) { sink.events([{ type: 'parse_error', agentId: spec.agentId }]); return; }
      const out = parseStreamLine(line, ctx, Date.now());
      if (out.sessionId) sessionId = out.sessionId;
      if (out.events.length) sink.events(out.events);
      if (out.limited !== undefined) sink.limited(out.limited);
      if (out.result) {
        result = out.result;
        // claude đã báo xong lượt: tiến trình phải thoát ngay; còn sống (cháu treo giữ pipe) thì dọn sau reapMs
        if (!reapTimer && !proc.exited() && proc.pid !== null) {
          const pid = proc.pid;
          reapTimer = setTimeout(() => {
            if (proc.exited() || killed) return;
            reaped = true;
            void stopTree(pid);
          }, reapMs);
          reapTimer.unref?.();
        }
      }
    });
    void proc.exit.then(() => clearTimeout(reapTimer));
    proc.stdin.end(spec.prompt, 'utf8');

    const done: Promise<RunResult> = proc.exit.then(({ code }) => ({
      // bị dọn sau khi đã có result: kết quả là của lượt đã xong, không phải lỗi
      exitCode: reaped ? 0 : code,
      killed,
      isError: result ? result.isError || (!reaped && code !== 0) : true,
      text: result ? result.text : proc.stderr().trim(),
      costUsd: result?.costUsd ?? null,
      rateLimited: result?.rateLimited ?? false,
      sessionId,
      changedFiles: [...ctx.changedFiles],
    }));

    return {
      pid: proc.pid,
      done,
      async kill() {
        const pid = proc.pid;
        if (proc.exited() || pid === null) return;
        killed = true;
        reaped = false;
        clearTimeout(reapTimer);
        await stopTree(pid);
      },
    };
  };
}
