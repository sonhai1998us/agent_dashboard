import nodePath from 'node:path';
import type { Role } from '@/src/tickets/model';

export interface GuardPolicy {
  role: Role;
  root: string;
  readRoots: string[];
  allowedFiles: string[];
  denyBash: RegExp[];
  checkCommands: RegExp[];
  /** Controller: thư mục không được ghi (dữ liệu dashboard, ~/.claude, ~/.codex). */
  protectedRoots?: string[];
}
/** `explicit`: hook trả "allow" tường minh (tool không nằm trong --allowedTools, vd. tool MCP của người dùng). */
export type GuardDecision = { allow: true; explicit?: true } | { allow: false; reason: string; scope: boolean };

/** Tool MCP chỉ đọc của người dùng mà Explorer được dùng (vd. Figma get_design_context, get_metadata, whoami). */
const MCP_READ = /^(get|list|search|read|fetch|whoami|describe|query)(_|$)|^create_session$/i;

export function isUserMcpReadTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__acctv__')) return false;
  const tool = toolName.split('__').slice(2).join('__');
  return MCP_READ.test(tool) && !MCP_GIT_WRITE.test(tool);
}

/** Tool MCP duy nhất của worker: nhờ người dùng làm việc agent không tự làm được (đăng nhập…). */
export const USER_ACTION_TOOL = 'mcp__acctv__request_user_action';

/** Tool MCP của dashboard: mở trang trên server preview của ticket trong Chrome headless (Dev, Designer, QC). */
export const CAPTURE_TOOL = 'mcp__acctv__capture';
const CAPTURE_ROLES = new Set(['dev', 'designer', 'qc']);

