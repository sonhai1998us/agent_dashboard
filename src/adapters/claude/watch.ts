import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import { isManagedId, type AgentStatus, type HubEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { applyClaudeMeta, claudeCtxForPath, parseClaudeLine, type ClaudeFileCtx, type ClaudeSubagentMeta } from './parse';
import { createTailCore, RESCAN_ACTIVE_MS, type Watcher, type WatcherOptions } from '../watchBase';

const isSubagentFile = (file: string): boolean => /[\\/]subagents[\\/]/.test(file);
const metaPathOf = (file: string): string => file.replace(/\.jsonl$/i, '.meta.json');

function readMeta(file: string): ClaudeSubagentMeta | undefined {
  if (!isSubagentFile(file)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(metaPathOf(file), 'utf8'));
    return j && typeof j === 'object' ? j : undefined;
  } catch {
    return undefined;
  }
}

function metaMtime(file: string): number | undefined {
  try { return fs.statSync(metaPathOf(file)).mtimeMs; } catch { return undefined; }
}

/** `<sid>` of projects/<proj>/<sid>.jsonl or projects/<proj>/<sid>/subagents/agent-<id>.jsonl */
function sessionIdOfPath(file: string): string {
  const parts = file.split(/[\\/]+/);
  const i = parts.lastIndexOf('subagents');
  return i >= 1 ? parts[i - 1] : (parts[parts.length - 1] ?? '').replace(/\.jsonl$/i, '');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

export function createClaudeWatcher(
  cfg: Config, store: Store, onEvents: (evs: HubEvent[]) => void, options: WatcherOptions = {},
): Watcher {
  let backfillDone: Promise<void> = Promise.resolve();
  const ctxByAgent = new Map<string, ClaudeFileCtx>();
  // A subagent can be ended by signals outside its transcript (parent's call closed, meta.json finished,
  // parent process gone). Mark its ctx ended so the next transcript record emits `running` again.
  const forward = (evs: HubEvent[]): void => {
    for (const e of evs) {
      if (e.type !== 'agent' || !e.agent.parentId || e.agent.status !== 'ended') continue;
      const c = ctxByAgent.get(e.agent.id);
      if (c) c.ended = true;
    }
    onEvents(evs);
  };
  const core = createTailCore<ClaudeFileCtx>({
    name: 'claude',
    root: path.join(cfg.claudeDir, 'projects'),
    match: (f) => f.toLowerCase().endsWith('.jsonl') && !store.isManagedSession(sessionIdOfPath(f)),
    makeCtx: (f, resumed) => {
      const c = claudeCtxForPath(f, cfg.claudeDir, readMeta(f), { resumed });
      ctxByAgent.set(c.agentId, c);
      return c;
    },
    parse: parseClaudeLine,
    // meta.json changes while a subagent runs (late creation, requestShape, `finished`): re-apply it
    // whenever its mtime changed, after the transcript records of this read
    refresh: (f, c) => {
      if (!c.parentId) return [];
      const m = metaMtime(f);
      if (m === undefined || m === c.metaMtime) return [];
      const meta = readMeta(f);
      if (!meta) return [];
      const evs = applyClaudeMeta(c, meta);
      if (c.lastTs !== null) c.metaMtime = m; // not introduced yet: apply again on the next read
      return evs;
    },
    agentId: (c) => c.agentId,
    store, onEvents: forward,
    backfillMs: cfg.backfillHours * 3600_000,
    options,
  });

  let timer: NodeJS.Timeout | null = null;
  const warned = new Set<string>();

  function liveness(): void {
    void core.ensureWatching();
    try {
      const since = Date.now() - RESCAN_ACTIVE_MS;
      const active = new Set(store.listAgents({ since }).map((a) => a.id));
      core.rescan((id) => active.has(id));
      // meta.json of live (or recently active) subagents: re-read when it changed (e.g. `finished`)
      for (const [file, raw] of core.entries()) {
        const c = raw as ClaudeFileCtx;
        if (!c.parentId) continue;
        const a = store.getAgent(c.agentId);
        if (!a || (a.status === 'ended' && !active.has(a.id))) continue;
        const m = metaMtime(file);
        if (m !== undefined && m !== c.metaMtime) void core.enqueue(file);
      }
    } catch (err) {
      console.warn(`[acctv] rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const dir = path.join(cfg.claudeDir, 'sessions');
      let names: string[] = [];
      try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')); } catch { /* no sessions dir */ }
      const alive = new Map<string, { pid: number; busy: boolean }>(); // sessionId -> live session
      for (const n of names) {
        const f = path.join(dir, n);
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (typeof j?.pid === 'number' && typeof j?.sessionId === 'string' && pidAlive(j.pid)) {
            alive.set(j.sessionId, { pid: j.pid, busy: j.status === 'busy' });
          }
        } catch (err) {
          if (!warned.has(f)) { warned.add(f); console.warn(`[acctv] cannot read ${f}: ${err instanceof Error ? err.message : String(err)}`); }
        }
      }
      const out: HubEvent[] = [];
      for (const a of store.listAgents()) {
        if (a.source !== 'claude' || isManagedId(a.id)) continue;
        const live = alive.get(a.sessionId);
        let status: AgentStatus;
        let pid: number | undefined;
        if (a.parentId === null) {
          status = live ? (live.busy ? 'running' : 'idle') : 'ended';
          pid = live?.pid;
        } else {
          // subagent status is driven by its transcript; liveness only demotes when the parent is gone
          if (live || a.status === 'ended') continue;
          status = 'ended';
        }
        if (a.status === status && (pid === undefined || a.pid === pid)) continue;
        const updated = store.setAgentStatus(a.id, status, pid);
        if (updated) out.push({ type: 'agent', agent: updated });
      }
      if (out.length) forward(out);
    } catch (err) {
      console.warn(`[acctv] claude liveness failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    async start() {
      await core.start();
      liveness();
      timer = setInterval(liveness, options.livenessMs ?? 5000);
      // statuses for agents found by the background backfill are set as soon as it ends
      backfillDone = core.backfilled().then(() => { if (timer) liveness(); });
    },
    backfilled: () => backfillDone,
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await core.stop();
    },
  };
}
