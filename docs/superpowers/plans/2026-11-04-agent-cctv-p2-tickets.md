# Agent CCTV Phần 2 — Ticket, Controller và điều phối agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm phần "văn phòng" vào Agent CCTV: tạo ticket, Controller lập kế hoạch và chờ duyệt, rồi điều phối các tiến trình Dev/Designer/QC trong một git worktree riêng. Mọi bước đều thấy được trên UI và CLI, và dừng được đúng một agent để trả về Controller.

**Architecture:** Mỗi agent là một tiến trình `claude -p --output-format stream-json` do server khởi chạy. Stdout của nó được chuyển thành `NormalizedEvent` bằng chính `parseClaudeLine` của Phần 1, rồi đi qua pipeline cũ: `Store` → `DetectEngine` → `Hub` → WS. Controller chạy theo từng lượt (`--session-id` ở lượt đầu, `--resume` ở các lượt sau). Nó gọi tool qua một MCP endpoint HTTP do chính server phục vụ tại `/mcp`. Quyền theo vai được ép bằng hook `PreToolUse`: một script `.mjs` nhỏ hỏi server qua `/api/guard`. Trạng thái ticket nằm trong SQLite (cùng DB với Phần 1), nên server khởi động lại vẫn tiếp tục được.

**Tech Stack:** Như Phần 1 (Node 22 `node:sqlite`, TypeScript, Next.js 16 App Router qua custom server tsx, React 19, `ws`, vitest). **Không thêm dependency.** MCP được viết tay (JSON-RPC qua HTTP POST). Git chạy bằng `execFile('git', …)`.

**Spec:** `docs/superpowers/specs/2026-11-02-agent-cctv-design.md` (§5, §6, §8, §9, §10). Kế hoạch Phần 1: `docs/superpowers/plans/2026-11-02-agent-cctv-p1-camera.md`.

## Global Constraints

- `~/.claude` và `~/.codex` **chỉ được đọc**. Dashboard chỉ ghi vào `ACCTV_HOME` (mặc định `~/.acctv`), vào worktree và nhánh `acctv/*` của ticket, và chạy `git init` khi người dùng bấm xác nhận.
- Server chỉ bind `127.0.0.1`. Mọi request kiểm Host như Phần 1.
  - POST/PUT phải có `content-type: application/json`, và `Origin` hoặc không có, hoặc là `http://127.0.0.1:<port>` / `http://localhost:<port>`.
  - `/mcp` và `/api/guard` còn đòi thêm token Bearer cấp cho từng lượt chạy, chỉ giữ trong bộ nhớ.
