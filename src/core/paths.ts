import path from 'node:path';

const WIN = process.platform === 'win32';

/** dir là root hoặc nằm trong root (không phân biệt hoa thường trên Windows). */
export function inside(dir: string, root: string): boolean {
  const norm = (p: string): string => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
  const d = norm(dir);
  const r = norm(root).replace(/[\\/]+$/, '');
  return d === r || d.startsWith(r + path.sep);
}
