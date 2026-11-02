import { test, expect } from 'vitest';
import { Store } from '@/src/core/store';
import { Hub } from '@/src/core/hub';
import type { Alert, HubEvent } from '@/src/core/model';

const agentEv = { type: 'agent', agent: { id: 'claude:s1', source: 'claude', sessionId: 's1', label: 'demo', startedAt: 1000, lastEventAt: 1000 } } as const;
const callStart = (over: object = {}) => ({ type: 'call_start' as const, call: { id: 'c1', agentId: 'claude:s1', kind: 'tool' as const, name: 'Bash', inputHash: 'h', inputPreview: 'npm test', startedAt: 2000, tokensIn: null, tokensOut: null, ...over } });

test('call_start rồi call_end tạo một CallRecord hoàn chỉnh', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent(callStart());
  const out = s.applyEvent({ type: 'call_end', agentId: 'claude:s1', callId: 'c1', endedAt: 2500, ok: false, errorPreview: 'exit 1' });
  expect(out).toContainEqual(expect.objectContaining({ type: 'call', call: expect.objectContaining({ id: 'c1', ok: false, endedAt: 2500 }) }));
  expect(s.getAgent('claude:s1')!.lastEventAt).toBe(2500);
});

test('call_start trùng id không tạo bản ghi thứ hai', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent(callStart()); s.applyEvent(callStart());
  expect(s.listCalls('claude:s1').length).toBe(1);
});

test('llm call trùng id: tokens lấy MAX(cũ, mới)', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  const llm = (i: number | null, o: number | null) => callStart({ id: 'l1', kind: 'llm', name: 'm', tokensIn: i, tokensOut: o });
  s.applyEvent(llm(10, 5)); s.applyEvent(llm(7, 20)); s.applyEvent(llm(null, null));
  const c = s.listCalls('claude:s1')[0];
  expect(s.listCalls('claude:s1').length).toBe(1);
  expect(c.tokensIn).toBe(10); expect(c.tokensOut).toBe(20);
});

test('tool call trùng id không đổi tokens', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent(callStart({ tokensIn: 1 })); s.applyEvent(callStart({ tokensIn: 99 }));
  expect(s.listCalls('claude:s1')[0].tokensIn).toBe(1);
});

test('call_end không có call_start bị bỏ qua, trả về []', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  expect(s.applyEvent({ type: 'call_end', agentId: 'claude:s1', callId: 'zz', endedAt: 5, ok: true, errorPreview: null })).toEqual([]);
  expect(s.listCalls('claude:s1')).toEqual([]);
});

test('parse_error tăng agent.parseErrors', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent({ type: 'parse_error', agentId: 'claude:s1' }); s.applyEvent({ type: 'parse_error', agentId: 'claude:s1' });
  expect(s.getAgent('claude:s1')!.parseErrors).toBe(2);
});

test('offset lưu và đọc lại', () => {
  const s = new Store(':memory:');
  expect(s.getOffset('f')).toBeUndefined();
  s.setOffset('f', 120, 3);
  expect(s.getOffset('f')).toEqual({ offset: 120, lines: 3 });
  s.setOffset('f', 200, 5);
  expect(s.getOffset('f')).toEqual({ offset: 200, lines: 5 });
});

test('upsertAlert cùng id cập nhật; activeAlerts chỉ trả active', () => {
  const s = new Store(':memory:');
  const a: Alert = { id: 'a1', agentId: 'x', kind: 'stuck', level: 'warn', message: 'm', since: 1, active: true };
  s.upsertAlert(a); s.upsertAlert({ ...a, id: 'a2', kind: 'loop' });
  expect(s.activeAlerts().length).toBe(2);
  s.upsertAlert({ ...a, level: 'critical', active: false });
  expect(s.activeAlerts().map(x => x.id)).toEqual(['a2']);
});

test('agent đầu tiên dùng mặc định; agent event sau chỉ ghi đè field được cung cấp', () => {
  const s = new Store(':memory:');
  s.applyEvent({ type: 'agent', agent: { id: 'codex:t1', source: 'codex', sessionId: 't1', cwd: 'D:\\Work\\proj', startedAt: 10 } });
  let a = s.getAgent('codex:t1')!;
  expect(a).toMatchObject({ parentId: null, label: 'proj', role: null, model: null, effort: null, cwd: 'D:\\Work\\proj', pid: null, startedAt: 10, lastEventAt: 10, status: 'idle', parseErrors: 0 });
  s.applyEvent({ type: 'agent', agent: { id: 'codex:t1', source: 'codex', sessionId: 't1', model: 'gpt', role: undefined } });
  a = s.getAgent('codex:t1')!;
  expect(a.model).toBe('gpt'); expect(a.label).toBe('proj'); expect(a.startedAt).toBe(10);
  s.applyEvent({ type: 'agent', agent: { id: 'claude:q', source: 'claude', sessionId: 'q' } });
  expect(s.getAgent('claude:q')!.label).toBe('claude:q');
});

