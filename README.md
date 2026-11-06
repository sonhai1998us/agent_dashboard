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
3. Sau khi duyệt, Controller giao việc cho các subagent dev, designer, qc, tối đa 3 agent chạy song song và 3 vòng mỗi ticket (chỉnh được trong Settings).
4. Ticket kết thúc ở `done`, `escalated` hoặc `cancelled`.

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
- Người dùng tự merge nhánh `acctv/*`. Dashboard không bao giờ `git push`.
- `~/.claude` và `~/.codex` chỉ được đọc.

### Quyền theo vai

| Vai | Đọc | Sửa file | Bash |
| --- | --- | --- | --- |
| Controller | mọi nơi | mọi nơi, trừ `.git`, `ACCTV_HOME`, `~/.claude`, `~/.codex` | chỉ bị chặn bởi danh sách deny (gồm `git commit`/`push`) |
| Dev | trong thư mục làm việc | chỉ file trong phạm vi được giao | chỉ bị chặn bởi danh sách deny |
| Designer, QC | trong thư mục làm việc | không | chỉ lệnh kiểm tra (`checkCommands`), không nối lệnh, không chuyển hướng, không dùng `--output` |

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

### Agent cần bạn (đăng nhập, mở link…)

Khi một Dev/QC/Designer (Claude) cần bạn làm việc nó không tự làm được, ví dụ đăng nhập một CLI qua trình duyệt, nó gọi tool `request_user_action`. Dashboard hiện hộp thoại "Agent cần bạn" gồm hướng dẫn, link (chỉ http/https, mở ở tab mới) và lệnh để bạn chép rồi chạy trong terminal của mình.

- **Đã xong, tiếp tục**: agent chạy tiếp trong cùng phiên, kèm ghi chú của bạn nếu có.
- **Không làm được**: agent hoàn tất phần làm được rồi báo phần còn thiếu.
- **Để sau**: ẩn hộp thoại. Mở lại bằng nút "cần bạn" trên thanh trên, hoặc nút "Mở" trong panel của agent.

Trong lúc chờ, agent không chiếm slot chạy song song. Bạn vẫn dừng được agent ("Dừng → trả Controller"). Tab trình duyệt hiện số yêu cầu đang chờ. Worker Codex chưa có tool này.

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
