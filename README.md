# Agent CCTV

Dashboard cục bộ để theo dõi các agent Claude Code và Codex đang chạy trên máy: trạng thái, timeline call, subagent nằm dưới phiên cha, cảnh báo (kẹt, tool chạy lâu, lặp lệnh, lỗi liên tiếp). Nguồn dữ liệu là log trong `~/.claude` và `~/.codex`.

## Yêu cầu

- Node.js >= 22.15 (dùng `node:sqlite` và `zlib.zstdDecompressSync`)
- Đã kiểm thử trên Windows 11

## Cài đặt và chạy

```
npm install
npm run dev                    # chế độ dev (Next dev)
npm run build && npm start     # chế độ production
```

Mặc định mở tại http://127.0.0.1:4777.

## CLI

```
node bin/acctv.mjs serve [--port N] [--dev]
node bin/acctv.mjs ls [--running]
node bin/acctv.mjs watch <id-prefix>
node bin/acctv.mjs logs <id-prefix> [-n 50]
```

Có thể `npm link` để dùng lệnh `acctv` trực tiếp (`acctv serve|ls|watch|logs`). Mọi lệnh nhận `--port N` (mặc định 4777). `serve` không có `--dev` cần `npm run build` trước.

## Biến môi trường

| Biến | Mặc định |
| --- | --- |
| `ACCTV_HOME` | `~/.acctv` (database `acctv.db`, `config.json`) |
| `ACCTV_CLAUDE_DIR` | `~/.claude` |
| `ACCTV_CODEX_DIR` | `~/.codex` |

## Cấu hình

`<ACCTV_HOME>/config.json` (tuỳ chọn):

```json
{
  "backfillHours": 24,
  "thresholds": {
    "stuckMs": 120000,
    "longToolMs": 300000,
    "loopWindow": 20,
    "loopWarn": 3,
    "loopCritical": 10,
    "errorBurst": 5
  }
}
```

- `backfillHours` (24): chỉ nạp các file log có mtime trong khoảng này khi khởi động; đây cũng là cửa sổ thời gian của `/api/snapshot` (agent hoạt động gần nhất trong khoảng đó).
- Kẹt (`stuckMs`) 120 giây; tool chạy lâu (`longToolMs`) 300 giây.
- Lặp: trong `loopWindow` = 20 call gần nhất, cảnh báo từ `loopWarn` = 3 lần, nghiêm trọng từ `loopCritical` = 10 lần.
- Lỗi liên tiếp (`errorBurst`): 5.

## Ticket và Controller

Từ Phần 2, dashboard có thể tự chạy agent theo ticket. Luồng làm việc:

1. Tạo ticket (giao diện hoặc `acctv new`). Trên giao diện, bấm "Chọn thư mục…" để duyệt thư mục dự án trên máy (repo git được đánh dấu `git`), hoặc dán đường dẫn. Controller (luôn là Claude) đọc mã nguồn và đề xuất kế hoạch.
2. Bạn xem kế hoạch, sửa nếu cần rồi bấm Duyệt (hoặc `acctv approve`), hoặc yêu cầu sửa (`acctv revise`).
3. Sau khi duyệt, Controller giao việc cho các subagent explorer, dev, designer, qc, tối đa 3 agent chạy song song và 3 vòng mỗi ticket (chỉnh được trong Settings).
4. Ticket kết thúc ở `done`, `escalated` hoặc `cancelled`.

Tiết kiệm token: Controller lập kế hoạch bằng model của vai controller (mặc định Opus xhigh), còn các lượt sau khi duyệt (giao việc, đọc báo cáo, kết thúc) chạy bằng `controllerExec` (mặc định Sonnet high, chỉnh ở mục "Controller sau duyệt" trong Settings, để trống thì dùng như lúc lập kế hoạch), cùng một session. Designer và QC mặc định Haiku. Explorer đọc được MCP và connector của người dùng (vd. Figma) nhưng guard chỉ cho tool đọc (`get_*`, `list_*`, `search_*`, `whoami`…), để phần đọc thiết kế và code nặng chạy trên model rẻ thay vì nằm lại trong context của Controller.

