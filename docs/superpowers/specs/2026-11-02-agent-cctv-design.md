# Agent CCTV — Thiết kế

*Ngày: 2026-11-02 · Trạng thái: bản nháp chờ duyệt · Tên dự án "Agent CCTV" và lệnh `acctv` là tên tạm*

## 1. Mục đích và lý do

Người dùng chạy nhiều coding agent trên máy (chủ yếu Claude Code và Codex) nhưng không nhìn được bên trong chúng khi đang chạy: agent nào đang làm gì, call nào thành công hay thất bại, latency bao nhiêu, có đang **kẹt** hay **lặp vòng** không, tốn bao nhiêu token. Họ cần một "camera giám sát" cho agent.

Họ cũng muốn **giao việc** theo kiểu một văn phòng: tạo ticket và giao cho một **Controller**. Controller lập kế hoạch, người dùng duyệt, rồi Controller điều phối các subagent **Dev, Designer, QC**, mỗi vai chạy với model và effort phù hợp. Mọi bước đều phải nhìn thấy được trên UI.

Ý tưởng đã có sẵn ở skill `/office` trên máy (`~/.claude/skills/office`, gồm Lead, office-dev, office-designer, office-qc). Người dùng muốn **một ứng dụng hoàn toàn mới, độc lập**, không phải mod của Claude Code và không phụ thuộc `/office`. `/office` chỉ dùng để tham khảo cách chia vai và vòng review.

## 2. Mục tiêu, ngoài phạm vi, thất bại

**Mục tiêu**
1. Tạo ticket và giao cho Controller (trên web hoặc CLI).
2. Controller đề xuất kế hoạch (số Dev, có Designer hay không, QC kiểm gì, model và effort từng vai). **Người dùng duyệt xong Dev mới được bắt đầu.**
3. Theo dõi trực tiếp: cây Controller → subagent, từng tool call, thành công/thất bại, latency, token, thời gian.
4. Tự phát hiện **kẹt**, **lặp**, **lỗi dồn dập** và cảnh báo trên UI.
5. Bấm **Dừng** một agent → agent bị tắt, kết quả dở dang được **trả về Controller** để nó quyết định bước tiếp.
6. Theo dõi luôn các phiên Claude Code/Codex người dùng tự mở ngoài dashboard ("phiên ngoài ticket"), ở chế độ chỉ xem.
7. Có CLI làm được các việc chính giống web.

**Ngoài phạm vi (bản đầu)**
- Các agent khác: OmniRoute (người dùng nói rõ là không dùng), Copilot, Kiro, Gemini Antigravity, Continue, Cursor. Kiến trúc adapter phải cho phép thêm sau, nhưng bản này không làm.
- Nhiều người dùng, đăng nhập, chạy trên server từ xa. Đây là công cụ local một người dùng.
- Dừng hoặc điều khiển các phiên ngoài ticket. Dashboard không khởi chạy chúng nên chỉ xem.
- Tích hợp Jira/GitHub.

**Thất bại dù vẫn "chạy được"**
- Không dừng được **đúng một** agent mà không làm chết Controller hoặc các agent khác.
- Số liệu trên UI cũ hoặc sai mà không báo. Dữ liệu live phải ghi rõ thời điểm cập nhật cuối và báo khi nguồn bị ngắt.
- Dev chạy thẳng khi kế hoạch chưa được duyệt.
- Dashboard ghi vào hoặc làm hỏng dữ liệu trong `~/.claude` hay `~/.codex`. Hai thư mục này **chỉ được đọc**.

## 3. Ràng buộc

- Máy Windows 11. Đường dẫn, cách kill cây tiến trình và theo dõi file phải chạy đúng trên Windows.
- Claude Code CLI có ở `C:\Users\Admin\.local\bin\claude.exe`, hỗ trợ `-p`, `--output-format stream-json`, `--model`, `--effort`, `--permission-mode`, `--allowedTools`/`--disallowedTools`, `--mcp-config`, `--append-system-prompt`.
- **Codex CLI hiện không có trên PATH.** Có dữ liệu Codex trong `~/.codex` (có thể do app desktop tạo ra). Chạy agent bằng Codex chỉ hoạt động khi có `codex` CLI. Nếu thiếu, UI phải báo rõ và không cho chọn Codex.
- Server chỉ lắng nghe trên `127.0.0.1`.
- Giao diện dùng **Next.js** (người dùng chọn).

