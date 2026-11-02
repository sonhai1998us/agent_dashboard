import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import type { HubEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { claudeCtxForPath, parseClaudeLine, type ClaudeFileCtx } from './parse';
import { createTailCore, type Watcher, type WatcherOptions } from '../watchBase';

const SUBAGENT_ACTIVE_MS = 10 * 60 * 1000;

function readMeta(file: string): { agentType?: string; description?: string } | undefined {
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
  const core = createTailCore<ClaudeFileCtx>({
    root: path.join(cfg.claudeDir, 'projects'),
    match: (f) => f.toLowerCase().endsWith('.jsonl'),
    makeCtx: (f, resumed) => claudeCtxForPath(f, cfg.claudeDir, readMeta(f), { resumed }),
    parse: parseClaudeLine,
    store, onEvents,
    backfillMs: cfg.backfillHours * 3600_000,
    options,
  });

  let timer: NodeJS.Timeout | null = null;
  const warned = new Set<string>();

  function liveness(): void {
    try {
      const dir = path.join(cfg.claudeDir, 'sessions');
      let names: string[] = [];
      try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')); } catch { /* no sessions dir */ }
      const alive = new Map<string, number>(); // sessionId -> pid
      for (const n of names) {
        const f = path.join(dir, n);
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (typeof j?.pid === 'number' && typeof j?.sessionId === 'string' && pidAlive(j.pid)) alive.set(j.sessionId, j.pid);
        } catch (err) {
          if (!warned.has(f)) { warned.add(f); console.warn(`[acctv] cannot read ${f}: ${err instanceof Error ? err.message : String(err)}`); }
        }
      }
      const now = Date.now();
      const out: HubEvent[] = [];
      for (const a of store.listAgents()) {
        if (a.source !== 'claude') continue;
        const sessionPid = alive.get(a.sessionId);
        const running = sessionPid !== undefined && (a.parentId === null || now - a.lastEventAt <= SUBAGENT_ACTIVE_MS);
        const status = running ? 'running' : 'ended';
        const pid = running ? sessionPid : undefined;
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
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await core.stop();
    },
  };
}
