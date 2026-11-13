# QC viết test case trước khi Dev làm

## Mục đích
Giảm số vòng Dev ↔ review (mỗi vòng ~$0.6–1, 5–10 phút). Ba vòng thêm gần đây (T-4 v2: chữ glossary lệch Design; T-6 v2: thiếu key dịch theo AC04; T-6 v3: lỗi UI Designer bắt) đều là lỗi mà test case viết sẵn từ tiêu chí nghiệm thu, hoặc spec Figma tới được Dev, có thể chặn từ vòng đầu.

## Mục tiêu / không làm
- Có: QC chế độ "viết test case" chạy song song với Explorer sau khi duyệt; Dev nhận test case qua `contextFrom`; QC review sau Dev chạy đủ các test case đó. Ticket có Figma bắt buộc có Explorer.
- Không: người dùng duyệt / sửa test case lúc duyệt plan (người dùng chọn Không — xem trong báo cáo agent nếu muốn); model riêng (Haiku) cho chế độ này; chặn cứng thứ tự trong code.
- Hỏng nếu: test case bám theo code thay vì tiêu chí nghiệm thu; QC review bỏ qua test case; Dev bị chặn chờ lâu hơn hiện nay.

## Cách làm đã chọn (A)
Đã cân nhắc: (A) chế độ `mode: "cases"` cho QC — chọn, vì test case độc lập với code và có cả khi plan không có Explorer; (B) Explorer viết luôn test case — loại vì không có Explorer thì không có test case, và Explorer đọc code trước nên test case dễ bám theo code (kiểu lỗi T-4 v2); chỉ sửa prompt Controller dùng QC thường — loại vì mâu thuẫn prompt review, phải chờ cài dependency, có tool capture thừa.

## Thiết kế
- **spawn_agent:** thêm `mode?: "cases"`, chỉ hợp lệ với `role: "qc"` (vai khác → lỗi). Lưu vào `ManagedAgent.mode: 'cases' | null` (cột `mode`, migrate `ALTER TABLE` như `user_action`) để prompt/tool đúng khi resume và sau khi dashboard khởi động lại.
- **Prompt chế độ cases:** chỉ đọc plan, tiêu chí nghiệm thu và task; không đọc code để thiết kế test case (được đọc để biết route/URL, dữ liệu mẫu). Báo cáo: danh sách test case đánh số `TC-1…`, mỗi cái có tiêu chí nghiệm thu liên quan, bước (URL, viewport, ngôn ngữ, dữ liệu), kết quả mong đợi cụ thể (chữ, số, thứ tự). Không có kết luận đạt/không đạt.
- **Tool & chờ:** chế độ cases không có tool capture và không chờ cài dependency (như Explorer). Vẫn chỉ đọc.
- **Giới hạn:** dùng model/effort của vai qc trong plan; tính vào giới hạn số qc chạy cùng lúc (đã xong thì giao QC review được); không tính là vòng Dev.
- **Prompt Controller (bước 3–4):** sau duyệt, giao song song Explorer (nếu có) và QC `mode: "cases"`; giao Dev kèm `contextFrom: [explorer, qc-cases]`. Khi Dev xong, giao QC review kèm `contextFrom: [qc-cases]`; task yêu cầu chạy từng TC và báo đạt/không đạt theo id, rồi mới kiểm thêm. Vòng sau giao lại Dev kèm báo cáo review như hiện nay. Plan không có vai qc thì bỏ bước này.
- **Prompt Controller (bước 1):** ticket có link/thiết kế Figma thì explorer count ≥ 1 (bắt buộc, không chỉ khuyến nghị).
- **Prompt Dev:** khi có test case trong context, tự đối chiếu từng TC trước khi báo xong và ghi TC nào đã tự kiểm.
- **Hiển thị:** nhãn agent `QC-n · test case` cho chế độ cases.

## Để người làm tự quyết
Tên hàm/biến, câu chữ prompt (giữ tiếng Việt như prompt hiện có), vị trí kiểm tra `mode` (server bắt buộc), test (spawn sai vai, không chờ dependency, tool không có capture, prompt chứa test case cho Dev/QC review, migrate cột).
