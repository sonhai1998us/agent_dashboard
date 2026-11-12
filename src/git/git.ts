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

/**
 * Commit snapshot vòng trên nhánh acctv/* của worktree. Bỏ qua hook của repo (`--no-verify`): hook pre-commit/commit-msg
 * (vd. husky chạy tsc, test, lint, ép format message) làm snapshot chậm hoặc lỗi; agent đã tự chạy kiểm tra, người dùng review trước khi merge.
 */
export async function snapshotCommit(wt: string, message: string): Promise<string | null> {
  await git(wt, ['add', '-A']);
  if ((await git(wt, ['status', '--porcelain'])).trim() === '') return null;
  await git(wt, [...IDENT, 'commit', '--no-verify', '-m', message], GIT_TIMEOUT_MS.commit);
  return (await git(wt, ['rev-parse', 'HEAD'])).trim();
}

/**
 * File đã đổi so với HEAD (sửa, xoá, chưa track; bỏ file bị .gitignore), đường dẫn tương đối gốc worktree, dùng `/`.
 * Bắt được cả file agent ghi bằng Bash, thứ runner không thấy.
 */
export async function worktreeChanges(wt: string): Promise<string[]> {
  const out = await git(wt, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall']);
  const parts = out.split('\0');
  const files = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    files.add(e.slice(3));
    // đổi tên / chép: phần tử kế tiếp là đường dẫn cũ
    if (e[0] === 'R' || e[0] === 'C') files.add(parts[++i]);
  }
  return [...files].filter(Boolean);
}

export async function diffStat(repo: string, baseRef: string, branch: string): Promise<string> {
  return git(repo, ['diff', '--stat', `${baseRef}..${branch}`]);
}

/** Nhánh local (sắp xếp) và nhánh thư mục đang đứng (null nếu detached). */
export async function listBranches(repo: string): Promise<{ branches: string[]; current: string | null }> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  const branches = out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const current = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
  return { branches, current };
}

/** `upToDate`: nhánh đích đã chứa sẵn nhánh ticket, không có gì mới để merge. */
export type MergeResult = { kind: 'merged'; head: string; fastForward: boolean; upToDate: boolean } | { kind: 'conflict'; conflicts: string[] };

/**
 * Merge `branch` vào nhánh `target` ngay trong thư mục `repo` của người dùng: chuyển sang `target` nếu cần, rồi `git merge`
 * (fast-forward được thì fast-forward). Dùng tên git và hook của người dùng (đây là nhánh của họ, không phải snapshot).
 * Xung đột: để nguyên merge dở cho người dùng tự xử lý. Git từ chối (vd. thay đổi chưa commit sẽ bị ghi đè): ném lỗi.
 */
export async function mergeBranch(repo: string, target: string, branch: string, message: string): Promise<MergeResult> {
  await switchForMerge(repo, target);
  const before = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const tip = (await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`])).trim();
  // theo tên nhánh để dấu xung đột ghi `>>>>>>> acctv/T-…` thay vì mã commit
  const conflicts = await mergeOrConflicts(repo, ['merge', '--no-edit', '-m', message, branch]);
  if (conflicts) return { kind: 'conflict', conflicts };
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  return { kind: 'merged', head, fastForward: head === tip && head !== before, upToDate: head === before };
}

/** `files` rỗng: nhánh đích đã chứa sẵn nhánh ticket, không có gì để đưa vào. */
export type SquashResult = { kind: 'staged'; files: string[] } | { kind: 'conflict'; conflicts: string[] };

/**
 * Đưa toàn bộ thay đổi của `branch` vào nhánh `target` mà chưa commit (`git merge --squash`): thay đổi nằm ở phần
 * đã stage để người dùng xem trong IDE rồi tự commit. Từ chối khi đang có thay đổi đã stage (lẫn với phần đưa vào).
 */
export async function squashBranch(repo: string, target: string, branch: string): Promise<SquashResult> {
  await switchForMerge(repo, target);
  const staged = await git(repo, ['diff', '--cached', '--quiet']).then(() => false, () => true);
  if (staged) throw new Error('Thư mục dự án đang có thay đổi đã stage (có thể từ lần đưa vào trước chưa commit); commit hoặc bỏ stage rồi thử lại');
  const conflicts = await mergeOrConflicts(repo, ['merge', '--squash', branch]);
  if (conflicts) return { kind: 'conflict', conflicts };
  const files = (await git(repo, ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  return { kind: 'staged', files };
}

async function switchForMerge(repo: string, target: string): Promise<void> {
  if (!target || target.startsWith('-')) throw new Error(`Tên nhánh đích không hợp lệ: ${target}`);
  const refExists = (ref: string) => git(repo, ['rev-parse', '--verify', '-q', ref]).then(() => true, () => false);
  if (await refExists('MERGE_HEAD')) throw new Error('Thư mục dự án đang có một merge dở dang; xử lý xong (commit hoặc git merge --abort) rồi thử lại');
  if (!(await refExists(`refs/heads/${target}`))) throw new Error(`Không có nhánh ${target} trong ${repo}`);
  const current = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (current !== target) await git(repo, ['switch', target]);
}

/** Chạy lệnh merge; xung đột → danh sách file xung đột, lỗi khác → ném. */
async function mergeOrConflicts(repo: string, args: string[]): Promise<string[] | null> {
  try {
    await git(repo, args, GIT_TIMEOUT_MS.commit);
    return null;
  } catch (e) {
    const conflicts = (await git(repo, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U', '-z']).catch(() => ''))
      .split('\0').filter(Boolean);
    if (conflicts.length) return conflicts;
    throw e;
  }
}

/** Tạo lại worktree cho nhánh đã có (worktree cũ đã bị xoá). */
export async function attachWorktree(repo: string, branch: string, wtPath: string): Promise<void> {
  await git(repo, ['worktree', 'prune']);
  await git(repo, ['worktree', 'add', wtPath, branch]);
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', wtPath]);
}

/** Bỏ đăng ký các worktree mà thư mục đã mất (sau khi xoá tay). */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune']);
}

/** null: không có nhánh này. Ngược lại: số commit của nhánh chưa nằm trong nhánh local nào khác. */
export async function unmergedCommits(repo: string, branch: string): Promise<number | null> {
  if (!branch || branch.startsWith('-')) return null;
  const has = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(() => true, () => false);
  if (!has) return null;
  // --exclude áp cho --branches ngay sau nó, mẫu không kèm refs/heads/
  const out = await git(repo, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches']);
  return Number(out.trim()) || 0;
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith('-')) throw new Error(`Tên nhánh không hợp lệ: ${branch}`);
  await git(repo, ['branch', '-D', branch]);
}

export async function gitInit(dir: string): Promise<void> {
  await git(dir, ['init']);
  await git(dir, ['add', '-A']);
  await git(dir, [...IDENT, 'commit', '--allow-empty', '-m', 'Initial commit'], GIT_TIMEOUT_MS.commit);
}

export function worktreePath(home: string, repo: string, ticketId: string): string {
  return join(home, 'worktrees', `${basename(repo)}-${ticketId}`);
}