- Không bao giờ `git push`. Không bao giờ dùng `bypassPermissions` hay `--dangerously-skip-permissions`.
- Chỉ kill cây tiến trình mà dashboard tự khởi chạy (theo pid do `spawn` trả về).
- Test tự động **không bao giờ gọi `claude` thật**. Mọi test dùng runner giả hoặc `tests/fixtures/fake-claude.mjs`.
- Trạng thái ticket: `draft → planning → awaiting_approval → running → done | escalated | cancelled`. Không agent nào ngoài Controller được chạy khi ticket chưa `running`.
- Model mặc định theo vai:

  | Vai | Agent | Model | Effort |
  |---|---|---|---|
  | Controller | claude | `claude-opus-5-5` | xhigh |
  | Dev, Designer, QC | claude | `claude-sonnet-5-5` | high |

  Effort hợp lệ: `low|medium|high|xhigh|max`. Model cho phép mặc định của claude: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`.
- Mặc định: tối đa 3 subagent chạy song song toàn hệ thống (Controller không tính), tối đa 3 vòng mỗi ticket. Cả hai chỉnh được trong Settings.
- Ngưỡng cảnh báo giữ như Phần 1. Lặp ≥ 10 (`loopCritical`) với agent do dashboard chạy thì **tự dừng**, lý do `auto-stop: loop`. Phiên ngoài ticket không bao giờ bị tự dừng.
- Id agent do dashboard chạy có dạng `acctv:<ticketId>:<slot>`, với `slot` là `controller | dev-1 | dev-2 | designer-1 | qc-1 …`. Id ticket có dạng `T-<n>`.
- Lỗi rate limit hoặc hết quota là trạng thái riêng `limited` ("bị giới hạn"). Nó không tính vào lỗi dồn dập. Agent tự chờ (60s, 120s, 300s) rồi `--resume`.
- Toàn bộ chữ trên UI và CLI là tiếng Việt. Trạng thái luôn có biểu tượng hoặc chữ đi kèm, không chỉ dùng màu. Độ tương phản ≥ 4.5:1.
- Lý do bị chặn của guard luôn bắt đầu bằng `[acctv-guard]`. Lỗi sửa ngoài phạm vi bắt đầu bằng `[acctv-guard] ngoài phạm vi:`.
- Mỗi task kết thúc bằng một commit. Message có dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Đường dẫn có dấu cách hoặc dấu tiếng Việt** (`D:\Dự án\my app`), đi qua spawn args, lệnh hook trong `settings.json`, `git worktree add` và tên nhánh. Agent vẫn phải chạy, guard vẫn nhận đúng đường dẫn, tên nhánh chỉ gồm ASCII. Test nằm ở Task 3 (slug), Task 4 (lệnh hook), Task 7 (spawn) và Task 8 (worktree).
2. **Guard so đường dẫn trên Windows**: `D:\Work\x` với `d:/work/X`, `..` thoát ra ngoài, đường dẫn tương đối theo `cwd` của hook. Cả ba phải ra cùng một quyết định đúng. Test ở Task 4.
3. **Bấm Duyệt hai lần, hoặc web và CLI cùng duyệt**: lần thứ hai nhận 409, Controller không bị chạy hai lượt song song. Test ở Task 10 và Task 12.
4. **Dừng một agent đang chạy lệnh con** (`npm test` sinh tiếp `node`): cả cây phải chết, Controller và các agent khác vẫn sống. Test ở Task 7 (cháu) và Task 11 (agent khác không bị ảnh hưởng).
5. **Stdout bất thường**: dòng không phải JSON, một dòng bị cắt giữa hai chunk, một dòng 9MB. Không được crash, dòng hỏng tính là `parse_error`. Test ở Task 6 và Task 7.

---

## Cấu trúc file

```
src/core/model.ts            (sửa) AgentStatus thêm queued|limited; AlertKind thêm guard; HubEvent thêm ticket|managed|wait
src/core/config.ts           (sửa) Settings trong Config, saveSettings()
src/core/store.ts            (sửa) getter database, isManagedSession(), clearIngested giữ acctv:*
src/server/core.ts           (sửa) ingest(), TicketStore, Orchestrator
src/adapters/claude/watch.ts (sửa) bỏ qua phiên do dashboard chạy
src/tickets/model.ts         Ticket, Plan, ManagedAgent, WaitSpan, AgentReport…
src/tickets/store.ts         TicketStore (bảng tickets, managed_agents, waits, ticket_log)
src/tickets/flow.ts          state machine thuần, validatePlan, branchName
src/guard/policy.ts          checkTool() thuần
bin/acctv-guard.mjs          hook PreToolUse: stdin → POST /api/guard → stdout
src/detect/rules.ts          (sửa) detectGuard
src/runner/types.ts          RunSpec, RunHandle, RunResult, Runner, RunSink
src/runner/claudeArgs.ts     buildClaudeArgs(), writeRunFiles()
src/runner/streamJson.ts     parseStreamLine()
src/runner/proc.ts           startProcess(), killTree()
src/runner/claude.ts         claudeRunner
src/runner/codex.ts          codexRunner + parseCodexExecLine (Task 20)
src/runner/detect.ts         findExecutable()
src/git/git.ts               gitInfo, createWorktree, snapshotCommit, diffStat, removeWorktree, gitInit
src/orchestrator/mcp.ts      handleMcp() JSON-RPC + TOOL_DEFS
src/orchestrator/prompts.ts  system prompt từng vai + nội dung từng lượt Controller
src/orchestrator/orchestrator.ts  class Orchestrator
src/server/routes.ts         route POST/PUT + GET mới, readJson()
app/lib/tickets.ts           nhãn trạng thái ticket/agent, controllerIdOf, layoutWaits, replayRange
app/components/TicketList.tsx, TicketHeader.tsx, ManagedPanel.tsx
app/tickets/new/page.tsx, app/tickets/[id]/plan/page.tsx, app/settings/page.tsx
cli/acctv.ts, cli/render.ts  (sửa) new|plan|approve|revise|stop, ls/watch/logs theo ticket
tests/fixtures/fake-claude.mjs, tests/fixtures/claude/stream.jsonl
```

---

### Task 1: Kiểu dữ liệu ticket và Settings

**Files:**
- Modify: `src/core/model.ts`, `src/core/config.ts`
- Create: `src/tickets/model.ts`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Produces (`src/core/model.ts`):
  - `AgentStatus = 'running' | 'idle' | 'ended' | 'queued' | 'limited'`
  - `AlertKind` thêm `'guard'`
  - `HubEvent` thêm `{type:'ticket'; ticket: Ticket}`, `{type:'managed'; managed: ManagedAgent}`, `{type:'wait'; wait: WaitSpan}`
  - `isManagedId(id: string): boolean` (`id.startsWith('acctv:')`)
- Produces (`src/tickets/model.ts`):
  ```ts
  export type TicketStatus = 'draft'|'planning'|'awaiting_approval'|'running'|'done'|'escalated'|'cancelled';
  export type Role = 'controller'|'dev'|'designer'|'qc';
  export type WorkRole = Exclude<Role,'controller'>;
  export type AgentKind = 'claude'|'codex';
  export type Effort = 'low'|'medium'|'high'|'xhigh'|'max';
  export interface RoleSpec { agent: AgentKind; model: string; effort: Effort }
  export interface WorkPackage { id: string; role: WorkRole; title: string; task: string; files: string[] }
  export interface Plan { summary: string; difficulty: 'easy'|'medium'|'hard'; packages: WorkPackage[];
    roles: Record<WorkRole, RoleSpec & { count: number }>; acceptance: string[] }
  export interface Ticket { id: string; seq: number; title: string; description: string; dir: string; status: TicketStatus;
    overrides: Partial<Record<Role, Partial<RoleSpec>>>; plan: Plan|null; feedback: string|null; round: number; maxRounds: number;
    controllerSessionId: string; branch: string|null; worktree: string|null; baseRef: string|null;
    pendingWait: string[]|null; report: string|null; diffStat: string|null; createdAt: number; updatedAt: number }
  export type ManagedState = 'queued'|'running'|'limited'|'waiting'|'done'|'failed'|'stopped'|'interrupted';
  export interface ManagedAgent { agentId: string; ticketId: string; role: Role; ordinal: number; packageId: string|null;
    task: string; files: string[]; runner: AgentKind; model: string; effort: Effort; sessionId: string; state: ManagedState;
    stopReason: string|null; resultText: string|null; changedFiles: string[]; costUsd: number|null; createdAt: number; endedAt: number|null }
  export interface WaitSpan { id: string; agentId: string; kind: 'approval'|'agents'; startedAt: number; endedAt: number|null }
  export interface AgentReport { id: string; role: WorkRole; state: ManagedState; stopReason: string|null; summary: string;
    changedFiles: string[]; calls: number; errors: number; guardBlocks: number; scopeViolations: number; topError: string|null }
  export const TERMINAL_STATES: ManagedState[] = ['done','failed','stopped','interrupted'];
  ```
- Produces (`src/core/config.ts`):
  ```ts
  export interface Settings { roleDefaults: Record<Role, RoleSpec>; allowedModels: Record<AgentKind, string[]>;
    denyBash: string[]; checkCommands: string[]; maxRounds: number; maxParallel: number;
    prices: Record<string, { in: number; out: number }>; claudePath: string|null; codexPath: string|null }
  // Config thêm: settings: Settings
  export const DEFAULT_SETTINGS: Settings
  // raw có dạng { settings, thresholds } (cũng là body của PUT /api/settings)
  export function validateSettings(raw: unknown): { ok: true; settings: Settings; thresholds: Thresholds } | { ok: false; errors: string[] }
  export function saveSettings(cfg: Config, settings: Settings, thresholds: Thresholds): void
  ```

Giá trị của `DEFAULT_SETTINGS`:
- `roleDefaults`: lấy theo bảng ở Global Constraints.
- `allowedModels.codex`: `[]`.
- `maxRounds`: 3. `maxParallel`: 3.
- `prices`: `{}`. Chi phí của agent do dashboard chạy lấy từ `total_cost_usd`; bảng giá chỉ dùng để ước tính cho phiên ngoài ticket.
- `claudePath` và `codexPath`: `null`, nghĩa là tự dò.
- `denyBash` (chuỗi regex, so không phân biệt hoa thường):
  - `\bgit\s+(commit|push|pull|fetch|checkout|switch|branch|merge|rebase|reset|remote|tag|worktree|stash|cherry-pick|revert|am|clean|config)\b`
  - `\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b`
  - `\bnpm\s+link\b`
  - `\b(reg|setx|regedit|bcdedit|diskpart|shutdown|winget|choco|scoop|apt|apt-get|brew|sudo|runas)\b`
  - `\b(taskkill|Stop-Process|pkill|killall)\b`
  - `\bkill\s+-`
  - `\brm\s+-\w*r\w*\s+(/|~|[A-Za-z]:[\\/])`
  - `Remove-Item\b[^\n]*-Recurse`
- `checkCommands`:
  - `^\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|typecheck|check|preview)\b`
  - `^\s*npx\s+(tsc|vitest|jest|eslint|playwright|prettier\s+--check)\b`
  - `^\s*git\s+(status|diff|log|show)\b`
  - `^\s*(ls|dir|cat|type|pwd)\b`

- [ ] **Step 1: Viết test hỏng** trong `tests/core/config.test.ts`:
  - `loadConfig` không có `config.json` → `cfg.settings` deep-equal `DEFAULT_SETTINGS`.
  - `config.json` chứa `{"settings":{"maxParallel":5,"roleDefaults":{"dev":{"agent":"claude","model":"claude-haiku-5-5","effort":"low"}}}}` → `maxParallel === 5`, `roleDefaults.dev.model === 'claude-haiku-5-5'`, `roleDefaults.qc` vẫn là giá trị mặc định.
  - `validateSettings({settings, thresholds})`, với `settings` và `thresholds` lấy từ mặc định rồi đổi một trường, từ chối các trường hợp sau. Mỗi trường hợp có một lỗi chứa tên trường:
    - `maxParallel: 0`
    - `thresholds.stuckMs: -1`, và `loopWarn >= loopCritical`
    - `effort: 'turbo'`
    - `denyBash: ['(']`
    - một `roleDefaults.*.model` không nằm trong `allowedModels[agent]`
  - `saveSettings` ghi `config.json` (giữ nguyên `backfillHours` đang có), `loadConfig` đọc lại ra đúng giá trị. Ghi qua file `.tmp` rồi rename, sau đó trong thư mục không còn `.tmp`.
- [ ] **Step 2:** `npx vitest run tests/core/config.test.ts` → FAIL (`settings` undefined).
- [ ] **Step 3:** Viết các kiểu và hàm ở trên.
  - `loadConfig` merge `o.settings` theo từng trường. `roleDefaults` merge theo từng vai. Giá trị nào không hợp lệ thì bỏ qua và giữ mặc định.
  - `saveSettings` cũng gán vào `cfg.settings` và `cfg.thresholds` đang dùng (mutate tại chỗ), để engine và orchestrator thấy ngay.
- [ ] **Step 4:** Chạy `npx vitest run` → toàn bộ PASS. 198 test cũ vẫn xanh, kể cả các chỗ `switch` theo `AgentStatus`. Thêm nhánh cho `queued`/`limited` ở `cli/render.ts statusIcon` (`◌` / `⏸`) và `SessionList.statusOf` (`◌ xếp hàng` tone `wait`, `⏸ bị giới hạn` tone `warn`). Thêm `'guard': 'bị chặn'` vào `ALERT_LABEL` trong `app/lib/format.ts`.
- [ ] **Step 5: Commit** `feat(p2): ticket model types and settings`

---

### Task 2: TicketStore và tách phiên do dashboard chạy khỏi watcher

**Files:**
- Create: `src/tickets/store.ts`
- Modify: `src/core/store.ts`, `src/adapters/claude/watch.ts`, `src/adapters/codex/watch.ts`, `src/server/core.ts`
- Test: `tests/tickets/store.test.ts`, `tests/core/store.test.ts`, `tests/adapters/watch.test.ts`

**Interfaces:**
- Consumes: kiểu từ Task 1.
- Produces:
  - `Store`:
    - `get database(): DatabaseSync`
    - `isManagedSession(sessionId: string): boolean`. Trả true khi có dòng `agents` với `session_id = ?` và `id LIKE 'acctv:%'`.
    - `dropAgent(id: string): void`. Xoá agent, các call và alert của nó.
  - `Store.clearIngested()` chỉ xoá các dòng có `id`/`agent_id NOT LIKE 'acctv:%'` (offsets vẫn xoá hết).
  - `class TicketStore`, constructor `(store: Store)`, tạo bảng bên dưới:
    - `nextTicketId(): string`. Trả `T-<n>`, tăng `meta.ticketSeq`.
    - `createTicket(t: Ticket): void`, `getTicket(id): Ticket|undefined`, `listTickets(): Ticket[]` (mới nhất trước).
    - `updateTicket(id, patch: Partial<Ticket>): Ticket`. Luôn đặt `updatedAt = Date.now()`.
    - `upsertManaged(m: ManagedAgent): void`, `getManaged(agentId)`, `listManaged(ticketId?)`, `updateManaged(agentId, patch): ManagedAgent`.
    - `openWait(w: WaitSpan): void`, `closeWait(id, at): WaitSpan|undefined`, `listWaits(since: number): WaitSpan[]`.
    - `log(ticketId, text): void`, `listLog(ticketId): {at:number; text:string}[]`.
  - `Core` thêm `ingest(evs: NormalizedEvent[]): void` và `tickets: TicketStore`. `ingest` áp từng event trong một `store.transaction`, rồi chạy cùng đường `onEvents` của watcher: publish lên hub, `engine.onCall` cho mỗi call.

Schema: các mảng và object lưu dạng JSON TEXT.

```sql
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  dir TEXT NOT NULL, status TEXT NOT NULL, overrides TEXT NOT NULL, plan TEXT, feedback TEXT, round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL, controller_session TEXT NOT NULL, branch TEXT, worktree TEXT, base_ref TEXT,
  pending_wait TEXT, report TEXT, diff_stat TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS managed_agents (agent_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, role TEXT NOT NULL,
  ordinal INTEGER NOT NULL, package_id TEXT, task TEXT NOT NULL, files TEXT NOT NULL, runner TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, stop_reason TEXT, result_text TEXT,
  changed_files TEXT NOT NULL, cost_usd REAL, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_managed_ticket ON managed_agents(ticket_id);
CREATE TABLE IF NOT EXISTS waits (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS ticket_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
```

- [ ] **Step 1: Viết test hỏng.**
  - `tests/tickets/store.test.ts`:
    - Round-trip một `Ticket` có đủ `plan`, `overrides`, `pendingWait`.
    - `nextTicketId()` trả `T-1`, `T-2`, và tiếp tục đếm sau khi mở lại DB.
    - `updateManaged` đổi `state` và giữ các trường khác.
    - `listWaits(since)` trả cả các span còn mở.
  - `tests/core/store.test.ts`: sau `clearIngested()`, agent `acctv:T-1:dev-1` và call của nó còn nguyên, còn `claude:abc` thì mất. `isManagedSession('sid-x')` là true sau khi apply agent `{id:'acctv:T-1:controller', source:'claude', sessionId:'sid-x'}`.
  - `tests/adapters/watch.test.ts`:
    - Có agent `acctv:T-1:controller` với `sessionId: 'sess-m'`. Ghi `projects/proj/sess-m.jsonl` có tool_use. Sau khi backfill, store **không** có `claude:sess-m`.
    - Thêm `sessions/<pid>.json` của `sess-m` (pid = `process.pid`). Sau một liveness tick, status của `acctv:T-1:controller` không đổi.
- [ ] **Step 2:** `npx vitest run tests/tickets tests/core/store.test.ts tests/adapters/watch.test.ts` → FAIL.
- [ ] **Step 3:** Viết code.
  - `match` của Claude watcher trả false khi `store.isManagedSession(sid)`. `sid` là phần `<sid>` của `projects/<p>/<sid>.jsonl`, hoặc `projects/<p>/<sid>/subagents/…`.
  - Vòng liveness `continue` khi `isManagedId(a.id)`.
  - Codex watcher: `match` bỏ qua file có thread id (uuid ở cuối tên `rollout-…-<uuid>.jsonl[.zst]`) đã thuộc phiên do dashboard chạy.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(p2): ticket store; watchers skip dashboard-run sessions`

---

### Task 3: State machine của ticket, kiểm kế hoạch, tên nhánh

**Files:**
- Create: `src/tickets/flow.ts`
- Test: `tests/tickets/flow.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TicketEvent = 'start_planning'|'plan_proposed'|'approve'|'revise'|'finish_done'|'finish_escalated'|'continue'|'cancel';
  export function transition(from: TicketStatus, ev: TicketEvent): TicketStatus | null; // null = không hợp lệ
  export function validatePlan(raw: unknown, s: Settings): { ok: true; plan: Plan } | { ok: false; errors: string[] };
  export function filesOverlap(a: string[], b: string[]): boolean;
  export function slugify(title: string): string;
  export function branchName(ticketId: string, title: string): string; // `acctv/${ticketId}-${slugify(title)}`
  ```

Bảng chuyển trạng thái (mọi cặp khác trả `null`):

| từ | sự kiện | tới |
|---|---|---|
| draft | start_planning | planning |
| planning | plan_proposed | awaiting_approval |
| awaiting_approval | approve | running |
| awaiting_approval | revise | planning |
| running | finish_done | done |
| running | finish_escalated | escalated |
| escalated | continue | running |
| planning, awaiting_approval, running, escalated | cancel | cancelled |

Quy tắc của `validatePlan`:
- `summary` là chuỗi khác rỗng. `difficulty` thuộc `easy|medium|hard`.
- `packages` có ≥ 1 gói. `id` không trùng nhau. `role` là vai làm việc hợp lệ. Gói `dev` phải có `files` ≥ 1. `files` là đường dẫn tương đối, không chứa `..`, không tuyệt đối.
- `roles.dev.count` từ 1 đến 6. `roles.designer.count` và `roles.qc.count` từ 0 đến 3.
- `agent` thuộc `claude|codex`. `model` nằm trong `allowedModels[agent]`. Riêng codex: `model` rỗng hoặc nằm trong danh sách.
- `effort` hợp lệ. `acceptance` có ≥ 1 dòng.
- Thiếu `roles.designer`/`roles.qc` thì điền `count: 0` cùng `roleDefaults` tương ứng.
- Mỗi lỗi là một chuỗi tiếng Việt có tên trường, ví dụ `packages[1].files: gói dev phải có ít nhất một file`.

`filesOverlap`: so theo dạng chuẩn hoá (đổi `\` thành `/`, viết thường). Glob `**`/`*` khớp như trong Task 4. Hai gói trùng nhau khi một file hoặc glob của gói này khớp một mục của gói kia.

`slugify`:
- NFD rồi bỏ `\p{M}`, đổi `đ`/`Đ` thành `d`, viết thường.
- Chuỗi ký tự ngoài `[a-z0-9]` thành một dấu `-`. Cắt hai đầu, tối đa 40 ký tự.
- Kết quả rỗng thì trả `ticket`.

- [ ] **Step 1: Viết test hỏng.**
  - Mọi dòng của bảng trên. `transition('draft','approve') === null`. `transition('done','cancel') === null`.
  - `slugify('Trang đăng nhập — Bước 2!') === 'trang-dang-nhap-buoc-2'`. `slugify('***') === 'ticket'`.
  - `branchName('T-12','Sửa lỗi') === 'acctv/T-12-sua-loi'`.
  - Một kế hoạch mẫu hợp lệ thì qua. Mỗi lỗi trong các quy tắc trên có một test riêng, kiểm `errors` chứa tên trường.
  - `filesOverlap(['src/a.ts'],['src/b.ts']) === false`. `filesOverlap(['src/**'],['src/x/y.ts']) === true`. `filesOverlap(['SRC\\A.ts'],['src/a.ts']) === true`.
- [ ] **Step 2:** `npx vitest run tests/tickets/flow.test.ts` → FAIL.
- [ ] **Step 3:** Viết `flow.ts`. Dùng chung hàm `matchGlob` export từ `src/guard/policy.ts`: viết nó ở task này, Task 4 dùng lại.
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5: Commit** `feat(p2): ticket state machine, plan validation, branch names`

---

### Task 4: Guard — luật theo vai và hook `PreToolUse`

**Files:**
- Create/Modify: `src/guard/policy.ts` (`matchGlob` đã có từ Task 3)
- Create: `bin/acctv-guard.mjs`
- Test: `tests/guard/policy.test.ts`, `tests/guard/hook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GuardPolicy { role: Role; root: string; readRoots: string[]; allowedFiles: string[];
    denyBash: RegExp[]; checkCommands: RegExp[] }
  export type GuardDecision = { allow: true } | { allow: false; reason: string; scope: boolean };
  export function checkTool(p: GuardPolicy, toolName: string, input: unknown, cwd: string): GuardDecision;
  export function matchGlob(pattern: string, relPath: string): boolean;
  export function hookCommand(nodePath: string, scriptPath: string, port: number, agentId: string, token: string): string;
  ```
- Hook: `bin/acctv-guard.mjs <port> <agentId> <token>`.
  1. Đọc toàn bộ stdin (JSON của Claude: `tool_name`, `tool_input`, `cwd`).
  2. POST tới `http://127.0.0.1:<port>/api/guard?agent=<agentId>`, header `authorization: Bearer <token>`, `content-type: application/json`, timeout 8 giây.
  3. Server trả `{allow:true}` thì thoát 0 và không in gì. Trả `{allow:false, reason}`, hoặc lỗi, hoặc timeout thì in ra stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}` rồi thoát 0. Khi lỗi hoặc timeout, reason là `[acctv-guard] dashboard không phản hồi, từ chối để an toàn`.

Luật của `checkTool`:
- Mọi đường dẫn được resolve theo `cwd` bằng `path.win32` trên win32 (`path.posix` trên nền khác), rồi so không phân biệt hoa thường trên win32.
- `Read`, `Glob`, `Grep`: cho phép khi `file_path`/`path` (không có thì lấy `cwd`) nằm trong `root` hoặc một `readRoots`. Không thì từ chối, reason `[acctv-guard] ngoài thư mục làm việc: <p>`, `scope:false`.
- `Edit`, `Write`, `MultiEdit`, `NotebookEdit`:
  - Vai khác `dev`: reason `[acctv-guard] vai <role> chỉ được đọc`.
  - `dev`: đường dẫn phải nằm trong `root`, và đường dẫn tương đối của nó phải khớp một mục trong `allowedFiles` (khớp chính xác hoặc qua `matchGlob`). Nếu không: reason `[acctv-guard] ngoài phạm vi: <rel>` (hoặc `<abs>` khi nằm ngoài root), `scope:true`.
- `Bash`:
  - Khớp một `denyBash` → reason `[acctv-guard] lệnh bị cấm (<pattern>)`.
  - Vai `designer`/`qc` mà không khớp `checkCommands` nào → reason `[acctv-guard] vai <role> chỉ chạy lệnh kiểm tra`.
  - `controller` → luôn từ chối.
- Tool `mcp__acctv__*`: chỉ `controller` được dùng.
- Mọi tool khác → reason `[acctv-guard] tool <name> không được phép cho vai <role>`.

`matchGlob`: `**` khớp mọi đoạn, kể cả rỗng. `*` khớp trong một đoạn. So sau khi đã chuẩn hoá `/` và viết thường.

`hookCommand` trả `"<node>" "<script>" <port> <agentId> <token>`. Hai đường dẫn đầu luôn nằm trong dấu nháy kép.

- [ ] **Step 1: Viết test hỏng** `tests/guard/policy.test.ts`. Với `root = 'D:\\Work\\wt'`, `allowedFiles = ['src/login/**','README.md']`, vai dev:
  - `Edit {file_path:'d:/work/WT/src/login/a.ts'}` → allow.
  - `Edit {file_path:'src/other.ts'}`, `cwd = root` → deny, `scope:true`, reason bắt đầu bằng `[acctv-guard] ngoài phạm vi:`.
  - `Write {file_path:'D:\\Work\\wt\\..\\x.txt'}` → deny, `scope:true`.
  - `Read {file_path:'C:\\Users\\Admin\\.ssh\\id_rsa'}` → deny.
  - `Bash {command:'git commit -m x'}` → deny. `Bash {command:'npm test -- login'}` → allow.
  - Vai qc: `Bash {command:'npm run build'}` → allow. `Bash {command:'node scripts/x.js'}` → deny. `Edit` bất kỳ → deny.
  - Vai controller: `mcp__acctv__spawn_agent` → allow. Vai dev: tool đó → deny.
  - Chạy cả bộ test trên với `posix` khi chạy trên Linux CI: bọc theo `process.platform` và chỉ assert phần chung.
- [ ] **Step 2: Viết test hỏng** `tests/guard/hook.test.ts`.
  - Dựng `http.createServer` ghi lại request và trả `{allow:false, reason:'[acctv-guard] x'}`. Chạy `node bin/acctv-guard.mjs <port> acctv:T-1:dev-1 tok` bằng `spawnSync`, input là JSON có `tool_name: 'Edit'`.
  - Kiểm: stdout parse ra `permissionDecision === 'deny'` và reason `'[acctv-guard] x'`; server nhận header `authorization: Bearer tok` và body đúng như input.
  - Trường hợp server trả `{allow:true}` → stdout rỗng, mã thoát 0.
  - Trường hợp cổng không có ai nghe → deny, reason chứa `không phản hồi`.
  - `hookCommand('C:\\Program Files\\nodejs\\node.exe','D:\\Dự án\\bin\\acctv-guard.mjs',4777,'a','t')` trả đúng chuỗi có nháy kép.
- [ ] **Step 3:** `npx vitest run tests/guard` → FAIL.
- [ ] **Step 4:** Viết `policy.ts` và `bin/acctv-guard.mjs` (JS thuần, chỉ dùng `node:http`, không import TS).
- [ ] **Step 5:** Test PASS.
- [ ] **Step 6: Commit** `feat(p2): role guard policy and PreToolUse hook`

---

### Task 5: Cảnh báo "bị chặn" và trạng thái mới trong DetectEngine

**Files:**
- Modify: `src/detect/rules.ts`, `src/detect/engine.ts`
- Test: `tests/detect/rules.test.ts`, `tests/detect/engine.test.ts`

**Interfaces:**
- Produces: `detectGuard(a: AgentInfo, recentTools: CallRecord[]): Alert | null`.
  - Đếm các call tool trong `recentTools` có `errorPreview` bắt đầu bằng `[acctv-guard]` (N). Trong đó có M call bắt đầu bằng `[acctv-guard] ngoài phạm vi`.
  - N = 0 → `null`.
  - Ngược lại trả alert kind `guard`. Message `bị chặn ×N`, thêm ` · ngoài phạm vi ×M` khi M > 0. Level `critical` khi `M >= 3`, ngược lại `warn`. `since` là `startedAt` của call bị chặn đầu tiên.
- `DetectEngine.onCall` reconcile thêm kind `guard`, theo cùng điều kiện `live` như `loop`.
- `KINDS` thêm `guard`.
- Trạng thái `queued`/`limited`: `tick` xử lý giống `idle` (tắt `stuck`/`long_tool`).

- [ ] **Step 1: Viết test hỏng.**
  - `detectGuard` với 2 call bị chặn (1 call ngoài phạm vi) → `warn`, message `bị chặn ×2 · ngoài phạm vi ×1`.
  - Với 3 call ngoài phạm vi → `critical`.
  - Engine: agent `limited`, không có sự kiện trong 10 phút → không có alert `stuck`.
- [ ] **Step 2:** FAIL → viết code → PASS (`npx vitest run tests/detect`).
- [ ] **Step 3: Commit** `feat(p2): guard alert; queued/limited agents never alert as stuck`

---

### Task 6: Đọc stream-json của Claude và dựng tham số dòng lệnh

**Files:**
- Create: `src/runner/types.ts`, `src/runner/streamJson.ts`, `src/runner/claudeArgs.ts`, `tests/fixtures/claude/stream.jsonl`
- Test: `tests/runner/streamJson.test.ts`, `tests/runner/claudeArgs.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface RunSpec { agentId: string; ticketId: string; role: Role; agent: AgentKind; label: string; parentId: string|null;
    cwd: string; model: string; effort: Effort; prompt: string; systemPrompt: string; sessionId: string; resume: boolean;
    tools: string[]; allowedTools: string[]; addDirs: string[]; runDir: string;
    mcp: { url: string; token: string } | null; guard: { port: number; token: string } }
  export interface RunResult { exitCode: number|null; killed: boolean; isError: boolean; text: string; costUsd: number|null;
    rateLimited: boolean; sessionId: string; changedFiles: string[] }
  export interface RunSink { events(evs: NormalizedEvent[]): void; limited(on: boolean): void }
  export interface RunHandle { pid: number|null; done: Promise<RunResult>; kill(): Promise<void> }
  export type Runner = (spec: RunSpec, sink: RunSink) => RunHandle;
  ```
- Produces (`streamJson.ts`):
  ```ts
  export interface StreamCtx { claude: ClaudeFileCtx; pendingEdits: Map<string, string>; changedFiles: Set<string> }
  export function newStreamCtx(spec: Pick<RunSpec,'agentId'|'sessionId'|'label'|'resume'>): StreamCtx;
  export interface StreamOut { events: NormalizedEvent[]; sessionId?: string;
    result?: { isError: boolean; text: string; costUsd: number|null; rateLimited: boolean }; limited?: boolean }
  export function parseStreamLine(line: string, ctx: StreamCtx, now: number): StreamOut;
  export const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|\b429\b|\b529\b|overloaded/i;
  ```
- Produces (`claudeArgs.ts`):
  ```ts
  export function buildClaudeArgs(spec: RunSpec, files: { systemPromptFile: string; settingsFile: string; mcpFile: string }): string[];
  export function writeRunFiles(spec: RunSpec, guardHook: string): { systemPromptFile: string; settingsFile: string; mcpFile: string };
  ```

Cách xử lý từng dòng trong `parseStreamLine`:
- `JSON.parse` lỗi → `{events:[{type:'parse_error', agentId}]}`.
- `type:'system', subtype:'init'` → `sessionId = rec.session_id`. Nếu có `rec.model`, thêm một event `agent` có `model`.
- `type:'system'` có `subtype` chứa `retry`, và (`error_status` là 429/529 hoặc `error` khớp `RATE_LIMIT_RE`) → `limited: true`.
- `type:'assistant'|'user'`:
  - Thêm `timestamp: new Date(now).toISOString()` nếu dòng chưa có, rồi đưa vào `parseClaudeLine(JSON.stringify(rec), ctx.claude)`.
  - Bỏ các khoá `parentId`, `status`, `label`, `startedAt` khỏi mọi event `agent`. Runner sở hữu các trường này.
  - Với `assistant`, thêm `limited: false`.
  - `tool_use` có tên thuộc `Edit|Write|MultiEdit|NotebookEdit` → ghi `pendingEdits[id] = input.file_path ?? input.notebook_path`. `tool_result` không lỗi của id đó → thêm đường dẫn vào `changedFiles`.
- `type:'result'` → `result`:
  - `isError = rec.is_error === true || rec.subtype !== 'success'`
  - `text = String(rec.result ?? '')`
  - `costUsd = typeof rec.total_cost_usd === 'number' ? … : null`
  - `rateLimited = isError && RATE_LIMIT_RE.test(text)`
- Mọi `type` khác → `{events: []}`.

`newStreamCtx` tạo `ClaudeFileCtx` với `agentId`, `sessionId`, `parentId: null`, `label`, `resumed: spec.resume`, `lastTs: null`.

`buildClaudeArgs` trả các cờ theo đúng thứ tự sau. Prompt được ghi vào **stdin**, không nằm trên dòng lệnh.

```
-p --output-format stream-json --verbose --model <model> --effort <effort>
(--session-id <id> | --resume <id>)
--permission-mode dontAsk --setting-sources project,local
--tools <tools.join(',')> --allowedTools <allowedTools.join(',')>
--append-system-prompt-file <systemPromptFile> --settings <settingsFile>
--mcp-config <mcpFile> --strict-mcp-config
(--add-dir <d>)*
```

`writeRunFiles` ghi các file sau vào `spec.runDir` (tạo thư mục nếu chưa có):
- `system.md`.
- `settings.json` = `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":<guardHook>,"timeout":10}]}]}}`.
- `mcp.json`:
  - Khi có `spec.mcp`: `{"mcpServers":{"acctv":{"type":"http","url":<url>,"headers":{"Authorization":"Bearer <token>"}}}}`.
  - Khi không có: `{"mcpServers":{}}`.

- [ ] **Step 1: Ghi fixture thật.**
  ```bash
  echo "Reply with exactly: OK" | "C:/Users/Admin/.local/bin/claude.exe" -p --output-format stream-json --verbose --model claude-haiku-5-5 --tools "" --max-budget-usd 0.05 --no-session-persistence > tests/fixtures/claude/stream-real.jsonl
  ```
  - Kiểm file có các dòng `system/init`, `assistant`, `result`.
  - Thay đường dẫn máy và `cwd` bằng `D:\\proj`, giữ nguyên cấu trúc.
  - Sau đó viết tay `tests/fixtures/claude/stream.jsonl`, theo đúng cấu trúc vừa thấy, gồm:
    1. init
    2. assistant có `tool_use` Edit `src/a.ts` (id `tu1`)
    3. user có `tool_result` `tu1` ok
    4. assistant có `tool_use` Bash (id `tu2`)
    5. user có `tool_result` `tu2` với `is_error: true`
    6. một dòng `not json`
    7. `system` subtype `api_retry`, `error_status: 429`
    8. assistant chỉ có text
    9. result success, `total_cost_usd: 0.0123`
- [ ] **Step 2: Viết test hỏng** `streamJson.test.ts`. Duyệt fixture với `now` tăng dần:
  - `sessionId` lấy từ init.
  - Có `call_start` và `call_end` ok cho `tu1`, `call_end` `ok:false` cho `tu2`.
  - Đúng một `parse_error`.
  - `limited: true` ở dòng 7, `limited: false` ở dòng 8.
  - `result.costUsd === 0.0123`.
  - `ctx.changedFiles` chứa đúng `src/a.ts`.
  - Không event `agent` nào có khoá `status`/`parentId`/`label`/`startedAt`.
  - `stream-real.jsonl` cũng đọc qua được, ra một `result` với `isError === false`.
  - Một dòng `type:'result', is_error:true, result:'Claude AI usage limit reached'` → `rateLimited:true`.
- [ ] **Step 3: Viết test hỏng** `claudeArgs.test.ts`:
  - Có `--session-id` khi `resume:false`, có `--resume` khi `true`, không bao giờ có cả hai.
  - Không có chuỗi nào chứa `bypass` hay `dangerously`.
  - `writeRunFiles` với `runDir` chứa dấu cách và chữ có dấu → `settings.json` parse ra đúng `command`. `mcp.json` có header Authorization khi có `spec.mcp`.
- [ ] **Step 4:** FAIL → viết code → PASS (`npx vitest run tests/runner`).
- [ ] **Step 5: Commit** `feat(p2): Claude stream-json parsing and CLI args`

---

### Task 7: Chạy tiến trình, kill cả cây, Claude runner

**Files:**
- Create: `src/runner/proc.ts`, `src/runner/claude.ts`, `src/runner/detect.ts`, `tests/fixtures/fake-claude.mjs`
- Test: `tests/runner/proc.test.ts`, `tests/runner/claude.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  ```ts
  // proc.ts
  export interface Proc { pid: number|null; onLine(fn: (line: string) => void): void; exit: Promise<{ code: number|null; signal: string|null }>; stdin: Writable }
  export function startProcess(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Proc;
  export function killTree(pid: number): Promise<void>;
  // detect.ts
  export function findExecutable(name: 'claude'|'codex', override: string|null, env?: NodeJS.ProcessEnv): string|null;
  // claude.ts
  export function createClaudeRunner(opts: { command: string; prefixArgs?: string[]; nodePath?: string; guardScript: string }): Runner;
  ```

Yêu cầu chi tiết:
- `startProcess`:
  - Dùng `spawn` với `shell:false` và `windowsHide:true`. Trên nền khác win32 thì thêm `detached:true` để kill được cả nhóm.
  - Tách stdout theo `\n`, giữ phần dư qua các chunk. Một dòng dài hơn 8MB thì bỏ, gửi chuỗi `'\u0000overflow'` cho `onLine`; runner chuyển nó thành `parse_error`.
  - Stderr chỉ giữ 4KB cuối, để làm `text` khi tiến trình thoát mà không có `result`.
- `killTree`:
  - win32: `execFile('taskkill', ['/PID', String(pid), '/T', '/F'])`, bỏ qua lỗi "not found".
  - Nền khác: `process.kill(-pid, 'SIGKILL')`, có try/catch.
  - Resolve sau khi lệnh kill xong.
- `findExecutable`:
  - Có `override` và file tồn tại → trả `override`.
  - Không có thì dò theo `PATH`: win32 thử thêm `.exe` và `.cmd`.
  - Với claude, thử thêm `%USERPROFILE%\.local\bin\claude.exe`.
- `createClaudeRunner(spec, sink)`:
  1. `writeRunFiles`.
  2. `startProcess(command, [...prefixArgs, ...buildClaudeArgs(...)], {cwd: spec.cwd})`, ghi `spec.prompt` vào stdin rồi `end()`.
  3. Mỗi dòng → `parseStreamLine` → `sink.events`, và `sink.limited(x)` khi `limited` có giá trị.
  4. `done` resolve thành `RunResult`:
     - `text` = text của `result`, không có thì lấy stderr cuối.
     - `isError` = `result.isError` hoặc mã thoát khác 0 hoặc không có `result`.
     - `killed` = true khi `kill()` đã được gọi.
     - `sessionId` = từ init, không có thì là `spec.sessionId`.
  5. `kill()` gọi `killTree(pid)`, rồi chờ `exit`.
- `fake-claude.mjs`:
  - Đọc toàn bộ argv và stdin.
  - Đọc kịch bản JSON từ file trong env `FAKE_CLAUDE_SCRIPT`. Kịch bản là `{ "<role|*>": Turn[] }`, với `Turn = { "when"?: string; "steps": Step[] }`.
    - Role lấy từ dòng đầu `ROLE: <role>` của file `--append-system-prompt-file`. `prompts.ts` ở Task 10 luôn đặt dòng này đầu tiên.
    - Chọn `Turn` đầu tiên có `when` là chuỗi con của stdin, hoặc không có `when`.
  - Ghi `{argv, stdin, cwd}` nối thêm vào file `FAKE_CLAUDE_LOG` (JSONL).
  - Các loại `Step`:
    - `{"emit": <obj>}`: in một dòng JSON.
    - `{"raw": "<s>"}`: in nguyên chuỗi.
    - `{"sleep": ms}`.
    - `{"mcp": "<tool>", "args": {...}}`: đọc `mcp.json` từ argv, POST JSON-RPC `tools/call`, rồi in kết quả dưới dạng một dòng `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"mcp-<n>","content":<text>}]}}` sau một dòng `assistant` `tool_use` tương ứng.
    - `{"hook": {"tool_name": "...", "tool_input": {...}}}`: đọc `settings.json`, chạy lệnh hook với stdin là JSON đó, in ra một `tool_use` và một `tool_result` có `is_error` = (hook trả deny), nội dung là reason.
    - `{"spawnChild": true}`: chạy một tiến trình node con ngủ 60 giây, ghi pid của nó vào `FAKE_CLAUDE_CHILD_PID`.
    - `{"exit": code}`.
  - Kết thúc kịch bản mà chưa in `result` thì tự in `{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0}`.

- [ ] **Step 1: Viết test hỏng** `proc.test.ts`:
  - Một script in `{"a":1}\n{"b"` rồi `:2}\n` ở lần write sau → `onLine` nhận đúng 2 dòng.
  - Một dòng 9MB → nhận `'\u0000overflow'`, sau đó vẫn nhận tiếp dòng kế.
  - `killTree`: tiến trình cha sinh một tiến trình con ngủ 60 giây. Sau `killTree(cha)`, trong vòng 5 giây cả hai pid đều chết (`process.kill(pid, 0)` ném lỗi).
- [ ] **Step 2: Viết test hỏng** `claude.test.ts`, dùng `createClaudeRunner({command: process.execPath, prefixArgs: [fakeClaudePath], guardScript})`:
  - `cwd` là thư mục tạm có tên `dự án có dấu cách`. Kịch bản in lại fixture `stream.jsonl`.
  - Kiểm:
    - `sink.events` nhận các call ở Task 6.
    - `done.costUsd === 0.0123`.
    - `FAKE_CLAUDE_LOG` có `--session-id`, `stdin === spec.prompt`, `cwd` đúng.
  - Kịch bản `sleep 60000`: `kill()` → `done.killed === true` trong vòng 5 giây.
  - Kịch bản `exit 3` không có result: `isError === true`, `text` là stderr cuối.
- [ ] **Step 3:** FAIL → viết code → PASS (`npx vitest run tests/runner`).
- [ ] **Step 4: Commit** `feat(p2): process tree control and Claude runner`

---

### Task 8: Git — worktree, snapshot, diff

**Files:**
- Create: `src/git/git.ts`
- Test: `tests/git/git.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GitInfo { exists: boolean; isGit: boolean; branch: string|null; head: string|null; dirty: boolean }
  export function gitInfo(dir: string): Promise<GitInfo>;
  export function createWorktree(repo: string, branch: string, wtPath: string): Promise<{ baseRef: string }>;
  export function snapshotCommit(wt: string, message: string): Promise<string|null>; // sha, hoặc null khi không có gì để commit
  export function diffStat(repo: string, baseRef: string, branch: string): Promise<string>;
  export function removeWorktree(repo: string, wtPath: string): Promise<void>;
  export function gitInit(dir: string): Promise<void>;
  export function worktreePath(home: string, repo: string, ticketId: string): string; // <home>/worktrees/<basename(repo)>-<ticketId>
  ```

Yêu cầu:
- Mọi lệnh chạy bằng `execFile('git', ['-C', dir, ...])`. Lỗi được ném ra kèm stderr.
- Commit (cả `snapshotCommit` lẫn commit đầu trong `gitInit`) thêm `-c user.name=Agent CCTV -c user.email=acctv@localhost`. Không dùng `--no-verify`.
- `createWorktree` chạy `worktree add -b <branch> <wtPath> HEAD`. `baseRef` = sha của HEAD trước khi tạo.
- `snapshotCommit` chạy `add -A`. Nếu `status --porcelain` rỗng thì trả `null`, không thì commit và trả sha.
- `diffStat` chạy `diff --stat <baseRef>..<branch>`.
- `gitInit` chạy `init`, `add -A`, rồi `commit --allow-empty -m "Initial commit"`.

- [ ] **Step 1: Viết test hỏng.** Repo tạm ở thư mục `Dự án demo` (có dấu, có cách), commit đầu có `a.txt`:
  - `gitInfo` → `isGit`, `dirty:false`, có `branch`. Sửa `a.txt` → `dirty:true`. Thư mục không tồn tại → `exists:false`. Thư mục thường → `isGit:false`.
  - `createWorktree(repo, 'acctv/T-1-demo', worktreePath(home, repo, 'T-1'))` → worktree có `a.txt`, nhánh tồn tại.
  - Ghi `b.txt` trong worktree → `snapshotCommit` trả sha. Gọi lần nữa → `null`. `diffStat` chứa `b.txt`. Repo gốc vẫn không có `b.txt`.
  - `removeWorktree` → thư mục mất, nhánh còn.
  - `gitInit` trên thư mục thường → `gitInfo.isGit === true` và có `head`.
- [ ] **Step 2:** FAIL → viết code → PASS (`npx vitest run tests/git`).
- [ ] **Step 3: Commit** `feat(p2): git worktree helpers`

---

### Task 9: MCP endpoint — JSON-RPC và định nghĩa tool

**Files:**
- Create: `src/orchestrator/mcp.ts`
- Test: `tests/orchestrator/mcp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolResult { text: string; isError?: boolean }
  export type ToolImpl = (args: Record<string, unknown>) => Promise<ToolResult>;
  export const TOOL_DEFS: { name: 'propose_plan'|'spawn_agent'|'wait_agents'|'get_agent_log'|'finish'; description: string; inputSchema: object }[];
  export function handleMcp(body: unknown, tools: Record<string, ToolImpl>): Promise<{ status: 200|202; json?: unknown }>;
  ```

Hành vi:
- Body là một request JSON-RPC 2.0, hoặc một mảng các request.
- `initialize` → `{protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'acctv', version: '0.2.0'}}`.
- Message không có `id` (notification) → `202`, không có body. Mảng chỉ gồm notification cũng vậy.
- `ping` → `{}`.
- `tools/list` → `{tools: TOOL_DEFS}`.
- `tools/call` → `{content: [{type: 'text', text}], isError}`. Tool không tồn tại → `isError: true`, text `Tool không tồn tại: <name>`. Tool ném lỗi → `isError: true`, text là message của lỗi.
- Method lạ → error `-32601`. Body không phải object → error `-32600`.

`inputSchema` (JSON Schema, `additionalProperties: false`):
- `propose_plan`: `{plan: object}`. Schema của plan mô tả đủ các trường của `Plan` để Controller biết cấu trúc.
- `spawn_agent`: `{role: enum dev|designer|qc, packageId?: string, task: string, files: string[], model?: string, effort?: enum, agent?: enum claude|codex}`. Bắt buộc: `role`, `task`, `files`.
- `wait_agents`: `{ids: string[]}`.
- `get_agent_log`: `{id: string, limit?: integer 1..200}`.
- `finish`: `{report: string, status: enum done|escalated}`.

Mỗi `description` ghi rõ: `propose_plan` và `wait_agents` có thể trả "đang chờ", và khi đó Controller phải kết thúc lượt ngay.

- [ ] **Step 1: Viết test hỏng:**
  - `initialize` echo đúng `protocolVersion`.
  - `notifications/initialized` → 202.
  - `tools/list` có đúng 5 tên.
  - `tools/call` gọi impl với đúng `args` và trả về text.
  - Impl ném `new Error('x')` → `isError: true`, text `x`.
  - Method `foo` → `-32601`.
  - Mảng 2 request → mảng 2 response.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Commit** `feat(p2): minimal MCP JSON-RPC handler`

---

### Task 10: Orchestrator I — vòng đời ticket

**Files:**
- Create: `src/orchestrator/orchestrator.ts`, `src/orchestrator/prompts.ts`
- Test: `tests/orchestrator/lifecycle.test.ts`, `tests/orchestrator/prompts.test.ts`, `tests/helpers/fakeRunner.ts`

**Interfaces:**
- Consumes: TicketStore và `Core.ingest` (Task 2), flow (Task 3), `GuardPolicy` (Task 4), `Runner` (Task 6), git (Task 8), `ToolImpl` (Task 9).
- Produces:
  ```ts
  export interface OrchestratorDeps { cfg: Config; store: Store; tickets: TicketStore; hub: Hub; ingest(evs: NormalizedEvent[]): void;
    runners: Partial<Record<AgentKind, Runner>>; git: typeof import('@/src/git/git'); port(): number;
    now?: () => number; newSessionId?: () => string; delays?: { rateLimitMs: number[] } }
  export class OrchestratorError extends Error { constructor(public status: 400|404|409, msg: string) }
  export class Orchestrator {
    constructor(deps: OrchestratorDeps);
    createTicket(input: { title: string; description: string; dir: string; overrides?: Ticket['overrides'] }): Promise<Ticket>;
    approve(ticketId: string, edited?: Plan): Promise<Ticket>;
    revise(ticketId: string, feedback: string): Promise<Ticket>;
    mcpTools(ticketId: string): Record<string, ToolImpl>;      // propose_plan, spawn_agent, wait_agents, get_agent_log, finish
    checkMcpToken(ticketId: string, token: string): boolean;
    guard(agentId: string, token: string, hookInput: unknown): { allow: true } | { allow: false; reason: string } | null; // null = token sai
    idle(): Promise<void>;                                       // chờ mọi việc nền xong (dùng trong test)
  }
  // prompts.ts
  export function systemPrompt(role: Role, ctx: { worktree: string|null; files: string[]; denyBash: string[] }): string; // dòng đầu: `ROLE: <role>`
  export function workerPrompt(m: Pick<ManagedAgent,'task'|'files'|'role'>, plan: Plan, worktree: string): string;
  export const turn: {
    first(t: Ticket): string; approved(plan: Plan, worktree: string): string; revised(feedback: string): string;
    agentsDone(reports: AgentReport[], round: number, maxRounds: number): string; nudge(): string;
    restarted(): string; continued(guidance: string, maxRounds: number): string };
  ```

Hành vi (mọi thay đổi ticket và managed agent đều publish `ticket`/`managed`/`wait` lên hub):

**`createTicket`:**
- `gitInfo(dir)` không phải git → `OrchestratorError(400, 'Thư mục không phải git repo')`. `deps.runners.claude` không có → `OrchestratorError(400, 'Không tìm thấy Claude CLI')`.
- Tạo ticket `draft`, rồi chuyển ngay `start_planning` sang `planning`. `controllerSessionId` = `newSessionId()` (`crypto.randomUUID`). `maxRounds` lấy từ settings.
- Tạo managed agent `acctv:<id>:controller`, rồi chạy **lượt Controller** với `turn.first`.

**Lượt Controller** (`runControllerTurn(ticketId, message)`, private):
- Chỉ một lượt mỗi ticket tại một thời điểm. Gọi khi đang có lượt chạy thì xếp message vào hàng và chạy sau.
- Spec:
  - `role: 'controller'`, `cwd: ticket.dir`, `addDirs: worktree ? [worktree] : []`.
  - `tools: ['Read','Glob','Grep']`. `allowedTools` gồm 3 tool đó cộng 5 tên đầy đủ `mcp__acctv__propose_plan`, `mcp__acctv__spawn_agent`, `mcp__acctv__wait_agents`, `mcp__acctv__get_agent_log`, `mcp__acctv__finish`. Không dùng wildcard.
  - `resume` = controller đã chạy ít nhất một lượt.
  - `mcp.url: http://127.0.0.1:<port>/mcp?ticket=<id>`. Token mới cho mỗi lượt.
  - Policy guard: `root = dir`, `readRoots = [worktree]`.
