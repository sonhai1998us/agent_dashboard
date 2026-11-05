import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { killTree } from '@/src/runner/proc';

const IDENT = ['-c', 'user.name=Agent CCTV', '-c', 'user.email=acctv@localhost', '-c', 'commit.gpgsign=false'];
/** Hook hay prompt của git không được treo dashboard: quá hạn thì kill cây tiến trình git và báo lỗi. */
export const GIT_TIMEOUT_MS = { commit: 120_000, other: 60_000 };

export interface GitInfo { exists: boolean; isGit: boolean; branch: string | null; head: string | null; dirty: boolean }

/** Tên lệnh con để báo lỗi (bỏ qua các cặp `-c k=v`). */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else return args[i];
  }
  return '';
}

function git(dir: string, args: string[], timeoutMs = GIT_TIMEOUT_MS.other): Promise<string> {
  const name = subcommand(args);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (!err) return resolve(stdout);
      const msg = String(stderr ?? '').trim();
      reject(new Error(`git ${name} lỗi: ${msg || err.message}`));
    });
    timer = setTimeout(() => {
      // không chờ stdio đóng: tiến trình con của hook có thể còn giữ pipe
      if (child.pid !== undefined) void killTree(child.pid);
      reject(new Error(`git ${name} lỗi: quá ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

export async function gitInfo(dir: string): Promise<GitInfo> {
  if (!existsSync(dir)) return { exists: false, isGit: false, branch: null, head: null, dirty: false };
  try {
    if ((await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') throw new Error('not git');
  } catch {
    return { exists: true, isGit: false, branch: null, head: null, dirty: false };
  }
  const branch = (await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
  const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
  const dirty = (await git(dir, ['status', '--porcelain'])).trim() !== '';
  return { exists: true, isGit: true, branch, head, dirty };
}

/** `base` nếu chưa có nhánh đó, ngược lại `base-2`, `base-3`, … */
export async function uniqueBranch(repo: string, base: string): Promise<string> {
  const exists = (b: string) => git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).then(() => true, () => false);
  if (!(await exists(base))) return base;
  for (let n = 2; ; n++) if (!(await exists(`${base}-${n}`))) return `${base}-${n}`;
}

export async function createWorktree(repo: string, branch: string, wtPath: string): Promise<{ baseRef: string }> {
  const baseRef = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
  return { baseRef };
}

export async function snapshotCommit(wt: string, message: string): Promise<string | null> {
  await git(wt, ['add', '-A']);
  if ((await git(wt, ['status', '--porcelain'])).trim() === '') return null;
  await git(wt, [...IDENT, 'commit', '-m', message], GIT_TIMEOUT_MS.commit);
  return (await git(wt, ['rev-parse', 'HEAD'])).trim();
}

export async function diffStat(repo: string, baseRef: string, branch: string): Promise<string> {
  return git(repo, ['diff', '--stat', `${baseRef}..${branch}`]);
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', wtPath]);
}

export async function gitInit(dir: string): Promise<void> {
  await git(dir, ['init']);
  await git(dir, ['add', '-A']);
  await git(dir, [...IDENT, 'commit', '--allow-empty', '-m', 'Initial commit'], GIT_TIMEOUT_MS.commit);
}

export function worktreePath(home: string, repo: string, ticketId: string): string {
  return join(home, 'worktrees', `${basename(repo)}-${ticketId}`);
}