## 4. Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| **Ticket** | Một yêu cầu công việc: tiêu đề, mô tả, thư mục dự án, (tuỳ chọn) ghi đè model hoặc agent cho từng vai |
| **Run** | Một lần thực thi ticket, gồm Controller và các subagent của nó, đi qua nhiều vòng |
| **Agent** | Một tiến trình agent do dashboard khởi chạy (Controller, Dev-n, Designer, QC-n), *hoặc* một phiên ngoài ticket được phát hiện từ log |
| **Call** | Một tool call của agent (Read, Edit, Bash, …) hoặc một lượt gọi model. Có thời điểm bắt đầu, kết thúc, kết quả ok/lỗi, input |
| **Cảnh báo** | Kẹt / lặp / lỗi dồn dập gắn với một agent |

## 5. Luồng một ticket

Trạng thái ticket: `draft → planning → awaiting_approval → running → done | escalated | cancelled`.

1. **Tạo ticket** (web hoặc `acctv new`) → `planning`. Dashboard khởi chạy Controller.
2. **Controller lập kế hoạch**: đọc ticket và code trong thư mục dự án, ước lượng độ khó, rồi gọi `propose_plan`. Kế hoạch gồm các gói việc (mỗi gói ghi rõ những file được phép sửa), vai, số lượng, model/effort/loại agent của từng vai, và tiêu chí nghiệm thu. → `awaiting_approval`. Controller bị chặn tại đây.
3. **Người dùng duyệt** trên màn duyệt kế hoạch. Có thể sửa số Dev, model, effort, loại agent, hoặc gửi góp ý để Controller lập lại. Duyệt → `running`.
4. **Vòng làm việc**: Controller khởi chạy các Dev (song song khi tập file không giao nhau), rồi Designer (nếu có) và QC review. Còn lỗi thì giao lại cho Dev ở vòng sau. Giới hạn mặc định 3 vòng, hết vòng mà vẫn còn lỗi → `escalated` và báo người dùng.
5. Controller kết luận → `done`, kèm báo cáo cuối.
6. Ticket ở trạng thái `escalated` thì người dùng chọn **Tiếp tục kèm chỉ đạo** (thêm 1 vòng, chỉ đạo được đưa vào Controller) hoặc **Huỷ** (→ `cancelled`, worktree giữ nguyên để xem lại). *(Lựa chọn của tôi, theo cách `/office resume`.)*

**Model mặc định** *(do tôi chọn, chỉnh được trong Settings)*:

| Vai | Agent | Model | Effort |
|---|---|---|---|
| Controller | Claude | `claude-opus-5-5` | xhigh |
| Dev | Claude | `claude-sonnet-5-5` | high |
| Designer | Claude | `claude-sonnet-5-5` | high |
| QC | Claude | `claude-sonnet-5-5` | high |

Người dùng chốt: **mặc định mọi vai đều là Claude**, có thể đổi sang Codex theo từng ticket hoặc từng vai. Controller được đề xuất model/effort khác mặc định tuỳ độ khó, nhưng phải nằm trong danh sách model cho phép ở Settings.

## 6. Cách chạy agent (quyết định kiến trúc quan trọng nhất)

**Mỗi subagent là một tiến trình riêng** do server dashboard khởi chạy, *không* dùng cơ chế subagent nội bộ (Task/Agent tool) của Claude. Lý do: phải dừng được đúng một agent và đo được từng call của nó.