- Trước khi spawn, emit event `agent`:
  - `{id, source: 'claude', sessionId, label: 'Controller', role: 'controller', parentId: null, model, effort, cwd: dir, status: 'running'}`.
  - Có `startedAt` ở lượt đầu.
  - Đóng wait đang mở của controller.
- Khi lượt kết thúc (`done`), cộng dồn `costUsd`, rồi quyết định bước tiếp:
  - Ticket ở `awaiting_approval`, hoặc có `pendingWait` chưa xong → status `idle`, state `waiting`, mở `WaitSpan` (`approval` hoặc `agents`).
  - `pendingWait` đã xong hết → chạy lượt mới với `turn.agentsDone`.
  - Ticket ở trạng thái kết thúc → status `ended`, state `done`.
  - Còn lại (Controller dừng mà không gọi tool chờ hay `finish`) → `turn.nudge`, tối đa 2 lần liên tiếp. Lần thứ 3 thì ticket chuyển `escalated`, `report = 'Controller dừng mà không kết luận'`.
  - Nhánh rate limit và lỗi tiến trình được viết ở Task 11.

**`propose_plan`:**
- Chỉ hợp lệ khi `planning`; ngược lại trả `isError`, text `Chỉ đề xuất kế hoạch khi ticket đang lập kế hoạch`.
- `validatePlan` lỗi → `isError`, text là các lỗi nối bằng xuống dòng.
- Hợp lệ → lưu plan, `plan_proposed`, ghi log `Controller đề xuất kế hoạch`. Trả `Đã gửi kế hoạch. Người dùng đang duyệt. Hãy kết thúc lượt ngay bây giờ.`

