import { describe, it, expect } from 'vitest';
import { checkTool, hookCommand, matchGlob, type GuardPolicy } from '@/src/guard/policy';
import { DEFAULT_SETTINGS } from '@/src/core/config';
import type { Role } from '@/src/tickets/model';

const WIN = process.platform === 'win32';
const root = WIN ? 'D:\\Work\\wt' : '/work/wt';
const sep = WIN ? '\\' : '/';
const mk = (role: Role): GuardPolicy => ({
  role,
  root,
  readRoots: [],
  allowedFiles: ['src/login/**', 'README.md'],
  denyBash: DEFAULT_SETTINGS.denyBash.map((s) => new RegExp(s, 'i')),
  checkCommands: DEFAULT_SETTINGS.checkCommands.map((s) => new RegExp(s, 'i')),
});

describe('matchGlob', () => {
  it('? matches one non-slash char', () => {
    expect(matchGlob('a?c.ts', 'abc.ts')).toBe(true);
    expect(matchGlob('a?c.ts', 'a/c.ts')).toBe(false);
    expect(matchGlob('a?c.ts', 'ac.ts')).toBe(false);
  });
  it('**/ matches zero or more directories; * stays in a segment', () => {
    expect(matchGlob('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(matchGlob('src/**/x.ts', 'src/a/b/x.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/x.ts')).toBe(false);
    expect(matchGlob('src/**', 'src/a/b')).toBe(true);
  });
  it('regex metacharacters are literal', () => {
    expect(matchGlob('a.b', 'axb')).toBe(false);
    expect(matchGlob('a+b(1)', 'a+b(1)')).toBe(true);
    expect(matchGlob('a+b(1)', 'aab(1)')).toBe(false);
    expect(matchGlob('[x]$.ts', '[x]$.ts')).toBe(true);
  });
  it('is case-insensitive and treats backslash as slash', () => {
    expect(matchGlob('SRC\\Login\\**', 'src/login/A.ts')).toBe(true);
  });
});

describe('checkTool', () => {
  const dev = mk('dev');
  it('dev edit inside allowed glob', () => {
    expect(checkTool(dev, 'Edit', { file_path: `${root}${sep}src${sep}login${sep}a.ts` }, root).allow).toBe(true);
    expect(checkTool(dev, 'Write', { file_path: 'README.md' }, root).allow).toBe(true);
  });
  it('dev edit outside allowed files is a scope violation', () => {
    const d = checkTool(dev, 'Edit', { file_path: 'src/other.ts' }, root);
    expect(d).toMatchObject({ allow: false, scope: true });
    expect((d as { reason: string }).reason.startsWith('[acctv-guard] ngoài phạm vi:')).toBe(true);
  });
  it('.. escaping root is denied', () => {
    expect(checkTool(dev, 'Write', { file_path: `${root}${sep}..${sep}x.txt` }, root)).toMatchObject({ allow: false, scope: true });
    expect(checkTool(dev, 'Write', { file_path: '../x.txt' }, root)).toMatchObject({ allow: false, scope: true });
    expect(checkTool(dev, 'Write', { file_path: 'src/login/../../x.txt' }, root)).toMatchObject({ allow: false, scope: true });
  });
  it('relative paths resolve against the hook cwd', () => {
    const sub = `${root}${sep}src${sep}login`;
    expect(checkTool(dev, 'Edit', { file_path: 'a.ts' }, sub).allow).toBe(true);
    expect(checkTool(dev, 'Edit', { file_path: 'a.ts' }, root).allow).toBe(false);
  });
  it('root itself and missing path are not editable', () => {
    expect(checkTool(dev, 'Edit', { file_path: root }, root).allow).toBe(false);
    expect(checkTool(dev, 'Edit', {}, root).allow).toBe(false);
    expect(checkTool(dev, 'Edit', null, root).allow).toBe(false);
  });
  it('read outside root denied, inside allowed, readRoots honoured', () => {
    const out = WIN ? 'C:\\Users\\Admin\\.ssh\\id_rsa' : '/home/u/.ssh/id_rsa';
    expect(checkTool(dev, 'Read', { file_path: out }, root).allow).toBe(false);
    expect(checkTool(dev, 'Read', { file_path: 'src/a.ts' }, root).allow).toBe(true);
    expect(checkTool(dev, 'Grep', {}, root).allow).toBe(true);
    expect(checkTool(dev, 'Glob', { path: out }, root).allow).toBe(false);
    const ro = { ...dev, readRoots: [WIN ? 'C:\\Users\\Admin\\.ssh' : '/home/u/.ssh'] };
    expect(checkTool(ro, 'Read', { file_path: out }, root).allow).toBe(true);
  });
  it('sibling dir sharing the root prefix is outside root', () => {
    expect(checkTool(dev, 'Read', { file_path: `${root}2${sep}a.ts` }, root).allow).toBe(false);
  });
  it('bash: dev', () => {
    expect(checkTool(dev, 'Bash', { command: 'git commit -m x' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Bash', { command: 'npm test -- login' }, root).allow).toBe(true);
    expect(checkTool(dev, 'Bash', { command: 'npm test && git push' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Bash', {}, root).allow).toBe(false);
  });
  it('bash: git global options, git.exe and quotes do not bypass the deny rule', () => {
    for (const command of [
      'git -C . commit -m x', 'git -c user.name=x commit', 'git --no-pager push', 'git.exe push origin HEAD', '"git" push',
      'git -C "D:\\Dự án\\x" commit -m y', 'git --git-dir=.git --work-tree=. commit', "'git.exe' -c a=b --no-pager reset --hard",
    ]) expect(checkTool(dev, 'Bash', { command }, root), command).toMatchObject({ allow: false });
    for (const command of ['git status', 'git diff', 'git -C . log', 'git --no-pager diff --stat', 'npm test', 'npm install lodash']) {
      expect(checkTool(dev, 'Bash', { command }, root).allow, command).toBe(true);
    }
  });
  it('bash: global installs in any flag order are denied', () => {
    for (const command of [
      'npm -g i x', 'npm i -g x', 'npm install --location=global x', 'npm install --global x', 'pnpm add -g x', 'yarn global add x', 'bun add --global x',
    ]) expect(checkTool(dev, 'Bash', { command }, root), command).toMatchObject({ allow: false });
    expect(checkTool(dev, 'Bash', { command: 'npm install --save-dev vitest' }, root).allow).toBe(true);
  });
  it('bash: calling the dashboard API or MCP endpoint is denied', () => {
    for (const command of ['curl http://127.0.0.1:4777/api/tickets', 'curl -X POST localhost:4777/mcp?ticket=T-1', 'node -e "fetch(\'http://localhost/api/settings\')"']) {
      expect(checkTool(dev, 'Bash', { command }, root), command).toMatchObject({ allow: false });
    }
    expect(checkTool(dev, 'Bash', { command: 'curl http://127.0.0.1:3000/health' }, root).allow).toBe(true);
  });
  it('a glob-free allowed entry also covers everything under it as a directory', () => {
    const d = { ...dev, allowedFiles: ['src/components'] };
    expect(checkTool(d, 'Edit', { file_path: 'src/components/Button.tsx' }, root).allow).toBe(true);
    expect(checkTool(d, 'Edit', { file_path: 'src/components/ui/x/Deep.tsx' }, root).allow).toBe(true);
    expect(checkTool(d, 'Edit', { file_path: 'src/other.ts' }, root).allow).toBe(false);
    expect(checkTool(d, 'Edit', { file_path: 'src/components2/x.ts' }, root).allow).toBe(false);
    expect(checkTool({ ...dev, allowedFiles: ['src/*.ts'] }, 'Edit', { file_path: 'src/a.ts/b.ts' }, root).allow).toBe(false);
  });
  it('bash: qc/designer only run check commands, no chaining', () => {
    const qc = mk('qc');
    expect(checkTool(qc, 'Bash', { command: 'npm run build' }, root).allow).toBe(true);
    expect(checkTool(qc, 'Bash', { command: 'node scripts/x.js' }, root).allow).toBe(false);
    expect(checkTool(qc, 'Bash', { command: 'npm test; node evil.js' }, root).allow).toBe(false);
    expect(checkTool(qc, 'Bash', { command: 'npm test\nnode evil.js' }, root).allow).toBe(false);
    expect(checkTool(mk('designer'), 'Bash', { command: 'npm test | tee x' }, root).allow).toBe(false);
  });
  it('qc: --output denied, plain git diff and ls/cat not allowed', () => {
    const qc = mk('qc');
    expect(checkTool(qc, 'Bash', { command: 'git diff --output=C:\\x.txt' }, root)).toMatchObject({ allow: false, reason: '[acctv-guard] vai qc chỉ chạy lệnh kiểm tra' });
    expect(checkTool(qc, 'Bash', { command: 'git diff' }, root).allow).toBe(true);
    expect(checkTool(qc, 'Bash', { command: 'cat C:\\secret' }, root).allow).toBe(false);
    expect(checkTool(qc, 'Bash', { command: 'ls ..' }, root).allow).toBe(false);
  });
  it('.git paths are never editable, even with ** allowed', () => {
    const all = { ...dev, allowedFiles: ['**'] };
    expect(checkTool(all, 'Write', { file_path: '.git/hooks/pre-commit' }, root)).toMatchObject({ allow: false, scope: true, reason: '[acctv-guard] ngoài phạm vi: .git/hooks/pre-commit' });
    expect(checkTool(all, 'Edit', { file_path: 'sub/.GIT/config' }, root).allow).toBe(false);
    expect(checkTool(all, 'Edit', { file_path: 'src/a.ts' }, root).allow).toBe(true);
  });
  it('Glob pattern must not be absolute or contain ..', () => {
    const abs = WIN ? 'C:\\Users\\**' : '/home/**';
    expect(checkTool(dev, 'Glob', { pattern: abs }, root)).toMatchObject({ allow: false, reason: `[acctv-guard] ngoài thư mục làm việc: ${abs}` });
    expect(checkTool(dev, 'Glob', { pattern: '../**/*.ts' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Glob', { pattern: 'src/../../x' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Glob', { pattern: 'src/**/*.ts' }, root).allow).toBe(true);
  });
  it('read-only roles cannot edit', () => {
    for (const r of ['qc', 'designer', 'controller'] as Role[]) {
      expect(checkTool(mk(r), 'Edit', { file_path: 'README.md' }, root)).toMatchObject({ allow: false, reason: `[acctv-guard] vai ${r} chỉ được đọc` });
    }
  });
  it('controller: mcp allowed, bash denied; dev denied mcp and unknown tools', () => {
    const c = mk('controller');
    expect(checkTool(c, 'mcp__acctv__spawn_agent', {}, root).allow).toBe(true);
    expect(checkTool(c, 'Bash', { command: 'ls' }, root).allow).toBe(false);
    expect(checkTool(dev, 'mcp__acctv__spawn_agent', {}, root).allow).toBe(false);
    expect(checkTool(dev, 'WebFetch', {}, root)).toMatchObject({ allow: false, reason: '[acctv-guard] tool WebFetch không được phép cho vai dev' });
  });
  it.runIf(WIN)('win32: case, slashes and drives', () => {
    expect(checkTool(dev, 'Edit', { file_path: 'd:/work/WT/src/login/a.ts' }, root).allow).toBe(true);
    expect(checkTool(dev, 'Edit', { file_path: 'D:\\WORK\\wt\\SRC\\LOGIN\\a.ts' }, root).allow).toBe(true);
    expect(checkTool(dev, 'Edit', { file_path: 'E:\\Work\\wt\\src\\login\\a.ts' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Edit', { file_path: 'readme.MD' }, root).allow).toBe(true);
  });
});

describe('hookCommand', () => {
  it('quotes both paths', () => {
    expect(hookCommand('C:\\Program Files\\nodejs\\node.exe', 'D:\\Dự án\\bin\\acctv-guard.mjs', 4777, 'a', 't')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\Dự án\\bin\\acctv-guard.mjs" 4777 a t',
    );
  });
});
