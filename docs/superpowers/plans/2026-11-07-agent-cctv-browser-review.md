# Review trên trình duyệt — Kế hoạch triển khai

> **Dành cho agent làm việc:** BẮT BUỘC dùng sub-skill superpowers:subagent-driven-development (khuyến nghị) hoặc superpowers:executing-plans để làm từng task. Các bước dùng checkbox (`- [ ]`).

**Mục tiêu:** Dev, Designer và QC kiểm được giao diện đang chạy thật qua tool `capture`: dashboard bật server preview cho từng ticket, điều khiển Chrome headless, đăng nhập bằng tài khoản test theo vai trò. Designer còn đọc được Figma.

**Kiến trúc:**
- Module mới `src/preview/` gồm cấu hình dự án, nạp file env, vòng đời server preview, trình duyệt cùng `runCapture`, và `PreviewManager` quản lý theo ticket.
- Orchestrator nhận `PreviewManager` qua `OrchestratorDeps`, rồi gắn `capture` vào MCP của worker, vào guard và vào lúc ticket kết thúc hoặc dashboard tắt.
- HTTP và UI chỉ đọc trạng thái, cộng thêm vài nút bấm.

**Công nghệ:** TypeScript, Node ≥ 22.15, vitest 5, `playwright-core` (mới, dùng Chrome hoặc Edge có sẵn trên máy, không tải trình duyệt), Next.js 16 cho UI.

**Spec:** [docs/superpowers/specs/2026-11-07-agent-cctv-browser-review-design.md](../specs/2026-11-07-agent-cctv-browser-review-design.md)

## Ràng buộc chung

- Windows 11. Kill cây tiến trình bằng `killTree` ([src/runner/proc.ts](../../../src/runner/proc.ts)), spawn bằng `startProcess` hoặc `child_process.spawn` với `windowsHide: true`.
- Origin preview luôn là `http://localhost:{port}`. Mỗi ticket một cổng trống.
- **Timeout:**
  - chờ server sẵn sàng ở chế độ dev: 120 000 ms;
  - build ở chế độ prod: 600 000 ms;
  - mỗi bước của `capture`: 10 000 ms;
  - cả lần gọi `capture` (không tính bật hoặc build server): 120 000 ms;
  - server không được dùng thì tắt sau 600 000 ms.
- **Giới hạn của `capture`:**
  - 1..30 bước, tối đa 6 ảnh;
  - ảnh toàn trang cắt ở chiều cao 8000px;
  - viewport rộng 320..1920, mặc định 1440×900;
  - tối đa 20 phần tử cho mỗi target của `measure`;
  - `console` tối đa 30 dòng, mỗi dòng 300 ký tự;
  - `overflow` tối đa 10 phần tử;
  - mỗi ticket tối đa 2 lần gọi chạy cùng lúc.
- **Bảo mật:**
  - mật khẩu tài khoản test không bao giờ xuất hiện trong prompt, kết quả tool, log ticket, hay response `GET /api/settings`;
  - giá trị che là chuỗi `"••••"`;
  - không ghi body hay header của request.
- Dữ liệu QC tạo ra phải có tiền tố `acctv-<ticket>-` (ví dụ `acctv-T-5-`).
- Thông báo cho người dùng và agent viết bằng tiếng Việt, theo giọng của code hiện có.
- Mỗi task kết thúc bằng: `npx vitest run` xanh, `npx tsc --noEmit` sạch, rồi commit. Thông điệp commit kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Shell là PowerShell 5.1, nên ghi thông điệp ra file rồi dùng `git commit -F`.

## Điểm cần chú ý khi review

1. **Server chết giữa vòng review** (crash, cổng bị chiếm): lần `capture` sau phải thấy server đã chết và bật lại, không kẹt ở trạng thái `ready`. Test thuộc Task 4.
2. **Hai agent gọi `capture` cùng lúc khi server chưa bật:** chỉ một tiến trình được bật, cả hai chờ chung một promise. Test thuộc Task 7.
3. **Đăng nhập sai hoặc bị chuyển hướng vòng:** trả `login_failed` sau đúng một lần thử lại. Output không chứa mật khẩu. Test thuộc Task 6.
4. **Ticket bị huỷ khi `capture` hoặc build đang chạy:** tiến trình build bị kill, `capture` trả lỗi, không còn tiến trình mồ côi. Test thuộc Task 7.
5. **`goto` hay `upload` cố thoát ra ngoài:** `goto` là URL tuyệt đối, `//evil.com`, `http://localhost:4777/api`, hay đường dẫn không bắt đầu bằng `/`; `upload` là `..\..\x`. Tất cả đều bị từ chối trước khi mở trình duyệt. Test thuộc Task 5.

---

## Bản đồ file

| File | Trách nhiệm |
|---|---|
| `src/preview/config.ts` (mới) | Kiểu `ProjectPreview`, mặc định Next.js, validate, che và bỏ che mật khẩu, tìm cấu hình theo `ticket.dir` |
| `src/preview/envFiles.ts` (mới) | Đọc `.env*` của thư mục dự án gốc theo chế độ |
| `src/preview/server.ts` (mới) | `PreviewServer`: một tiến trình server của một ticket (cổng, sẵn sàng, build, chữ ký, log cuối, tắt) |
| `src/preview/captureArgs.ts` (mới) | Validate tham số `capture`, che giá trị nhạy cảm, định dạng kết quả |
| `src/preview/browser.ts` (mới) | `TicketBrowser`: Chrome headless, phiên theo tài khoản, đăng nhập, `runCapture` |
| `src/preview/manager.ts` (mới) | `PreviewManager`: ghép server và browser theo ticket, kiểm backend, giới hạn chạy cùng lúc, tắt khi rảnh, pid mồ côi, trạng thái |
| `src/core/config.ts` | `Settings.projects`, gắn validate và merge |
| `src/core/model.ts` | Thêm `HubEvent` `{ type: 'preview' }` |
| `src/tickets/model.ts`, `src/tickets/flow.ts`, `src/orchestrator/mcp.ts` | `Plan.preview?.mode`, tool `capture` trong `TOOL_DEFS` |
| `src/guard/policy.ts` | `CAPTURE_TOOL`, cho Designer dùng MCP đọc của người dùng |
| `src/orchestrator/orchestrator.ts` | Nối tool, MCP, guard, `readRoots` của thư mục ảnh, tắt server, khôi phục |
| `src/orchestrator/prompts.ts` | Prompt cho Dev, Designer, QC, Controller |
| `src/server/core.ts`, `src/server/routes.ts` | Tạo `PreviewManager`, các route mới, trả nội dung nhị phân |
| `app/settings/SettingsForm.tsx`, `app/components/TicketHeader.tsx`, `app/components/AgentDetail.tsx`, `app/lib/liveStore.ts` | Giao diện |

