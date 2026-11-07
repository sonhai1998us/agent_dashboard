# Agent CCTV — Review trên trình duyệt (server preview, tool `capture`, Figma cho Designer)

*Ngày: 2026-11-07 · Trạng thái: bản nháp chờ duyệt · Nối tiếp [thiết kế chung](2026-11-02-agent-cctv-design.md) và [P2 tickets](../plans/2026-11-04-agent-cctv-p2-tickets.md)*

Ký hiệu: **(người dùng chốt)** là điều người dùng đã nói rõ. **(lựa chọn của tôi)** là điều tôi tự quyết, người dùng đọc lại và có thể đổi. Phần không đánh dấu là hệ quả trực tiếp hoặc hiện trạng của code.

## 1. Vì sao làm

Ở ticket T-5 (dự án Next.js `upload_app_fe`), vòng 1:

- QC muốn bật server và gọi HTTP để kiểm redirect và chọn locale (`next start`, `curl`, `node -e fetch`), nhưng cả 4 cách đều bị guard chặn. QC chỉ chạy được `pnpm typecheck/test/build` và `git diff`.
- Designer tìm Chrome (`ls chrome.exe`), kiểm `node -v`, cả hai đều bị chặn. Designer không chụp được màn hình nào nên chỉ review bằng cách đọc diff.
- Designer không đọc được Figma. Worker chạy với `--strict-mcp-config`, và guard chỉ cho vai `explorer` dùng tool MCP đọc của người dùng ([policy.ts](../../../src/guard/policy.ts), [claudeArgs.ts](../../../src/runner/claudeArgs.ts)).
- Dev (vai này không bị giới hạn lệnh) tự bật `next start`, tự chụp bằng Chrome headless và tự chấm cho chính mình. Như vậy phần kiểm tra lúc chạy không có ai review độc lập.
- Cả vòng chạy `pnpm build` khoảng 5 lần (Dev 3, Designer 1, QC 1) mà vẫn không ai review được giao diện đang chạy.

Người dùng muốn Designer và QC kiểm được giao diện đang chạy thật: so với Figma bằng con số, và thao tác như người dùng thật theo từng vai trò trong ứng dụng.

## 2. Mục tiêu, ngoài phạm vi, thất bại

**Mục tiêu**
1. Mỗi ticket có **một server preview** của frontend, do dashboard bật, dùng chung cho Dev, Designer và QC, và do dashboard tắt. Agent không tự bật server hay trình duyệt.
2. Tool MCP **`capture`** cho Dev, Designer và QC: mở trang trong Chrome headless, có thể đăng nhập bằng tài khoản test theo tên vai trò, chạy một chuỗi bước thao tác, rồi trả về ảnh chụp, số đo DOM, URL, lỗi console và các request mạng.
3. **Designer đọc được Figma** bằng tool đọc của MCP người dùng (giống Explorer), để so số liệu thiết kế với số đo thật trên trang.
4. **QC kiểm theo từng vai trò** bằng các tài khoản test đã có trong dữ liệu seed, có thao tác trên trang (bấm, điền, gửi form) **(người dùng chốt)**.
5. Dashboard **không bao giờ đưa** mật khẩu tài khoản test vào prompt, output của tool, log, hay response `GET` của API. Đây là mức bảo vệ dành cho giá trị test, không phải bí mật thật **(lựa chọn của tôi)**:
   - Tên đăng nhập và email được phép hiện trong ảnh chụp và trong URL.
   - Seed của backend chứa mật khẩu ở dạng chữ thường. Nếu seed nằm trong worktree thì agent vẫn đọc được, và việc này được chấp nhận.
   - Guard thêm một rule `denyBash` chặn lệnh đọc `~/.acctv/config.json`. Read, Glob và Grep đã bị chặn sẵn vì thư mục này nằm ngoài worktree.

