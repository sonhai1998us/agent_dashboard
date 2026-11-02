# Agent CCTV — Phần 1: Camera giám sát — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một server local (`acctv serve`) đọc log của mọi phiên Claude Code và Codex trên máy, chuẩn hoá thành agent + call, phát hiện kẹt/lặp/lỗi dồn dập, và hiển thị trực tiếp trên màn chính bố cục A + C. Kèm CLI `acctv ls | watch | logs`.

**Architecture:** Một tiến trình Node: custom server bọc Next.js (App Router) cho UI; `/api/*` và `/ws` do custom server tự xử lý (core không bao giờ bị Next bundle). Pipeline gồm adapter (đọc file, chỉ đọc) → parser thuần → `Store` (SQLite qua `node:sqlite`) → `DetectEngine` → `Hub` (EventEmitter) → WebSocket. Phần này **chưa có ticket hay Controller**. Đó là Phần 2, sẽ dùng lại `Store`, `Hub`, `DetectEngine`, `AgentInfo`/`CallRecord` và các component UI của phần này.

**Tech Stack:** Node 22.23 (có sẵn `node:sqlite` và `zlib.zstdDecompressSync`), TypeScript, Next.js App Router (bản stable mới nhất lúc cài) + React 19, `ws@8`, `chokidar@4`, `@tanstack/react-virtual@3`, `tsx`, `vitest@3`.

**Spec:** `docs/superpowers/specs/2026-11-02-agent-cctv-design.md`. Phần này cài §2 mục tiêu 3, 4 và 6, §7, §8, §9 (màn chính), §10 (`serve`, `ls`, `watch`, `logs`), §11.

## Global Constraints

- `~/.claude` và `~/.codex` **chỉ đọc**. Không ghi, không tạo file, không mở SQLite ở chế độ ghi (`?mode=ro` / `readOnly: true`).
- Server chỉ bind `127.0.0.1`. Cổng mặc định `4777`.
- Chạy trên Windows 11. Đường dẫn dùng `path`, không ghép chuỗi `/`.
- Chỉ hai nguồn: Claude Code và Codex. Không có OmniRoute, Copilot, Kiro, Gemini, Continue, Cursor.
- Ngưỡng mặc định (§8): **kẹt** = tiến trình còn sống, không có sự kiện mới trong 120s và không có tool nào đang chạy → `warn`. **Tool chạy lâu** = một call mở quá 300s → `warn`. **Lặp** = cùng tool + cùng input ≥ 3 lần trong 20 call gần nhất, hoặc chuỗi A→B→A→B → `warn`. ≥ 10 lần → `critical`. **Lỗi dồn dập** = ≥ 5 call thất bại liên tiếp → `critical`.
- Phiên ngoài ticket **không bao giờ bị tự dừng**. Phần 1 không dừng gì cả.
- UI: nền `#0F172A`, card `#1B2336`, viền `#334155`, chữ `#F8FAFC` / muted `#94A3B8`. Thành công `#22C55E`, thất bại `#EF4444`, đang chạy `#3B82F6`, cảnh báo `#FBBF24`, chờ `#64748B`. Fira Code cho số liệu và log, Fira Sans cho nhãn. Không glassmorphism hay blur. Trạng thái luôn kèm biểu tượng hoặc chữ. Tôn trọng `prefers-reduced-motion`. Tương phản chữ ≥ 4.5:1. Danh sách call dài phải virtualize. Luôn hiện thời điểm cập nhật cuối và trạng thái "mất kết nối".
- Nhãn giao diện bằng tiếng Việt, đúng như trong mockup `.superpowers/brainstorm/711-1793610801/content/layout-v2.html`.
- Không đưa transcript thật vào fixture test. Fixture phải tự viết, mô phỏng đúng cấu trúc ghi ở Task 3 và Task 4.

## Review Focus

