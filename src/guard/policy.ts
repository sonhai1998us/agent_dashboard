import nodePath from 'node:path';
import type { Role } from '@/src/tickets/model';

export interface GuardPolicy {
  role: Role;
  root: string;
  readRoots: string[];
  allowedFiles: string[];
  denyBash: RegExp[];
  checkCommands: RegExp[];
}
export type GuardDecision = { allow: true } | { allow: false; reason: string; scope: boolean };

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

const CHAIN = /[;&|<>`\n\r]|\$\(|--output/i;
const hasGit = (rel: string) => rel.split('/').some((seg) => cmp(seg) === '.git');

export function checkTool(p: GuardPolicy, toolName: string, input: unknown, cwd: string): GuardDecision {
  const base = typeof cwd === 'string' && cwd ? cwd : p.root;
  const resolve = (x: string) => P.resolve(base, x);
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep': {
      if (toolName === 'Glob') {
        const pat = strField(input, 'pattern');
        if (pat && (P.isAbsolute(pat) || /^[\/]/.test(pat) || /^[a-zA-Z]:/.test(pat) || pat.split(/[\/]/).includes('..'))) return deny(`ngoài thư mục làm việc: ${pat}`);
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
      if (rel && p.allowedFiles.some((g) => sameRel(g, rel) || matchGlob(g, rel))) return { allow: true };
      return deny(`ngoài phạm vi: ${rel || abs}`, true);
    }
    case 'Bash': {
      if (p.role === 'controller') return deny('vai controller không được chạy lệnh');
      const cmd = strField(input, 'command');
      if (cmd === undefined) return deny('lệnh bị cấm (thiếu command)');
      for (const re of p.denyBash) if (re.test(cmd)) return deny(`lệnh bị cấm (${re.source})`);
      if (p.role === 'designer' || p.role === 'qc') {
        if (CHAIN.test(cmd) || !p.checkCommands.some((re) => re.test(cmd))) return deny(`vai ${p.role} chỉ chạy lệnh kiểm tra`);
      }
      return { allow: true };
    }
  }
  if (toolName.startsWith('mcp__acctv__') && p.role === 'controller') return { allow: true };
  return deny(`tool ${toolName} không được phép cho vai ${p.role}`);
}

export function hookCommand(nodeExe: string, scriptPath: string, port: number, agentId: string, token: string): string {
  return `"${nodeExe}" "${scriptPath}" ${port} ${agentId} ${token}`;
}
