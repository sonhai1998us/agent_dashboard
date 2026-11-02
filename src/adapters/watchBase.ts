import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { HubEvent, NormalizedEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { tailChunks, CHUNK_BYTES } from './tail';

export interface Watcher {
  /** Resolves once the fs watcher is attached; the backfill keeps running in the background. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when the current backfill (and the status pass after it) has finished. */
  backfilled(): Promise<void>;
}

export interface WatcherOptions {
  /**
   * Use polling instead of native fs events. Note: on NTFS a directory's mtime is not reliably
   * bumped when a file is created in it, so polling can miss brand-new files; prefer native events.
   */
  polling?: boolean;
  /** Delays before re-reading a file whose read failed (default 1s, 2s, 5s: max 3 retries). */
  retryMs?: number[];
  /** Liveness check period in ms (default 5000). */
  livenessMs?: number;
  /** Max bytes read per chunk (default 2MB). */
  chunkBytes?: number;
}

export interface TailWatcherSpec<Ctx> {
  /** Short source name used in log lines. */
  name?: string;
  root: string;
  match(file: string): boolean;
  makeCtx(file: string, resumed: boolean): Ctx;
  parse(line: string, ctx: Ctx): NormalizedEvent[];
  store: Store;
  onEvents(evs: HubEvent[]): void;
  backfillMs: number;
  options?: WatcherOptions;
  /** Agent id of a ctx when known (used to count skipped lines as parse errors). */
  agentId?(ctx: Ctx): string | null;
  /** Called after each file read with the file and its ctx. */
  afterRead?(file: string, ctx: Ctx): void;
}

export interface TailCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(file: string): Promise<void>;
  /** Starts watching the root once it exists (backfill runs in the background). Idempotent. */
  ensureWatching(): Promise<void>;
  /** Resolves when the running backfill (if any) has finished. */
  backfilled(): Promise<void>;
  /**
   * Safety net for dropped fs events: re-stats every known file whose agent `isActive` and
   * re-reads it when its size differs from the saved offset.
   */
  rescan(isActive: (agentId: string) => boolean): void;
}

const DEFAULT_RETRY_MS = [1000, 2000, 5000];
/** Liveness ticks re-check the files of agents with an event this recent. */
export const RESCAN_ACTIVE_MS = 10 * 60_000;

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

