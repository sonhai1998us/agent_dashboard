import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '@/src/core/store';
import { Hub } from '@/src/core/hub';
import { TicketStore } from '@/src/tickets/store';
import { DEFAULT_SETTINGS, DEFAULT_THRESHOLDS, type Config } from '@/src/core/config';
import * as git from '@/src/git/git';
import { Orchestrator, type OrchestratorDeps } from '@/src/orchestrator/orchestrator';
import type { HubEvent, NormalizedEvent } from '@/src/core/model';
import type { AgentKind } from '@/src/tickets/model';
import type { Runner } from '@/src/runner/types';
import { createFakeRunner, type FakeRun } from './fakeRunner';

export const g = (dir: string, ...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

export interface Env {
  root: string; repo: string; cfg: Config; store: Store; tickets: TicketStore; hub: Hub; orch: Orchestrator;
  runs: FakeRun[]; fake: { spawnFailures: number; deferKill: boolean }; published: HubEvent[]; order: string[]; managedAtSpawn: boolean[]; clock: { t: number };
  /** Orchestrator mới trên cùng DB và runner giả (giả lập dashboard khởi động lại). */
  reopen(): Orchestrator;
}

export function makeEnv(opts: { maxParallel?: number; maxRounds?: number; runners?: Partial<Record<AgentKind, Runner | null>>; delays?: OrchestratorDeps['delays']; git?: Partial<typeof git> } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'acctv-orch-'));
  const repo = join(root, 'Dự án demo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  g(repo, 'init', '-q');
  g(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 1;\n');
  g(repo, 'add', '-A');
  g(repo, '-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');

  const settings = structuredClone(DEFAULT_SETTINGS);
  if (opts.maxParallel) settings.maxParallel = opts.maxParallel;
  if (opts.maxRounds) settings.maxRounds = opts.maxRounds;
  const cfg: Config = {
    home: join(root, 'home'), claudeDir: join(root, 'claude'), codexDir: join(root, 'codex'), port: 4777, host: '127.0.0.1',
    backfillHours: 24, thresholds: { ...DEFAULT_THRESHOLDS }, settings,
  };
  const store = new Store(':memory:');
  const tickets = new TicketStore(store);
  const hub = new Hub();
  const published: HubEvent[] = [];
  hub.subscribe((e) => published.push(e));
  const order: string[] = [];
  const managedAtSpawn: boolean[] = [];
  const ingest = (evs: NormalizedEvent[]): void => {
    for (const e of evs) if (e.type === 'agent') order.push(`ingest:${e.agent.id}`);
    const out = store.transaction(() => evs.flatMap((e) => store.applyEvent(e)));
    for (const e of out) hub.publish(e);
  };
  const fake = createFakeRunner();
  const claude: Runner = (spec, sink) => {
    order.push(`run:${spec.agentId}`);
    managedAtSpawn.push(store.isManagedSession(spec.sessionId));
    return fake.runner(spec, sink);
  };
  const runners: Partial<Record<AgentKind, Runner>> = {};
  const want = { claude, ...opts.runners };
  for (const k of Object.keys(want) as AgentKind[]) if (want[k]) runners[k] = want[k]!;
  const clock = { t: 1_700_000_000_000 };
  let sid = 0;
  const deps: OrchestratorDeps = {
    cfg, store, tickets, hub, ingest, runners, git: { ...git, ...opts.git }, port: () => 4777,
    now: () => clock.t, newSessionId: () => `sid-${++sid}`, delays: opts.delays,
  };
  const orch = new Orchestrator(deps);
  return {
    root, repo, cfg, store, tickets, hub, orch, runs: fake.runs, fake: fake.control, published, order, managedAtSpawn, clock,
    reopen: () => new Orchestrator(deps),
  };
}

export function cleanup(env: Env): void {
  env.store.close();
  rmSync(env.root, { recursive: true, force: true, maxRetries: 3 });
}

/** Kế hoạch mẫu; `codexQc`: vai qc chạy bằng codex (model gpt-x). */
export const codexPlan = (role: 'dev' | 'qc' = 'qc') => {
  const p = validPlan();
  p.roles[role] = { ...p.roles[role], agent: 'codex', model: 'gpt-x' };
  return p;
};

export const validPlan = () => ({
  summary: 'Thêm trang đăng nhập', difficulty: 'medium',
  packages: [
    { id: 'p1', role: 'dev', title: 'A', task: 'Làm a', files: ['src/a.ts'] },
    { id: 'p2', role: 'dev', title: 'B', task: 'Làm b', files: ['src/b.ts'] },
    { id: 'p3', role: 'qc', title: 'Review', task: 'Review', files: [] },
  ],
  roles: {
    explorer: { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 0 },
    dev: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 2 },
    designer: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 0 },
    qc: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', count: 1 },
  },
  acceptance: ['Đăng nhập được'],
});

export const ids = (T: string) => ({
  ctrl: `acctv:${T}:controller`, dev1: `acctv:${T}:dev-1`, dev2: `acctv:${T}:dev-2`, qc1: `acctv:${T}:qc-1`,
});

export const runOf = (env: Env, agentId: string): FakeRun | undefined => [...env.runs].reverse().find((r) => r.spec.agentId === agentId);
export const openWaits = (env: Env, agentId: string) => env.tickets.listWaits(Number.MAX_SAFE_INTEGER).filter((w) => w.agentId === agentId);

/** Tạo ticket, đề xuất kế hoạch hợp lệ, duyệt: trả id ticket ở trạng thái running (lượt controller sau duyệt đang chạy). */
export async function toRunning(env: Env, plan: ReturnType<typeof validPlan> = validPlan()): Promise<string> {
  const t = await env.orch.createTicket({ title: 'Trang đăng nhập', description: 'Làm trang login', dir: env.repo });
  const r = await env.orch.mcpTools(t.id).propose_plan({ plan });
  if (r.isError) throw new Error(r.text);
  env.runs[env.runs.length - 1].finish({});
  await env.orch.idle();
  await env.orch.approve(t.id);
  await env.orch.idle();
  return t.id;
}