1. **File transcript rất lớn khi backfill** (vài chục MB, hàng chục nghìn dòng): server không được treo hay ăn hết RAM, và UI vẫn phản hồi. Ghim bằng test đọc theo stream ở Task 5.
2. **File đang được ghi dở một dòng** lúc đọc: không được parse dòng cụt hay mất dòng. Ghim bằng test partial line ở Task 5.
3. **Định dạng log đổi giữa các phiên bản** (record lạ, thiếu field, JSON hỏng): bỏ qua, đếm `parseErrors`, không crash. UI hiện số dòng không đọc được. Ghim ở Task 3 và Task 4.
4. **Call mồ côi**: tool_result không có tool_use tương ứng (do compaction hoặc ngoài cửa sổ backfill), hoặc tool_use không bao giờ có kết quả vì phiên đã chết. Không crash, không tính "tool chạy lâu" cho agent đã dừng. Ghim ở Task 3 và Task 6.
5. **Server khởi động lại**: không nhân đôi call, đọc tiếp từ offset đã lưu. Ghim ở Task 5.

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts, .gitignore
bin/acctv.mjs                      — entry CLI (đăng ký tsx rồi import cli/acctv.ts)
src/core/model.ts                  — mọi type dùng chung
src/core/config.ts                 — loadConfig: đường dẫn, cổng, ngưỡng
src/core/store.ts                  — Store trên node:sqlite
src/core/metrics.ts                — percentile, metrics theo agent/toàn cục
src/core/hub.ts                    — Hub (EventEmitter có type)
src/core/inputHash.ts              — chuẩn hoá input + hash
src/adapters/tail.ts               — FileTailer: đọc dòng mới theo offset
src/adapters/claude/parse.ts       — parser thuần cho transcript Claude
src/adapters/claude/watch.ts       — ClaudeWatcher: quét file, liveness
src/adapters/codex/parse.ts        — parser thuần cho rollout Codex
src/adapters/codex/watch.ts        — CodexWatcher
src/detect/rules.ts                — các rule thuần
src/detect/engine.ts               — DetectEngine
src/server/core.ts                 — createCore: nối pipeline
src/server/http.ts                 — /api/* + /ws
server/index.ts                    — startServer: Next custom server
app/layout.tsx, app/globals.css, app/page.tsx
app/components/{TopBar,SessionList,AgentTimeline,AgentDetail}.tsx (+ .module.css)
app/lib/{liveStore.ts,tree.ts,lanes.ts,format.ts}
cli/acctv.ts, cli/render.ts
tests/**                           — vitest, mirror theo src/app/cli
tests/fixtures/{claude,codex}/**   — fixture tự viết
```

---

### Task 1: Khởi tạo dự án, model, config, Store

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/core/model.ts`, `src/core/config.ts`, `src/core/store.ts`, `src/core/hub.ts`
- Test: `tests/core/store.test.ts`, `tests/core/config.test.ts`

**Interfaces — Produces:**

```ts
// src/core/model.ts
export type Source = 'claude' | 'codex';
export type AgentStatus = 'running' | 'idle' | 'ended';
export interface AgentInfo {
  id: string;            // 'claude:<sessionId>' | 'claude:<sessionId>:<agentId>' | 'codex:<threadId>'
  source: Source; sessionId: string; parentId: string | null;
  label: string; role: string | null; model: string | null; effort: string | null;
  cwd: string | null; pid: number | null;
  startedAt: number; lastEventAt: number;   // epoch ms
  status: AgentStatus; parseErrors: number;
}
export interface CallRecord {
  id: string; agentId: string; kind: 'tool' | 'llm'; name: string;
  inputHash: string; inputPreview: string;   // preview ≤ 200 ký tự
  startedAt: number; endedAt: number | null; ok: boolean | null; errorPreview: string | null;
  tokensIn: number | null; tokensOut: number | null;
}
export type AlertKind = 'stuck' | 'long_tool' | 'loop' | 'error_burst';
export interface Alert { id: string; agentId: string; kind: AlertKind; level: 'warn' | 'critical';
  message: string; since: number; active: boolean; }
export type NormalizedEvent =
  | { type: 'agent'; agent: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'source' | 'sessionId'> }
  | { type: 'call_start'; call: Omit<CallRecord, 'endedAt' | 'ok' | 'errorPreview'> }
  | { type: 'call_end'; agentId: string; callId: string; endedAt: number; ok: boolean; errorPreview: string | null }
  | { type: 'activity'; agentId: string; at: number }
  | { type: 'parse_error'; agentId: string };
export type HubEvent =
  | { type: 'agent'; agent: AgentInfo } | { type: 'call'; call: CallRecord }
  | { type: 'alert'; alert: Alert };

// src/core/config.ts
export interface Thresholds { stuckMs: number; longToolMs: number; loopWindow: number;
  loopWarn: number; loopCritical: number; errorBurst: number; }
export interface Config { home: string; claudeDir: string; codexDir: string; port: number;
  host: '127.0.0.1'; backfillHours: number; thresholds: Thresholds; }
export function loadConfig(env?: NodeJS.ProcessEnv): Config;
// mặc định: home = env.ACCTV_HOME ?? ~/.acctv; claudeDir = env.ACCTV_CLAUDE_DIR ?? ~/.claude;
// codexDir = env.ACCTV_CODEX_DIR ?? ~/.codex; port 4777; backfillHours 24;
// thresholds {120000, 300000, 20, 3, 10, 5}; ghi đè từng phần bằng <home>/config.json nếu có.

// src/core/store.ts
export class Store {
  constructor(dbPath: string);              // ':memory:' cho test
  applyEvent(e: NormalizedEvent): HubEvent[];   // trả về các bản ghi đã đổi để Hub phát
  getAgent(id: string): AgentInfo | undefined;
  listAgents(opts?: { since?: number }): AgentInfo[];
  listCalls(agentId: string, opts?: { since?: number; limit?: number }): CallRecord[];  // mới nhất trước
  openCalls(agentId: string): CallRecord[];
  setAgentStatus(id: string, status: AgentStatus, pid?: number | null): AgentInfo | undefined;
  upsertAlert(a: Alert): void; activeAlerts(): Alert[];
  getOffset(file: string): { offset: number; lines: number } | undefined;
  setOffset(file: string, offset: number, lines: number): void;
  close(): void;
}

// src/core/hub.ts
export class Hub { publish(e: HubEvent): void; subscribe(fn: (e: HubEvent) => void): () => void; }
```

- [ ] **Step 1: Khởi tạo dự án.** Chạy `git init` trong `D:\Work\agent-dashboard`. `.gitignore` gồm `node_modules/`, `.next/`, `.superpowers/`, `*.db`. Tạo `package.json` (`"type": "module"`, `"engines": {"node": ">=22.13"}`, scripts `test: vitest run`, `dev: tsx server/index.ts`, `build: next build`, `start: NODE_ENV=production tsx server/index.ts` dùng `cross-env` cho Windows). Cài `next react react-dom ws chokidar @tanstack/react-virtual tsx` và dev `typescript vitest @types/node @types/react @types/ws cross-env`. Tạo `tsconfig.json` (strict, `moduleResolution: bundler`, path `@/*` → `./*`).

- [ ] **Step 2: Viết test thất bại**

```ts
// tests/core/store.test.ts
const agentEv = { type: 'agent', agent: { id: 'claude:s1', source: 'claude', sessionId: 's1', label: 'demo', startedAt: 1000, lastEventAt: 1000 } } as const;
test('call_start rồi call_end tạo một CallRecord hoàn chỉnh', () => {
  const s = new Store(':memory:'); s.applyEvent(agentEv);
  s.applyEvent({ type: 'call_start', call: { id: 'c1', agentId: 'claude:s1', kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: 'npm test', startedAt: 2000, tokensIn: null, tokensOut: null } });
  const out = s.applyEvent({ type: 'call_end', agentId: 'claude:s1', callId: 'c1', endedAt: 2500, ok: false, errorPreview: 'exit 1' });
  expect(out).toContainEqual(expect.objectContaining({ type: 'call', call: expect.objectContaining({ id: 'c1', ok: false, endedAt: 2500 }) }));
  expect(s.getAgent('claude:s1')!.lastEventAt).toBe(2500);
});
test('call_start trùng id không tạo bản ghi thứ hai', () => { /* apply 2 lần → listCalls().length === 1 */ });
test('call_end không có call_start bị bỏ qua, trả về []', () => { /* Review Focus 4 */ });
test('parse_error tăng agent.parseErrors', () => {});
test('offset lưu và đọc lại', () => { /* setOffset('f', 120, 3) → getOffset('f') = {offset:120, lines:3} */ });
test('upsertAlert cùng id cập nhật; activeAlerts chỉ trả active', () => {});
// tests/core/config.test.ts
test('mặc định đúng spec', () => { const c = loadConfig({ ACCTV_HOME: tmp }); expect(c.thresholds).toEqual({ stuckMs: 120000, longToolMs: 300000, loopWindow: 20, loopWarn: 3, loopCritical: 10, errorBurst: 5 }); expect(c.host).toBe('127.0.0.1'); expect(c.port).toBe(4777); });
test('config.json ghi đè một phần thresholds', () => {});
```

- [ ] **Step 3: Chạy `npx vitest run tests/core`**. Kỳ vọng: FAIL (module chưa có).
- [ ] **Step 4: Cài đặt** `model.ts`, `config.ts`, `hub.ts`, `store.ts`. Store dùng `DatabaseSync` của `node:sqlite` với các bảng `agents`, `calls` (PK `id`, index `(agent_id, started_at)`), `alerts`, `offsets`. `call_start` dùng `INSERT OR IGNORE`. Mỗi event có timestamp đều nâng `agents.last_event_at = max(...)`.
- [ ] **Step 5: Chạy `npx vitest run tests/core`**. Kỳ vọng: PASS.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: project setup, core model, config and store"`