**`approve`:**
- Ticket không ở `awaiting_approval` → `OrchestratorError(409, 'Ticket không ở trạng thái chờ duyệt')`.
- `edited` qua `validatePlan`, lỗi thì 400.
- Tạo worktree (`branchName`, `worktreePath`). Lưu `branch`, `worktree`, `baseRef`. Chuyển `approve`, đóng wait, chạy lượt `turn.approved`.
- Chuyển trạng thái **trước** mọi `await`, để lần duyệt thứ hai (đồng thời) nhận 409.

**`revise`:** chỉ khi `awaiting_approval`. Lưu `feedback`, chuyển `revise`, chạy lượt `turn.revised`.

**`spawn_agent`:**
- Ticket khác `running` → `isError`, text `Kế hoạch chưa được duyệt; chưa được khởi chạy agent`.
- `model`/`effort`/`agent` lấy theo thứ tự: tham số, rồi `plan.roles[role]`, rồi `overrides[role]`, rồi `roleDefaults`. Model ngoài `allowedModels` → `isError`.
- Agent kind không có runner (ví dụ codex chưa cài) → `isError`, text `Codex CLI chưa được cài trên máy`.
- `role === 'dev'` và `filesOverlap` với một dev khác của ticket đang `queued|running|limited` → `isError`, text `Trùng file với <id> đang chạy; hãy chờ nó xong hoặc chia lại file`.
- `ordinal` = số agent cùng vai của ticket + 1. Id `acctv:<T>:<role>-<n>`. Label `Dev-1`, `Designer-1`, `QC-1`.
- Tạo managed agent `queued`, emit `agent` (`parentId` = controller id, `status: 'queued'`), rồi đưa vào hàng đợi.
- Trả `Đã tạo <id> (<role>, <model>/<effort>). Dùng wait_agents để chờ.`

