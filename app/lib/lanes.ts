import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { fmtDuration } from './format';

export type BarState = 'ok' | 'error' | 'running' | 'unknown';
export interface Bar { callId: string; x: number; w: number; state: BarState; title: string; }
export interface LoopZone { x: number; w: number; }

export const WINDOWS_MIN = [1, 5, 15, 60] as const;
export const DEFAULT_WINDOW_MIN = 5;
const MIN_W = 2;
const LOOP_SPAN = 20; // số call tool gần nhất dùng để tìm khoá lặp

function stateOf(c: CallRecord, agent: AgentInfo): BarState {
  if (c.endedAt === null) return agent.status === 'running' ? 'running' : 'unknown';
  if (c.ok === false) return 'error';
  if (c.ok === true) return 'ok';
  return 'unknown';
}

export function layoutLane(
  calls: CallRecord[], agent: AgentInfo, win: { start: number; end: number }, width: number, alerts: Alert[],
): { bars: Bar[]; loopZones: LoopZone[] } {
  const span = win.end - win.start;
  if (span <= 0 || width <= 0) return { bars: [], loopZones: [] };
  const px = (t: number): number => ((Math.min(Math.max(t, win.start), win.end) - win.start) / span) * width;
  const tools = calls.filter((c) => c.kind === 'tool').sort((a, b) => a.startedAt - b.startedAt);

  const bars: Bar[] = [];
  for (const c of tools) {
    const end = c.endedAt ?? win.end;
    if (end < win.start || c.startedAt > win.end) continue;
    const x = px(c.startedAt);
    const w = Math.max(MIN_W, px(end) - x);
    const dur = c.endedAt === null ? 'đang chạy' : fmtDuration(c.endedAt - c.startedAt);
    bars.push({
      callId: c.id, x, w: Math.min(w, Math.max(MIN_W, width - x)), state: stateOf(c, agent),
      title: `${c.name}${c.inputPreview ? ` · ${c.inputPreview}` : ''} · ${dur}`,
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
  return { bars, loopZones };
}
