# Nhánh gốc cho từng ticket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ticket có thể chọn nhánh gốc (có sẵn hoặc tạo mới từ nhánh khác); worktree tách từ nhánh đó và Merge mặc định về nhánh đó.

**Architecture:** `Ticket` thêm `baseBranch`/`baseFrom` (lưu SQLite). `createTicket` kiểm tra tên/nhánh; `approve` truyền nhánh gốc cho `createWorktree`, hàm này tạo nhánh gốc nếu chưa có rồi `worktree add` từ nó. Form tạo ticket có ô chọn-hoặc-gõ nhánh; `/api/fs/check` trả thêm danh sách nhánh.

**Tech Stack:** TypeScript, Next.js (app/), node:sqlite, git CLI, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-ticket-base-branch-design.md`

## Global Constraints

- Ticket cũ (`baseBranch` null) giữ nguyên hành vi: worktree từ HEAD repo gốc, `defaultTarget` như hiện tại.
- Không checkout gì trong repo gốc; tạo nhánh bằng `git branch <name> <from>`.
- Nhánh gốc mới chỉ được tạo lúc duyệt plan, không lúc tạo ticket.
- Chỉ nhánh local; không `git fetch`.
- Text UI và lỗi bằng tiếng Việt như phần còn lại của code.

## Review Focus

1. Tên nhánh sai (`feature/a b`, `..x`, rỗng sau trim) → 400 lúc tạo ticket, không đợi tới lúc duyệt. → test Task 2.
2. Nhánh "mới" đã được ai đó tạo trước lúc duyệt → dùng nhánh có sẵn, bỏ `baseFrom`, không lỗi. → test Task 1.
3. `baseFrom` bị xoá trước lúc duyệt → duyệt báo 400 "Không tạo được worktree…", ticket về `awaiting_approval` (catch hiện có ở `orchestrator.ts:211`). → test Task 2.
4. Ticket huỷ trước khi duyệt → không có nhánh gốc mới nào trong repo. → test Task 2.
5. Nhánh gốc trùng nhánh repo gốc đang checkout → vẫn tạo được worktree (không checkout nhánh đó lần hai). → test Task 1.

---

### Task 1: git — tạo worktree từ nhánh gốc

**Files:**
- Modify: `src/git/git.ts:60-64` (`createWorktree`), thêm `validBranchName`
- Test: `tests/git/git.test.ts`

**Interfaces:**
- Produces:
  - `createWorktree(repo: string, branch: string, wtPath: string, base?: { branch: string; from: string | null }): Promise<{ baseRef: string }>` — không có `base`: như cũ (HEAD). Có `base`: nếu `refs/heads/<base.branch>` chưa có thì `git branch <base.branch> <base.from>` (lỗi nếu `from` null); rồi `worktree add -b <branch> <wtPath> <base.branch>`; `baseRef` = `rev-parse <base.branch>`.
  - `validBranchName(repo: string, name: string): Promise<boolean>` — `git check-ref-format --branch <name>`, thành công → true.

- [ ] **Step 1: Write failing tests** (trong `describe('git helpers')`, repo test có sẵn nhánh `main`)

```ts
it('createWorktree từ nhánh gốc có sẵn (kể cả nhánh đang checkout)', async () => {
  // repo đang đứng ở main; tạo nhánh feat có thêm commit
  // createWorktree(repo, 'acctv/T-1', wt1, { branch: 'main', from: null }) → baseRef === rev-parse main
  // createWorktree(repo, 'acctv/T-2', wt2, { branch: 'feat', from: null }) → baseRef === rev-parse feat; wt2 có file của feat
});
it('createWorktree tạo nhánh gốc mới từ nhánh khác, không đổi HEAD repo gốc', async () => {
  // { branch: 'feature/moi', from: 'feat' } → rev-parse feature/moi === rev-parse feat; symbolic-ref HEAD vẫn là main
});
it('createWorktree: nhánh gốc chưa có và from null hoặc from không tồn tại → ném lỗi', async () => {
  await expect(createWorktree(repo, 'acctv/T-3', wt3, { branch: 'x/khong-co', from: null })).rejects.toThrow();
  await expect(createWorktree(repo, 'acctv/T-4', wt4, { branch: 'x/khong-co', from: 'nhanh-ma' })).rejects.toThrow();
});
it('validBranchName', async () => {
  expect(await validBranchName(repo, 'feature/US-1-abc')).toBe(true);
  for (const bad of ['feature/a b', '..x', 'a..b', '-x', 'x.lock', '']) expect(await validBranchName(repo, bad)).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/git/git.test.ts` — Expected: FAIL (`validBranchName` không tồn tại / baseRef sai).
- [ ] **Step 3: Implement** hai hàm theo Interfaces. Kiểm tra nhánh có sẵn bằng `git rev-parse --verify -q refs/heads/<name>`; `validBranchName('')` trả false không gọi git.
- [ ] **Step 4: Run** `npx vitest run tests/git` — Expected: PASS hết.
- [ ] **Step 5: Commit** `git add src/git/git.ts tests/git/git.test.ts && git commit -m "feat(git): worktree from a chosen base branch, creating it if missing"`

---

### Task 2: Ticket lưu nhánh gốc; tạo / duyệt / merge dùng nó; API

**Files:**
- Modify: `src/tickets/model.ts` (Ticket), `src/tickets/store.ts` (SCHEMA, TICKET_COLS, ticketVals, toTicket, migrate cột)
- Modify: `src/orchestrator/orchestrator.ts:163-177` (`createTicket`), `:204-217` (`approve`), `:454-466` (`mergeTargets`)
- Modify: `src/server/routes.ts:205-214` (POST /api/tickets), `:374` (GET /api/fs/check)
- Test: `tests/tickets/store.test.ts`, `tests/orchestrator/control.test.ts`, `tests/server/tickets.test.ts`; sửa fixture Ticket trong `tests/tickets/store.test.ts:22` và mọi chỗ dựng `Ticket` literal (thêm `baseBranch: null, baseFrom: null`; `npx tsc --noEmit` chỉ ra hết)

**Interfaces:**
- Consumes: Task 1 `createWorktree(..., base)`, `validBranchName`; `listBranches` có sẵn.
- Produces:
  - `Ticket.baseBranch: string | null`, `Ticket.baseFrom: string | null` (cột `base_branch`, `base_from`, `ALTER TABLE tickets ADD COLUMN` nếu thiếu như `merge_info`).
  - `orchestrator.createTicket(input: { title; description; dir; overrides?; baseBranch?: string; baseFrom?: string })`. Quy tắc: `baseBranch` trim; rỗng → null (hành vi cũ). Sai tên → `OrchestratorError(400, 'Tên nhánh gốc không hợp lệ: <name>')`. Nhánh đã có → lưu `baseFrom: null`. Chưa có → `baseFrom` bắt buộc và phải có trong `listBranches`, nếu không `OrchestratorError(400, 'Nhánh gốc <name> chưa có: chọn nhánh để tạo từ đó')` / `'Không có nhánh <from>'`.
  - `approve`: gọi `createWorktree(t.dir, branch, wt, t.baseBranch ? { branch: t.baseBranch, from: t.baseFrom } : undefined)`.
  - `mergeTargets`: `defaultTarget = t.baseBranch` nếu có trong `branches` (đã lọc nhánh ticket), ngược lại logic cũ.
  - POST `/api/tickets` body nhận `baseBranch?`, `baseFrom?` (string, ≤ 200 ký tự; khác string → 400).
  - GET `/api/fs/check` trả `GitInfo & { branches: string[] }` (`[]` khi không phải git).

- [ ] **Step 1: Write failing tests**
  - store: ticket có `baseBranch: 'feature/x', baseFrom: 'dev-main'` lưu và đọc lại đúng; DB cũ không có cột vẫn mở được (cột thêm bởi migrate).
  - control.test (dùng `env.repo`, `toRunning` mẫu nhưng tự gọi `createTicket` với base):
    ```ts
    it('nhánh gốc có sẵn: worktree tách từ nó, merge mặc định về nó', ...)
      // g(repo,'branch','feat'); commit thêm trên feat; createTicket({..., baseBranch:'feat'}) → baseFrom null
      // propose + approve → ticket.baseRef === rev-parse feat; mergeTargets(T).defaultTarget === 'feat'
    it('nhánh gốc mới: tạo lúc duyệt từ baseFrom, không tạo lúc tạo ticket', ...)
      // createTicket({ baseBranch:'feature/moi', baseFrom: main }) → listBranches chưa có feature/moi
      // approve → rev-parse feature/moi === rev-parse main
    it('huỷ trước khi duyệt: không để lại nhánh gốc mới', ...)
      // createTicket({ baseBranch:'feature/huy', baseFrom: main }); cancel → không có refs/heads/feature/huy
    it('baseFrom bị xoá trước khi duyệt: lỗi 400, ticket về awaiting_approval', ...)
      // g(repo,'branch','tam'); createTicket({ baseBranch:'feature/y', baseFrom:'tam' }); g(repo,'branch','-D','tam')
      // approve rejects { status: 400 }; status === 'awaiting_approval'
    it('createTicket từ chối tên nhánh sai / thiếu baseFrom / baseFrom không có', ...)
      // 'feature/a b' → 400; 'feature/moi' không baseFrom → 400; baseFrom 'khong-co' → 400
    ```
  - server/tickets.test: POST với `baseBranch: 5` → 400; GET `/api/fs/check?dir=<repo>` có `branches` chứa nhánh hiện tại.
  - Sửa expectation cũ `control.test.ts:443` không đổi (ticket không có base → `defaultTarget: main`).
- [ ] **Step 2: Run** `npx vitest run tests/tickets tests/orchestrator/control.test.ts tests/server/tickets.test.ts` — Expected: FAIL ở test mới.
- [ ] **Step 3: Implement** theo Interfaces.
- [ ] **Step 4: Run** `npx tsc --noEmit -p . && npx vitest run` — Expected: tsc sạch, toàn bộ test PASS.
- [ ] **Step 5: Commit** các file của task: `feat(tickets): per-ticket base branch for worktree and merge target`

---

### Task 3: Form tạo ticket và header

**Files:**
- Modify: `app/tickets/new/NewTicketForm.tsx` (GitInfo có `branches`; ô "Nhánh gốc"; body POST)
- Modify: `app/components/TicketHeader.tsx:173-177` (hiện "từ <baseBranch>" cạnh nhánh ticket)
- Modify: `app/lib/tickets.ts` (helper thuần), CSS module của form nếu cần
- Test: `tests/app/tickets.test.ts`

**Interfaces:**
- Consumes: Task 2 `/api/fs/check` → `branches`, POST nhận `baseBranch`/`baseFrom`, `Ticket.baseBranch`.
- Produces: `defaultBaseFrom(branches: string[], current: string | null): string | null` trong `app/lib/tickets.ts` — `'dev-main'` nếu có, rồi `current` nếu có trong `branches`, rồi `branches[0] ?? null`.

- [ ] **Step 1: Write failing test**
```ts
test('defaultBaseFrom: ưu tiên dev-main, rồi nhánh hiện tại, rồi nhánh đầu', () => {
  expect(defaultBaseFrom(['a', 'dev-main', 'main'], 'main')).toBe('dev-main');
  expect(defaultBaseFrom(['a', 'main'], 'main')).toBe('main');
  expect(defaultBaseFrom(['a', 'b'], null)).toBe('a');
  expect(defaultBaseFrom([], null)).toBe(null);
});
```
- [ ] **Step 2: Run** `npx vitest run tests/app/tickets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** helper, rồi form:
  - Ô `<input list>` "Nhánh gốc" + `<datalist>` từ `git.branches`, khởi tạo bằng `git.branch` khi kiểm tra thư mục xong (đổi thư mục → đặt lại).
  - Giá trị trim không có trong `branches` và khác rỗng → dòng "▲ Nhánh mới, sẽ tạo từ" + `<select>` các nhánh, mặc định `defaultBaseFrom`.
  - Cảnh báo "Có thay đổi chưa commit…" (dòng 156) chỉ hiện khi nhánh gốc === `git.branch`.
  - POST gửi `baseBranch` (luôn, khi có git) và `baseFrom` (chỉ khi nhánh mới).
  - TicketHeader: `nhánh {t.branch}` → thêm `<span>từ {t.baseBranch}</span>` khi `t.baseBranch`.
- [ ] **Step 4: Run** `npx tsc --noEmit -p . && npx vitest run` — Expected: sạch, PASS.
- [ ] **Step 5: Kiểm tra tay** (`run` skill hoặc dev server): form với uniscore-client hiện danh sách nhánh; gõ tên mới hiện ô "tạo từ" mặc định `dev-main`; tạo ticket → `GET /api/tickets` có `baseBranch`.
- [ ] **Step 6: Commit** `feat(ui): choose or create a ticket's base branch`
