import path from 'node:path';

/** CSS selector, hoặc 'text=…', 'role=button[name="Lưu"]', 'testid=…'. */
export type Target = string;
export type Step =
  | { goto: string }
  | { click: Target }
  | { fill: Target; value: string }
  | { select: Target; value: string }
  | { check: Target; checked?: boolean }
  | { press: string; target?: Target }
  | { upload: Target; file: string }
  | { waitFor: Target | { url: string } }
  | { shot: string; fullPage?: boolean; target?: Target }
  | { measure: Target[] };

export interface CaptureArgs {
  as: string | null;
  viewport: { width: number; height: number };
  colorScheme: 'light' | 'dark';
  locale: string | null;
  cookies: { name: string; value: string }[];
  steps: Step[];
}

export const LIMITS = {
  steps: 30, shots: 6, stepMs: 10000, totalMs: 120000, fullPageMax: 8000, measurePerTarget: 20,
  consoleLines: 30, consoleChars: 300, overflowItems: 10, minWidth: 320, maxWidth: 1920,
} as const;

export interface StepReport { i: number; kind: string; ok: boolean; ms: number; error?: string }
export interface CaptureResult {
  server: { mode: 'dev' | 'prod'; port: number; startedNow: boolean; buildMs: number | null; envFiles: string[] };
  steps: StepReport[];
  finalUrl: string | null;
  status: number | null;
  redirects: string[];
  console: string[];
  requests: { method: string; url: string; status: number | null }[];
  overflow: { scrollWidth: number; clientWidth: number; items: { selector: string; width: number; right: number }[] } | null;
  measures: { target: string; items: { rect: { x: number; y: number; width: number; height: number }; style: Record<string, string> }[] }[];
  shots: string[];
}
export type CaptureErrorCode = 'invalid_args' | 'not_configured' | 'backend_down' | 'login_failed' | 'server_failed' | 'busy_cancelled';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const target = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 500;
const SHOT = /^[\w-]{1,40}$/;
const KINDS = ['goto', 'click', 'fill', 'select', 'check', 'press', 'upload', 'waitFor', 'shot', 'measure'] as const;

