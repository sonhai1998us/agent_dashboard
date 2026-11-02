import { describe, expect, test } from 'vitest';
import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { layoutLane, WINDOWS_MIN } from '@/app/lib/lanes';

const MIN = 60_000;
const call = (id: string, startedAt: number, o: Partial<CallRecord> = {}): CallRecord => ({
  id, agentId: 'a', kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: 'ls', startedAt, endedAt: startedAt + 1000,
  ok: true, errorPreview: null, tokensIn: null, tokensOut: null, ...o,
});
const agent = (o: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'a', source: 'claude', sessionId: 'a', parentId: null, label: 'a', role: null, model: null, effort: null,
  cwd: null, pid: null, startedAt: 0, lastEventAt: 0, status: 'running', parseErrors: 0, ...o,
});
const loopAlert = (o: Partial<Alert> = {}): Alert => ({ id: 'a:loop', agentId: 'a', kind: 'loop', level: 'warn', message: 'x', since: 0, active: true, ...o });
const win = { start: 0, end: 5 * MIN };

describe('layoutLane', () => {
  test('mặc định cửa sổ là 5 phút', () => {
    expect(WINDOWS_MIN).toEqual([1, 5, 15, 60]);
  });
  test('call 2 phút trong cửa sổ 5 phút, width 500 → w = 200', () => {
    const r = layoutLane([call('c', MIN, { endedAt: 3 * MIN })], agent(), win, 500, []);
    expect(r.bars).toHaveLength(1);
    expect(r.bars[0].x).toBeCloseTo(100);
    expect(r.bars[0].w).toBeCloseTo(200);
    expect(r.bars[0].state).toBe('ok');
  });
  test('call mở ở agent ended → state unknown', () => {
    const r = layoutLane([call('c', MIN, { endedAt: null, ok: null })], agent({ status: 'ended' }), win, 500, []);
    expect(r.bars[0].state).toBe('unknown');
  });
  test('call mở ở agent running → state running, kéo dài tới cuối cửa sổ', () => {
    const r = layoutLane([call('c', MIN, { endedAt: null, ok: null })], agent(), win, 500, []);
    expect(r.bars[0].state).toBe('running');
    expect(r.bars[0].x + r.bars[0].w).toBeCloseTo(500);
  });
  test('call ngắn → w tối thiểu 2', () => {
    const r = layoutLane([call('c', MIN, { endedAt: MIN + 5 })], agent(), win, 500, []);
    expect(r.bars[0].w).toBe(2);
  });
  test('call lỗi → state error', () => {
    const r = layoutLane([call('c', MIN, { ok: false })], agent(), win, 500, []);
    expect(r.bars[0].state).toBe('error');
  });
  test('chỉ lấy kind tool, bỏ llm', () => {
    const r = layoutLane([call('c', MIN, { kind: 'llm' })], agent(), win, 500, []);
    expect(r.bars).toHaveLength(0);
  });
  test('call cắt theo cửa sổ, call ngoài cửa sổ bị bỏ', () => {
    const r = layoutLane(
      [call('in', -MIN, { endedAt: MIN }), call('out', 10 * MIN), call('before', -5 * MIN, { endedAt: -4 * MIN })],
      agent(), win, 500, [],
    );
    expect(r.bars.map((b) => b.callId)).toEqual(['in']);
    expect(r.bars[0].x).toBe(0);
    expect(r.bars[0].w).toBeCloseTo(100);
  });
  test('loop alert active → có loopZone, không có alert → không có', () => {
    const calls = [call('1', MIN), call('2', 2 * MIN), call('3', 3 * MIN), call('o', 4 * MIN, { inputHash: 'z' })];
    const r = layoutLane(calls, agent(), win, 500, [loopAlert()]);
    expect(r.loopZones).toHaveLength(1);
    expect(r.loopZones[0].x).toBeCloseTo(100);
    expect(r.loopZones[0].w).toBeGreaterThan(190);
    expect(layoutLane(calls, agent(), win, 500, []).loopZones).toEqual([]);
    expect(layoutLane(calls, agent(), win, 500, [loopAlert({ active: false })]).loopZones).toEqual([]);
    expect(layoutLane(calls, agent(), win, 500, [loopAlert({ agentId: 'b' })]).loopZones).toEqual([]);
  });
  test('title chứa tên tool và input', () => {
    const r = layoutLane([call('c', MIN, { name: 'Read', inputPreview: 'a.ts' })], agent(), win, 500, []);
    expect(r.bars[0].title).toContain('Read');
    expect(r.bars[0].title).toContain('a.ts');
  });
});

describe('layoutLane: trạng thái trong title', () => {
  test('title có chữ trạng thái, không chỉ dựa vào màu', () => {
    const e = layoutLane([call('c', MIN, { ok: false })], agent(), win, 500, []);
    expect(e.bars[0].title.startsWith('lỗi')).toBe(true);
    const o = layoutLane([call('c', MIN)], agent(), win, 500, []);
    expect(o.bars[0].title.startsWith('ok')).toBe(true);
  });
});
