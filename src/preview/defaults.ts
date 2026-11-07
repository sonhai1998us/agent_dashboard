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

export const NEXT_DEFAULTS: ProjectPreview = {
  dev: { command: 'pnpm exec next dev -p {port}' },
  prod: { build: 'pnpm exec next build', start: 'pnpm exec next start -p {port}' },
  defaultMode: 'dev',
  env: {},
  readyPath: '/',
  accounts: [],
};
