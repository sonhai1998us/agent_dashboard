import { describe, expect, test } from 'vitest';
import type { ManagedAgent, Ticket } from '@/src/tickets/model';
import { pendingUserActions, safeHttpUrl } from '@/app/lib/userActions';

const ua = (id: string, createdAt: number) => ({ id, title: `T ${id}`, message: 'm', url: null, command: null, createdAt });
const m = (agentId: string, o: Partial<ManagedAgent>): ManagedAgent => ({ agentId, ticketId: 'T-1', role: 'dev', userAction: null, ...o } as ManagedAgent);

describe('pendingUserActions', () => {
  test('chỉ agent có yêu cầu, cũ trước, kèm tên ticket và nhãn', () => {
    const managed = {
      a: m('a', { userAction: ua('2', 20) }),
      b: m('b', { userAction: ua('1', 10), ticketId: 'T-2' }),
      c: m('c', {}),
      d: m('d', { role: 'controller', userAction: ua('3', 5) }),
    };
    const tickets = { 'T-1': { title: 'US-5039' } as Ticket };
    expect(pendingUserActions(managed, tickets, { a: 'Dev-2' })).toEqual([
      { agentId: 'b', ticketId: 'T-2', ticketTitle: 'T-2', label: 'b', action: ua('1', 10) },
      { agentId: 'a', ticketId: 'T-1', ticketTitle: 'US-5039', label: 'Dev-2', action: ua('2', 20) },
    ]);
  });
});

describe('safeHttpUrl', () => {
  test('nhận http(s), bỏ scheme khác và chuỗi hỏng', () => {
    expect(safeHttpUrl('https://id.atlassian.com/login?x=1')).toBe('https://id.atlassian.com/login?x=1');
    expect(safeHttpUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('file:///C:/x')).toBeNull();
    expect(safeHttpUrl('không phải url')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
