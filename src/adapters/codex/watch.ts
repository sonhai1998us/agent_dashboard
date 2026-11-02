import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import type { AgentStatus, HubEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { codexCtxForPath, parseCodexLine, type CodexFileCtx } from './parse';
import { createTailCore, RESCAN_ACTIVE_MS, type Watcher, type WatcherOptions } from '../watchBase';

/** Resumed ctx with unknown turn state: running only if the file was written this recently. */
const ACTIVE_MS = 120_000;
const ENDED_MS = 30 * 60_000;

/**
 * Codex liveness: an open turn stays `running` however long a command takes (so stuck/long_tool can
 * fire); a closed turn is `idle`; no write for 30 min is `ended`. A ctx resumed mid-file does not know
 * whether a turn is open until the next task_* event, so it falls back to the file's recency.
 */
export function codexStatus(ctx: Pick<CodexFileCtx, 'turnOpen' | 'resumed' | 'turnKnown'>, ageMs: number): AgentStatus {
  if (ageMs >= ENDED_MS) return 'ended';
  const known = !ctx.resumed || ctx.turnKnown === true;
  if (known) return ctx.turnOpen ? 'running' : 'idle';
  return ageMs <= ACTIVE_MS ? 'running' : 'idle';
}

export function createCodexWatcher(
  cfg: Config, store: Store, onEvents: (evs: HubEvent[]) => void, options: WatcherOptions = {},
): Watcher {
  const ctxByFile = new Map<string, CodexFileCtx>();
  let backfillDone: Promise<void> = Promise.resolve();
  const core = createTailCore<CodexFileCtx>({
    name: 'codex',
    root: path.join(cfg.codexDir, 'sessions'),
    match: (f) => /\.jsonl(\.zst)?$/i.test(f),
    makeCtx: (f, resumed) => codexCtxForPath(f, { resumed }),
    parse: parseCodexLine,
    agentId: (c) => c.agentId,
    store, onEvents,
    backfillMs: cfg.backfillHours * 3600_000,
    options,
    afterRead: (f, ctx) => { ctxByFile.set(f, ctx); },
  });

  let timer: NodeJS.Timeout | null = null;

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
      const now = Date.now();
      const out: HubEvent[] = [];
      for (const [file, ctx] of ctxByFile) {
        if (!ctx.agentId) continue;
        let mtime: number;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        const status = codexStatus(ctx, now - mtime);
        const a = store.getAgent(ctx.agentId);
        if (!a || a.status === status) continue;
        const updated = store.setAgentStatus(ctx.agentId, status);
        if (updated) out.push({ type: 'agent', agent: updated });
      }
      if (out.length) onEvents(out);
    } catch (err) {
      console.warn(`[acctv] codex liveness failed: ${err instanceof Error ? err.message : String(err)}`);
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
