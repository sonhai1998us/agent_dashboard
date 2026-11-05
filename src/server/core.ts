import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@/src/core/config';
import { Store } from '@/src/core/store';
import { INGEST_VERSION } from '@/src/core/version';
import { Hub } from '@/src/core/hub';
import { DetectEngine } from '@/src/detect/engine';
import { createClaudeWatcher } from '@/src/adapters/claude/watch';
import { createCodexWatcher } from '@/src/adapters/codex/watch';
import type { Watcher, WatcherOptions } from '@/src/adapters/watchBase';
import type { HubEvent, NormalizedEvent } from '@/src/core/model';
import type { AgentKind } from '@/src/tickets/model';
import { TicketStore } from '@/src/tickets/store';
import { Orchestrator } from '@/src/orchestrator/orchestrator';
import * as git from '@/src/git/git';
import type { Runner } from '@/src/runner/types';
import { createClaudeRunner } from '@/src/runner/claude';
import { createCodexRunner } from '@/src/runner/codex';
import { findExecutable } from '@/src/runner/detect';

export type Runners = Partial<Record<AgentKind, Runner>>;

export interface Core {
  cfg: Config;
  store: Store;
  hub: Hub;
  engine: DetectEngine;
  tickets: TicketStore;
  orchestrator: Orchestrator;
  /** Applies events from dashboard-run agents, then publishes them like watcher events. */
  ingest(evs: NormalizedEvent[]): void;
  capabilities(): Record<AgentKind, boolean>;
  /** Dò lại CLI sau khi đổi claudePath/codexPath (không làm gì khi runner được truyền vào). */
  reloadRunners(): void;
  /** Resolves when every watcher has finished its background backfill. */
  backfilled(): Promise<void>;
  stop(): Promise<void>;
}

export interface CoreOptions {
  runners?: Runners;
  /** Cổng server thật (cấp cho URL MCP và hook guard). Mặc định cfg.port. */
  port?: () => number;
}

export const TICK_MS = 5000;
export const GUARD_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'acctv-guard.mjs');

/** Runner theo CLI có trên máy. `ACCTV_CLAUDE_CMD` (JSON `{command, prefixArgs?}`) chỉ để thử: thay CLI claude thật. */
export function cliRunners(cfg: Config, env: Record<string, string | undefined> = process.env): Runners {
  const out: Runners = {};
  const fake = env.ACCTV_CLAUDE_CMD;
  if (fake) {
    let j: { command?: unknown; prefixArgs?: unknown };
    try {
      j = JSON.parse(fake);
    } catch (e) {
      throw new Error(`ACCTV_CLAUDE_CMD không phải JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const prefix = j.prefixArgs ?? [];
    if (typeof j.command !== 'string' || !j.command || !Array.isArray(prefix) || !prefix.every((x) => typeof x === 'string')) {
      throw new Error('ACCTV_CLAUDE_CMD phải có dạng {"command": "...", "prefixArgs": ["..."]}');
    }
    out.claude = createClaudeRunner({ command: j.command, prefixArgs: prefix as string[], guardScript: GUARD_SCRIPT });
  } else {
    const exe = findExecutable('claude', cfg.settings.claudePath);
    if (exe) out.claude = createClaudeRunner({ command: exe, guardScript: GUARD_SCRIPT });
  }
  const codex = findExecutable('codex', cfg.settings.codexPath);
  if (codex) out.codex = createCodexRunner({ command: codex });
  return out;
}

export async function createCore(cfg: Config, watcherOptions: WatcherOptions = {}, opts: CoreOptions = {}): Promise<Core> {
  const runners: Runners = opts.runners ? { ...opts.runners } : cliRunners(cfg);
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
  const orchestrator = new Orchestrator({ cfg, store, tickets, hub, ingest, runners, git, port: opts.port ?? (() => cfg.port) });
  const unsub = hub.subscribe((e) => {
    if (e.type === 'alert') orchestrator.onAlert(e.alert);
  });
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
    await orchestrator.recover();
  } catch (err) {
    clearInterval(tick);
    unsub();
    await Promise.allSettled(watchers.map((w) => w.stop()));
    await orchestrator.shutdown();
    store.close();
    throw err;
  }

  let stopped = false;
  return {
    cfg, store, hub, engine, tickets, orchestrator, ingest,
    capabilities: () => ({ claude: !!runners.claude, codex: !!runners.codex }),
    reloadRunners() {
      if (opts.runners) return;
      const next = cliRunners(cfg);
      for (const k of Object.keys(runners) as AgentKind[]) delete runners[k];
      Object.assign(runners, next);
    },
    async backfilled() {
      await Promise.all(watchers.map((w) => w.backfilled()));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      unsub();
      await Promise.allSettled(watchers.map((w) => w.stop()));
      await orchestrator.shutdown(); // kill agent đang chạy trước khi đóng store
      store.close();
    },
  };
}