---

### Task 1: Cấu hình dự án trong Settings

**Files:**
- Create: `src/preview/config.ts`
- Modify: `src/core/config.ts` (`Settings`, `DEFAULT_SETTINGS`, `mergeSettings`, `validateSettings`), `src/server/routes.ts` (route `GET/PUT /api/settings`)
- Test: `tests/preview/config.test.ts`, `tests/core/config.test.ts`, `tests/server/api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PreviewLogin { path: string; usernameSelector: string; passwordSelector: string; submitSelector: string; success: { urlNotMatching: string } | { selector: string } }
  export interface PreviewAccount { name: string; description: string; username: string; password: string }
  export interface ProjectPreview {
    dev: { command: string }; prod: { build: string; start: string }; defaultMode: 'dev' | 'prod';
    env: Record<string, string>; readyPath: string; backend?: { healthUrl: string }; login?: PreviewLogin;
    accounts: PreviewAccount[]; db?: { resetCommand: string; cwd: string };
  }
  export const MASK = '••••';
  export const NEXT_DEFAULTS: ProjectPreview; // dev 'pnpm exec next dev -p {port}', prod build 'pnpm exec next build', start 'pnpm exec next start -p {port}', defaultMode 'dev', env {}, readyPath '/', accounts []
  export function validateProjects(raw: unknown): { ok: true; projects: Record<string, ProjectPreview> } | { ok: false; errors: string[] };
  export function maskProjects(p: Record<string, ProjectPreview>): Record<string, ProjectPreview>;
  /** Mật khẩu = MASK → lấy mật khẩu cũ của tài khoản cùng name trong cùng dir; không có tài khoản cũ → lỗi. */
  export function unmaskProjects(next: Record<string, ProjectPreview>, prev: Record<string, ProjectPreview>): { ok: true; projects: Record<string, ProjectPreview> } | { ok: false; errors: string[] };
  /** Khoá được chuẩn hoá: path.resolve, Windows so không phân biệt hoa thường. Không có cấu hình mà package.json có `next` → NEXT_DEFAULTS; còn lại null. */
  export function resolveProject(projects: Record<string, ProjectPreview>, dir: string): ProjectPreview | null;
  ```
- `Settings.projects: Record<string, ProjectPreview>`, mặc định `{}`.

- [ ] **Step 1: Viết test cho `validateProjects`, `maskProjects`, `unmaskProjects`, `resolveProject`** trong `tests/preview/config.test.ts`. Các assert:
  - `validateProjects({ 'D:\\app': { ...NEXT_DEFAULTS, accounts: [{ name: 'owner', description: 'Chủ', username: 'a@x', password: 'p' }] } })` trả `ok` và giữ nguyên dữ liệu.
  - Mỗi trường hợp sau trả `ok: false`, lỗi có nhắc tên trường:
    - khoá không phải đường dẫn tuyệt đối;
    - `dev.command` không chứa `{port}`;
    - hai account trùng `name`;
    - `name` không khớp `/^[a-z0-9][a-z0-9_-]{0,31}$/`;
    - `defaultMode: 'x'`;
    - `backend.healthUrl` không bắt đầu bằng `http://` hay `https://`;
    - `db.cwd` không phải đường dẫn tuyệt đối.
  - `maskProjects` thay mọi `password` bằng `'••••'` và không sửa object gốc.
  - `unmaskProjects` với `password: '••••'` và tài khoản cũ cùng `name` thì trả lại mật khẩu cũ. Tài khoản mới mà mật khẩu là `'••••'` thì trả lỗi `accounts.<name>.password`.
  - `resolveProject`:
    - với `{ 'D:\\App': cfg }` và `'d:\\app\\'` thì trả `cfg` (chỉ trên win32);
    - với thư mục tạm có `package.json` chứa `{"dependencies":{"next":"16"}}` thì trả `NEXT_DEFAULTS`;
    - với thư mục không có `next` thì trả `null`.
- [ ] **Step 2: Chạy và xác nhận thất bại.** Run: `npx vitest run tests/preview/config.test.ts`. Mong đợi: FAIL vì không tìm thấy module.
- [ ] **Step 3: Viết `src/preview/config.ts` theo Interfaces.**
- [ ] **Step 4: Gắn vào `config.ts`.**
  - Thêm `projects` vào `Settings` và `DEFAULT_SETTINGS`.
  - `mergeSettings`: nếu `validateProjects(raw.projects).ok` thì gán, ngược lại giữ `{}`.
  - `validateSettings`:
    - `s.projects === undefined` thì dùng `{}`;
    - không hợp lệ thì đẩy các lỗi vào `errors`;
    - đưa vào object kết quả.
  - Thêm vào `DEFAULT_SETTINGS.denyBash` mẫu `String.raw\`\.acctv[\\/]+config\.json\``.
  - Test trong `tests/core/config.test.ts`:
    - `loadConfig` đọc `projects` hợp lệ;
    - `projects` hỏng thì thành `{}`;
    - `checkTool(dev, 'Bash', { command: 'cat C:\\Users\\a\\.acctv\\config.json' })` bị chặn.
- [ ] **Step 5: Che mật khẩu ở route.**
  - `GET /api/settings` trả `settings.projects` qua `maskProjects`.
  - `PUT /api/settings` gọi `unmaskProjects(v.settings.projects, core.cfg.settings.projects)` trước `saveSettings`. Lỗi thì trả 400 kèm `errors`. Response cũng được che.
  - Test trong `tests/server/api.test.ts`:
    - lưu xong thì GET không chứa mật khẩu;
    - PUT lại với `'••••'` thì file `config.json` vẫn giữ mật khẩu cũ.
- [ ] **Step 6: Chạy `npx vitest run` và `npx tsc --noEmit`**, cả hai phải xanh.
- [ ] **Step 7: Commit** `feat(p3): per-project preview settings with masked test-account passwords`.

### Task 2: Nạp file env của dự án

**Files:**
- Create: `src/preview/envFiles.ts`
- Test: `tests/preview/envFiles.test.ts`

