import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '@/src/core/store';
import type { ManagedAgent, Ticket, WaitSpan } from './model';

type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  dir TEXT NOT NULL, status TEXT NOT NULL, overrides TEXT NOT NULL, plan TEXT, feedback TEXT, round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL, controller_session TEXT NOT NULL, branch TEXT, worktree TEXT, base_ref TEXT,
  pending_wait TEXT, report TEXT, diff_stat TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS managed_agents (agent_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, role TEXT NOT NULL,
  ordinal INTEGER NOT NULL, package_id TEXT, task TEXT NOT NULL, files TEXT NOT NULL, runner TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, stop_reason TEXT, result_text TEXT,
  changed_files TEXT NOT NULL, cost_usd REAL, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_managed_ticket ON managed_agents(ticket_id);
CREATE TABLE IF NOT EXISTS waits (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS ticket_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
`;

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const unjson = <T>(s: string | null | undefined): T | null => (s === null || s === undefined ? null : JSON.parse(s) as T);

function toTicket(r: Row): Ticket {
  return {
    id: r.id, seq: r.seq, title: r.title, description: r.description, dir: r.dir, status: r.status,
    overrides: unjson(r.overrides) ?? {}, plan: unjson(r.plan), feedback: r.feedback ?? null,
    round: r.round, maxRounds: r.max_rounds, controllerSessionId: r.controller_session,
    branch: r.branch ?? null, worktree: r.worktree ?? null, baseRef: r.base_ref ?? null,
    pendingWait: unjson(r.pending_wait), report: r.report ?? null, diffStat: r.diff_stat ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function toManaged(r: Row): ManagedAgent {
  return {
    agentId: r.agent_id, ticketId: r.ticket_id, role: r.role, ordinal: r.ordinal, packageId: r.package_id ?? null,
    task: r.task, files: unjson(r.files) ?? [], runner: r.runner, model: r.model, effort: r.effort,
    sessionId: r.session_id, state: r.state, stopReason: r.stop_reason ?? null, resultText: r.result_text ?? null,
    changedFiles: unjson(r.changed_files) ?? [], costUsd: r.cost_usd ?? null, createdAt: r.created_at, endedAt: r.ended_at ?? null,
    userAction: unjson(r.user_action),
  };
}

const toWait = (r: Row): WaitSpan => ({ id: r.id, agentId: r.agent_id, kind: r.kind, startedAt: r.started_at, endedAt: r.ended_at ?? null });

const TICKET_COLS = [
  'id', 'seq', 'title', 'description', 'dir', 'status', 'overrides', 'plan', 'feedback', 'round', 'max_rounds',
  'controller_session', 'branch', 'worktree', 'base_ref', 'pending_wait', 'report', 'diff_stat', 'created_at', 'updated_at',
];
const MANAGED_COLS = [
  'agent_id', 'ticket_id', 'role', 'ordinal', 'package_id', 'task', 'files', 'runner', 'model', 'effort', 'session_id',
  'state', 'stop_reason', 'result_text', 'changed_files', 'cost_usd', 'created_at', 'ended_at', 'user_action',
];
const placeholders = (cols: string[]): string => cols.map(() => '?').join(', ');

const ticketVals = (t: Ticket): unknown[] => [
  t.id, t.seq, t.title, t.description, t.dir, t.status, JSON.stringify(t.overrides), json(t.plan), t.feedback, t.round, t.maxRounds,
  t.controllerSessionId, t.branch, t.worktree, t.baseRef, json(t.pendingWait), t.report, t.diffStat, t.createdAt, t.updatedAt,
];
const managedVals = (m: ManagedAgent): unknown[] => [
  m.agentId, m.ticketId, m.role, m.ordinal, m.packageId, m.task, JSON.stringify(m.files), m.runner, m.model, m.effort, m.sessionId,
  m.state, m.stopReason, m.resultText, JSON.stringify(m.changedFiles), m.costUsd, m.createdAt, m.endedAt, json(m.userAction ?? null),
];

export class TicketStore {
  private db: DatabaseSync;

  constructor(private store: Store) {
    this.db = store.database;
    this.db.exec(SCHEMA);
    // DB tạo trước khi có cột này
    const cols = (this.db.prepare('PRAGMA table_info(managed_agents)').all() as Row[]).map((c) => c.name);
    if (!cols.includes('user_action')) this.db.exec('ALTER TABLE managed_agents ADD COLUMN user_action TEXT');
  }

  nextTicketId(): string {
    const n = Number(this.store.getMeta('ticketSeq') ?? '0') + 1;
    this.store.setMeta('ticketSeq', String(n));
    return `T-${n}`;
  }

  createTicket(t: Ticket): void {
    this.db.prepare(`INSERT INTO tickets (${TICKET_COLS.join(', ')}) VALUES (${placeholders(TICKET_COLS)})`).run(...(ticketVals(t) as any[]));
  }

  getTicket(id: string): Ticket | undefined {
    const r = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined;
    return r ? toTicket(r) : undefined;
  }

  listTickets(): Ticket[] {
    return (this.db.prepare('SELECT * FROM tickets ORDER BY seq DESC').all() as Row[]).map(toTicket);
  }

  updateTicket(id: string, patch: Partial<Ticket>): Ticket {
    const cur = this.getTicket(id);
    if (!cur) throw new Error(`ticket not found: ${id}`);
    const next: Ticket = { ...cur, ...patch, id, updatedAt: Date.now() };
    const sets = TICKET_COLS.slice(1).map((c) => `${c} = ?`).join(', ');
    this.db.prepare(`UPDATE tickets SET ${sets} WHERE id = ?`).run(...(ticketVals(next).slice(1) as any[]), id);
    return next;
  }

  upsertManaged(m: ManagedAgent): void {
    const sets = MANAGED_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ');
    this.db.prepare(
      `INSERT INTO managed_agents (${MANAGED_COLS.join(', ')}) VALUES (${placeholders(MANAGED_COLS)})
       ON CONFLICT(agent_id) DO UPDATE SET ${sets}`,
    ).run(...(managedVals(m) as any[]));
  }

  getManaged(agentId: string): ManagedAgent | undefined {
    const r = this.db.prepare('SELECT * FROM managed_agents WHERE agent_id = ?').get(agentId) as Row | undefined;
    return r ? toManaged(r) : undefined;
  }

  listManaged(ticketId?: string): ManagedAgent[] {
    const rows = (ticketId === undefined
      ? this.db.prepare('SELECT * FROM managed_agents ORDER BY created_at, ordinal, agent_id').all()
      : this.db.prepare('SELECT * FROM managed_agents WHERE ticket_id = ? ORDER BY created_at, ordinal, agent_id').all(ticketId)) as Row[];
    return rows.map(toManaged);
  }

  updateManaged(agentId: string, patch: Partial<ManagedAgent>): ManagedAgent {
    const cur = this.getManaged(agentId);
    if (!cur) throw new Error(`managed agent not found: ${agentId}`);
    const next: ManagedAgent = { ...cur, ...patch, agentId };
    this.upsertManaged(next);
    return next;
  }

  openWait(w: WaitSpan): void {
    this.db.prepare('INSERT OR REPLACE INTO waits (id, agent_id, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
      .run(w.id, w.agentId, w.kind, w.startedAt, w.endedAt);
  }

  closeWait(id: string, at: number): WaitSpan | undefined {
    this.db.prepare('UPDATE waits SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(at, id);
    const r = this.db.prepare('SELECT * FROM waits WHERE id = ?').get(id) as Row | undefined;
    return r ? toWait(r) : undefined;
  }

  listWaits(since: number): WaitSpan[] {
    return (this.db.prepare('SELECT * FROM waits WHERE ended_at IS NULL OR ended_at >= ? ORDER BY started_at').all(since) as Row[]).map(toWait);
  }

  log(ticketId: string, text: string): void {
    this.db.prepare('INSERT INTO ticket_log (ticket_id, at, text) VALUES (?, ?, ?)').run(ticketId, Date.now(), text);
  }

  listLog(ticketId: string): { at: number; text: string }[] {
    return (this.db.prepare('SELECT at, text FROM ticket_log WHERE ticket_id = ? ORDER BY id').all(ticketId) as Row[])
      .map((r) => ({ at: r.at, text: r.text }));
  }
}
