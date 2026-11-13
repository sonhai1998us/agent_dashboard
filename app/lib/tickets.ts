import { isManagedId, type AgentInfo } from '@/src/core/model';
import { FEEDBACK_EXT, FEEDBACK_IMAGE_BYTES, FEEDBACK_IMAGES_MAX, type FeedbackKind, type ManagedAgent, type ManagedState, type Role, type RoleSpec, type Ticket, type TicketMerge, type WaitSpan } from '@/src/tickets/model';
import { fmtClock, fmtDuration } from './format';
import type { PreviewStatus } from '@/src/preview/server';

/** Chip trạng thái server preview của ticket. */
export function previewLabel(s: PreviewStatus | null | undefined): string {
  switch (s?.state) {
    case 'starting': return 'Server: đang bật';
    case 'building': return 'Server: đang build';
    case 'ready': return `Server: sẵn sàng :${s.port} (${s.mode})`;
    case 'failed': return 'Server: lỗi';
    default: return 'Server: tắt';
  }
}

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

export interface WaitBox { x: number; w: number; title: string; kind: WaitSpan['kind'] }

const WAIT_TEXT: Record<WaitSpan['kind'], string> = {
  approval: 'chờ duyệt kế hoạch', agents: 'chờ subagent', startup: 'claude đang khởi động lượt chạy',
  interrupted: 'gián đoạn: dashboard tắt/khởi động lại, phần model đang làm bị mất',
};

/** Agent có khoảng khởi động đang mở (chưa gửi về dòng nào). */
export const isStartingUp = (waits: WaitSpan[], agentId: string): boolean =>
  waits.some((w) => w.agentId === agentId && w.kind === 'startup' && w.endedAt === null);

export function layoutWaits(
  waits: WaitSpan[], agentId: string, win: { start: number; end: number }, width: number, now: number = win.end,
): WaitBox[] {
  const span = win.end - win.start;
  if (span <= 0 || width <= 0) return [];
  const px = (t: number): number => ((Math.min(Math.max(t, win.start), win.end) - win.start) / span) * width;
  const out: WaitBox[] = [];
  for (const w of waits) {
    if (w.agentId !== agentId) continue;
    const end = w.endedAt ?? win.end;
    if (end < win.start || w.startedAt > win.end) continue;
    const x = px(w.startedAt);
    out.push({
      x, w: Math.max(2, px(end) - x), kind: w.kind,
      title: `${WAIT_TEXT[w.kind] ?? w.kind} · ${fmtDuration((w.endedAt ?? now) - w.startedAt)}`,
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

/** Nút Merge: ticket không còn agent chạy (done, escalated, cancelled) và đã có nhánh. */
export const canMerge = (t: Ticket): boolean => (t.status === 'done' || t.status === 'escalated' || t.status === 'cancelled') && !!t.branch;

/** Nút xoá: ticket đã kết thúc; phiên không còn chạy. Server kiểm tra lại (agent con, merge đang chạy…). */
export const canDeleteTicket = (t: Ticket): boolean => t.status === 'done' || t.status === 'escalated' || t.status === 'cancelled';
export const canDeleteSession = (a: AgentInfo): boolean => a.status === 'idle' || a.status === 'ended';

/** Dòng kết quả lần merge gần nhất trên header ticket. */
export function mergeText(m: TicketMerge | null | undefined): { tone: 'ok' | 'crit'; text: string } | null {
  if (!m) return null;
  if (m.result === 'conflict') return { tone: 'crit', text: `merge vào ${m.target} bị xung đột · ${fmtClock(m.at)}` };
  if (m.result === 'staged') {
    return m.files.length
      ? { tone: 'ok', text: `đã đưa ${m.files.length} file vào ${m.target}, chưa commit · ${fmtClock(m.at)}` }
      : { tone: 'ok', text: `${m.target} đã có sẵn mọi thay đổi của nhánh ticket, không có gì mới để đưa vào · ${fmtClock(m.at)}` };
  }
  if (m.upToDate) return { tone: 'ok', text: `${m.target} đã có sẵn mọi thay đổi của nhánh ticket, không có gì mới để merge · ${fmtClock(m.at)}` };
  return { tone: 'ok', text: `đã merge vào ${m.target} @ ${m.head.slice(0, 7)}${m.fastForward ? ' (fast-forward)' : ''} · ${fmtClock(m.at)}` };
}

/** Nút Góp ý để làm tiếp: chỉ ticket đã xong. */
export const canFeedback = (t: Ticket): boolean => t.status === 'done';

/** Lý do không nhận ảnh góp ý (sai định dạng, quá lớn, quá số lượng); null = nhận. `count`: số ảnh đã có. */
export function feedbackFileError(f: { name: string; type: string; size: number }, count: number): string | null {
  if (count >= FEEDBACK_IMAGES_MAX) return `Tối đa ${FEEDBACK_IMAGES_MAX} ảnh mỗi lần góp ý`;
  if (!FEEDBACK_EXT[f.type]) return `${f.name}: chỉ nhận ảnh png, jpg, webp, gif`;
  if (f.size > FEEDBACK_IMAGE_BYTES) return `${f.name}: ảnh lớn hơn 5MB`;
  return null;
}

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  plan: 'Góp ý kế hoạch',
  result: 'Góp ý để làm tiếp',
  guidance: 'Chỉ đạo khi tiếp tục',
};

/** "08/11 14:05" — năm khác năm nay thì thêm năm. */
export function fmtDateTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `/${d.getFullYear()}`;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}${year} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Nhánh mặc định để tạo nhánh gốc mới: dev-main, rồi nhánh đang checkout, rồi nhánh đầu. */
export function defaultBaseFrom(branches: string[], current: string | null): string | null {
  if (branches.includes('dev-main')) return 'dev-main';
  if (current && branches.includes(current)) return current;
  return branches[0] ?? null;
}

/** Nhánh gốc từ ô nhập của form; repo chưa có commit (chưa có nhánh nào) → bỏ, worktree tách từ HEAD như ticket cũ. */
export function baseChoice(branches: string[], input: string): { name: string; isNew: boolean } {
  const name = branches.length ? input.trim() : '';
  return { name, isNew: name !== '' && !branches.includes(name) };
}

/** Tổng chi phí của ticket: Controller + mọi agent con; null khi chưa agent nào báo chi phí. */
export function ticketCost(managed: Record<string, Pick<ManagedAgent, 'ticketId' | 'costUsd'>>, ticketId: string): number | null {
  let sum: number | null = null;
  for (const m of Object.values(managed)) if (m.ticketId === ticketId && m.costUsd !== null) sum = (sum ?? 0) + m.costUsd;
  return sum;
}
