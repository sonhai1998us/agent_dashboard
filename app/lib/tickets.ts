import { isManagedId, type AgentInfo } from '@/src/core/model';
import type { ManagedState, Ticket } from '@/src/tickets/model';

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
