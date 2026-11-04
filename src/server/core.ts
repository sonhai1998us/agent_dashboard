import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@/src/core/config';
import { Store } from '@/src/core/store';
import { INGEST_VERSION } from '@/src/core/version';
import { Hub } from '@/src/core/hub';
import { DetectEngine } from '@/src/detect/engine';
import { createClaudeWatcher } from '@/src/adapters/claude/watch';
import { createCodexWatcher } from '@/src/adapters/codex/watch';
import type { Watcher, WatcherOptions } from '@/src/adapters/watchBase';
import type { HubEvent, NormalizedEvent } from '@/src/core/model';
import { TicketStore } from '@/src/tickets/store';

export interface Core {
  cfg: Config;
  store: Store;
  hub: Hub;
  engine: DetectEngine;
  tickets: TicketStore;
  /** Applies events from dashboard-run agents, then publishes them like watcher events. */
  ingest(evs: NormalizedEvent[]): void;
  /** Resolves when every watcher has finished its background backfill. */
  backfilled(): Promise<void>;
  stop(): Promise<void>;
}

export const TICK_MS = 5000;

export async function createCore(cfg: Config, watcherOptions: WatcherOptions = {}): Promise<Core> {
  fs.mkdirSync(cfg.home, { recursive: true });
  const store = new Store(path.join(cfg.home, 'acctv.db'));
  if (store.getMeta('ingestVersion') !== String(INGEST_VERSION)) {
    store.clearIngested();
    store.setMeta('ingestVersion', String(INGEST_VERSION));
  }
  const hub = new Hub();
  const engine = new DetectEngine(store, cfg, (e) => hub.publish(e));

  const onEvents = (evs: HubEvent[]): void => {
    for (const e of evs) {
      hub.publish(e);
      if (e.type === 'call') engine.onCall(e.call.agentId);
    }
  };
  const tickets = new TicketStore(store);
  const ingest = (evs: NormalizedEvent[]): void => {
    const out = store.transaction(() => evs.flatMap((e) => store.applyEvent(e)));
    onEvents(out);
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
    for (const w of watchers) await w.start(); // attaches the fs watchers; backfill continues in the background
  } catch (err) {
    clearInterval(tick);
    await Promise.allSettled(watchers.map((w) => w.stop()));
    store.close();
    throw err;
  }

  let stopped = false;
  return {
    cfg, store, hub, engine, tickets, ingest,
    async backfilled() {
      await Promise.all(watchers.map((w) => w.backfilled()));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      await Promise.allSettled(watchers.map((w) => w.stop()));
      store.close();
    },
  };
}