- Claude: `claude -p --output-format stream-json --verbose --model <m> --effort <e> --permission-mode <…> --allowedTools <…> --append-system-prompt <prompt vai> --mcp-config <…>`, chạy trong thư mục dự án. Server đọc stdout dạng stream-json theo thời gian thực.
- Codex: `codex exec --json` với model, effort và sandbox tương ứng. Cờ chính xác do người xây dựng kiểm tra lại khi có CLI.

**Controller cũng là một tiến trình Claude**, được dashboard cấp một MCP server riêng với các tool:

| Tool | Việc |
|---|---|
| `propose_plan(plan)` | Gửi kế hoạch, chặn đến khi người dùng duyệt, sửa hoặc góp ý. Trả về kế hoạch đã duyệt hoặc góp ý |
| `spawn_agent(role, task, files, model?, effort?, agent?)` | Khởi chạy một subagent, trả về `agentId` |
| `wait_agents(ids)` | Chờ các agent kết thúc. Trả về báo cáo của từng agent: hoàn thành / thất bại / **bị dừng** (kèm lý do: người dùng dừng, tự dừng vì lặp, …), tóm tắt log, các file đã đổi |
| `get_agent_log(id)` | Lấy log chi tiết khi Controller cần |
| `finish(report, status)` | Kết thúc ticket (`done` / `escalated`) |

**Phân quyền theo vai.** Người dùng chọn kiểu **"quyền rộng, có danh sách cấm"**. Agent chạy không có ai bấm duyệt, nên:
- **Dev** được sửa file trong worktree của ticket và chạy hầu hết các lệnh: build, test, lint, cài package *trong dự án*.
- **Dev bị cấm**: `git commit`, `git push` và mọi lệnh git làm đổi nhánh hoặc remote; xoá hay ghi ra ngoài worktree; lệnh hệ thống (cài phần mềm toàn máy, sửa registry hoặc biến môi trường hệ thống, tắt tiến trình không phải của mình). Danh sách cấm chỉnh được trong Settings.
- **Designer và QC** chỉ đọc file và chạy lệnh kiểm tra (test, lint, build, preview).
- **Controller** chỉ đọc code và dùng các tool MCP của dashboard. Nó không tự sửa code.
- Một lệnh bị cấm thì bị từ chối, agent nhận lỗi, còn UI ghi lại thành cảnh báo. Không dùng `bypassPermissions`.
- Với Claude, thực thi bằng `--permission-mode`, `--allowedTools`/`--disallowedTools` và một hook `PreToolUse` do dashboard cung cấp, dùng để kiểm lệnh Bash và đường dẫn file. Với Codex, dùng sandbox/approval tương đương.

**Phạm vi file của gói việc** *(lựa chọn của tôi)*: với Edit/Write, danh sách file được phép sửa **được ép thật** qua hook `PreToolUse`. Sửa ngoài phạm vi thì bị từ chối kèm lý do, agent nhận lỗi, UI hiện cảnh báo vàng "ngoài phạm vi". Agent cố vượt phạm vi ≥ 3 lần → tính như lặp và Controller được báo. Riêng file do lệnh Bash ghi ra thì không ép được, chỉ nhắc trong prompt.

**Nơi làm việc.** Người dùng chọn **mỗi ticket một git worktree và một nhánh riêng**:
- Khi kế hoạch được duyệt, dashboard tạo worktree từ nhánh hiện tại của dự án, đặt tên nhánh kiểu `acctv/T-12-trang-login`. Các Dev trong ticket dùng chung worktree đó và chia việc theo file như trên. **Code người dùng đang làm không bị đụng tới.**
- Cuối mỗi vòng, dashboard (không phải Dev) commit một snapshot vào nhánh của ticket để mỗi vòng xem lại được. Không bao giờ push. *(Lựa chọn của tôi.)*
- Khi `done`, UI hiện tên nhánh, đường dẫn worktree và tóm tắt diff. **Người dùng tự merge.** Có nút xoá worktree khi không cần nữa.
- Thư mục dự án không phải git repo: form tạo ticket báo rõ và đề nghị `git init` kèm commit đầu tiên (người dùng bấm xác nhận). Không có repo thì không chạy được ticket. *(Lựa chọn của tôi.)*
- "File đã đổi" của từng agent lấy từ log Edit/Write của chính agent đó, còn tổng thay đổi của vòng lấy từ `git diff`.
- Các Dev song song có thể đụng nhau khi chạy build/test cùng lúc trong một worktree. Prompt vai Dev nhắc chạy test theo phạm vi gói việc. Người xây dựng có thể thêm khoá đơn giản cho lệnh build/test nặng.