export function createTailCore<Ctx>(spec: TailWatcherSpec<Ctx>): TailCore {
  const ctxs = new Map<string, Ctx>();
  const queues = new Map<string, Promise<void>>();
  const warned = new Set<string>();
  const retryMs = spec.options?.retryMs ?? DEFAULT_RETRY_MS;
  const failures = new Map<string, number>(); // file -> consecutive failed reads
  const retryTimers = new Map<string, NodeJS.Timeout>();
  let fsw: ReturnType<typeof chokidar.watch> | null = null;
  let stopped = false;

  const warnOnce = (file: string, err: unknown, where = '') => {
    if (warned.has(file)) return;
    warned.add(file);
    console.warn(`[acctv] cannot read ${file}${where ? ' (' + where + ')' : ''}: ${err instanceof Error ? err.message : String(err)}`);
  };

  function scheduleRetry(file: string): void {
    const n = failures.get(file) ?? 0;
    failures.set(file, n + 1);
    if (n >= retryMs.length || retryTimers.has(file) || stopped) return; // gave up: the next fs event retries
    const t = setTimeout(() => {
      retryTimers.delete(file);
      void enqueue(file);
    }, retryMs[n]);
    retryTimers.set(file, t);
  }

  async function readFile(file: string): Promise<void> {
    if (stopped) return;
    try {
      const saved = spec.store.getOffset(file);
      let ctx = ctxs.get(file);
      if (!ctx) {
        const resumed = !!saved && (saved.offset > 0 || saved.lines > 0);
        ctx = spec.makeCtx(file, resumed);
        ctxs.set(file, ctx);
      }
      const c = ctx;
      let first = true;
      for await (const chunk of tailChunks(file, saved ?? { offset: 0, lines: 0 }, spec.options?.chunkBytes ?? CHUNK_BYTES)) {
        if (stopped) return;
        if (!first) await new Promise<void>((r) => setImmediate(r));
        first = false;
        const out: HubEvent[] = [];
        spec.store.transaction(() => {
          for (const line of chunk.lines) {
            try {
              for (const ev of spec.parse(line, c)) out.push(...spec.store.applyEvent(ev));
            } catch (err) {
              warnOnce(file, err, `line near byte ${chunk.startOffset}`);
              const id = spec.agentId?.(c);
              if (id) {
                try { out.push(...spec.store.applyEvent({ type: 'parse_error', agentId: id })); } catch { /* ignore */ }
              }
            }
          }
          spec.store.setOffset(file, chunk.offset, chunk.lineCount);
        });
        if (out.length) spec.onEvents(out);
      }
      spec.afterRead?.(file, ctx);
      failures.delete(file);
    } catch (err) {
      warnOnce(file, err);
      scheduleRetry(file);
    }
  }

  function enqueue(file: string): Promise<void> {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.then(() => readFile(file));
    queues.set(file, next);
    void next.then(() => {
      if (queues.get(file) === next) queues.delete(file);
    });
    return next;
  }

  let backfilling: Promise<void> = Promise.resolve();
  const BACKFILL_LOG_MS = 2000;

  async function backfill(): Promise<void> {
    const all: string[] = [];
    walk(spec.root, all);
    const cutoff = Date.now() - spec.backfillMs;
    const recent: { f: string; m: number }[] = [];
    for (const f of all) {
      if (!spec.match(f)) continue;
      try {
        const m = fs.statSync(f).mtimeMs;
        if (m >= cutoff) recent.push({ f, m });
      } catch (err) {
        warnOnce(f, err);
      }
    }
    recent.sort((a, b) => a.m - b.m);
    const total = recent.length;
    if (total === 0) return;
    const tag = spec.name ? ` (${spec.name})` : '';
    console.log(`[acctv] backfill: 0/${total} files${tag}`);
    let lastLog = Date.now();
    let n = 0;
    for (const { f } of recent) {
      if (stopped) return;
      await enqueue(f);
      n++;
      if (n < total && Date.now() - lastLog >= BACKFILL_LOG_MS) {
        lastLog = Date.now();
        console.log(`[acctv] backfill: ${n}/${total} files${tag}`);
      }
    }
    console.log(`[acctv] backfill: ${n}/${total} files${tag}`);
  }

  let attaching: Promise<void> | null = null;

  async function attach(): Promise<void> {
    const polling = spec.options?.polling ?? false;
    const w = chokidar.watch(spec.root, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      usePolling: polling,
      interval: polling ? 50 : undefined,
      ignored: (p: string, stats?: fs.Stats) => !!stats?.isFile() && !spec.match(p),
    });
    fsw = w;
    const onFile = (f: string) => {
      if (spec.match(f)) void enqueue(f);
    };
    w.on('add', onFile).on('change', onFile);
    w.on('error', (err) => console.warn(`[acctv] watcher error: ${err instanceof Error ? err.message : String(err)}`));
    await new Promise<void>((resolve) => {
      w.once('ready', () => resolve());
    });
    if (stopped) return;
    // files that predate the watcher (ignoreInitial skips them); runs in the background so the
    // server can answer while a large backlog is read
    backfilling = backfill().catch((err) => {
      console.warn(`[acctv] backfill of ${spec.root} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  function ensureWatching(): Promise<void> {
    if (stopped || fsw || attaching) return attaching ?? Promise.resolve();
    if (!fs.existsSync(spec.root)) return Promise.resolve();
    attaching = attach()
      .catch((err) => console.warn(`[acctv] cannot watch ${spec.root}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { attaching = null; });
    return attaching;
  }

  return {
    enqueue,
    ensureWatching,
    async backfilled() {
      await attaching;
      await backfilling;
    },
    rescan(isActive) {
      if (stopped) return;
      for (const [file, ctx] of ctxs) {
        if (queues.has(file) || retryTimers.has(file)) continue; // a read is already pending
        const id = spec.agentId?.(ctx);
        if (!id || !isActive(id)) continue;
        let size: number;
        try { size = fs.statSync(file).size; } catch { continue; }
        const saved = spec.store.getOffset(file);
        if (!saved || size !== saved.offset) void enqueue(file);
      }
    },
    async start() {
      stopped = false;
      await ensureWatching();
    },
    async stop() {
      stopped = true;
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
      await attaching;
      const w = fsw;
      fsw = null;
      if (w) await w.close();
      await backfilling;
      await Promise.allSettled([...queues.values()]);
    },
  };
}
