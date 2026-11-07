import { NEXT_DEFAULTS, type ProjectPreview } from '@/src/preview/defaults';

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

export function toProjectForm(dir: string, p: ProjectPreview): ProjectForm {
  const s = p.login?.success;
  return {
    dir,
    dev: p.dev.command,
    build: p.prod.build,
    start: p.prod.start,
    defaultMode: p.defaultMode,
    env: Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\n'),
    readyPath: p.readyPath,
    healthUrl: p.backend?.healthUrl ?? '',
    loginPath: p.login?.path ?? '',
    usernameSelector: p.login?.usernameSelector ?? '',
    passwordSelector: p.login?.passwordSelector ?? '',
    submitSelector: p.login?.submitSelector ?? '',
    successKind: s && 'selector' in s ? 'selector' : 'url',
    successValue: s ? ('selector' in s ? s.selector : s.urlNotMatching) : '',
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
    project.login = {
      path: f.loginPath.trim(),
      usernameSelector: f.usernameSelector.trim(),
      passwordSelector: f.passwordSelector.trim(),
      submitSelector: f.submitSelector.trim(),
      success: f.successKind === 'selector' ? { selector: f.successValue.trim() } : { urlNotMatching: f.successValue.trim() },
    };
  }
  if (f.resetCommand.trim()) project.db = { resetCommand: f.resetCommand.trim(), cwd: f.resetCwd.trim() };
  return { ok: true, dir: f.dir.trim(), project };
}
