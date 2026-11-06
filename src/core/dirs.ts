import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
export const DIR_LIST_MAX = 1000;

export interface DirEntry { name: string; path: string; isGit: boolean }
export interface DirListing {
  /** null: danh sách gốc (ổ đĩa trên Windows, `/` trên máy khác) */
  path: string | null;
  parent: string | null;
  isGit: boolean;
  entries: DirEntry[];
  truncated: boolean;
}

export class DirError extends Error {
  constructor(public status: 403 | 404, msg: string) { super(msg); }
}

/** Thư mục ẩn / hệ thống không cần cho việc chọn dự án. */
function hidden(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || name === 'node_modules' || name === 'System Volume Information';
}

const hasGit = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));

function isDirEntry(parent: string, d: fs.Dirent): boolean {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(parent, d.name)).isDirectory(); } catch { return false; }
}

function roots(): DirEntry[] {
  const out: DirEntry[] = [];
  const home = os.homedir();
  if (WIN) {
    for (let c = 65; c <= 90; c++) {
      const p = `${String.fromCharCode(c)}:\\`;
      try { if (fs.statSync(p).isDirectory()) out.push({ name: p, path: p, isGit: false }); } catch { /* ổ không có */ }
    }
  } else out.push({ name: '/', path: '/', isGit: false });
  if (home) out.push({ name: `Thư mục người dùng (${home})`, path: home, isGit: hasGit(home) });
  return out;
}

/** Thư mục con của `dir` (đường dẫn tuyệt đối), hoặc danh sách gốc khi `dir` là null. */
export function listDirs(dir: string | null): DirListing {
  if (dir === null) return { path: null, parent: null, isGit: false, entries: roots(), truncated: false };
  const abs = path.resolve(dir);
  let items: fs.Dirent[];
  try {
    if (!fs.statSync(abs).isDirectory()) throw new DirError(404, 'Không phải thư mục');
    items = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    if (e instanceof DirError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new DirError(403, 'Không có quyền đọc thư mục này');
    throw new DirError(404, 'Thư mục không tồn tại');
  }
  const names = items.filter((d) => !hidden(d.name) && isDirEntry(abs, d)).map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const truncated = names.length > DIR_LIST_MAX;
  const entries = names.slice(0, DIR_LIST_MAX).map((name) => {
    const p = path.join(abs, name);
    return { name, path: p, isGit: hasGit(p) };
  });
  const up = path.dirname(abs);
  return { path: abs, parent: up === abs ? null : up, isGit: hasGit(abs), entries, truncated };
}