**Ngoài phạm vi**
- Bật backend. Người dùng tự chạy backend local **(người dùng chốt)**. Dashboard chỉ kiểm backend có phản hồi không.
- Tự reset cơ sở dữ liệu **(người dùng chốt)**. Lệnh reset chỉ chạy khi người dùng bấm nút.
- Agent chạy Codex. Worker Codex hiện chưa nối MCP của worker ([orchestrator.ts](../../../src/orchestrator/orchestrator.ts), chỗ `mcp: m.runner === 'claude' ? … : null`), nên Codex chưa dùng được `capture` và Figma. Prompt phải nói rõ điều này.
- So pixel tự động giữa ảnh Figma và ảnh chụp (nhiễu do render font, khử răng cưa, dữ liệu động).
- Giả lập thiết bị di động đầy đủ (touch, user agent). Chỉ hỗ trợ đổi kích thước viewport và theme sáng/tối.
- Tự dò lệnh bật server cho các framework ngoài Next.js. Dự án khác vẫn dùng được nếu tự khai lệnh trong cấu hình.

**Thất bại dù vẫn "chạy được"**
- Còn tiến trình server preview hoặc Chrome sống sau khi ticket kết thúc, bị huỷ, hoặc dashboard tắt hay khởi động lại.
- Mật khẩu tài khoản test xuất hiện trong prompt, transcript, output của tool, log ticket, hoặc response `GET` của API settings.
- `capture` mở được URL ngoài server preview của ticket (vd. API của dashboard `127.0.0.1:<port>/api`, hay trang web bất kỳ).
- Agent lại tự chạy `pnpm build` hoặc `next start` song song với server preview rồi làm hỏng thư mục build của nhau.
- Review chậm hơn hẳn hiện nay mà không bắt thêm được lỗi nào (vd. mỗi lần gọi `capture` đều build lại).
- Lỗi ở dashboard (server không lên, đăng nhập hỏng, backend chưa chạy) trông giống lỗi của Dev trong báo cáo QC.

## 3. Ràng buộc

- Windows 11. Kill cây tiến trình bằng `killTree` có sẵn ([proc.ts](../../../src/runner/proc.ts)).
- Hầu hết dự án là **Next.js** **(người dùng chốt)**. Dự án mẫu `upload_app_fe`:
  - script `dev: next dev -p 3000`, `start: next start -p 3000` (cổng ghi cứng trong script);
  - gọi API backend qua `NEXT_PUBLIC_API_URL` (mặc định `http://localhost:3001/api/v1`), giá trị này được nhúng vào bundle lúc build;
  - có `UI_PREVIEW_MODE` cho giao diện mẫu không cần API.
