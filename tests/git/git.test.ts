import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitInfo, createWorktree, snapshotCommit, diffStat, removeWorktree, gitInit, worktreePath, uniqueBranch, GIT_TIMEOUT_MS } from '@/src/git/git';

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

  it('a hanging pre-commit hook times out the snapshot instead of stalling', async () => {
    const r = join(root, 'hooked');
    mkdirSync(r);
    g(r, 'init', '-q');
    g(r, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(r, 'a.txt'), 'a\n');
    g(r, 'add', '-A');
    g(r, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'first');
    writeFileSync(join(r, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    writeFileSync(join(r, 'b.txt'), 'b\n');
    const saved = GIT_TIMEOUT_MS.commit;
    GIT_TIMEOUT_MS.commit = 1500;
    try {
      const t0 = Date.now();
      await expect(snapshotCommit(r, 'snap')).rejects.toThrow(/git commit lỗi: quá 1\.5s/);
      expect(Date.now() - t0).toBeLessThan(10_000);
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
});
