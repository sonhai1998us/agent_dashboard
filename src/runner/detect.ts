import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

export function findExecutable(name: 'claude' | 'codex', override: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (override && existsSync(override)) return override;
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.cmd', ''] : [''];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  if (name === 'claude') {
    const home = env.USERPROFILE ?? env.HOME;
    if (home) {
      const p = path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude');
      if (isFile(p)) return p;
    }
  }
  return null;
}
