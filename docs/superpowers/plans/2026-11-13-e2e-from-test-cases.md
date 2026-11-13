# Test e2e sinh từ test case — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khi dự án có `playwright.config.*`, Dev viết `e2e/<mã ticket>.spec.ts` từ các TC, Dev/QC chạy nó trên server preview bằng tool `run_e2e`; người dùng chạy lại bộ e2e trên staging lúc release.

**Architecture:** `PreviewManager.runE2e` dùng lại vòng đời server preview của capture (acquire → ensure → release), chạy `npx playwright test` bằng argv (không qua shell) với `BASE_URL` = preview và tài khoản test qua env. Orchestrator mở tool MCP `run_e2e` cho Dev/QC review khi worktree có cấu hình Playwright; prompt Controller/Dev/QC được bật theo cờ `e2e`.

**Tech Stack:** TypeScript, node:child_process, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-e2e-from-test-cases-design.md`

## Global Constraints

- Bật khi worktree có `playwright.config.ts|js|mjs|cjs`; không có thì không tool, không chữ nào về e2e trong prompt.
- `run_e2e` chỉ nhận file trong `e2e/`, đuôi `.spec.ts`/`.spec.js`, nằm trong worktree; dành cho runner claude, vai dev và qc (không QC `mode: "cases"`, không designer/explorer).
- Env khi chạy: `childEnv()` + `BASE_URL=http://localhost:<port>` + mỗi tài khoản test `E2E_<NAME>_USER` / `E2E_<NAME>_PASS` (NAME: viết hoa, ký tự không phải chữ/số → `_`).
- Mật khẩu tài khoản không bao giờ xuất hiện trong kết quả trả về (dùng `redact` có sẵn).
- Lỗi trả về dạng `[e2e:<mã>] …` với mã như capture (`invalid_args`, `not_configured`, `server_failed`, `busy_cancelled`).
- Prompt tiếng Việt, theo giọng `src/orchestrator/prompts.ts`.

## Review Focus

1. `file` là `../x.spec.ts`, đường dẫn tuyệt đối, `src/a.spec.ts`, hay file không tồn tại → `[e2e:invalid_args]`, không chạy gì. → test Task 1.
2. `grep` chứa ký tự shell (`"; rm -rf ~"`) → đi nguyên văn thành một phần tử argv, không qua shell. → test Task 1.
3. Output của playwright có in mật khẩu tài khoản → kết quả trả về đã bị che. → test Task 1.
4. Worktree không có `playwright.config.*` → Dev/QC không có `run_e2e`, prompt Controller/Dev/QC không nhắc e2e. → test Task 2, Task 3.
5. QC `mode: "cases"`, designer, runner codex, không có preview → không có `run_e2e` (tool CLI lẫn MCP worker). → test Task 2.

---

### Task 1: `PreviewManager.runE2e`

**Files:**
- Modify: `src/preview/manager.ts` (method mới, deps `exec?`), `src/preview/dbReset.ts` (hàm `runArgs`), `src/preview/captureArgs.ts` (`formatError` nhận tiền tố, mặc định `capture`)
- Test: `tests/preview/manager.test.ts`

**Interfaces:**
- Produces:
  - `export interface E2eRequest { ticketId: string; agentId: string; worktree: string; projectDir: string; mode: 'dev' | 'prod'; file: unknown; grep?: unknown }` (manager.ts)
  - `PreviewManager.runE2e(req: E2eRequest): Promise<{ text: string; isError?: boolean }>`
  - `PreviewManagerDeps.exec?: (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; tail: string }>`; mặc định `runArgs`.
  - `runArgs(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, keep = 6000): Promise<{ code: number | null; tail: string }>` (dbReset.ts; `spawn` không `shell`, kill cây tiến trình khi quá hạn như `runShell`).
  - `E2E_TIMEOUT_MS = 600_000`.

- [ ] **Step 1: Write failing tests** (dùng fixture `setup()` có sẵn trong `manager.test.ts`, truyền `exec` giả ghi lại lời gọi; worktree tạm có `e2e/T-1.spec.ts`)
  - `runE2e: chạy npx playwright test <file> trong worktree, BASE_URL = server preview, tài khoản qua env` — exec nhận `('npx', ['playwright','test','e2e/T-1.spec.ts','--reporter=line'], { cwd: worktree, env })`, `env.BASE_URL === 'http://localhost:<port của FakeServer>'`, `env.E2E_OWNER_USER`/`E2E_OWNER_PASS` theo tài khoản fixture; exit 0 → không `isError`, text có `đạt`.
  - `runE2e: file ngoài e2e/, có .., tuyệt đối, không tồn tại → [e2e:invalid_args], không gọi exec` — 4 trường hợp.
  - `runE2e: grep đi nguyên văn thành argv` — `grep: '"; rm -rf ~'` → args kết thúc bằng `['--grep', '"; rm -rf ~']`.
  - `runE2e: exit khác 0 → isError, text có tail; mật khẩu bị che` — exec trả `{ code: 1, tail: 'login with <password>' }` → `isError`, text không chứa mật khẩu.
  - `runE2e: dự án chưa cấu hình → [e2e:not_configured]; server lỗi → [e2e:server_failed] kèm log` — theo mẫu test capture tương ứng.
