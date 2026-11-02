import type { AgentInfo, Alert, CallRecord } from './model';

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface AgentMetrics {
  calls: number; errors: number; okRate: number | null;
  p50: number | null; p95: number | null; tokensIn: number; tokensOut: number; durationMs: number;
}

const endedTools = (calls: CallRecord[]) => calls.filter((c) => c.kind === 'tool' && c.endedAt !== null);
const latencies = (calls: CallRecord[]) => calls.map((c) => (c.endedAt as number) - c.startedAt);

export function agentMetrics(agent: AgentInfo, calls: CallRecord[], now: number): AgentMetrics {
  const tools = endedTools(calls);
  const errors = tools.filter((c) => c.ok === false).length;
  const ok = tools.filter((c) => c.ok === true).length;
  const lat = latencies(tools);
  let tokensIn = 0;
  let tokensOut = 0;
  for (const c of calls) {
    if (c.kind !== 'llm') continue;
    tokensIn += c.tokensIn ?? 0;
    tokensOut += c.tokensOut ?? 0;
  }
  return {
    calls: tools.length,
    errors,
    okRate: tools.length ? ok / tools.length : null,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    tokensIn,
    tokensOut,
    durationMs: (agent.status === 'running' ? now : agent.lastEventAt) - agent.startedAt,
  };
}

export interface GlobalMetrics { running: number; alerts: number; okRate1h: number | null; p50_1h: number | null; }

export function globalMetrics(agents: AgentInfo[], recentCalls: CallRecord[], alerts: Alert[], now: number): GlobalMetrics {
  const tools = endedTools(recentCalls).filter((c) => c.startedAt >= now - 3_600_000);
  const ok = tools.filter((c) => c.ok === true).length;
  return {
    running: agents.filter((a) => a.status === 'running').length,
    alerts: alerts.filter((a) => a.active).length,
    okRate1h: tools.length ? ok / tools.length : null,
    p50_1h: percentile(latencies(tools), 50),
  };
}
