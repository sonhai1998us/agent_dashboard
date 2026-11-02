import { describe, expect, test } from 'vitest';
import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { initialState, reduce, type LiveState } from '@/app/lib/liveStore';

const call = (id: string, startedAt: number, o: Partial<CallRecord> = {}): CallRecord => ({
  id, agentId: 'a', kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: '', startedAt, endedAt: null,
  ok: null, errorPreview: null, tokensIn: null, tokensOut: null, ...o,
});
const agent = (id: string, o: Partial<AgentInfo> = {}): AgentInfo => ({
  id, source: 'claude', sessionId: id, parentId: null, label: id, role: null, model: null, effort: null,
  cwd: null, pid: null, startedAt: 0, lastEventAt: 0, status: 'running', parseErrors: 0, ...o,
});
const alert = (o: Partial<Alert> = {}): Alert => ({ id: 'al1', agentId: 'a', kind: 'stuck', level: 'warn', message: 'm', since: 1, active: true, ...o });

describe('reduce', () => {
  test('reduce: call event chèn vào calls[agentId] theo id, không nhân đôi', () => {
    let s: LiveState = initialState();
    s = reduce(s, { type: 'call', call: call('c1', 10) });
    s = reduce(s, { type: 'call', call: call('c2', 20) });
    s = reduce(s, { type: 'call', call: call('c1', 10, { endedAt: 15, ok: true }) });
    expect(s.calls.a.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(s.calls.a[1].ok).toBe(true);
  });
  test('reduce: conn disconnected giữ nguyên dữ liệu, lastUpdateAt không đổi', () => {
    let s = reduce(initialState(), { type: 'agent', agent: agent('a') });
    s = reduce(s, { type: 'metrics', metrics: { running: 1, alerts: 0, okRate1h: 1, p50_1h: 5 }, at: 1234 });
    const d = reduce(s, { type: 'conn', conn: 'disconnected' });
    expect(d.conn).toBe('disconnected');
    expect(d.lastUpdateAt).toBe(1234);
    expect(d.agents).toBe(s.agents);
    expect(d.metrics).toBe(s.metrics);
  });
  test('reduce: alert không còn active thì bị gỡ', () => {
    let s = reduce(initialState(), { type: 'alert', alert: alert() });
    expect(Object.keys(s.alerts)).toEqual(['al1']);
    s = reduce(s, { type: 'alert', alert: alert({ active: false }) });
    expect(s.alerts).toEqual({});
  });
  test('reduce: snapshot thay agents/alerts/metrics và đặt lastUpdateAt', () => {
    const s = reduce(initialState(), {
      type: 'snapshot', generatedAt: 99, agents: [agent('a')], alerts: [alert()],
      metrics: { running: 1, alerts: 1, okRate1h: null, p50_1h: null }, agentMetrics: {},
    });
    expect(Object.keys(s.agents)).toEqual(['a']);
    expect(s.alerts.al1).toBeDefined();
    expect(s.lastUpdateAt).toBe(99);
  });
});

describe('reduce: độ bền', () => {
  test('reduce: action lạ trả về đúng state cũ', () => {
    const s = reduce(initialState(), { type: 'agent', agent: agent('a') });
    expect(reduce(s, { type: 'bogus' } as never)).toBe(s);
  });
  test('reduce: agent event mới hơn snapshot không bị snapshot ghi đè', () => {
    let s = reduce(initialState(), { type: 'agent', agent: agent('a', { lastEventAt: 200, label: 'new' }) });
    s = reduce(s, { type: 'agent', agent: agent('b', { lastEventAt: 50 }) });
    s = reduce(s, {
      type: 'snapshot', generatedAt: 150, agents: [agent('a', { lastEventAt: 100, label: 'old' }), agent('b', { lastEventAt: 60, label: 'snap' })],
      alerts: [], metrics: { running: 0, alerts: 0, okRate1h: null, p50_1h: null }, agentMetrics: {},
    });
    expect(s.agents.a.label).toBe('new');
    expect(s.agents.b.label).toBe('snap');
  });
  test('reduce: alert event sau generatedAt sống sót qua snapshot, kể cả khi bị gỡ', () => {
    let s = reduce(initialState(), { type: 'alert', alert: alert({ id: 'x' }), at: 200 });
    s = reduce(s, { type: 'alert', alert: alert({ id: 'gone', active: false }), at: 200 });
    s = reduce(s, {
      type: 'snapshot', generatedAt: 100, agents: [], alerts: [alert({ id: 'gone' }), alert({ id: 'old' })],
      metrics: { running: 0, alerts: 0, okRate1h: null, p50_1h: null }, agentMetrics: {},
    });
    expect(Object.keys(s.alerts).sort()).toEqual(['old', 'x']);
  });
});

describe('reduce: snapshot với agent vắng mặt', () => {
  const snap = (generatedAt: number) => ({
    type: 'snapshot' as const, generatedAt, agents: [], alerts: [],
    metrics: { running: 0, alerts: 0, okRate1h: null, p50_1h: null }, agentMetrics: {},
  });
  test('reduce: agent vắng trong snapshot và cũ hơn generatedAt bị bỏ, kèm bỏ chọn', () => {
    let s = reduce(initialState(), { type: 'agent', agent: agent('a', { lastEventAt: 100 }) });
    s = reduce(s, { type: 'select', id: 'a' });
    s = reduce(s, snap(150));
    expect(s.agents).toEqual({});
    expect(s.selectedAgentId).toBeNull();
  });
  test('reduce: agent vắng trong snapshot nhưng mới hơn generatedAt được giữ', () => {
    let s = reduce(initialState(), { type: 'agent', agent: agent('a', { lastEventAt: 200 }) });
    s = reduce(s, { type: 'select', id: 'a' });
    s = reduce(s, snap(150));
    expect(Object.keys(s.agents)).toEqual(['a']);
    expect(s.selectedAgentId).toBe('a');
  });
});