- Đăng nhập thật với backend local bằng **nhiều tài khoản test, mỗi tài khoản một vai trò** **(người dùng chốt)**. Tài khoản và quyền có sẵn trong dữ liệu seed **(người dùng chốt)**.
- Dự án có sẵn lệnh seed/reset cơ sở dữ liệu **(người dùng chốt)**.
- Chrome có ở `C:\Program Files\Google\Chrome\Application\chrome.exe`, Edge có ở `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
- Server dashboard chỉ nghe trên `127.0.0.1`. Guard chạy đồng bộ trong server, không được làm treo event loop.

## 4. Cấu hình theo dự án

Settings có thêm `projects`, khoá là thư mục dự án gốc (`ticket.dir`, so sánh sau khi chuẩn hoá đường dẫn, không phân biệt hoa thường trên Windows). Có giao diện sửa trong trang Settings, mục "Dự án" **(lựa chọn của tôi)**.

```ts
interface ProjectPreview {
  /** Lệnh theo chế độ. `{port}` được thay bằng cổng dashboard cấp. */
  dev: { command: string };                       // mặc định Next.js: `pnpm exec next dev -p {port}`
  prod: { build: string; start: string };         // mặc định: `pnpm exec next build` / `pnpm exec next start -p {port}`
  defaultMode: 'dev' | 'prod';                    // mặc định 'dev'
  env: Record<string, string>;                    // biến môi trường thêm cho server preview (vd. UI_PREVIEW_MODE=0)
  readyPath: string;                              // đường dẫn coi là "server đã lên" khi trả < 500, mặc định '/'
  backend?: { healthUrl: string };                // vd. http://localhost:3001/api/v1/health
  login?: {
    path: string;                                 // vd. '/login'
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
    success: { urlNotMatching?: string } | { selector: string }; // dấu hiệu đăng nhập xong
  };
  accounts: { name: string; description: string; username: string; password: string }[];
  db?: { resetCommand: string; cwd: string };     // chỉ chạy khi người dùng bấm nút
}
```

- Dự án chưa có cấu hình: dashboard dò `package.json`. Có `next` trong dependencies thì dùng mặc định Next.js. Không có thì `capture` trả lỗi "dự án chưa cấu hình server preview" **(lựa chọn của tôi)**.
- Lệnh chạy qua shell trong **worktree của ticket** (không phải thư mục gốc), cộng thêm biến `PORT={port}`.
- **File env:** worktree là bản checkout mới nên không có các file `.env*` bị gitignore, ví dụ worktree T-5 chỉ có `.env.example`. Cách xử lý **(lựa chọn của tôi)**:
  - Dashboard đọc `.env`, `.env.local`, `.env.development(.local)` và `.env.production(.local)` từ **thư mục dự án gốc**, chọn file theo chế độ giống thứ tự ưu tiên của Next.js.
  - Các biến đó chỉ được đưa vào biến môi trường của tiến trình server preview (cả lúc build ở chế độ prod). File không bị chép vào worktree, nên agent không đọc được.
  - `env` trong cấu hình dự án ghi đè lên các biến lấy từ file.
  - Kết quả `capture` ghi tên các file env đã nạp, không ghi giá trị.
- **Tài khoản test:** được lưu trong `~/.acctv/config.json` cùng các thiết lập khác. Đây là giá trị test của ứng dụng đang phát triển, công cụ chạy local cho một người dùng **(lựa chọn của tôi)**. `GET` settings trả mật khẩu đã che (vd. `"••••"`). Khi `PUT` mà mật khẩu vẫn là giá trị che thì giữ nguyên mật khẩu cũ.
- Prompt của agent chỉ có `name` và `description` của từng tài khoản.

## 5. Server preview của ticket

**Một server cho mỗi ticket**, nằm trong worktree của ticket.

- **Bật lười:** lần gọi `capture` đầu tiên của ticket mới bật server. Các lần gọi đến trong lúc server đang bật thì chờ cùng một promise.
- **Cấp cổng:** dashboard lấy một cổng trống (thử bind `127.0.0.1:0` hoặc quét một dải) rồi thay vào `{port}`. Nhiều ticket chạy song song thì mỗi ticket một cổng **(lựa chọn của tôi)**.
  - Backend local chấp nhận frontend ở cổng bất kỳ trên `localhost` (CORS, cookie) **(người dùng chốt)**.
  - Vì vậy origin preview luôn là `http://localhost:{port}`, không dùng `127.0.0.1`.
- **Sẵn sàng:** gọi `http://localhost:{port}{readyPath}` cho tới khi nhận mã < 500. Timeout 120 giây ở chế độ dev, 600 giây cho bước build ở chế độ prod. Hết giờ thì trả lỗi kèm khoảng 2 KB cuối của stdout/stderr.
- **Kiểm backend:** trước lần `capture` đầu tiên cần đăng nhập, nếu có `backend.healthUrl` thì gọi thử URL đó. Không phản hồi thì trả lỗi loại `backend_down`. Prompt dặn agent khi đó gọi `request_user_action` nhờ người dùng bật backend.
- **Chế độ:**
  - Mặc định lấy `defaultMode` của dự án.
  - Controller có thể ghi đè cho cả ticket bằng trường tuỳ chọn `preview: { mode }` trong kế hoạch (`propose_plan`), khi tiêu chí nghiệm thu đụng tới SSR, redirect, middleware hay header **(lựa chọn của tôi)**.
  - Agent không đổi được chế độ trong lúc gọi `capture`.
- **Chế độ prod và code đã đổi:**
  - Mỗi lần build, dashboard ghi một chữ ký của worktree: `HEAD` + hash của `git diff HEAD` + danh sách file untracked.
  - Đến lần `capture` sau, chữ ký khác thì tắt server, build lại rồi start lại.
  - Chế độ dev không cần làm việc này vì HMR tự cập nhật.