**Interfaces:**
- Produces: `export function loadEnvFiles(dir: string, mode: 'dev' | 'prod'): { vars: Record<string, string>; files: string[] }`.
  - Thứ tự ưu tiên (file đứng trước thắng):
    - dev: `.env.development.local`, `.env.local`, `.env.development`, `.env`;
    - prod: `.env.production.local`, `.env.local`, `.env.production`, `.env`.
  - `files` là tên các file tồn tại, theo đúng thứ tự trên.
  - Cú pháp hỗ trợ: `KEY=VALUE`, `export KEY=VALUE`, dòng `#` là chú thích, giá trị bọc nháy đơn hoặc kép (nháy kép có `\n` xuống dòng), `#` sau một khoảng trắng trong giá trị không có nháy là chú thích. Không mở rộng `$VAR`.

- [ ] **Step 1: Viết test.** Thư mục tạm có `.env` (`A=1`, `B=env`), `.env.local` (`B=local`, `C="x # y"`), `.env.production` (`A=prod`). Các assert:
  - `loadEnvFiles(d, 'dev')` cho `vars` là `{ A: '1', B: 'local', C: 'x # y' }` và `files` là `['.env.local', '.env']`.
  - `loadEnvFiles(d, 'prod')` cho `A` là `'prod'`.
  - `D=v # chú thích` cho `'v'`.
  - Thư mục không có file nào thì trả `{ vars: {}, files: [] }`.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.**
- [ ] **Step 4: Chạy và xác nhận test xanh.**
- [ ] **Step 5: Commit** `feat(p3): load project .env files for the preview server`.

### Task 3: `preview.mode` trong kế hoạch

**Files:**
- Modify: `src/tickets/model.ts` (`Plan`), `src/tickets/flow.ts` (`validatePlan`), `src/orchestrator/mcp.ts` (`PLAN_SCHEMA`)
- Test: `tests/tickets/flow.test.ts`

**Interfaces:**
- Produces: `Plan.preview?: { mode: 'dev' | 'prod' }`.

- [ ] **Step 1: Viết test.**
  - `validatePlan({ ...validPlan(), preview: { mode: 'prod' } })` thì `ok` và giữ `preview`.
  - `{ preview: { mode: 'x' } }` thì lỗi `preview.mode`.
  - Không có `preview` thì `plan.preview` là `undefined`.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.** Thêm vào `PLAN_SCHEMA.properties` `preview: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['dev', 'prod'], description: 'Chế độ server preview cho capture; prod khi tiêu chí nghiệm thu cần SSR, redirect, middleware hay header.' } }, required: ['mode'] }`. Field này không nằm trong `required`.
- [ ] **Step 4: Chạy và xác nhận test xanh.** Test của `PlanEditor` và `planEdit` vẫn phải xanh.
- [ ] **Step 5: Commit** `feat(p3): optional preview.mode in the ticket plan`.

### Task 4: `PreviewServer`

**Files:**
- Create: `src/preview/server.ts`
- Test: `tests/preview/server.test.ts`, kèm script giả `tests/helpers/fakeNextServer.mjs`

**Interfaces:**
- Consumes: `ProjectPreview` (Task 1), `loadEnvFiles` (Task 2), `startProcess` và `killTree` (`src/runner/proc.ts`).
- Produces:
  ```ts
  export type PreviewState = 'stopped' | 'starting' | 'building' | 'ready' | 'failed';
  export interface PreviewStatus { state: PreviewState; mode: 'dev' | 'prod'; port: number | null; error: string | null; logTail: string; envFiles: string[]; startedAt: number | null }
  export interface ServerInfo { port: number; mode: 'dev' | 'prod'; startedNow: boolean; buildMs: number | null }
  export class PreviewServerError extends Error { constructor(public code: 'server_failed', msg: string, public logTail: string) }
  export interface PreviewServerDeps {
    worktree: string; projectDir: string; project: ProjectPreview; mode: 'dev' | 'prod';
    /** chữ ký worktree: HEAD + hash(git diff HEAD) + danh sách untracked */
    signature(): Promise<string>;
    onPids(pids: number[]): void; onStatus(s: PreviewStatus): void;
    timeouts?: { readyMs: number; buildMs: number };
  }
  export class PreviewServer {
    constructor(deps: PreviewServerDeps);
    /** Chạy song song thì dùng chung một promise. Chế độ prod: chữ ký khác lần build trước thì build lại. Tiến trình đã thoát thì bật lại. */
    ensure(): Promise<ServerInfo>;
    stop(): Promise<void>;
    status(): PreviewStatus;
    alive(): boolean;
  }
  export function freePort(): Promise<number>; // bind 127.0.0.1:0 rồi đóng
  export function worktreeSignature(worktree: string): Promise<string>;
  ```
  - Cách chạy lệnh: spawn qua shell (`cmd.exe /d /s /c` trên Windows, `sh -c` ở nơi khác), `cwd = worktree`, `env = { ...process.env, ...loadEnvFiles(projectDir, mode).vars, ...project.env, PORT }`, `{port}` được thay trong lệnh.
  - Kiểm sẵn sàng: `fetch('http://localhost:{port}{readyPath}', { redirect: 'manual' })` mỗi 500 ms cho tới khi nhận mã < 500.
  - `logTail` là 2048 ký tự cuối của stdout và stderr gộp lại.

- [ ] **Step 1: Viết script giả `tests/helpers/fakeNextServer.mjs`.**
  - Đối số: `serve <port>` mở HTTP server trả 200 kèm `process.env.FAKE_TAG`. `build` ghi file `built.txt` có nội dung là một số đếm rồi thoát 0. `fail` in `boom` rồi thoát 1.
  - Biến `FAKE_DELAY_MS` làm chậm việc listen.
- [ ] **Step 2: Viết test** dùng `ProjectPreview` có `dev.command = 'node "<script>" serve {port}'`. Các assert:
  - `ensure()` trả `{ startedNow: true, mode: 'dev' }`, rồi `fetch` tới cổng đó nhận body bằng `FAKE_TAG` lấy từ `project.env`.
  - Biến đọc từ `.env.local` của `projectDir` cũng có trong body: script in thêm `process.env.FROM_FILE`.
  - Hai lần `ensure()` chạy song song chỉ tạo một tiến trình (đếm qua `onPids`), lần sau có `startedNow: false`.
  - Kill tiến trình từ bên ngoài, `alive()` thành `false`, `ensure()` bật lại với `startedNow: true` (Review Focus 1).
  - Lệnh `fail`: `ensure()` ném `PreviewServerError` có `code: 'server_failed'`, `logTail` chứa `boom`, `status().state === 'failed'`.
  - Chế độ prod với `signature` giả: chữ ký giữ nguyên thì `build` chạy đúng một lần qua hai lần `ensure()`; đổi chữ ký thì build lại và tiến trình cũ bị kill.
  - Hết `timeouts.readyMs` (đặt 1000 ms với `FAKE_DELAY_MS=5000`) thì ném lỗi chứa `không sẵn sàng sau`.
  - Sau `stop()` thì tiến trình đã chết (`process.kill(pid, 0)` ném lỗi) và `status().state === 'stopped'`.
