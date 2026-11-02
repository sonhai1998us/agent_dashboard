import { test, expect } from 'vitest';
import { detectStuck, detectLongTool, detectLoop, detectErrorBurst } from '@/src/detect/rules';
import { DEFAULT_THRESHOLDS as T } from '@/src/core/config';
import type { AgentInfo, CallRecord } from '@/src/core/model';

const agent = (o: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'claude:s1', source: 'claude', sessionId: 's1', parentId: null, parentToolUseId: null, label: 'demo', role: null, model: null,
  effort: null, cwd: null, pid: null, startedAt: 0, lastEventAt: 1000, status: 'running', parseErrors: 0, ...o,
});
let n = 0;
const call = (name: string, input: string, o: Partial<CallRecord> = {}): CallRecord => ({
  id: `c${n++}`, agentId: 'claude:s1', kind: 'tool', name, inputHash: input, inputPreview: input,
  startedAt: n * 10, endedAt: n * 10 + 5, ok: true, errorPreview: null, tokensIn: null, tokensOut: null, ...o,
});

test('kẹt: running, 121s không sự kiện, không call mở → warn', () => {
  const a = detectStuck(agent(), [], 1000 + 121000, T)!;
  expect(a.kind).toBe('stuck'); expect(a.level).toBe('warn'); expect(a.id).toBe('claude:s1:stuck');
  expect(a.message).toBe('im lặng 2m01s');
  expect(detectStuck(agent(), [], 1000 + 100000, T)).toBeNull();
});

test('không kẹt khi có call đang mở (đó là long_tool)', () => {
  const open = [call('Bash', 'x', { endedAt: null, ok: null })];
  expect(detectStuck(agent(), open, 1000 + 500000, T)).toBeNull();
});

test('long_tool: call mở 301s ở agent running → warn; agent ended → null', () => {
  const open = [call('Bash', 'x', { startedAt: 1000, endedAt: null, ok: null })];
  const a = detectLongTool(agent(), open, 1000 + 301000, T)!;
  expect(a.kind).toBe('long_tool'); expect(a.message).toBe('Bash chạy 5m01s');
  expect(detectLongTool(agent({ status: 'ended' }), open, 1000 + 301000, T)).toBeNull();
  expect(detectLongTool(agent(), open, 1000 + 100000, T)).toBeNull();
});

test('lặp: 3 lần Bash npm test trong 20 call → warn; 10 lần → critical; 2 lần → null', () => {
  const mix = (k: number) => [...Array.from({ length: k }, () => call('Bash', 'npm test')), ...Array.from({ length: 5 }, (_, i) => call('Read', `f${i}`))];
  const w = detectLoop(agent(), mix(3), T)!;
  expect(w.level).toBe('warn'); expect(w.message).toBe('lặp 3× Bash npm test');
  expect(detectLoop(agent(), mix(10), T)!.level).toBe('critical');
  expect(detectLoop(agent(), mix(2), T)).toBeNull();
});

test('lặp: chỉ xét 20 call gần nhất', () => {
  const old = Array.from({ length: 5 }, () => call('Bash', 'npm test'));
  const rest = Array.from({ length: 20 }, (_, i) => call('Read', `f${i}`));
  expect(detectLoop(agent(), [...old, ...rest], T)).toBeNull();
});

test('lặp A→B→A→B→A→B → warn', () => {
  const seq = [call('Read', 'a'), call('Edit', 'b'), call('Read', 'a'), call('Edit', 'b'), call('Read', 'a'), call('Edit', 'b')];
  const a = detectLoop(agent(), seq, T)!;
  expect(a.level).toBe('warn'); expect(a.message).toBe('lặp 3× Read ↔ Edit');
});

test('lỗi dồn dập: 5 lỗi liên tiếp → critical; 4 lỗi + 1 ok → null', () => {
  const bad = () => call('Bash', 'x', { ok: false });
  const a = detectErrorBurst(agent(), [call('Read', 'r'), bad(), bad(), bad(), bad(), bad()], T)!;
  expect(a.level).toBe('critical'); expect(a.message).toBe('5 call lỗi liên tiếp');
  expect(detectErrorBurst(agent(), [bad(), call('Read', 'r'), bad(), bad(), bad(), bad()], T)).toBeNull();
  const open = call('Bash', 'x', { endedAt: null, ok: null });
  expect(detectErrorBurst(agent(), [bad(), bad(), bad(), bad(), bad(), open], T)!.message).toBe('5 call lỗi liên tiếp');
});
