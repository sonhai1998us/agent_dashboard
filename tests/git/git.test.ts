import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitInfo, createWorktree, snapshotCommit, diffStat, removeWorktree, gitInit, worktreePath, uniqueBranch, worktreeChanges, GIT_TIMEOUT_MS, listBranches, mergeBranch, squashBranch } from '@/src/git/git';

const g = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

let root: string;
let repo: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'acctv-git-'));
  repo = join(root, 'Dự án demo');
  home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  g(repo, 'init');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '-A');
  g(repo, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-m', 'first');
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('git helpers', () => {
  it('gitInfo: clean, dirty, missing, plain dir', async () => {
    const clean = await gitInfo(repo);
    expect(clean).toMatchObject({ exists: true, isGit: true, dirty: false });
    expect(clean.branch).toBeTruthy();
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect((await gitInfo(repo)).dirty).toBe(true);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    expect(await gitInfo(join(root, 'khong-ton-tai'))).toMatchObject({ exists: false, isGit: false });
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await gitInfo(plain)).toMatchObject({ exists: true, isGit: false });
  });

  it('worktree, snapshot, diffStat, remove', async () => {
    const wt = worktreePath(home, repo, 'T-1');
    expect(wt).toBe(join(home, 'worktrees', 'Dự án demo-T-1'));
    const { baseRef } = await createWorktree(repo, 'acctv/T-1-demo', wt);
    expect(baseRef).toBe(g(repo, 'rev-parse', 'HEAD').trim());
    expect(readFileSync(join(wt, 'a.txt'), 'utf8').trim()).toBe('a');
    expect(g(repo, 'branch', '--list', 'acctv/T-1-demo')).toContain('acctv/T-1-demo');

    writeFileSync(join(wt, 'b.txt'), 'b\n');
    const sha = await snapshotCommit(wt, 'round 1');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await snapshotCommit(wt, 'round 2')).toBeNull();
    expect(await diffStat(repo, baseRef, 'acctv/T-1-demo')).toContain('b.txt');
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);

    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(g(repo, 'branch', '--list', 'acctv/T-1-demo')).toContain('acctv/T-1-demo');
  });

  it('errors carry stderr', async () => {
    await expect(createWorktree(repo, 'acctv/x', join(root, 'x'))).resolves.toBeTruthy();
    await expect(createWorktree(repo, 'acctv/x', join(root, 'y'))).rejects.toThrow(/already exists|acctv\/x/);
  });

  it('snapshot ignores commit.gpgsign=true in the repo config', async () => {
    const r = join(root, 'signed');
    mkdirSync(r);
    g(r, 'init', '-q');
    g(r, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(r, 'a.txt'), 'a\n');
    g(r, 'add', '-A');
    g(r, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'first');
    g(r, 'config', 'commit.gpgsign', 'true');
    g(r, 'config', 'gpg.program', join(root, 'khong-co-gpg.exe'));
    writeFileSync(join(r, 'b.txt'), 'b\n');
    expect(await snapshotCommit(r, 'snap')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('snapshot bỏ qua hook của repo: pre-commit treo và commit-msg từ chối không chặn được', async () => {
    const r = join(root, 'hooked');
    mkdirSync(r);
    g(r, 'init', '-q');
    g(r, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(r, 'a.txt'), 'a\n');
    g(r, 'add', '-A');
    g(r, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'first');
    writeFileSync(join(r, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    writeFileSync(join(r, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "Invalid commit message format!" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(r, 'b.txt'), 'b\n');
    const saved = GIT_TIMEOUT_MS.commit;
    GIT_TIMEOUT_MS.commit = 5000;
    try {
      const t0 = Date.now();
      expect(await snapshotCommit(r, 'acctv: T-1 vòng 1')).toMatch(/^[0-9a-f]{40}$/);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(g(r, 'log', '-1', '--format=%s').trim()).toBe('acctv: T-1 vòng 1');
    } finally {
      GIT_TIMEOUT_MS.commit = saved;
    }
  }, 20_000);

  it('uniqueBranch suffixes -2, -3 … when the branch already exists', async () => {
    expect(await uniqueBranch(repo, 'acctv/T-7-moi')).toBe('acctv/T-7-moi');
    g(repo, 'branch', 'acctv/T-7-moi');
    expect(await uniqueBranch(repo, 'acctv/T-7-moi')).toBe('acctv/T-7-moi-2');
    g(repo, 'branch', 'acctv/T-7-moi-2');
    expect(await uniqueBranch(repo, 'acctv/T-7-moi')).toBe('acctv/T-7-moi-3');
  });

  it('gitInit on a plain dir', async () => {
    const d = join(root, 'Thư mục mới');
    mkdirSync(d);
    writeFileSync(join(d, 'f.txt'), 'f');
    await gitInit(d);
    const info = await gitInfo(d);
    expect(info.isGit).toBe(true);
    expect(info.head).toBeTruthy();
  });

  it('worktreeChanges lists modified, deleted and untracked files (nested, unicode) relative to the root', async () => {
    const d = join(root, 'changes');
    mkdirSync(d);
    g(d, 'init', '-q');
    writeFileSync(join(d, 'keep.txt'), 'k\n');
    writeFileSync(join(d, 'gone.txt'), 'g\n');
    writeFileSync(join(d, '.gitignore'), 'ignored/\n');
    g(d, 'add', '-A');
    g(d, '-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');
    expect(await worktreeChanges(d)).toEqual([]);
    writeFileSync(join(d, 'keep.txt'), 'changed\n');
    rmSync(join(d, 'gone.txt'));
    mkdirSync(join(d, 'src', 'mới'), { recursive: true });
    writeFileSync(join(d, 'src', 'mới', 'tệp a.ts'), 'x');
    mkdirSync(join(d, 'ignored'));
    writeFileSync(join(d, 'ignored', 'x.txt'), 'x');
    expect((await worktreeChanges(d)).sort()).toEqual(['gone.txt', 'keep.txt', 'src/mới/tệp a.ts']);
  });
});

describe('merge nhánh ticket vào nhánh của người dùng', () => {
  let n = 0;
  /** repo có main (a.txt) và nhánh ticket acctv/T-1 thêm b.txt; đang đứng ở main */
  const mkRepo = (): string => {
    const r = join(root, `merge-${++n}`);
    mkdirSync(r);
    g(r, 'init', '-q', '-b', 'main');
    g(r, 'config', 'core.autocrlf', 'false');
    g(r, 'config', 'user.name', 'Người dùng');
    g(r, 'config', 'user.email', 'me@localhost');
    writeFileSync(join(r, 'a.txt'), 'a\n');
    g(r, 'add', '-A');
    g(r, 'commit', '-q', '-m', 'first');
    g(r, 'switch', '-q', '-c', 'acctv/T-1');
    writeFileSync(join(r, 'b.txt'), 'b\n');
    g(r, 'add', '-A');
    g(r, 'commit', '-q', '-m', 'acctv: T-1 vòng 1');
    g(r, 'switch', '-q', 'main');
    return r;
  };
  const commitOn = (r: string, file: string, body: string, msg: string) => {
    writeFileSync(join(r, file), body);
    g(r, 'add', '-A');
    g(r, 'commit', '-q', '-m', msg);
  };
  const head = (r: string) => g(r, 'rev-parse', 'HEAD').trim();
  const hasMergeHead = (r: string) => { try { g(r, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'); return true; } catch { return false; } };

  it('listBranches: nhánh local đã sắp xếp và nhánh đang đứng', async () => {
    const r = mkRepo();
    g(r, 'branch', 'dev');
    expect(await listBranches(r)).toEqual({ branches: ['acctv/T-1', 'dev', 'main'], current: 'main' });
  });

  it('fast-forward khi nhánh đích chưa đổi', async () => {
    const r = mkRepo();
    const tip = g(r, 'rev-parse', 'acctv/T-1').trim();
    expect(await mergeBranch(r, 'main', 'acctv/T-1', 'Merge T-1: demo')).toEqual({ kind: 'merged', head: tip, fastForward: true, upToDate: false });
    // merge lại: không có gì mới
    expect(await mergeBranch(r, 'main', 'acctv/T-1', 'x')).toEqual({ kind: 'merged', head: tip, fastForward: false, upToDate: true });
    expect(head(r)).toBe(tip);
    expect(existsSync(join(r, 'b.txt'))).toBe(true);
  });

  it('đang đứng ở nhánh khác: chuyển sang nhánh đích rồi merge', async () => {
    const r = mkRepo();
    g(r, 'switch', '-q', '-c', 'dev');
    const res = await mergeBranch(r, 'main', 'acctv/T-1', 'Merge T-1: demo');
    expect(res.kind).toBe('merged');
    expect(g(r, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(g(r, 'rev-parse', 'main').trim()).toBe(g(r, 'rev-parse', 'acctv/T-1').trim());
  });

  it('nhánh đích đã có commit mới: tạo merge commit bằng tên git của người dùng', async () => {
    const r = mkRepo();
    commitOn(r, 'c.txt', 'c\n', 'việc khác trên main');
    const res = await mergeBranch(r, 'main', 'acctv/T-1', 'Merge T-1: demo');
    expect(res).toMatchObject({ kind: 'merged', fastForward: false, upToDate: false });
    expect(g(r, 'log', '-1', '--format=%s|%an|%P').trim()).toMatch(/^Merge T-1: demo\|Người dùng\|\w+ \w+$/);
    expect(existsSync(join(r, 'b.txt')) && existsSync(join(r, 'c.txt'))).toBe(true);
  });

  it('xung đột: để nguyên merge dở cho người dùng, trả danh sách file', async () => {
    const r = mkRepo();
    g(r, 'switch', '-q', 'acctv/T-1');
    commitOn(r, 'a.txt', 'từ ticket\n', 'ticket sửa a');
    g(r, 'switch', '-q', 'main');
    commitOn(r, 'a.txt', 'từ main\n', 'main sửa a');
    const res = await mergeBranch(r, 'main', 'acctv/T-1', 'Merge T-1: demo');
    expect(res).toEqual({ kind: 'conflict', conflicts: ['a.txt'] });
    expect(hasMergeHead(r)).toBe(true);
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toContain('>>>>>>> acctv/T-1');
    // merge dở dang → lần sau bị từ chối, không đụng gì thêm
    await expect(mergeBranch(r, 'main', 'acctv/T-1', 'x')).rejects.toThrow(/merge dở dang/);
  });

  it('git từ chối (thay đổi chưa commit sẽ bị ghi đè): báo lỗi, không đổi gì', async () => {
    const r = mkRepo();
    commitOn(r, 'c.txt', 'c\n', 'việc khác trên main');
    writeFileSync(join(r, 'b.txt'), 'đang sửa dở\n');
    const before = head(r);
    await expect(mergeBranch(r, 'main', 'acctv/T-1', 'Merge T-1: demo')).rejects.toThrow(/b\.txt/);
    expect(head(r)).toBe(before);
    expect(hasMergeHead(r)).toBe(false);
    expect(readFileSync(join(r, 'b.txt'), 'utf8')).toBe('đang sửa dở\n');
  });

  it('nhánh đích không tồn tại hoặc tên không hợp lệ', async () => {
    const r = mkRepo();
    await expect(mergeBranch(r, 'khong-co', 'acctv/T-1', 'x')).rejects.toThrow(/khong-co/);
    await expect(mergeBranch(r, '-main', 'acctv/T-1', 'x')).rejects.toThrow(/không hợp lệ/);
    expect(g(r, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
  });

  it('squash: đưa thay đổi vào phần đã stage, chưa commit, HEAD giữ nguyên', async () => {
    const r = mkRepo();
    const before = head(r);
    writeFileSync(join(r, 'x.txt'), 'chưa stage\n');
    expect(await squashBranch(r, 'main', 'acctv/T-1')).toEqual({ kind: 'staged', files: ['b.txt'] });
    expect(head(r)).toBe(before);
    expect(hasMergeHead(r)).toBe(false);
    expect(g(r, 'diff', '--cached', '--name-only').trim()).toBe('b.txt');
    expect(readFileSync(join(r, 'x.txt'), 'utf8')).toBe('chưa stage\n');
    // chưa commit phần đã đưa vào → lần sau bị từ chối
    await expect(squashBranch(r, 'main', 'acctv/T-1')).rejects.toThrow(/đã stage/);
  });

  it('squash: nhánh đích đã có sẵn → không có gì để đưa vào', async () => {
    const r = mkRepo();
    await mergeBranch(r, 'main', 'acctv/T-1', 'x');
    expect(await squashBranch(r, 'main', 'acctv/T-1')).toEqual({ kind: 'staged', files: [] });
  });

  it('squash: xung đột để nguyên cho người dùng', async () => {
    const r = mkRepo();
    g(r, 'switch', '-q', 'acctv/T-1');
    commitOn(r, 'a.txt', 'từ ticket\n', 'ticket sửa a');
    g(r, 'switch', '-q', 'main');
    commitOn(r, 'a.txt', 'từ main\n', 'main sửa a');
    expect(await squashBranch(r, 'main', 'acctv/T-1')).toEqual({ kind: 'conflict', conflicts: ['a.txt'] });
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toContain('>>>>>>> acctv/T-1');
  });
});