- [ ] **Step 3: Chạy và xác nhận thất bại.**
- [ ] **Step 4: Viết code.** Trong `worktreeSignature`, dùng `git rev-parse HEAD`, `git diff HEAD` (băm sha1) và `git ls-files --others --exclude-standard` qua `execFile` của `node:child_process` với `cwd`.
- [ ] **Step 5: Chạy và xác nhận test xanh.** Chạy thêm 3 lần để chắc không chập chờn.
- [ ] **Step 6: Commit** `feat(p3): per-ticket preview server process with readiness and prod rebuild`.

### Task 5: Tham số và kết quả của `capture`

**Files:**
- Create: `src/preview/captureArgs.ts`
- Test: `tests/preview/captureArgs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Target = string;
  export type Step =
    | { goto: string } | { click: Target } | { fill: Target; value: string } | { select: Target; value: string }
    | { check: Target; checked?: boolean } | { press: string; target?: Target } | { upload: Target; file: string }
    | { waitFor: Target | { url: string } } | { shot: string; fullPage?: boolean; target?: Target } | { measure: Target[] };
  export interface CaptureArgs { as: string | null; viewport: { width: number; height: number }; colorScheme: 'light' | 'dark'; locale: string | null; cookies: { name: string; value: string }[]; steps: Step[] }
  export const LIMITS: { steps: 30; shots: 6; stepMs: 10000; totalMs: 120000; fullPageMax: 8000; measurePerTarget: 20; consoleLines: 30; consoleChars: 300; overflowItems: 10; minWidth: 320; maxWidth: 1920 };
  /** accounts: tên tài khoản hợp lệ của dự án. worktree: để kiểm `upload.file`. */
  export function validateCaptureArgs(raw: unknown, accounts: string[], worktree: string): { ok: true; args: CaptureArgs } | { ok: false; error: string };
  export interface StepReport { i: number; kind: string; ok: boolean; ms: number; error?: string }
  export interface CaptureResult {
    server: { mode: 'dev' | 'prod'; port: number; startedNow: boolean; buildMs: number | null; envFiles: string[] };
    steps: StepReport[]; finalUrl: string | null; status: number | null; redirects: string[];
    console: string[]; requests: { method: string; url: string; status: number | null }[];
    overflow: { scrollWidth: number; clientWidth: number; items: { selector: string; width: number; right: number }[] } | null;
    measures: { target: string; items: { rect: { x: number; y: number; width: number; height: number }; style: Record<string, string> }[] }[];
    shots: string[];
  }
  export type CaptureErrorCode = 'invalid_args' | 'not_configured' | 'backend_down' | 'login_failed' | 'server_failed' | 'busy_cancelled';
  /** Thay mọi giá trị trong `secrets` bằng `***` trong mọi chuỗi của kết quả. */
  export function redact<T>(value: T, secrets: string[]): T;
  export function formatResult(r: CaptureResult): string;  // JSON gọn, 1 dòng mỗi phần
  export function formatError(code: CaptureErrorCode, message: string, extra?: Partial<CaptureResult>): string; // bắt đầu bằng `[capture:${code}]`
  ```

- [ ] **Step 1: Viết test.**
  - Mặc định: `{ steps: [{ goto: '/' }] }` cho `as: null`, viewport 1440×900, `colorScheme: 'light'`.
  - Từ chối (Review Focus 5), lỗi `invalid_args`:
    - `goto` là `'http://x.com'`, `'//evil.com'`, `'http://localhost:4777/api'`, `'api'` (không bắt đầu bằng `/`), `'/\\evil'`;
    - `upload.file` là `'..\\..\\x'`, hoặc đường dẫn tuyệt đối nằm ngoài `worktree`;
    - `as: 'ghost'` không nằm trong `accounts`;
    - 31 bước, 7 bước `shot`, `viewport.width` 200 hoặc 2000;
    - kiểu bước lạ `{ eval: '1' }`;
    - `shot` có tên không khớp `/^[\w-]{1,40}$/`.
  - `redact({ a: 'x pass1 y', b: ['pass1'] }, ['pass1'])` cho `{ a: 'x *** y', b: ['***'] }`. Danh sách `secrets` rỗng thì giữ nguyên.
  - `formatError('login_failed', 'Sai…')` bắt đầu bằng `[capture:login_failed]`.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.**
- [ ] **Step 4: Chạy và xác nhận test xanh.**
- [ ] **Step 5: Commit** `feat(p3): validate capture arguments and shape results`.

### Task 6: Trình duyệt và `runCapture`

**Files:**
- Modify: `package.json` (thêm `playwright-core`, ghi đúng một phiên bản chính xác, phiên bản đó đã ra ít nhất 2 tuần)
- Create: `src/preview/browser.ts`
- Test: `tests/preview/browser.e2e.test.ts`. Không tìm thấy Chrome hay Edge thì `describe.skip`.

