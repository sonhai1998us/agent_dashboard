import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { codexCtxForPath, parseCodexLine, type CodexFileCtx } from '@/src/adapters/codex/parse';
import type { NormalizedEvent } from '@/src/core/model';

const lines = readFileSync('tests/fixtures/codex/rollout.jsonl', 'utf8').split('\n').filter(Boolean);
const UUID = '019e5947-01fe-7393-b890-65ac89a98961';
const freshCtx = (): CodexFileCtx => ({ agentId: null, lastTs: null, turnOpen: false, resumed: false });

function run(ls = lines, ctx: CodexFileCtx = freshCtx()) {
  const ev: NormalizedEvent[] = [];
  for (const l of ls) ev.push(...parseCodexLine(l, ctx));
  return { ctx, ev };
}
const T = (s: string) => Date.parse(s);

describe('codex parser', () => {
  test('function_call + output Exit code: 1 → ok=false', () => {
    const { ev } = run();
    const s = ev.find((e) => e.type === 'call_start' && e.call.id === 'call_1') as any;
    expect(s.call.name).toBe('shell_command');
    expect(s.call.kind).toBe('tool');
    expect(s.call.inputHash).toHaveLength(12);
    const e = ev.find((x) => x.type === 'call_end' && x.callId === 'call_1') as any;
    expect(e.ok).toBe(false);
    expect(e.errorPreview).toContain('FAIL suite');
  });

  test('custom_tool_call apply_patch → ok=true', () => {
    const { ev } = run();
    const s = ev.find((e) => e.type === 'call_start' && e.call.id === 'call_2') as any;
    expect(s.call.name).toBe('apply_patch');
    const e = ev.find((x) => x.type === 'call_end' && x.callId === 'call_2') as any;
    expect(e.ok).toBe(true);
    expect(e.errorPreview).toBeNull();
  });

  test('output không có Exit code → ok=true', () => {
    const ctx = freshCtx();
    ctx.agentId = 'codex:x';
    const ev = parseCodexLine(
      '{"timestamp":"2026-05-24T09:00:00Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"hello"}}',
      ctx,
    );
    expect((ev.find((e) => e.type === 'call_end') as any).ok).toBe(true);
  });

  test('session_meta parent_thread_id → parentId', () => {
    const { ev, ctx } = run();
    expect(ctx.agentId).toBe(`codex:${UUID}`);
    const a = ev.find((e) => e.type === 'agent') as any;
    expect(a.agent).toMatchObject({
      id: `codex:${UUID}`, source: 'codex', sessionId: UUID,
      parentId: 'codex:019e5900-0000-7000-8000-000000000001',
      cwd: 'C:\\Work\\demo-app', label: 'demo-app', startedAt: T('2026-05-24T09:18:10.000Z'),
    });
  });

  test('thread_settings_applied → model, turn_context → effort', () => {
    const { ev } = run();
    const agents = ev.filter((e) => e.type === 'agent').map((e: any) => e.agent);
    expect(agents.some((a) => a.model === 'gpt-test-1')).toBe(true);
    expect(agents.some((a) => a.effort === 'high')).toBe(true);
  });

  test('token_usage_record → llm call với tokens', () => {
    const { ev } = run();
    const s = ev.find((e) => e.type === 'call_start' && e.call.kind === 'llm') as any;
    expect(s.call).toMatchObject({ id: 'resp_1', tokensIn: 120, tokensOut: 45, name: 'gpt-test-1' });
    expect(s.call.startedAt).toBe(T('2026-05-24T09:18:18.000Z'));
    const e = ev.find((x) => x.type === 'call_end' && x.callId === 'resp_1') as any;
    expect(e.ok).toBe(true);
    expect(e.endedAt).toBe(T('2026-05-24T09:18:19.000Z'));
  });

  test('dòng hỏng → parse_error, không ném lỗi', () => {
    const ctx = freshCtx();
    ctx.agentId = `codex:${UUID}`;
    expect(parseCodexLine('{nope', ctx)).toEqual([{ type: 'parse_error', agentId: `codex:${UUID}` }]);
    const { ev } = run();
    expect(ev.filter((e) => e.type === 'parse_error')).toHaveLength(1);
  });

  test('task_started/task_complete cập nhật turnOpen; task_complete → activity', () => {
    const ctx = freshCtx();
    ctx.agentId = 'codex:x';
    const l = (t: string) => `{"timestamp":"2026-05-24T09:00:00Z","type":"event_msg","payload":{"type":"${t}"}}`;
    parseCodexLine(l('task_started'), ctx);
    expect(ctx.turnOpen).toBe(true);
    const ev = parseCodexLine(l('task_complete'), ctx);
    expect(ctx.turnOpen).toBe(false);
    expect(ev.some((e) => e.type === 'activity')).toBe(true);
    parseCodexLine(l('task_started'), ctx);
    parseCodexLine(l('turn_aborted'), ctx);
    expect(ctx.turnOpen).toBe(false);
  });

  test('dòng trước session_meta (agentId null) bị bỏ qua', () => {
    const ctx = freshCtx();
    expect(parseCodexLine(lines[1], ctx)).toEqual([]);
  });

  test('codexCtxForPath lấy uuid từ tên file .jsonl và .jsonl.zst', () => {
    const z = codexCtxForPath(`C:\\x\\sessions\\2026\\05\\24\\rollout-2026-05-24T16-18-10-${UUID}.jsonl.zst`);
    expect(z).toEqual({ agentId: `codex:${UUID}`, lastTs: null, turnOpen: false, resumed: false });
    expect(codexCtxForPath(`/a/rollout-2026-05-24T16-18-10-${UUID}.jsonl`).agentId).toBe(`codex:${UUID}`);
    expect(codexCtxForPath('/a/other.jsonl').agentId).toBeNull();
    expect(codexCtxForPath(`/a/rollout-2026-05-24T16-18-10-${UUID}.jsonl`, { resumed: true }).resumed).toBe(true);
  });

  test('resumed giữa file: vẫn phát call, agent event không có startedAt', () => {
    const ctx = codexCtxForPath(`/a/rollout-2026-05-24T16-18-10-${UUID}.jsonl`, { resumed: true });
    const { ev } = run(lines.slice(4, 6), ctx);
    const a = ev.find((e) => e.type === 'agent') as any;
    expect(a.agent.id).toBe(`codex:${UUID}`);
    expect(a.agent.sessionId).toBe(UUID);
    expect('startedAt' in a.agent).toBe(false);
    expect('label' in a.agent).toBe(false);
    expect(ev.some((e) => e.type === 'call_start' && e.call.id === 'call_1')).toBe(true);
    expect((ev.find((e) => e.type === 'call_end') as any).ok).toBe(false);
  });
});
