import type { NormalizedEvent } from '@/src/core/model';
import { inputHash } from '@/src/core/inputHash';

export interface CodexFileCtx {
  agentId: string | null;
  lastTs: number | null;
  turnOpen: boolean;
  resumed: boolean;
  /** True once a task_started/task_complete/turn_aborted was seen (a resumed ctx starts unknown). */
  turnKnown?: boolean;
  // Optional state learned while parsing (not needed to construct a ctx).
  model?: string | null;
  parentId?: string | null;
  cwd?: string | null;
}

const ROLLOUT_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

export function codexCtxForPath(file: string, opts?: { resumed?: boolean }): CodexFileCtx {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
  const m = ROLLOUT_RE.exec(base);
  return { agentId: m ? `codex:${m[1].toLowerCase()}` : null, lastTs: null, turnOpen: false, resumed: opts?.resumed ?? false };
}

const lastSegment = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';

function outputText(o: unknown): string {
  if (typeof o === 'string') return o;
  if (o == null) return '';
  try {
    return JSON.stringify(o);
  } catch {
    return '';
  }
}

export function parseCodexLine(line: string, ctx: CodexFileCtx): NormalizedEvent[] {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return ctx.agentId ? [{ type: 'parse_error', agentId: ctx.agentId }] : [];
  }
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') {
    return ctx.agentId ? [{ type: 'parse_error', agentId: ctx.agentId }] : [];
  }
  const payload: any = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
  const hadCwd = !!ctx.cwd;

  if (rec.type === 'session_meta') {
    if (typeof payload.id === 'string') ctx.agentId = `codex:${payload.id}`;
    ctx.parentId = typeof payload.parent_thread_id === 'string' && payload.parent_thread_id ? `codex:${payload.parent_thread_id}` : null;
    if (typeof payload.cwd === 'string') ctx.cwd = payload.cwd;
  }
  if (!ctx.agentId) return [];

  const agentId = ctx.agentId;
  const parsed = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  const ts: number | null = Number.isFinite(parsed) ? parsed : null;
  const prevTs = ctx.lastTs;
  const sessionId = agentId.replace(/^codex:/, '');
  const base = { id: agentId, source: 'codex' as const, sessionId };
  const out: NormalizedEvent[] = [];

  // Settings / context updates
  const info: any = {};
  const ptype: string | undefined = typeof payload.type === 'string' ? payload.type : undefined;
  if (rec.type === 'event_msg' && ptype === 'thread_settings_applied') {
    const m = payload.thread_settings?.model;
    if (typeof m === 'string' && m) info.model = m;
  } else if (rec.type === 'turn_context') {
    if (typeof payload.cwd === 'string') {
      info.cwd = payload.cwd;
      ctx.cwd = payload.cwd;
    }
    if (typeof payload.model === 'string' && payload.model) info.model = payload.model;
    if (typeof payload.effort === 'string' && payload.effort) info.effort = payload.effort;
  }
  if (info.model) ctx.model = info.model;

  // First timestamped record introduces the agent
  if (ts !== null && prevTs === null) {
    const agent: any = { ...base };
    if (!ctx.resumed || ctx.parentId) agent.parentId = ctx.parentId ?? null;
    if (!ctx.resumed) agent.startedAt = ts;
    if (ctx.cwd) agent.cwd = ctx.cwd;
    if (!ctx.resumed && ctx.cwd) {
      const label = lastSegment(ctx.cwd);
      if (label) agent.label = label;
    }
    if (ctx.model) agent.model = ctx.model;
    Object.assign(agent, info);
    out.push({ type: 'agent', agent });
  } else {
    if (!hadCwd && ctx.cwd && prevTs !== null) {
      // introduced without a cwd: project/label come from the first record that has one
      info.cwd = ctx.cwd;
      const label = ctx.resumed ? '' : lastSegment(ctx.cwd);
      if (label) info.label = label;
    }
    if (Object.keys(info).length) out.push({ type: 'agent', agent: { ...base, ...info } });
  }

  const at = ts ?? ctx.lastTs ?? Date.now();
  let produced = false;

  if (rec.type === 'event_msg') {
    if (ptype === 'task_started') { ctx.turnOpen = true; ctx.turnKnown = true; }
    else if (ptype === 'task_complete' || ptype === 'turn_aborted') { ctx.turnOpen = false; ctx.turnKnown = true; }
  } else if (rec.type === 'response_item' && typeof payload.call_id === 'string') {
    if (ptype === 'function_call' || ptype === 'custom_tool_call') {
      const name = String(payload.name ?? 'tool');
      let input: unknown;
      if (ptype === 'function_call') {
        const raw = payload.arguments;
        try {
          input = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          input = raw;
        }
      } else {
        input = payload.input;
      }
      const h = inputHash(name, input);
      out.push({
        type: 'call_start',
        call: {
          id: payload.call_id, agentId, kind: 'tool', name, inputHash: h.hash, inputPreview: h.preview,
          startedAt: at, tokensIn: null, tokensOut: null,
        },
      });
      produced = true;
    } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
      const text = outputText(payload.output);
      const m = /^\s*Exit code:\s*(-?\d+)/.exec(text);
      const ok = m ? Number(m[1]) === 0 : true;
      out.push({
        type: 'call_end', agentId, callId: payload.call_id, endedAt: at, ok,
        errorPreview: ok ? null : text.slice(0, 200),
      });
      produced = true;
    }
  } else if (rec.type === 'token_usage_record' || ptype === 'token_usage_record') {
    const u = payload.usage;
    if (u && typeof u === 'object') {
      const id = String(payload.response_id ?? `llm-${at}`);
      out.push({
        type: 'call_start',
        call: {
          id, agentId, kind: 'llm', name: ctx.model || 'llm', inputHash: '', inputPreview: '',
          startedAt: prevTs ?? at, tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0,
        },
      });
      out.push({ type: 'call_end', agentId, callId: id, endedAt: at, ok: true, errorPreview: null });
      produced = true;
    }
  }

  if (ts !== null) {
    if (!produced) out.push({ type: 'activity', agentId, at: ts });
    ctx.lastTs = ts;
  }
  return out;
}
