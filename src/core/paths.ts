import path from 'node:path';

// Windows và macOS (APFS mặc định) không phân biệt hoa thường
const FOLD = process.platform === 'win32' || process.platform === 'darwin';

/** dir là root hoặc nằm trong root (không phân biệt hoa thường trên Windows, macOS). */
export function inside(dir: string, root: string): boolean {
  const norm = (p: string): string => (FOLD ? path.resolve(p).toLowerCase() : path.resolve(p));
  const d = norm(dir);
  const r = norm(root).replace(/[\\/]+$/, '');
  return d === r || d.startsWith(r + path.sep);
}