/** Độ dài tối đa của lệnh Bash mà guard chịu kiểm tra. */
export const MAX_COMMAND = 32_000;

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** `**` khớp mọi thứ (kể cả `/`), `*` khớp mọi thứ trừ `/`, `?` một ký tự trừ `/`. So không phân biệt hoa thường, `\` = `/`. */
export function matchGlob(pattern: string, path: string): boolean {
  const p = norm(pattern);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(norm(path));
}

/** Mục trong danh sách file: glob, hoặc (không có `*`/`?`) một file hay cả thư mục bên dưới nó. */
export function matchEntry(entry: string, path: string): boolean {
  if (matchGlob(entry, path)) return true;
  return !/[*?]/.test(entry) && matchGlob(`${entry.replace(/[\\/]+$/, '')}/**`, path);
}

const WIN = process.platform === 'win32';
const P = WIN ? nodePath.win32 : nodePath.posix;
const cmp = (s: string) => (WIN ? s.toLowerCase() : s);

const deny = (reason: string, scope = false): GuardDecision => ({ allow: false, reason: `[acctv-guard] ${reason}`, scope });
const strField = (input: unknown, ...keys: string[]): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
};

/** Đường dẫn tương đối (dùng `/`) nếu `abs` nằm trong `root`, ngược lại null. */
function relInside(root: string, abs: string): string | null {
  const a = P.resolve(root);
  const r = WIN ? P.relative(a.toLowerCase(), abs.toLowerCase()) : P.relative(a, abs);
  if (r === '') return '';
  if (r === '..' || r.startsWith('..' + P.sep) || r.startsWith('../') || P.isAbsolute(r)) return null;
  // lấy phần tương đối từ đường dẫn gốc (giữ nguyên hoa/thường)
  return abs.slice(a.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}
const sameRel = (a: string, b: string) => cmp(a.replace(/\\/g, '/')) === cmp(b.replace(/\\/g, '/'));

/** Regex của denyBash/checkCommands viết lại cho người (và model) đọc: bỏ \b, \s → dấu cách, [^\n]* → … */
export function readableRule(src: string): string {
  return src
    .replace(/\\b/g, '')
    .replace(/\[\^\\n\]\*/g, '…')
    .replace(/\\s[+*]?/g, ' ')
    .replace(/^\^/, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const CHAIN = /[;&|<>`\n\r]|\$\(|--output/i;
const hasGit = (rel: string) => rel.split('/').some((seg) => cmp(seg) === '.git');

/**
 * python/python3/python3.14/py ở vị trí đầu lệnh (đầu chuỗi, sau ; & | ( ` xuống dòng hay $(, bỏ qua gán biến FOO=1),
 * kèm đường dẫn và .exe tuỳ ý.
 */
const PY_CMD = /(?:^|[;&|(`\n\r]|\$\()\s*(?:\w+=\S*\s+)*(?:[^\s;&|()`'"<>]*[\\/])?(?:python(?:\d+(?:\.\d+)?)?|py)(?:\.exe)?(?=$|[\s;&|)<`])/gi;
const SEG_END = /[;&|)\n\r`]/;
const PY_INFO = new Set(['-V', '-VV', '--version', '-h', '--help']);
const PY_STDIN = 'python đọc script từ stdin hoặc mở REPL (python -, python <<EOF, … | python, python không đối số) bị chặn: '
  + 'trên máy này python gặp stdin rỗng sẽ mở REPL và treo tới khi lệnh hết hạn. '
  + 'Hãy ghi script bằng Write rồi chạy `python file.py`, dùng `python -c "…"`, hoặc dùng `node -e`.';

/** Lệnh gọi python mà không có script, -c hay -m: python đọc stdin (heredoc rỗng vì quote nhiều dòng, pipe) hoặc mở REPL. */
function pythonReadsStdin(cmd: string): boolean {
  for (const m of cmd.matchAll(PY_CMD)) {
    const rest = cmd.slice(m.index + m[0].length);
    const end = rest.search(SEG_END);
    const args = (end < 0 ? rest : rest.slice(0, end)).trim().split(/\s+/).filter(Boolean);
    let runsScript = false;
    for (const a of args) {
      if (a === '-' || a === '-i' || a.startsWith('<')) break;
      if (a === '-c' || a === '-m' || PY_INFO.has(a) || !a.startsWith('-')) { runsScript = true; break; }
    }
    if (!runsScript) return true;
  }
  return false;
}

/** Lệnh shell: chặn lệnh nền, lệnh quá dài, python đọc stdin và lệnh khớp denyBash. null = cho qua. */
function shellDeny(p: GuardPolicy, input: unknown): GuardDecision | null {
  const cmd = strField(input, 'command');
  if (cmd === undefined) return deny('lệnh bị cấm (thiếu command)');
  // Lệnh nền giữ tiến trình `claude -p` sống sau khi agent đã xong (vd. `twg login` chờ trình duyệt) và ghi output ra ngoài worktree.
  const bg = (input as Record<string, unknown>).run_in_background;
  if (bg !== undefined && bg !== null && bg !== false) {
    return deny(p.role === 'controller'
      ? 'không chạy lệnh nền (run_in_background); hãy chạy lệnh ở tiền cảnh kèm timeout. Lệnh cần đăng nhập thì ghi vào kế hoạch để người dùng làm.'
      : 'không chạy lệnh nền (run_in_background); hãy chạy lệnh ở tiền cảnh kèm timeout. Lệnh cần tương tác hay đăng nhập thì gọi request_user_action để nhờ người dùng.');
  }
  // Chặn trước khi chạy regex: guard chạy đồng bộ trong server, lệnh khổng lồ không được làm treo event loop.
  if (cmd.length > MAX_COMMAND) return deny(`lệnh quá dài (> ${MAX_COMMAND} ký tự); hãy ghi nội dung bằng Write rồi chạy file`);
  if (pythonReadsStdin(cmd)) return deny(PY_STDIN);
  for (const re of p.denyBash) if (re.test(cmd)) return deny(`lệnh bị cấm (${re.source})`);
  return null;
}

/** Tool không cho Controller: tạo worktree / nhánh git, và tool MCP có tên kiểu commit/push/merge (vd. GitHub MCP). */
const CONTROLLER_DENY_TOOLS = new Set(['EnterWorktree', 'ExitWorktree']);
const MCP_GIT_WRITE = /(^|_)(commit|push|merge)(_|$)|push_files|create_or_update_file|create_branch|delete_branch/i;

/** Controller có quyền như người dùng, trừ commit/push (denyBash) và ghi vào thư mục được bảo vệ. */
function checkController(p: GuardPolicy, toolName: string, input: unknown, resolve: (x: string) => string): GuardDecision {
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const raw = strField(input, 'file_path', 'notebook_path');
      if (!raw) return deny('thiếu đường dẫn');
      const abs = resolve(raw);
      if (abs.split(/[\\/]/).some((seg) => cmp(seg) === '.git')) return deny(`không sửa trực tiếp thư mục .git: ${abs}`);
      if ((p.protectedRoots ?? []).some((r) => relInside(r, abs) !== null)) return deny(`thư mục được bảo vệ (dashboard, Claude, Codex): ${abs}`);
      return { allow: true };
    }
    case 'Bash':
    case 'PowerShell':
      return shellDeny(p, input) ?? { allow: true };
  }
  if (CONTROLLER_DENY_TOOLS.has(toolName)) return deny(`tool ${toolName} không được phép cho Controller (đổi nhánh / worktree)`);
  if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__acctv__')) {
    const tool = toolName.split('__').slice(2).join('__');
    if (MCP_GIT_WRITE.test(tool)) return deny(`tool ${toolName} có thể commit/push; Controller không được dùng`);
  }
  return { allow: true };
}

export function checkTool(p: GuardPolicy, toolName: string, input: unknown, cwd: string): GuardDecision {
  const base = typeof cwd === 'string' && cwd ? cwd : p.root;
  const resolve = (x: string) => P.resolve(base, x);
  if (p.role === 'controller') return checkController(p, toolName, input, resolve);
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep': {
      if (toolName === 'Glob') {
        const pat = strField(input, 'pattern');
        if (pat && (P.isAbsolute(pat) || /^[\\/]/.test(pat) || /^[a-zA-Z]:/.test(pat) || pat.split(/[\\/]/).includes('..'))) return deny(`ngoài thư mục làm việc: ${pat}`);
      }
      const target = resolve(strField(input, 'file_path', 'path') ?? base);
      const ok = [p.root, ...p.readRoots].some((r) => relInside(r, target) !== null);
      return ok ? { allow: true } : deny(`ngoài thư mục làm việc: ${target}`);
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (p.role !== 'dev') return deny(`vai ${p.role} chỉ được đọc`);
      const raw = strField(input, 'file_path', 'notebook_path');
      if (!raw) return deny('ngoài phạm vi: (thiếu đường dẫn)', true);
      const abs = resolve(raw);
      const rel = relInside(p.root, abs);
      if (rel === null) return deny(`ngoài phạm vi: ${abs}`, true);
      if (rel && hasGit(rel)) return deny(`ngoài phạm vi: ${rel}`, true);
      if (rel && p.allowedFiles.some((g) => sameRel(g, rel) || matchEntry(g, rel))) return { allow: true };
      return deny(`ngoài phạm vi: ${rel || abs}`, true);
    }
    case 'Bash': {
      const d = shellDeny(p, input);
      if (d) return d;
      const cmd = strField(input, 'command')!;
      if (p.role === 'designer' || p.role === 'qc' || p.role === 'explorer') {
        // Nêu rõ cái gì được phép: chỉ nói "bị chặn" thì model cứ thử biến thể khác và bị chặn lặp lại.
        if (CHAIN.test(cmd)) return deny(`vai ${p.role} chỉ chạy lệnh kiểm tra đơn: không nối lệnh (; & | < > \` $( hay xuống dòng), không chuyển hướng và không dùng --output`);
        if (!p.checkCommands.some((re) => re.test(cmd))) {
          const allowed = p.checkCommands.map((re) => `\`${readableRule(re.source)}\``).join(', ');
          return deny(`vai ${p.role} chỉ chạy lệnh kiểm tra khớp một trong các mẫu: ${allowed || '(không có)'}. Đọc hay tìm file thì dùng Read, Grep, Glob; lệnh khác (cat, ls, curl, node, chạy server…) sẽ bị chặn, đừng thử biến thể khác`);
        }
      }
      return { allow: true };
    }
  }
  if (toolName === USER_ACTION_TOOL) return { allow: true };
  if (toolName === CAPTURE_TOOL && CAPTURE_ROLES.has(p.role)) return { allow: true };
  // Explorer và Designer đọc thiết kế (Figma…) qua MCP của người dùng: chỉ tool đọc
  if (p.role === 'explorer' || p.role === 'designer') {
    if (toolName === 'ToolSearch') return { allow: true, explicit: true };
    if (isUserMcpReadTool(toolName)) return { allow: true, explicit: true };
  }
  return deny(`tool ${toolName} không được phép cho vai ${p.role}`);
}

export function hookCommand(nodeExe: string, scriptPath: string, port: number, agentId: string, token: string): string {
  return `"${nodeExe}" "${scriptPath}" ${port} ${agentId} ${token}`;
}
