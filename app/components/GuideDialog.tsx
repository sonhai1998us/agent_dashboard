'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './UserActionDialog.module.css';

const HIDE_KEY = 'acctv.guide.hidden';
const CONFIG = `import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// tài khoản test, mỗi máy tự tạo, không commit
// ép kiểu vì @types/node cũ (<20.12) chưa có loadEnvFile
const proc = process as NodeJS.Process & { loadEnvFile?: (path: string) => void };
if (existsSync('.env.e2e')) {
  if (!proc.loadEnvFile) throw new Error(\`Đọc .env.e2e cần Node 20.12 trở lên (máy này: \${process.version})\`);
  proc.loadEnvFile('.env.e2e');
}

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: process.env.BASE_URL },
});`;
const IGNORE = `test-results/
playwright-report/
.env.e2e`;
const ENV = `E2E_OWNER_USER=email-tai-khoan-test@vidu.com
E2E_OWNER_PASS=mat-khau-tai-khoan-test`;
const isHidden = (): boolean => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };
const saveHidden = (v: boolean): void => {
  try { if (v) localStorage.setItem(HIDE_KEY, '1'); else localStorage.removeItem(HIDE_KEY); } catch { /* bộ nhớ trình duyệt bị chặn: lần sau vẫn hiện */ }
};

/** Hướng dẫn sử dụng: tự mở lần đầu (trừ khi đã chọn không hiển thị lại), nút trên header mở lại. */
export default function GuideDialog({ btnClass }: { btnClass?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [hide, setHide] = useState(false);

  const open = () => { setHide(isHidden()); ref.current?.showModal(); };
  const close = () => { saveHidden(hide); ref.current?.close(); };

  // đọc localStorage sau khi mount để HTML server và client khớp nhau
  useEffect(() => { if (!isHidden()) ref.current?.showModal(); }, []);

  return (
    <>
      <button type="button" className={btnClass ?? styles.btn} onClick={open}>Hướng dẫn</button>
      <dialog ref={ref} className={styles.dlg} aria-labelledby="guide-title" onCancel={(e) => { e.preventDefault(); close(); }}>
        <h2 id="guide-title" className={styles.title}>Hướng dẫn sử dụng</h2>
        <ol>
          <li><b>Theo dõi agent</b>: các phiên Claude Code / Codex trên máy tự hiện ở đây; agent bị kẹt hay chạy tool quá lâu sẽ có cảnh báo.</li>
          <li><b>Tạo ticket</b>: bấm <b>+ Ticket mới</b>, chọn thư mục dự án. Ghi mã Jira ở đầu tiêu đề, vd. <code>[UNI-123] Sửa trang login</code>: tên file test e2e lấy theo mã này nên không trùng với người khác trong team.</li>
          <li><b>Duyệt kế hoạch</b>: Controller đọc code rồi lập kế hoạch; bạn xem, sửa và duyệt. Các agent làm trên một nhánh và worktree riêng của ticket.</li>
          <li><b>▲ cần bạn</b>: agent đang chờ bạn trả lời hoặc làm một việc; bấm nút này trên header để mở.</li>
          <li><b>Cài đặt → Dự án</b>: lệnh bật server preview, cách đăng nhập test và tài khoản test. Đặt tên tài khoản <code>owner</code> giống nhau cả team để test e2e chạy được trên máy mọi người.</li>
          <li><b>Test e2e</b>: dự án có <code>playwright.config</code> thì mỗi ticket có thêm file test <code>e2e/&lt;mã&gt;.spec.ts</code>, merge cùng code. Cài đặt và cách chạy ở phần dưới.</li>
        </ol>

        <h3 className={styles.title}>Cài đặt test e2e (một lần cho mỗi dự án)</h3>
        <p>Làm trong thư mục gốc của dự án (vd. uniscore-client), commit và merge vào nhánh gốc của ticket: dashboard chỉ bật e2e khi worktree của ticket có <code>playwright.config</code>.</p>
        <ol>
          <li>Cài thư viện: <code>yarn add -D @playwright/test</code>. Mỗi máy cài trình duyệt một lần: <code>npx playwright install chromium</code>.</li>
          <li>Thêm file <code>playwright.config.ts</code>:
            <pre className={`mono ${styles.cmd}`}>{CONFIG}</pre>
          </li>
          <li>Thêm vào <code>scripts</code> của <code>package.json</code>: <code>&quot;e2e&quot;: &quot;playwright test&quot;</code></li>
          <li>Thêm vào <code>.gitignore</code>:
            <pre className={`mono ${styles.cmd}`}>{IGNORE}</pre>
          </li>
          <li>Thư mục <code>e2e/</code> chứa file test. Không cần tạo tay: Dev của mỗi ticket tạo <code>e2e/&lt;mã ticket&gt;.spec.ts</code>.</li>
        </ol>

        <h3 className={styles.title}>File .env.e2e (mỗi máy tự tạo, không commit)</h3>
        <p>Đặt ở thư mục gốc dự án, chứa tài khoản test <b>trên staging</b>:</p>
        <pre className={`mono ${styles.cmd}`}>{ENV}</pre>
        <p>Tên biến theo tên tài khoản trong Cài đặt: <code>owner</code> → <code>E2E_OWNER_USER</code> / <code>E2E_OWNER_PASS</code>; thêm tài khoản thì thêm một cặp. File này chỉ dùng khi bạn tự chạy; trong dashboard, tài khoản lấy từ Cài đặt.</p>

        <h3 className={styles.title}>Chạy test</h3>
        <ul>
          <li><b>Trong dashboard</b>: tự động. Dev chạy thử file test của ticket, QC review chạy lại trên server preview.</li>
          <li><b>Trước release</b>, ở thư mục gốc dự án, chạy toàn bộ trên staging: <code>BASE_URL=https://&lt;staging&gt; yarn e2e</code></li>
          <li>Chạy một file: <code>BASE_URL=https://&lt;staging&gt; yarn e2e e2e/UNI-123.spec.ts</code></li>
          <li>Thử trên máy mình: thay <code>BASE_URL</code> bằng địa chỉ server dev, vd. <code>http://localhost:4000</code>.</li>
          <li>Cần Node 20.12 trở lên (để đọc <code>.env.e2e</code>).</li>
        </ul>
        <div className={styles.actions}>
          <label>
            <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Không hiển thị lại
          </label>
          <span className={styles.spacer} />
          <button type="button" className={styles.btn} onClick={close} autoFocus>Đã hiểu</button>
        </div>
      </dialog>
    </>
  );
}
