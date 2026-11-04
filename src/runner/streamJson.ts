import { parseClaudeLine, type ClaudeFileCtx } from '@/src/adapters/claude/parse';
import type { NormalizedEvent } from '@/src/core/model';
import type { RunSpec } from './types';

export const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|\b429\b|\b529\b|overloaded/i;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const RUNNER_OWNED = ['parentId', 'status', 'label', 'startedAt'];

export interface StreamCtx { claude: ClaudeFileCtx; pendingEdits: Map<string, string>; changedFiles: Set<string> }

export interface StreamOut {
  events: NormalizedEvent[];
  sessionId?: string;
  result?: { isError: boolean; text: string; costUsd: number | null; rateLimited: boolean };
  limited?: boolean;
}

export function newStreamCtx(spec: Pick<RunSpec, 'agentId' | 'sessionId' | 'label' | 'resume'>): StreamCtx {
  return {
    claude: { agentId: spec.agentId, sessionId: spec.sessionId, parentId: null, role: null, label: spec.label, lastTs: null, resumed: spec.resume },
    pendingEdits: new Map(),
    changedFiles: new Set(),
  };
}

export function parseStreamLine(line: string, ctx: StreamCtx, now: number): StreamOut {
  const agentId = ctx.claude.agentId;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return { events: [{ type: 'parse_error', agentId }] }; }
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') return { events: [{ type: 'parse_error', agentId }] };

  if (rec.type === 'system') {
    const sub = typeof rec.subtype === 'string' ? rec.subtype : '';
    if (sub === 'init') {
      const out: StreamOut = { events: [], sessionId: typeof rec.session_id === 'string' ? rec.session_id : undefined };
      if (typeof rec.model === 'string' && rec.model) {
        out.events.push({ type: 'agent', agent: { id: agentId, source: 'claude', sessionId: ctx.claude.sessionId, model: rec.model } });
      }
      return out;
    }
    if (sub.includes('retry')) {
      const es = Number(rec.error_status);
      if (es === 429 || es === 529 || RATE_LIMIT_RE.test(String(rec.error ?? ''))) return { events: [], limited: true };
    }
    return { events: [] };
  }

  if (rec.type === 'assistant' || rec.type === 'user') {
    if (typeof rec.timestamp !== 'string') rec.timestamp = new Date(now).toISOString();
    const events = parseClaudeLine(JSON.stringify(rec), ctx.claude).map((e) => {
      if (e.type !== 'agent') return e;
      const agent: any = { ...e.agent };
      for (const k of RUNNER_OWNED) delete agent[k];
      return { ...e, agent };
    });
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (rec.type === 'assistant' && b.type === 'tool_use' && EDIT_TOOLS.has(b.name) && typeof b.id === 'string') {
          const p = b.input?.file_path ?? b.input?.notebook_path;
          if (typeof p === 'string' && p) ctx.pendingEdits.set(b.id, p);
        } else if (rec.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const p = ctx.pendingEdits.get(b.tool_use_id);
          if (p !== undefined) {
            ctx.pendingEdits.delete(b.tool_use_id);
            if (b.is_error !== true) ctx.changedFiles.add(p);
          }
        }
      }
    }
    return rec.type === 'assistant' ? { events, limited: false } : { events };
  }

  if (rec.type === 'result') {
    const isError = rec.is_error === true || rec.subtype !== 'success';
    const text = String(rec.result ?? '');
    const costUsd = typeof rec.total_cost_usd === 'number' ? rec.total_cost_usd : null;
    return { events: [], result: { isError, text, costUsd, rateLimited: isError && RATE_LIMIT_RE.test(text) } };
  }

  return { events: [] };
}
