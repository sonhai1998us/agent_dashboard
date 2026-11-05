import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCodexArgs, parseCodexExecLine, createCodexRunner } from '@/src/runner/codex';
import type { RunSpec, RunSink } from '@/src/runner/types';
import type { NormalizedEvent } from '@/src/core/model';

const lines = readFileSync('tests/fixtures/codex/exec.jsonl', 'utf8').split('\n').filter(Boolean);
const fake = path.resolve('tests/fixtures/fake-codex.mjs');

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  agentId: 'acctv:T-1:qc-1', ticketId: 'T-1', role: 'qc', agent: 'codex', label: 'qc', parentId: null,
  cwd: 'D:\\Dự án\\my app', model: 'gpt-5-codex', effort: 'high', prompt: 'làm đi', systemPrompt: '', sessionId: 'thr-1', resume: false,
  tools: [], allowedTools: [], addDirs: [], runDir: '', mcp: null, guard: { port: 1, token: 't' }, ...o,
});

describe('parseCodexExecLine', () => {
  it('ánh xạ fixture', () => {
    const ctx = { agentId: 'a', open: new Map<string, number>(), changedFiles: new Set<string>() };
    const evs: NormalizedEvent[] = [];
    let sid: string | undefined;
    let text = '';
    lines.forEach((l, i) => {
      const o = parseCodexExecLine(l, ctx, 1000 + i);
      evs.push(...o.events);
      if (o.sessionId) sid = o.sessionId;
      if (o.result) text = o.result.text;
    });
    expect(sid).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
    const starts = evs.flatMap((e) => (e.type === 'call_start' ? [e.call] : []));
    const ends = evs.flatMap((e) => (e.type === 'call_end' ? [e] : []));
    expect(starts.filter((c) => c.name === 'Bash')).toHaveLength(2);
    expect(starts.filter((c) => c.name === 'Edit')).toHaveLength(1);
    const llm = starts.filter((c) => c.kind === 'llm');
    expect(llm).toHaveLength(1);
    expect([llm[0].tokensIn, llm[0].tokensOut]).toEqual([150, 20]);
    const bash = starts.filter((c) => c.name === 'Bash').map((c) => ends.find((e) => e.callId === c.id)!.ok);
    expect(bash).toEqual([true, false]);
    expect([...ctx.changedFiles]).toEqual(['src/a.ts']);
    expect(ctx.open.size).toBe(0);
    expect(text).toBe('Đã sửa xong src/a.ts');
  });
  it('turn.failed và rate limit', () => {
    const ctx = { agentId: 'a', open: new Map<string, number>() };
    const o = parseCodexExecLine('{"type":"turn.failed","error":{"message":"429 rate limit"}}', ctx, 1);
    expect(o.result).toMatchObject({ isError: true, rateLimited: true });
    expect(o.limited).toBe(true);
    expect(parseCodexExecLine('rác', ctx, 1).events).toEqual([{ type: 'parse_error', agentId: 'a' }]);
  });
});

describe('buildCodexArgs', () => {
  it('resume, sandbox theo vai, không cờ nguy hiểm', () => {
    const a = buildCodexArgs(spec({ resume: true, sessionId: 'abc', addDirs: ['D:\\x'] }));
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', 'abc']);
    expect(a.join(' ')).toContain('--sandbox read-only');
    expect(a.at(-1)).toBe('-');
    expect(a.some((x) => /dangerously|bypass/i.test(x))).toBe(false);
    expect(buildCodexArgs(spec({ role: 'dev' }))).toContain('workspace-write');
    expect(buildCodexArgs(spec({ role: 'dev' })).slice(0, 2)).toEqual(['exec', '--json']);
  });
});

describe('createCodexRunner', () => {
  it('chạy script giả, ra agent_message và đăng ký thread id', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'acctv-cdx-'));
    mkdirSync(path.join(cwd, 'x y'));
    const got: NormalizedEvent[] = [];
    const sink: RunSink = { events: (e) => got.push(...e), limited: () => {} };
    const h = createCodexRunner({ command: process.execPath, prefixArgs: [fake] })(spec({ cwd: path.join(cwd, 'x y') }), sink);
    const r = await h.done;
    expect(r).toMatchObject({ exitCode: 0, isError: false, text: 'Đã sửa xong src/a.ts', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53', changedFiles: ['src/a.ts'] });
    expect(got.find((e) => e.type === 'agent')).toMatchObject({ agent: { id: 'acctv:T-1:qc-1', source: 'codex' } });
  });

  const sink = (): RunSink => ({ events: () => {}, limited: () => {} });
  const fixture = (recs: unknown[]) => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'acctv-cdx-')), 'f.jsonl');
    writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    process.env.FAKE_CODEX_FIXTURE = f;
  };
  const run = (o: Partial<RunSpec> = {}) => createCodexRunner({ command: process.execPath, prefixArgs: [fake] })(spec({ cwd: tmpdir(), ...o }), sink());
  afterEach(() => { delete process.env.FAKE_CODEX_FIXTURE; delete process.env.FAKE_CODEX_SLEEP; });

  it('error không chí mạng rồi turn.completed, exit 0 -> thành công', async () => {
    fixture([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'Reconnecting...' },
      { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'xong' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    expect(await run().done).toMatchObject({ isError: false, text: 'xong' });
  });
  it('turn.failed luôn là lỗi', async () => {
    fixture([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.failed', error: { message: 'hỏng' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    expect(await run().done).toMatchObject({ isError: true, text: 'hỏng' });
  });
  it('file_change lỗi không vào changedFiles', async () => {
    fixture([
      { type: 'item.started', item: { id: 'i', type: 'file_change', changes: [{ path: 'src/b.ts', kind: 'update' }], status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i', type: 'file_change', changes: [{ path: 'src/b.ts', kind: 'update' }], status: 'failed' } },
    ]);
    const got: NormalizedEvent[] = [];
    const r = await createCodexRunner({ command: process.execPath, prefixArgs: [fake] })(spec({ cwd: tmpdir() }), { events: (e) => got.push(...e), limited: () => {} }).done;
    expect(r.changedFiles).toEqual([]);
    expect(got.find((e) => e.type === 'call_end')).toMatchObject({ ok: false });
  });
  it('spawn lỗi -> kết quả isError, không throw', async () => {
    const h = createCodexRunner({ command: path.join(tmpdir(), 'không-có-codex.exe') })(spec({ cwd: tmpdir() }), sink());
    expect(await h.done).toMatchObject({ isError: true });
  });
  it('kill() dừng script đang ngủ', async () => {
    process.env.FAKE_CODEX_SLEEP = '30000';
    const h = run();
    await new Promise((r) => setTimeout(r, 500));
    await h.kill();
    expect(await h.done).toMatchObject({ killed: true });
  });
});
