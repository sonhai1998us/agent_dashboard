# Agent CCTV

Dashboard cục bộ để theo dõi các agent Claude Code và Codex đang chạy trên máy: trạng thái, timeline call, subagent nằm dưới phiên cha, cảnh báo (kẹt, tool chạy lâu, lặp lệnh, lỗi liên tiếp). Nguồn dữ liệu là log trong `~/.claude` và `~/.codex`.

## Yêu cầu

- Node.js >= 22.13 (dùng `node:sqlite`)
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

## An toàn dữ liệu

- Chỉ đọc `~/.claude` và `~/.codex`, không bao giờ ghi vào đó. Dữ liệu của app nằm trong `ACCTV_HOME`.
- Server chỉ bind `127.0.0.1`.
- Khi `INGEST_VERSION` (`src/core/version.ts`) đổi, database của app được xoá và nạp lại từ log khi khởi động.

## Giới hạn đã biết

- Định dạng log của Claude Code và Codex không chính thức, có thể đổi bất cứ lúc nào và làm parser sai hoặc thiếu dữ liệu.
- Codex chỉ theo dõi (watch-only), chưa chạy được agent từ dashboard.
- Chưa có ticket hay Controller (Phần 2).
- Phát hiện subagent kết thúc dựa vào `SubagentHandback` / `end_turn`.
- Lần tải đầu tiên của Next dev có thể cần tải lại trang.
