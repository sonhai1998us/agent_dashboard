import { describe, expect, test } from 'vitest';
import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { alertPill, alertTag, callRowState, topRepeatedError, toolCalls } from '@/app/lib/detail';
import { ALERT_LABEL } from '@/app/lib/format';

const call = (id: string, o: Partial<CallRecord> = {}): CallRecord => ({
  id, agentId: 'a', kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: 'ls', startedAt: 1000, endedAt: 2000,
  ok: true, errorPreview: null, tokensIn: null, tokensOut: null, ...o,
});
const err = (id: string, e: string) => call(id, { ok: false, errorPreview: e });

describe('topRepeatedError', () => {
  test('topRepeatedError lấy lỗi xuất hiện nhiều nhất, ≥2 lần', () => {
    const r = topRepeatedError([err('1', 'A'), err('2', 'B'), err('3', 'B'), err('4', 'A'), err('5', 'B')]);
    expect(r).toEqual({ preview: 'B', count: 3 });
  });
  test('topRepeatedError: không có lỗi lặp → null', () => {
    expect(topRepeatedError([err('1', 'A'), err('2', 'B'), call('3')])).toBeNull();
    expect(topRepeatedError([])).toBeNull();
  });
  test('topRepeatedError bỏ qua call llm và lỗi rỗng', () => {
    expect(topRepeatedError([call('1', { kind: 'llm', errorPreview: 'X' }), call('2', { kind: 'llm', errorPreview: 'X' })])).toBeNull();
    expect(topRepeatedError([err('1', ''), err('2', '')])).toBeNull();
  });
});

describe('callRowState', () => {
  const agent = (status: AgentInfo['status']) => ({ status } as AgentInfo);
  test('call ok → ✓ ok', () => {
    expect(callRowState(call('1'), agent('running'), 5000)).toMatchObject({ state: 'ok', icon: '✓', text: 'ok', durationMs: 1000 });
  });
  test('call lỗi → ✗ lỗi', () => {
    expect(callRowState(err('1', 'x'), agent('running'), 5000)).toMatchObject({ state: 'error', icon: '✗', text: 'lỗi' });
  });
  test('call đang mở của agent đang chạy → … đang chạy, thời gian tính từ now', () => {
    expect(callRowState(call('1', { endedAt: null, ok: null, startedAt: 1000 }), agent('running'), 4000))
      .toMatchObject({ state: 'running', icon: '…', durationMs: 3000 });
  });
  test('call đang mở của agent không chạy → ? không rõ, không có thời gian', () => {
    expect(callRowState(call('1', { endedAt: null, ok: null }), agent('ended'), 4000))
      .toMatchObject({ state: 'unknown', icon: '?', text: 'không rõ', durationMs: null });
  });
});

describe('toolCalls', () => {
  test('toolCalls chỉ giữ call tool, giữ thứ tự', () => {
    expect(toolCalls([call('1'), call('2', { kind: 'llm' }), call('3')]).map((c) => c.id)).toEqual(['1', '3']);
  });
});

describe('alertPill', () => {
  const al = (kind: Alert['kind'], since: number, message = 'm'): Alert => ({ id: 'x', agentId: 'a', kind, level: 'warn', message, since, active: true });
  test('stuck/long_tool tính thời gian sống từ since', () => {
    expect(alertPill(al('stuck', 0), 65_000)).toBe('kẹt 1m05');
    expect(alertPill(al('long_tool', 0), 12_000)).toBe('tool lâu 12s');
  });
  test('loop/error_burst dùng message', () => {
    expect(alertPill(al('loop', 0, 'lặp 3×'), 9000)).toBe('lặp 3×');
    expect(alertPill(al('error_burst', 0, 'lỗi dồn'), 9000)).toBe('lỗi dồn');
  });
});

describe('nhãn cảnh báo tiếng Việt', () => {
  const al = (kind: Alert['kind'], level: Alert['level'] = 'warn'): Alert => ({ id: 'x', agentId: 'a', kind, level, message: 'm', since: 0, active: true });
  test('ALERT_LABEL đủ 4 loại', () => {
    expect(ALERT_LABEL).toEqual({ stuck: 'kẹt', long_tool: 'tool lâu', loop: 'lặp', error_burst: 'lỗi liên tiếp' });
  });
  test('alertTag (timeline): biểu tượng + nhãn tiếng Việt + thời lượng từ since, không còn tên tiếng Anh', () => {
    expect(alertTag(al('stuck'), 125_000)).toBe('▲ kẹt 2m05');
    expect(alertTag(al('error_burst', 'critical'), 3_000)).toBe('■ lỗi liên tiếp 3s');
    for (const k of ['stuck', 'long_tool', 'loop', 'error_burst'] as const) expect(alertTag(al(k), 1000)).not.toContain(k);
  });
});
