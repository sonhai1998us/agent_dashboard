import { startProcess, killTree, OVERFLOW } from './proc';
import { RATE_LIMIT_RE, type StreamOut } from './streamJson';
import { inputHash } from '@/src/core/inputHash';
import type { NormalizedEvent } from '@/src/core/model';
import type { Runner, RunResult, RunSpec } from './types';

export function buildCodexArgs(spec: RunSpec): string[] {
  const a = ['exec'];
  if (spec.resume) a.push('resume', spec.sessionId);
  a.push('--json', '--cd', spec.cwd, '--sandbox', spec.role === 'dev' ? 'workspace-write' : 'read-only');
  if (spec.model) a.push('-m', spec.model);
  a.push('-c', `model_reasoning_effort=${spec.effort}`);
  for (const d of spec.addDirs) a.push('--add-dir', d);
  a.push('-');
  return a;
}

export interface CodexCtx { agentId: string; open: Map<string, number>; changedFiles?: Set<string>; turns?: number }

const TOOL_ITEMS = new Set(['command_execution', 'mcp_tool_call', 'file_change']);

function toolOf(item: any): { name: string; input: unknown } {
  if (item.type === 'command_execution') return { name: 'Bash', input: item.command };
  if (item.type === 'mcp_tool_call') return { name: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`, input: item.arguments };
  return { name: 'Edit', input: item.changes };
}

export function parseCodexExecLine(line: string, ctx: CodexCtx, now: number): StreamOut {
  const agentId = ctx.agentId;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return { events: [{ type: 'parse_error', agentId }] }; }
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') return { events: [{ type: 'parse_error', agentId }] };

  if (rec.type === 'thread.started') {
    return { events: [], sessionId: typeof rec.thread_id === 'string' ? rec.thread_id : undefined };
  }

  const item = rec.item;
  if ((rec.type === 'item.started' || rec.type === 'item.completed') && item && typeof item === 'object' && typeof item.id === 'string') {
    if (TOOL_ITEMS.has(item.type)) {
      const callId = `${agentId}:${item.id}`;
      const events: NormalizedEvent[] = [];
      if (rec.type === 'item.started' || !ctx.open.has(callId)) {
        const { name, input } = toolOf(item);
        const h = inputHash(name, input);
        ctx.open.set(callId, now);
        events.push({ type: 'call_start', call: { id: callId, agentId, kind: 'tool', name, inputHash: h.hash, inputPreview: h.preview, startedAt: now, tokensIn: null, tokensOut: null } });
      }
      if (rec.type === 'item.completed') {
        const ok = item.status !== 'failed' && (item.exit_code ?? 0) === 0;
        ctx.open.delete(callId);
        events.push({ type: 'call_end', agentId, callId, endedAt: now, ok, errorPreview: ok ? null : String(item.aggregated_output ?? item.error?.message ?? item.status ?? 'lỗi').slice(0, 200) });
        if (item.type === 'file_change' && Array.isArray(item.changes) && ctx.changedFiles) {
          for (const c of item.changes) if (c && typeof c.path === 'string') ctx.changedFiles.add(c.path);
        }
      }
      return { events };
    }
    if (rec.type === 'item.completed' && item.type === 'agent_message') {
      return { events: [], result: { isError: false, text: String(item.text ?? ''), costUsd: null, rateLimited: false } };
    }
    return { events: [] };
  }

  if (rec.type === 'turn.completed' && rec.usage && typeof rec.usage === 'object') {
    const u = rec.usage;
    const id = `${agentId}:llm:${ctx.turns = (ctx.turns ?? 0) + 1}`;
    return {
      events: [
        { type: 'call_start', call: { id, agentId, kind: 'llm', name: 'llm', inputHash: '', inputPreview: '', startedAt: now, tokensIn: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0), tokensOut: u.output_tokens ?? 0 } },
        { type: 'call_end', agentId, callId: id, endedAt: now, ok: true, errorPreview: null },
      ],
      limited: false,
    };
  }

  if (rec.type === 'turn.failed' || rec.type === 'error') {
    const text = String(rec.error?.message ?? rec.message ?? '');
    const rateLimited = RATE_LIMIT_RE.test(text);
    return { events: [], result: { isError: true, text, costUsd: null, rateLimited }, ...(rateLimited ? { limited: true } : {}) };
  }

  return { events: [] };
}

export function createCodexRunner(opts: { command: string; prefixArgs?: string[] }): Runner {
  return (spec, sink) => {
    const proc = startProcess(opts.command, [...(opts.prefixArgs ?? []), ...buildCodexArgs(spec)], { cwd: spec.cwd });
    const changedFiles = new Set<string>();
    const ctx: CodexCtx = { agentId: spec.agentId, open: new Map(), changedFiles };
    let sessionId = spec.sessionId;
    let registered = false;
    let message: string | null = null;
    let failure: { text: string; rateLimited: boolean } | null = null;
    let killed = false;

    proc.onLine((line) => {
      if (line === OVERFLOW) { sink.events([{ type: 'parse_error', agentId: spec.agentId }]); return; }
      const out = parseCodexExecLine(line, ctx, Date.now());
      if (out.sessionId && !registered) {
        registered = true;
        sessionId = out.sessionId;
        sink.events([{ type: 'agent', agent: { id: spec.agentId, source: 'codex', sessionId } }]);
      }
      if (out.events.length) sink.events(out.events);
      if (out.limited !== undefined) sink.limited(out.limited);
      if (out.result) {
        if (out.result.isError) failure = { text: out.result.text, rateLimited: out.result.rateLimited };
        else message = out.result.text;
      }
    });
    proc.stdin.end(spec.prompt, 'utf8');

    const done: Promise<RunResult> = proc.exit.then(({ code }) => {
      const f = failure as { text: string; rateLimited: boolean } | null;
      const m = message as string | null;
      return {
        exitCode: code,
        killed,
        isError: f ? true : code !== 0,
        text: f ? f.text : m ?? proc.stderr().trim(),
        costUsd: null,
        rateLimited: f?.rateLimited ?? false,
        sessionId,
        changedFiles: [...changedFiles],
      };
    });

    return {
      pid: proc.pid,
      done,
      async kill() {
        const pid = proc.pid;
        if (proc.exited() || pid === null) return;
        killed = true;
        await killTree(pid);
        let timer: NodeJS.Timeout | undefined;
        const ok = await Promise.race([
          proc.exit.then(() => true),
          new Promise<boolean>((r) => { timer = setTimeout(() => r(false), 5000); }),
        ]);
        clearTimeout(timer);
        if (!ok && !proc.exited()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      },
    };
  };
}
