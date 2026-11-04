import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@/src/core/store';
import { TicketStore } from '@/src/tickets/store';
import type { ManagedAgent, Ticket } from '@/src/tickets/model';

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'T-1', seq: 1, title: 't', description: 'd', dir: 'D:\\Dự án\\app', status: 'awaiting_approval',
  overrides: { dev: { model: 'claude-haiku-5-5' } },
  plan: {
    summary: 's', difficulty: 'easy', acceptance: ['ok'],
    packages: [{ id: 'p1', role: 'dev', title: 'x', task: 'do', files: ['a.ts'] }],
    roles: {
      dev: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 1 },
      designer: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 0 },
      qc: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 1 },
    },
  },
  feedback: null, round: 1, maxRounds: 3, controllerSessionId: 'sid-c', branch: 'acctv/t-1', worktree: 'w', baseRef: 'abc',
  pendingWait: ['acctv:T-1:dev-1'], report: null, diffStat: null, createdAt: 1000, updatedAt: 1000, ...over,
});

const managed = (over: Partial<ManagedAgent> = {}): ManagedAgent => ({
  agentId: 'acctv:T-1:dev-1', ticketId: 'T-1', role: 'dev', ordinal: 1, packageId: 'p1', task: 'do', files: ['a.ts'],
  runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high', sessionId: 'sid-d', state: 'running', stopReason: null,
  resultText: null, changedFiles: ['a.ts'], costUsd: 0.5, createdAt: 1000, endedAt: null, ...over,
});

test('Ticket round-trip đủ plan, overrides, pendingWait', () => {
  const ts = new TicketStore(new Store(':memory:'));
  ts.createTicket(ticket());
  expect(ts.getTicket('T-1')).toEqual(ticket());
  expect(ts.getTicket('T-9')).toBeUndefined();
  ts.createTicket(ticket({ id: 'T-2', seq: 2, plan: null, pendingWait: null, overrides: {} }));
  expect(ts.listTickets().map((t) => t.id)).toEqual(['T-2', 'T-1']);
  const u = ts.updateTicket('T-1', { status: 'running', pendingWait: null });
  expect(u.status).toBe('running'); expect(u.pendingWait).toBeNull(); expect(u.plan).not.toBeNull();
  expect(u.updatedAt).toBeGreaterThan(1000);
});

test('nextTicketId đếm tiếp sau khi mở lại DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-ts-'));
  const p = path.join(dir, 'a.db');
  try {
    let s = new Store(p);
    let ts = new TicketStore(s);
    expect(ts.nextTicketId()).toBe('T-1'); expect(ts.nextTicketId()).toBe('T-2');
    s.close();
    s = new Store(p); ts = new TicketStore(s);
    expect(ts.nextTicketId()).toBe('T-3');
    s.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updateManaged đổi state, giữ các trường khác', () => {
  const ts = new TicketStore(new Store(':memory:'));
  ts.upsertManaged(managed());
  ts.upsertManaged(managed({ agentId: 'acctv:T-2:dev-1', ticketId: 'T-2' }));
  const u = ts.updateManaged('acctv:T-1:dev-1', { state: 'done', endedAt: 2000 });
  expect(u).toEqual(managed({ state: 'done', endedAt: 2000 }));
  expect(ts.getManaged('acctv:T-1:dev-1')).toEqual(u);
  expect(ts.listManaged('T-1').length).toBe(1);
  expect(ts.listManaged().length).toBe(2);
});

test('listWaits(since) gồm cả span còn mở; closeWait đóng span', () => {
  const ts = new TicketStore(new Store(':memory:'));
  ts.openWait({ id: 'w1', agentId: 'a', kind: 'approval', startedAt: 100, endedAt: null });
  ts.openWait({ id: 'w2', agentId: 'a', kind: 'agents', startedAt: 200, endedAt: 250 });
  ts.openWait({ id: 'w3', agentId: 'a', kind: 'agents', startedAt: 50, endedAt: 60 });
  expect(ts.listWaits(150).map((w) => w.id).sort()).toEqual(['w1', 'w2']);
  expect(ts.closeWait('w1', 300)).toEqual({ id: 'w1', agentId: 'a', kind: 'approval', startedAt: 100, endedAt: 300 });
  expect(ts.closeWait('nope', 1)).toBeUndefined();
});

test('log / listLog theo thứ tự thời gian', () => {
  const ts = new TicketStore(new Store(':memory:'));
  ts.log('T-1', 'a'); ts.log('T-1', 'b'); ts.log('T-2', 'c');
  expect(ts.listLog('T-1').map((l) => l.text)).toEqual(['a', 'b']);
});