**Hàng đợi:**
- FIFO toàn hệ thống. Số agent đang `running|limited` < `settings.maxParallel` thì chạy agent kế tiếp.
- Spec của worker:
  - `cwd: worktree`, `tools` và `allowedTools` theo vai. Dev: `Read,Glob,Grep,Edit,Write,Bash`. Designer/QC: `Read,Glob,Grep,Bash`.
  - `prompt` = `workerPrompt`.
  - Policy: `root = worktree`, `allowedFiles = files`.
- Khi kết thúc: state = `done` nếu `!isError`, ngược lại `failed`. Lưu `resultText`, `changedFiles`, `costUsd`. Emit status `ended`, giải phóng slot, rồi kiểm `pendingWait`.

**`wait_agents(ids)`:**
- Id không thuộc ticket → `isError`.
- Tất cả đã ở `TERMINAL_STATES` → trả JSON các `AgentReport` ngay. Không tăng vòng.
- Ngược lại → lưu `pendingWait = ids`, trả `Đang chờ N agent. Hãy kết thúc lượt ngay; bạn sẽ được gọi lại kèm báo cáo.`
- Khi agent cuối cùng trong `pendingWait` kết thúc:
  - Nếu trong đó có `dev` thì `round += 1`. Gọi `snapshotCommit(worktree, 'acctv: <T> vòng <round>')`, ghi log sha hoặc lỗi (lỗi commit không làm hỏng ticket).
  - Xoá `pendingWait`. Nếu Controller đang không có lượt chạy thì chạy lượt `turn.agentsDone(reports, round, maxRounds)`.

**`AgentReport`:**
- `summary` = `resultText` cắt còn 4000 ký tự.
- `calls`/`errors` lấy từ `agentMetrics`.
- `guardBlocks`/`scopeViolations` đếm theo tiền tố `[acctv-guard]` trên các call tool.
- `topError` lấy từ `topRepeatedError` (import từ `app/lib/detail.ts`; hàm này thuần).

**`get_agent_log(id, limit = 50)`:** mỗi call một dòng `HH:MM:SS ✓|✗|… <name> <inputPreview>[ → <errorPreview>]`, cũ trước.

**`finish(report, status)`:**
- Chỉ khi `running`, ngược lại `isError`.
- `snapshotCommit` cuối. Tính `diffStat(dir, baseRef, branch)`. Chuyển `finish_done` hoặc `finish_escalated`, lưu `report`.
- Trả `Đã kết thúc ticket (<status>). Kết thúc lượt.`

**`prompts.ts`** (tham khảo `~/.claude/agents/office-*.md`; mỗi hàm là thuần):
- Mọi system prompt bắt đầu bằng `ROLE: <role>`.
- Câu mở đầu của mỗi lượt cố định, để kịch bản giả nhận ra:
  - `turn.approved` bắt đầu bằng `Kế hoạch đã được duyệt`.
  - `turn.agentsDone` bắt đầu bằng `Các agent đã xong`.
  - `turn.revised` bắt đầu bằng `Người dùng góp ý`.
  - `turn.restarted` bắt đầu bằng `Dashboard vừa khởi động lại`.
- Controller: chỉ đọc code, không tự sửa. Quy trình: lập kế hoạch → `propose_plan` → chờ. Sau khi duyệt: `spawn_agent` theo gói việc, cho Dev chạy song song khi file không giao nhau, rồi Designer (nếu có) và QC review. Còn lỗi thì giao lại Dev ở vòng sau. Giới hạn vòng. Kết thúc bằng `finish`. Khi `propose_plan` hoặc `wait_agents` trả "đang chờ" thì phải kết thúc lượt ngay.
- Dev: chỉ sửa đúng các file được giao. Chạy test theo phạm vi gói việc. Cấm `git commit`/`push`. Cuối cùng báo cáo đã làm gì, file nào, test nào đã chạy và kết quả.
- Designer/QC: chỉ đọc và chạy lệnh kiểm tra. Báo cáo danh sách lỗi có file:dòng, mức độ, và kết luận "đạt / không đạt".
- System prompt nhúng danh sách `denyBash` dạng dễ đọc.
- `workerPrompt` gồm task, danh sách file được sửa, đường dẫn worktree và tiêu chí nghiệm thu của kế hoạch.

`tests/helpers/fakeRunner.ts`:
- `createFakeRunner()` trả `{ runner: Runner, runs: FakeRun[] }`.
- Mỗi `FakeRun` có `spec`, `emit(evs: NormalizedEvent[])`, `limited(on)`, `finish(r: Partial<RunResult>)`, và `killed: boolean`.
- `kill()` resolve `done` với `{killed: true, isError: true}`.

- [ ] **Step 1: Viết test hỏng** `prompts.test.ts`: dòng đầu mỗi system prompt là `ROLE: <role>`. Prompt Controller chứa tên cả 5 tool. Prompt Dev chứa `git commit`. `workerPrompt` chứa từng file và worktree.
- [ ] **Step 2: Viết test hỏng** `lifecycle.test.ts`. Repo git tạm, fake runner, `now` giả. Kịch bản đầy đủ:
  1. `createTicket` → ticket `planning`. `runs[0].spec` có role controller, `resume: false`, `cwd === dir`, `mcp` khác null.
  2. Gọi `mcpTools(T).spawn_agent(...)` lúc đang `planning` → `isError` (Dev không chạy khi chưa duyệt).
  3. `propose_plan(plan hợp lệ: 2 gói dev không giao file, 1 qc)` → `awaiting_approval`. `runs[0].finish({})` → controller `idle`, có wait `approval` đang mở.
  4. `Promise.allSettled([approve(T), approve(T)])` → đúng một fulfilled, một rejected 409. Chỉ có **một** lượt controller mới (`runs.length === 2`), với `resume: true` và `addDirs` = [worktree]. Worktree tồn tại.
  5. Gọi `spawn_agent` cho dev 2 lần và qc 1 lần, với `maxParallel = 2` → 2 run worker chạy, `qc-1` là `queued`. `wait_agents([dev-1, dev-2, qc-1])` → text "Đang chờ". Controller finish → controller `idle`.
  6. `dev-1`: ghi file `src/a.ts` trong worktree, rồi `finish({text: 'xong a', changedFiles: ['src/a.ts']})` → `qc-1` bắt đầu chạy. `dev-2` và `qc-1` lần lượt finish → `round === 1`, có commit `acctv: T-1 vòng 1` trên nhánh. Có một lượt controller mới với prompt chứa `xong a` và `"round":1` hoặc `vòng 1/3`.
  7. `finish({report: 'ok', status: 'done'})` → ticket `done`, `diffStat` chứa `src/a.ts`. Controller finish → status `ended`.
  - Thêm các test riêng:
    - `spawn_agent` dev trùng file với dev đang chạy → `isError`.
    - Controller kết thúc 3 lượt liên tiếp mà không gọi tool → ticket `escalated`.
    - `propose_plan` sai → `isError` có tên trường, ticket vẫn `planning`.
