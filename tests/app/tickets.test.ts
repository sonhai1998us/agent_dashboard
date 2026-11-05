import { describe, expect, test } from 'vitest';
import type { AgentInfo } from '@/src/core/model';
import type { Ticket } from '@/src/tickets/model';
import type { WaitSpan } from '@/src/tickets/model';
import { controllerIdOf, isExternal, layoutWaits, managedStateText, replayRange, ticketStatusText } from '@/app/lib/tickets';

const t = (o: Partial<Ticket>): Ticket => ({ id: 'T-1', status: 'draft', round: 0, maxRounds: 3, ...o } as Ticket);

describe('tickets helpers', () => {
  test('controllerIdOf', () => expect(controllerIdOf('T-1')).toBe('acctv:T-1:controller'));
  test('ticketStatusText: running hiện vòng', () => {
    const r = ticketStatusText(t({ status: 'running', round: 1, maxRounds: 3 }));
    expect(r.text).toBe('đang chạy · vòng 2/3');
    expect(ticketStatusText(t({ status: 'running', round: 3, maxRounds: 3 })).text).toBe('đang chạy · vòng 3/3');
    expect(r.icon).toBe('●');
    expect(r.tone).toBe('run');
  });
  test('ticketStatusText: các trạng thái còn lại', () => {
    expect(ticketStatusText(t({ status: 'draft' }))).toEqual({ icon: '○', text: 'nháp', tone: 'wait' });
    expect(ticketStatusText(t({ status: 'planning' }))).toEqual({ icon: '●', text: 'đang lập kế hoạch', tone: 'run' });
    expect(ticketStatusText(t({ status: 'awaiting_approval' }))).toEqual({ icon: '▲', text: 'chờ duyệt', tone: 'warn' });
    expect(ticketStatusText(t({ status: 'done' }))).toEqual({ icon: '✓', text: 'xong', tone: 'ok' });
    expect(ticketStatusText(t({ status: 'escalated' }))).toEqual({ icon: '■', text: 'cần bạn quyết', tone: 'crit' });
    expect(ticketStatusText(t({ status: 'cancelled' }))).toEqual({ icon: '○', text: 'đã huỷ', tone: 'ended' });
  });
  test('managedStateText', () => {
    expect(managedStateText('limited')).toMatchObject({ icon: '⏸', text: 'bị giới hạn' });
    expect(managedStateText('interrupted')).toMatchObject({ icon: '○', text: 'bị gián đoạn' });
    expect(managedStateText('failed')).toMatchObject({ icon: '✗', text: 'thất bại' });
  });
  test('isExternal', () => {
    expect(isExternal({ id: 'acctv:T-1:dev-1' } as AgentInfo)).toBe(false);
    expect(isExternal({ id: 'claude:abc' } as AgentInfo)).toBe(true);
  });
});

describe('layoutWaits', () => {
  const win = { start: 0, end: 600_000 };
  const w = (o: Partial<WaitSpan>): WaitSpan => ({ id: 'w', agentId: 'a', kind: 'approval', startedAt: 0, endedAt: 1000, ...o });
  test('span mở từ giữa cửa sổ kéo tới cuối', () => {
    const r = layoutWaits([w({ startedAt: 300_000, endedAt: null })], 'a', win, 200);
    expect(r).toHaveLength(1);
    expect(r[0].x).toBe(100);
    expect(r[0].w).toBe(100);
  });
  test('bỏ span của agent khác và span ngoài cửa sổ; tiêu đề theo loại', () => {
    const r = layoutWaits([
      w({ id: '1', agentId: 'b' }), w({ id: '2', kind: 'agents', startedAt: 60_000, endedAt: 120_000 }),
      w({ id: '3', startedAt: 700_000, endedAt: 800_000 }),
    ], 'a', win, 600);
    expect(r).toEqual([{ x: 60, w: 60, title: 'chờ subagent · 1m00' }]);
  });
  test('span mở: tooltip tính theo now', () => {
    expect(layoutWaits([w({ startedAt: 300_000, endedAt: null })], 'a', win, 200, 900_000)[0].title).toBe('chờ duyệt kế hoạch · 10m00');
  });
  test('chờ duyệt kế hoạch', () => {
    expect(layoutWaits([w({ startedAt: 0, endedAt: 30_000 })], 'a', win, 600)[0].title).toBe('chờ duyệt kế hoạch · 30s');
  });
});

describe('replayRange', () => {
  const a = (o: Partial<AgentInfo>): AgentInfo => ({ id: 'x', status: 'ended', startedAt: 10, lastEventAt: 50, ...o } as AgentInfo);
  test('tất cả đã kết thúc: không live, max = lastEventAt lớn nhất', () => {
    expect(replayRange([a({ startedAt: 20, lastEventAt: 50 }), a({ startedAt: 10, lastEventAt: 90 })], 1000)).toEqual({ min: 10, max: 90, live: false });
  });
  test('node idle vẫn live, max = now', () => {
    expect(replayRange([a({ status: 'idle' as AgentInfo['status'] })], 1000)).toEqual({ min: 10, max: 1000, live: true });
  });
  test('queued/limited/running là live', () => {
    expect(replayRange([a({}), a({ status: 'queued' })], 1000)).toEqual({ min: 10, max: 1000, live: true });
    expect(replayRange([a({ status: 'limited' })], 1000).live).toBe(true);
  });
});
