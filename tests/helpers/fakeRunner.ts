import type { NormalizedEvent } from '@/src/core/model';
import type { Runner, RunResult, RunSink, RunSpec } from '@/src/runner/types';

export interface FakeRun {
  spec: RunSpec;
  sink: RunSink;
  done: Promise<RunResult>;
  killed: boolean;
  ended: boolean;
  emit(evs: NormalizedEvent[]): void;
  limited(on: boolean): void;
  finish(r?: Partial<RunResult>): void;
}

export function createFakeRunner(): { runner: Runner; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const runner: Runner = (spec, sink) => {
    let resolve!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => { resolve = r; });
    const run: FakeRun = {
      spec, sink, done, killed: false, ended: false,
      emit: (evs) => sink.events(evs),
      limited: (on) => sink.limited(on),
      finish(r = {}) {
        if (run.ended) return;
        run.ended = true;
        resolve({
          exitCode: 0, killed: false, isError: false, text: '', costUsd: null, rateLimited: false,
          sessionId: spec.sessionId, changedFiles: [], ...r,
        });
      },
    };
    runs.push(run);
    return {
      pid: null,
      done,
      async kill() {
        if (run.ended) return;
        run.killed = true;
        run.finish({ exitCode: null, killed: true, isError: true });
      },
    };
  };
  return { runner, runs };
}