**Vòng đời Controller** *(lựa chọn của tôi)*: Controller **không** là một tiến trình sống suốt ticket. Mỗi lần nó cần chờ (`propose_plan` chờ duyệt, `wait_agents` chờ subagent), tool trả về ngay "đang chờ", Controller kết thúc lượt và tiến trình thoát. Khi có kết quả (người dùng duyệt hoặc góp ý, agent xong hoặc bị dừng), dashboard chạy lại Controller bằng `claude -p --resume <session>` và đưa kết quả vào. Nhờ vậy việc chờ duyệt qua đêm không tốn gì, không dính timeout MCP, và dashboard khởi động lại vẫn tiếp tục được: trạng thái nằm trong DB và session của Claude. Trên UI, Controller vẫn hiện như một agent liên tục, với các đoạn "chờ" màu xám.

**Dừng một agent**: kill toàn bộ cây tiến trình (Windows: `taskkill /T /F` hoặc tương đương), ghi lý do, chụp lại các file đã đổi, rồi trả kết quả vào `wait_agents` của Controller. Controller quyết định giao lại với chỉ dẫn khác, đổi model, chia nhỏ việc, hoặc báo người dùng.

**Dashboard khởi động lại khi đang có run**: các subagent đang chạy chết theo và được ghi là "bị gián đoạn". Lần resume tiếp theo, Controller nhận chúng như agent bị dừng và tự quyết bước tiếp. Ticket đang chờ duyệt thì không bị ảnh hưởng. *(Lựa chọn của tôi.)*

**Codex trong bản đầu** *(lựa chọn của tôi)*: theo dõi phiên Codex (chỉ đọc) nằm trong phạm vi. Phần chạy agent bằng Codex được viết sau cùng một interface runner với Claude, nhưng **chỉ bật khi tìm thấy `codex` CLI**. Không có CLI thì lựa chọn Codex bị khoá trên UI kèm lời giải thích. Phần này chưa kiểm thử được cho tới khi cài CLI, và tài liệu bàn giao phải ghi rõ điều đó.

**Tài khoản, giới hạn và chi phí** *(lựa chọn của tôi)*: agent dùng tài khoản mà `claude` CLI đang đăng nhập. Mặc định tối đa **3 subagent chạy song song** trên toàn hệ thống (chỉnh trong Settings), agent vượt số này phải xếp hàng. Lỗi rate limit hoặc hết quota là **trạng thái riêng ("bị giới hạn")**: không tính vào lỗi dồn dập, agent tự chờ rồi thử lại. UI hiện token và **chi phí ước tính** theo bảng giá model cấu hình trong Settings.

## 7. Thu thập dữ liệu

Có hai nguồn, cùng được chuẩn hoá về một mô hình sự kiện chung:

1. **Agent do dashboard chạy**: lấy từ stdout stream-json/JSON của tiến trình. Đây là nguồn chính, cập nhật theo thời gian thực.
2. **Phiên ngoài ticket**: theo dõi file, **chỉ đọc**:
   - Claude Code: `~/.claude/projects/<project>/*.jsonl` (transcript, mỗi dòng một record; có `type` = user/assistant/system/…, `timestamp`, `isSidechain`, `sessionId`). `~/.claude/sessions/<pid>.json` cho biết phiên nào đang sống (`pid`, `sessionId`, `cwd`, `status`, `updatedAt`).
   - Codex: `~/.codex/sessions/**/*.jsonl` và `~/.codex/state_5.sqlite` (bảng `threads`, …; mở ở chế độ read-only, chú ý file WAL).
   - Định dạng các file này không được công bố chính thức và có thể đổi giữa các phiên bản. Mỗi adapter phải chịu được record lạ: bỏ qua và ghi log, không được crash.

