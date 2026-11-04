import { describe, expect, test } from 'vitest';
import type { AgentInfo } from '@/src/core/model';
import type { Ticket } from '@/src/tickets/model';
import { controllerIdOf, isExternal, managedStateText, ticketStatusText } from '@/app/lib/tickets';

const t = (o: Partial<Ticket>): Ticket => ({ id: 'T-1', status: 'draft', round: 0, maxRounds: 3, ...o } as Ticket);

describe('tickets helpers', () => {
  test('controllerIdOf', () => expect(controllerIdOf('T-1')).toBe('acctv:T-1:controller'));
  test('ticketStatusText: running hiện vòng', () => {
    const r = ticketStatusText(t({ status: 'running', round: 1, maxRounds: 3 }));
    expect(r.text).toBe('đang chạy · vòng 2/3');
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
