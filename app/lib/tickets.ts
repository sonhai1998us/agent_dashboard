import { isManagedId, type AgentInfo } from '@/src/core/model';
import type { ManagedState, Role, RoleSpec, Ticket, WaitSpan } from '@/src/tickets/model';
import { fmtDuration } from './format';

export type StatusTone = 'run' | 'wait' | 'warn' | 'crit' | 'ok' | 'ended';
export interface StatusText { icon: string; text: string; tone: StatusTone }

export const controllerIdOf = (ticketId: string): string => `acctv:${ticketId}:controller`;

export function ticketStatusText(t: Ticket): StatusText {
  switch (t.status) {
    case 'draft': return { icon: '○', text: 'nháp', tone: 'wait' };
    case 'planning': return { icon: '●', text: 'đang lập kế hoạch', tone: 'run' };
    case 'awaiting_approval': return { icon: '▲', text: 'chờ duyệt', tone: 'warn' };
    case 'running': return { icon: '●', text: `đang chạy · vòng ${Math.min(t.round + 1, t.maxRounds)}/${t.maxRounds}`, tone: 'run' };
    case 'done': return { icon: '✓', text: 'xong', tone: 'ok' };
    case 'escalated': return { icon: '■', text: 'cần bạn quyết', tone: 'crit' };
    case 'cancelled': return { icon: '○', text: 'đã huỷ', tone: 'ended' };
  }
}

/** Form tạo ticket gửi đúng lựa chọn đang hiển thị cho mọi vai (kể cả khi trùng mặc định): lựa chọn đó là bắt buộc với Controller. */
export function roleOverrides(specs: Record<Role, RoleSpec>): Record<Role, RoleSpec> {
  return Object.fromEntries((Object.keys(specs) as Role[]).map((r) => [r, { ...specs[r] }])) as Record<Role, RoleSpec>;
}

export type StatusAction = { kind: 'plan'; href: string; label: string } | { kind: 'decide'; label: string };

/** Badge trạng thái bấm được khi ticket đang chờ người dùng: chờ duyệt → trang duyệt, escalated → phần cần quyết. */
export function statusAction(t: Ticket): StatusAction | null {
  if (t.status === 'awaiting_approval') return { kind: 'plan', href: `/tickets/${t.id}/plan`, label: 'Mở trang duyệt kế hoạch' };
  if (t.status === 'escalated') return { kind: 'decide', label: 'Xem điều Controller cần bạn quyết' };
  return null;
}

export interface Inline { text: string; style: 'text' | 'bold' | 'code' }
export type ReportBlock = { kind: 'p'; parts: Inline[] } | { kind: 'li'; marker: string; parts: Inline[] };

function inlines(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index), style: 'text' });
    out.push(m[1] !== undefined ? { text: m[1], style: 'bold' } : { text: m[2], style: 'code' });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), style: 'text' });
  return out;
}

/** Báo cáo của Controller (markdown nhẹ) thành khối để hiển thị: đoạn, mục danh sách; **đậm** và `code` trong dòng. */
export function reportBlocks(md: string | null): ReportBlock[] {
  const out: ReportBlock[] = [];
  for (const raw of (md ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const li = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) out.push({ kind: 'li', marker: /^\d/.test(li[1]) ? li[1].replace(')', '.') : '•', parts: inlines(li[2]) });
    else out.push({ kind: 'p', parts: inlines(line) });
  }
  return out;
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
  waits: WaitSpan[], agentId: string, win: { start: number; end: number }, width: number, now: number = win.end,
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
      title: `${w.kind === 'approval' ? 'chờ duyệt kế hoạch' : 'chờ subagent'} · ${fmtDuration((w.endedAt ?? now) - w.startedAt)}`,
    });
  }
  return out;
}

export function replayRange(nodes: AgentInfo[], now: number): { min: number; max: number; live: boolean } {
  const live = nodes.some((n) => n.status !== 'ended');
  const min = nodes.length ? Math.min(...nodes.map((n) => n.startedAt)) : now;
  const max = live ? now : nodes.length ? Math.max(...nodes.map((n) => n.lastEventAt)) : now;
  return { min, max, live };
}

const ENDED_TICKET: Ticket['status'][] = ['done', 'escalated', 'cancelled'];

/** Thời gian làm của một agent: từ lúc được giao/bắt đầu tới event cuối; còn chạy thì tới `now`. */
export function agentWorkMs(a: Pick<AgentInfo, 'startedAt' | 'lastEventAt' | 'status'>, now: number): number {
  const end = a.status === 'ended' ? a.lastEventAt : now;
  return Math.max(0, end - a.startedAt);
}

export interface TicketDuration { totalMs: number; approvalMs: number; live: boolean }

/**
 * Tổng thời gian ticket: từ lúc tạo tới event cuối của agent trong ticket (ticket đã kết thúc) hoặc tới `now`.
 * `approvalMs`: thời gian chờ người dùng duyệt kế hoạch (nằm trong tổng).
 */
export function ticketDuration(t: Ticket, agents: AgentInfo[], waits: WaitSpan[], now: number): TicketDuration {
  const prefix = `acctv:${t.id}:`;
  const mine = agents.filter((a) => a.id.startsWith(prefix));
  const live = !ENDED_TICKET.includes(t.status);
  const lastEvent = mine.length ? Math.max(...mine.map((a) => a.lastEventAt)) : t.updatedAt;
  const end = live ? now : Math.max(t.createdAt, lastEvent);
  let approvalMs = 0;
  for (const w of waits) {
    if (w.kind !== 'approval' || !w.agentId.startsWith(prefix)) continue;
    const s = Math.max(w.startedAt, t.createdAt);
    const e = Math.min(w.endedAt ?? end, end);
    if (e > s) approvalMs += e - s;
  }
  return { totalMs: Math.max(0, end - t.createdAt), approvalMs, live };
}
