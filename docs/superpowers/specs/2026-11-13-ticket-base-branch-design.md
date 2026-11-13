# Nhánh gốc cho từng ticket

## Mục đích
Chạy nhiều ticket song song, mỗi ticket trên một nhánh khác nhau (vd. T-6 trên `feature/US-5369`, T-7 trên `feature/US-7001` chưa có), mà không phải checkout qua lại trong repo gốc. Hiện worktree luôn tách từ HEAD của repo gốc lúc duyệt plan.

## Mục tiêu / không làm
- Có: chọn nhánh local có sẵn, hoặc gõ tên nhánh mới và chọn nhánh để tạo từ đó; merge mặc định về nhánh gốc.
- Không (vòng này): nhánh remote / `git fetch`; agent làm thẳng trên nhánh feature.
- Hỏng nếu: ticket cũ (không có nhánh gốc) đổi hành vi; tạo nhánh khi ticket chưa được duyệt rồi bị huỷ.

## Cách làm đã chọn (A)
Đã cân nhắc: (A) ô nhánh gốc chọn-hoặc-gõ, tự tạo nhánh mới; (B) agent làm thẳng trên nhánh feature — loại vì git cấm một nhánh checkout ở hai worktree và snapshot commit lọt vào lịch sử feature; (C) chỉ chọn nhánh có sẵn — loại vì vẫn phải tự tạo nhánh mới. Người dùng chọn A.

## Thiết kế
- **Dữ liệu:** `Ticket` thêm `baseBranch: string | null` và `baseFrom: string | null` (nhánh để tạo `baseBranch` khi nó chưa có). Cột mới trong `tickets`, migrate kiểu `ALTER TABLE` như các cột trước. Ticket cũ: cả hai null → giữ hành vi HEAD.
- **API:** `GET /api/fs/check` trả thêm `branches` (dùng `listBranches`) để form có danh sách. `POST /api/tickets` nhận `baseBranch?`, `baseFrom?`; kiểm tra tên bằng `git check-ref-format --branch`, `baseFrom` bắt buộc và phải là nhánh có sẵn khi `baseBranch` chưa có.
- **Duyệt plan:** nếu `baseBranch` chưa có thì `git branch <baseBranch> <baseFrom>` (không checkout), rồi `git worktree add -b acctv/T-n <wt> <baseBranch>`; `baseRef` = `rev-parse <baseBranch>`. Nhánh đã có lúc duyệt (do ai đó tạo sau) thì dùng luôn, bỏ qua `baseFrom`.
- **Merge:** `defaultTarget` = `baseBranch` nếu còn trong danh sách nhánh, ngược lại giữ logic hiện tại.
- **Form tạo ticket:** ô "Nhánh gốc" (input + datalist nhánh local), mặc định nhánh hiện tại. Gõ tên không có trong danh sách → hiện "▲ Nhánh mới, sẽ tạo từ [select]", mặc định `dev-main` nếu có, không thì nhánh hiện tại. Cảnh báo "có thay đổi chưa commit" chỉ hiện khi nhánh gốc là nhánh hiện tại.
- **Hiển thị:** TicketHeader hiện nhánh gốc cạnh nhánh ticket.

## Để người làm tự quyết
Tên prop/hàm, vị trí kiểm tra tên nhánh (server là bắt buộc), văn bản lỗi, test (git: tạo worktree từ nhánh có sẵn / nhánh mới / tên sai; orchestrator: defaultTarget).