---

### Task 2: Metrics và hash input

**Files:** Create `src/core/metrics.ts`, `src/core/inputHash.ts`. Test `tests/core/metrics.test.ts`, `tests/core/inputHash.test.ts`

**Interfaces — Produces:**

```ts
export function percentile(values: number[], p: number): number | null;   // nearest-rank, [] → null
export interface AgentMetrics { calls: number; errors: number; okRate: number | null;
  p50: number | null; p95: number | null; tokensIn: number; tokensOut: number; durationMs: number; }
export function agentMetrics(agent: AgentInfo, calls: CallRecord[], now: number): AgentMetrics;
// calls/errors/p50/p95 chỉ tính kind='tool' đã kết thúc; tokens cộng mọi kind='llm';
// durationMs = (status==='running' ? now : lastEventAt) - startedAt
export interface GlobalMetrics { running: number; alerts: number; okRate1h: number | null; p50_1h: number | null; }
export function globalMetrics(agents: AgentInfo[], recentCalls: CallRecord[], alerts: Alert[], now: number): GlobalMetrics;
export function inputHash(toolName: string, input: unknown): { hash: string; preview: string };
// chuẩn hoá: string → trim + gộp whitespace; object → JSON với key sắp xếp đệ quy; hash = sha1(toolName+'\0'+norm) 12 ký tự hex
```

- [ ] **Step 1: Viết test thất bại**

```ts
test('percentile nearest-rank', () => { expect(percentile([1,2,3,4,5,6,7,8,9,10], 50)).toBe(5); expect(percentile([1,2,3,4,5,6,7,8,9,10], 95)).toBe(10); expect(percentile([], 50)).toBeNull(); });
test('agentMetrics bỏ qua call chưa kết thúc khi tính latency', () => {});
test('agentMetrics cộng token từ llm call', () => {});
test('inputHash không phụ thuộc thứ tự key và khoảng trắng', () => {
  expect(inputHash('Bash', { command: 'npm  test', timeout: 1 }).hash).toBe(inputHash('Bash', { timeout: 1, command: 'npm test ' }).hash);
  expect(inputHash('Bash', { command: 'npm test' }).hash).not.toBe(inputHash('Read', { command: 'npm test' }).hash);
});
test('preview cắt ở 200 ký tự', () => {});
```

- [ ] **Step 2: Chạy** `npx vitest run tests/core`. Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt** hai module.
- [ ] **Step 4: Chạy lại.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat: metrics and input hashing`

---

### Task 3: Parser transcript Claude

**Files:** Create `src/adapters/claude/parse.ts`. Test `tests/adapters/claude-parse.test.ts`, fixtures `tests/fixtures/claude/main.jsonl`, `tests/fixtures/claude/sub.jsonl`, `tests/fixtures/claude/sub.meta.json`

**Định dạng thật đã quan sát được** (mỗi dòng một JSON):
- `type: 'assistant'`: `timestamp` (ISO), `sessionId`, `cwd`, `isSidechain`, `agentId?` (chỉ có ở subagent), `effort?`, `message.model`, `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`, `message.content[]` gồm các block `{type:'tool_use', id, name, input}` | `text` | `thinking`.
- `type: 'user'`: `message.content` là string hoặc mảng block `{type:'tool_result', tool_use_id, content, is_error?}`.
- `type: 'custom-title'` → `customTitle`. `type: 'agent-name'` → `agentName`. Mọi `type` khác (attachment, system, api-request, queue-operation, file-history-snapshot, …) → chỉ sinh `activity` nếu có `timestamp`, ngược lại bỏ qua.
- Transcript chính: `<claudeDir>/projects/<projDir>/<sessionId>.jsonl`. Subagent: `<claudeDir>/projects/<projDir>/<sessionId>/subagents/agent-<agentId>.jsonl`, kèm `agent-<agentId>.meta.json` = `{agentType, description, toolUseId, …}`.

**Interfaces — Produces:**

```ts
export interface ClaudeFileCtx { agentId: string; sessionId: string; parentId: string | null;
  role: string | null; label: string | null; lastTs: number | null; }
