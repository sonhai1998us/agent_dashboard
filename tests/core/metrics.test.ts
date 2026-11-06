import { test, expect } from 'vitest';
import { percentile, agentMetrics, globalMetrics } from '@/src/core/metrics';
import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';

const agent = (o: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'claude:s1', source: 'claude', sessionId: 's1', parentId: null, parentToolUseId: null, requestShape: null, label: 'a', role: null,
  model: null, effort: null, cwd: null, pid: null, startedAt: 1000, lastEventAt: 5000,
  status: 'running', parseErrors: 0, ...o,
});
const call = (o: Partial<CallRecord> = {}): CallRecord => ({
  id: 'c', agentId: 'claude:s1', kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: '',
  startedAt: 1000, endedAt: 1100, ok: true, errorPreview: null, tokensIn: null, tokensOut: null, ...o,
});
const alert = (active: boolean): Alert => ({
  id: 'a', agentId: 'claude:s1', kind: 'stuck', level: 'warn', message: '', since: 0, active,
});

test('percentile nearest-rank', () => {
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  expect(percentile([], 50)).toBeNull();
});

test('agentMetrics bỏ qua call chưa kết thúc khi tính latency', () => {
  const calls = [
    call({ id: '1', startedAt: 0, endedAt: 100 }),
    call({ id: '2', startedAt: 0, endedAt: 300, ok: false }),
    call({ id: '3', startedAt: 0, endedAt: null, ok: null }),
  ];
  const m = agentMetrics(agent(), calls, 9000);
  expect(m.calls).toBe(2);
  expect(m.errors).toBe(1);
  expect(m.okRate).toBe(0.5);
  expect(m.p50).toBe(100);
  expect(m.p95).toBe(300);
});

test('agentMetrics cộng token từ llm call', () => {
  const calls = [
    call({ kind: 'llm', tokensIn: 10, tokensOut: 5 }),
    call({ kind: 'llm', tokensIn: 20, tokensOut: null }),
    call({ kind: 'tool', tokensIn: 999, tokensOut: 999 }),
  ];
  const m = agentMetrics(agent(), calls, 9000);
  expect(m.tokensIn).toBe(30);
  expect(m.tokensOut).toBe(5);
  expect(m.calls).toBe(1);
});

test('agentMetrics durationMs theo status, okRate null khi không có call', () => {
  expect(agentMetrics(agent({ status: 'running' }), [], 9000).durationMs).toBe(8000);
  const m = agentMetrics(agent({ status: 'ended' }), [], 9000);
  expect(m.durationMs).toBe(4000);
  expect(m.okRate).toBeNull();
  expect(m.p50).toBeNull();
});

test('globalMetrics đếm running, alert active và chỉ tính tool call trong 1h', () => {
  const now = 10_000_000;
  const calls = [
    call({ id: '1', startedAt: now - 1000, endedAt: now - 900, ok: true }),
    call({ id: '2', startedAt: now - 1000, endedAt: now - 700, ok: false }),
    call({ id: '3', startedAt: now - 4_000_000, endedAt: now - 3_999_000, ok: true }),
    call({ id: '4', startedAt: now - 500, endedAt: null, ok: null }),
    call({ id: '5', kind: 'llm', startedAt: now - 500, endedAt: now - 400 }),
  ];
  const g = globalMetrics(
    [agent(), agent({ id: 'x', status: 'idle' }), agent({ id: 'y' })],
    calls, [alert(true), alert(false), alert(true)], now,
  );
  expect(g).toEqual({ running: 2, alerts: 2, okRate1h: 0.5, p50_1h: 100 });
  expect(globalMetrics([], [], [], now)).toEqual({ running: 0, alerts: 0, okRate1h: null, p50_1h: null });
});

test('agentMetrics cộng token cache đọc/ghi của llm call', () => {
  const m = agentMetrics(agent(), [
    call({ id: 'l1', kind: 'llm', tokensIn: 1000, tokensOut: 50, cacheRead: 900, cacheWrite: 90 }),
    call({ id: 'l2', kind: 'llm', tokensIn: 500, tokensOut: 10, cacheRead: 400 }),
    call({ id: 't1', kind: 'tool', cacheRead: 999 }),
  ], 6000);
  expect(m).toMatchObject({ tokensIn: 1500, tokensOut: 60, cacheRead: 1300, cacheWrite: 90 });
});
