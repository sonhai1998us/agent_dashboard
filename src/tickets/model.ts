export type TicketStatus = 'draft' | 'planning' | 'awaiting_approval' | 'running' | 'done' | 'escalated' | 'cancelled';
/** explorer: đọc và tìm file liên quan để Controller giao cho Dev (chỉ đọc). */
export type Role = 'controller' | 'explorer' | 'dev' | 'designer' | 'qc';
export type WorkRole = Exclude<Role, 'controller'>;
export type AgentKind = 'claude' | 'codex';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RoleSpec {
  agent: AgentKind;
  model: string;
  effort: Effort;
}

export interface WorkPackage {
  id: string;
  role: WorkRole;
  title: string;
  task: string;
  files: string[];
}

export interface Plan {
  summary: string;
  difficulty: 'easy' | 'medium' | 'hard';
  packages: WorkPackage[];
  roles: Record<WorkRole, RoleSpec & { count: number }>;
  acceptance: string[];
  /** Chế độ server preview cho tool capture; thiếu thì dùng defaultMode của dự án. */
  preview?: { mode: 'dev' | 'prod' };
}

/** merged: đã vào nhánh đích tại `head`. conflict: merge dở trong thư mục dự án, chờ người dùng xử lý `conflicts`. */
export type TicketMerge =
  | { target: string; at: number; result: 'merged'; head: string; fastForward: boolean; upToDate: boolean }
  | { target: string; at: number; result: 'conflict'; conflicts: string[] };

export interface Ticket {
  id: string;
  seq: number;
  title: string;
  description: string;
  dir: string;
  status: TicketStatus;
  overrides: Partial<Record<Role, Partial<RoleSpec>>>;
  plan: Plan | null;
  feedback: string | null;
  round: number;
  maxRounds: number;
  controllerSessionId: string;
  branch: string | null;
  worktree: string | null;
  baseRef: string | null;
  pendingWait: string[] | null;
  report: string | null;
  diffStat: string | null;
  /** Lần merge nhánh ticket vào nhánh của người dùng gần nhất (nút Merge). */
  merge: TicketMerge | null;
  createdAt: number;
  updatedAt: number;
}

export type ManagedState = 'queued' | 'running' | 'limited' | 'waiting' | 'done' | 'failed' | 'stopped' | 'interrupted';

export interface ManagedAgent {
  agentId: string;
  ticketId: string;
  role: Role;
  ordinal: number;
  packageId: string | null;
  task: string;
  files: string[];
  runner: AgentKind;
  model: string;
  effort: Effort;
  sessionId: string;
  state: ManagedState;
  stopReason: string | null;
  resultText: string | null;
  changedFiles: string[];
  costUsd: number | null;
  createdAt: number;
  endedAt: number | null;
  /** Việc agent cần người dùng làm (đăng nhập, mở link…); agent ở trạng thái `waiting` cho tới khi người dùng trả lời. */
  userAction: UserAction | null;
}

export interface UserAction {
  id: string;
  title: string;
  message: string;
  /** chỉ http(s) */
  url: string | null;
  /** lệnh người dùng tự chạy trong terminal của mình */
  command: string | null;
  createdAt: number;
}

/**
 * Khoảng thời gian trên làn timeline không có call nào:
 * approval = chờ duyệt kế hoạch, agents = Controller chờ subagent,
 * startup = claude đang khởi động lượt chạy (từ lúc spawn tới dòng đầu tiên nó gửi về),
 * interrupted = lượt bị ngắt vì dashboard tắt/khởi động lại (từ event cuối tới lúc dashboard chạy lại).
 */
export interface WaitSpan {
  id: string;
  agentId: string;
  kind: 'approval' | 'agents' | 'startup' | 'interrupted';
  startedAt: number;
  endedAt: number | null;
}

export interface AgentReport {
  id: string;
  role: WorkRole;
  state: ManagedState;
  stopReason: string | null;
  summary: string;
  changedFiles: string[];
  calls: number;
  errors: number;
  guardBlocks: number;
  scopeViolations: number;
  topError: string | null;
}

export const TERMINAL_STATES: ManagedState[] = ['done', 'failed', 'stopped', 'interrupted'];