- [ ] **Step 3:** `npx vitest run tests/orchestrator` → FAIL.
- [ ] **Step 4:** Viết `prompts.ts` và `orchestrator.ts` (chưa có stop/rate limit/recover).
- [ ] **Step 5:** PASS.
- [ ] **Step 6: Commit** `feat(p2): orchestrator ticket lifecycle with controller turns`

---

### Task 11: Orchestrator II — dừng, tự dừng, rate limit, vòng, khởi động lại

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`
- Test: `tests/orchestrator/control.test.ts`

**Interfaces:**
- Produces (thêm vào `Orchestrator`):
  ```ts
  stopAgent(agentId: string, reason: string): Promise<void>;   // 404 không có; 409 đã kết thúc hoặc là controller
  cancel(ticketId: string): Promise<Ticket>;
  continueTicket(ticketId: string, guidance: string): Promise<Ticket>; // chỉ khi escalated
  removeWorktree(ticketId: string): Promise<Ticket>;           // chỉ khi done|escalated|cancelled
  recover(): Promise<void>;                                    // gọi một lần khi server khởi động
  onAlert(a: Alert): void;                                     // core nối từ hub
  ```

Hành vi:
- **`stopAgent`:**
  - `queued` → bỏ khỏi hàng.
  - `running`/`limited` → `handle.kill()`.
  - State `stopped`, `stopReason = reason`, emit status `ended`, ghi log `Dừng <id>: <reason>`. Sau đó đi theo đường kết thúc agent bình thường, nên `wait_agents` nhận report có `state: 'stopped'` và `stopReason`.
  - Gọi lại trên agent đã kết thúc → 409. Gọi trên controller → 409 `Controller: dùng Huỷ ticket`.
  - Lý do do API dùng là `người dùng dừng`.
- **`onAlert`:** khi `kind === 'loop'`, `level === 'critical'`, `active`, và `isManagedId(agentId)`:
  - Worker → `stopAgent(id, 'auto-stop: loop')`.
  - Controller → kill lượt đang chạy, ticket `escalated` với `report = 'Controller lặp vòng (auto-stop: loop)'`.
  - Chỉ xử lý một lần cho mỗi agent.
- **Rate limit:**
  - `sink.limited(true)` → state và status `limited`. `sink.limited(false)` → `running`.
  - `done` với `rateLimited` → state `limited`, giữ slot, sau `delays.rateLimitMs[i]` thì chạy lại cùng spec với `resume: true` và prompt `Tiếp tục công việc đang dở.` (với Controller là message của lượt đó).
  - Hết 3 lần thử → `failed`, `stopReason = 'bị giới hạn: hết lượt thử'`.
  - Mặc định `delays = [60000, 120000, 300000]`.
  - Lỗi `limited` không tính vào nudge của Controller.
- **Vòng:** `spawn_agent` với `role === 'dev'` khi `round >= maxRounds` → `isError`, text `Đã hết <maxRounds> vòng; hãy gọi finish với status "escalated" và nêu lỗi còn lại`.
- **`continueTicket`:** chỉ khi `escalated`. `maxRounds += 1`, chuyển `continue`, chạy lượt `turn.continued(guidance, maxRounds)`.
- **`cancel`:** kill mọi agent đang chạy của ticket (cả lượt Controller), đặt state `stopped` với lý do `ticket bị huỷ`, chuyển `cancel`. Worktree giữ nguyên.
- **`removeWorktree`:** gọi `git.removeWorktree`, đặt `worktree = null`, ghi log. Nhánh giữ nguyên.
- **`recover()`:**
  - Mọi managed agent đang `queued|running|limited` → `interrupted`, `stopReason = 'bị gián đoạn: dashboard khởi động lại'`, status `ended`. Controller đang `running` cũng vậy.
  - Ticket `planning` không có plan → lượt `turn.restarted`.
  - Ticket `running` có `pendingWait` mà mọi agent đã kết thúc → lượt `turn.agentsDone`.
  - Ticket `running` không có `pendingWait` và controller không ở `waiting` → lượt `turn.restarted`.
  - `awaiting_approval` và `escalated` giữ nguyên.

- [ ] **Step 1: Viết test hỏng** `control.test.ts` (fake runner, repo tạm, đưa ticket tới `running` bằng helper dùng chung với Task 10):
  - Ba worker chạy song song. `stopAgent(dev-1, 'người dùng dừng')` → chỉ run của dev-1 có `killed === true`. Dev-2, qc-1 và controller không bị gọi `kill`. Report của `wait_agents` cho dev-1 có `state: 'stopped'`, `stopReason: 'người dùng dừng'`.
  - `stopAgent` lần hai → 409. `stopAgent(controller)` → 409.
  - `onAlert({kind:'loop', level:'critical', active:true, agentId: dev-2})` → dev-2 bị dừng với `auto-stop: loop`. Gửi alert đó lần nữa không gây lỗi. Alert `warn` → không làm gì.
  - Rate limit: run đầu `finish({rateLimited: true, isError: true})` → state `limited`. Sau `delays.rateLimitMs[0]` (test truyền `[10, 10, 10]`) có run thứ hai với `resume: true`. Ba lần liên tiếp bị giới hạn → `failed`.
  - `round = maxRounds` → `spawn_agent` dev bị từ chối, qc vẫn được.
  - `finish(escalated)` → `continueTicket(T, 'thử cách khác')` → `running`, `maxRounds === 4`, prompt của lượt mới chứa `thử cách khác`.
  - `cancel` khi có 2 worker chạy → cả hai `stopped`, ticket `cancelled`, worktree vẫn còn.
  - `recover()`: tạo `Orchestrator` mới trên cùng DB khi có dev-1 `running` và `pendingWait = [dev-1]` → dev-1 `interrupted`, có một lượt controller mới với report `interrupted`. Ticket `awaiting_approval` thì không có lượt mới.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Commit** `feat(p2): stop/auto-stop, rate-limit retries, rounds, recovery`

---

### Task 12: Server — API mới, MCP/guard endpoint, nối vào core

**Files:**
- Create: `src/server/routes.ts`
- Modify: `src/server/http.ts`, `src/server/core.ts`
- Test: `tests/server/tickets.test.ts`, `tests/server/e2e.test.ts`

**Interfaces:**
- Consumes: Orchestrator (Task 10–11), `handleMcp` (Task 9), `saveSettings` (Task 1), `gitInfo`/`gitInit` (Task 8), `findExecutable` (Task 7).
- Produces:
  - `Core.orchestrator: Orchestrator`. `createCore(cfg, watcherOptions, opts?: { runners?: Partial<Record<AgentKind, Runner>> })`. Khi không truyền `runners`, dựng runner `claude` từ `findExecutable('claude', settings.claudePath)` (bỏ qua nếu null), và `codex` ở Task 20.
  - `core.hub` alert → `orchestrator.onAlert`. Gọi `orchestrator.recover()` sau khi watcher bắt đầu.
  - Biến môi trường chỉ để thử: `ACCTV_CLAUDE_CMD` là JSON `{"command": "...", "prefixArgs": [...]}`. Khi có biến này, runner `claude` dùng lệnh đó thay cho CLI thật, và `capabilities.claude` là true.
  - Thêm `tests/fixtures/demo-scenario.json`, một kịch bản cho `fake-claude.mjs`: Controller đề xuất kế hoạch 2 dev + 1 qc. Sau khi duyệt, nó spawn rồi wait. Mỗi worker `sleep 20000` rồi xong. Lượt cuối gọi `finish done`. Các bước kiểm trên trình duyệt ở Task 13–18 bật `acctv-dev` với `ACCTV_CLAUDE_CMD` trỏ tới fake-claude và `FAKE_CLAUDE_SCRIPT` trỏ tới kịch bản này. Thêm cấu hình `acctv-demo` vào `.claude/launch.json` (cổng 4778, `ACCTV_HOME` riêng trong thư mục tạm), để DB thật không bị lẫn dữ liệu demo.
  - `readJson(req, limitBytes = 1_000_000): Promise<unknown>`. Lỗi → 400, quá cỡ → 413.

Các route (`/api/*` GET giữ nguyên như Phần 1):

| Method | Path | Trả |
|---|---|---|
| GET | `/api/snapshot` | như cũ + `tickets: Ticket[]`, `managed: ManagedAgent[]`, `waits: WaitSpan[]` (`listWaits(since)` theo `backfillHours`), `prices` |
| GET | `/api/tickets` | `Ticket[]` |
| GET | `/api/tickets/:id` | `{ticket, agents: ManagedAgent[], log}`; 404 |
| POST | `/api/tickets` | `{title, description?, dir, overrides?}` → 201 `Ticket` |
| POST | `/api/tickets/:id/approve` | `{plan?}` → 200 `Ticket` |
| POST | `/api/tickets/:id/revise` | `{feedback}` → 200 |
| POST | `/api/tickets/:id/cancel` | 200 |
| POST | `/api/tickets/:id/continue` | `{guidance}` → 200 |
| POST | `/api/tickets/:id/remove-worktree` | 200 |
| POST | `/api/agents/:id/stop` | 202 `{ok:true}` |
| GET | `/api/fs/check?dir=` | `GitInfo` |
| POST | `/api/fs/git-init` | `{dir}` → 200 `GitInfo` |
| GET | `/api/settings` | `{settings, thresholds}` |
| PUT | `/api/settings` | body như trên → 200; lỗi → 400 `{errors}` |
| GET | `/api/capabilities` | `{claude: boolean, codex: boolean}` |
| POST | `/api/guard?agent=` | Bearer → `{allow, reason?}`; token sai → 401 |
| POST | `/mcp?ticket=` | Bearer → JSON-RPC; GET `/mcp` → 405; token sai → 401 |

Quy tắc chung:
- `OrchestratorError` map ra status của nó, body `{error}`.
- POST/PUT thiếu `content-type: application/json` → 415. `Origin` lạ → 403.
- `/mcp` nằm ngoài `/api`, nên `attachApi` phải nhận cả path `/mcp` trước khi giao cho Next.
- Validate input: `title` là chuỗi 1–200 ký tự. `dir` là đường dẫn tuyệt đối. `feedback`/`guidance` 1–5000 ký tự.

- [ ] **Step 1: Viết test hỏng** `tickets.test.ts`. Server với `port: 0`, fake runner truyền qua `createCore`; thêm tham số `runners` vào `StartOptions`.
  - `POST /api/tickets` có `dir` là repo tạm → 201, `status: 'planning'`.
  - Thiếu `content-type` → 415. `Origin: http://evil.test` → 403. `dir` không phải repo → 400 với message `git repo`.
  - Đưa ticket tới `awaiting_approval` qua orchestrator. Hai `POST approve` song song → một 200, một 409.
  - `POST /api/agents/acctv:T-1:dev-1/stop` → 202. Gọi lần nữa → 409.
  - `PUT /api/settings` với `maxParallel: 0` → 400 có `errors`. Giá trị hợp lệ → 200, và `GET` trả lại đúng giá trị đó.
  - `/api/guard` sai token → 401. `/mcp` sai token → 401. `GET /mcp` → 405.
  - Snapshot có `tickets`, `managed`, `waits`.
  - WS nhận event `ticket` khi trạng thái đổi.
- [ ] **Step 2: Viết test hỏng** `e2e.test.ts`, dùng runner thật `createClaudeRunner` với `command: process.execPath` và `prefixArgs: [fake-claude.mjs]`. Kịch bản:
  - `controller` lượt 1: `{"mcp":"propose_plan","args":{"plan":<plan 1 gói dev files ["src/a.ts"]>}}`.
  - `controller` lượt 2 (`when: "Kế hoạch đã được duyệt"`): `mcp spawn_agent dev`, rồi `mcp wait_agents`.
  - `dev`:
    - `{"hook":{"tool_name":"Edit","tool_input":{"file_path":"src/b.ts"}}}`: phải bị chặn.
    - `{"hook":{"tool_name":"Edit","tool_input":{"file_path":"src/a.ts"}}}`: phải được phép.
  - `controller` lượt 3 (`when: "Các agent đã xong"`): `mcp finish done`.
  - Duyệt qua HTTP. Chờ (poll `GET /api/tickets/T-1`, timeout 20 giây) tới `done`.
  - Kiểm:
    - Có call của `acctv:T-1:dev-1` với `errorPreview` bắt đầu bằng `[acctv-guard] ngoài phạm vi: src/b.ts`.
    - Alert `guard` tồn tại.
    - Store không có agent `claude:*` nào cho các session đó.
- [ ] **Step 3:** FAIL → viết code → PASS (`npx vitest run tests/server`).
- [ ] **Step 4:** `npx vitest run` → toàn bộ PASS.
- [ ] **Step 5: Commit** `feat(p2): ticket/agent/settings API, MCP and guard endpoints`

---

### Task 13: Client — liveStore, thanh trên, cột trái

**Files:**
- Modify: `app/lib/liveStore.ts`, `app/components/TopBar.tsx`, `app/components/Dashboard.tsx`, `app/components/SessionList.tsx`
- Create: `app/lib/tickets.ts`, `app/components/TicketList.tsx` (+ `.module.css`)
- Test: `tests/app/liveStore.test.ts`, `tests/app/tickets.test.ts`

**Interfaces:**
- Produces:
  - `LiveState` thêm `tickets: Record<string, Ticket>`, `managed: Record<string, ManagedAgent>`, `waits: Record<string, WaitSpan>`, `selectedTicketId: string|null`.
  - `LiveAction` thêm các HubEvent mới. Snapshot mang thêm 3 mảng. Thêm action `{type:'selectTicket'; id: string|null}`.
  - Export `selectTicket(id)`, và `postJson<T>(path, body): Promise<T>`. `postJson` ném `Error(body.error)` khi `!ok`.
  - `app/lib/tickets.ts`:
    - `controllerIdOf(ticketId): string`
    - `ticketStatusText(t: Ticket): {icon: string; text: string; tone: 'run'|'wait'|'warn'|'crit'|'ok'|'ended'}`
    - `managedStateText(s: ManagedState): {icon; text; tone}`
    - `isExternal(a: AgentInfo): boolean`

Nhãn trạng thái ticket:

| status | icon + text | tone |
|---|---|---|
| draft | `○ nháp` | wait |
| planning | `● đang lập kế hoạch` | run |
| awaiting_approval | `▲ chờ duyệt` | warn |
| running | `● đang chạy · vòng {round+1}/{maxRounds}` | run |
| done | `✓ xong` | ok |
| escalated | `■ cần bạn quyết` | crit |
| cancelled | `○ đã huỷ` | ended |

Nhãn trạng thái managed agent:

| state | icon + text |
|---|---|
| queued | `◌ xếp hàng` |
| running | `● đang chạy` |
| limited | `⏸ bị giới hạn` |
| waiting | `◷ đang chờ` |
| done | `✓ xong` |
| failed | `✗ thất bại` |
| stopped | `■ bị dừng` |
| interrupted | `○ bị gián đoạn` |

Hành vi:
- Reducer ticket: thay khi `updatedAt` mới hơn. Snapshot giữ ticket ở state nếu `updatedAt` mới hơn bản trong snapshot (cùng mẫu với agents).
- `selectTicket` đặt `selectedTicketId` và `selectedAgentId = controllerIdOf(id)`. `select` (agent) mà agent không phải managed thì đặt `selectedTicketId = null`.
- TopBar thêm KPI "chờ duyệt" (số ticket `awaiting_approval`, có `▲` khi > 0) và link-nút `+ Ticket mới` tới `/tickets/new`.
- Cột trái: `TicketList` ở trên. Mỗi dòng là một `button` gồm tiêu đề, id và nhãn trạng thái; điều hướng bằng ↑/↓ như SessionList. Ticket `awaiting_approval` có link `Duyệt kế hoạch →` tới `/tickets/<id>/plan`. Bên dưới là SessionList với tiêu đề đổi thành "Phiên ngoài ticket", chỉ hiện agent `isExternal`.

- [ ] **Step 1: Viết test hỏng:**
  - Reducer: `ticket` cũ hơn không ghi đè. Snapshot giữ ticket mới hơn.
  - `selectTicket('T-1')` → `selectedAgentId === 'acctv:T-1:controller'`.
  - `ticketStatusText({status:'running', round:1, maxRounds:3})` có `text === 'đang chạy · vòng 2/3'`.
  - `isExternal({id:'acctv:T-1:dev-1'}) === false`.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Kiểm trên trình duyệt** (`preview_start acctv-dev`):
  - Mở `/`. Thấy cột "Ticket" (rỗng: `Chưa có ticket. Bấm + Ticket mới để bắt đầu.`) và "Phiên ngoài ticket" vẫn có các phiên thật.
  - Không có lỗi console.
- [ ] **Step 4: Commit** `feat(p2): live tickets in the client, top bar and ticket list`

---

### Task 14: Cột giữa — đầu ticket, đoạn chờ xám, xem lại

**Files:**
- Create: `app/components/TicketHeader.tsx` (+ css)
- Modify: `app/components/AgentTimeline.tsx`, `app/lib/tickets.ts`, `app/lib/lanes.ts`
- Test: `tests/app/tickets.test.ts`, `tests/app/lanes.test.ts`

**Interfaces:**
- Produces:
  - `layoutWaits(waits: WaitSpan[], agentId: string, win: {start; end}, width: number): { x: number; w: number; title: string }[]`. Title là `chờ duyệt kế hoạch · <dur>` hoặc `chờ subagent · <dur>`. Span đang mở thì kéo tới `win.end`.
  - `replayRange(nodes: AgentInfo[], now: number): { min: number; max: number; live: boolean }`. `live` = có node `running|queued|limited`. `max = live ? now : max(lastEventAt)`, `min = min(startedAt)`.
- `TicketHeader` (hiện phía trên timeline khi `selectedTicketId` khác null):
  - Gồm: tiêu đề, nhãn trạng thái, `nhánh <branch>` và `worktree <path>` (có nút copy), và `diffStat` khi `done`.
  - Hành động theo trạng thái:
    - `awaiting_approval` → link `Duyệt kế hoạch`.
    - `escalated` → `Tiếp tục kèm chỉ đạo`: mở textarea, gửi qua `POST continue`.
    - `planning|awaiting_approval|running|escalated` → `Huỷ ticket`, hỏi xác nhận bằng `confirm()` với chữ `Huỷ ticket <id>? Các agent đang chạy sẽ bị dừng, worktree được giữ lại.`
    - `done|escalated|cancelled` có worktree → `Xoá worktree`, có confirm.
  - Lỗi từ API hiện ngay dưới header (`role="alert"`).
- `AgentTimeline`:
  - Vẽ `layoutWaits` của từng lane thành thanh `var(--wait)` có chữ "chờ" khi đủ rộng, nằm dưới các thanh call.
  - Khi `!replayRange(...).live`: thêm thanh kéo `<input type="range" aria-label="Thời điểm xem lại">` từ `min + winMs` đến `max`, mặc định là `max`. Cửa sổ là `[v - winMs, v]`, ẩn vạch "bây giờ", hiện `xem lại · HH:MM:SS`. Khi live thì như cũ.

- [ ] **Step 1: Viết test hỏng:**
  - `layoutWaits`: span mở từ giữa cửa sổ → `x === width/2`, kéo tới cuối cửa sổ. Span của agent khác bị bỏ qua.
  - `replayRange`: mọi node `ended` → `live: false`, `max` = `lastEventAt` lớn nhất. Có node `queued` → `live: true`.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Kiểm trên trình duyệt:**
  - Mở `/` và chọn một phiên ngoài ticket đã kết thúc → thấy thanh kéo "xem lại". Kéo về trước thì thanh call dịch theo.
  - Trên `acctv-demo`, tạo một ticket bằng `node bin/acctv.mjs new … --port 4778` → header hiện đúng nút ở từng trạng thái (`planning` → `awaiting_approval` → `running` → `done`).
- [ ] **Step 4: Commit** `feat(p2): ticket header, grey wait spans, timeline replay`

---

### Task 15: Cột phải — gói việc và nút Dừng

**Files:**
- Create: `app/components/ManagedPanel.tsx` (+ css)
- Modify: `app/components/AgentDetail.tsx`, `app/lib/format.ts`
- Test: `tests/app/format.test.ts`

**Interfaces:**
- Produces: `fmtCost(usd: number|null): string`. `null` → `—`. Nhỏ hơn 0.01 → `<$0.01`. Còn lại → `~$1.23`.
- `estimateCost(model: string|null, tokensIn: number, tokensOut: number, prices: Settings['prices']): number|null`. Model không có trong bảng giá → `null`.
- Snapshot (Task 12) mang thêm `prices`. `liveStore` lưu vào `LiveState.prices`.
- Ô `chi phí` của AgentDetail: agent do dashboard chạy dùng `managed.costUsd`, phiên ngoài ticket dùng `estimateCost`. Cả hai hiện qua `fmtCost`.
- `ManagedPanel({agentId})`, render trong AgentDetail ở chỗ `{/* Phần 2: … */}` khi `managed[agentId]` tồn tại:
  - Chip trạng thái `managedStateText`. Dòng `runner · model · effort`. Chi phí `fmtCost`.
  - Khối "Gói việc": task, hiện 6 dòng đầu, có nút `Xem thêm`.
  - Khối "File được sửa": danh sách `files`. Mục nào có trong `changedFiles` thì đánh dấu `✎`.
  - `stopReason` nếu có, màu warn.
  - Nút `Dừng → trả Controller`:
    - Chỉ hiện khi vai khác controller và state thuộc `queued|running|limited`.
    - Bấm → `confirm('Dừng <label>? Kết quả dở dang sẽ trả về Controller.')` → `POST /api/agents/:id/stop`. Trong lúc gửi thì nút bị disable, có chữ `Đang dừng…`. Lỗi hiện `role="alert"`.
    - Phím tắt: `S` khi panel đang có focus, cũng hỏi confirm.
- Metric "token" của AgentDetail giữ nguyên. Thêm ô `chi phí`.

- [ ] **Step 1: Viết test hỏng** cho `fmtCost(null)`, `fmtCost(0.004)` và `fmtCost(1.234) === '~$1.23'`; `estimateCost('m', 1_000_000, 500_000, {m:{in:3,out:15}}) === 10.5`; `estimateCost('x', 1, 1, {}) === null`.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Kiểm trên trình duyệt:** với một ticket demo đang chạy (runner giả có `sleep`), bấm Dừng ở Dev-1 → chip chuyển `■ bị dừng`, lý do `người dùng dừng`. Lane của các agent khác vẫn chạy.
- [ ] **Step 4: Commit** `feat(p2): work package panel and stop button`

---

### Task 16: Màn tạo ticket

**Files:**
- Create: `app/tickets/new/page.tsx`, `app/tickets/new/NewTicketForm.tsx` (+ css), `app/lib/recentDirs.ts`
- Test: `tests/app/recentDirs.test.ts`

**Interfaces:**
- Produces: `recentDirs(tickets: Ticket[], max = 8): string[]`. Các `dir` không trùng (so không phân biệt hoa thường), mới nhất trước.
- Form gồm các trường:
  - Tiêu đề (bắt buộc).
  - Mô tả (textarea).
  - Thư mục dự án: `<input list>` gợi ý từ `recentDirs`.
  - "Tuỳ chọn theo vai" (đóng mặc định): mỗi vai một dòng agent / model / effort. Model lấy từ `allowedModels` của `/api/settings`.
- Hành vi:
  - Khi `dir` đổi (debounce 400ms) → `GET /api/fs/check`. Hiện dưới ô:
    - `✓ git · nhánh <branch>`.
    - `▲ Có thay đổi chưa commit; worktree được tạo từ HEAD nên sẽ không có các thay đổi này.` khi `dirty`.
    - `✗ Thư mục không tồn tại`.
    - `▲ Không phải git repo` kèm nút `Khởi tạo git và commit đầu tiên`. Nút này `confirm()` rồi `POST /api/fs/git-init`.
  - Lựa chọn `codex` bị `disabled` khi `capabilities.codex === false`, có chữ giải thích `Codex CLI chưa được cài trên máy`.
  - Nút `Tạo và giao cho Controller` bị disable khi chưa có tiêu đề hoặc thư mục chưa phải git. Gửi thành công → `router.push('/?ticket=<id>')`. Dashboard đọc query `ticket` khi mount để `selectTicket`.
  - Mọi `label` gắn với input. Lỗi có `role="alert"`. Tab đi đúng thứ tự.

- [ ] **Step 1: Viết test hỏng** cho `recentDirs`: bỏ trùng `D:\a` với `d:\A`, mới nhất trước, tối đa 8.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Kiểm trên trình duyệt:**
  - Thư mục không tồn tại, thư mục thường, repo bẩn, repo sạch: mỗi trường hợp ra đúng thông báo.
  - Option Codex bị khoá trên máy này.
  - Trên `acctv-demo`, tạo một ticket từ form → quay về `/` với ticket đó được chọn.
- [ ] **Step 4: Commit** `feat(p2): new ticket screen`

---

### Task 17: Màn duyệt kế hoạch

**Files:**
- Create: `app/tickets/[id]/plan/page.tsx`, `app/tickets/[id]/plan/PlanEditor.tsx` (+ css), `app/lib/planEdit.ts`
- Test: `tests/app/planEdit.test.ts`

**Interfaces:**
- Produces (thuần, dùng cho state của editor):
  ```ts
  export type PlanEdit =
    | { type: 'role'; role: WorkRole; patch: Partial<RoleSpec & { count: number }> }
    | { type: 'pkg'; id: string; patch: Partial<Omit<WorkPackage,'id'>> }
    | { type: 'pkgFiles'; id: string; text: string }          // mỗi dòng một file
    | { type: 'addPkg'; role: WorkRole } | { type: 'removePkg'; id: string }
    | { type: 'acceptance'; text: string };                     // mỗi dòng một tiêu chí
  export function applyPlanEdit(p: Plan, e: PlanEdit): Plan;
  export function planDiff(before: Plan, after: Plan): string[]; // mô tả tiếng Việt từng thay đổi, vd `Dev: 2 → 3`, `gói p2: thêm src/x.ts`
  ```
- Trang:
  - Nạp `GET /api/tickets/:id`. Ticket không ở `awaiting_approval` thì hiện trạng thái và link về `/`.
  - Hiện `summary` và `difficulty`.
  - Bảng vai: số lượng, agent, model, effort; mỗi ô là select hoặc number.
  - Danh sách gói việc: role, tiêu đề, task (textarea), files (textarea mỗi dòng một file). Cảnh báo `▲ trùng file với gói <id>` khi `filesOverlap` giữa hai gói dev.
  - Tiêu chí nghiệm thu: textarea.
  - Khối "Bạn đã sửa" liệt kê `planDiff`.
  - Ba nút:
    - `Duyệt và bắt đầu`: `POST approve {plan}`, chỉ gửi `plan` khi có sửa.
    - `Gửi góp ý cho Controller`: cần textarea góp ý khác rỗng, `POST revise`.
    - `Huỷ ticket`: có confirm.
  - Thành công → về `/?ticket=<id>`. Lỗi 400 thì hiện danh sách lỗi; 409 thì hiện `Kế hoạch đã được xử lý ở nơi khác` kèm link về.

- [ ] **Step 1: Viết test hỏng:**
  - `applyPlanEdit` role count 2 → 3.
  - `pkgFiles` với `"a.ts\n\n b.ts "` → `['a.ts','b.ts']`.
  - `addPkg` sinh id `p<n>` chưa dùng.
  - `removePkg`.
  - `planDiff` trả `['Dev: 2 → 3']` cho thay đổi số lượng, và `[]` khi không đổi gì.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Kiểm trên trình duyệt:** với ticket demo đang `awaiting_approval`, sửa số Dev và một file rồi Duyệt → ticket chuyển `running`, Controller nhận plan đã sửa (xem `FAKE_CLAUDE_LOG`). Mở lại trang → thấy trạng thái và link về.
- [ ] **Step 4: Commit** `feat(p2): plan review screen`

---

### Task 18: Settings và chế độ sáng

**Files:**
- Create: `app/settings/page.tsx`, `app/settings/SettingsForm.tsx` (+ css), `app/lib/theme.ts`
- Modify: `app/globals.css`, `app/layout.tsx`, `app/components/TopBar.tsx`
- Test: `tests/app/theme.test.ts`

**Interfaces:**
- Produces:
  - `type ThemePref = 'system'|'dark'|'light'`
  - `resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark'|'light'`
  - `THEME_KEY = 'acctv.theme'`
  - `themeBootScript(): string`. Trả script inline đặt `document.documentElement.dataset.theme` trước khi vẽ, bọc try/catch cho `localStorage`.
