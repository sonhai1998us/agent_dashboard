import { DatabaseSync } from 'node:sqlite';
import type {
  AgentInfo, AgentStatus, Alert, CallRecord, HubEvent, NormalizedEvent, Source,
} from './model';

type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL, parent_id TEXT, parent_tool_use_id TEXT, request_shape TEXT,
  label TEXT NOT NULL, role TEXT, model TEXT, effort TEXT, cwd TEXT, pid INTEGER,
  started_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', parse_errors INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  input_hash TEXT NOT NULL, input_preview TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, ok INTEGER, error_preview TEXT,
  tokens_in INTEGER, tokens_out INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_agent_started ON calls(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
  message TEXT NOT NULL, since INTEGER NOT NULL, active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS offsets (
  file TEXT PRIMARY KEY, offset INTEGER NOT NULL, lines INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

const PREVIEW_MAX = 200;

function toAgent(r: Row): AgentInfo {
  return {
    id: r.id, source: r.source as Source, sessionId: r.session_id, parentId: r.parent_id ?? null,
    parentToolUseId: r.parent_tool_use_id ?? null,
    requestShape: r.request_shape === 'background' || r.request_shape === 'foreground' ? r.request_shape : null,
    label: r.label, role: r.role ?? null, model: r.model ?? null, effort: r.effort ?? null,
    cwd: r.cwd ?? null, pid: r.pid ?? null,
    startedAt: r.started_at, lastEventAt: r.last_event_at,
    status: r.status as AgentStatus, parseErrors: r.parse_errors,
  };
}

function toCall(r: Row): CallRecord {
  return {
    id: r.id, agentId: r.agent_id, kind: r.kind, name: r.name,
    inputHash: r.input_hash, inputPreview: r.input_preview,
    startedAt: r.started_at, endedAt: r.ended_at ?? null,
    ok: r.ok === null || r.ok === undefined ? null : r.ok === 1,
    errorPreview: r.error_preview ?? null,
    tokensIn: r.tokens_in ?? null, tokensOut: r.tokens_out ?? null,
  };
}

function toAlert(r: Row): Alert {
  return {
    id: r.id, agentId: r.agent_id, kind: r.kind, level: r.level,
    message: r.message, since: r.since, active: r.active === 1,
  };
}

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // DBs created before these columns existed
    const cols = (this.db.prepare('PRAGMA table_info(agents)').all() as Row[]).map((c) => c.name);
    for (const col of ['parent_tool_use_id', 'request_shape']) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`);
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  getAgent(id: string): AgentInfo | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return r ? toAgent(r) : undefined;
  }

  listAgents(opts: { since?: number } = {}): AgentInfo[] {
    const rows = (opts.since !== undefined
      ? this.db.prepare('SELECT * FROM agents WHERE last_event_at >= ? ORDER BY last_event_at DESC').all(opts.since)
      : this.db.prepare('SELECT * FROM agents ORDER BY last_event_at DESC').all()) as Row[];
    return rows.map(toAgent);
  }

  listCalls(agentId: string, opts: { since?: number; limit?: number } = {}): CallRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM calls WHERE agent_id = ? AND started_at >= ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
    ).all(agentId, opts.since ?? 0, opts.limit ?? -1) as Row[];
    return rows.map(toCall);
  }

  recentCalls(since: number): CallRecord[] {
    const rows = this.db.prepare('SELECT * FROM calls WHERE started_at >= ? ORDER BY started_at DESC, rowid DESC').all(since) as Row[];
    return rows.map(toCall);
  }

  openCalls(agentId: string): CallRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM calls WHERE agent_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC',
    ).all(agentId) as Row[];
    return rows.map(toCall);
  }

  setAgentStatus(id: string, status: AgentStatus, pid?: number | null): AgentInfo | undefined {
    if (!this.getAgent(id)) return undefined;
    if (pid !== undefined) {
      this.db.prepare('UPDATE agents SET status = ?, pid = ? WHERE id = ?').run(status, pid, id);
    } else {
      this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
    }
    return this.getAgent(id);
  }

  upsertAlert(a: Alert): void {
    this.db.prepare(
      `INSERT INTO alerts (id, agent_id, kind, level, message, since, active) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind, level = excluded.level,
         message = excluded.message, since = excluded.since, active = excluded.active`,
    ).run(a.id, a.agentId, a.kind, a.level, a.message, a.since, a.active ? 1 : 0);
  }

  activeAlerts(): Alert[] {
    return (this.db.prepare('SELECT * FROM alerts WHERE active = 1 ORDER BY since ASC').all() as Row[]).map(toAlert);
  }

  getMeta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? r.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Drops all ingested data (agents, calls, alerts, offsets) so logs are re-parsed from scratch. */
  clearIngested(): void {
    this.transaction(() => {
      for (const t of ['agents', 'calls', 'alerts', 'offsets']) this.db.exec(`DELETE FROM ${t}`);
    });
  }

  getOffset(file: string): { offset: number; lines: number } | undefined {
    const r = this.db.prepare('SELECT offset, lines FROM offsets WHERE file = ?').get(file) as Row | undefined;
    return r ? { offset: r.offset, lines: r.lines } : undefined;
  }

  setOffset(file: string, offset: number, lines: number): void {
    this.db.prepare(
      'INSERT INTO offsets (file, offset, lines) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, lines = excluded.lines',
    ).run(file, offset, lines);
  }

  applyEvent(e: NormalizedEvent): HubEvent[] {
    switch (e.type) {
      case 'agent': return this.applyAgent(e.agent);
      case 'call_start': return this.applyCallStart(e.call);
      case 'call_end': return this.applyCallEnd(e);
      case 'activity': {
        this.ensureAgent(e.agentId, e.at);
        this.touch(e.agentId, e.at);
        return this.agentOut(e.agentId);
      }
      case 'parse_error': {
        this.ensureAgent(e.agentId);
        this.db.prepare('UPDATE agents SET parse_errors = parse_errors + 1 WHERE id = ?').run(e.agentId);
        return this.agentOut(e.agentId);
      }
    }
  }

  private agentOut(id: string): HubEvent[] {
    const a = this.getAgent(id);
    return a ? [{ type: 'agent', agent: a }] : [];
  }

  private touch(agentId: string, ts: number): void {
    this.db.prepare('UPDATE agents SET last_event_at = MAX(last_event_at, ?) WHERE id = ?').run(ts, agentId);
  }

  /** Creates the agent with defaults when unknown; returns true if it was created. */
  private ensureAgent(id: string, at?: number, init: Partial<AgentInfo> = {}): boolean {
    if (this.getAgent(id)) return false;
    const [src, sessionId] = id.split(':');
    const source = (init.source ?? src) as Source;
    const sid = init.sessionId ?? sessionId ?? id;
    const now = at ?? Date.now();
    const startedAt = init.startedAt ?? now;
    this.db.prepare(
      `INSERT OR IGNORE INTO agents (id, source, session_id, parent_id, parent_tool_use_id, request_shape, label, role, model, effort, cwd, pid, started_at, last_event_at, status, parse_errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, source, sid, init.parentId ?? null, init.parentToolUseId ?? null, init.requestShape ?? null,
      init.label ?? (init.cwd ? lastSegment(init.cwd) : id),
      init.role ?? null, init.model ?? null, init.effort ?? null, init.cwd ?? null, init.pid ?? null,
      startedAt, init.lastEventAt ?? startedAt, init.status ?? 'idle', init.parseErrors ?? 0,
    );
    return true;
  }

  private applyAgent(patch: Extract<NormalizedEvent, { type: 'agent' }>['agent']): HubEvent[] {
    const created = this.ensureAgent(patch.id, patch.lastEventAt ?? patch.startedAt, patch);
    if (!created) {
      const cols: Record<string, string> = {
        source: 'source', sessionId: 'session_id', parentId: 'parent_id', parentToolUseId: 'parent_tool_use_id', requestShape: 'request_shape', label: 'label', role: 'role',
        model: 'model', effort: 'effort', cwd: 'cwd', pid: 'pid', startedAt: 'started_at',
        lastEventAt: 'last_event_at', status: 'status', parseErrors: 'parse_errors',
      };
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [k, col] of Object.entries(cols)) {
        const v = (patch as Record<string, unknown>)[k];
        if (v === undefined || k === 'lastEventAt') continue;
        sets.push(`${col} = ?`);
        vals.push(v);
      }
      if (sets.length) this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals, patch.id);
      if (patch.lastEventAt !== undefined) this.touch(patch.id, patch.lastEventAt);
    }
    if (patch.status === 'running' || patch.parentToolUseId !== undefined || patch.requestShape !== undefined) {
      this.settleChild(patch.id, patch.lastEventAt);
    }
    return this.agentOut(patch.id);
  }

  /**
   * A subagent whose spawning call in the parent has already ended (at or after `at`, the time of the
   * record being applied) is finished: replaying its old records must not flip it back to running.
   * Records newer than the parent's call end (a resumed subagent) still count.
   * Background subagents are exempt: their spawning call ends as soon as they are launched.
   */
  private settleChild(id: string, at?: number): void {
    const a = this.getAgent(id);
    if (!a || a.status === 'ended' || !a.parentId || !a.parentToolUseId || a.requestShape === 'background') return;
    const r = this.db.prepare('SELECT ended_at FROM calls WHERE id = ? AND agent_id = ?').get(a.parentToolUseId, a.parentId) as Row | undefined;
    if (r && r.ended_at !== null && r.ended_at !== undefined && r.ended_at >= (at ?? a.lastEventAt)) {
      this.db.prepare("UPDATE agents SET status = 'ended' WHERE id = ?").run(id);
    }
  }

  private applyCallStart(c: Omit<CallRecord, 'endedAt' | 'ok' | 'errorPreview'>): HubEvent[] {
    this.ensureAgent(c.agentId, c.startedAt);
    this.db.prepare(
      `INSERT OR IGNORE INTO calls (id, agent_id, kind, name, input_hash, input_preview, started_at, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.agentId, c.kind, c.name, c.inputHash, c.inputPreview.slice(0, PREVIEW_MAX), c.startedAt, c.tokensIn, c.tokensOut);
    if (c.kind === 'llm') {
      // llm calls are emitted as call_start (+ call_end) possibly repeatedly: keep the largest token counts
      this.db.prepare(
        `UPDATE calls SET
           tokens_in = CASE WHEN ? IS NULL THEN tokens_in WHEN tokens_in IS NULL THEN ? ELSE MAX(tokens_in, ?) END,
           tokens_out = CASE WHEN ? IS NULL THEN tokens_out WHEN tokens_out IS NULL THEN ? ELSE MAX(tokens_out, ?) END
         WHERE id = ? AND kind = 'llm'`,
      ).run(c.tokensIn, c.tokensIn, c.tokensIn, c.tokensOut, c.tokensOut, c.tokensOut, c.id);
    }
    this.touch(c.agentId, c.startedAt);
    return [...this.agentOut(c.agentId), ...this.callOut(c.id)];
  }

  private applyCallEnd(e: Extract<NormalizedEvent, { type: 'call_end' }>): HubEvent[] {
    const created = this.ensureAgent(e.agentId, e.endedAt);
    this.touch(e.agentId, e.endedAt);
    const r = this.db.prepare('UPDATE calls SET ended_at = ?, ok = ?, error_preview = ? WHERE id = ? AND agent_id = ?')
      .run(e.endedAt, e.ok ? 1 : 0, e.errorPreview, e.callId, e.agentId);
    if (Number(r.changes) === 0) return created ? this.agentOut(e.agentId) : []; // orphan call_end: only emit a newly created agent
    // the spawning call (Agent/Task) closed: foreground subagents still marked live (e.g. interrupted,
    // no handback) are done. Background ones keep running: their call ends right after the async launch.
    const kids = this.db.prepare(
      "SELECT id FROM agents WHERE parent_id = ? AND parent_tool_use_id = ? AND status != 'ended' AND (request_shape IS NULL OR request_shape != 'background')",
    ).all(e.agentId, e.callId) as Row[];
    const out: HubEvent[] = [...this.agentOut(e.agentId), ...this.callOut(e.callId)];
    for (const k of kids) {
      this.db.prepare("UPDATE agents SET status = 'ended' WHERE id = ?").run(k.id);
      out.push(...this.agentOut(k.id));
    }
    return out;
  }

  private callOut(id: string): HubEvent[] {
    const r = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as Row | undefined;
    return r ? [{ type: 'call', call: toCall(r) }] : [];
  }
}
