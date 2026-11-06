import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitInfo, createWorktree, snapshotCommit, diffStat, removeWorktree, gitInit, worktreePath, uniqueBranch, worktreeChanges, GIT_TIMEOUT_MS } from '@/src/git/git';

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