- Settings page, các section:
  1. Model mặc định theo vai (4 dòng agent/model/effort).
  2. Model cho phép: textarea mỗi dòng một model, một ô cho claude, một ô cho codex.
  3. Ngưỡng cảnh báo: 6 ô số, đơn vị hiện rõ (giây cho `stuckMs`/`longToolMs`, form tự đổi sang ms).
  4. Quyền theo vai: textarea `denyBash`, textarea `checkCommands`.
  5. Giới hạn: `maxRounds`, `maxParallel`.
  6. Bảng giá: các dòng `model · $/1M vào · $/1M ra`, thêm hoặc xoá được.
  7. Đường dẫn CLI: `claudePath`, `codexPath` (để trống là tự dò), kèm trạng thái lấy từ `/api/capabilities`.
  8. Giao diện: Hệ thống / Tối / Sáng, lưu trong `localStorage`.
  - `Lưu` → `PUT /api/settings`. Lỗi 400 thì hiện danh sách lỗi cạnh từng trường (khớp theo tên trường trong chuỗi lỗi).
- TopBar thêm link `Cài đặt`.
- Chế độ sáng trong `globals.css`: đặt các token dưới `:root[data-theme="light"]`:
  - `--bg #F8FAFC`, `--card #FFFFFF`, `--border #CBD5E1`, `--fg #0F172A`, `--muted #475569`
  - `--ok #15803D`, `--err #B91C1C`, `--run #1D4ED8`, `--warn #A16207`, `--wait #64748B`, `--sel #E2E8F0`

  Kiểm mọi file `.module.css` không còn màu viết cứng. Màu nào còn sót thì đổi sang token.

