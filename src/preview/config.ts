import fs from 'node:fs';
import path from 'node:path';

import { MASK, NEXT_DEFAULTS, nextDefaults, type PreviewAccount, type PreviewLogin, type ProjectPreview } from './defaults';

export { MASK, NEXT_DEFAULTS, type PreviewAccount, type PreviewLogin, type ProjectPreview };

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isAbs = (v: unknown): v is string => str(v) && path.isAbsolute(v.trim());

function one(raw: unknown, key: string, errors: string[]): ProjectPreview | null {
  const e = (m: string) => errors.push(`projects[${key}].${m}`);
  if (!isObj(raw)) {
    e('phải là object');
    return null;
  }
  const n = errors.length;
  const dev = isObj(raw.dev) ? raw.dev : {};
  const prod = isObj(raw.prod) ? raw.prod : {};
  if (!str(dev.command) || !dev.command.includes('{port}')) e('dev.command phải là lệnh có {port}');
  if (!str(prod.build)) e('prod.build không được rỗng');
  if (!str(prod.start) || !prod.start.includes('{port}')) e('prod.start phải là lệnh có {port}');
  if (raw.defaultMode !== 'dev' && raw.defaultMode !== 'prod') e('defaultMode phải là dev hoặc prod');
  const env = raw.env === undefined ? {} : raw.env;
  if (!isObj(env) || !Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')) e('env phải ánh xạ tên biến sang chuỗi');
  const readyPath = raw.readyPath === undefined ? '/' : raw.readyPath;
  if (typeof readyPath !== 'string' || !readyPath.startsWith('/')) e('readyPath phải bắt đầu bằng /');
  let backend: ProjectPreview['backend'];
  if (raw.backend !== undefined) {
    const b = isObj(raw.backend) ? raw.backend : {};
    if (!str(b.healthUrl) || !/^https?:\/\//.test(b.healthUrl)) e('backend.healthUrl phải là URL http(s)');
    else backend = { healthUrl: b.healthUrl.trim() };
  }
  let login: PreviewLogin | undefined;
  if (raw.login !== undefined) {
    const l = isObj(raw.login) ? raw.login : {};
    if (!str(l.path) || !l.path.startsWith('/')) e('login.path phải bắt đầu bằng /');
    for (const k of ['usernameSelector', 'passwordSelector', 'submitSelector'] as const) if (!str(l[k])) e(`login.${k} không được rỗng`);
    const s = isObj(l.success) ? l.success : {};
    const success = str(s.urlNotMatching) ? { urlNotMatching: s.urlNotMatching } : str(s.selector) ? { selector: s.selector } : null;
    if (!success) e('login.success phải có urlNotMatching hoặc selector');
    if (errors.length === n) {
      login = { path: l.path as string, usernameSelector: l.usernameSelector as string, passwordSelector: l.passwordSelector as string, submitSelector: l.submitSelector as string, success: success! };
    }
  }
  const accounts: PreviewAccount[] = [];
  const rawAccounts = raw.accounts === undefined ? [] : raw.accounts;
  if (!Array.isArray(rawAccounts)) e('accounts phải là mảng');
  else {
    const seen = new Set<string>();
    rawAccounts.forEach((a, i) => {
      if (!isObj(a) || typeof a.name !== 'string' || !ACCOUNT_NAME.test(a.name)) return e(`accounts[${i}].name phải khớp ${ACCOUNT_NAME.source}`);
      if (seen.has(a.name)) return e(`accounts: tên "${a.name}" bị trùng`);
      seen.add(a.name);
      if (!str(a.username)) e(`accounts.${a.name}.username không được rỗng`);
      if (typeof a.password !== 'string' || !a.password) e(`accounts.${a.name}.password không được rỗng`);
      accounts.push({ name: a.name, description: typeof a.description === 'string' ? a.description : '', username: String(a.username ?? ''), password: String(a.password ?? '') });
    });
  }
  let db: ProjectPreview['db'];
  if (raw.db !== undefined) {
    const d = isObj(raw.db) ? raw.db : {};
    if (!str(d.resetCommand)) e('db.resetCommand không được rỗng');
    if (!isAbs(d.cwd)) e('db.cwd phải là đường dẫn tuyệt đối');
    if (str(d.resetCommand) && isAbs(d.cwd)) db = { resetCommand: d.resetCommand, cwd: d.cwd.trim() };
  }
  if (errors.length !== n) return null;
  return {
    dev: { command: dev.command as string },
    prod: { build: prod.build as string, start: prod.start as string },
    defaultMode: raw.defaultMode as 'dev' | 'prod',
    env: { ...(env as Record<string, string>) },
    readyPath: readyPath as string,
    ...(backend ? { backend } : {}),
    ...(login ? { login } : {}),
    accounts,
    ...(db ? { db } : {}),
  };
}

export function validateProjects(raw: unknown): { ok: true; projects: Record<string, ProjectPreview> } | { ok: false; errors: string[] } {
  if (raw === undefined) return { ok: true, projects: {} };
  if (!isObj(raw)) return { ok: false, errors: ['projects phải là object theo thư mục dự án'] };
  const errors: string[] = [];
  const projects: Record<string, ProjectPreview> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isAbs(k)) {
      errors.push(`projects: khoá "${k}" phải là đường dẫn tuyệt đối`);
      continue;
    }
    const p = one(v, k, errors);
    if (p) projects[path.resolve(k)] = p;
  }
  return errors.length ? { ok: false, errors } : { ok: true, projects };
}