export function claudeCtxForPath(file: string, claudeDir: string, meta?: { agentType?: string; description?: string }): ClaudeFileCtx;
export function parseClaudeLine(line: string, ctx: ClaudeFileCtx): NormalizedEvent[];   // cập nhật ctx.lastTs
```

Quy tắc:
- Dòng đầu có `timestamp` sinh `agent` event (`startedAt`, `cwd`, `label`).
- Label: `customTitle`, `agentName`, `meta.description`, hoặc tên thư mục cuối của `cwd`, lấy cái đầu tiên có.
- Subagent: `role = meta.agentType`, `parentId = 'claude:<sessionId>'`.
- `assistant` sinh `llm` call: `id = message.id ?? uuid`, `startedAt = ctx.lastTs ?? ts`, `endedAt = ts`, `ok = true`, `tokensIn = input + cache_creation + cache_read`, `tokensOut = output_tokens`. Một `message.id` có thể trải qua nhiều dòng, nên chỉ dòng có `usage` lớn nhất được tính, dựa vào `INSERT OR IGNORE` cộng thêm việc gộp theo id ở phía parser. Kèm `agent` event cập nhật `model` và `effort`.
- Mỗi `tool_use` sinh `call_start` (`id = block.id`, `name`, `inputHash` từ Task 2).
- Mỗi `tool_result` sinh `call_end` (`ok = !is_error`, `errorPreview` = 200 ký tự đầu của content khi lỗi).
- JSON hỏng hoặc thiếu `type` sinh `parse_error`.

- [ ] **Step 1: Viết fixture** theo đúng định dạng trên: 1 phiên chính có `custom-title`; 3 tool_use Bash cùng `npm test`, trong đó 2 cái có `is_error: true`; 1 dòng JSON hỏng; 1 record `type: 'weird-new-type'`; 1 tool_result mồ côi. Thêm 1 subagent kèm meta `{agentType: 'office-dev', description: 'WP-1'}`.
- [ ] **Step 2: Viết test thất bại**

```ts
test('tool_use/tool_result thành call_start/call_end, is_error → ok=false', () => {});
test('assistant usage → llm call, tokensIn gồm cache tokens', () => { /* 2 + 36239 + 0 */ });
test('subagent: id claude:<sid>:<agentId>, parentId claude:<sid>, role office-dev', () => {});
test('custom-title đặt label', () => {});
test('dòng JSON hỏng → parse_error, record lạ → không ném lỗi', () => {});
test('tool_result mồ côi vẫn sinh call_end (Store sẽ bỏ qua)', () => {});
```

- [ ] **Step 3: Chạy** `npx vitest run tests/adapters`. Kỳ vọng: FAIL.
- [ ] **Step 4: Cài đặt** `parse.ts`.
- [ ] **Step 5: Chạy lại.** Kỳ vọng: PASS.
- [ ] **Step 6: Commit** `feat: claude transcript parser`

---

### Task 4: Parser rollout Codex

**Files:** Create `src/adapters/codex/parse.ts`. Test `tests/adapters/codex-parse.test.ts`, fixture `tests/fixtures/codex/rollout.jsonl`

**Định dạng thật đã quan sát được:** mỗi dòng có dạng `{timestamp, type, payload}`. File nằm ở `<codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl.zst` (nén zstd) hoặc `.jsonl`.
- `session_meta`: `payload.{id, session_id, parent_thread_id?, cwd}`.
- `event_msg` với `payload.type = 'thread_settings_applied'`: lấy `payload.thread_settings.model`. Với `turn_context`: lấy `payload.cwd`, và nếu có thì `payload.model` / `payload.effort`.
- `response_item` với `payload.type = 'function_call'` → `{name, arguments (string JSON), call_id}`. Với `'custom_tool_call'` → `{name, input, call_id}`.
- `response_item` với `payload.type = 'function_call_output' | 'custom_tool_call_output'` → `{call_id, output}`. `output` bắt đầu bằng `Exit code: N`: `ok = N === 0`. Không có dòng đó thì `ok = true`.
- `token_usage_record`: `payload.usage.{input_tokens, output_tokens}` → `llm` call (`id = payload.response_id`).
- `event_msg` với `task_complete` → `activity`. Mọi loại khác → `activity`.

**Interfaces — Produces:**

```ts
export interface CodexFileCtx { agentId: string | null; lastTs: number | null; turnOpen: boolean; }
// task_started → turnOpen = true; task_complete | turn_aborted → false (watcher dùng cho liveness ở Task 5)
export function parseCodexLine(line: string, ctx: CodexFileCtx): NormalizedEvent[];
// agentId = 'codex:' + session_meta.payload.id; parentId = parent_thread_id ? 'codex:'+parent_thread_id : null
// trước khi gặp session_meta: mọi dòng bị bỏ qua (ctx.agentId null)
```

- [ ] **Step 1: Viết fixture** gồm `session_meta` có `parent_thread_id`, `thread_settings_applied`, 1 function_call `shell_command` với output `Exit code: 1`, 1 `custom_tool_call` `apply_patch` với output `Exit code: 0`, 1 `token_usage_record`, và 1 dòng hỏng.
- [ ] **Step 2: Viết test thất bại**

```ts
test('function_call + output Exit code: 1 → ok=false', () => {});
test('custom_tool_call apply_patch → ok=true', () => {});
test('session_meta parent_thread_id → parentId', () => {});
test('thread_settings_applied → model', () => {});
test('token_usage_record → llm call với tokens', () => {});
test('dòng hỏng → parse_error, không ném lỗi', () => {});
```

- [ ] **Step 3–5:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 6: Commit** `feat: codex rollout parser`

---

### Task 5: Đọc file theo offset và watcher hai nguồn

**Files:** Create `src/adapters/tail.ts`, `src/adapters/claude/watch.ts`, `src/adapters/codex/watch.ts`. Test `tests/adapters/tail.test.ts`, `tests/adapters/watch.test.ts`

**Interfaces — Produces:**

```ts
// tail.ts
export async function readNewLines(file: string, from: { offset: number; lines: number }):
  Promise<{ lines: string[]; offset: number; lineCount: number }>;
