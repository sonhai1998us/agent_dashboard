# Test tự động (e2e) sinh từ test case của ticket

## Mục đích
Trước mỗi release, người dùng chạy tay một lệnh trong dự án (vd. uniscore-client) để chạy lại toàn bộ test e2e tích lũy từ các ticket trước trên **staging**, bắt hồi quy mà không tốn token. Test được sinh dần theo từng ticket đi qua dashboard, không ai phải ngồi viết.

## Mục tiêu / không làm
- Có: Dev chuyển các TC (từ QC `mode: "cases"`) thành `e2e/<ticket>.spec.ts` (`@playwright/test`) cùng lúc với code; QC review chạy file đó trên server preview và nhận xét độ phủ TC; file merge cùng code ticket; release thì chạy với `BASE_URL` = staging.
- Không: chạy trên CI hay tự động sau mỗi ticket; chuyển 142 kịch bản capture cũ; dashboard tự chạy bộ e2e lúc release; QC có quyền ghi file.
- Hỏng nếu: test đỏ vì dữ liệu thật đổi chứ không phải code hỏng; chạy cần nhiều bước chuẩn bị; spec gắn vào cổng/URL của preview.

## Cách làm đã chọn (A)
Đã cân nhắc: (A) Dev viết spec cùng code từ danh sách TC, QC review chạy — chọn, vì không thêm agent và kỳ vọng vẫn độc lập (do QC cases viết trước khi có code); (B) thêm bước QC automation chỉ được ghi `e2e/**` sau khi review đạt — để dành nếu spec do Dev viết hay sai, vì tốn thêm agent và phải mở quyền ghi cho QC; tự sinh spec từ kịch bản capture — loại vì chỉ có thao tác, không có kỳ vọng.

## Thiết kế
- **Điều kiện bật:** chỉ khi worktree có `playwright.config.*` (dự án đã chuẩn bị e2e). Không có thì giữ luồng hiện tại, Controller không giao viết spec.
- **Chuẩn bị một lần ở dự án (ngoài dashboard, có thể làm bằng một ticket):** `@playwright/test` trong devDependencies; `playwright.config.ts` với `testDir: 'e2e'`, `use.baseURL = process.env.BASE_URL`, trình duyệt chromium; script `e2e` trong package.json; tài khoản test qua biến môi trường `E2E_<NAME>_USER` / `E2E_<NAME>_PASS` (không commit); thư mục kết quả trong `.gitignore`.
- **Controller:** khi bật e2e, thêm `e2e/<mã ticket>.spec.ts` vào file của gói Dev (mã Jira nếu ticket có, không thì `T-n`) và ghi trong task: chuyển từng TC thành một `test()`.
- **Dev (prompt):** mỗi TC một `test('TC-n: …')` trong `test.describe('<mã ticket>')`; dùng đường dẫn tương đối (`page.goto('/en/…')`), không ghi cổng hay host; selector ưu tiên `data-testid`, role, text ổn định; assertion theo **quy luật** (thứ tự giảm dần, định dạng `dd/MM`, có logo, tab ẩn khi rỗng, chữ đã dịch) thay vì giá trị dữ liệu thật hay đổi (tên, số, ngày cụ thể); id/slug dữ liệu mẫu chọn cái ổn định và ghi chú lý do; cần đăng nhập thì đọc tài khoản từ biến môi trường. Chạy thử bằng `run_e2e` trước khi báo xong.
- **Tool mới `run_e2e({ file, grep? })`** cho Dev và QC (claude, khi có server preview): dashboard bảo đảm server preview chạy (như capture), chạy `npx playwright test <file> --reporter=line` trong worktree với `BASE_URL` = server preview, trả về số đạt/lỗi, tên test lỗi và phần cuối log (giới hạn độ dài); timeout như capture. Không cho file ngoài `e2e/`.
- **QC review (prompt):** chạy `run_e2e` cho file spec của ticket; báo từng TC có `test()` tương ứng chưa, test nào đỏ, assertion nào bám giá trị dữ liệu dễ đổi (lỗi mức vừa). Vẫn kiểm độc lập bằng capture như hiện nay.
- **Release (người dùng):** `BASE_URL=https://<staging> yarn e2e` (hoặc `npx playwright test`) trong dự án; xem báo cáo HTML của Playwright khi có lỗi.

## Để người làm tự quyết
Tên hàm/biến, cách phát hiện `playwright.config.*`, giới hạn độ dài kết quả `run_e2e`, câu chữ prompt (tiếng Việt), test (tool chỉ nhận file trong `e2e/`, đặt đúng `BASE_URL`, không có tool khi không có preview/codex, prompt Controller/Dev/QC khi bật và khi tắt e2e).