/** Lúc nạp config.json: giữ từng dự án hợp lệ, bỏ dự án hỏng (để lần lưu sau từ UI không xoá mất tài khoản test). */
export function salvageProjects(raw: unknown): { projects: Record<string, ProjectPreview>; errors: string[] } {
  if (!isObj(raw)) return { projects: {}, errors: raw === undefined ? [] : ['projects phải là object theo thư mục dự án'] };
  const projects: Record<string, ProjectPreview> = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const r = validateProjects({ [k]: v });
    if (r.ok) Object.assign(projects, r.projects);
    else errors.push(...r.errors);
  }
  return { projects, errors };
}

export function maskProjects(p: Record<string, ProjectPreview>): Record<string, ProjectPreview> {
  const out = structuredClone(p);
  for (const v of Object.values(out)) for (const a of v.accounts) a.password = MASK;
  return out;
}

const keyOf = (dir: string): string => {
  const r = path.resolve(dir);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function lookup(projects: Record<string, ProjectPreview>, dir: string): ProjectPreview | undefined {
  const k = keyOf(dir);
  for (const [d, p] of Object.entries(projects)) if (keyOf(d) === k) return p;
  return undefined;
}

export function unmaskProjects(
  next: Record<string, ProjectPreview>,
  prev: Record<string, ProjectPreview>,
): { ok: true; projects: Record<string, ProjectPreview> } | { ok: false; errors: string[] } {
  const out = structuredClone(next);
  const errors: string[] = [];
  for (const [dir, p] of Object.entries(out)) {
    const old = lookup(prev, dir);
    for (const a of p.accounts) {
      if (a.password !== MASK) continue;
      const was = old?.accounts.find((x) => x.name === a.name);
      if (was) a.password = was.password;
      else errors.push(`projects[${dir}].accounts.${a.name}.password: nhập mật khẩu cho tài khoản mới`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, projects: out };
}

const RUNNERS: Record<string, string> = { pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx', npm: 'npx' };

/** Tiền tố chạy bin cục bộ theo trình quản lý gói của dự án: trường packageManager, rồi lockfile, mặc định npx. */
export function binRunner(dir: string, packageManager?: unknown): string {
  const declared = typeof packageManager === 'string' ? packageManager.split('@')[0] : '';
  if (RUNNERS[declared]) return RUNNERS[declared];
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return RUNNERS.pnpm;
  if (has('yarn.lock')) return RUNNERS.yarn;
  if (has('bun.lock') || has('bun.lockb')) return RUNNERS.bun;
  return RUNNERS.npm;
}

export function resolveProject(projects: Record<string, ProjectPreview>, dir: string): ProjectPreview | null {
  const hit = lookup(projects, dir);
  if (hit) return hit;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    if (pkg.dependencies?.next || pkg.devDependencies?.next) return nextDefaults(binRunner(dir, pkg.packageManager));
  } catch {
    // không có hoặc hỏng package.json
  }
  return null;
}
