import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as proc from '@/src/runner/proc';
import { createClaudeRunner } from '@/src/runner/claude';
import type { RunSpec, RunSink } from '@/src/runner/types';
import type { NormalizedEvent } from '@/src/core/model';

vi.mock('@/src/runner/proc', async (orig) => {
  const m = await orig<typeof import('@/src/runner/proc')>();
  return { ...m, killTree: vi.fn(m.killTree) };
});

afterEach(() => { delete process.env.FAKE_CLAUDE_SCRIPT; delete process.env.FAKE_CLAUDE_LOG; delete process.env.FAKE_CLAUDE_CHILD_PID; });

const fake = path.resolve('tests/fixtures/fake-claude.mjs');
const guardScript = path.resolve('bin/acctv-guard.mjs');
const streamLines = readFileSync('tests/fixtures/claude/stream.jsonl', 'utf8').split('\n').filter(Boolean);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function setup(script: unknown) {
  // realpath: trên macOS tmpdir là /var/… nhưng tiến trình con thấy cwd thật /private/var/…
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'acctv-run-')));
  const cwd = path.join(root, 'dự án có dấu cách');
  mkdirSync(cwd);
  const scriptFile = path.join(root, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(root, 'log.jsonl');
  process.env.FAKE_CLAUDE_SCRIPT = scriptFile;
  process.env.FAKE_CLAUDE_LOG = log;
  const spec: RunSpec = {
    agentId: 'acctv:T-1:dev-1', ticketId: 'T-1', role: 'dev', agent: 'claude', label: 'Dev 1', parentId: null,
    cwd, model: 'claude-sonnet-5-5', effort: 'high', prompt: 'làm việc đi\nxin chào', systemPrompt: 'ROLE: dev\nbạn là dev',
    sessionId: '22222222-2222-4222-8222-222222222222', resume: false, tools: ['Read', 'Edit'], allowedTools: ['Read'],
    addDirs: [], runDir: path.join(root, 'run'), mcp: null, guard: { port: 1, token: 'tok' },
  };
  const events: NormalizedEvent[] = [];
  const limits: boolean[] = [];
  const sink: RunSink = { events: (e) => events.push(...e), limited: (b) => limits.push(b) };
  const runner = createClaudeRunner({ command: process.execPath, prefixArgs: [fake], guardScript });
  return { spec, sink, events, limits, runner, log, root, cwd };
}