// .jsonl: đọc bằng stream từ offset, chỉ trả các dòng đã có '\n'; offset = byte cuối của dòng đầy đủ cuối;
//         kích thước file < offset → đọc lại từ 0
// .jsonl.zst: zstdDecompressSync cả file, bỏ qua from.lines dòng đầu; offset = kích thước file nén

export interface Watcher { start(): Promise<void>; stop(): Promise<void>; }
export function createClaudeWatcher(cfg: Config, store: Store, onEvents: (evs: HubEvent[]) => void): Watcher;
export function createCodexWatcher(cfg: Config, store: Store, onEvents: (evs: HubEvent[]) => void): Watcher;
```

Hành vi:
- **Backfill**: chỉ lấy các file có mtime trong vòng `backfillHours`.
- **Theo dõi file**: dùng `chokidar` theo dõi `<claudeDir>/projects` và `<codexDir>/sessions`, có `awaitWriteFinish: false`. Mỗi file chỉ đọc một lần tại một thời điểm, dùng hàng đợi theo file. Sau khi đọc thì lưu offset vào Store.
- **Liveness Claude**: cứ 5s đọc `<claudeDir>/sessions/*.json`, rồi kiểm `process.kill(pid, 0)`. Còn sống thì set `running` cho `claude:<sessionId>` và các subagent có `lastEventAt` trong 10 phút gần nhất. Còn lại set `ended`.
- **Liveness Codex**: `running` nếu file được ghi trong 120s gần nhất và chưa có `task_complete` sau `task_started` cuối. Ngược lại là `idle`, và sau 30 phút thì thành `ended`.
- Mọi lỗi đọc file đều ghi log rồi bỏ qua, không làm chết watcher.

- [ ] **Step 1: Viết test thất bại**

```ts
test('dòng cụt chưa có \\n không được trả; lần đọc sau trả đủ', async () => { /* Review Focus 2 */ });
test('file bị cắt ngắn → đọc lại từ 0', async () => {});
test('file 50.000 dòng đọc xong < 3s và không dùng readFileSync', async () => { /* Review Focus 1: spy fs.readFileSync không được gọi cho .jsonl */ });
test('.jsonl.zst: chỉ trả các dòng mới sau from.lines', async () => { /* tạo bằng zlib.zstdCompressSync */ });
test('watcher Claude: ghi fixture vào thư mục tạm → Store có agent + call', async () => {});
test('khởi động lại watcher với cùng DB → không nhân đôi call', async () => { /* Review Focus 5 */ });
test('sessions/<pid>.json với pid = process.pid → agent running', async () => {});
test('watcher không bao giờ ghi vào claudeDir/codexDir', async () => { /* so sánh danh sách file + mtime trước/sau */ });
```

- [ ] **Step 2: Chạy** `npx vitest run tests/adapters`. Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt** `tail.ts` (dùng `fs.createReadStream({start})` và tự cắt theo `\n`). Sau đó cài hai watcher.
- [ ] **Step 4: Chạy lại.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat: file tailer and claude/codex watchers`

---

### Task 6: Phát hiện kẹt, lặp, lỗi

**Files:** Create `src/detect/rules.ts`, `src/detect/engine.ts`. Test `tests/detect/rules.test.ts`, `tests/detect/engine.test.ts`

**Interfaces — Produces:**

```ts
// rules.ts — thuần, calls sắp theo startedAt tăng dần
export function detectStuck(a: AgentInfo, open: CallRecord[], now: number, t: Thresholds): Alert | null;
export function detectLongTool(a: AgentInfo, open: CallRecord[], now: number, t: Thresholds): Alert | null;
export function detectLoop(a: AgentInfo, recentTools: CallRecord[], t: Thresholds): Alert | null;
export function detectErrorBurst(a: AgentInfo, recentTools: CallRecord[], t: Thresholds): Alert | null;
// Alert.id = `${agentId}:${kind}`; message tiếng Việt, ví dụ "lặp 6× Bash npm test", "im lặng 3m12s", "5 call lỗi liên tiếp"

// engine.ts
export class DetectEngine {
  constructor(store: Store, cfg: Config, publish: (e: HubEvent) => void);
  onCall(agentId: string): void;   // gọi lại loop + error_burst cho agent đó
  tick(now: number): void;         // mỗi 5s: stuck + long_tool cho agent running; tắt alert đã hết điều kiện
}
```

Quy tắc lặp (thuật toán không suy ra được từ signature):

```
khoá = name + ':' + inputHash; xét 20 tool call gần nhất (loopWindow)
n1 = số lần xuất hiện nhiều nhất của một khoá
n2 = số lần lặp liên tiếp của cặp (k_i, k_{i+1}) với k_i ≠ k_{i+1} ở cuối chuỗi (A→B→A→B…), tính theo cặp
n = max(n1, n2); n ≥ loopCritical → critical; n ≥ loopWarn → warn; ngược lại null
```

