import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { HubEvent, NormalizedEvent } from '@/src/core/model';
import type { Store } from '@/src/core/store';
import { readNewLines } from './tail';

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WatcherOptions {
  /** Use polling instead of native fs events (tests). */
  polling?: boolean;
  /** Liveness check period in ms (default 5000). */
  livenessMs?: number;
}

export interface TailWatcherSpec<Ctx> {
  root: string;
  match(file: string): boolean;
  makeCtx(file: string, resumed: boolean): Ctx;
  parse(line: string, ctx: Ctx): NormalizedEvent[];
  store: Store;
  onEvents(evs: HubEvent[]): void;
  backfillMs: number;
  options?: WatcherOptions;
  /** Called after each file read with the file and its ctx. */
  afterRead?(file: string, ctx: Ctx): void;
}

export interface TailCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(file: string): Promise<void>;
}

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
  let fsw: ReturnType<typeof chokidar.watch> | null = null;
  let stopped = false;

  const warnOnce = (file: string, err: unknown) => {
    if (warned.has(file)) return;
    warned.add(file);
    console.warn(`[acctv] cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  };

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
      const res = await readNewLines(file, saved ?? { offset: 0, lines: 0 });
      if (stopped) return;
      const out: HubEvent[] = [];
      const c = ctx;
      spec.store.transaction(() => {
        for (const line of res.lines) {
          for (const ev of spec.parse(line, c)) out.push(...spec.store.applyEvent(ev));
        }
        spec.store.setOffset(file, res.offset, res.lineCount);
      });
      spec.afterRead?.(file, ctx);
      if (out.length) spec.onEvents(out);
    } catch (err) {
      warnOnce(file, err);
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
    for (const { f } of recent) await enqueue(f);
  }

  return {
    enqueue,
    async start() {
      stopped = false;
      await backfill();
      if (!fs.existsSync(spec.root)) return;
      const polling = spec.options?.polling ?? false;
      fsw = chokidar.watch(spec.root, {
        ignoreInitial: true,
        awaitWriteFinish: false,
        usePolling: polling,
        interval: polling ? 50 : undefined,
        ignored: (p: string, stats?: fs.Stats) => !!stats?.isFile() && !spec.match(p),
      });
      const onFile = (f: string) => {
        if (spec.match(f)) void enqueue(f);
      };
      fsw.on('add', onFile).on('change', onFile);
      fsw.on('error', (err) => console.warn(`[acctv] watcher error: ${err instanceof Error ? err.message : String(err)}`));
      await new Promise<void>((resolve) => {
        fsw!.once('ready', () => resolve());
      });
    },
    async stop() {
      stopped = true;
      const w = fsw;
      fsw = null;
      if (w) await w.close();
      await Promise.allSettled([...queues.values()]);
    },
  };
}
