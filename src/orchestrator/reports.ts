import { agentMetrics } from '@/src/core/metrics';
import { topRepeatedError } from '@/app/lib/detail';
import type { AgentInfo, CallRecord } from '@/src/core/model';
import type { AgentReport, ManagedAgent, WorkRole } from '@/src/tickets/model';

const GUARD = '[acctv-guard]';
const GUARD_SCOPE = '[acctv-guard] ngoài phạm vi';
export const SUMMARY_MAX = 4000;

/** Báo cáo của một worker cho Controller; `calls` theo thứ tự bất kỳ. */
export function agentReport(m: ManagedAgent, agent: AgentInfo | undefined, calls: CallRecord[], now: number): AgentReport {
  const tools = calls.filter((c) => c.kind === 'tool');
  const met = agent ? agentMetrics(agent, calls, now) : { calls: 0, errors: 0 };
  return {
    id: m.agentId,
    role: m.role as WorkRole,
    state: m.state,
    stopReason: m.stopReason,
    summary: (m.resultText ?? '').slice(0, SUMMARY_MAX),
    changedFiles: m.changedFiles,
    calls: met.calls,
    errors: met.errors,
    guardBlocks: tools.filter((c) => c.errorPreview?.startsWith(GUARD)).length,
    scopeViolations: tools.filter((c) => c.errorPreview?.startsWith(GUARD_SCOPE)).length,
    topError: topRepeatedError(calls)?.preview ?? null,
  };
}

const hms = (ts: number): string => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

/** Mỗi call tool một dòng, cũ trước: `HH:MM:SS ✓|✗|… <name> <inputPreview>[ → <errorPreview>]`. */
export function agentLog(calls: CallRecord[], limit: number): string {
  // listCalls trả mới trước: đảo lại rồi sort ổn định để call cùng thời điểm giữ đúng thứ tự
  const tools = calls.filter((c) => c.kind === 'tool').reverse().sort((a, b) => a.startedAt - b.startedAt).slice(-limit);
  if (!tools.length) return 'Chưa có call nào.';
  return tools
    .map((c) => {
      const icon = c.endedAt === null ? '…' : c.ok === false ? '✗' : '✓';
      const err = c.ok === false && c.errorPreview ? ` → ${c.errorPreview}` : '';
      return `${hms(c.startedAt)} ${icon} ${c.name} ${c.inputPreview}`.trimEnd() + err;
    })
    .join('\n');
}
