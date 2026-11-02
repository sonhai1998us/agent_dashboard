import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import type { HubEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { codexCtxForPath, parseCodexLine, type CodexFileCtx } from './parse';
import { createTailCore, type Watcher, type WatcherOptions } from '../watchBase';

const ACTIVE_MS = 120_000;
const ENDED_MS = 30 * 60_000;

export function createCodexWatcher(
  cfg: Config, store: Store, onEvents: (evs: HubEvent[]) => void, options: WatcherOptions = {},
): Watcher {
  const ctxByFile = new Map<string, CodexFileCtx>();
  const core = createTailCore<CodexFileCtx>({
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
      const now = Date.now();
      const out: HubEvent[] = [];
      for (const [file, ctx] of ctxByFile) {
        if (!ctx.agentId) continue;
        let mtime: number;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        const age = now - mtime;
        const status = age > ENDED_MS ? 'ended' : age <= ACTIVE_MS && ctx.turnOpen ? 'running' : 'idle';
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
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await core.stop();
    },
  };
}
