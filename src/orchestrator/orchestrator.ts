import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { Config, Settings } from '@/src/core/config';
import type { Store } from '@/src/core/store';
import type { Hub } from '@/src/core/hub';
import type { AgentInfo, NormalizedEvent } from '@/src/core/model';
import type { TicketStore } from '@/src/tickets/store';
import { TERMINAL_STATES, type AgentKind, type ManagedAgent, type ManagedState, type Plan, type Role, type RoleSpec, type Ticket, type TicketStatus, type WaitSpan, type WorkRole } from '@/src/tickets/model';
import { branchName, filesOverlap, transition, validatePlan, type TicketEvent } from '@/src/tickets/flow';
import { checkTool, type GuardPolicy } from '@/src/guard/policy';
import type { Runner, RunHandle, RunResult, RunSink, RunSpec } from '@/src/runner/types';
import type { ToolImpl, ToolResult } from './mcp';
import { systemPrompt, turn, workerPrompt } from './prompts';
import { agentLog, agentReport } from './reports';

export interface OrchestratorDeps {
  cfg: Config; store: Store; tickets: TicketStore; hub: Hub; ingest(evs: NormalizedEvent[]): void;
  runners: Partial<Record<AgentKind, Runner>>; git: typeof import('@/src/git/git'); port(): number;
  now?: () => number; newSessionId?: () => string; delays?: { rateLimitMs: number[] };
}

export class OrchestratorError extends Error {
  constructor(public status: 400 | 404 | 409, msg: string) {
    super(msg);
    this.name = 'OrchestratorError';
  }
}

interface CtrlState { handle: RunHandle | null; message: string | null; queue: string[]; nudges: number; waking: boolean }
interface WorkerRun { handle: RunHandle; spec: RunSpec }

const CTRL_TOOLS = ['Read', 'Glob', 'Grep'];
const MCP_TOOLS = ['propose_plan', 'spawn_agent', 'wait_agents', 'get_agent_log', 'finish'].map((n) => `mcp__acctv__${n}`);
const WORKER_TOOLS: Record<WorkRole, string[]> = {
  dev: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  designer: ['Read', 'Glob', 'Grep', 'Bash'],
  qc: ['Read', 'Glob', 'Grep', 'Bash'],
};
const ROLE_LABEL: Record<WorkRole, string> = { dev: 'Dev', designer: 'Designer', qc: 'QC' };
const WORK_ROLES: WorkRole[] = ['dev', 'designer', 'qc'];
const AGENTS: AgentKind[] = ['claude', 'codex'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LIVE: ManagedState[] = ['queued', 'running', 'limited'];
const ENDED_TICKET: TicketStatus[] = ['done', 'escalated', 'cancelled'];
const NOT_APPROVED = 'Kế hoạch chưa được duyệt; chưa được khởi chạy agent';
const NO_CLI: Record<AgentKind, string> = { claude: 'Không tìm thấy Claude CLI', codex: 'Codex CLI chưa được cài trên máy' };

export const controllerId = (ticketId: string): string => `acctv:${ticketId}:controller`;
/** meta: Controller của ticket đã khởi động được ít nhất một tiến trình (session tồn tại → --resume). */
const startedKey = (ticketId: string): string => `ctrlStarted:${ticketId}`;
const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ isError: true, text });
const isStr = (v: unknown): v is string => typeof v === 'string';
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const newToken = (): string => randomBytes(24).toString('hex');
const isTerminal = (s: ManagedState): boolean => TERMINAL_STATES.includes(s);

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Đường dẫn file đã đổi, tương đối theo worktree khi nằm trong nó. */
function relFiles(root: string, files: string[]): string[] {
  const out = files.map((f) => {
    if (!path.isAbsolute(f)) return f.replace(/\\/g, '/');
    const r = path.relative(root, f);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : f;
  });
  return [...new Set(out)];
}

