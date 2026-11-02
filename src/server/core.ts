import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import { Store } from '@/src/core/store';
import { Hub } from '@/src/core/hub';
import { DetectEngine } from '@/src/detect/engine';
import { createClaudeWatcher } from '@/src/adapters/claude/watch';
import { createCodexWatcher } from '@/src/adapters/codex/watch';
import type { Watcher, WatcherOptions } from '@/src/adapters/watchBase';
import type { HubEvent } from '@/src/core/model';

export interface Core {
  cfg: Config;
  store: Store;
  hub: Hub;
  engine: DetectEngine;
  stop(): Promise<void>;
}

export const TICK_MS = 5000;

export async function createCore(cfg: Config, watcherOptions: WatcherOptions = {}): Promise<Core> {
  fs.mkdirSync(cfg.home, { recursive: true });
  const store = new Store(path.join(cfg.home, 'acctv.db'));
  const hub = new Hub();
  const engine = new DetectEngine(store, cfg, (e) => hub.publish(e));

  const onEvents = (evs: HubEvent[]): void => {
    for (const e of evs) {
      hub.publish(e);
      if (e.type === 'call') engine.onCall(e.call.agentId);
    }
  };
  const watchers: Watcher[] = [
    createClaudeWatcher(cfg, store, onEvents, watcherOptions),
    createCodexWatcher(cfg, store, onEvents, watcherOptions),
  ];
  const tick = setInterval(() => {
    try {
      engine.tick(Date.now());
    } catch (err) {
      console.warn(`[acctv] detect tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, TICK_MS);

  try {
    for (const w of watchers) await w.start();
  } catch (err) {
    clearInterval(tick);
    await Promise.allSettled(watchers.map((w) => w.stop()));
    store.close();
    throw err;
  }

  let stopped = false;
  return {
    cfg, store, hub, engine,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      await Promise.allSettled(watchers.map((w) => w.stop()));
      store.close();
    },
  };
}