**Interfaces:**
- Consumes: `CaptureArgs`, `CaptureResult`, `LIMITS`, `redact` (Task 5), `PreviewLogin`, `PreviewAccount` (Task 1).
- Produces:
  ```ts
  /** Chrome rồi Edge theo đường dẫn chuẩn của Windows (Program Files, Program Files (x86), LOCALAPPDATA); biến ACCTV_BROWSER ghi đè. null nếu không có. */
  export function findBrowser(env?: NodeJS.ProcessEnv): string | null;
  export class LoginError extends Error {}
  export class TicketBrowser {
    constructor(opts: { executablePath: string; origin: string; login?: PreviewLogin; accounts: PreviewAccount[]; onPid(pid: number): void });
    /** Mỗi lần gọi mở một tab mới trong context của tài khoản (`null` = khách). Ảnh ghi vào `outDir/<n>-<shot>.png` (n đếm tăng dần trong outDir). */
    runCapture(args: CaptureArgs, outDir: string, worktree: string): Promise<Omit<CaptureResult, 'server'>>;
    close(): Promise<void>;
  }
  ```
  - **Đăng nhập:** context của một tài khoản được tạo lần đầu cần dùng. Tạo xong thì mở `login.path`, `fill` hai ô, `click` nút gửi, rồi chờ dấu hiệu `success` trong tối đa 10 000 ms.
  - **Đăng nhập lại:** trong lúc chạy các bước, nếu URL chính đổi sang `login.path` thì đăng nhập lại một lần rồi lặp lại bước đó. Lần thứ hai vẫn hỏng thì ném `LoginError`, kèm ảnh chụp tự động tên `login-failed`.
  - **Chặn thoát ra ngoài:** `page.route('**/*')` chặn các request `document` có origin khác `origin`, bước hiện tại báo lỗi `điều hướng ra ngoài server preview bị chặn`. Request XHR hay fetch tới backend vẫn được đi.
  - **Diễn giải `Target`:** chuỗi bắt đầu bằng `text=`, `role=` (như `role=button[name="Lưu"]`) hay `testid=` thì đổi sang locator tương ứng của Playwright (`getByText`, `getByRole`, `getByTestId`). Chuỗi khác là CSS.
  - **Ghi nhận:** `requests` giữ mọi request có method khác `GET`, `HEAD`, `OPTIONS`, cộng các response có mã ≥ 400 và các request lỗi mạng. `console` giữ `error` và `warning`. `status` và `redirects` lấy từ lần điều hướng chính cuối cùng.
  - **`measure`:** chạy `getBoundingClientRect` và `getComputedStyle` trong trang để lấy các thuộc tính: `color`, `background-color`, `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `padding`, `margin`, `gap`, `border`, `border-radius`, `box-shadow`, `opacity`, `display`.
  - **`overflow`:** lấy sau bước cuối, gồm `scrollWidth` và `clientWidth` của `document.documentElement`, cộng tối đa 10 phần tử có `right > clientWidth + 1`.
  - **Bước lỗi:** dừng lại, chụp tự động ảnh tên `error-<i>`, rồi trả về những gì đã thu được.
  - **Che mật khẩu:** trước khi trả, kết quả được `redact` với mật khẩu của mọi tài khoản.

- [ ] **Step 1: Cài thư viện.** Run: `npm install --save-exact playwright-core@<phiên bản>`. Không chạy `playwright install`. Kiểm `node -e "require('playwright-core')"` không lỗi.
- [ ] **Step 2: Viết test e2e.** Dựng một HTTP server tĩnh trên cổng trống, có các trang:
  - `/login`: form `#u`, `#p`, `button[type=submit]`. POST đúng `owner/secret1` thì đặt cookie `s=1` và 302 về `/home`; sai thì 401.
  - `/home`: không có cookie thì 302 về `/login`. Có cookie thì hiện `<h1 style="font-size:24px;color:rgb(1,2,3)">Xin chào</h1>`, nút `Xoá` (bấm thì POST `/api/items/1`, server trả 403), và một div rộng 2000px.
  - `/out`: `location.href = 'https://example.com'`.

  Các assert:
  - **Đăng nhập và đo:** `runCapture({ as: 'owner', steps: [{ goto: '/home' }, { measure: ['h1'] }, { click: 'text=Xoá' }, { waitFor: { url: '/home' } }, { shot: 'home' }] })` cho:
    - `measures[0].items[0].style['font-size'] === '24px'` và `color === 'rgb(1, 2, 3)'`;
    - `requests` chứa `{ method: 'POST', url: …'/api/items/1', status: 403 }`;
    - `overflow.scrollWidth > overflow.clientWidth`;
    - `shots` có đúng 1 file và file tồn tại;
    - không có chuỗi nào trong kết quả JSON chứa `secret1`.
  - **Đăng nhập sai** (Review Focus 3): tài khoản `owner` mật khẩu `sai` thì ném `LoginError`. Server ghi nhận đúng 2 lần POST `/login`, nghĩa là chỉ thử lại một lần.
  - **Khách:** gọi không kèm `as` với `goto: '/home'` thì `finalUrl` kết thúc bằng `/login`, `redirects` có `/home`.
  - **Thoát ra ngoài:** `goto: '/out'` thì bước 1 hoặc bước điều hướng tiếp theo có `ok: false`, lỗi chứa `bị chặn`.
  - **Bước lỗi:** `{ click: '#khong-co' }` thì `steps[1].ok === false` và `shots` có ảnh `error-1`.
  - **Không mồ côi:** sau `close()` thì tiến trình Chrome (pid lấy qua `onPid`) đã chết.
- [ ] **Step 3: Chạy và xác nhận thất bại.** Run: `npx vitest run tests/preview/browser.e2e.test.ts`.
- [ ] **Step 4: Viết `src/preview/browser.ts`.** Dùng `chromium.launch({ executablePath, headless: true })`, mỗi tài khoản một context dùng chung qua các lần gọi. Viewport, theme, locale và cookie là tuỳ chọn của từng lần gọi, nên đặt trên page: `page.setViewportSize`, `page.emulateMedia({ colorScheme })`, `page.setExtraHTTPHeaders({ 'accept-language': locale })`, và `context.addCookies` cho origin preview. Lấy pid từ `browser.process()`.
- [ ] **Step 5: Chạy và xác nhận test xanh.** Chạy thêm 2 lần.
- [ ] **Step 6: Commit** `feat(p3): headless browser with per-account sessions and capture steps`.

### Task 7: `PreviewManager`

**Files:**
- Create: `src/preview/manager.ts`
- Modify: `src/core/model.ts` (`HubEvent` thêm `{ type: 'preview'; ticketId: string; preview: PreviewStatus }`)
- Test: `tests/preview/manager.test.ts`