- **Tắt server:**
  1. Ticket chuyển sang `done`, `escalated` hoặc `cancelled`.
  2. Không có `capture` nào trong 10 phút **(lựa chọn của tôi)**.
  3. Người dùng bấm "Tắt server" trên trang ticket.
  4. Dashboard tắt.

  Server chế độ dev được giữ qua các vòng: Dev sửa xong, HMR cập nhật, vòng review sau dùng lại luôn.
- **Tiến trình mồ côi:** pid của server preview và Chrome được lưu trong meta của store. Khi dashboard khởi động, nó `killTree` các pid đã lưu (cùng cách xử lý trạng thái `interrupted` hiện có).
- **Build song song:** prompt của Dev, Designer và QC dặn không tự chạy `next dev`, `next start` hay `next build` khi đã có `capture`. Phần build mà tiêu chí nghiệm thu yêu cầu vẫn được chạy, nhưng chỉ một lần.
  - *Việc của người làm:* kiểm Next 16 có tách thư mục build của `next dev` khỏi `next build` không (vd. `.next/dev`). Nếu không tách thì khi server dev đang chạy, chặn `next build` trong worktree đó bằng guard, hoặc để `capture` báo rõ là server bị hỏng vì có lệnh build chạy chen.
- **Giao diện:** trang ticket hiện trạng thái server: `đang bật` / `đang build` / `sẵn sàng :{port}` / `lỗi` kèm log cuối, có nút "Tắt server". Lần chờ build hoặc start hiện trên timeline giống một call dài của `capture`, không cần thêm loại khoảng chờ mới.

## 6. Trình duyệt và tool `capture`

**Trình duyệt:**
- Dùng Chrome đã cài trên máy, Edge nếu không có Chrome, điều khiển qua DevTools Protocol, không tải trình duyệt mới.
- Thư viện gợi ý: `playwright-core` với `executablePath` trỏ vào Chrome hay Edge của máy **(lựa chọn của tôi)**. Người làm được chọn thư viện khác nếu đáp ứng được các bước ở dưới.
- Mỗi ticket một tiến trình trình duyệt headless.
- Mỗi tài khoản một **phiên riêng** (browser context: cookie và storage tách biệt). Gọi không kèm `as` là khách chưa đăng nhập.

**Đăng nhập:**
- Lần đầu dùng một tài khoản, dashboard mở `login.path`, điền tên đăng nhập và mật khẩu, bấm gửi, rồi chờ dấu hiệu `success`.
- Phiên đăng nhập được giữ suốt vòng đời của trình duyệt trong ticket.
- Đang chạy mà bị chuyển về `login.path` thì dashboard đăng nhập lại một lần. Vẫn hỏng thì trả lỗi `login_failed`, có ảnh chụp trang đăng nhập.
- Agent không tự điền form đăng nhập bằng thông tin tài khoản test và không biết các giá trị đó.

**Định nghĩa tool (MCP của worker, cạnh `request_user_action`):**

```ts
capture({
  as?: string,                        // tên tài khoản; bỏ trống = khách
  viewport?: { width: number; height?: number },   // mặc định 1440×900; width 320..1920
  colorScheme?: 'light' | 'dark',
  locale?: string,                    // đặt Accept-Language và navigator.language
  cookies?: { name: string; value: string }[],     // cookie thêm cho origin của server preview
  steps: Step[],                      // 1..30 bước
})

type Step =
  | { goto: string }                  // đường dẫn tương đối, vd. '/workspaces'
  | { click: Target }
  | { fill: Target; value: string }
  | { select: Target; value: string }
  | { check: Target; checked?: boolean }
  | { press: string; target?: Target }            // vd. 'Enter'
  | { upload: Target; file: string }  // đường dẫn tương đối trong worktree
  | { waitFor: Target | { url: string } }
  | { shot: string; fullPage?: boolean; target?: Target }   // tên ảnh
  | { measure: Target[] }

type Target = string                  // CSS selector, hoặc 'text=…', 'role=button[name="Lưu"]', 'testid=…'
```