- [ ] **Step 1: Viết test thất bại**

```ts
test('kẹt: running, 121s không sự kiện, không call mở → warn', () => {});
test('không kẹt khi có call đang mở (đó là long_tool)', () => {});
test('long_tool: call mở 301s ở agent running → warn; agent ended → null', () => { /* Review Focus 4 */ });
test('lặp: 3 lần Bash npm test trong 20 call → warn; 10 lần → critical; 2 lần → null', () => {});
test('lặp A→B→A→B→A→B → warn', () => {});
test('lỗi dồn dập: 5 lỗi liên tiếp → critical; 4 lỗi + 1 ok → null', () => {});
test('engine: hết điều kiện → alert active=false được publish', () => {});
test('engine không bao giờ dừng agent (chỉ cảnh báo)', () => {});
```

- [ ] **Step 2–4:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 5: Commit** `feat: stuck/loop/error detection`

---

### Task 7: Core, HTTP API, WebSocket, Next custom server

**Files:** Create `src/server/core.ts`, `src/server/http.ts`, `server/index.ts`, `next.config.ts`. Test `tests/server/api.test.ts`

**Interfaces — Produces:**

```ts
export interface Core { cfg: Config; store: Store; hub: Hub; engine: DetectEngine; stop(): Promise<void>; }
export async function createCore(cfg: Config): Promise<Core>;   // DB ở <home>/acctv.db, khởi động 2 watcher, tick mỗi 5s
export function attachApi(server: http.Server, core: Core): (req, res) => boolean; // trả true nếu đã xử lý
export async function startServer(opts?: { cfg?: Config; dev?: boolean; withNext?: boolean }): Promise<{ url: string; close(): Promise<void> }>;
```

API (JSON):
- `GET /api/snapshot` → `{ generatedAt, agents: AgentInfo[] (lastEventAt trong 24h), alerts: Alert[], metrics: GlobalMetrics, agentMetrics: Record<id, AgentMetrics> }`
- `GET /api/agents/:id/calls?since=<ms>&limit=<n≤2000>` → `CallRecord[]`
- `WS /ws` → server đẩy `HubEvent` (JSON). Cứ 5s gửi thêm `{type:'metrics', metrics, at}`. Client không gửi gì.
- Mọi request có header `Host` khác `127.0.0.1:<port>` hoặc `localhost:<port>` đều nhận 403, để chặn DNS rebinding.

`server/index.ts` gọi `next({ dev })`. Request `/api/*` thì `attachApi` xử lý trước, còn lại chuyển cho Next. Sự kiện `upgrade` với path `/ws` thì vào `ws`, path khác (HMR) chuyển cho Next. Bind `cfg.host`.

- [ ] **Step 1: Viết test thất bại** (chạy `startServer({ withNext: false })` với `ACCTV_*` trỏ vào thư mục tạm, port 0)

```ts
test('GET /api/snapshot trả agent sau khi ghi fixture Claude', async () => {});
test('WS nhận {type:"call"} khi có dòng tool_use mới', async () => {});
test('Host lạ → 403', async () => {});
test('server chỉ listen 127.0.0.1', async () => { /* server.address().address === '127.0.0.1' */ });
```

- [ ] **Step 2–4:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 5: Commit** `feat: core pipeline, api, websocket, next custom server`

---

### Task 8: Khung UI, token, thanh trên, danh sách phiên, live store

**Files:** Create `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `app/components/TopBar.tsx`, `app/components/SessionList.tsx`, `app/lib/liveStore.ts`, `app/lib/tree.ts`, `app/lib/format.ts`. Test `tests/app/tree.test.ts`, `tests/app/liveStore.test.ts`, `tests/app/format.test.ts`

**Interfaces — Produces:**

```ts
// app/lib/liveStore.ts — store phía client (useSyncExternalStore)
export type ConnState = 'connecting' | 'live' | 'disconnected';
export interface LiveState { conn: ConnState; lastUpdateAt: number | null; agents: Record<string, AgentInfo>;
  alerts: Record<string, Alert>; metrics: GlobalMetrics | null; agentMetrics: Record<string, AgentMetrics>;
  calls: Record<string, CallRecord[]>; selectedAgentId: string | null; }
export function reduce(s: LiveState, e: HubEvent | { type: 'metrics'; metrics: GlobalMetrics; at: number } | { type: 'conn'; conn: ConnState }): LiveState;
export function useLive<T>(sel: (s: LiveState) => T): T;
export function selectAgent(id: string): void;     // nạp /api/agents/:id/calls nếu chưa có
// WS mất kết nối → conn 'disconnected', tự nối lại với backoff 1s→2s→5s→10s; khi nối lại nạp lại /api/snapshot

// app/lib/tree.ts
export interface TreeNode { agent: AgentInfo; depth: number; isLast: boolean; }
export function buildRoots(agents: AgentInfo[]): { session: AgentInfo; children: AgentInfo[] }[];  // gốc = parentId null, sắp: running trước, rồi lastEventAt giảm dần
export function flattenTree(root: AgentInfo, all: AgentInfo[]): TreeNode[];

// app/lib/format.ts
export function fmtDuration(ms: number): string;   // 41000 → "41s", 207000 → "3m27", 3600000 → "1h00m"
export function fmtTokens(n: number): string;      // 212345 → "212k"
export function fmtClock(ms: number): string;      // "14:02:11" theo giờ máy
```

UI:
- **`TopBar`** hiện, từ trái sang phải: số đang chạy, số cảnh báo, "call ok · 1h", "p50 latency", và một nhãn kết nối ("● trực tiếp · cập nhật 14:03:48" khi live, "○ mất kết nối · dữ liệu lúc 14:03:48" kèm màu cảnh báo khi disconnected). Phần 1 **chưa có** nút "+ Ticket mới" và mục "chờ duyệt"; Phần 2 thêm vào.
- **`SessionList`** (cột trái) có tiêu đề "Phiên". Mỗi dòng gồm chấm trạng thái + biểu tượng (●/▲/○), nguồn (`claude`/`codex`), label và tên thư mục dự án. Có ô lọc theo nguồn và theo trạng thái đang chạy. Dòng được chọn có nền `#16203a`.
- **Bố cục** ba cột `170px 1fr 240px` từ 1280px trở lên. Dưới 1024px thì cột phải chuyển xuống dưới, còn cột trái thành một select.