**Interfaces:**
- Consumes: `PreviewServer`, `freePort`, `worktreeSignature` (Task 4); `TicketBrowser`, `findBrowser`, `LoginError` (Task 6); `validateCaptureArgs`, `formatResult`, `formatError`, `redact` (Task 5); `resolveProject` (Task 1).
- Produces:
  ```ts
  export interface CaptureRequest { ticketId: string; agentId: string; worktree: string; projectDir: string; mode: 'dev' | 'prod'; outDir: string; args: unknown }
  export interface PreviewManagerDeps {
    settings(): { projects: Record<string, ProjectPreview> };
    publish(e: HubEvent): void;
    getMeta(k: string): string | undefined; setMeta(k: string, v: string): void;
    /** để test thay thế */
    makeServer?: (d: PreviewServerDeps) => PreviewServer;
    makeBrowser?: (o: ConstructorParameters<typeof TicketBrowser>[0]) => TicketBrowser;
    findBrowser?: () => string | null;
    fetchOk?: (url: string) => Promise<boolean>;
    idleMs?: number;   // mặc định 600000
    now?: () => number;
  }
  export class PreviewManager {
    constructor(deps: PreviewManagerDeps);
    /** Trả text cho kết quả tool MCP; lỗi thì isError: true kèm formatError. */
    capture(req: CaptureRequest): Promise<{ text: string; isError?: boolean }>;
    status(ticketId: string): PreviewStatus | null;
    stop(ticketId: string): Promise<void>;
    stopAll(): Promise<void>;
    /** Lúc khởi động: killTree mọi pid còn lưu ở meta 'previewPids' rồi xoá. */
    killOrphans(): Promise<void>;
    /** Tên và mô tả tài khoản cho prompt; không có mật khẩu. */
    accountsFor(projectDir: string): { name: string; description: string }[];
  }
  ```
  - **Trình tự của `capture`:**
    1. `resolveProject`; không có thì `not_configured`.
    2. `validateCaptureArgs`; sai thì `invalid_args`.
    3. Có `as` mà dự án có `backend.healthUrl`: `fetchOk` (GET, timeout 3000 ms, mã < 500) thất bại thì trả `backend_down` với thông báo `Backend không phản hồi tại <url>. Gọi request_user_action nhờ người dùng bật backend.`
    4. Lấy một trong 2 slot của ticket; quá 2 lần gọi thì chờ.
    5. `server.ensure()`, lỗi thì `server_failed`.
    6. Trình duyệt được tạo lười; `findBrowser()` null thì `server_failed` với `Không tìm thấy Chrome hoặc Edge`.
    7. `runCapture` có timeout 120 000 ms; `LoginError` thì `login_failed`.
    8. Gộp phần `server` vào kết quả, rồi trả `formatResult`.
    9. Đặt lại hẹn giờ rảnh 600 000 ms.
  - `stop` huỷ các lần gọi đang chờ slot (trả `busy_cancelled`), đóng trình duyệt rồi tắt server.
  - `meta 'previewPids'` là JSON `{ [ticketId]: number[] }`, cập nhật mỗi khi pid đổi.
  - Mỗi lần trạng thái server đổi thì `publish({ type: 'preview', … })`.

- [ ] **Step 1: Viết test** với server, browser và `fetchOk` giả, đồng hồ giả hoặc `vi.useFakeTimers` cho hẹn giờ rảnh. Các assert:
  - **Bật một lần** (Review Focus 2): hai lần `capture` song song khi server chưa bật thì `makeServer` được gọi đúng một lần, `ensure` được gọi hai lần trên cùng một instance, cả hai trả kết quả `ok`.
  - **Giới hạn 2:** lần gọi thứ ba chỉ chạy `runCapture` sau khi một trong hai lần trước xong (kiểm thứ tự bằng các promise mở).
  - **Lỗi môi trường:**
    - `fetchOk` false và có `as` thì text bắt đầu bằng `[capture:backend_down]`, browser không được tạo;
    - không có `as` thì không kiểm backend;
    - `resolveProject` null thì `[capture:not_configured]`;
    - `LoginError` thì `[capture:login_failed]`.
  - **Không lộ mật khẩu:** text kết quả không chứa mật khẩu dù `runCapture` giả cố tình trả mật khẩu trong `console`.
  - **Huỷ ticket** (Review Focus 4): `stop()` khi `ensure()` đang treo (đang build) thì server giả được `stop`, `capture` đang treo trả lỗi, `status()` là `stopped`, và `previewPids` của ticket bị xoá.
  - **Tắt khi rảnh:** tiến 600 000 ms sau lần gọi cuối thì server `stop` và có event `preview` với `state: 'stopped'`.
  - **Mồ côi:** `killOrphans()` với meta `{ "T-1": [999999] }` không ném lỗi và xoá meta.
  - **Prompt:** `accountsFor` trả `[{ name, description }]`, không có `password`.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.**
- [ ] **Step 4: Chạy và xác nhận test xanh.**
- [ ] **Step 5: Commit** `feat(p3): preview manager per ticket (lazy server, concurrency, idle stop, orphans)`.

### Task 8: Nối vào orchestrator và guard

**Files:**
- Modify:
  - `src/guard/policy.ts`: `CAPTURE_TOOL`, nhánh `designer` cho MCP đọc;
  - `src/orchestrator/mcp.ts`: `TOOL_DEFS` thêm `capture`;
  - `src/orchestrator/orchestrator.ts`;
  - `src/server/core.ts`: tạo `PreviewManager`, `stop()` gọi `stopAll()`;
  - `tests/helpers/orchestratorEnv.ts`: truyền `preview` giả.
- Test: `tests/orchestrator/preview.test.ts`, `tests/guard/policy.test.ts`

**Interfaces:**
- Consumes: `PreviewManager` (Task 7).
- Produces:
  - `export const CAPTURE_TOOL = 'mcp__acctv__capture'` trong `policy.ts`.
  - `OrchestratorDeps.preview?: Pick<PreviewManager, 'capture' | 'stop' | 'stopAll' | 'killOrphans' | 'accountsFor' | 'status'>`.
  - Trong `TOOL_DEFS`, mục `capture` có `inputSchema` khớp với `CaptureArgs`. Description: "Mở trang của ticket trong Chrome headless trên server preview do dashboard quản lý (đăng nhập theo tên tài khoản test nếu có `as`), chạy các bước, trả ảnh (đường dẫn PNG để Read), số đo DOM, URL, console, request ghi. Không tự bật server hay trình duyệt."