test('call_start/activity/parse_error cho agent lạ tự tạo agent', () => {
  const s = new Store(':memory:');
  s.applyEvent(callStart({ agentId: 'claude:s9:ag1', startedAt: 77 }));
  expect(s.getAgent('claude:s9:ag1')).toMatchObject({ source: 'claude', sessionId: 's9', status: 'idle', lastEventAt: 77 });
  s.applyEvent({ type: 'activity', agentId: 'codex:t5', at: 5 });
  expect(s.getAgent('codex:t5')).toMatchObject({ source: 'codex', sessionId: 't5', lastEventAt: 5 });
  s.applyEvent({ type: 'parse_error', agentId: 'codex:t6' });
  expect(s.getAgent('codex:t6')!.parseErrors).toBe(1);
  s.applyEvent({ type: 'call_end', agentId: 'claude:nope', callId: 'x', endedAt: 1, ok: true, errorPreview: null });
  expect(s.getAgent('claude:nope')).toBeDefined();
});

test('activity nâng lastEventAt, không bao giờ hạ', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent({ type: 'activity', agentId: 'claude:s1', at: 5000 });
  s.applyEvent({ type: 'activity', agentId: 'claude:s1', at: 3000 });
  expect(s.getAgent('claude:s1')!.lastEventAt).toBe(5000);
});

test('openCalls, listCalls (mới nhất trước, limit/since), listAgents since, setAgentStatus', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent(callStart({ id: 'a', startedAt: 100 })); s.applyEvent(callStart({ id: 'b', startedAt: 200 })); s.applyEvent(callStart({ id: 'c', startedAt: 300 }));
  s.applyEvent({ type: 'call_end', agentId: 'claude:s1', callId: 'a', endedAt: 150, ok: true, errorPreview: null });
  expect(s.openCalls('claude:s1').map(c => c.id).sort()).toEqual(['b', 'c']);
  expect(s.listCalls('claude:s1').map(c => c.id)).toEqual(['c', 'b', 'a']);
  expect(s.listCalls('claude:s1', { limit: 1 }).map(c => c.id)).toEqual(['c']);
  expect(s.listCalls('claude:s1', { since: 200 }).map(c => c.id)).toEqual(['c', 'b']);
  expect(s.listAgents({ since: 99999 })).toEqual([]);
  expect(s.listAgents().length).toBe(1);
  expect(s.setAgentStatus('claude:s1', 'running', 42)).toMatchObject({ status: 'running', pid: 42 });
  expect(s.setAgentStatus('claude:s1', 'ended')).toMatchObject({ status: 'ended', pid: 42 });
  expect(s.setAgentStatus('nope', 'ended')).toBeUndefined();
});

test('inputPreview bị cắt còn 200 ký tự', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent(callStart({ inputPreview: 'x'.repeat(500) }));
  expect(s.listCalls('claude:s1')[0].inputPreview.length).toBe(200);
});

test('Hub publish/subscribe/unsubscribe', () => {
  const h = new Hub(); const got: HubEvent[] = [];
  const un = h.subscribe(e => got.push(e));
  const ev: HubEvent = { type: 'alert', alert: { id: 'a', agentId: 'x', kind: 'stuck', level: 'warn', message: '', since: 0, active: true } };
  h.publish(ev); un(); h.publish(ev);
  expect(got).toEqual([ev]);
});

test('orphan call_end nâng lastEventAt của agent đã có, vẫn trả []', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  expect(s.applyEvent({ type: 'call_end', agentId: 'claude:s1', callId: 'zz', endedAt: 9000, ok: true, errorPreview: null })).toEqual([]);
  expect(s.getAgent('claude:s1')!.lastEventAt).toBe(9000);
});

test('orphan call_end tự tạo agent thì phát sự kiện agent', () => {
  const s = new Store(':memory:');
  const out = s.applyEvent({ type: 'call_end', agentId: 'claude:new', callId: 'zz', endedAt: 4000, ok: true, errorPreview: null });
  expect(out).toEqual([expect.objectContaining({ type: 'agent', agent: expect.objectContaining({ id: 'claude:new', lastEventAt: 4000 }) })]);
});

test('transaction: commit gộp ghi, lỗi thì rollback', () => {
  const s = new Store(':memory:');
  s.transaction(() => { s.setOffset('a', 1, 1); s.setOffset('b', 2, 2); });
  expect(s.getOffset('b')).toEqual({ offset: 2, lines: 2 });
  expect(() => s.transaction(() => { s.setOffset('c', 3, 3); throw new Error('boom'); })).toThrow('boom');
  expect(s.getOffset('c')).toBeUndefined();
});

test('PRAGMA synchronous = NORMAL (1)', () => {
  const s = new Store(':memory:');
  expect((s as any).db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
});

test('recentCalls: mọi agent, startedAt >= since', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent({ ...agentEv, agent: { ...agentEv.agent, id: 'claude:s2' } } as any);
  s.applyEvent(callStart({ id: 'a', startedAt: 100 }));
  s.applyEvent(callStart({ id: 'b', startedAt: 200 }));
  s.applyEvent(callStart({ id: 'c', agentId: 'claude:s2', startedAt: 300 }));
  s.applyEvent(callStart({ id: 'd', kind: 'llm', name: 'm', startedAt: 400 }));
  expect(s.recentCalls(200).map(c => c.id).sort()).toEqual(['b', 'c', 'd']);
  expect(s.recentCalls(1000)).toEqual([]);
});

test('calls có index theo started_at (recentCalls không quét toàn bảng)', () => {
  const s = new Store(':memory:');
  const plan = (s as any).db.prepare('EXPLAIN QUERY PLAN SELECT * FROM calls WHERE started_at >= ? ORDER BY started_at DESC, rowid DESC').all(0) as { detail: string }[];
  expect(plan.map((p) => p.detail).join(' | ')).toMatch(/USING INDEX idx_calls_started/);
});