describe('createClaudeRunner', () => {
  it('replays a stream, parses it and records argv/stdin/cwd', async () => {
    const steps = streamLines.map((l) => { try { return { emit: JSON.parse(l) }; } catch { return { raw: l }; } });
    const s = setup({ '*': [{ steps }] });
    const h = s.runner(s.spec, s.sink);
    const r = await h.done;
    expect(r.costUsd).toBe(0.0123);
    expect(r.isError).toBe(false);
    expect(r.killed).toBe(false);
    expect(r.text).toBe('Done');
    expect(r.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(r.changedFiles).toEqual(['src/a.ts']);
    expect(s.events.some((e) => e.type === 'call_start' && e.call.id === 'tu1')).toBe(true);
    expect(s.events.filter((e) => e.type === 'parse_error')).toHaveLength(1);
    expect(s.limits).toContain(true);
    const rec = JSON.parse(readFileSync(s.log, 'utf8').trim().split('\n')[0]);
    expect(rec.argv).toContain('--session-id');
    expect(rec.stdin).toBe(s.spec.prompt);
    expect(path.resolve(rec.cwd).toLowerCase()).toBe(path.resolve(s.cwd).toLowerCase());
  }, 30000);

  it('kill() ends a sleeping run with killed=true', async () => {
    const s = setup({ '*': [{ steps: [{ sleep: 60000 }] }] });
    const h = s.runner(s.spec, s.sink);
    await new Promise((r) => setTimeout(r, 1500));
    const t = Date.now();
    await h.kill();
    const r = await h.done;
    expect(r.killed).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
  }, 30000);

  it('kill() also kills a grandchild', async () => {
    const s = setup({ '*': [{ steps: [{ spawnChild: true }, { sleep: 60000 }] }] });
    const pidFile = path.join(s.root, 'child.pid');
    process.env.FAKE_CLAUDE_CHILD_PID = pidFile;
    const h = s.runner(s.spec, s.sink);
    const t = Date.now();
    while (Date.now() - t < 15000 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8'))) await new Promise((r) => setTimeout(r, 50));
    const child = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(child)).toBe(true);
    await h.kill();
    await h.done;
    const t2 = Date.now();
    while (Date.now() - t2 < 5000 && alive(child)) await new Promise((r) => setTimeout(r, 50));
    expect(alive(child)).toBe(false);
  }, 40000);

  it('đã có result mà tiến trình không thoát (cháu treo): dọn cả cây, kết quả vẫn thành công', async () => {
    const result = JSON.parse(streamLines.find((l) => l.includes('"type":"result"'))!);
    const s = setup({ '*': [{ steps: [{ spawnChild: true }, { emit: result }, { sleep: 60000 }] }] });
    const pidFile = path.join(s.root, 'child.pid');
    process.env.FAKE_CLAUDE_CHILD_PID = pidFile;
    const runner = createClaudeRunner({ command: process.execPath, prefixArgs: [fake], guardScript, reapAfterResultMs: 300 });
    const t = Date.now();
    const r = await runner(s.spec, s.sink).done;
    expect(Date.now() - t).toBeLessThan(15000);
    expect(r).toMatchObject({ isError: false, killed: false, exitCode: 0, text: 'Done', costUsd: 0.0123 });
    const child = Number(readFileSync(pidFile, 'utf8'));
    const t2 = Date.now();
    while (Date.now() - t2 < 5000 && alive(child)) await new Promise((res) => setTimeout(res, 50));
    expect(alive(child)).toBe(false);
  }, 40000);

  it('kill() trong lúc chờ dọn sau result vẫn là killed', async () => {
    const result = JSON.parse(streamLines.find((l) => l.includes('"type":"result"'))!);
    const s = setup({ '*': [{ steps: [{ emit: result }, { sleep: 60000 }] }] });
    const runner = createClaudeRunner({ command: process.execPath, prefixArgs: [fake], guardScript, reapAfterResultMs: 60000 });
    const h = runner(s.spec, s.sink);
    const t = Date.now();
    while (Date.now() - t < 10000 && !s.events.some((e) => e.type === 'call_end' || e.type === 'agent')) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 1000));
    await h.kill();
    expect(await h.done).toMatchObject({ killed: true, text: 'Done' });
  }, 30000);

  it('xong lượt: đọc lại transcript để lấy token ra cuối cùng và phần cache của từng message', async () => {
    const steps = streamLines.map((l) => { try { return { emit: JSON.parse(l) }; } catch { return { raw: l }; } });
    const s = setup({ '*': [{ steps }] });
    const claudeDir = path.join(s.root, 'claude');
    const proj = path.join(claudeDir, 'projects', 'D--du-an');
    mkdirSync(proj, { recursive: true });
    const u = (out: number) => ({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: out });
    writeFileSync(path.join(proj, '11111111-1111-4111-8111-111111111111.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: u(333) } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_3', usage: u(77) } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_khac', usage: u(9) } }), // không có trong lượt này: bỏ qua
    ].join('\n'));
    const runner = createClaudeRunner({ command: process.execPath, prefixArgs: [fake], guardScript, claudeDir });
    await runner(s.spec, s.sink).done;
    const llm = s.events.filter((e): e is Extract<NormalizedEvent, { type: 'call_start' }> => e.type === 'call_start' && e.call.kind === 'llm');
    const last = (id: string) => llm.filter((e) => e.call.id === id).at(-1)!.call;
    expect(last('msg_1')).toMatchObject({ tokensIn: 5102, tokensOut: 333, cacheRead: 5000, cacheWrite: 100, agentId: s.spec.agentId });
    expect(last('msg_3')).toMatchObject({ tokensOut: 77 });
    expect(last('msg_2')).toMatchObject({ tokensOut: 10 }); // không có trong transcript: giữ số của stream
    expect(llm.some((e) => e.call.id === 'msg_khac')).toBe(false);
  }, 30000);

  it('exit 3 without result is an error with stderr as text', async () => {
    const s = setup({ '*': [{ steps: [{ stderr: 'boom: không chạy được' }, { exit: 3 }] }] });
    const r = await s.runner(s.spec, s.sink).done;
    expect(r.isError).toBe(true);
    expect(r.exitCode).toBe(3);
    expect(r.text).toBe('boom: không chạy được');
  }, 30000);

  it('runs the settings.json guard hook through a shell', async () => {
    const s = setup({ '*': [{ steps: [{ hook: { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: 'x' } }] }] });
    const r = await s.runner(s.spec, s.sink).done;
    expect(r.isError).toBe(false);
    const end = s.events.find((e) => e.type === 'call_end');
    expect(end).toMatchObject({ ok: false });
  }, 30000);

  it('kill() after exit does not call killTree', async () => {
    const s = setup({ '*': [{ steps: [] }] });
    const h = s.runner(s.spec, s.sink);
    await h.done;
    vi.mocked(proc.killTree).mockClear();
    await h.kill();
    expect(proc.killTree).not.toHaveBeenCalled();
    expect((await h.done).killed).toBe(false);
  }, 30000);

  it('a nonexistent command resolves as an error result without throwing', async () => {
    const s = setup({});
    const runner = createClaudeRunner({ command: path.join(s.root, 'khong-co', 'claude.exe'), guardScript });
    const r = await runner(s.spec, s.sink).done;
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  }, 30000);

  it('a command that throws synchronously on spawn resolves as an error result', async () => {
    const s = setup({});
    const cmd = path.join(s.root, 'x.cmd');
    writeFileSync(cmd, '@echo hi');
    const r = await createClaudeRunner({ command: cmd, guardScript })(s.spec, s.sink).done;
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  }, 30000);
});