- [ ] **Step 1: Viết test.**
  - `tests/guard/policy.test.ts`:
    - `CAPTURE_TOOL` được phép cho `dev`, `designer`, `qc`, bị từ chối cho `explorer`;
    - `mcp__figma__get_design_context` được phép cho `designer` với `explicit: true`, bị từ chối cho `qc`;
    - `ToolSearch` được phép cho `designer`.
  - `tests/orchestrator/preview.test.ts` dùng `makeEnv` với `preview` giả ghi nhận các lần gọi:
    - Spawn `designer` (claude): `spec.tools` chứa `mcp__acctv__capture` và `ToolSearch`, `spec.userMcp === true`. `qc` có `capture` nhưng không có `userMcp`. Worker codex không có `capture`.
    - `workerMcpTools(qcId)` có `capture`. Gọi tool này thì `preview.capture` nhận `{ ticketId, agentId, worktree: t.worktree, projectDir: t.dir, mode, outDir: <home>/runs/<T>/qc-1/captures }`. `mode` lấy `plan.preview.mode` nếu có, không thì lấy `defaultMode` của dự án, không có nữa thì `'dev'`.
    - Guard của qc cho phép `Read` file trong `outDir`, từ chối `Read` trong thư mục `captures` của agent khác.
    - `finish` (done hoặc escalated) và `cancel` gọi `preview.stop(T)`. `shutdown` gọi `stopAll`. `recover` gọi `killOrphans` đúng một lần.
    - `auditChanges` không báo `next-env.d.ts` là thay đổi ngoài phạm vi.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.**
  - `WORKER_TOOLS`: designer thêm `ToolSearch`.
  - `workerTools(runner, role)`: runner là claude và role thuộc dev, designer, qc thì thêm `CAPTURE_TOOL`.
  - `startWorker`:
    - `policy(role, wt, captures ? [outDir] : [], m.files)`;
    - `userMcp` cho explorer và designer;
    - `mkdirSync(outDir, { recursive: true })`.
  - `checkTool`: `CAPTURE_TOOL` cho dev, designer, qc; designer dùng chung nhánh MCP đọc với explorer.
  - `auditChanges`: lọc `next-env.d.ts` khỏi danh sách `out`.
- [ ] **Step 4: Chạy và xác nhận test xanh.** Toàn bộ `tests/orchestrator` phải xanh.
- [ ] **Step 5: Commit** `feat(p3): wire capture into worker MCP, guard and ticket lifecycle; Figma read for Designer`.

### Task 9: Prompt

**Files:**
- Modify: `src/orchestrator/prompts.ts`, `src/orchestrator/orchestrator.ts` (truyền thêm ngữ cảnh cho `systemPrompt`)
- Test: `tests/orchestrator/prompts.test.ts`

**Interfaces:**
- Produces: tham số `ctx` của `systemPrompt` thêm `preview?: { mode: 'dev' | 'prod'; accounts: { name: string; description: string }[]; capture: boolean }`.
- Nội dung bắt buộc (test so theo các cụm chữ này):
  - **Mọi vai có `capture: true`:**
    - `Dùng tool capture để xem trang đang chạy; không tự chạy next dev, next start hay next build.` Phần build mà tiêu chí nghiệm thu yêu cầu vẫn giữ quy tắc build một lần sẵn có;
    - danh sách `Tài khoản test (dùng as: "<name>"):` liệt kê từng dòng `` - `<name>`: <description> ``;
    - `Chế độ server: <mode>`;
    - `Lỗi [capture:backend_down], [capture:login_failed], [capture:server_failed] là lỗi môi trường, không phải lỗi của Dev`.
  - **Designer:**
    - `get_design_context` (excludeScreenshot) và `get_variable_defs`;
    - `measure` ở đúng viewport của frame;
    - `lệch tối đa ±1px`;
    - `màu phải khớp đúng (hoặc khớp token)`;
    - báo lỗi kèm `file:dòng` và đường dẫn ảnh.
  - **QC:**
    - `` tên bắt đầu bằng `acctv-<ticket>-` `` với id ticket thật;
    - `không sửa hay xoá dữ liệu seed`;
    - `thử quyền trên dữ liệu seed`;
    - `dọn dữ liệu đã tạo`;
    - mục `Request ghi` trong báo cáo.
  - **Controller:**
    - task giao Designer phải ghi `fileKey`/`nodeId` của từng frame và viewport;
    - có thể đặt `preview.mode` là `prod` khi tiêu chí nghiệm thu đụng tới SSR, redirect, middleware hay header.
  - **Worker codex (`capture: false`):** `Không có tool capture`.

- [ ] **Step 1: Viết test** cho từng vai theo các cụm chữ trên. Thêm hai assert phủ định: prompt không chứa `password` hay chuỗi mật khẩu giả `secret1` dù `accountsFor` của test có tài khoản mang mật khẩu đó; vai `explorer` không có đoạn nào về `capture`.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.** Orchestrator truyền `preview` từ `deps.preview.accountsFor(t.dir)` và `mode` (cùng cách tính như Task 8).
- [ ] **Step 4: Chạy và xác nhận test xanh.**
- [ ] **Step 5: Commit** `feat(p3): prompts for capture, Figma comparison and QC data rules`.

### Task 10: Route HTTP

**Files:**
- Modify: `src/server/routes.ts` (`Reply` thêm `body?: Buffer; contentType?: string`; `handleApi` ghi body nhị phân), `src/orchestrator/orchestrator.ts` (thêm `previewStatus(T)`, `stopPreview(T)`, `resetProjectDb(dir)`)
- Test: `tests/server/api.test.ts`

**Interfaces:**
- **Route:**
  - `GET /api/tickets/:id` thêm trường `preview: PreviewStatus | null`.
  - `POST /api/tickets/:id/preview/stop` trả `{ ok: true }`.
  - `GET /api/agents/:id/captures` trả `{ name: string; file: string; at: number }[]`, lấy từ thư mục `captures` của agent, mới nhất trước.
  - `GET /api/captures/:ticket/:slot/:file` trả PNG.
    - `:file` phải khớp `/^\d+-[\w-]{1,40}\.png$/`, đường dẫn thật phải nằm trong `<home>/runs`.
    - Dùng `inside()` của `src/core/paths.ts`, sai thì 404.
    - Header: `content-type: image/png`, `cache-control: no-store`.
  - `POST /api/projects/reset-db` nhận `{ dir }`, trả `{ code: number | null; tail: string }`.
    - Chạy `db.resetCommand` trong `db.cwd` qua shell, timeout 300 000 ms.
    - `tail` là 4000 ký tự cuối, đã che mật khẩu.
    - Dự án không có `db` thì 400.
- Orchestrator: `previewStatus(T)` uỷ quyền cho `deps.preview.status`. `stopPreview(T)` gọi `deps.preview.stop`.

