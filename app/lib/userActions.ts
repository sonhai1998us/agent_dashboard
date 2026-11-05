import type { ManagedAgent, Ticket, UserAction } from '@/src/tickets/model';

export interface PendingUserAction {
  agentId: string;
  ticketId: string;
  ticketTitle: string;
  /** "Dev-2" … (nhãn của agent, nếu đã biết) */
  label: string;
  action: UserAction;
}

/** Các yêu cầu đang chờ người dùng, cũ trước. */
export function pendingUserActions(
  managed: Record<string, ManagedAgent>, tickets: Record<string, Ticket>, labels: Record<string, string | undefined> = {},
): PendingUserAction[] {
  return Object.values(managed)
    .filter((m): m is ManagedAgent & { userAction: UserAction } => !!m.userAction && m.role !== 'controller')
    .map((m) => ({
      agentId: m.agentId, ticketId: m.ticketId, ticketTitle: tickets[m.ticketId]?.title ?? m.ticketId,
      label: labels[m.agentId] ?? m.agentId, action: m.userAction,
    }))
    .sort((a, b) => a.action.createdAt - b.action.createdAt || a.agentId.localeCompare(b.agentId));
}

/** Chỉ trả link http(s) (server đã kiểm, kiểm lại ở client trước khi đặt vào href). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Sự kiện cửa sổ để mở lại hộp thoại (từ TopBar, ManagedPanel); `detail` là agentId muốn xem, nếu có. */
export const OPEN_USER_ACTIONS = 'acctv:open-user-actions';

export function openUserActions(agentId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_USER_ACTIONS, { detail: agentId ?? null }));
}
