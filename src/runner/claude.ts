import { writeRunFiles, buildClaudeArgs } from './claudeArgs';
import { newStreamCtx, parseStreamLine } from './streamJson';
import { startProcess, killTree, OVERFLOW } from './proc';
import { hookCommand } from '@/src/guard/policy';
import type { Runner, RunResult } from './types';

export function createClaudeRunner(opts: { command: string; prefixArgs?: string[]; nodePath?: string; guardScript: string }): Runner {
  return (spec, sink) => {
    const hook = hookCommand(opts.nodePath ?? process.execPath, opts.guardScript, spec.guard.port, spec.agentId, spec.guard.token);
    const files = writeRunFiles(spec, hook);
    const proc = startProcess(opts.command, [...(opts.prefixArgs ?? []), ...buildClaudeArgs(spec, files)], { cwd: spec.cwd });
    const ctx = newStreamCtx(spec);
    let sessionId = spec.sessionId;
    let result: { isError: boolean; text: string; costUsd: number | null; rateLimited: boolean } | null = null;
    let killed = false;

    proc.onLine((line) => {
      if (line === OVERFLOW) { sink.events([{ type: 'parse_error', agentId: spec.agentId }]); return; }
      const out = parseStreamLine(line, ctx, Date.now());
      if (out.sessionId) sessionId = out.sessionId;
      if (out.events.length) sink.events(out.events);
      if (out.limited !== undefined) sink.limited(out.limited);
      if (out.result) result = out.result;
    });
    proc.stdin.end(spec.prompt, 'utf8');

    const done: Promise<RunResult> = proc.exit.then(({ code }) => ({
      exitCode: code,
      killed,
      isError: result ? result.isError || code !== 0 : true,
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
        killed = true;
        if (proc.pid !== null) await killTree(proc.pid);
        await proc.exit;
      },
    };
  };
}
