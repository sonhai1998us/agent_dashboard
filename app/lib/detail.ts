import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { fmtDuration } from './format';

/** errorPreview giống nhau nhiều nhất trong các call tool, chỉ khi lặp ≥ 2 lần */
export function topRepeatedError(calls: CallRecord[]): { preview: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const c of calls) {
    if (c.kind !== 'tool' || !c.errorPreview) continue;
    counts.set(c.errorPreview, (counts.get(c.errorPreview) ?? 0) + 1);
  }
  let best: { preview: string; count: number } | null = null;
  for (const [preview, count] of counts) if (count >= 2 && (!best || count > best.count)) best = { preview, count };
  return best;
}

export function toolCalls(calls: CallRecord[]): CallRecord[] {
  return calls.filter((c) => c.kind === 'tool');
}

export type RowState = 'ok' | 'error' | 'running' | 'unknown';
export interface RowInfo { state: RowState; icon: string; text: string; durationMs: number | null; }

export function callRowState(c: CallRecord, agent: Pick<AgentInfo, 'status'> | undefined, now: number): RowInfo {
  if (c.endedAt === null) {
    if (agent?.status === 'running') return { state: 'running', icon: '…', text: 'đang chạy', durationMs: Math.max(0, now - c.startedAt) };
    return { state: 'unknown', icon: '?', text: 'không rõ', durationMs: null };
  }
  const durationMs = c.endedAt - c.startedAt;
  if (c.ok === false) return { state: 'error', icon: '✗', text: 'lỗi', durationMs };
  if (c.ok === true) return { state: 'ok', icon: '✓', text: 'ok', durationMs };
  return { state: 'unknown', icon: '?', text: 'không rõ', durationMs };
}

/** Văn bản pill cảnh báo; stuck/long_tool tính trực tiếp từ since vì message không được phát lại mỗi tick */
export function alertPill(a: Alert, now: number): string {
  const live = fmtDuration(now - a.since);
  if (a.kind === 'stuck') return `treo ${live}`;
  if (a.kind === 'long_tool') return `tool lâu ${live}`;
  return a.message;
}
