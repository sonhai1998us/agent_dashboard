import { describe, it, expect } from 'vitest';
import { CAPTURE_TOOL, checkTool, hookCommand, matchGlob, type GuardPolicy } from '@/src/guard/policy';
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
    expect(checkTool(qc, 'Bash', { command: 'git diff --output=C:\\x.txt' }, root)).toMatchObject({ allow: false, reason: expect.stringMatching(/^\[acctv-guard\] vai qc chỉ chạy lệnh kiểm tra/) });
    expect(checkTool(qc, 'Bash', { command: 'git diff' }, root).allow).toBe(true);
    expect(checkTool(qc, 'Bash', { command: 'cat C:\\secret' }, root).allow).toBe(false);
    expect(checkTool(qc, 'Bash', { command: 'ls ..' }, root).allow).toBe(false);
  });
  it('capture: dev/designer/qc được, explorer không; designer đọc Figma và ToolSearch như explorer', () => {
    for (const r of ['dev', 'designer', 'qc'] as const) expect(checkTool(mk(r), CAPTURE_TOOL, {}, root), r).toEqual({ allow: true });
    expect(checkTool(mk('explorer'), CAPTURE_TOOL, {}, root).allow).toBe(false);
    expect(checkTool(mk('designer'), 'mcp__figma__get_design_context', {}, root)).toEqual({ allow: true, explicit: true });
    expect(checkTool(mk('designer'), 'mcp__figma__use_figma', {}, root).allow).toBe(false);
    expect(checkTool(mk('qc'), 'mcp__figma__get_design_context', {}, root).allow).toBe(false);
    expect(checkTool(mk('designer'), 'ToolSearch', {}, root)).toEqual({ allow: true, explicit: true });
    expect(checkTool(mk('qc'), 'ToolSearch', {}, root).allow).toBe(false);
    expect(CAPTURE_TOOL).toBe('mcp__acctv__capture');
  });
  it('qc/designer: lý do chặn nêu mẫu lệnh được phép và nhắc dùng Read/Grep/Glob', () => {
    for (const r of ['qc', 'designer'] as const) {
      const d = checkTool(mk(r), 'Bash', { command: 'git grep foo' }, root) as { allow: false; reason: string };
      expect(d.reason.startsWith(`[acctv-guard] vai ${r} chỉ chạy lệnh kiểm tra`)).toBe(true);
      expect(d.reason).toContain('`git (status|diff|log|show)`');
      expect(d.reason).toContain('`npx (tsc|vitest|jest|eslint|playwright|prettier --check)`');
      expect(d.reason).toMatch(/Read, Grep, Glob/);
      expect(d.reason).not.toContain('\\b');
      expect(d.reason).not.toContain('\\s');
    }
  });
  it('qc: lệnh nối bị chặn được báo rõ là do nối lệnh', () => {
    const d = checkTool(mk('qc'), 'Bash', { command: 'npm test | tee x' }, root) as { allow: false; reason: string };
    expect(d.reason).toMatch(/không nối lệnh/);
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
    for (const r of ['qc', 'designer'] as Role[]) {
      expect(checkTool(mk(r), 'Edit', { file_path: 'README.md' }, root)).toMatchObject({ allow: false, reason: `[acctv-guard] vai ${r} chỉ được đọc` });
    }
  });
  it('Glob: \\ cũng là dấu phân cách khi kiểm .. và đường dẫn tuyệt đối', () => {
    expect(checkTool(dev, 'Glob', { pattern: '..\\..\\x' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Glob', { pattern: 'src\\..\\..\\x' }, root).allow).toBe(false);
    expect(checkTool(dev, 'Glob', { pattern: '\\Users\\**' }, root).allow).toBe(false);
  });
  it('dev không dùng được mcp của dashboard hay tool lạ', () => {
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

describe('denyBash cannot stall the server (ReDoS)', () => {
  const bash = (command: string) => checkTool(mk('dev'), 'Bash', { command }, root);
  const timed = (command: string) => {
    const t0 = performance.now();
    const d = bash(command);
    return { d, ms: performance.now() - t0 };
  };
  it.each([
    ['many --opt before a harmless subcommand', 'git' + ' --no-pager'.repeat(2500) + ' log'],
    ['many --a=b', 'git' + ' --a=b'.repeat(3000) + ' log'],
    ['-C followed by dash-values', 'git' + ' -C -a'.repeat(3000) + ' log'],
    ['-C with quoted values', 'git' + ' -C "a"'.repeat(3000) + ' log'],
    ['--git-dir followed by dash-values', 'git' + ' --git-dir --x'.repeat(2000) + ' log'],
  ])('%s stays fast and allowed', (_n, cmd) => {
    const { d, ms } = timed(cmd);
    expect(d.allow).toBe(true);
    expect(ms).toBeLessThan(500);
  });
  it('still denies the forbidden subcommand after many options', () => {
    const { d, ms } = timed('git' + ' --no-pager'.repeat(2500) + ' push');
    expect(d.allow).toBe(false);
    expect(ms).toBeLessThan(500);
  });
  it('a command over the length cap is denied without running the rules', () => {
    const { d, ms } = timed('npm '.repeat(32000));
    expect(d).toMatchObject({ allow: false });
    expect((d as { reason: string }).reason).toMatch(/quá dài/);
    expect(ms).toBeLessThan(100);
  });
  it('a long but normal command under the cap is still checked', () => {
    expect(bash('echo ' + 'a'.repeat(30000)).allow).toBe(true);
  });
});

describe('Bash chạy nền bị chặn cho worker', () => {
  it.each(['dev', 'designer', 'qc'] as const)('%s: run_in_background=true bị từ chối, lệnh thường vẫn qua', (role) => {
    const d = checkTool(mk(role), 'Bash', { command: 'npm test', run_in_background: true }, root);
    expect(d).toMatchObject({ allow: false, scope: false });
    expect((d as { reason: string }).reason).toMatch(/^\[acctv-guard\] không chạy lệnh nền/);
    expect(checkTool(mk(role), 'Bash', { command: 'npm test', run_in_background: false }, root).allow).toBe(true);
    expect(checkTool(mk(role), 'Bash', { command: 'npm test' }, root).allow).toBe(true);
  });
  it('giá trị không phải true (chuỗi "true") cũng bị chặn để không lách bằng kiểu dữ liệu', () => {
    expect(checkTool(mk('dev'), 'Bash', { command: 'npm test', run_in_background: 'true' }, root).allow).toBe(false);
  });
});

describe('python đọc script từ stdin hoặc mở REPL bị chặn (python 3.14 trên Windows treo khi stdin rỗng)', () => {
  const blocked = [
    "python3 - <<'EOF' 2>/dev/null || node -e \"\nconsole.log(1)\n\"\nEOF",
    'python -',
    'python3 -u - < script.py',
    'python3 <<EOF\nprint(1)\nEOF',
    'python < x.py',
    'cat x.py | python3',
    'cat x.py | python3 -',
    'python',
    'python3 -i',
    'py',
    'py -3 -',
    'npm test && python3',
    'C:/Python/python.exe -',
    'python.exe',
    'python3.14 -',
    'FOO=1 python3 -',
    'echo hi; python3 -',
  ];
  const allowed = [
    'python3 script.py',
    'python -c "print(1)"',
    'python3 -m pytest -q',
    'python3 --version',
    'python3 -u tools/gen.py < input.txt',
    'cat data.json | python3 -m json.tool',
    'echo python',
    'grep -r python src',
    'npm run python-build',
    'node -e "console.log(1)"',
  ];
  it.each(['dev', 'qc', 'controller'] as const)('%s: các dạng treo bị chặn kèm hướng dẫn', (role) => {
    for (const command of blocked) {
      const d = checkTool(mk(role), 'Bash', { command }, root);
      expect(d, command).toMatchObject({ allow: false, scope: false });
      expect((d as { reason: string }).reason, command).toMatch(/^\[acctv-guard\] python đọc script từ stdin/);
    }
  });
  it('dev: các dạng có script, -c, -m vẫn chạy được', () => {
    for (const command of allowed) expect(checkTool(mk('dev'), 'Bash', { command }, root).allow, command).toBe(true);
  });
  it('controller: PowerShell cũng bị chặn', () => {
    expect(checkTool(mk('controller'), 'PowerShell', { command: 'python -' }, root).allow).toBe(false);
    expect(checkTool(mk('controller'), 'PowerShell', { command: 'python -c "print(1)"' }, root).allow).toBe(true);
  });
});

describe('thư mục nháp của worker', () => {
  const scratch = WIN ? 'C:\\h\\runs\\T-1\\dev-1\\scratch' : '/h/runs/T-1/dev-1/scratch';
  const tmp = WIN ? 'C:\\Users\\me\\AppData\\Local\\Temp\\x.png' : '/tmp/x.png';
  const withScratch = (role: Role): GuardPolicy => ({ ...mk(role), readRoots: [scratch], scratch });
  const inS = `${scratch}${sep}stills${sep}f000.png`;
  it('dev đọc và ghi được trong thư mục nháp', () => {
    expect(checkTool(withScratch('dev'), 'Read', { file_path: inS }, root).allow).toBe(true);
    expect(checkTool(withScratch('dev'), 'Write', { file_path: inS }, root).allow).toBe(true);
    expect(checkTool(withScratch('dev'), 'Edit', { file_path: `${scratch}${sep}tmp.mjs` }, root).allow).toBe(true);
  });
  it('vai chỉ đọc: đọc được, không ghi được', () => {
    expect(checkTool(withScratch('qc'), 'Read', { file_path: inS }, root).allow).toBe(true);
    expect(checkTool(withScratch('qc'), 'Write', { file_path: inS }, root).allow).toBe(false);
  });
  it('chặn ngoài phạm vi thì chỉ tới thư mục nháp', () => {
    const r = checkTool(withScratch('dev'), 'Read', { file_path: tmp }, root);
    expect(r.allow).toBe(false);
    expect((r as { reason: string }).reason).toContain(`thư mục nháp ${scratch}`);
    const w = checkTool(withScratch('dev'), 'Write', { file_path: tmp }, root);
    expect(w).toMatchObject({ allow: false, scope: true });
    expect((w as { reason: string }).reason).toContain(`thư mục nháp ${scratch}`);
    // ghi file nằm trong worktree nhưng ngoài phạm vi: vẫn bị chặn như cũ
    expect(checkTool(withScratch('dev'), 'Write', { file_path: `${root}${sep}src${sep}x.ts` }, root).allow).toBe(false);
  });
  it('không có thư mục nháp: lý do giữ như cũ', () => {
    const r = checkTool(mk('dev'), 'Read', { file_path: tmp }, root);
    expect((r as { reason: string }).reason).not.toContain('thư mục nháp');
  });
});

describe('checkTool: controller có quyền như người dùng', () => {
  const home = WIN ? String.raw`C:\Users\me\.acctv` : '/home/me/.acctv';
  const claude = WIN ? String.raw`C:\Users\me\.claude` : '/home/me/.claude';
  const other = WIN ? String.raw`E:\khac\a.txt` : '/tmp/a.txt';
  const c: GuardPolicy = { ...mk('controller'), protectedRoots: [home, claude] };
  const ok = (tool: string, input: unknown) => expect(checkTool(c, tool, input, root)).toEqual({ allow: true });
  const no = (tool: string, input: unknown, re: RegExp) => {
    const d = checkTool(c, tool, input, root);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(re);
  };
  it('đọc, chạy lệnh, MCP của người dùng, web, subagent', () => {
    ok('Read', { file_path: other });
    ok('Glob', { pattern: WIN ? String.raw`C:\**` : '/**' });
    ok('Bash', { command: 'twg jira issue get US-5039 -o json' });
    ok('PowerShell', { command: 'Get-ChildItem' });
    ok('mcp__figma__get_design_context', { nodeId: '1:2' });
    ok('mcp__acctv__propose_plan', {});
    ok('WebFetch', { url: 'https://example.com' });
    ok('Agent', { prompt: 'x' });
  });
  it.runIf(process.platform === 'darwin')('darwin: thư mục được bảo vệ không phân biệt hoa thường', () => {
    no('Write', { file_path: '/home/me/.CLAUDE/settings.json' }, /được bảo vệ/);
    no('Edit', { file_path: '/HOME/me/.acctv/config.json' }, /được bảo vệ/);
  });
  it('ghi file ngoài thư mục được bảo vệ', () => {
    ok('Write', { file_path: 'notes.md' });
    ok('Edit', { file_path: other });
  });
  it('cấm commit/push và lệnh trong denyBash, cả qua PowerShell', () => {
    no('Bash', { command: 'git commit -m x' }, /lệnh bị cấm/);
    no('Bash', { command: 'git -C ../x push origin main' }, /lệnh bị cấm/);
    no('PowerShell', { command: 'git.exe push' }, /lệnh bị cấm/);
    no('Bash', { command: 'curl -X POST http://127.0.0.1:4777/api/tickets/T-1/approve' }, /lệnh bị cấm/);
    no('Bash', { command: 'twg login', run_in_background: true }, /lệnh nền/);
    no('Bash', { command: 'x'.repeat(40_000) }, /quá dài/);
  });
  it('cấm ghi vào .git, dữ liệu dashboard, ~/.claude', () => {
    no('Write', { file_path: '.git/config' }, /\.git/);
    no('Edit', { file_path: `${home}${sep}acctv.db` }, /bảo vệ/);
    no('Write', { file_path: `${WIN ? claude.toUpperCase() : claude}${sep}settings.json` }, /bảo vệ/);
    no('Write', {}, /thiếu đường dẫn/);
  });
  it('cấm tool MCP commit/push/merge và tool đổi worktree', () => {
    no('mcp__github__push_files', {}, /commit\/push/);
    no('mcp__github__create_or_update_file', {}, /commit\/push/);
    no('mcp__github__merge_pull_request', {}, /commit\/push/);
    no('mcp__gitlab__create_commit', {}, /commit\/push/);
    no('EnterWorktree', {}, /worktree/);
    ok('mcp__github__get_pull_request', {});
  });
});
