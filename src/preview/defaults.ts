// Kiểu và giá trị mặc định của cấu hình dự án, không import module Node (UI dùng được).

export interface PreviewLogin {
  path: string;
  /** bấm lần lượt trước khi điền, khi form nằm trong modal/menu (vd. icon user → Sign in → Sign in with email) */
  openSelectors?: string[];
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** dấu hiệu đăng nhập xong: URL không còn khớp (chuỗi con), hoặc một phần tử xuất hiện */
  success: { urlNotMatching: string } | { selector: string };
}
export interface PreviewAccount { name: string; description: string; username: string; password: string }
export interface ProjectPreview {
  /** `{port}` được thay bằng cổng dashboard cấp. */
  dev: { command: string };
  prod: { build: string; start: string };
  defaultMode: 'dev' | 'prod';
  env: Record<string, string>;
  readyPath: string;
  backend?: { healthUrl: string };
  login?: PreviewLogin;
  accounts: PreviewAccount[];
  /** chỉ chạy khi người dùng bấm nút */
  db?: { resetCommand: string; cwd: string };
}

export const MASK = '••••';

/** Cấu hình mặc định cho dự án Next.js; `run`: tiền tố chạy bin cục bộ (`pnpm exec`, `yarn`, `bunx`, `npx`). */
export const nextDefaults = (run: string): ProjectPreview => ({
  dev: { command: `${run} next dev -p {port}` },
  prod: { build: `${run} next build`, start: `${run} next start -p {port}` },
  defaultMode: 'dev',
  env: {},
  readyPath: '/',
  accounts: [],
});

export const NEXT_DEFAULTS: ProjectPreview = nextDefaults('pnpm exec');

/** Đăng nhập email của uniscore-client: icon user → Sign In → Sign in with email (đã bấm thử trên localhost 2026-11-16). */
export const UNISCORE_LOGIN: PreviewLogin = {
  path: '/en',
  openSelectors: [
    'header button[data-slot=popover-trigger]',
    '[data-slot=popover-content] button:has-text("Sign In")',
    '[data-slot=dialog-content] [role=button]:has-text("Sign in with email")',
  ],
  usernameSelector: '[data-slot=dialog-content] input[type=email]',
  passwordSelector: '[data-slot=dialog-content] input[type=password]',
  submitSelector: '[data-slot=dialog-content] button:text-is("Sign in")',
  // drawer menu luôn có trong DOM; đăng nhập rồi thì có ảnh đại diện, hoặc ảnh mặc định unknown1 khi tài khoản chưa có ảnh
  success: { selector: '[aria-labelledby=drawer-menu-title] img[alt="User Avatar"], [aria-labelledby=drawer-menu-title] img[alt="unknown1"]' },
};
// shortcut: nhận theo tên thư mục clone mặc định của repo; clone vào thư mục tên khác thì điền tay trong Settings
export const isUniscore = (dir: string): boolean => /(^|[\\/])uniscore-client[\\/]*$/i.test(dir.trim());
