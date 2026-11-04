import type { NormalizedEvent } from '@/src/core/model';
import type { Runner, RunResult, RunSink, RunSpec } from '@/src/runner/types';

export interface FakeRun {
  spec: RunSpec;
  sink: RunSink;
  done: Promise<RunResult>;
  /** null khi run giả lập lỗi spawn đồng bộ */
  pid: number | null;
  killed: boolean;
  ended: boolean;
  emit(evs: NormalizedEvent[]): void;
  limited(on: boolean): void;
  finish(r?: Partial<RunResult>): void;
}

/**
 * `control.spawnFailures = n`: n lần gọi runner tiếp theo trả pid null và kết thúc ngay với lỗi spawn.
 * `control.deferKill = true`: kill() chỉ đánh dấu killed; tiến trình "thoát" khi test gọi finish().
 */
export function createFakeRunner(): { runner: Runner; runs: FakeRun[]; control: { spawnFailures: number; deferKill: boolean } } {
  const runs: FakeRun[] = [];
  const control = { spawnFailures: 0, deferKill: false };
  const runner: Runner = (spec, sink) => {
    let resolve!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => { resolve = r; });
    const spawnFail = control.spawnFailures > 0;
    if (spawnFail) control.spawnFailures--;
    const run: FakeRun = {
      spec, sink, done, pid: spawnFail ? null : 10000 + runs.length, killed: false, ended: false,
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
    if (spawnFail) run.finish({ exitCode: null, isError: true, text: 'spawn ENOENT' });
    return {
      pid: run.pid,
      done,
      async kill() {
        if (run.ended) return;
        run.killed = true;
        if (!control.deferKill) run.finish({ exitCode: null, killed: true, isError: true });
      },
    };
  };
  return { runner, runs, control };
}