**Mô hình chuẩn hoá** *(tối thiểu)*: `Agent {id, source, role?, model, effort?, pid?, cwd, parentId?, status}`, `Call {agentId, kind: tool|llm, name, inputHash, inputPreview, startedAt, endedAt, ok, errorPreview, tokensIn?, tokensOut?}`.

**Số liệu hiển thị**: số call, số lỗi, tỉ lệ thành công, latency p50/p95 (theo tool và theo lượt gọi model), token vào/ra, thời gian chạy, theo agent / ticket / toàn hệ thống.

## 8. Phát hiện kẹt, lặp, lỗi

Ngưỡng mặc định, chỉnh được trong Settings:

| Cảnh báo | Quy tắc | Mức |
|---|---|---|
| **Kẹt** | Tiến trình còn sống nhưng không có sự kiện mới trong 120s, *và* không có tool nào đang chạy | vàng |
| **Tool chạy lâu** | Một tool call chạy quá 5 phút (khác với kẹt: agent đang chờ lệnh, không phải im lặng) | vàng |
| **Lặp** | Cùng tool + cùng input (sau chuẩn hoá) xuất hiện ≥ 3 lần trong 20 call gần nhất, hoặc chuỗi A→B→A→B lặp lại | vàng |
| **Lặp nặng** | ≥ 10 lần → **tự dừng** agent, trả về Controller với lý do "auto-stop: loop" | đỏ |
| **Lỗi dồn dập** | ≥ 5 call thất bại liên tiếp | đỏ |

Phiên ngoài ticket vẫn có cảnh báo nhưng không bao giờ bị tự dừng.

## 9. Giao diện

**Hướng hình ảnh**: nền tối (slate `#0F172A`, card `#1B2336`, viền `#334155`), chữ Fira Code cho số liệu và log, Fira Sans cho nhãn. Màu trạng thái: xanh lá thành công, đỏ thất bại, xanh dương đang chạy, vàng cảnh báo, xám chờ. Trạng thái luôn kèm biểu tượng hoặc chữ, không chỉ dùng màu. Không dùng glassmorphism hay hiệu ứng blur. Chuyển động tối thiểu và tôn trọng `prefers-reduced-motion`. Mật độ thông tin cao, kiểu dashboard. Mọi màn có cả chế độ sáng *(tôi đoán là cần, ưu tiên thấp)*.

**Màn chính (người dùng đã chốt: ghép phương án A + C)**. Mockup ở `.superpowers/brainstorm/711-1793610801/content/layout-v2.html`.
- **Thanh trên**: số agent đang chạy, số cảnh báo, số ticket chờ duyệt, tỉ lệ call ok (1h), p50 latency, nút "+ Ticket mới".
- **Cột trái**: danh sách ticket (chấm trạng thái + phase), bên dưới là "Phiên ngoài ticket".
- **Giữa**: cây Controller → subagent. **Mỗi dòng của cây kéo dài sang phải thành một làn thời gian**, mỗi tool call là một thanh màu theo kết quả. Đoạn Controller chờ subagent hiện màu xám, vùng nghi lặp tô sọc vàng, có vạch "bây giờ". Chọn được khung 1 / 5 / 15 / 60 phút. Bấm vào một thanh để xem chi tiết call đó.
- **Cột phải**: agent đang chọn hiện trực tiếp gói việc, file được sửa, danh sách call (giờ, tool, input rút gọn, ok/lỗi, thời gian), lỗi lặp nhiều nhất, số liệu (call, lỗi, p50, p95, token, thời gian) và nút **Dừng → trả Controller**.