function failedHandle(spec: RunSpec, text: string): RunHandle {
  return {
    pid: null,
    done: Promise.resolve({ exitCode: null, killed: false, isError: true, text, costUsd: null, rateLimited: false, sessionId: spec.sessionId, changedFiles: [] }),
    async kill() {},
  };
}

export class Orchestrator {
  private ctrls = new Map<string, CtrlState>();
  private workers = new Map<string, WorkerRun>();
  private queue: string[] = [];
  private guards = new Map<string, { token: string; policy: GuardPolicy }>();
  private mcpTokens = new Map<string, string>();
  private bg = new Set<Promise<void>>();
  private now: () => number;
  private newSessionId: () => string;

  constructor(private deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  private get settings(): Settings {
    return this.deps.cfg.settings;
  }

  // ---------- API ----------

  async createTicket(input: { title: string; description: string; dir: string; overrides?: Ticket['overrides'] }): Promise<Ticket> {
    const dir = path.resolve(input.dir);
    if (!(await this.deps.git.gitInfo(dir)).isGit) throw new OrchestratorError(400, 'Thư mục không phải git repo');
    if (!this.deps.runners.claude) throw new OrchestratorError(400, NO_CLI.claude);
    const id = this.deps.tickets.nextTicketId();
    const now = this.now();
    const t: Ticket = {
      id, seq: Number(id.slice(2)), title: input.title, description: input.description, dir, status: 'draft',
      overrides: input.overrides ?? {}, plan: null, feedback: null, round: 0, maxRounds: this.settings.maxRounds,
      controllerSessionId: this.newSessionId(), branch: null, worktree: null, baseRef: null, pendingWait: null,
      report: null, diffStat: null, createdAt: now, updatedAt: now,
    };
    this.deps.tickets.createTicket(t);
    this.deps.hub.publish({ type: 'ticket', ticket: t });
    const planning = this.move(id, 'start_planning');
    const spec = this.roleSpec(planning, 'controller');
    this.putManaged({
      agentId: controllerId(id), ticketId: id, role: 'controller', ordinal: 1, packageId: null, task: t.title, files: [],
      runner: 'claude', model: spec.model, effort: spec.effort, sessionId: t.controllerSessionId, state: 'queued',
      stopReason: null, resultText: null, changedFiles: [], costUsd: null, createdAt: now, endedAt: null,
    });
    this.log(id, `Tạo ticket: ${t.title}`);
    this.runControllerTurn(id, turn.first(planning));
    return this.mustTicket(id);
  }

  async approve(ticketId: string, edited?: Plan): Promise<Ticket> {
    const t = this.mustTicket(ticketId);
    if (t.status !== 'awaiting_approval') throw new OrchestratorError(409, 'Ticket không ở trạng thái chờ duyệt');
    let plan = t.plan;
    if (edited !== undefined) {
      const v = validatePlan(edited, this.settings);
      if (!v.ok) throw new OrchestratorError(400, v.errors.join('\n'));
      plan = v.plan;
    }
    if (!plan) throw new OrchestratorError(409, 'Ticket chưa có kế hoạch');
    // chuyển trạng thái trước mọi await: lần duyệt đồng thời thứ hai nhận 409
    this.move(ticketId, 'approve', { plan });
    const branch = branchName(ticketId, t.title);
    const wt = this.deps.git.worktreePath(this.deps.cfg.home, t.dir, ticketId);
    let baseRef: string;
    try {
      ({ baseRef } = await this.deps.git.createWorktree(t.dir, branch, wt));
    } catch (e) {
      this.save(ticketId, { status: 'awaiting_approval', plan: t.plan });
      this.log(ticketId, `Không tạo được worktree: ${errMsg(e)}`);
      throw new OrchestratorError(400, `Không tạo được worktree: ${errMsg(e)}`);
    }
    this.save(ticketId, { branch, worktree: wt, baseRef });
    this.closeWaits(controllerId(ticketId));
    this.log(ticketId, `Người dùng duyệt kế hoạch; nhánh ${branch}`);
    this.runControllerTurn(ticketId, turn.approved(plan, wt));
    return this.mustTicket(ticketId);
  }

  async revise(ticketId: string, feedback: string): Promise<Ticket> {
    const t = this.mustTicket(ticketId);
    if (t.status !== 'awaiting_approval') throw new OrchestratorError(409, 'Ticket không ở trạng thái chờ duyệt');
    const fb = isStr(feedback) ? feedback.trim() : '';
    if (!fb) throw new OrchestratorError(400, 'Góp ý không được rỗng');
    this.move(ticketId, 'revise', { feedback: fb });
    this.closeWaits(controllerId(ticketId));
    this.log(ticketId, 'Người dùng góp ý kế hoạch');
    this.runControllerTurn(ticketId, turn.revised(fb));
    return this.mustTicket(ticketId);
  }

  mcpTools(ticketId: string): Record<string, ToolImpl> {
    return {
      propose_plan: async (a) => this.proposePlan(ticketId, a),
      spawn_agent: async (a) => this.spawnAgent(ticketId, a),
      wait_agents: async (a) => this.waitAgents(ticketId, a),
      get_agent_log: async (a) => this.getAgentLog(ticketId, a),
      finish: async (a) => this.finish(ticketId, a),
    };
  }

  checkMcpToken(ticketId: string, token: string): boolean {
    const cur = this.mcpTokens.get(ticketId);
    return !!cur && safeEq(cur, token);
  }

  guard(agentId: string, token: string, hookInput: unknown): { allow: true } | { allow: false; reason: string } | null {
    const g = this.guards.get(agentId);
    if (!g || !safeEq(g.token, token)) return null;
    const h = hookInput && typeof hookInput === 'object' ? (hookInput as Record<string, unknown>) : {};
    const name = isStr(h.tool_name) ? h.tool_name : '';
    const d = checkTool(g.policy, name, h.tool_input, isStr(h.cwd) ? h.cwd : g.policy.root);
    return d.allow ? { allow: true } : { allow: false, reason: d.reason };
  }

  async idle(): Promise<void> {
    for (;;) {
      await new Promise<void>((r) => setImmediate(r));
      if (!this.bg.size) return;
      await Promise.allSettled([...this.bg]);
    }
  }

  // ---------- MCP tools ----------

  private proposePlan(T: string, args: Record<string, unknown>): ToolResult {
    const t = this.deps.tickets.getTicket(T);
    if (!t || t.status !== 'planning') return fail('Chỉ đề xuất kế hoạch khi ticket đang lập kế hoạch');
    const v = validatePlan(args.plan, this.settings);
    if (!v.ok) return fail(v.errors.join('\n'));
    this.move(T, 'plan_proposed', { plan: v.plan });
    this.log(T, 'Controller đề xuất kế hoạch');
    return ok('Đã gửi kế hoạch. Người dùng đang duyệt. Hãy kết thúc lượt ngay bây giờ.');
  }

  private spawnAgent(T: string, args: Record<string, unknown>): ToolResult {
    const t = this.deps.tickets.getTicket(T);
    if (!t || t.status !== 'running' || !t.worktree || !t.plan) return fail(NOT_APPROVED);
    const role = args.role as WorkRole;
    if (!WORK_ROLES.includes(role)) return fail('role phải là dev, designer hoặc qc');
    const task = isStr(args.task) ? args.task.trim() : '';
    if (!task) return fail('task không được rỗng');
    if (!Array.isArray(args.files) || !args.files.every(isStr)) return fail('files phải là mảng chuỗi');
    const files = args.files as string[];
    if (args.agent !== undefined && !AGENTS.includes(args.agent as AgentKind)) return fail('agent phải là claude hoặc codex');
    if (args.effort !== undefined && !EFFORTS.includes(args.effort as string)) return fail('effort phải là low, medium, high, xhigh hoặc max');
    if (args.model !== undefined && !isStr(args.model)) return fail('model phải là chuỗi');

    const own: Partial<RoleSpec> = {
      agent: args.agent as AgentKind | undefined,
      model: args.model === '' ? undefined : (args.model as string | undefined),
      effort: args.effort as RoleSpec['effort'] | undefined,
    };
    const layers: (Partial<RoleSpec> | undefined)[] = [own, t.plan.roles[role], t.overrides[role], this.settings.roleDefaults[role]];
    const pick = <K extends keyof RoleSpec>(k: K): RoleSpec[K] => layers.map((l) => l?.[k]).find((v) => v !== undefined && v !== null) as RoleSpec[K];
    const agent = pick('agent');
    const model = pick('model');
    const effort = pick('effort');
    if (!this.deps.runners[agent]) return fail(NO_CLI[agent]);
    if (!(agent === 'codex' && model === '') && !(this.settings.allowedModels[agent] ?? []).includes(model)) {
      return fail(`Model "${model}" không nằm trong danh sách cho phép của ${agent}`);
    }
    const mine = this.deps.tickets.listManaged(T);
    if (role === 'dev') {
      const clash = mine.find((m) => m.role === 'dev' && LIVE.includes(m.state) && filesOverlap(m.files, files));
      if (clash) return fail(`Trùng file với ${clash.agentId} đang chạy; hãy chờ nó xong hoặc chia lại file`);
    }

    const ordinal = mine.filter((m) => m.role === role).length + 1;
    const id = `acctv:${T}:${role}-${ordinal}`;
    const now = this.now();
    const m: ManagedAgent = {
      agentId: id, ticketId: T, role, ordinal, packageId: isStr(args.packageId) && args.packageId ? args.packageId : null,
      task, files, runner: agent, model, effort, sessionId: this.newSessionId(), state: 'queued', stopReason: null,
      resultText: null, changedFiles: [], costUsd: null, createdAt: now, endedAt: null,
    };
    this.putManaged(m);
    this.emitAgent({
      id, source: agent, sessionId: m.sessionId, label: `${ROLE_LABEL[role]}-${ordinal}`, role, parentId: controllerId(T),
      model, effort, cwd: t.worktree, status: 'queued', startedAt: now, lastEventAt: now,
    });
    this.log(T, `Controller giao ${id} (${role}, ${model}/${effort})`);
    this.queue.push(id);
    this.pump();
    return ok(`Đã tạo ${id} (${role}, ${model}/${effort}). Dùng wait_agents để chờ.`);
  }

  private waitAgents(T: string, args: Record<string, unknown>): ToolResult {
    const t = this.deps.tickets.getTicket(T);
    if (!t) return fail(`Không tìm thấy ticket ${T}`);
    const raw = args.ids;
    if (!Array.isArray(raw) || !raw.length || !raw.every(isStr)) return fail('ids phải là mảng id agent, không rỗng');
    const ids = [...new Set(raw as string[])];
    const ms: ManagedAgent[] = [];
    for (const id of ids) {
      const m = this.deps.tickets.getManaged(id);
      if (!m || m.ticketId !== T || m.role === 'controller') return fail(`Không có agent ${id} trong ticket ${T}`);
      ms.push(m);
    }
    const pending = ms.filter((m) => !isTerminal(m.state)).length;
    if (!pending) return ok(JSON.stringify(ids.map((id) => this.report(id))));
    this.save(T, { pendingWait: ids });
    return ok(`Đang chờ ${pending} agent. Hãy kết thúc lượt ngay; bạn sẽ được gọi lại kèm báo cáo.`);
  }

  private getAgentLog(T: string, args: Record<string, unknown>): ToolResult {
    const id = args.id;
    const m = isStr(id) ? this.deps.tickets.getManaged(id) : undefined;
    if (!m || m.ticketId !== T) return fail(`Không có agent ${String(id)} trong ticket ${T}`);
    const limit = Number.isInteger(args.limit) ? Math.min(200, Math.max(1, args.limit as number)) : 50;
    return ok(agentLog(this.deps.store.listCalls(m.agentId), limit));
  }

  private async finish(T: string, args: Record<string, unknown>): Promise<ToolResult> {
    const t = this.deps.tickets.getTicket(T);
    if (!t || t.status !== 'running') return fail('Chỉ kết thúc khi ticket đang chạy');
    const status = args.status;
    if (status !== 'done' && status !== 'escalated') return fail('status phải là done hoặc escalated');
    const report = isStr(args.report) ? args.report : '';
    if (!report.trim()) return fail('report không được rỗng');
    // chuyển trạng thái trước khi await để lượt chờ agent không đánh thức Controller nữa
    this.move(T, status === 'done' ? 'finish_done' : 'finish_escalated', { report, pendingWait: null });
    this.ctrl(T).queue.length = 0;
    this.log(T, `Controller kết thúc ticket (${status})`);
    if (t.worktree) await this.snapshot(T, t.worktree, `acctv: ${T} kết thúc`, 'Snapshot cuối');
    if (t.baseRef && t.branch) {
      try {
        this.save(T, { diffStat: await this.deps.git.diffStat(t.dir, t.baseRef, t.branch) });
      } catch (e) {
        this.log(T, `Lỗi tính diff: ${errMsg(e)}`);
      }
    }
    return ok(`Đã kết thúc ticket (${status}). Kết thúc lượt.`);
  }

  // ---------- Controller ----------

  private ctrl(T: string): CtrlState {
    let s = this.ctrls.get(T);
    if (!s) this.ctrls.set(T, (s = { handle: null, message: null, queue: [], nudges: 0, waking: false }));
    return s;
  }

  /** Mỗi ticket chỉ một lượt Controller tại một thời điểm; gọi khi đang có lượt thì message xếp hàng. */
  private runControllerTurn(T: string, message: string): void {
    const st = this.ctrl(T);
    if (st.handle) st.queue.push(message);
    else this.startControllerTurn(T, message);
  }

  private startControllerTurn(T: string, message: string): void {
    const t = this.mustTicket(T);
    const st = this.ctrl(T);
    const id = controllerId(T);
    const m = this.deps.tickets.getManaged(id)!;
    const now = this.now();
    const resume = this.deps.store.getMeta(startedKey(T)) === '1';
    const firstSeen = !this.deps.store.getAgent(id);
    const port = this.deps.port();
    const token = newToken();
    const mcpToken = newToken();
    this.mcpTokens.set(T, mcpToken);
    this.guards.set(id, { token, policy: this.policy('controller', t.dir, t.worktree ? [t.worktree] : [], []) });
    this.closeWaits(id);
    this.saveManaged(id, { state: 'running', endedAt: null });
    // watcher bỏ qua transcript của agent acctv: chỉ khi đã thấy session này lúc phát hiện file → ingest trước khi chạy
    this.emitAgent({
      id, source: 'claude', sessionId: t.controllerSessionId, label: 'Controller', role: 'controller', parentId: null,
      model: m.model, effort: m.effort, cwd: t.dir, status: 'running', lastEventAt: now, ...(firstSeen ? { startedAt: now } : {}),
    });
    const spec: RunSpec = {
      agentId: id, ticketId: T, role: 'controller', agent: 'claude', label: 'Controller', parentId: null, cwd: t.dir,
      model: m.model, effort: m.effort, prompt: message,
      systemPrompt: systemPrompt('controller', { worktree: t.worktree, files: [], denyBash: this.settings.denyBash }),
      sessionId: t.controllerSessionId, resume, tools: [...CTRL_TOOLS], allowedTools: [...CTRL_TOOLS, ...MCP_TOOLS],
      addDirs: t.worktree ? [t.worktree] : [], runDir: this.runDir(id),
      mcp: { url: `http://127.0.0.1:${port}/mcp?ticket=${encodeURIComponent(T)}`, token: mcpToken }, guard: { port, token },
    };
    st.message = message;
    st.handle = this.launch(spec, this.sink(id));
    // tiến trình đã khởi động (có pid) thì session Claude tồn tại: các lượt sau dùng --resume, kể cả sau khi dashboard khởi động lại
    if (st.handle.pid !== null && !resume) this.deps.store.setMeta(startedKey(T), '1');
    this.emitPid(id, spec, st.handle);
    this.onEnd(spec, st.handle, (r) => this.onControllerDone(T, r));
  }

  private async onControllerDone(T: string, r: RunResult): Promise<void> {
    const st = this.ctrl(T);
    const id = controllerId(T);
    st.handle = null;
    st.message = null;
    this.mcpTokens.delete(T);
    this.guards.delete(id);
    const m = this.deps.tickets.getManaged(id);
    if (m && r.costUsd !== null) this.saveManaged(id, { costUsd: (m.costUsd ?? 0) + r.costUsd });
    // Task 11: nhánh rate limit và lỗi tiến trình

    const t = this.mustTicket(T);
    if (ENDED_TICKET.includes(t.status)) {
      st.nudges = 0;
      st.queue.length = 0;
      this.endController(T);
      return;
    }
    const next = st.queue.shift();
    // đang duyệt: ticket đã running nhưng approve() còn chờ tạo worktree → chờ như đang chờ duyệt
    const approving = t.status === 'running' && !t.worktree;
    if (next !== undefined) {
      st.nudges = 0;
      this.startControllerTurn(T, next);
    } else if (t.pendingWait && this.allEnded(t.pendingWait)) {
      st.nudges = 0;
      await this.checkWait(T);
    } else if (t.status === 'awaiting_approval' || approving || t.pendingWait || st.waking) {
      st.nudges = 0;
      this.ctrlWaiting(T, t.status === 'awaiting_approval' || approving ? 'approval' : 'agents');
    } else if (st.nudges < 2) {
      st.nudges++;
      this.log(T, `Controller dừng mà không gọi tool chờ hay finish; nhắc lần ${st.nudges}`);
      this.startControllerTurn(T, turn.nudge());
    } else {
      st.nudges = 0;
      this.move(T, 'finish_escalated', { report: 'Controller dừng mà không kết luận' });
      this.log(T, 'Controller dừng 3 lượt liên tiếp mà không kết luận → escalated');
      this.endController(T);
    }
  }

  private ctrlWaiting(T: string, kind: WaitSpan['kind']): void {
    const id = controllerId(T);
    const t = this.mustTicket(T);
    this.saveManaged(id, { state: 'waiting' });
    this.emitAgent({ id, source: 'claude', sessionId: t.controllerSessionId, status: 'idle' });
    this.closeWaits(id);
    const w: WaitSpan = { id: randomUUID(), agentId: id, kind, startedAt: this.now(), endedAt: null };
    this.deps.tickets.openWait(w);
    this.deps.hub.publish({ type: 'wait', wait: w });
  }

  private endController(T: string): void {
    const id = controllerId(T);
    const t = this.mustTicket(T);
    this.closeWaits(id);
    this.saveManaged(id, { state: 'done', endedAt: this.now() });
    this.emitAgent({ id, source: 'claude', sessionId: t.controllerSessionId, status: 'ended' });
  }

  // ---------- Workers & queue ----------

  /** FIFO toàn hệ thống; số worker đang chạy (kể cả limited) < maxParallel. */
  private pump(): void {
    while (this.queue.length && this.workers.size < this.settings.maxParallel) this.startWorker(this.queue.shift()!);
  }

  private startWorker(id: string): void {
    const m = this.deps.tickets.getManaged(id);
    const t = m && this.deps.tickets.getTicket(m.ticketId);
    if (!m || !t || m.state !== 'queued') return;
    if (t.status !== 'running' || !t.worktree || !t.plan) {
      this.saveManaged(id, { state: 'stopped', stopReason: 'ticket không còn chạy', endedAt: this.now() });
      this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'ended' });
      this.log(m.ticketId, `${id} không chạy: ticket không còn chạy`);
      return;
    }
    const role = m.role as WorkRole;
    const wt = t.worktree;
    const port = this.deps.port();
    const token = newToken();
    this.guards.set(id, { token, policy: this.policy(role, wt, [], m.files) });
    const spec: RunSpec = {
      agentId: id, ticketId: t.id, role, agent: m.runner, label: `${ROLE_LABEL[role]}-${m.ordinal}`, parentId: controllerId(t.id),
      cwd: wt, model: m.model, effort: m.effort, prompt: workerPrompt(m, t.plan, wt),
      systemPrompt: systemPrompt(role, { worktree: wt, files: m.files, denyBash: this.settings.denyBash }),
      sessionId: m.sessionId, resume: false, tools: [...WORKER_TOOLS[role]], allowedTools: [...WORKER_TOOLS[role]],
      addDirs: [], runDir: this.runDir(id), mcp: null, guard: { port, token },
    };
    this.saveManaged(id, { state: 'running' });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'running', lastEventAt: this.now() });
    const handle = this.launch(spec, this.sink(id));
    this.workers.set(id, { handle, spec });
    this.emitPid(id, spec, handle);
    this.onEnd(spec, handle, (r) => this.onWorkerDone(id, r));
  }

  /** Đường kết thúc duy nhất của worker. */
  private async onWorkerDone(id: string, r: RunResult): Promise<void> {
    const run = this.workers.get(id);
    this.workers.delete(id);
    this.guards.delete(id);
    const m = this.deps.tickets.getManaged(id);
    if (!m) return;
    const state: ManagedState = isTerminal(m.state) ? m.state : r.isError ? 'failed' : 'done';
    this.saveManaged(id, {
      state, resultText: r.text, changedFiles: relFiles(run?.spec.cwd ?? '', r.changedFiles), costUsd: r.costUsd, endedAt: this.now(),
    });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'ended' });
    this.log(m.ticketId, `${id} ${state === 'done' ? 'xong' : state === 'failed' ? 'thất bại' : state}`);
    this.pump();
    await this.checkWait(m.ticketId);
  }

  /** pendingWait xong hết → tăng vòng (nếu có dev), snapshot, đánh thức Controller với báo cáo. */
  private async checkWait(T: string): Promise<void> {
    const t = this.deps.tickets.getTicket(T);
    if (!t || t.status !== 'running' || !t.pendingWait || !this.allEnded(t.pendingWait)) return;
    const ids = t.pendingWait;
    const hasDev = ids.some((id) => this.deps.tickets.getManaged(id)?.role === 'dev');
    const round = hasDev ? t.round + 1 : t.round;
    this.save(T, { pendingWait: null, round });
    const st = this.ctrl(T);
    st.waking = true;
    try {
      if (hasDev && t.worktree) await this.snapshot(T, t.worktree, `acctv: ${T} vòng ${round}`, `Snapshot vòng ${round}`);
    } finally {
      st.waking = false;
    }
    const cur = this.mustTicket(T);
    if (cur.status !== 'running') return;
    this.runControllerTurn(T, turn.agentsDone(ids.map((id) => this.report(id)), round, cur.maxRounds));
  }

  private allEnded(ids: string[]): boolean {
    return ids.every((id) => {
      const m = this.deps.tickets.getManaged(id);
      return !m || isTerminal(m.state);
    });
  }

  private async snapshot(T: string, wt: string, message: string, label: string): Promise<void> {
    try {
      const sha = await this.deps.git.snapshotCommit(wt, message);
      this.log(T, sha ? `${label}: ${sha.slice(0, 7)}` : `${label}: không có thay đổi`);
    } catch (e) {
      this.log(T, `${label} lỗi: ${errMsg(e)}`);
    }
  }

  private report(id: string) {
    const m = this.deps.tickets.getManaged(id)!;
    return agentReport(m, this.deps.store.getAgent(id), this.deps.store.listCalls(id), this.now());
  }

  // ---------- Runs ----------

  private launch(spec: RunSpec, sink: RunSink): RunHandle {
    const runner = this.deps.runners[spec.agent];
    if (!runner) return failedHandle(spec, NO_CLI[spec.agent]);
    try {
      return runner(spec, sink);
    } catch (e) {
      return failedHandle(spec, errMsg(e));
    }
  }

  private onEnd(spec: RunSpec, h: RunHandle, fn: (r: RunResult) => Promise<void>): void {
    h.done.then(
      (r) => this.track(fn(r)),
      (e) => this.track(fn({ exitCode: null, killed: false, isError: true, text: errMsg(e), costUsd: null, rateLimited: false, sessionId: spec.sessionId, changedFiles: [] })),
    );
  }

  private sink(agentId: string): RunSink {
    return {
      events: (evs) => {
        try {
          this.deps.ingest(evs);
        } catch (e) {
          console.warn(`[acctv] ingest ${agentId} lỗi: ${errMsg(e)}`);
        }
      },
      limited: () => {}, // Task 11
    };
  }

  private emitPid(id: string, spec: RunSpec, h: RunHandle): void {
    if (h.pid !== null) this.emitAgent({ id, source: spec.agent, sessionId: spec.sessionId, pid: h.pid });
  }

  private policy(role: Role, root: string, readRoots: string[], allowedFiles: string[]): GuardPolicy {
    const compile = (xs: string[]): RegExp[] => xs.flatMap((s) => {
      try {
        return [new RegExp(s, 'i')];
      } catch {
        return [];
      }
    });
    return { role, root, readRoots, allowedFiles, denyBash: compile(this.settings.denyBash), checkCommands: compile(this.settings.checkCommands) };
  }

  private runDir(agentId: string): string {
    const [, T, slot] = agentId.split(':');
    return path.join(this.deps.cfg.home, 'runs', T, slot);
  }

  private track(p: Promise<void>): void {
    const q: Promise<void> = p
      .catch((e) => console.warn(`[acctv] orchestrator: ${errMsg(e)}`))
      .finally(() => this.bg.delete(q));
    this.bg.add(q);
  }

  // ---------- Persistence ----------

  private mustTicket(id: string): Ticket {
    const t = this.deps.tickets.getTicket(id);
    if (!t) throw new OrchestratorError(404, `Không tìm thấy ticket ${id}`);
    return t;
  }

  private roleSpec(t: Ticket, role: Role): RoleSpec {
    const o = t.overrides[role] ?? {};
    const d = this.settings.roleDefaults[role];
    return { agent: o.agent ?? d.agent, model: o.model ?? d.model, effort: o.effort ?? d.effort };
  }

  private save(id: string, patch: Partial<Ticket>): Ticket {
    const t = this.deps.tickets.updateTicket(id, patch);
    this.deps.hub.publish({ type: 'ticket', ticket: t });
    return t;
  }

  private move(id: string, ev: TicketEvent, patch: Partial<Ticket> = {}): Ticket {
    const t = this.mustTicket(id);
    const to = transition(t.status, ev);
    if (!to) throw new OrchestratorError(409, `Không thể ${ev} khi ticket đang ${t.status}`);
    return this.save(id, { ...patch, status: to });
  }

  private putManaged(m: ManagedAgent): void {
    this.deps.tickets.upsertManaged(m);
    this.deps.hub.publish({ type: 'managed', managed: m });
  }

  private saveManaged(id: string, patch: Partial<ManagedAgent>): ManagedAgent {
    const m = this.deps.tickets.updateManaged(id, patch);
    this.deps.hub.publish({ type: 'managed', managed: m });
    return m;
  }

  private emitAgent(agent: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'source' | 'sessionId'>): void {
    this.deps.ingest([{ type: 'agent', agent }]);
  }

  private closeWaits(agentId: string): void {
    const at = this.now();
    for (const w of this.deps.tickets.listWaits(Number.MAX_SAFE_INTEGER)) {
      if (w.agentId !== agentId || w.endedAt !== null) continue;
      const closed = this.deps.tickets.closeWait(w.id, at);
      if (closed) this.deps.hub.publish({ type: 'wait', wait: closed });
    }
  }

  private log(T: string, text: string): void {
    this.deps.tickets.log(T, text);
  }
}
