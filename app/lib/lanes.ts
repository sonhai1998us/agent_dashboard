import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { fmtDuration } from './format';

export type BarState = 'ok' | 'error' | 'running' | 'unknown' | 'wait';
export interface Bar { callId: string; x: number; w: number; state: BarState; title: string; }
export interface LoopZone { x: number; w: number; }
/** Lượt model đang suy nghĩ/viết (call llm), hoặc lượt đang diễn ra mà chưa có message nào (`live`). */
export interface Think { x: number; w: number; title: string; live: boolean; }

export const WINDOWS_MIN = [1, 5, 15, 60] as const;
export const DEFAULT_WINDOW_MIN = 5;
const MIN_W = 2;
const STATE_TEXT: Record<BarState, string> = { ok: 'ok', error: 'lỗi', running: 'đang chạy', unknown: 'không rõ', wait: 'chờ subagent' };
const LOOP_SPAN = 20; // số call tool gần nhất dùng để tìm khoá lặp
const NO_WAIT: Set<string> = new Set();

/** Ids of this agent's calls that spawned a subagent which has not ended yet (the parent is waiting on it). */
export function waitingCallIds(agentId: string, agents: Iterable<AgentInfo>): Set<string> {
  const out = new Set<string>();
  for (const a of agents) {
    // a background subagent does not block its parent's call (it ends at launch)
    if (a.parentId === agentId && a.parentToolUseId && a.status !== 'ended' && a.requestShape !== 'background') out.add(a.parentToolUseId);
  }
  return out;
}

function stateOf(c: CallRecord, agent: AgentInfo, waiting: Set<string>): BarState {
  if (c.endedAt === null && waiting.has(c.id)) return 'wait';
  if (c.endedAt === null) return agent.status === 'running' ? 'running' : 'unknown';
  if (c.ok === false) return 'error';
  if (c.ok === true) return 'ok';
  return 'unknown';
}

export function layoutLane(
  calls: CallRecord[], agent: AgentInfo, win: { start: number; end: number }, width: number, alerts: Alert[],
  waiting: Set<string> = NO_WAIT,
): { bars: Bar[]; loopZones: LoopZone[]; thinks: Think[] } {
  const span = win.end - win.start;
  if (span <= 0 || width <= 0) return { bars: [], loopZones: [], thinks: [] };
  const px = (t: number): number => ((Math.min(Math.max(t, win.start), win.end) - win.start) / span) * width;
  const tools = calls.filter((c) => c.kind === 'tool').sort((a, b) => a.startedAt - b.startedAt);

  const bars: Bar[] = [];
  for (const c of tools) {
    const end = c.endedAt ?? win.end;
    if (end < win.start || c.startedAt > win.end) continue;
    const x = px(c.startedAt);
    const w = Math.max(MIN_W, px(end) - x);
    const state = stateOf(c, agent, waiting);
    const dur = c.endedAt === null ? STATE_TEXT[state === 'wait' ? 'wait' : 'running'] : fmtDuration(c.endedAt - c.startedAt);
    bars.push({
      callId: c.id, x, w: Math.min(w, Math.max(MIN_W, width - x)), state,
      title: `${STATE_TEXT[state]} · ${c.name}${c.inputPreview ? ` · ${c.inputPreview}` : ''} · ${dur}`,
    });
  }

  const loopZones: LoopZone[] = [];
  if (alerts.some((a) => a.active && a.kind === 'loop' && a.agentId === agent.id)) {
    const recent = tools.slice(-LOOP_SPAN);
    const counts = new Map<string, number>();
    for (const c of recent) { const k = `${c.name}:${c.inputHash}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    let top: string | null = null, n = 0;
    for (const [k, v] of counts) if (v > n) { n = v; top = k; }
    if (top && n >= 2) {
      const hits = recent.filter((c) => `${c.name}:${c.inputHash}` === top);
      const first = hits[0], last = hits[hits.length - 1];
      const a = px(first.startedAt), b = px(last.endedAt ?? last.startedAt);
      if (b >= a && last.startedAt >= win.start && first.startedAt <= win.end) loopZones.push({ x: a, w: Math.max(MIN_W, b - a) });
    }
  }
  return { bars, loopZones, thinks: layoutThinks(calls, tools, agent, win, px) };
}

const fmtTokens = (n: number | null): string => (n === null ? '' : ` · ${n.toLocaleString('vi-VN')} token ra`);

/**
 * Khoảng model suy nghĩ/viết giữa các tool call: mỗi call llm chạy từ sự kiện trước tới lúc message về.
 * Khi agent đang chạy mà không có tool nào mở, phần từ sự kiện cuối tới cuối cửa sổ là "đang nghĩ".
 */
function layoutThinks(
  calls: CallRecord[], tools: CallRecord[], agent: AgentInfo, win: { start: number; end: number }, px: (t: number) => number,
): Think[] {
  const out: Think[] = [];
  const push = (from: number, to: number, title: string, live: boolean) => {
    if (to < win.start || from > win.end || to <= from) return;
    const x = px(from);
    out.push({ x, w: Math.max(1, px(to) - x), title, live });
  };
  const running = agent.status === 'running';
  let last = agent.lastEventAt;
  for (const c of calls) {
    last = Math.max(last, c.endedAt ?? c.startedAt);
    if (c.kind !== 'llm') continue;
    if (c.endedAt === null) {
      if (running) push(c.startedAt, win.end, `đang nghĩ · ${c.name}`, true);
      continue;
    }
    push(c.startedAt, c.endedAt, `model nghĩ · ${c.name} · ${fmtDuration(c.endedAt - c.startedAt)}${fmtTokens(c.tokensOut)}`, false);
  }
  const toolOpen = tools.some((c) => c.endedAt === null);
  const llmOpen = calls.some((c) => c.kind === 'llm' && c.endedAt === null);
  if (running && !toolOpen && !llmOpen && last < win.end) {
    push(last, win.end, `đang nghĩ · ${fmtDuration(win.end - last)}`, true);
  }
  return out;
}