- [ ] **Step 1: Viết test.**
  - `GET` ticket có `preview: null` khi chưa từng gọi `capture`.
  - `POST …/preview/stop` gọi `stop`.
  - `GET /api/captures/T-1/qc-1/1-home.png` trả đúng byte của file đã ghi sẵn.
  - `GET /api/captures/T-1/qc-1/..%2F..%2Fconfig.json` và `…/x.txt` trả 404.
  - `reset-db` với `resetCommand: 'node -e "console.log(42)"'` trả `code: 0` và `tail` chứa `42`.
  - `reset-db` có header `origin` lạ thì 403 (kiểm origin đã có sẵn).
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code.**
- [ ] **Step 4: Chạy và xác nhận test xanh.**
- [ ] **Step 5: Commit** `feat(p3): preview status, capture images and manual DB reset over HTTP`.

### Task 11: Giao diện

**Files:**
- Modify:
  - `app/lib/liveStore.ts`: lưu `previews: Record<ticketId, PreviewStatus>` từ event `preview` và từ `GET` ticket;
  - `app/components/TicketHeader.tsx`: chip trạng thái server và nút "Tắt server";
  - `app/components/AgentDetail.tsx`: khung "Ảnh chụp" cho agent dev, designer, qc;
  - `app/settings/SettingsForm.tsx`: mục "Dự án".
- Create: `app/lib/projectsForm.ts` (chuyển giữa `ProjectPreview` và trạng thái form, tách ra để test được)
- Test: `tests/app/liveStore.test.ts`, `tests/app/projectsForm.test.ts`

**Interfaces:**
- Produces:
  - `export function previewLabel(s: PreviewStatus | null): string` trong `app/lib/tickets.ts`. Kết quả lần lượt theo trạng thái:
    - `null` hoặc `stopped`: `'Server: tắt'`;
    - `starting`: `'Server: đang bật'`;
    - `building`: `'Server: đang build'`;
    - `ready`: `` `Server: sẵn sàng :${port} (${mode})` ``;
    - `failed`: `'Server: lỗi'`.
  - `toProjectForm` và `fromProjectForm` trong `app/lib/projectsForm.ts`.

**Nội dung từng phần:**
- **Mục "Dự án"** có danh sách dự án theo thư mục, nút thêm hoặc xoá dự án, và các trường sau:
  - lệnh dev, build, start;
  - chế độ mặc định;
  - `env`, mỗi dòng `KEY=VALUE`;
  - `readyPath`;
  - URL kiểm backend;
  - phần đăng nhập: path, 3 selector và dấu hiệu thành công;
  - bảng tài khoản: name, mô tả, tên đăng nhập, mật khẩu (ô `type=password`, hiện `••••`);
  - lệnh reset và thư mục chạy.
- **Nút "Reset dữ liệu"** có hộp xác nhận `confirm`. Kết quả (mã thoát và log cuối) hiện ngay dưới nút.
- **Lỗi từ API** gắn vào đúng trường, theo cơ chế `errs()` đang có.
- **Khung "Ảnh chụp"** gọi `GET /api/agents/:id/captures`, hiện ảnh thu nhỏ rộng 160px. Bấm vào thì mở ảnh gốc trong tab mới. Không có ảnh thì không hiện khung.

- [ ] **Step 1: Viết test.**
  - `previewLabel` cho từng trạng thái.
  - `liveStore` nhận event `preview` thì cập nhật `previews[T]`.
  - `fromProjectForm(toProjectForm(p))` cho lại đúng `p`.
  - Dòng env `A=1` và `B = x=y` cho `{ A: '1', B: 'x=y' }`. Dòng không có `=` trả lỗi `env: dòng <n>`.
- [ ] **Step 2: Chạy và xác nhận thất bại.**
- [ ] **Step 3: Viết code giao diện.**
- [ ] **Step 4: Kiểm trên trình duyệt.**
  - `preview_start` với cấu hình dev của dashboard (`.claude/launch.json`, tạo nếu chưa có: `npm run dev`, cổng 4777).
  - Mở `/settings`, thêm một dự án kèm một tài khoản rồi lưu. Tải lại trang thì mật khẩu hiện `••••`. Lưu lại một lần nữa thì `~/.acctv/config.json` vẫn giữ mật khẩu cũ.
  - Chụp màn hình mục "Dự án" và chip server trên trang ticket.
- [ ] **Step 5: Chạy `npx vitest run` và `npx tsc --noEmit`.**
- [ ] **Step 6: Commit** `feat(p3): settings UI for projects, preview status chip, capture gallery`.

### Task 12: Kiểm toàn bộ với dự án thật

**Files:** chỉ thêm tài liệu: `README.md` (mục "Review trên trình duyệt": cấu hình dự án, tài khoản test, reset dữ liệu).

- [ ] **Step 1: Cấu hình `upload_app_fe` trong Settings.** Lệnh mặc định của Next.js, `backend.healthUrl` của backend local, phần đăng nhập theo form `/login`, và ít nhất 2 tài khoản test lấy từ seed. Người dùng nhập mật khẩu; agent không nhập giá trị nào không lấy từ seed hay từ chính người dùng.
- [ ] **Step 2: Gọi `capture` thật** qua `PreviewManager` bằng một script tạm trong scratchpad, không commit. Gọi cho worktree của T-5 với `as` là từng tài khoản, `goto` tới `/workspaces`, cộng `measure` và `shot`. Xác nhận:
  - server lên trong 120 giây;
  - đăng nhập được với từng tài khoản;
  - ảnh và số đo hợp lý;
  - `stop()` không để lại tiến trình `node` hay `chrome` mồ côi (kiểm bằng `Get-Process` trước và sau).
- [ ] **Step 3: Cập nhật README rồi commit** `docs: browser review setup`.

---

## Phần tự rà soát

- **Spec đã có task cho mọi mục:**
  - mục 4 (cấu hình, env): Task 1 và 2;
  - mục 5 (server): Task 4 và 7, nút tắt ở Task 10 và 11;
  - mục 6 (trình duyệt, `capture`, bảo mật, ảnh): Task 5, 6, 7 và 10;
  - mục 7 (quyền, prompt): Task 8 và 9;
  - mục 8 (reset): Task 10 và 11;
  - mục tiêu 5 và `denyBash` `.acctv`: Task 1.
- **Khác spec:** ảnh thu nhỏ hiện trong khung "Ảnh chụp" của chi tiết agent (Task 11), không gắn vào từng call trên timeline, vì call trong store không lưu output. Spec để phần này cho người làm quyết.
- **Kiểm chéo tên:** `CaptureRequest.mode` và `ServerInfo.mode` dùng chung `'dev' | 'prod'`. `PreviewStatus` dùng chung ở Task 4, 7, 10 và 11. `CAPTURE_TOOL` được định nghĩa ở Task 8 và dùng lại ở Task 9.