Vai explorer (mặc định Haiku, effort high) chỉ đọc: tìm và đọc file liên quan tới một gói việc rồi báo lại để Controller giao Dev cụ thể hơn, đỡ tốn token của Controller. Explorer không tính vòng. Khi giao việc, Controller truyền `contextFrom` (vd. `["explorer-1"]` hay `["qc-1"]`): dashboard chèn nguyên văn báo cáo của các agent đó vào prompt của agent mới, nên Controller không phải chép lại báo cáo (token đầu ra, loại đắt nhất). Header ticket hiện tổng thời gian (từ lúc tạo tới event cuối, kèm thời gian chờ duyệt); mỗi lane trên timeline và panel gói việc hiện thời gian làm của agent. Trên màn hình rộng từ 1024px, ba cột cuộn riêng. Trên lane, thanh dày là tool call, đường mảnh xanh dương là lúc model suy nghĩ/viết (rê chuột xem thời gian và token ra); đường nhấp nháy ở cuối là model đang nghĩ. Khung viền đứt màu xám là lúc claude đang khởi động lượt chạy (từ lúc spawn tới dòng đầu tiên nó gửi về); khung đỏ có vạch đỏ ở đầu là lượt bị ngắt vì dashboard tắt hoặc khởi động lại (từ event cuối tới lúc dashboard chạy lại; tool đang chạy dở được đóng với lỗi "bị gián đoạn").

Controller luôn là Claude. Codex chỉ dùng được cho worker dev, designer, qc.

### Lệnh CLI

```
acctv new "<tiêu đề>" --dir <path> [--desc <mô tả>]
acctv plan <T>                  # xem kế hoạch
acctv approve <T>               # duyệt kế hoạch
acctv revise <T> "<góp ý>"      # yêu cầu Controller sửa kế hoạch
acctv stop <T>/<agent>          # dừng một agent, vd: stop T-3/dev-1
acctv ls | watch | logs         # nhận biết ticket và agent do dashboard chạy
```

### Worktree và nhánh