**Quy tắc:**
- `goto` chỉ nhận đường dẫn tương đối, trên origin của server preview. Trang vẫn gọi API backend bình thường.
- Mọi điều hướng chính của trang ra ngoài origin preview đều bị chặn và báo lỗi bước.
- Mỗi bước chờ tối đa 10 giây. Cả lần gọi tối đa 120 giây (chưa tính thời gian bật hoặc build server).
- Tối đa 6 ảnh mỗi lần gọi. Ảnh toàn trang bị cắt ở chiều cao 8000px.
- Mỗi lần gọi mở một tab mới trong phiên của tài khoản. Cookie được giữ, nhưng trạng thái trên trang thì không.
- Mỗi ticket chạy tối đa 2 lần `capture` cùng lúc, lần thứ ba xếp hàng chờ **(lựa chọn của tôi)**.
- Bước lỗi thì dừng lại, nhưng vẫn trả về mọi thứ đã thu được tới bước đó, kèm một ảnh chụp tự động tại bước lỗi.

**Kết quả trả về (text, dạng JSON gọn):**
- `server`: `{ mode, port, startedNow, buildMs? }`.
- `steps`: mỗi bước có `ok` / `error` và thời gian.
- `finalUrl`, mã HTTP của lần điều hướng chính cuối cùng, và các lần chuyển hướng.
- `console`: các lỗi và cảnh báo, mỗi dòng tối đa 300 ký tự, tối đa 30 dòng.
- `requests`:
  - mọi request ghi (POST, PUT, PATCH, DELETE) gồm `method`, `url`, `status`;
  - các request lỗi (≥ 400 hoặc lỗi mạng).
  - Không gồm body và header.
