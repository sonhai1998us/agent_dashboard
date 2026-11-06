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
      explorer: { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 0 },
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
  resultText: null, changedFiles: ['a.ts'], costUsd: 0.5, createdAt: 1000, endedAt: null, userAction: null, ...over,
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

test('managed: userAction lưu và đọc lại; DB cũ không có cột thì được thêm', () => {
  const ua = { id: 'u1', title: 'Đăng nhập', message: 'm', url: 'https://x', command: 'twg login', createdAt: 5 };
  const s = new Store(':memory:');
  s.database.exec(`CREATE TABLE managed_agents (agent_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, role TEXT NOT NULL,
    ordinal INTEGER NOT NULL, package_id TEXT, task TEXT NOT NULL, files TEXT NOT NULL, runner TEXT NOT NULL, model TEXT NOT NULL,
    effort TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, stop_reason TEXT, result_text TEXT,
    changed_files TEXT NOT NULL, cost_usd REAL, created_at INTEGER NOT NULL, ended_at INTEGER)`);
  const ts = new TicketStore(s);
  ts.upsertManaged(managed({ userAction: ua }));
  expect(ts.getManaged('acctv:T-1:dev-1')!.userAction).toEqual(ua);
  ts.updateManaged('acctv:T-1:dev-1', { userAction: null });
  expect(ts.getManaged('acctv:T-1:dev-1')!.userAction).toBeNull();
  s.close();
});

test('kế hoạch lưu trước khi có vai explorer được bổ sung explorer count 0 khi đọc', () => {
  const ts = new TicketStore(new Store(':memory:'));
  const t = ticket();
  const { explorer: _drop, ...roles } = t.plan!.roles;
  ts.createTicket({ ...t, plan: { ...t.plan!, roles: roles as never } });
  expect(ts.getTicket('T-1')!.plan!.roles.explorer).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 0 });
  expect(ts.getTicket('T-1')!.plan!.roles.dev).toEqual(t.plan!.roles.dev);
});