- [ ] **Step 1: Viết test thất bại**

```ts
test('reduce: call event chèn vào calls[agentId] theo id, không nhân đôi', () => {});
test('reduce: conn disconnected giữ nguyên dữ liệu, lastUpdateAt không đổi', () => {});
test('buildRoots: subagent nằm dưới phiên cha; phiên running lên đầu', () => {});
test('fmtDuration', () => { expect(fmtDuration(41000)).toBe('41s'); expect(fmtDuration(207000)).toBe('3m27'); });
```

- [ ] **Step 2–4:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 5: Kiểm tra bằng mắt.** Chạy `npm run dev`, mở `http://127.0.0.1:4777`. Phiên Claude hiện tại phải có trong danh sách. Tắt server thì nhãn đổi sang "mất kết nối".
- [ ] **Step 6: Commit** `feat: ui shell, top bar, session list, live store`

---

### Task 9: Cây agent và làn thời gian (cột giữa)

**Files:** Create `app/components/AgentTimeline.tsx` (+ `.module.css`), `app/lib/lanes.ts`. Test `tests/app/lanes.test.ts`

**Interfaces — Produces:**

```ts
export type BarState = 'ok' | 'error' | 'running' | 'unknown';
export interface Bar { callId: string; x: number; w: number; state: BarState; title: string; }
export interface LoopZone { x: number; w: number; }
export function layoutLane(calls: CallRecord[], agent: AgentInfo, win: { start: number; end: number }, width: number, alerts: Alert[]): { bars: Bar[]; loopZones: LoopZone[] };
// chỉ kind='tool'; call cắt theo cửa sổ; w tối thiểu 2px; call mở: running nếu agent running, ngược lại 'unknown' (xám)
// loopZones: từ lần xuất hiện đầu đến cuối của khoá lặp khi có alert loop active cho agent
export const WINDOWS_MIN = [1, 5, 15, 60] as const;   // mặc định 5
```

UI (theo `layout-v2.html`):
- Tiêu đề: label phiên, nguồn, thư mục, và nút chọn cửa sổ thời gian "1 · 5 · 15 · 60 phút".
- Trục thời gian có 4 mốc.
- Mỗi dòng gồm cột trái 260px (ký tự cây `├`/`└`, pill trạng thái kèm biểu tượng, `model · effort` bằng Fira Code) và một làn SVG bên phải.
- Màu thanh: ok `#22C55E`, lỗi `#EF4444`, đang chạy `#3B82F6`, unknown `#64748B`. Vùng lặp tô sọc vàng. Có vạch "bây giờ".
- Click một dòng thì `selectAgent`. Click một thanh thì chọn agent đó và cuộn cột phải tới call đó. Rê chuột hoặc focus vào thanh thì hiện tooltip (tên tool, input rút gọn, thời gian chạy).
- Có chú giải màu bên dưới.
- Điều khiển bằng bàn phím: ↑/↓ chuyển dòng, Enter để chọn.
- Làn được vẽ lại tối đa 1 lần mỗi giây.

- [ ] **Step 1: Viết test thất bại**

```ts
test('call 2 phút trong cửa sổ 5 phút, width 500 → w = 200', () => {});
test('call mở ở agent ended → state unknown', () => {});
test('call ngắn → w tối thiểu 2', () => {});
test('loop alert active → có loopZone', () => {});
```

- [ ] **Step 2–4:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 5: Kiểm tra bằng mắt** với phiên thật có subagent. Dùng một phiên `/office` cũ trong `uniscore-client` nếu nó còn trong cửa sổ backfill, nếu không thì tăng `backfillHours` trong config.
- [ ] **Step 6: Commit** `feat: agent tree with timeline lanes`

---

### Task 10: Chi tiết agent (cột phải)

**Files:** Create `app/components/AgentDetail.tsx` (+ `.module.css`). Test `tests/app/detail.test.ts`

**Interfaces — Produces:**

```ts
export function topRepeatedError(calls: CallRecord[]): { preview: string; count: number } | null;  // errorPreview giống nhau nhiều nhất, count ≥ 2
```

UI:
- Tiêu đề "<label> · trực tiếp" kèm pill cảnh báo đang active (ví dụ "▲ lặp 3×").
- Dòng phụ hiện role, cwd và model · effort.
- Danh sách call mới nhất ở trên. Mỗi dòng gồm `fmtClock`, tên tool, input rút gọn, và ✓/✗/… kèm thời gian chạy. Danh sách được virtualize bằng `@tanstack/react-virtual`. Click một dòng thì mở rộng xem input/error đầy đủ.
- Dòng "Lỗi lặp lại: …" lấy từ `topRepeatedError`.
- Lưới số liệu: call, lỗi, p50, p95, token, thời gian.
- Nếu `parseErrors > 0`: hiện "N dòng log không đọc được" (Review Focus 3).
- Phần 1 **không có nút Dừng**. Chỗ đó để trống cho Phần 2.
- Chưa chọn agent nào: hiện trạng thái trống "Chọn một agent để xem trực tiếp".

- [ ] **Step 1: Viết test thất bại**