- `overflow`: `scrollWidth` so với `clientWidth` của trang, cộng tối đa 10 phần tử tràn ra ngoài viewport (selector rút gọn và kích thước).
- `measures`: mỗi phần tử khớp (tối đa 20 phần tử cho mỗi target) gồm:
  - `rect` (x, y, width, height);
  - các thuộc tính computed: `color`, `background-color`, `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `padding`, `margin`, `gap`, `border`, `border-radius`, `box-shadow`, `opacity`, `display`.
- `shots`: đường dẫn tuyệt đối tới các file PNG.

**Nơi lưu ảnh và cách agent xem ảnh:**
- Ảnh lưu ở `~/.acctv/runs/<ticket>/<agent>/captures/<n>-<tên>.png`.
- Thư mục `captures` của chính agent được thêm vào `readRoots` trong policy guard của agent đó, để agent dùng `Read` xem ảnh. Agent chỉ xem ảnh nó cần, nên đỡ tốn token hơn trả ảnh thẳng trong kết quả tool **(lựa chọn của tôi)**.

**Bảo mật:**
- Kết quả trả về, log và ảnh chụp không chứa mật khẩu. Ô mật khẩu khi chụp đã bị che sẵn trên giao diện, và request đăng nhập không ghi body.
- Nếu một bước `fill` nhận đúng giá trị mật khẩu của một tài khoản test thì vẫn chạy, nhưng giá trị đó được thay bằng `***` trong mọi chỗ ghi lại.

**Giao diện:** chi tiết call `capture` trên timeline hiện ảnh thu nhỏ. Dashboard phục vụ ảnh qua một route chỉ đọc, chỉ trong `~/.acctv/runs` **(lựa chọn của tôi)**.

## 7. Quyền theo vai

| Vai | `capture` | Figma (MCP đọc của người dùng) | Bash |
|---|---|---|---|
| Explorer | không | có (như hiện nay) | không |
| Dev | có | không | như hiện nay |
| Designer | có | **có** | `checkCommands` |
| QC | có | không | `checkCommands` |
| Controller | không | có (như hiện nay) | như hiện nay |

**Thay đổi trong code:**
- **`WORKER_TOOLS`:**
  - thêm `mcp__acctv__capture` cho dev, designer và qc khi runner là Claude;
  - thêm `ToolSearch` cho designer.
- **Spawn:** đặt `userMcp: true` cho designer, giống explorer. Guard cho designer dùng `isUserMcpReadTool` và `ToolSearch`, giống explorer.
- **Guard:** cho phép tool `capture` với dev, designer và qc.
- **`denyBash` mặc định:** thêm một mẫu chặn lệnh nhắc tới `.acctv[\\/]config.json` (mục 2, mục tiêu 5).

**Thay đổi trong prompt:**
- **Controller:** kế hoạch có giao diện thì Designer cần biết thiết kế ở đâu. Task giao Designer phải ghi `fileKey`/`nodeId` của từng frame cần so, cùng kích thước viewport tương ứng. Controller có thể đặt `preview.mode` trong kế hoạch.
- **Designer:**
  - lấy số liệu bằng `get_design_context` (excludeScreenshot) và `get_variable_defs`;
  - chỉ gọi `get_screenshot` khi cần xem bố cục tổng thể;
  - gọi `capture` có `measure` ở đúng viewport của frame;
  - so từng cặp số: kích thước và khoảng cách lệch tối đa ±1px, màu phải khớp đúng (hoặc khớp token), font và độ đậm phải khớp đúng;
  - xem ảnh để bắt lỗi tổng thể;
  - báo lỗi kèm `file:dòng` và đường dẫn ảnh làm bằng chứng.
- **QC:**
  - kiểm từng tiêu chí nghiệm thu bằng `capture`, theo từng vai trò được liệt kê;
  - dữ liệu tự tạo phải có tên bắt đầu bằng `acctv-<ticket>-`;
  - không sửa hay xoá dữ liệu seed: kịch bản sửa hay xoá thì tự tạo dữ liệu trước rồi thao tác trên đó;
  - thử quyền ("vai X không được làm Y") trên dữ liệu seed vẫn được, vì backend đúng sẽ từ chối;
  - cuối lượt dọn dữ liệu đã tạo nếu ứng dụng có chức năng xoá **(người dùng chốt)**;
  - báo cáo có mục "Request ghi" liệt kê mọi request ghi mà `capture` ghi nhận được.
- **Dev:** có thể dùng `capture` để tự xem kết quả thay cho tự bật server. Không chạy `next dev` / `next start` riêng.
- **Mọi vai dùng `capture`:**
  - có danh sách tài khoản (tên + mô tả) và chế độ server của ticket;
  - lỗi loại `backend_down`, `login_failed` hay `server_failed` là lỗi môi trường, không phải lỗi của Dev: báo đúng như vậy và gọi `request_user_action` khi cần.
- **Worker Codex:** prompt ghi rõ là không có `capture`.

Quy tắc "chỉ đụng vào dữ liệu `acctv-`" chỉ nằm trong prompt. Guard không ép được, vì dashboard không biết một request ghi đang nhắm vào bản ghi nào. Lưới an toàn là danh sách request ghi trong báo cáo và nút reset.

## 8. Reset cơ sở dữ liệu

- Lệnh `db.resetCommand` chạy trong `db.cwd`, chỉ khi người dùng bấm nút "Reset dữ liệu" trong Settings > Dự án (có hộp xác nhận) **(người dùng chốt)**.
- Agent không gọi được lệnh này.
- Kết quả (mã thoát và log cuối) hiện ngay dưới nút.
- Dùng khi dữ liệu seed bị hỏng, ví dụ backend có lỗi phân quyền làm một lần thử "phải bị từ chối" lại ghi thật.

## 9. Phần để người làm quyết

- Thư viện điều khiển trình duyệt và cách diễn giải `Target`, miễn hỗ trợ được CSS, chữ hiển thị, role kèm tên, và test id.
- Cách lấy cổng trống và cách dò "server đã sẵn sàng".
- Cấu trúc module, ví dụ `src/preview/server.ts`, `src/preview/browser.ts`, `src/preview/capture.ts`.
- Cách lưu và hiển thị trạng thái server trên UI, cách hiện ảnh thu nhỏ trên timeline.
- Kiểm cách Next 16 dùng thư mục build ở chế độ dev và prod (mục 5), rồi chọn cách chống build chen.
- Timeout của MCP tool trong Claude Code. Kiểm `capture` có lần build 600 giây không bị client MCP cắt ngang. Nếu bị cắt thì tách lần build ra (vd. `capture` trả `server_starting` và agent gọi lại).
- Test: giả lập server preview bằng một HTTP server nhỏ, và giả lập trình duyệt ở tầng orchestrator. Có ít nhất một test e2e thật với Chrome trên một trang tĩnh, test này bỏ qua nếu máy không có Chrome.