/** Đường dẫn tương đối trên origin preview: bắt đầu bằng một `/`, không phải `//` hay `/\`. */
const relPath = (v: unknown): v is string => typeof v === 'string' && /^\/(?![/\\])/.test(v) && !/[\s\\]/.test(v.split(/[?#]/)[0]) && v.length <= 2000;

function inside(root: string, p: string): boolean {
  const abs = path.resolve(root, p);
  const r = path.relative(path.resolve(root), abs);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

function step(raw: unknown, i: number, worktree: string): Step | string {
  const at = `bước ${i}`;
  if (!isObj(raw)) return `${at}: phải là object`;
  const keys = Object.keys(raw);
  const kind = KINDS.find((k) => k in raw);
  if (!kind) return `${at}: loại bước không hợp lệ (${keys.join(', ') || 'rỗng'}); dùng ${KINDS.join(', ')}`;
  const allowed: Record<(typeof KINDS)[number], string[]> = {
    goto: ['goto'], click: ['click'], fill: ['fill', 'value'], select: ['select', 'value'], check: ['check', 'checked'],
    press: ['press', 'target'], upload: ['upload', 'file'], waitFor: ['waitFor'], shot: ['shot', 'fullPage', 'target'], measure: ['measure'],
  };
  const extra = keys.filter((k) => !allowed[kind].includes(k));
  if (extra.length) return `${at}: trường lạ ${extra.join(', ')} cho bước ${kind}`;
  switch (kind) {
    case 'goto':
      return relPath(raw.goto) ? { goto: raw.goto } : `${at}: goto phải là đường dẫn tương đối bắt đầu bằng / trên server preview`;
    case 'click':
      return target(raw.click) ? { click: raw.click } : `${at}: click cần target`;
    case 'fill':
    case 'select':
      if (!target(raw[kind])) return `${at}: ${kind} cần target`;
      if (typeof raw.value !== 'string' || raw.value.length > 5000) return `${at}: ${kind}.value phải là chuỗi`;
      return kind === 'fill' ? { fill: raw.fill as string, value: raw.value } : { select: raw.select as string, value: raw.value };
    case 'check':
      if (!target(raw.check)) return `${at}: check cần target`;
      if (raw.checked !== undefined && typeof raw.checked !== 'boolean') return `${at}: checked phải là boolean`;
      return { check: raw.check, ...(raw.checked !== undefined ? { checked: raw.checked } : {}) };
    case 'press':
      if (typeof raw.press !== 'string' || !/^[\w+-]{1,40}$/.test(raw.press)) return `${at}: press phải là tên phím (vd. Enter)`;
      if (raw.target !== undefined && !target(raw.target)) return `${at}: press.target không hợp lệ`;
      return { press: raw.press, ...(raw.target !== undefined ? { target: raw.target as string } : {}) };
    case 'upload':
      if (!target(raw.upload)) return `${at}: upload cần target`;
      if (typeof raw.file !== 'string' || !inside(worktree, raw.file)) return `${at}: upload.file phải là file trong worktree`;
      return { upload: raw.upload, file: raw.file };
    case 'waitFor':
      if (target(raw.waitFor)) return { waitFor: raw.waitFor };
      if (isObj(raw.waitFor) && typeof raw.waitFor.url === 'string' && raw.waitFor.url) return { waitFor: { url: raw.waitFor.url } };
      return `${at}: waitFor cần target hoặc { url }`;
    case 'shot':
      if (typeof raw.shot !== 'string' || !SHOT.test(raw.shot)) return `${at}: shot phải là tên ảnh khớp ${SHOT.source}`;
      if (raw.fullPage !== undefined && typeof raw.fullPage !== 'boolean') return `${at}: fullPage phải là boolean`;
      if (raw.target !== undefined && !target(raw.target)) return `${at}: shot.target không hợp lệ`;
      return { shot: raw.shot, ...(raw.fullPage !== undefined ? { fullPage: raw.fullPage } : {}), ...(raw.target !== undefined ? { target: raw.target as string } : {}) };
    case 'measure':
      if (!Array.isArray(raw.measure) || !raw.measure.length || raw.measure.length > 20 || !raw.measure.every(target)) return `${at}: measure cần 1–20 target`;
      return { measure: raw.measure as string[] };
  }
}

export function validateCaptureArgs(raw: unknown, accounts: string[], worktree: string): { ok: true; args: CaptureArgs } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isObj(raw) || !Array.isArray(raw.steps)) return fail('steps phải là mảng bước');
  if (!raw.steps.length) return fail('steps cần ít nhất 1 bước');
  if (raw.steps.length > LIMITS.steps) return fail(`steps tối đa ${LIMITS.steps} bước`);
  let as: string | null = null;
  if (raw.as !== undefined && raw.as !== null && raw.as !== '') {
    if (typeof raw.as !== 'string' || !accounts.includes(raw.as)) return fail(`as: "${String(raw.as)}" không phải tài khoản test của dự án (có: ${accounts.join(', ') || 'không có'})`);
    as = raw.as;
  }
  const vp = raw.viewport === undefined ? {} : raw.viewport;
  if (!isObj(vp)) return fail('viewport phải là { width, height? }');
  const width = vp.width === undefined ? 1440 : vp.width;
  const height = vp.height === undefined ? 900 : vp.height;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < LIMITS.minWidth || width > LIMITS.maxWidth) return fail(`viewport.width phải là số nguyên ${LIMITS.minWidth}..${LIMITS.maxWidth}`);
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 200 || height > 4000) return fail('viewport.height phải là số nguyên 200..4000');
  const colorScheme = raw.colorScheme === undefined ? 'light' : raw.colorScheme;
  if (colorScheme !== 'light' && colorScheme !== 'dark') return fail('colorScheme phải là light hoặc dark');
  let locale: string | null = null;
  if (raw.locale !== undefined && raw.locale !== null) {
    if (typeof raw.locale !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw.locale)) return fail('locale phải dạng vi, en-US…');
    locale = raw.locale;
  }
  const cookies: CaptureArgs['cookies'] = [];
  if (raw.cookies !== undefined) {
    if (!Array.isArray(raw.cookies) || raw.cookies.length > 20) return fail('cookies phải là mảng tối đa 20 { name, value }');
    for (const c of raw.cookies) {
      if (!isObj(c) || typeof c.name !== 'string' || !/^[\w.-]{1,100}$/.test(c.name) || typeof c.value !== 'string' || c.value.length > 4000) return fail('cookies: mỗi cookie cần name và value là chuỗi');
      cookies.push({ name: c.name, value: c.value });
    }
  }
  const steps: Step[] = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const s = step(raw.steps[i], i + 1, worktree);
    if (typeof s === 'string') return fail(s);
    steps.push(s);
  }
  if (steps.filter((s) => 'shot' in s).length > LIMITS.shots) return fail(`tối đa ${LIMITS.shots} bước shot mỗi lần gọi`);
  return { ok: true, args: { as, viewport: { width, height }, colorScheme, locale, cookies, steps } };
}

/** Thay mọi giá trị trong `secrets` bằng `***` trong mọi chuỗi của kết quả. */
export function redact<T>(value: T, secrets: string[]): T {
  const list = secrets.filter((s) => s.length > 0);
  if (!list.length) return value;
  const fix = (s: string) => list.reduce((acc, x) => acc.split(x).join('***'), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function formatResult(r: CaptureResult): string {
  return JSON.stringify(r);
}

export function formatError(code: CaptureErrorCode, message: string, extra?: Partial<CaptureResult>): string {
  return `[capture:${code}] ${message}${extra && Object.keys(extra).length ? `\n${JSON.stringify(extra)}` : ''}`;
}
