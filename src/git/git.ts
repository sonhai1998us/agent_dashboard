import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const run = promisify(execFile);
const IDENT = ['-c', 'user.name=Agent CCTV', '-c', 'user.email=acctv@localhost'];

export interface GitInfo { exists: boolean; isGit: boolean; branch: string | null; head: string | null; dirty: boolean }

async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const stderr = String(err.stderr ?? '').trim();
    throw new Error(`git ${args[0]} lỗi: ${stderr || err.message}`);
  }
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

export async function createWorktree(repo: string, branch: string, wtPath: string): Promise<{ baseRef: string }> {
  const baseRef = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
  return { baseRef };
}

export async function snapshotCommit(wt: string, message: string): Promise<string | null> {
  await git(wt, ['add', '-A']);
  if ((await git(wt, ['status', '--porcelain'])).trim() === '') return null;
  await git(wt, [...IDENT, 'commit', '-m', message]);
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
  await git(dir, [...IDENT, 'commit', '--allow-empty', '-m', 'Initial commit']);
}

export function worktreePath(home: string, repo: string, ticketId: string): string {
  return join(home, 'worktrees', `${basename(repo)}-${ticketId}`);
}
