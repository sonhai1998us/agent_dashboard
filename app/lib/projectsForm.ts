import { NEXT_DEFAULTS, UNISCORE_LOGIN, isUniscore, type PreviewLogin, type ProjectPreview } from '@/src/preview/defaults';

export interface AccountForm { name: string; description: string; username: string; password: string }
export interface ProjectForm {
  dir: string;
  dev: string;
  build: string;
  start: string;
  defaultMode: 'dev' | 'prod';
  /** mỗi dòng KEY=VALUE */
  env: string;
  readyPath: string;
  healthUrl: string;
  loginPath: string;
  /** mỗi dòng một selector, bấm lần lượt trước khi điền */
  loginOpen: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successKind: 'url' | 'selector';
  successValue: string;
  accounts: AccountForm[];
  resetCommand: string;
  resetCwd: string;
}

export function emptyProjectForm(): ProjectForm {
  return toProjectForm('', structuredClone(NEXT_DEFAULTS));
}

const loginFields = (l: PreviewLogin | undefined) => {
  const s = l?.success;
  return {
    loginPath: l?.path ?? '',
    loginOpen: (l?.openSelectors ?? []).join('\n'),
    usernameSelector: l?.usernameSelector ?? '',
    passwordSelector: l?.passwordSelector ?? '',
    submitSelector: l?.submitSelector ?? '',
    successKind: s && 'selector' in s ? 'selector' as const : 'url' as const,
    successValue: s ? ('selector' in s ? s.selector : s.urlNotMatching) : '',
  };
};

/** Đổi thư mục dự án: uniscore-client chưa điền đăng nhập thì điền sẵn mặc định của nó. */
export function withDir(f: ProjectForm, dir: string): ProjectForm {
  return !f.loginPath.trim() && isUniscore(dir) ? { ...f, dir, ...loginFields(UNISCORE_LOGIN) } : { ...f, dir };
}

export function toProjectForm(dir: string, p: ProjectPreview): ProjectForm {
  return {
    dir,
    dev: p.dev.command,
    build: p.prod.build,
    start: p.prod.start,
    defaultMode: p.defaultMode,
    env: Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\n'),
    readyPath: p.readyPath,
    healthUrl: p.backend?.healthUrl ?? '',
    ...loginFields(p.login ?? (isUniscore(dir) ? UNISCORE_LOGIN : undefined)),
    accounts: p.accounts.map((a) => ({ ...a })),
    resetCommand: p.db?.resetCommand ?? '',
    resetCwd: p.db?.cwd ?? '',
  };
}

export function parseEnvLines(text: string): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const k = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!k) return { ok: false, error: `env: dòng ${i + 1} phải dạng KEY=VALUE` };
    env[k] = line.slice(eq + 1).trim();
  }
  return { ok: true, env };
}

/** Form → cấu hình gửi lên API. Kiểm chi tiết (đường dẫn tuyệt đối, {port}…) do server làm. */
export function fromProjectForm(f: ProjectForm): { ok: true; dir: string; project: ProjectPreview } | { ok: false; error: string } {
  const env = parseEnvLines(f.env);
  if (!env.ok) return env;
  const project: ProjectPreview = {
    dev: { command: f.dev.trim() },
    prod: { build: f.build.trim(), start: f.start.trim() },
    defaultMode: f.defaultMode,
    env: env.env,
    readyPath: f.readyPath.trim() || '/',
    accounts: f.accounts.map((a) => ({ name: a.name.trim(), description: a.description.trim(), username: a.username.trim(), password: a.password })),
  };
  if (f.healthUrl.trim()) project.backend = { healthUrl: f.healthUrl.trim() };
  if (f.loginPath.trim()) {
    const open = f.loginOpen.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    project.login = {
      path: f.loginPath.trim(),
      ...(open.length ? { openSelectors: open } : {}),
      usernameSelector: f.usernameSelector.trim(),
      passwordSelector: f.passwordSelector.trim(),
      submitSelector: f.submitSelector.trim(),
      success: f.successKind === 'selector' ? { selector: f.successValue.trim() } : { urlNotMatching: f.successValue.trim() },
    };
  }
  if (f.resetCommand.trim()) project.db = { resetCommand: f.resetCommand.trim(), cwd: f.resetCwd.trim() };
  return { ok: true, dir: f.dir.trim(), project };
}