**Các màn khác** (chưa có mockup, theo cùng hệ thống hình ảnh):
- **Tạo ticket**: tiêu đề, mô tả, thư mục dự án (chọn từ các thư mục đã dùng hoặc nhập đường dẫn; báo rõ khi thư mục không phải git repo), tuỳ chọn ghi đè model/agent theo vai.
- **Duyệt kế hoạch**: hiện kế hoạch của Controller (gói việc, file, vai, model/effort/agent, tiêu chí). Sửa được từng dòng, rồi Duyệt / Gửi góp ý / Huỷ.
- **Lịch sử / phát lại**: mở ticket hoặc phiên đã xong theo cùng bố cục A + C, có thanh kéo thời gian.
- **Settings**: model mặc định theo vai, danh sách model cho phép, ngưỡng cảnh báo, quyền theo vai, giới hạn số vòng, số agent chạy song song tối đa.

Phải đáp ứng: hiển thị thời điểm cập nhật cuối, có trạng thái "mất kết nối", danh sách call dài phải virtualize, điều khiển được bằng bàn phím, độ tương phản ≥ 4.5:1.

## 10. CLI

Một binary `acctv`, gọi vào server đang chạy:

| Lệnh | Việc |
|---|---|
| `acctv serve` | Bật server (UI + API + WebSocket + quản lý agent) |
| `acctv new "<tiêu đề>" --dir <path> [--desc …]` | Tạo ticket |
| `acctv ls` | Danh sách ticket, phiên ngoài ticket và cảnh báo |
| `acctv plan <T>` / `acctv approve <T>` / `acctv revise <T> "<góp ý>"` | Xem, duyệt, góp ý kế hoạch |
| `acctv watch <T>` | Hiện cây agent và log trực tiếp trong terminal |
| `acctv stop <T>/<agent>` | Dừng một agent và trả về Controller |
| `acctv logs <T>/<agent>` | Xem log của một agent |

## 11. Công nghệ *(do tôi chọn, trừ Next.js)*

- **Next.js (App Router) + TypeScript**, chạy bằng **custom server** để chung một tiến trình Node sống lâu với: trình quản lý tiến trình agent, watcher file, MCP server cho Controller, WebSocket đẩy sự kiện lên UI.
- **SQLite** của riêng ứng dụng (ví dụ `~/.acctv/acctv.db`) lưu ticket, run, agent, call, cảnh báo.
- Watcher file chạy được trên Windows. Làn thời gian vẽ bằng SVG, chuyển sang canvas khi dữ liệu lớn.
- CLI nằm chung package, gọi API/WebSocket của server.

## 12. Phần để người xây dựng tự quyết

Cấu trúc thư mục và module, thư viện cụ thể (watcher, SQLite driver, WebSocket, UI component), schema DB chi tiết, cách chuẩn hoá input để so lặp, cách lấy "file đã đổi" (git diff khi là repo, snapshot khi không phải), giao thức API giữa CLI và server, cách thiết kế prompt hệ thống cho từng vai (tham khảo `~/.claude/agents/office-*.md`), thời gian lưu dữ liệu.

## 13. Tài liệu tham chiếu

- Mockup bố cục: `.superpowers/brainstorm/711-1793610801/content/layout.html` (3 phương án) và `layout-v2.html` (bản chốt A + C).
- `/office`: `~/.claude/skills/office/SKILL.md`, `~/.claude/agents/office-{dev,designer,qc}.md`. Tham khảo cách chia vai, gói việc theo file và vòng review.

## 14. Các quyết định sau vòng review

**Người dùng quyết:** quyền rộng có danh sách cấm (§6), mỗi ticket một worktree và nhánh riêng, người dùng tự merge (§6).

**Lựa chọn của tôi, cần người dùng kiểm khi đọc:** phạm vi file được ép bằng hook với Edit/Write (§6), Controller chạy theo từng bước bằng `--resume` (§6), dashboard commit snapshot mỗi vòng vào nhánh ticket (§6), bắt buộc git repo (§6), Codex runner chỉ bật khi có CLI (§6), tối đa 3 agent song song và rate limit là trạng thái riêng (§6), ticket escalated được tiếp tục kèm chỉ đạo (§5), model mặc định theo vai (§5), ngưỡng cảnh báo (§8), công nghệ ngoài Next.js (§11).
