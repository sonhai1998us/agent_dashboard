import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import type { Thresholds } from '@/src/core/config';

export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const tools = (calls: CallRecord[]) => calls.filter((c) => c.kind === 'tool');

function mk(a: AgentInfo, kind: Alert['kind'], level: Alert['level'], message: string, since: number): Alert {
  return { id: `${a.id}:${kind}`, agentId: a.id, kind, level, message, since, active: true };
}

export function detectStuck(a: AgentInfo, open: CallRecord[], now: number, t: Thresholds): Alert | null {
  if (a.status !== 'running' || tools(open).length > 0) return null;
  const quiet = now - a.lastEventAt;
  if (quiet <= t.stuckMs) return null;
  return mk(a, 'stuck', 'warn', `im lặng ${fmtDur(quiet)}`, a.lastEventAt + t.stuckMs);
}

export function detectLongTool(a: AgentInfo, open: CallRecord[], now: number, t: Thresholds): Alert | null {
  if (a.status !== 'running') return null;
  const oldest = tools(open).reduce<CallRecord | null>((m, c) => (!m || c.startedAt < m.startedAt ? c : m), null);
  if (!oldest) return null;
  const dur = now - oldest.startedAt;
  if (dur <= t.longToolMs) return null;
  return mk(a, 'long_tool', 'warn', `${oldest.name} chạy ${fmtDur(dur)}`, oldest.startedAt + t.longToolMs);
}

const keyOf = (c: CallRecord) => `${c.name}:${c.inputHash}`;
const windowOf = (calls: CallRecord[], t: Thresholds) => tools(calls).slice(-t.loopWindow);

export function detectLoop(a: AgentInfo, recentTools: CallRecord[], t: Thresholds): Alert | null {
  const w = windowOf(recentTools, t);
  if (w.length === 0) return null;
  const keys = w.map(keyOf);
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  let n1 = 0, top = keys[0];
  for (const [k, v] of counts) if (v > n1) { n1 = v; top = k; }

  let n2 = 0;
  const L = keys.length;
  if (L >= 2 && keys[L - 1] !== keys[L - 2]) {
    const kb = keys[L - 1], ka = keys[L - 2];
    while (L - 2 * (n2 + 1) >= 0 && keys[L - 2 * (n2 + 1)] === ka && keys[L - 2 * (n2 + 1) + 1] === kb) n2++;
  }

  const n = Math.max(n1, n2);
  if (n < t.loopWarn) return null;
  const level = n >= t.loopCritical ? 'critical' : 'warn';
  const since = w[0].startedAt;
  if (n2 >= n1 && n2 >= 2) {
    return mk(a, 'loop', level, `lặp ${n}× ${w[L - 2].name} ↔ ${w[L - 1].name}`, since);
  }
  const sample = w[keys.lastIndexOf(top)];
  return mk(a, 'loop', level, `lặp ${n}× ${sample.name} ${sample.inputPreview.slice(0, 40)}`, since);
}

export function detectErrorBurst(a: AgentInfo, recentTools: CallRecord[], t: Thresholds): Alert | null {
  const w = windowOf(recentTools, t);
  let n = 0;
  let first = 0;
  for (let i = w.length - 1; i >= 0; i--) {
    const c = w[i];
    if (c.endedAt === null) continue;
    if (c.ok === false) { n++; first = c.startedAt; } else break;
  }
  if (n < t.errorBurst) return null;
  return mk(a, 'error_burst', 'critical', `${n} call lỗi liên tiếp`, first);
}
