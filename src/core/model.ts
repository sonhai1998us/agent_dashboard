import type { ManagedAgent, Ticket, WaitSpan } from '@/src/tickets/model';

export type Source = 'claude' | 'codex';
export type AgentStatus = 'running' | 'idle' | 'ended' | 'queued' | 'limited';

export const isManagedId = (id: string): boolean => id.startsWith('acctv:');

export interface AgentInfo {
  id: string; // 'claude:<sessionId>' | 'claude:<sessionId>:<agentId>' | 'codex:<threadId>'
  source: Source;
  sessionId: string;
  parentId: string | null;
  /** Subagent only: id of the parent's tool call (Agent/Task) that spawned it. */
  parentToolUseId: string | null;
  /**
   * Subagent only (meta.json `requestShape`): a foreground subagent blocks the parent's spawning call;
   * a background one is launched async (the parent's call ends at once). null = unknown.
   */
  requestShape: 'background' | 'foreground' | null;
  label: string;
  role: string | null;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  pid: number | null;
  startedAt: number; // epoch ms
  lastEventAt: number; // epoch ms
  status: AgentStatus;
  parseErrors: number;
}

export interface CallRecord {
  id: string;
  agentId: string;
  kind: 'tool' | 'llm';
  name: string;
  inputHash: string;
  inputPreview: string; // <= 200 chars
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
  errorPreview: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export type AlertKind = 'stuck' | 'long_tool' | 'loop' | 'error_burst' | 'guard';

export interface Alert {
  id: string;
  agentId: string;
  kind: AlertKind;
  level: 'warn' | 'critical';
  message: string;
  since: number;
  active: boolean;
}

export type NormalizedEvent =
  | { type: 'agent'; agent: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'source' | 'sessionId'> }
  | { type: 'call_start'; call: Omit<CallRecord, 'endedAt' | 'ok' | 'errorPreview'> }
  | { type: 'call_end'; agentId: string; callId: string; endedAt: number; ok: boolean; errorPreview: string | null }
  | { type: 'activity'; agentId: string; at: number }
  | { type: 'parse_error'; agentId: string };

export type HubEvent =
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'call'; call: CallRecord }
  | { type: 'alert'; alert: Alert }
  | { type: 'ticket'; ticket: Ticket }
  | { type: 'managed'; managed: ManagedAgent }
  | { type: 'wait'; wait: WaitSpan };