- [ ] **Step 1: Viết test hỏng:**
  - `resolveTheme('system', true) === 'light'`, `resolveTheme('dark', true) === 'dark'`.
  - `themeBootScript()` chứa `acctv.theme` và `try`.
- [ ] **Step 2:** FAIL → viết code → PASS.
- [ ] **Step 3: Kiểm trên trình duyệt:**
  - Đổi `maxParallel` rồi Lưu, tải lại trang → giá trị còn.
  - Nhập `(` vào `denyBash` → lỗi hiện đúng chỗ.
  - Chuyển Sáng → mọi màn (`/`, `/tickets/new`, `/settings`) đọc rõ.
  - Kiểm tương phản chữ `--muted` trên `--card` bằng `javascript_tool` (tính tỉ lệ, cần ≥ 4.5).
- [ ] **Step 4: Commit** `feat(p2): settings screen and light theme`

---

### Task 19: CLI — ticket và điều khiển

**Files:**
- Modify: `cli/acctv.ts`, `cli/render.ts`
- Test: `tests/cli/tickets.test.ts`, `tests/cli/render.test.ts`

**Interfaces:**
- Produces:
  - `Api.post<T>(path, body)` gửi `content-type: application/json`. Lỗi trả `{error}` thì ném `CliError` chứa message đó.
  - `renderTickets(tickets: Ticket[], color: boolean): string`
  - `renderPlan(t: Ticket, color: boolean): string`
  - `parseAgentRef(ref: string): string | null`: `'T-12/dev-1'` → `'acctv:T-12:dev-1'`, `'T-12'` → `'acctv:T-12:controller'`, còn lại → `null`.
- Lệnh mới và lệnh sửa (cập nhật `USAGE` cho khớp):
  - `new "<tiêu đề>" --dir <path> [--desc <mô tả>]` → in `T-3 đã tạo · đang lập kế hoạch`. `--dir` được resolve thành tuyệt đối.
  - `ls` → in thêm phần "Ticket" (`renderTickets`) trước danh sách agent, và danh sách agent đổi tiêu đề thành "Phiên ngoài ticket".
  - `plan <T>` → `renderPlan`. Ticket chưa có plan thì in `T-3 chưa có kế hoạch (trạng thái: đang lập kế hoạch)`.
  - `approve <T>`, `revise <T> "<góp ý>"`.
  - `stop <T>/<agent>` → in `Đã dừng Dev-1, kết quả trả về Controller`.
  - `watch <T>` và `logs <T>/<agent>`: khi `parseAgentRef` khác null thì dùng id đó, không thì dùng prefix như cũ.

`renderPlan` in: tóm tắt, độ khó, bảng vai (`Dev ×2 · claude · claude-sonnet-5-5 · high`), các gói (`[p1] dev · <title>` cùng các file thụt lề) và tiêu chí nghiệm thu.

- [ ] **Step 1: Viết test hỏng:**
  - `parseAgentRef` cho cả ba dạng.
  - `renderPlan` (không màu) chứa `Dev ×2` và từng file.
  - `tests/cli/tickets.test.ts` dựng server với fake runner như Task 12 và chạy `runCli`:
    - `new` → stdout chứa `T-1 đã tạo`.
    - Đưa ticket tới `awaiting_approval` rồi `approve T-1` → mã 0. Gọi `approve T-1` lần nữa → mã 1, stderr chứa `chờ duyệt`.
    - `stop T-1/dev-1` → mã 0.
    - `plan T-9` → mã 1, stderr chứa `404` hoặc `không tìm thấy`.
- [ ] **Step 2:** FAIL → viết code → PASS (`npx vitest run tests/cli`).
- [ ] **Step 3: Commit** `feat(p2): CLI new/plan/approve/revise/stop and ticket-aware ls/watch/logs`

---

### Task 20: Codex runner (chỉ bật khi có CLI) và tài liệu

**Files:**
- Create: `src/runner/codex.ts`, `tests/fixtures/codex/exec.jsonl`
- Modify: `src/server/core.ts`, `README.md`
- Test: `tests/runner/codex.test.ts`

**Interfaces:**
- Produces:
  - `buildCodexArgs(spec: RunSpec): string[]`. Ra `exec --json --cd <cwd> --sandbox <workspace-write|read-only> [-m <model>] -c model_reasoning_effort=<effort> [--add-dir <d>]* -`. Khi `resume`, chèn `resume <sessionId>` ngay sau `exec`. Prompt đi qua stdin (`-`).
  - `parseCodexExecLine(line: string, ctx: { agentId: string; open: Map<string, number> }, now: number): StreamOut`
  - `createCodexRunner(opts: { command: string; prefixArgs?: string[] }): Runner`
- Sandbox: dev dùng `workspace-write`, designer/qc dùng `read-only`. Codex không có hook, nên phạm vi file chỉ nằm trong prompt. Ghi rõ điều này trong README.

Ánh xạ event của `codex exec --json`:

| event | ra |
|---|---|
| `thread.started` | `sessionId = thread_id` |
| `item.started` có `item.type` là `command_execution` / `mcp_tool_call` / `file_change` | `call_start` tool. Name là `Bash` / `<server>.<tool>` / `Edit`. Input hash dựa trên `command` / `arguments` / `changes` |
| `item.completed` cùng id | `call_end`. `ok` = `status !== 'failed' && (exit_code ?? 0) === 0`. `file_change` thì thêm path vào `changedFiles` |
| `turn.completed` có `usage` | một call `llm`, `tokensIn = input_tokens + cached_input_tokens`, `tokensOut = output_tokens` |
| `turn.failed` hoặc `error` | `result`, `isError: true`, `text = message`, `rateLimited` theo `RATE_LIMIT_RE` |
| `item.completed` loại `agent_message` | ghi đè `text` của result thành công |

Khi tiến trình kết thúc, nếu chưa có `turn.failed` thì `result` thành công với `text` cuối cùng.

Hành vi khi nối vào server:
- `createCore` chỉ dựng runner `codex` khi `findExecutable('codex', settings.codexPath)` khác null.
- Khi đã đăng ký một `sessionId` từ `thread.started`, runner gọi `sink.events` với event `agent` để cập nhật `sessionId`. Orchestrator gọi `store.dropAgent('codex:<threadId>')` để xoá bản mà codex watcher có thể đã ghi trước khi id được đăng ký.

- [ ] **Step 1: Viết tay fixture** `tests/fixtures/codex/exec.jsonl` theo bảng trên:
  1. `thread.started`
  2. `item.started` + `item.completed` của `command_execution`, `exit_code: 0`
  3. Một cặp như trên với `exit_code: 1`
  4. `file_change` có `changes: [{path: 'src/a.ts', kind: 'update'}]`
  5. `agent_message`
  6. `turn.completed` có `usage`
- [ ] **Step 2: Viết test hỏng:**
  - `parseCodexExecLine` trên fixture: 2 call Bash (một ok, một lỗi), 1 call Edit, 1 call `llm` với token đúng, `changedFiles = ['src/a.ts']`.
  - `buildCodexArgs` khi `resume`: có `resume <id>` ngay sau `exec`, có `--sandbox read-only` cho qc, không có cờ nào chứa `dangerously` hay `bypass`.
  - Chạy `createCodexRunner({command: process.execPath, prefixArgs: [script in fixture]})` → `done.text` là `agent_message`.
- [ ] **Step 3:** FAIL → viết code → PASS.
- [ ] **Step 4:** Cập nhật README:
  - Mục "Ticket và Controller":
    - Luồng làm việc.
    - Các lệnh CLI mới.
    - Nơi đặt worktree (`~/.acctv/worktrees`).
    - Nhánh `acctv/*`: người dùng tự merge, dashboard không bao giờ push.
    - Bảng quyền theo vai.
    - Biến `ACCTV_CLAUDE_CMD`, chỉ dùng để thử bằng runner giả.
  - "Giới hạn đã biết":
    - Codex runner viết theo tài liệu nhưng **chưa được thử với CLI thật**, và không ép được phạm vi file.
    - Lệnh Bash ghi file thì không ép được phạm vi.
    - Format stream-json không chính thức.
    - Dashboard khởi động lại thì các subagent đang chạy bị gián đoạn.
- [ ] **Step 5: Thử thật một lần** (thủ công, tốn token thật, chỉ chạy khi người dùng đồng ý lúc thực thi):
  - Tạo repo tạm có `README.md`, rồi `acctv new "Thêm dòng Hello vào README" --dir <repo>`.
  - Duyệt kế hoạch, chờ `done`.
  - Kiểm: nhánh `acctv/T-…` có commit vòng; `git -C <repo> status` sạch (repo gốc không bị đụng); `~/.claude` không có file nào bị sửa bởi dashboard; dashboard không có phiên `claude:*` trùng với các agent của ticket.
- [ ] **Step 6:** `npx vitest run` → toàn bộ PASS.
- [ ] **Step 7: Commit** `feat(p2): Codex exec runner (enabled only with codex CLI); docs`
