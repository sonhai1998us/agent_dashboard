import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { runShell } from '@/src/preview/dbReset';

export interface DepsResult { ok: boolean; how: 'clone' | 'install'; cmd: string; ms: number; detail: string }

const INSTALL_MS = 600_000;
const LOCKS: [lock: string, cmd: string][] = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
];
/** File trình quản lý gói ghi vào node_modules sau mỗi lần cài: mtime của nó cho biết node_modules có mới hơn lockfile không. */
const MARKERS = ['.package-lock.json', '.modules.yaml', '.yarn-state.yml', '.yarn-integrity'];

const mtime = (p: string): number | null => { try { return statSync(p).mtimeMs; } catch { return null; } };

/** Lockfile và lệnh cài của worktree; null khi không phải dự án Node hoặc đã có node_modules. */
export function installPlan(wt: string): { lock: string | null; cmd: string } | null {
  if (!existsSync(path.join(wt, 'package.json')) || existsSync(path.join(wt, 'node_modules'))) return null;
  for (const [lock, cmd] of LOCKS) if (existsSync(path.join(wt, lock))) return { lock, cmd };
  return { lock: null, cmd: 'npm install' };
}

/**
 * Nhân bản được node_modules của repo gốc khi: lockfile giống hệt, node_modules được cài sau lần sửa lockfile cuối,
 * và không phải monorepo (node_modules của từng package con không được nhân bản).
 */
export function canClone(dir: string, wt: string, lock: string | null): boolean {
  if (!lock || (process.platform !== 'darwin' && process.platform !== 'linux')) return false;
  if (existsSync(path.join(wt, 'pnpm-workspace.yaml'))) return false;
  try {
    if ('workspaces' in JSON.parse(readFileSync(path.join(wt, 'package.json'), 'utf8'))) return false;
    if (!readFileSync(path.join(dir, lock)).equals(readFileSync(path.join(wt, lock)))) return false;
  } catch {
    return false;
  }
  const lockAt = mtime(path.join(dir, lock));
  const installedAt = Math.max(...MARKERS.map((m) => mtime(path.join(dir, 'node_modules', m)) ?? -1));
  return lockAt !== null && installedAt >= lockAt;
}

const run = promisify(execFile);

/** Chuẩn bị node_modules cho worktree mới; null khi không có gì để làm. Không bao giờ ném lỗi. */
export function installDeps(dir: string, wt: string): Promise<DepsResult> | null {
  const plan = installPlan(wt);
  if (!plan) return null;
  return (async () => {
    const t0 = Date.now();
    if (canClone(dir, wt, plan.lock)) {
      // APFS / btrfs, xfs: nhân bản copy-on-write, gần như tức thì và không tốn dung lượng
      const flags = process.platform === 'darwin' ? ['-cR'] : ['-R', '--reflink=auto'];
      try {
        await run('cp', [...flags, path.join(dir, 'node_modules'), path.join(wt, 'node_modules')], { timeout: INSTALL_MS });
        return { ok: true, how: 'clone', cmd: 'cp', ms: Date.now() - t0, detail: '' };
      } catch {
        rmSync(path.join(wt, 'node_modules'), { recursive: true, force: true });
      }
    }
    const r = await runShell(plan.cmd, wt, INSTALL_MS);
    return { ok: r.code === 0, how: 'install', cmd: plan.cmd, ms: Date.now() - t0, detail: r.code === 0 ? '' : r.tail.trim().slice(-1500) };
  })();
}
