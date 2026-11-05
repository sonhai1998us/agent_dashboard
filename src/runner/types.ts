import type { Role, AgentKind, Effort } from '@/src/tickets/model';
import type { NormalizedEvent } from '@/src/core/model';

export interface RunSpec {
  agentId: string; ticketId: string; role: Role; agent: AgentKind; label: string; parentId: string | null;
  cwd: string; model: string; effort: Effort; prompt: string; systemPrompt: string; sessionId: string; resume: boolean;
  tools: string[]; allowedTools: string[]; addDirs: string[]; runDir: string;
  mcp: { url: string; token: string } | null; guard: { port: number; token: string };
}

export interface RunResult {
  exitCode: number | null; killed: boolean; isError: boolean; text: string; costUsd: number | null;
  rateLimited: boolean; sessionId: string; changedFiles: string[];
}

export interface RunSink { events(evs: NormalizedEvent[]): void; limited(on: boolean): void }
export interface RunHandle { pid: number | null; done: Promise<RunResult>; kill(): Promise<void> }
export type Runner = (spec: RunSpec, sink: RunSink) => RunHandle;
