import path from 'node:path';
import type { NormalizedEvent } from '@/src/core/model';
import { inputHash } from '@/src/core/inputHash';

export interface ClaudeFileCtx {
  agentId: string;
  sessionId: string;
  parentId: string | null;
  role: string | null;
  label: string | null;
  lastTs: number | null;
  resumed: boolean;
  /** Subagent only: undefined until the first status is emitted; true after end_turn, false while running. */
  ended?: boolean;
}

const norm = (p: string) => p.replace(/\\/g, '/');

export function claudeCtxForPath(
  file: string,
  _claudeDir: string,
  meta?: { agentType?: string; description?: string },
  opts?: { resumed?: boolean },
): ClaudeFileCtx {
  const resumed = opts?.resumed ?? false;
  const parts = norm(file).split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  const stem = base.replace(/\.jsonl$/i, '');
  const isSub = parts.length >= 3 && parts[parts.length - 2] === 'subagents';
  if (isSub) {
    const sessionId = parts[parts.length - 3];
    const agentId = stem.replace(/^agent-/, '');
    return {
      agentId: `claude:${sessionId}:${agentId}`,
      sessionId,
      parentId: `claude:${sessionId}`,
      role: meta?.agentType ?? null,
      label: meta?.description ?? null,
      lastTs: null,
      resumed,
    };
  }
  return { agentId: `claude:${stem}`, sessionId: stem, parentId: null, role: null, label: meta?.description ?? null, lastTs: null, resumed };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function parseClaudeLine(line: string, ctx: ClaudeFileCtx): NormalizedEvent[] {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return [{ type: 'parse_error', agentId: ctx.agentId }];
  }
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') {
    return [{ type: 'parse_error', agentId: ctx.agentId }];
  }

  const parsed = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  const ts: number | null = Number.isFinite(parsed) ? parsed : null;
  const prevTs = ctx.lastTs;
  const base = { id: ctx.agentId, source: 'claude' as const, sessionId: ctx.sessionId };
  const out: NormalizedEvent[] = [];

  // Label updates
  const title = rec.type === 'custom-title' ? rec.customTitle : rec.type === 'agent-name' ? rec.agentName : null;
  if (typeof title === 'string' && title) {
    ctx.label = title;
    out.push({ type: 'agent', agent: { ...base, label: title } });
  }

  // First timestamped record introduces the agent
  if (ts !== null && prevTs === null) {
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : null;
    const cwdBase = cwd ? path.win32.basename(norm(cwd)) : '';
    const label = ctx.label ?? (ctx.resumed ? null : cwdBase || null);
    const agent: any = { ...base, parentId: ctx.parentId };
    if (!ctx.resumed) agent.startedAt = ts;
    if (cwd) agent.cwd = cwd;
    if (label) agent.label = label;
    if (ctx.role) agent.role = ctx.role;
    out.push({ type: 'agent', agent });
  }

  const at = ts ?? ctx.lastTs ?? Date.now();
  let produced = false;

  if (rec.type === 'assistant') {
    const msg = rec.message ?? {};
    const info: any = {};
    if (typeof msg.model === 'string') info.model = msg.model;
    if (typeof rec.effort === 'string') info.effort = rec.effort;
    if (Object.keys(info).length) out.push({ type: 'agent', agent: { ...base, ...info } });

    const u = msg.usage;
    if (u && typeof u === 'object') {
      const id = String(msg.id ?? rec.uuid ?? `llm-${at}`);
      const tokensIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      out.push({
        type: 'call_start',
        call: {
          id, agentId: ctx.agentId, kind: 'llm', name: msg.model ?? 'llm', inputHash: '', inputPreview: '',
          startedAt: prevTs ?? at, tokensIn, tokensOut: u.output_tokens ?? 0,
        },
      });
      out.push({ type: 'call_end', agentId: ctx.agentId, callId: id, endedAt: at, ok: true, errorPreview: null });
      produced = true;
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === 'tool_use' && typeof b.id === 'string') {
          const name = String(b.name ?? 'tool');
          const h = inputHash(name, b.input);
          out.push({
            type: 'call_start',
            call: {
              id: b.id, agentId: ctx.agentId, kind: 'tool', name, inputHash: h.hash, inputPreview: h.preview,
              startedAt: at, tokensIn: null, tokensOut: null,
            },
          });
          produced = true;
        }
      }
    }
  } else if (rec.type === 'user') {
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const isErr = b.is_error === true;
          out.push({
            type: 'call_end', agentId: ctx.agentId, callId: b.tool_use_id, endedAt: at, ok: !isErr,
            errorPreview: isErr ? textOf(b.content).slice(0, 200) : null,
          });
          produced = true;
        }
      }
    }
  }

  if (ctx.parentId && (rec.type === 'assistant' || rec.type === 'user')) {
    if (rec.type === 'assistant' && rec.message?.stop_reason === 'end_turn') {
      ctx.ended = true;
      out.push({ type: 'agent', agent: { ...base, status: 'ended' } });
    } else if (ctx.ended !== false) {
      ctx.ended = false;
      out.push({ type: 'agent', agent: { ...base, status: 'running' } });
    }
  }

  if (ts !== null) {
    if (!produced && rec.type !== 'custom-title' && rec.type !== 'agent-name') out.push({ type: 'activity', agentId: ctx.agentId, at: ts });
    ctx.lastTs = ts;
  }
  return out;
}
