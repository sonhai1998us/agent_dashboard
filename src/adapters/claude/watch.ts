import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import type { AgentStatus, HubEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { applyClaudeMeta, claudeCtxForPath, parseClaudeLine, type ClaudeFileCtx, type ClaudeSubagentMeta } from './parse';
import { createTailCore, RESCAN_ACTIVE_MS, type Watcher, type WatcherOptions } from '../watchBase';

function readMeta(file: string): ClaudeSubagentMeta | undefined {
  if (!/[\\/]subagents[\\/]/.test(file)) return undefined;
  try {
    const metaFile = file.replace(/\.jsonl$/i, '.meta.json');
    const j = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return j && typeof j === 'object' ? j : undefined;
  } catch {
    return undefined;
  }
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
  const core = createTailCore<ClaudeFileCtx>({
    name: 'claude',
    root: path.join(cfg.claudeDir, 'projects'),
    match: (f) => f.toLowerCase().endsWith('.jsonl'),
    makeCtx: (f, resumed) => claudeCtxForPath(f, cfg.claudeDir, readMeta(f), { resumed }),
    parse: parseClaudeLine,
    // meta.json may be written after the transcript: keep looking for it while it is missing
    beforeRead: (f, c) => {
      if (!c.metaPending) return [];
      const meta = readMeta(f);
      return meta ? applyClaudeMeta(c, meta) : [];
    },
    agentId: (c) => c.agentId,
    store, onEvents,
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
        if (a.source !== 'claude') continue;
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
      if (out.length) onEvents(out);
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
