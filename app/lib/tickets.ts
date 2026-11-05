import { isManagedId, type AgentInfo } from '@/src/core/model';
import type { ManagedState, Ticket, WaitSpan } from '@/src/tickets/model';
import { fmtDuration } from './format';

export type StatusTone = 'run' | 'wait' | 'warn' | 'crit' | 'ok' | 'ended';
export interface StatusText { icon: string; text: string; tone: StatusTone }

export const controllerIdOf = (ticketId: string): string => `acctv:${ticketId}:controller`;

export function ticketStatusText(t: Ticket): StatusText {
  switch (t.status) {
    case 'draft': return { icon: '○', text: 'nháp', tone: 'wait' };
    case 'planning': return { icon: '●', text: 'đang lập kế hoạch', tone: 'run' };
    case 'awaiting_approval': return { icon: '▲', text: 'chờ duyệt', tone: 'warn' };
    case 'running': return { icon: '●', text: `đang chạy · vòng ${t.round + 1}/${t.maxRounds}`, tone: 'run' };
    case 'done': return { icon: '✓', text: 'xong', tone: 'ok' };
    case 'escalated': return { icon: '■', text: 'cần bạn quyết', tone: 'crit' };
    case 'cancelled': return { icon: '○', text: 'đã huỷ', tone: 'ended' };
  }
}

const MANAGED: Record<ManagedState, StatusText> = {
  queued: { icon: '◌', text: 'xếp hàng', tone: 'wait' },
  running: { icon: '●', text: 'đang chạy', tone: 'run' },
  limited: { icon: '⏸', text: 'bị giới hạn', tone: 'warn' },
  waiting: { icon: '◷', text: 'đang chờ', tone: 'wait' },
  done: { icon: '✓', text: 'xong', tone: 'ok' },
  failed: { icon: '✗', text: 'thất bại', tone: 'crit' },
  stopped: { icon: '■', text: 'bị dừng', tone: 'ended' },
  interrupted: { icon: '○', text: 'bị gián đoạn', tone: 'ended' },
};

export const managedStateText = (s: ManagedState): StatusText => MANAGED[s];

export const isExternal = (a: AgentInfo): boolean => !isManagedId(a.id);

export function layoutWaits(
  waits: WaitSpan[], agentId: string, win: { start: number; end: number }, width: number,
): { x: number; w: number; title: string }[] {
  const span = win.end - win.start;
  if (span <= 0 || width <= 0) return [];
  const px = (t: number): number => ((Math.min(Math.max(t, win.start), win.end) - win.start) / span) * width;
  const out: { x: number; w: number; title: string }[] = [];
  for (const w of waits) {
    if (w.agentId !== agentId) continue;
    const end = w.endedAt ?? win.end;
    if (end < win.start || w.startedAt > win.end) continue;
    const x = px(w.startedAt);
    out.push({
      x, w: Math.max(2, px(end) - x),
      title: `${w.kind === 'approval' ? 'chờ duyệt kế hoạch' : 'chờ subagent'} · ${fmtDuration(end - w.startedAt)}`,
    });
  }
  return out;
}

export function replayRange(nodes: AgentInfo[], now: number): { min: number; max: number; live: boolean } {
  const live = nodes.some((n) => n.status === 'running' || n.status === 'queued' || n.status === 'limited');
  const min = nodes.length ? Math.min(...nodes.map((n) => n.startedAt)) : now;
  const max = live ? now : nodes.length ? Math.max(...nodes.map((n) => n.lastEventAt)) : now;
  return { min, max, live };
}