- Mỗi ticket làm việc trong một git worktree riêng ở `~/.acctv/worktrees` (theo `ACCTV_HOME`), trên nhánh `acctv/*`. Repo gốc không bị đụng.
- Worktree mới của dự án Node được dashboard chuẩn bị dependency ngay sau khi duyệt, song song với lượt giao việc của Controller: nhân bản `node_modules` của thư mục dự án (copy-on-write, macOS/Linux) khi lockfile giống hệt và `node_modules` được cài sau lần sửa lockfile cuối, không phải monorepo; nếu không thì chạy lệnh cài theo lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install`). Explorer chạy ngay; Dev, Designer, QC chờ tới khi xong. Cài lỗi thì lỗi được ghi vào log ticket và prompt của các worker đó.
- Người dùng tự merge nhánh `acctv/*`. Dashboard không bao giờ `git push`.
- Commit snapshot mỗi vòng dùng `--no-verify`: hook pre-commit/commit-msg của repo (vd. husky chạy tsc, test, lint, ép format message) không chạy cho các commit này. Hook vẫn chạy khi bạn tự commit hay merge.
- `~/.claude` và `~/.codex` chỉ được đọc.

### Quyền theo vai

| Vai | Đọc | Sửa file | Bash |
| --- | --- | --- | --- |
| Controller | mọi nơi | mọi nơi, trừ `.git`, `ACCTV_HOME`, `~/.claude`, `~/.codex` | chỉ bị chặn bởi danh sách deny (gồm `git commit`/`push`) |
| Dev | trong thư mục làm việc | chỉ file trong phạm vi được giao | chỉ bị chặn bởi danh sách deny |
| Explorer | trong thư mục làm việc | không | không có tool Bash |
| Designer, QC | trong thư mục làm việc | không | chỉ lệnh kiểm tra (`checkCommands`), không nối lệnh, không chuyển hướng, không dùng `--output` |

Dev, Designer và QC (Claude) có thêm tool `capture` (xem "Review trên trình duyệt"). Designer đọc được Figma qua tool đọc của MCP người dùng, giống Explorer.

Controller chạy với quyền như người dùng để đọc được ngữ cảnh khi lập kế hoạch: nạp cấu hình Claude của người dùng (`--setting-sources user,project,local`, gồm plugin và hook của người dùng), các MCP server và connector của người dùng (không `--strict-mcp-config`), dùng mọi tool kể cả CLI như `twg`. Guard cho phép tường minh mọi tool, trừ: lệnh khớp danh sách deny (gồm `git commit`, `git push`, lệnh git đổi nhánh/remote, gọi API của dashboard), lệnh nền, tool MCP có tên kiểu commit/push/merge (vd. `push_files`, `create_or_update_file`, `merge_pull_request`), `EnterWorktree`, và ghi vào `.git`, `ACCTV_HOME`, `~/.claude`, `~/.codex`. Lệnh chạy bằng shell vẫn có thể ghi file ở mọi nơi; Controller được dặn không tự sửa code mà giao Dev.

Phạm vi file của dev được ép bằng hook guard (`[acctv-guard]`). Bash của dev chỉ bị giới hạn bởi danh sách deny nên file do lệnh Bash ghi ra không bị chặn; sau mỗi lần chờ agent, dashboard đối chiếu `git status` của worktree với phạm vi các gói Dev, ghi file đã đổi vào báo cáo và cảnh báo Controller (kèm log ticket) về file ngoài phạm vi.

### Codex

Codex chạy bằng `codex exec --json` và chỉ bật khi tìm thấy CLI `codex` (hoặc đặt `codexPath` trong Settings). Dev dùng sandbox `workspace-write`, designer và qc dùng `read-only`. Codex không có hook nên phạm vi file chỉ nằm trong prompt, không ép được.

### Phát hiện CLI trên Windows

Trên Windows chỉ tự dò các CLI dạng `.exe`. Nếu cài bằng npm (shim `.cmd`), đặt `claudePath` / `codexPath` trong Settings trỏ tới file thực thi thật.

### Hành vi khi chạy

- Tắt dashboard sẽ kill các agent đang chạy và đánh dấu chúng là bị gián đoạn.
- Agent bị rate limit sẽ chờ rồi thử lại sau 60s, 120s, 300s; quá số lần đó thì báo lỗi.
- Lặp lệnh từ `loopCritical` với agent do dashboard chạy thì tự dừng (`auto-stop: loop`); phiên ngoài ticket không bao giờ bị tự dừng.
- Agent Claude đã báo xong lượt (dòng `result`) mà tiến trình chưa thoát sau 10 giây (vd. tiến trình con treo chờ stdin giữ pipe) thì dashboard tắt cả cây tiến trình và vẫn nhận kết quả như lần chạy thành công.

### Agent cần bạn (đăng nhập, mở link…)

Khi một Dev/QC/Designer (Claude) cần bạn làm việc nó không tự làm được, ví dụ đăng nhập một CLI qua trình duyệt, nó gọi tool `request_user_action`. Dashboard hiện hộp thoại "Agent cần bạn" gồm hướng dẫn, link (chỉ http/https, mở ở tab mới) và lệnh để bạn chép rồi chạy trong terminal của mình.

- **Đã xong, tiếp tục**: agent chạy tiếp trong cùng phiên, kèm ghi chú của bạn nếu có.
- **Không làm được**: agent hoàn tất phần làm được rồi báo phần còn thiếu.
- **Để sau**: ẩn hộp thoại. Mở lại bằng nút "cần bạn" trên thanh trên, hoặc nút "Mở" trong panel của agent.

Trong lúc chờ, agent không chiếm slot chạy song song. Bạn vẫn dừng được agent ("Dừng → trả Controller"). Tab trình duyệt hiện số yêu cầu đang chờ. Worker Codex chưa có tool này.

### Review trên trình duyệt

Dev, Designer và QC xem trang đang chạy bằng tool `capture`. Agent không tự bật server hay trình duyệt.

- **Server preview.**
  - Mỗi ticket có một server preview trong worktree của nó, cổng do dashboard cấp, origin luôn là `http://localhost:<cổng>`.
  - Server được bật ở lần `capture` đầu tiên và dùng chung cho mọi agent của ticket.
  - Server tự tắt khi ticket kết thúc hoặc bị huỷ, khi không ai dùng trong 10 phút, khi bạn bấm "Tắt server" trên trang ticket, hoặc khi dashboard tắt.
  - Chế độ `dev` (mặc định) giữ server qua các vòng, nhờ HMR. Chế độ `prod` build rồi start, và build lại khi code trong worktree đã đổi, hoặc khi một lệnh build khác ghi đè `.next/BUILD_ID`.
  - Next.js 16 tách thư mục build của `next dev` (`.next/dev`) khỏi `next build`. Với Next.js 15 trở xuống, `next build` chạy trong worktree khi server dev đang bật sẽ ghi chung `.next`; dùng chế độ `prod` hoặc tránh build song song. Controller đặt `preview.mode: prod` trong kế hoạch khi tiêu chí nghiệm thu đụng tới SSR, redirect, middleware hay header.
- **Trình duyệt.** Dashboard dùng Chrome, không có thì dùng Edge, chạy headless. Biến `ACCTV_BROWSER` trỏ tới file chạy nếu trình duyệt cài ở chỗ khác. Mỗi tài khoản test có phiên (cookie) riêng.
- **Kết quả của `capture`.** Ảnh PNG (agent xem bằng `Read`), số đo DOM (kích thước, màu, font, padding…), URL và chuyển hướng, lỗi console, request ghi (POST/PUT/PATCH/DELETE) kèm mã trạng thái, và tràn ngang. Ảnh lưu ở `ACCTV_HOME/runs/<ticket>/<agent>/captures`, hiện trong panel của agent.
- **Cấu hình dự án** (Settings > Dự án, khoá theo thư mục dự án gốc):
  - lệnh `dev`, `build`, `start` (có `{port}`);
  - chế độ mặc định;
  - biến môi trường thêm;
  - URL kiểm backend;
  - form đăng nhập (trang, selector, dấu hiệu thành công);
  - tài khoản test theo vai trò;
  - lệnh reset dữ liệu.

  Dự án Next.js chưa cấu hình dùng `pnpm exec next dev -p {port}`. Các file `.env*` của thư mục dự án gốc được nạp vào biến môi trường của server preview; chúng không bị chép vào worktree.
- **Tài khoản test.**
  - Mật khẩu chỉ lưu trong `ACCTV_HOME/config.json`. API Settings luôn trả `••••`.
  - Agent chỉ thấy tên và mô tả của tài khoản, gọi kiểu `capture({ as: "owner", … })`, và dashboard tự đăng nhập.
  - Mật khẩu bị thay bằng `***` trong mọi output.
- **Dữ liệu.**
  - Dashboard không bật backend. Bạn tự chạy backend local; dashboard chỉ gọi URL kiểm backend và báo `[capture:backend_down]` nếu nó không phản hồi.
  - QC được dặn đặt tên dữ liệu tự tạo bắt đầu bằng `acctv-<ticket>-`, không sửa hay xoá dữ liệu seed, và dọn dữ liệu đã tạo. Quy tắc này nằm trong prompt, guard không ép được.
  - Nút "Reset dữ liệu" chạy lệnh reset của dự án, và chỉ chạy khi bạn bấm.
- **Codex.** Worker Codex chưa có `capture`.

### Biến môi trường chỉ để thử

`ACCTV_CLAUDE_CMD` (JSON `{"command": "...", "prefixArgs": ["..."]}`) thay CLI claude thật bằng runner giả. Chỉ dùng khi thử nghiệm, không dùng khi chạy thật.

## An toàn dữ liệu

- Chỉ đọc `~/.claude` và `~/.codex`, không bao giờ ghi vào đó. Dữ liệu của app nằm trong `ACCTV_HOME`.
- Server chỉ bind `127.0.0.1`.
- Khi `INGEST_VERSION` (`src/core/version.ts`) đổi, database của app được xoá và nạp lại từ log khi khởi động.

## Giới hạn đã biết

- Định dạng log của Claude Code và Codex không chính thức, có thể đổi bất cứ lúc nào và làm parser sai hoặc thiếu dữ liệu.
- Codex runner được viết theo tài liệu nhưng **chưa được thử với CLI thật**, và không ép được phạm vi file (không có hook).
- Lệnh Bash ghi file của dev không bị chặn trước; chỉ được phát hiện sau (qua git) và báo cho Controller.
- Guard chặn lệnh Bash gọi `127.0.0.1`/`localhost` tới `/api` hoặc `/mcp` của dashboard, nhưng agent vẫn có thể gọi tới API qua cách viết khác của địa chỉ loopback (vd. `127.1`, `127.0.0.2` kèm header `Host` tự đặt) hoặc qua một file script tự viết. Danh sách `denyBash` chỉ là lớp chặn theo mẫu, không phải sandbox.
- Định dạng stream-json của Claude và `codex exec --json` không chính thức, có thể đổi.
- Dashboard khởi động lại thì các subagent đang chạy bị gián đoạn.
- Phát hiện subagent kết thúc dựa vào `SubagentHandback` / `end_turn`.
- Lần tải đầu tiên của Next dev có thể cần tải lại trang.
