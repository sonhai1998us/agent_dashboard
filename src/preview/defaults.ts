// Kiểu và giá trị mặc định của cấu hình dự án, không import module Node (UI dùng được).

export interface PreviewLogin {
  path: string;
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
