# QC viết test case trước Dev — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QC có chế độ `mode: "cases"` viết test case từ tiêu chí nghiệm thu, chạy song song Explorer sau khi duyệt; Dev và QC review nhận test case qua `contextFrom`.

**Architecture:** Thêm `ManagedAgent.mode` (lưu SQLite). `spawn_agent` nhận `mode`; agent chế độ cases dùng system prompt riêng, không có capture, không chờ cài dependency, nhãn `QC-n · test case`. Prompt Controller/Dev/QC đổi để dùng test case; Controller bắt buộc Explorer khi ticket có Figma.

**Tech Stack:** TypeScript, node:sqlite, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-qc-test-cases-first-design.md`

## Global Constraints

- `mode` chỉ nhận `"cases"` và chỉ với `role: "qc"`; không truyền → `null`, hành vi như hiện nay.
- Chế độ cases dùng model/effort của vai qc trong plan; tính vào giới hạn số qc chạy cùng lúc; không tính vòng Dev.
- Prompt tiếng Việt, giữ giọng văn của `src/orchestrator/prompts.ts`.
- Không chặn thứ tự trong code; thứ tự là hướng dẫn trong prompt Controller.

## Review Focus

1. `mode: "cases"` với `role: "dev"` (hay vai khác), hoặc `mode: "abc"` → `spawn_agent` báo lỗi rõ, không tạo agent. → test Task 2.
2. Đang cài dependency → QC cases chạy ngay như Explorer; QC thường vẫn chờ. → test Task 2.
3. Có server preview → QC cases vẫn không có tool `capture` (cả trong tools CLI lẫn MCP của worker), QC thường có. → test Task 2.
4. Plan qc count 1: QC cases còn chạy → giao QC review bị từ chối "Đã đủ"; QC cases xong → giao QC review được. → test Task 2.
5. DB cũ không có cột `mode` mở được; agent cases đọc lại sau khi mở lại DB vẫn `mode: 'cases'`. → test Task 2.

---

### Task 1: Prompt cho chế độ test case

**Files:**
- Modify: `src/orchestrator/prompts.ts` (`CONTROLLER` bước 1, 3, 4; `DEV`; `REVIEWER`; `systemPrompt`)
- Test: `tests/orchestrator/prompts.test.ts`

**Interfaces:**
- Produces: `systemPrompt(role, ctx)` nhận thêm `ctx.mode?: 'cases' | null`. `role === 'qc' && ctx.mode === 'cases'` → thân prompt là hằng mới `QC_CASES`, không chèn `checkList`, không chèn `previewParts`.

- [ ] **Step 1: Write failing tests** (trong `prompts.test.ts`)
```ts
it('QC chế độ cases: viết TC từ tiêu chí nghiệm thu, không review, không capture, không lệnh kiểm tra', () => {
  const p = systemPrompt('qc', { ...ctx, mode: 'cases', checkCommands: ['pnpm test'], preview: pvWithCapture });
  expect(p.split('\n')[0]).toBe('ROLE: qc');
  expect(p).toContain('TC-1');
  expect(p).toMatch(/tiêu chí nghiệm thu/);
  expect(p).not.toMatch(/review phần Dev vừa làm/);
  expect(p).not.toMatch(/capture/);
  expect(p).not.toContain('pnpm test');
});
it('QC review và Dev dùng test case TC-… khi có trong ngữ cảnh', () => {
  expect(systemPrompt('qc', ctx)).toMatch(/TC-.*đạt \/ không đạt|từng TC/);
  expect(systemPrompt('dev', ctx)).toMatch(/từng TC/);
});
it('Controller: QC cases song song Explorer, Dev nhận contextFrom test case, QC review chạy từng TC; Figma → explorer ≥ 1', () => {
  const p = systemPrompt('controller', ctx);
  expect(p).toContain('mode: "cases"');
  expect(p).toMatch(/song song với Explorer/);
  expect(p).toMatch(/Figma[^\n]*explorer count ≥ 1[^\n]*bắt buộc|bắt buộc[^\n]*explorer count ≥ 1/);
});
```
(`ctx`, `pvWithCapture`: dùng lại fixture có sẵn trong file — ctx của các test hiện có và preview `capture: true`.)
- [ ] **Step 2: Run** `npx vitest run tests/orchestrator/prompts.test.ts` — Expected: 3 FAIL.
- [ ] **Step 3: Implement**
  - `QC_CASES`: vai QC chế độ test case; chỉ đọc; đọc plan + tiêu chí nghiệm thu + task; chỉ đọc code để biết route/URL/dữ liệu mẫu, không lấy code làm căn cứ kết quả mong đợi; báo cáo là danh sách `TC-1…`, mỗi TC: tiêu chí liên quan, bước (URL, viewport, ngôn ngữ, dữ liệu), kết quả mong đợi cụ thể (chữ, số, thứ tự); không kết luận đạt/không đạt.
  - `REVIEWER('qc')`: thêm quy tắc — ngữ cảnh có test case `TC-…` thì chạy từng TC trước, báo đạt / không đạt theo id, rồi mới kiểm thêm.
  - `DEV`: thêm — ngữ cảnh có test case `TC-…` thì tự đối chiếu từng TC trước khi báo xong, ghi TC nào đã tự kiểm.
  - `CONTROLLER` bước 1: ticket có link/thiết kế Figma thì explorer count ≥ 1 là bắt buộc. Bước 3: sau duyệt, nếu plan có vai qc thì giao QC `mode: "cases"` song song với Explorer (task: kiểm gì theo tiêu chí nghiệm thu), chờ cả hai, rồi giao Dev kèm `contextFrom: [explorer, qc cases]`. Bước 4: giao QC review kèm `contextFrom: [qc cases]`, task yêu cầu chạy từng TC.
- [ ] **Step 4: Run** `npx vitest run tests/orchestrator/prompts.test.ts` — Expected: PASS hết (kể cả test cũ).

---

### Task 2: `mode` trong dữ liệu, spawn, hàng đợi, tool, nhãn

**Files:**
- Modify: `src/tickets/model.ts` (`ManagedAgent`), `src/tickets/store.ts` (SCHEMA, `MANAGED_COLS`, `managedVals`, `toManaged`, migrate cột `mode`)
- Modify: `src/orchestrator/orchestrator.ts` — `spawnAgent` (~789-850), `pump` (~1147), `hasCapture` (~641) và 3 chỗ gọi (~637, `startWorker`, `workerTools`), nhãn ở `spawnAgent` và `startWorker`, truyền `mode` vào `systemPrompt`, `depsNote` như Explorer
- Modify: `src/orchestrator/mcp.ts` (schema `spawn_agent`: `mode: { type: 'string', enum: ['cases'], description }`)
- Test: tạo `tests/orchestrator/qcCases.test.ts` (dùng `makeEnv`, `validPlan`, `toRunning` như `deps.test.ts` / `explorer.test.ts`); `tests/tickets/store.test.ts` (fixture `managed()` thêm `mode: null`)

**Interfaces:**
- Consumes: Task 1 `systemPrompt(role, { ..., mode })`.
- Produces: `ManagedAgent.mode?: 'cases' | null`; nhãn `agentLabel(role: WorkRole, ordinal: number, mode?: 'cases' | null): string` → `QC-2 · test case` hoặc `Dev-1`; `hasCapture(runner, role, mode?)` → false khi `mode === 'cases'`.

- [ ] **Step 1: Write failing tests** trong `qcCases.test.ts`:
  - `spawn_agent mode sai: vai khác qc hoặc giá trị lạ → lỗi, không tạo agent` — `{ role: 'dev', mode: 'cases' }` và `{ role: 'qc', mode: 'abc' }` → `isError`, `listManaged(T)` không thêm.
  - `QC cases chạy ngay khi đang cài dependency; QC thường chờ` — mẫu theo test "Explorer chạy ngay" của `deps.test.ts`.
  - `QC cases không có capture dù có preview; QC thường có` — `runOf(env, id).spec.tools` không chứa `CAPTURE_TOOL`; `workerMcpTools(id).capture` undefined; system prompt không chứa `capture`.
  - `qc count 1: QC cases đang chạy chặn QC review; xong thì giao được` — lần 2 trả "Đã đủ 1 qc"; sau `finish` QC cases, spawn QC review OK, `contextFrom: [qcCasesId]` hợp lệ.
  - `nhãn và mode lưu lại` — `store.getAgent(id).label === 'QC-1 · test case'`; `tickets.getManaged(id).mode === 'cases'`; QC thường `mode` null, nhãn `QC-2`.
  - store test: `managed: mode lưu và đọc lại; DB cũ không có cột thì được thêm` (mẫu theo test `userAction` hiện có).
- [ ] **Step 2: Run** `npx vitest run tests/orchestrator/qcCases.test.ts tests/tickets/store.test.ts` — Expected: FAIL ở test mới.
- [ ] **Step 3: Implement** theo Interfaces. Lỗi spawn: `mode "cases" chỉ dùng với role qc` / `mode chỉ nhận "cases"`. `pump.ready`: thêm `m.mode === 'cases'`. `depsNote`: bỏ cho `mode === 'cases'` như Explorer.
- [ ] **Step 4: Run** `npx tsc --noEmit -p . && npx vitest run` — Expected: sạch, toàn bộ PASS.