- [ ] **Step 2: Run** `npx vitest run tests/preview/manager.test.ts` — Expected: FAIL (`runE2e` không tồn tại).
- [ ] **Step 3: Implement** theo Interfaces. Thứ tự: resolve project → validate file/grep (grep: chuỗi ≤ 200 ký tự, không xuống dòng) → `entry` + `acquire` → `server.ensure()` → `exec` → `release` trong `finally`. Kết quả đạt: `[e2e] đạt (exit 0)\n<tail>`; lỗi: `[e2e] lỗi (exit <code>)\n<tail>`; quá hạn (`code === null`): `[e2e:server_failed] quá <n>s`.
- [ ] **Step 4: Run** `npx vitest run tests/preview` — Expected: PASS hết.

---

### Task 2: tool `run_e2e` trong orchestrator, guard, MCP

**Files:**
- Modify: `src/guard/policy.ts` (`E2E_TOOL = 'mcp__acctv__run_e2e'`, cho phép vai dev, qc), `src/orchestrator/mcp.ts` (TOOL_DEFS: `run_e2e`, schema `{ file: string, grep?: string }`, additionalProperties false), `src/orchestrator/orchestrator.ts` (`deps.preview` Pick thêm `'runE2e'`; `hasE2e`; `workerMcpTools`; `workerTools`; method `runE2e(agentId, args)` theo mẫu `capture`)
- Test: tạo `tests/orchestrator/e2e.test.ts` (mẫu `preview.test.ts`: `fakePreview` thêm `runE2e` ghi lại request)

**Interfaces:**
- Consumes: Task 1 `PreviewManager.runE2e(req: E2eRequest)`.
- Produces: `hasE2eConfig(worktree: string): boolean` (export từ `src/orchestrator/installDeps.ts`, cạnh các hàm đọc worktree); `private hasE2e(m: ManagedAgent, worktree: string | null): boolean` = preview có && runner claude && role ∈ {dev, qc} && `m.mode !== 'cases'` && `hasE2eConfig(worktree)`.

- [ ] **Step 1: Write failing tests**
  - `có playwright.config: dev và qc review có run_e2e (tool CLI + MCP worker), gọi tới preview.runE2e với worktree/projectDir/mode/file` — ghi `playwright.config.ts` vào worktree sau `toRunning`.
  - `không có playwright.config: không ai có run_e2e`.
  - `QC cases, designer, explorer, runner codex, không preview: không có run_e2e`.
  - `guard: run_e2e cho dev/qc được phép, designer bị chặn`.
  - `run_e2e khi agent đã xong hoặc ticket không chạy → "Agent không còn chạy"/"Ticket không còn chạy"`.
- [ ] **Step 2: Run** `npx vitest run tests/orchestrator/e2e.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** theo Interfaces. Mô tả tool trong MCP: chạy file e2e của ticket trên server preview, `BASE_URL` tự đặt, chỉ file trong `e2e/`, lỗi dạng `[e2e:<mã>]`.
- [ ] **Step 4: Run** `npx tsc --noEmit -p . && npx vitest run tests/orchestrator tests/guard` — Expected: sạch, PASS.

---

### Task 3: prompt Controller/Dev/QC theo cờ e2e

**Files:**
- Modify: `src/orchestrator/prompts.ts` (`systemPrompt` ctx `e2e?: boolean`; `turn.approved` opts `e2e?: boolean`), `src/orchestrator/orchestrator.ts` (truyền `e2e: hasE2eConfig(wt)` ở 2 chỗ gọi `turn.approved` và vào `systemPrompt` của worker = `hasE2e(m, wt)`)
- Test: `tests/orchestrator/prompts.test.ts`, thêm 1 test vào `tests/orchestrator/e2e.test.ts`

**Interfaces:**
- Consumes: Task 2 `hasE2eConfig`, `hasE2e`.

- [ ] **Step 1: Write failing tests**
  - `Dev có e2e: mỗi TC một test('TC-n: …'), goto tương đối, assertion theo quy luật, tài khoản từ E2E_*, chạy run_e2e trước khi xong` — `systemPrompt('dev', { ...ctx, e2e: true })` chứa `test('TC-`, `run_e2e`, `E2E_`, `quy luật`; không e2e thì không chứa `run_e2e`.
  - `QC review có e2e: chạy run_e2e, đối chiếu TC ↔ test(), assertion bám dữ liệu dễ đổi là lỗi vừa` — `systemPrompt('qc', { ...ctx, e2e: true })` chứa `run_e2e`, `lỗi vừa`; `mode: 'cases'` + `e2e: true` không chứa `run_e2e`.
  - `turn.approved e2e: Controller thêm e2e/<mã ticket>.spec.ts vào file gói Dev` — `turn.approved(plan, 'W', { e2e: true })` chứa `e2e/<mã ticket>.spec.ts`; không cờ thì không chứa `e2e/`.
  - e2e.test: `duyệt plan khi worktree có playwright.config → lượt Controller có hướng dẫn e2e`.
- [ ] **Step 2: Run** `npx vitest run tests/orchestrator/prompts.test.ts tests/orchestrator/e2e.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** nội dung theo mục Thiết kế của spec (Controller, Dev, QC review). Controller: mã ticket = mã Jira trong tiêu đề/mô tả nếu có, không thì id `T-n`.
- [ ] **Step 4: Run** `npx tsc --noEmit -p . && npx vitest run` — Expected: sạch, toàn bộ PASS.