```ts
test('topRepeatedError lấy lỗi xuất hiện nhiều nhất, ≥2 lần', () => {});
test('topRepeatedError: không có lỗi lặp → null', () => {});
```

- [ ] **Step 2–4:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 5: Kiểm tra bằng mắt.** Chọn phiên Claude hiện tại: call mới phải hiện trong vòng ~2s. Kiểm cuộn 2.000 call không giật. Bật `prefers-reduced-motion` để kiểm không còn animation.
- [ ] **Step 6: Commit** `feat: live agent detail panel`

---

### Task 11: CLI `acctv`

**Files:** Create `bin/acctv.mjs`, `cli/acctv.ts`, `cli/render.ts`; Modify `package.json` (thêm `"bin": {"acctv": "bin/acctv.mjs"}`). Test `tests/cli/render.test.ts`, `tests/cli/cli.test.ts`

**Interfaces — Produces:**

```ts
// cli/render.ts — thuần, trả chuỗi (có màu ANSI khi color=true)
export function renderList(agents: AgentInfo[], alerts: Alert[], color: boolean): string;
// mỗi dòng: biểu tượng trạng thái, id rút gọn (8 ký tự đầu của sessionId), nguồn, label, số call, cảnh báo
export function renderWatch(root: AgentInfo, all: AgentInfo[], calls: Record<string, CallRecord[]>, alerts: Alert[], width: number, color: boolean): string;
// cây agent + 10 call gần nhất của agent có hoạt động mới nhất
```

Lệnh:

| Lệnh | Việc |
|---|---|
| `acctv serve [--port N] [--dev]` | Gọi `startServer`, in URL |
| `acctv ls [--running]` | GET `/api/snapshot` → `renderList` |
| `acctv watch <id-prefix>` | Nối `/ws`, vẽ lại `renderWatch` (xoá màn bằng ANSI) tối đa 4 lần/giây. Ctrl+C để thoát |
| `acctv logs <id-prefix> [-n 50]` | In call của agent, mới nhất ở cuối |

- `id-prefix` khớp với prefix của `sessionId` hoặc `agentId`. Khớp nhiều agent thì liệt kê ra rồi exit 1.
- Server chưa chạy thì in `Server chưa chạy. Bật bằng: acctv serve` và exit 1.
- `bin/acctv.mjs` dùng `tsx/esm/api` `register()` rồi `import('../cli/acctv.ts')`.

- [ ] **Step 1: Viết test thất bại**

```ts
test('renderList hiện ▲ cho agent có alert warn và không có ANSI khi color=false', () => {});
test('renderWatch hiện cây ├/└ và 10 call gần nhất', () => {});
test('ls khi server không chạy → exit 1 với thông báo hướng dẫn', async () => {});
test('logs với prefix trùng nhiều agent → liệt kê và exit 1', async () => {});
```

- [ ] **Step 2–4:** Chạy (FAIL), cài đặt, chạy lại (PASS).
- [ ] **Step 5: Kiểm tra thật.** Chạy `npm link`, rồi `acctv serve` ở một terminal. Ở terminal khác chạy `acctv ls --running` (phải thấy phiên Claude hiện tại) và `acctv watch <prefix>` (phải thấy call mới xuất hiện).
- [ ] **Step 6: Commit** `feat: acctv cli (serve, ls, watch, logs)`

---

### Task 12: Kiểm tra toàn bộ với dữ liệu thật

**Files:** Create `README.md` (cách chạy, biến `ACCTV_*`, giới hạn đã biết).

- [ ] **Step 1:** Chạy `npm test` → tất cả PASS. Chạy `npx tsc --noEmit` → không lỗi. Chạy `npm run build` → thành công.
- [ ] **Step 2:** Chạy `npm start`, mở UI. Kiểm từng mục:
  - (a) phiên Claude hiện tại ở trạng thái running, có call mới trong ~2s;
  - (b) subagent của một phiên nằm đúng dưới phiên cha;
  - (c) phiên Codex cũ hiện được khi tăng `backfillHours`;
  - (d) tạo một phiên Claude thử, cho nó chạy `Bash` cùng một lệnh 3 lần → cảnh báo lặp xuất hiện, vùng lặp tô sọc vàng;
  - (e) tắt rồi bật lại server → không có call trùng;
  - (f) chạy lại lệnh liệt kê mtime ở `~/.claude`, `~/.codex` trước và sau → không có file nào do acctv tạo hay sửa.
- [ ] **Step 3:** Ghi "Giới hạn đã biết" vào README: định dạng log không chính thức; Codex chỉ theo dõi, chưa chạy được; chưa có ticket hay Controller (Phần 2).
- [ ] **Step 4: Commit** `docs: readme and verification notes`

---

## Phần 2 (kế hoạch riêng, viết sau khi Phần 1 xong)

Ticket và state machine (§5), Controller chạy theo bước bằng `--resume` cùng MCP server (`propose_plan`, `spawn_agent`, `wait_agents`, `get_agent_log`, `finish`), runner cho Claude (và Codex khi có CLI), quyền theo vai cùng hook `PreToolUse` ép phạm vi file, worktree mỗi ticket kèm snapshot commit mỗi vòng, Dừng → trả Controller, tự dừng khi lặp ≥ 10, hàng đợi tối đa 3 agent, trạng thái rate limit, màn tạo ticket, duyệt kế hoạch, lịch sử và Settings (gồm ngưỡng cảnh báo, model mặc định, bảng giá để ước tính chi phí), chế độ sáng (ưu tiên thấp), và các lệnh CLI `new | plan | approve | revise | stop`. Phần 2 dùng lại `Store`, `Hub`, `DetectEngine`, `AgentInfo`/`CallRecord`, `liveStore` và ba component màn chính của Phần 1. Agent do dashboard chạy sẽ được nạp vào cùng pipeline qua stdout stream-json, không qua file watcher.
