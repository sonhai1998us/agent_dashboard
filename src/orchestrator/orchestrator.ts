import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { Config, Settings } from '@/src/core/config';
import type { Store } from '@/src/core/store';
import type { Hub } from '@/src/core/hub';
import { isManagedId, type AgentInfo, type Alert, type NormalizedEvent } from '@/src/core/model';
import type { TicketStore } from '@/src/tickets/store';
import { TERMINAL_STATES, type UserAction, type AgentKind, type ManagedAgent, type ManagedState, type Plan, type Role, type RoleSpec, type Ticket, type TicketStatus, type WaitSpan, type WorkRole } from '@/src/tickets/model';
import { branchName, filesOverlap, transition, validatePlan, type TicketEvent } from '@/src/tickets/flow';
import { checkTool, matchEntry, USER_ACTION_TOOL, type GuardPolicy } from '@/src/guard/policy';
import { inside } from '@/src/core/paths';
import type { Runner, RunHandle, RunResult, RunSink, RunSpec } from '@/src/runner/types';
import { USER_ACTION_LIMITS, type ToolImpl, type ToolResult } from './mcp';
import { listPreview, systemPrompt, turn, workerPrompt } from './prompts';
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

type Timer = ReturnType<typeof setTimeout>;
/** `timer`: đang chờ thử lại sau rate limit (lượt vẫn được coi là đang chạy). */
interface CtrlState { handle: RunHandle | null; message: string | null; queue: string[]; nudges: number; waking: boolean; retries: number; timer: Timer | null }
/** Giữ slot suốt các lần thử lại sau rate limit; `cost` và `files` cộng dồn qua các lần chạy (--resume không báo lại file cũ). */
interface WorkerRun {
  handle: RunHandle; spec: RunSpec; retries: number; timer: Timer | null; cost: number | null; files: string[]; last: RunResult | null;
  /** tiến trình đã thoát sau request_user_action; chờ người dùng trả lời */
  waitingUser: boolean;
  /** người dùng đã trả lời: lời nhắn để chạy tiếp agent (khi tiến trình thoát, hoặc ngay nếu đã thoát) */
  resumePrompt: string | null;
}

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
/** worker còn sống, kể cả đang chờ người dùng (Controller cũng dùng `waiting` nhưng theo nghĩa khác) */
const WORKER_LIVE: ManagedState[] = [...LIVE, 'waiting'];
const isWorkerLive = (m: ManagedAgent): boolean => m.role !== 'controller' && WORKER_LIVE.includes(m.state);
const ENDED_TICKET: TicketStatus[] = ['done', 'escalated', 'cancelled'];
const NOT_APPROVED = 'Kế hoạch chưa được duyệt; chưa được khởi chạy agent';
const NO_CLI: Record<AgentKind, string> = { claude: 'Không tìm thấy Claude CLI', codex: 'Codex CLI chưa được cài trên máy' };
const RATE_LIMIT_MS = [60000, 120000, 300000];
const RESUME_PROMPT = 'Tiếp tục công việc đang dở.';
const LIMIT_EXHAUSTED = 'bị giới hạn: hết lượt thử';
const CANCELLED = 'ticket bị huỷ';
const INTERRUPTED = 'bị gián đoạn: dashboard khởi động lại';
const SHUTDOWN = 'bị gián đoạn: dashboard tắt';
const LOOP_STOP = 'auto-stop: loop';
const ESCALATED = 'ticket chuyển sang cần người dùng quyết';

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
  private alerted = new Set<string>();
  private removing = new Set<string>();
  private recovered = false;
  /** Sau shutdown(): handler thoát, hẹn giờ và sink không còn chạm vào store. */
  private closed = false;
  private now: () => number;
  private newSessionId: () => string;

  constructor(private deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  private get settings(): Settings {
    return this.deps.cfg.settings;
  }

  private get delays(): number[] {
    return this.deps.delays?.rateLimitMs ?? RATE_LIMIT_MS;
  }

  // ---------- API ----------

  async createTicket(input: { title: string; description: string; dir: string; overrides?: Ticket['overrides'] }): Promise<Ticket> {
    const dir = path.resolve(input.dir);
    const { home, claudeDir, codexDir } = this.deps.cfg;
    if ([home, claudeDir, codexDir].some((r) => inside(dir, r))) throw new OrchestratorError(400, 'Không được tạo ticket trong thư mục của dashboard, Claude hoặc Codex');
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
      stopReason: null, resultText: null, changedFiles: [], costUsd: null, createdAt: now, endedAt: null, userAction: null,
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
    const wt = this.deps.git.worktreePath(this.deps.cfg.home, t.dir, ticketId);
    let branch: string;
    let baseRef: string;
    try {
      // ACCTV_HOME mới đánh số ticket lại từ T-1: nhánh cũ cùng tên còn trong repo → thêm hậu tố
      branch = await this.deps.git.uniqueBranch(t.dir, branchName(ticketId, t.title));
      ({ baseRef } = await this.deps.git.createWorktree(t.dir, branch, wt));
    } catch (e) {
      // bị huỷ trong lúc chờ thì giữ cancelled
      if (this.mustTicket(ticketId).status === 'running') this.save(ticketId, { status: 'awaiting_approval', plan: t.plan });
      this.log(ticketId, `Không tạo được worktree: ${errMsg(e)}`);
      throw new OrchestratorError(400, `Không tạo được worktree: ${errMsg(e)}`);
    }
    this.save(ticketId, { branch, worktree: wt, baseRef });
    if (this.mustTicket(ticketId).status !== 'running') {
      this.log(ticketId, `Đã tạo worktree nhưng ticket không còn chạy; nhánh ${branch}`);
      return this.mustTicket(ticketId);
    }
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

  async stopAgent(agentId: string, reason: string): Promise<void> {
    const m = this.deps.tickets.getManaged(agentId);
    if (!m) throw new OrchestratorError(404, `Không tìm thấy agent ${agentId}`);
    if (m.role === 'controller') throw new OrchestratorError(409, 'Controller: dùng Huỷ ticket');
    if (!isWorkerLive(m)) throw new OrchestratorError(409, `Agent ${agentId} đã kết thúc`);
    await this.stopWorker(m, reason);
  }

  async cancel(ticketId: string): Promise<Ticket> {
    this.move(ticketId, 'cancel', { pendingWait: null });
    this.ctrl(ticketId).queue.length = 0;
    this.log(ticketId, 'Người dùng huỷ ticket');
    await Promise.all([this.stopLiveWorkers(ticketId, CANCELLED), this.stopController(ticketId, CANCELLED)]);
    return this.mustTicket(ticketId);
  }

  async continueTicket(ticketId: string, guidance: string): Promise<Ticket> {
    const t = this.mustTicket(ticketId);
    if (t.status !== 'escalated') throw new OrchestratorError(409, 'Chỉ tiếp tục được ticket đang escalated');
    const text = isStr(guidance) ? guidance.trim() : '';
    if (!text) throw new OrchestratorError(400, 'Chỉ đạo không được rỗng');
    if ((!t.worktree && t.branch) || this.removing.has(ticketId)) throw new OrchestratorError(409, 'Worktree đã bị xoá; không thể tiếp tục ticket');
    const maxRounds = t.maxRounds + 1;
    // chưa có worktree = kế hoạch chưa từng được duyệt → quay lại lập kế hoạch
    this.move(ticketId, t.worktree ? 'continue' : 'continue_planning', { maxRounds });
    const st = this.ctrl(ticketId);
    st.nudges = 0;
    st.retries = 0;
    this.closeWaits(controllerId(ticketId));
    this.log(ticketId, `Người dùng cho tiếp tục (tối đa ${maxRounds} vòng)`);
    this.runControllerTurn(ticketId, turn.continued(text, maxRounds));
    return this.mustTicket(ticketId);
  }

  async removeWorktree(ticketId: string): Promise<Ticket> {
    const t = this.mustTicket(ticketId);
    if (!ENDED_TICKET.includes(t.status)) throw new OrchestratorError(409, 'Chỉ xoá worktree khi ticket đã xong, escalated hoặc đã huỷ');
    const wt = t.worktree;
    if (!wt || this.removing.has(ticketId)) throw new OrchestratorError(409, 'Ticket không có worktree');
    if (this.liveWorkers(ticketId).length) throw new OrchestratorError(409, 'Còn agent đang chạy trong worktree');
    this.removing.add(ticketId);
    try {
      // remove --force bỏ file chưa commit → snapshot lên nhánh trước; snapshot lỗi mà còn thay đổi thì không xoá
      if (!(await this.snapshot(ticketId, wt, `acctv: ${ticketId} trước khi xoá worktree`, 'Snapshot trước khi xoá worktree'))) {
        const dirty = await this.deps.git.gitInfo(wt).then((i) => i.dirty, () => true);
        if (dirty) throw new OrchestratorError(409, 'Không commit được snapshot; worktree còn thay đổi chưa lưu. Xử lý rồi thử lại, hoặc xoá thủ công.');
      }
      try {
        await this.deps.git.removeWorktree(t.dir, wt);
      } catch (e) {
        this.log(ticketId, `Không xoá được worktree: ${errMsg(e)}`);
        throw new OrchestratorError(400, `Không xoá được worktree: ${errMsg(e)}`);
      }
    } finally {
      this.removing.delete(ticketId);
    }
    this.log(ticketId, `Đã xoá worktree ${wt}; nhánh ${t.branch} giữ nguyên`);
    return this.save(ticketId, { worktree: null });
  }

  /** Gọi một lần khi server khởi động: agent đang chạy dở → interrupted, rồi gọi lại Controller nơi cần. */
  async recover(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    const at = this.now();
    for (const m of this.deps.tickets.listManaged()) {
      if (!LIVE.includes(m.state) && !isWorkerLive(m)) continue;
      this.saveManaged(m.agentId, { state: 'interrupted', stopReason: INTERRUPTED, endedAt: at, userAction: null });
      this.emitAgent({ id: m.agentId, source: m.runner, sessionId: m.sessionId, status: 'ended' });
      this.log(m.ticketId, `${m.agentId} ${INTERRUPTED}`);
    }
    for (const t of this.deps.tickets.listTickets()) {
      if (t.status === 'planning') this.restartTurn(t.id);
      else if (t.status !== 'running') continue;
      else if (!t.worktree) {
        // dừng giữa lúc duyệt (worktree chưa tạo xong) → chờ duyệt lại
        this.save(t.id, { status: 'awaiting_approval' });
        this.log(t.id, 'Dashboard khởi động lại khi đang duyệt; chờ duyệt lại');
        this.ctrlWaiting(t.id, 'approval');
      }
      else if (t.pendingWait) await this.checkWait(t.id);
      // không còn gì để chờ (kể cả Controller waiting khi dừng giữa lúc xoá pendingWait và lượt agentsDone) → gọi lại Controller
      else this.restartTurn(t.id);
    }
  }

  /** Dashboard tắt: huỷ hẹn giờ thử lại, kill mọi tiến trình mình đã spawn, agent đang sống → interrupted. */
  async shutdown(): Promise<void> {
    if (this.closed) return this.idle();
    this.closed = true;
    this.queue.length = 0;
    const handles: RunHandle[] = [];
    for (const st of this.ctrls.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.queue.length = 0;
      if (st.handle) handles.push(st.handle);
      st.handle = null;
    }
    for (const run of this.workers.values()) {
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
      handles.push(run.handle);
    }
    this.workers.clear();
    this.guards.clear();
    this.mcpTokens.clear();
    const at = this.now();
    for (const m of this.deps.tickets.listManaged()) {
      if (!LIVE.includes(m.state) && !isWorkerLive(m)) continue;
      this.saveManaged(m.agentId, { state: 'interrupted', stopReason: SHUTDOWN, endedAt: at, userAction: null });
      this.emitAgent({ id: m.agentId, source: m.runner, sessionId: m.sessionId, status: 'ended' });
      this.log(m.ticketId, `${m.agentId} ${SHUTDOWN}`);
    }
    await Promise.allSettled(handles.map((h) => h.kill()));
    await this.idle();
  }

  onAlert(a: Alert): void {
    if (this.closed) return;
    // một vòng lặp mới có `since` mới → Controller được tiếp tục vẫn bị tự dừng lại được
    const key = `${a.agentId}:${a.since}`;
    if (a.kind !== 'loop' || a.level !== 'critical' || !a.active || !isManagedId(a.agentId) || this.alerted.has(key)) return;
    const m = this.deps.tickets.getManaged(a.agentId);
    if (!m) return;
    if (m.role !== 'controller') {
      if (!isWorkerLive(m)) return;
      this.alerted.add(key);
      this.track(this.stopWorker(m, LOOP_STOP));
      return;
    }
    const st = this.ctrl(m.ticketId);
    if (!st.handle && !st.timer) return;
    this.alerted.add(key);
    this.track(this.autoStopController(m.ticketId));
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

  /** MCP của worker: chỉ request_user_action. */
  workerMcpTools(agentId: string): Record<string, ToolImpl> {
    return { request_user_action: async (a) => this.requestUserAction(agentId, a) };
  }

  /** Worker dùng token guard của chính nó cho MCP. */
  checkWorkerMcpToken(agentId: string, token: string): boolean {
    const m = this.deps.tickets.getManaged(agentId);
    return !!m && m.role !== 'controller' && this.checkGuardToken(agentId, token);
  }

  /** Người dùng trả lời yêu cầu của agent: chạy tiếp agent trong cùng phiên. */
  async answerUserAction(agentId: string, a: { done: boolean; note?: string }): Promise<ManagedAgent> {
    const m = this.deps.tickets.getManaged(agentId);
    if (!m) throw new OrchestratorError(404, `Không tìm thấy agent ${agentId}`);
    const run = this.workers.get(agentId);
    if (!m.userAction || !run || !isWorkerLive(m)) throw new OrchestratorError(409, `Agent ${agentId} không có yêu cầu nào đang chờ`);
    const ua = m.userAction;
    const note = (a.note ?? '').trim().slice(0, USER_ACTION_LIMITS.message);
    const extra = note ? ` Ghi chú của người dùng: ${note}` : '';
    const prompt = a.done
      ? `Người dùng đã làm xong: ${ua.title}.${extra} Hãy kiểm tra lại (vd. lệnh whoami/status) rồi làm tiếp gói việc từ chỗ dừng.`
      : `Người dùng không làm được: ${ua.title}.${extra} Hãy hoàn tất phần làm được mà không cần việc này, rồi báo cáo rõ phần còn thiếu.`;
    this.log(m.ticketId, `${a.done ? 'Người dùng đã làm' : 'Người dùng không làm được'}: ${ua.title} (${agentId})`);
    const next = this.saveManaged(agentId, { userAction: null });
    run.resumePrompt = prompt;
    if (run.waitingUser) await this.resumeWorker(agentId);
    return this.deps.tickets.getManaged(agentId) ?? next;
  }

  /** Chỉ kiểm token guard của agent (không quyết định, không tác dụng phụ). */
  checkGuardToken(agentId: string, token: string): boolean {
    const g = this.guards.get(agentId);
    return !!g && safeEq(g.token, token);
  }

  checkMcpToken(ticketId: string, token: string): boolean {
    const cur = this.mcpTokens.get(ticketId);
    return !!cur && safeEq(cur, token);
  }

  /** `decide`: hook trả "allow" tường minh (Controller dùng mọi tool như người dùng, kể cả tool MCP không có trong --allowedTools). */
  guard(agentId: string, token: string, hookInput: unknown): { allow: true; decide?: true } | { allow: false; reason: string } | null {
    const g = this.guards.get(agentId);
    if (!g || !safeEq(g.token, token)) return null;
    const h = hookInput && typeof hookInput === 'object' ? (hookInput as Record<string, unknown>) : {};
    const name = isStr(h.tool_name) ? h.tool_name : '';
    const d = checkTool(g.policy, name, h.tool_input, isStr(h.cwd) ? h.cwd : g.policy.root);
    if (!d.allow) return { allow: false, reason: d.reason };
    return g.policy.role === 'controller' ? { allow: true, decide: true } : { allow: true };
  }

  async idle(): Promise<void> {
    for (;;) {
      await new Promise<void>((r) => setImmediate(r));
      if (!this.bg.size) return;
      await Promise.allSettled([...this.bg]);
    }
  }

  // ---------- MCP tools ----------

  private requestUserAction(id: string, args: Record<string, unknown>): ToolResult {
    const m = this.deps.tickets.getManaged(id);
    const run = this.workers.get(id);
    if (!m || m.role === 'controller' || !run || run.waitingUser || !['running', 'limited'].includes(m.state)) return fail('Agent không còn chạy');
    if (m.userAction) return fail('Đã có một yêu cầu đang chờ người dùng; hãy kết thúc lượt và chờ được gọi lại');
    const L = USER_ACTION_LIMITS;
    const str = (k: string): string | null => {
      const v = args[k];
      return isStr(v) && v.trim() ? v.trim() : null;
    };
    const title = str('title');
    const message = str('message');
    const url = str('url');
    const command = str('command');
    if (!title || title.length > L.title) return fail(`title bắt buộc, tối đa ${L.title} ký tự`);
    if (!message || message.length > L.message) return fail(`message bắt buộc, tối đa ${L.message} ký tự`);
    if (url !== null) {
      let good = false;
      try { good = url.length <= L.url && ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* không phải URL */ }
      if (!good) return fail('url phải là link http(s) hợp lệ');
    }
    if (command !== null && command.length > L.command) return fail(`command tối đa ${L.command} ký tự`);
    const ua: UserAction = { id: randomUUID(), title, message, url, command, createdAt: this.now() };
    this.saveManaged(id, { userAction: ua });
    this.log(m.ticketId, `${run.spec.label} cần bạn: ${title}`);
    return ok('Đã gửi yêu cầu cho người dùng. Hãy kết thúc lượt ngay bây giờ: không gọi thêm tool, chỉ viết một câu ngắn. Khi người dùng trả lời, bạn sẽ được gọi lại trong cùng phiên để làm tiếp.');
  }

  private proposePlan(T: string, args: Record<string, unknown>): ToolResult {
    const t = this.deps.tickets.getTicket(T);
    if (!t || t.status !== 'planning') return fail('Chỉ đề xuất kế hoạch khi ticket đang lập kế hoạch');
    const v = validatePlan(args.plan, this.settings);
    if (!v.ok) return fail(v.errors.join('\n'));
    // lựa chọn agent/model/effort của người dùng lúc tạo ticket là bắt buộc: ghi đè lên đề xuất của Controller
    const plan = structuredClone(v.plan);
    const applied: string[] = [];
    for (const role of WORK_ROLES) {
      const o = t.overrides[role];
      if (!o) continue;
      const cur = plan.roles[role];
      const next = { ...cur, ...(o.agent ? { agent: o.agent } : {}), ...(o.model !== undefined ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) };
      if (next.agent !== cur.agent || next.model !== cur.model || next.effort !== cur.effort) applied.push(`${role}: ${next.model || '(mặc định CLI)'}/${next.effort}`);
      plan.roles[role] = next;
    }
    this.move(T, 'plan_proposed', { plan });
    this.log(T, applied.length ? `Controller đề xuất kế hoạch (áp lựa chọn của người dùng: ${applied.join(', ')})` : 'Controller đề xuất kế hoạch');
    const note = applied.length ? ` Đã đổi vai theo lựa chọn của người dùng: ${applied.join(', ')}.` : '';
    return ok(`Đã gửi kế hoạch.${note} Người dùng đang duyệt. Hãy kết thúc lượt ngay bây giờ.`);
  }

  private spawnAgent(T: string, args: Record<string, unknown>): ToolResult {
    const t = this.deps.tickets.getTicket(T);
    if (!t || t.status !== 'running' || !t.worktree || !t.plan) return fail(NOT_APPROVED);
    const role = args.role as WorkRole;
    if (!WORK_ROLES.includes(role)) return fail('role phải là dev, designer hoặc qc');
    if (role === 'dev' && t.round >= t.maxRounds) {
      return fail(`Đã hết ${t.maxRounds} vòng; hãy gọi finish với status "escalated" và nêu lỗi còn lại`);
    }
    const count = t.plan.roles[role]?.count ?? 0;
    if (count <= 0) return fail(`Kế hoạch đã duyệt không có vai ${role}`);
    if (this.liveWorkers(T).filter((m) => m.role === role).length >= count) return fail(`Đã đủ ${count} ${role} theo kế hoạch đã duyệt; hãy chờ wait_agents`);
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
    // kế hoạch đã duyệt (gồm lựa chọn và chỉnh sửa của người dùng) quyết định agent/model/effort; tham số của Controller chỉ dùng khi kế hoạch thiếu
    const layers: (Partial<RoleSpec> | undefined)[] = [t.plan.roles[role], t.overrides[role], own, this.settings.roleDefaults[role]];
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
      resultText: null, changedFiles: [], costUsd: null, createdAt: now, endedAt: null, userAction: null,
    };
    this.putManaged(m);
    this.emitAgent({
      id, source: agent, sessionId: m.sessionId, label: `${ROLE_LABEL[role]}-${ordinal}`, role, parentId: controllerId(T),
      model, effort, cwd: t.worktree, status: 'queued', startedAt: now, lastEventAt: now,
    });
    this.log(T, `Controller giao ${id} (${role}, ${model}/${effort})`);
    this.queue.push(id);
    this.pump();
    const ignored = (own.agent !== undefined && own.agent !== agent) || (own.model !== undefined && own.model !== model) || (own.effort !== undefined && own.effort !== effort);
    const note = ignored ? ' Dùng agent/model/effort theo kế hoạch đã duyệt; tham số bạn truyền khác kế hoạch nên bị bỏ qua.' : '';
    return ok(`Đã tạo ${id} (${role}, ${model}/${effort}).${note} Dùng wait_agents để chờ.`);
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
    if (this.liveWorkers(T).length) return fail('Còn agent đang chạy; hãy wait_agents trước khi finish');
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
    if (!s) this.ctrls.set(T, (s = { handle: null, message: null, queue: [], nudges: 0, waking: false, retries: 0, timer: null }));
    return s;
  }

  /** Mỗi ticket chỉ một lượt Controller tại một thời điểm; gọi khi đang có lượt thì message xếp hàng. */
  private runControllerTurn(T: string, message: string): void {
    if (this.closed) return;
    const st = this.ctrl(T);
    if (st.handle || st.timer) st.queue.push(message);
    else this.startControllerTurn(T, message);
  }

  private restartTurn(T: string): void {
    this.log(T, 'Dashboard khởi động lại; gọi lại Controller');
    this.runControllerTurn(T, turn.restarted());
  }

  /** Kill lượt Controller đang chạy (hoặc bỏ lần thử lại đang chờ); gọi khi ticket đã kết thúc. */
  private async stopController(T: string, reason: string): Promise<void> {
    const st = this.ctrl(T);
    const id = controllerId(T);
    const m = this.deps.tickets.getManaged(id);
    if (!m) return;
    if (!isTerminal(m.state)) this.saveManaged(id, { state: 'stopped', stopReason: reason, endedAt: this.now() });
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
      st.retries = 0;
    }
    // onControllerDone thấy ticket đã kết thúc → endController (giữ state stopped)
    if (st.handle) await st.handle.kill();
    else this.endController(T);
  }

  private async autoStopController(T: string): Promise<void> {
    const t = this.mustTicket(T);
    this.log(T, `Dừng ${controllerId(T)}: ${LOOP_STOP}`);
    if (!transition(t.status, 'finish_escalated')) {
      // awaiting_approval: chỉ kill lượt đang chạy, ticket vẫn chờ duyệt
      const st = this.ctrl(T);
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
        st.retries = 0;
      }
      await st.handle?.kill();
      return;
    }
    await Promise.all([this.escalate(T, `Controller lặp vòng (${LOOP_STOP})`), this.stopController(T, LOOP_STOP)]);
  }

  /** Escalate không qua finish: ticket cần người dùng quyết, dừng mọi worker còn chạy. */
  private async escalate(T: string, report: string): Promise<void> {
    this.move(T, 'finish_escalated', { report, pendingWait: null });
    this.ctrl(T).queue.length = 0;
    await this.stopLiveWorkers(T, ESCALATED);
  }

  private async retryController(T: string, message: string): Promise<void> {
    const st = this.ctrl(T);
    if (this.closed || !st.timer) return;
    st.timer = null;
    const t = this.mustTicket(T);
    if (ENDED_TICKET.includes(t.status)) return this.endController(T);
    this.startControllerTurn(T, message);
  }

  private startControllerTurn(T: string, message: string): void {
    if (this.closed) return;
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
    this.saveManaged(id, { state: 'running', stopReason: null, endedAt: null });
    // watcher bỏ qua transcript của agent acctv: chỉ khi đã thấy session này lúc phát hiện file → ingest trước khi chạy
    this.emitAgent({
      id, source: 'claude', sessionId: t.controllerSessionId, label: 'Controller', role: 'controller', parentId: null,
      model: m.model, effort: m.effort, cwd: t.dir, status: 'running', lastEventAt: now, ...(firstSeen ? { startedAt: now } : {}),
    });
    const spec: RunSpec = {
      agentId: id, ticketId: T, role: 'controller', agent: 'claude', label: 'Controller', parentId: null, cwd: t.dir,
      model: m.model, effort: m.effort, prompt: message,
      systemPrompt: systemPrompt('controller', { worktree: t.worktree, files: [], denyBash: this.settings.denyBash }),
      // quyền như người dùng: mọi tool, MCP server và cấu hình Claude của người dùng; guard chặn commit/push và thư mục được bảo vệ
      sessionId: t.controllerSessionId, resume, tools: [], allowedTools: [...MCP_TOOLS], inheritUser: true,
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
    const message = st.message;
    st.handle = null;
    st.message = null;
    this.mcpTokens.delete(T);
    this.guards.delete(id);
    const m = this.deps.tickets.getManaged(id);
    if (m && r.costUsd !== null) this.saveManaged(id, { costUsd: (m.costUsd ?? 0) + r.costUsd });

    const t = this.mustTicket(T);
    if (ENDED_TICKET.includes(t.status)) {
      st.nudges = 0;
      st.retries = 0;
      st.queue.length = 0;
      this.endController(T);
      return;
    }
    // rate limit: chờ rồi chạy lại cùng message; không tính vào nhắc. Lỗi tiến trình khác đi đường nhắc bên dưới.
    if (r.rateLimited && !r.killed && message !== null && (t.status === 'planning' || (t.status === 'running' && t.worktree))) {
      const ms = this.delays[st.retries];
      if (ms !== undefined) {
        st.retries++;
        this.setLimited(id, true);
        this.log(T, `Controller bị giới hạn; thử lại sau ${Math.round(ms / 1000)}s (lần ${st.retries}/${this.delays.length})`);
        st.timer = setTimeout(() => this.track(this.retryController(T, message)), ms);
        return;
      }
      st.retries = 0;
      this.saveManaged(id, { state: 'failed', stopReason: LIMIT_EXHAUSTED });
      this.log(T, `Controller ${LIMIT_EXHAUSTED} → escalated`);
      this.endController(T);
      await this.escalate(T, `Controller ${LIMIT_EXHAUSTED}`);
      return;
    }
    st.retries = 0;
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
      this.log(T, 'Controller dừng 3 lượt liên tiếp mà không kết luận → escalated');
      this.endController(T);
      await this.escalate(T, 'Controller dừng mà không kết luận');
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
    const m = this.deps.tickets.getManaged(id);
    this.closeWaits(id);
    // giữ stopped/failed do huỷ, tự dừng hay hết lượt thử
    this.saveManaged(id, { state: m && isTerminal(m.state) ? m.state : 'done', endedAt: m?.endedAt ?? this.now() });
    this.emitAgent({ id, source: 'claude', sessionId: t.controllerSessionId, status: 'ended' });
  }

  // ---------- Workers & queue ----------

  /** FIFO toàn hệ thống; số worker đang chạy (kể cả limited) < maxParallel. */
  private pump(): void {
    // worker đang chờ người dùng không giữ slot
    const active = (): number => [...this.workers.values()].filter((r) => !r.waitingUser).length;
    while (!this.closed && this.queue.length && active() < this.settings.maxParallel) this.startWorker(this.queue.shift()!);
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
      sessionId: m.sessionId, resume: false, ...this.workerTools(m.runner, role),
      addDirs: [], runDir: this.runDir(id),
      // claude: MCP riêng của worker (request_user_action), xác thực bằng token guard; codex chưa nối MCP
      mcp: m.runner === 'claude' ? { url: `http://127.0.0.1:${port}/mcp?agent=${encodeURIComponent(id)}`, token } : null,
      guard: { port, token },
    };
    this.saveManaged(id, { state: 'running' });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'running', lastEventAt: this.now() });
    const handle = this.launch(spec, this.sink(id));
    this.workers.set(id, { handle, spec, retries: 0, timer: null, cost: null, files: [], last: null, waitingUser: false, resumePrompt: null });
    this.emitPid(id, spec, handle);
    this.onEnd(spec, handle, (r) => this.onWorkerExit(id, handle, r));
  }

  private workerTools(runner: AgentKind, role: WorkRole): { tools: string[]; allowedTools: string[] } {
    const t = runner === 'claude' ? [...WORKER_TOOLS[role], USER_ACTION_TOOL] : [...WORKER_TOOLS[role]];
    return { tools: t, allowedTools: [...t] };
  }

  /** Chạy tiếp worker sau khi người dùng trả lời request_user_action. */
  private async resumeWorker(id: string): Promise<void> {
    const run = this.workers.get(id);
    if (this.closed || !run || !run.resumePrompt) return;
    const m = this.deps.tickets.getManaged(id);
    const prompt = run.resumePrompt;
    run.resumePrompt = null;
    run.waitingUser = false;
    if (!m || isTerminal(m.state)) return this.onWorkerDone(id, run.last!);
    if (this.deps.tickets.getTicket(m.ticketId)?.status !== 'running') {
      this.saveManaged(id, { state: 'stopped', stopReason: 'ticket không còn chạy' });
      return this.onWorkerDone(id, run.last!);
    }
    const spec: RunSpec = { ...run.spec, resume: true, prompt };
    this.saveManaged(id, { state: 'running' });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'running', lastEventAt: this.now() });
    const handle = this.launch(spec, this.sink(id));
    run.handle = handle;
    run.spec = spec;
    this.emitPid(id, spec, handle);
    this.onEnd(spec, handle, (r) => this.onWorkerExit(id, handle, r));
  }

  /** Mỗi lần tiến trình worker thoát: rate limit → giữ slot, chờ rồi chạy lại; còn lại → onWorkerDone. */
  private async onWorkerExit(id: string, handle: RunHandle, r: RunResult): Promise<void> {
    const run = this.workers.get(id);
    if (!run || run.handle !== handle) return;
    run.last = r;
    if (run.spec.agent === 'codex' && r.sessionId) this.adoptSession(id, r.sessionId);
    if (r.costUsd !== null) run.cost = (run.cost ?? 0) + r.costUsd;
    run.files = [...new Set([...run.files, ...relFiles(run.spec.cwd, r.changedFiles)])];
    const m = this.deps.tickets.getManaged(id);
    // agent đã nhờ người dùng (request_user_action): đã có trả lời → chạy tiếp; chưa → chờ, nhả slot
    if (m && !r.killed && !isTerminal(m.state) && (m.userAction || run.resumePrompt)) {
      if (run.resumePrompt) return this.resumeWorker(id);
      run.waitingUser = true;
      this.saveManaged(id, { state: 'waiting' });
      this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'idle' });
      this.log(m.ticketId, `${run.spec.label} chờ bạn: ${m.userAction!.title}`);
      this.pump();
      return;
    }
    if (m && r.rateLimited && !r.killed && !isTerminal(m.state)) {
      const ms = this.delays[run.retries];
      if (ms !== undefined) {
        run.retries++;
        this.setLimited(id, true);
        this.log(m.ticketId, `${id} bị giới hạn; thử lại sau ${Math.round(ms / 1000)}s (lần ${run.retries}/${this.delays.length})`);
        run.timer = setTimeout(() => this.track(this.retryWorker(id)), ms);
        return;
      }
      this.saveManaged(id, { state: 'failed', stopReason: LIMIT_EXHAUSTED });
    }
    await this.onWorkerDone(id, r);
  }

  private async retryWorker(id: string): Promise<void> {
    const run = this.workers.get(id);
    if (this.closed || !run || !run.timer) return;
    run.timer = null;
    const m = this.deps.tickets.getManaged(id);
    if (!m || isTerminal(m.state)) return this.onWorkerDone(id, run.last!);
    if (this.deps.tickets.getTicket(m.ticketId)?.status !== 'running') {
      this.saveManaged(id, { state: 'stopped', stopReason: 'ticket không còn chạy' });
      this.log(m.ticketId, `${id} không chạy lại: ticket không còn chạy`);
      return this.onWorkerDone(id, run.last!);
    }
    const spec: RunSpec = { ...run.spec, resume: true, prompt: RESUME_PROMPT };
    this.saveManaged(id, { state: 'running' });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'running', lastEventAt: this.now() });
    const handle = this.launch(spec, this.sink(id));
    run.handle = handle;
    run.spec = spec;
    this.emitPid(id, spec, handle);
    this.onEnd(spec, handle, (r) => this.onWorkerExit(id, handle, r));
  }

  /** Dừng worker: bỏ khỏi hàng, kill tiến trình hoặc huỷ lần thử lại; kết thúc theo đường thường. */
  private async stopWorker(m: ManagedAgent, reason: string): Promise<void> {
    const id = m.agentId;
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    const run = this.workers.get(id);
    this.saveManaged(id, { state: 'stopped', stopReason: reason, ...(run ? {} : { endedAt: this.now() }) });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: 'ended' });
    this.log(m.ticketId, `Dừng ${id}: ${reason}`);
    if (!run) return this.checkWait(m.ticketId);
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
      return this.onWorkerDone(id, run.last!);
    }
    if (run.waitingUser) {
      // tiến trình đã thoát; không có gì để kill
      run.waitingUser = false;
      run.resumePrompt = null;
      return this.onWorkerDone(id, run.last!);
    }
    await run.handle.kill();
  }

  /** Worker còn sống: queued/running/limited, hoặc đã dừng nhưng tiến trình chưa thoát hẳn. */
  private liveWorkers(T: string): ManagedAgent[] {
    return this.deps.tickets.listManaged(T).filter((m) => m.role !== 'controller' && (isWorkerLive(m) || this.workers.has(m.agentId)));
  }

  private async stopLiveWorkers(T: string, reason: string): Promise<void> {
    // agent đang xếp hàng ra khỏi hàng trước, để slot được giải phóng không khởi chạy chúng
    const live = this.liveWorkers(T).filter(isWorkerLive).sort((a, b) => Number(b.state === 'queued') - Number(a.state === 'queued'));
    await Promise.all(live.map((m) => this.stopWorker(m, reason)));
  }

  /** Codex tự đặt thread id: dùng nó cho `exec resume <thread_id>` và ghi lại vào managed. */
  private adoptSession(id: string, sessionId: string): void {
    const run = this.workers.get(id);
    if (run && run.spec.sessionId !== sessionId) run.spec = { ...run.spec, sessionId };
    const m = this.deps.tickets.getManaged(id);
    if (m && m.role !== 'controller' && m.sessionId !== sessionId) this.saveManaged(id, { sessionId });
  }

  private setLimited(id: string, on: boolean): void {
    const m = this.deps.tickets.getManaged(id);
    if (!m) return;
    this.saveManaged(id, { state: on ? 'limited' : 'running' });
    this.emitAgent({ id, source: m.runner, sessionId: m.sessionId, status: on ? 'limited' : 'running' });
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
      state, resultText: r.text, changedFiles: run ? run.files : relFiles('', r.changedFiles), costUsd: run ? run.cost : r.costUsd, endedAt: this.now(),
      userAction: null,
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
    let outOfScope: string[] = [];
    try {
      if (t.worktree) outOfScope = await this.auditChanges(T, t.worktree, ids);
      if (hasDev && t.worktree) await this.snapshot(T, t.worktree, `acctv: ${T} vòng ${round}`, `Snapshot vòng ${round}`);
    } finally {
      st.waking = false;
    }
    const cur = this.mustTicket(T);
    if (cur.status !== 'running') return;
    this.runControllerTurn(T, turn.agentsDone(ids.map((id) => this.report(id)), round, cur.maxRounds, outOfScope));
  }

  /**
   * Đối chiếu thay đổi thật trong worktree (git) với phạm vi file của các Dev trong ticket.
   * Guard chỉ chặn được Edit/Write; file ghi bằng Bash chỉ lộ ra ở đây.
   * Ghi file git thấy vào changedFiles của Dev đang chờ (theo phạm vi; một Dev thì nhận hết), trả về file ngoài mọi phạm vi.
   */
  private async auditChanges(T: string, wt: string, ids: string[]): Promise<string[]> {
    let changed: string[];
    try {
      changed = await this.deps.git.worktreeChanges(wt);
    } catch (e) {
      this.log(T, `Không đọc được thay đổi trong worktree: ${errMsg(e)}`);
      return [];
    }
    if (!changed.length) return [];
    const devs = this.deps.tickets.listManaged(T).filter((m) => m.role === 'dev');
    const inScope = (f: string, files: string[]) => files.some((e) => matchEntry(e, f));
    const waited = devs.filter((m) => ids.includes(m.agentId));
    const others = devs.filter((m) => !ids.includes(m.agentId) && (LIVE.includes(m.state) || this.workers.has(m.agentId)));
    for (const m of waited) {
      const mine = waited.length === 1 && !others.length ? changed : changed.filter((f) => inScope(f, m.files));
      const files = [...new Set([...m.changedFiles, ...mine])];
      if (files.length !== m.changedFiles.length) this.saveManaged(m.agentId, { changedFiles: files });
    }
    const out = changed.filter((f) => !devs.some((m) => inScope(f, m.files))).sort();
    if (out.length) this.log(T, `Thay đổi ngoài phạm vi kế hoạch (git): ${listPreview(out)}`);
    return out;
  }

  private allEnded(ids: string[]): boolean {
    return ids.every((id) => {
      const m = this.deps.tickets.getManaged(id);
      return !m || isTerminal(m.state);
    });
  }

  /** false khi commit lỗi (hook, quá thời gian…); lỗi chỉ được ghi log. */
  private async snapshot(T: string, wt: string, message: string, label: string): Promise<boolean> {
    try {
      const sha = await this.deps.git.snapshotCommit(wt, message);
      this.log(T, sha ? `${label}: ${sha.slice(0, 7)}` : `${label}: không có thay đổi`);
      return true;
    } catch (e) {
      this.log(T, `${label} lỗi: ${errMsg(e)}`);
      return false;
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
      (r) => { if (!this.closed) this.track(fn(r)); },
      (e) => { if (!this.closed) this.track(fn({ exitCode: null, killed: false, isError: true, text: errMsg(e), costUsd: null, rateLimited: false, sessionId: spec.sessionId, changedFiles: [] })); },
    );
  }

  private sink(agentId: string): RunSink {
    return {
      events: (evs) => {
        if (this.closed) return;
        try {
          this.deps.ingest(evs);
          for (const e of evs) {
            if (e.type !== 'agent' || e.agent.source !== 'codex' || e.agent.id !== agentId) continue;
            this.deps.store.dropAgent(`codex:${e.agent.sessionId}`);
            this.adoptSession(agentId, e.agent.sessionId);
          }
        } catch (e) {
          console.warn(`[acctv] ingest ${agentId} lỗi: ${errMsg(e)}`);
        }
      },
      limited: (on) => {
        if (this.closed) return;
        const s = this.deps.tickets.getManaged(agentId)?.state;
        if (s === 'running' || s === 'limited') this.setLimited(agentId, on);
      },
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
    const { home, claudeDir, codexDir } = this.deps.cfg;
    return {
      role, root, readRoots, allowedFiles, denyBash: compile(this.settings.denyBash), checkCommands: compile(this.settings.checkCommands),
      ...(role === 'controller' ? { protectedRoots: [home, claudeDir, codexDir] } : {}),
    };
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
