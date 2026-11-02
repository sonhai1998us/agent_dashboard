import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { claudeCtxForPath, parseClaudeLine } from '@/src/adapters/claude/parse';
import type { NormalizedEvent } from '@/src/core/model';

const fx = (n: string) => readFileSync(`tests/fixtures/claude/${n}`, 'utf8').split('\n').filter(Boolean);
const CD = 'C:\\Users\\x\\.claude';
const mainPath = `${CD}\\projects\\proj\\sess-main.jsonl`;
const subPath = `${CD}\\projects\\proj\\sess-main\\subagents\\agent-ab12.jsonl`;

function runMain() {
  const ctx = claudeCtxForPath(mainPath, CD);
  const ev: NormalizedEvent[] = [];
  for (const l of fx('main.jsonl')) ev.push(...parseClaudeLine(l, ctx));
  return { ctx, ev };
}

describe('claude parser', () => {
  test('tool_use/tool_result thành call_start/call_end, is_error → ok=false', () => {
    const { ev } = runMain();
    const starts = ev.filter((e) => e.type === 'call_start' && e.call.kind === 'tool');
    expect(starts).toHaveLength(3);
    const hashes = new Set(starts.map((e: any) => e.call.inputHash));
    expect(hashes.size).toBe(1);
    const ends = ev.filter((e) => e.type === 'call_end') as any[];
    const a = ends.find((e) => e.callId === 'toolu_A');
    expect(a.ok).toBe(false);
    expect(a.errorPreview).toContain('FAIL');
    expect(ends.find((e) => e.callId === 'toolu_B').errorPreview).toContain('FAIL again');
    const c = ends.find((e) => e.callId === 'toolu_C');
    expect(c.ok).toBe(true);
    expect(c.errorPreview).toBeNull();
  });

  test('assistant usage → llm call, tokensIn gồm cache tokens', () => {
    const { ev } = runMain();
    const llm = ev.find((e) => e.type === 'call_start' && e.call.id === 'msg_01') as any;
    expect(llm.call.kind).toBe('llm');
    expect(llm.call.tokensIn).toBe(2 + 36239 + 0);
    expect(llm.call.tokensOut).toBe(50);
    expect(llm.call.name).toBe('claude-opus-test');
    const end = ev.find((e) => e.type === 'call_end' && e.callId === 'msg_01') as any;
    expect(end.ok).toBe(true);
    expect(end.endedAt).toBe(Date.parse('2026-11-02T10:00:02.000Z'));
    expect(llm.call.startedAt).toBe(Date.parse('2026-11-02T10:00:00.000Z'));
    const ag = ev.find((e) => e.type === 'agent' && (e.agent as any).model) as any;
    expect(ag.agent.model).toBe('claude-opus-test');
    expect(ag.agent.effort).toBe('high');
  });

  test('subagent: id claude:<sid>:<agentId>, parentId claude:<sid>, role office-dev', () => {
    const ctx = claudeCtxForPath(subPath, CD, { agentType: 'office-dev', description: 'WP-1' });
    expect(ctx.agentId).toBe('claude:sess-main:ab12');
    expect(ctx.parentId).toBe('claude:sess-main');
    expect(ctx.sessionId).toBe('sess-main');
    expect(ctx.role).toBe('office-dev');
    const ev: NormalizedEvent[] = [];
    for (const l of fx('sub.jsonl')) ev.push(...parseClaudeLine(l, ctx));
    const first = ev[0] as any;
    expect(first.type).toBe('agent');
    expect(first.agent).toMatchObject({ id: 'claude:sess-main:ab12', source: 'claude', parentId: 'claude:sess-main', role: 'office-dev', label: 'WP-1' });
  });

  test('đường dẫn dùng / cũng nhận ra', () => {
    const ctx = claudeCtxForPath('C:/Users/x/.claude/projects/proj/sess-main.jsonl', 'C:/Users/x/.claude');
    expect(ctx.agentId).toBe('claude:sess-main');
    expect(ctx.parentId).toBeNull();
  });

  test('custom-title đặt label', () => {
    const { ctx, ev } = runMain();
    expect(ctx.label).toBe('Sua loi dang nhap');
    const labelled = ev.find((e) => e.type === 'agent' && (e.agent as any).label === 'Sua loi dang nhap');
    expect(labelled).toBeTruthy();
  });

  test('label mặc định là tên thư mục cuối của cwd', () => {
    const ctx = claudeCtxForPath(mainPath, CD);
    const ev = parseClaudeLine(fx('main.jsonl')[1], ctx);
    expect((ev[0] as any).agent).toMatchObject({ label: 'demo-app', cwd: 'D:\\Work\\demo-app', startedAt: Date.parse('2026-11-02T10:00:00.000Z') });
  });

  test('dòng JSON hỏng → parse_error, record lạ → không ném lỗi', () => {
    const ctx = claudeCtxForPath(mainPath, CD);
    expect(parseClaudeLine('{ this is not json', ctx)).toEqual([{ type: 'parse_error', agentId: 'claude:sess-main' }]);
    expect(parseClaudeLine('{"foo":1}', ctx)).toEqual([{ type: 'parse_error', agentId: 'claude:sess-main' }]);
    const ev = parseClaudeLine('{"type":"weird-new-type","timestamp":"2026-11-02T10:00:20.000Z"}', ctx);
    expect(ev.some((e) => e.type === 'activity')).toBe(true);
    expect(parseClaudeLine('{"type":"weird-new-type"}', ctx).filter((e) => e.type === 'activity')).toHaveLength(0);
  });

  test('tool_result mồ côi vẫn sinh call_end (Store sẽ bỏ qua)', () => {
    const { ev } = runMain();
    expect(ev.some((e) => e.type === 'call_end' && e.callId === 'toolu_ORPHAN')).toBe(true);
  });

  test('ctx.lastTs cập nhật, dòng không có timestamp không đổi nó', () => {
    const ctx = claudeCtxForPath(mainPath, CD);
    parseClaudeLine('{"type":"weird-new-type","timestamp":"2026-11-02T10:00:20.000Z"}', ctx);
    expect(ctx.lastTs).toBe(Date.parse('2026-11-02T10:00:20.000Z'));
    parseClaudeLine('{"type":"weird-new-type"}', ctx);
    expect(ctx.lastTs).toBe(Date.parse('2026-11-02T10:00:20.000Z'));
  });

  test('resumed: không có startedAt và không đặt label theo cwd', () => {
    const ctx = claudeCtxForPath(mainPath, CD, undefined, { resumed: true });
    const ev = parseClaudeLine(fx('main.jsonl')[4], ctx);
    const a = (ev[0] as any).agent;
    expect(a.id).toBe('claude:sess-main');
    expect(a).not.toHaveProperty('startedAt');
    expect(a).not.toHaveProperty('label');
    expect(a.cwd).toBe('D:\\Work\\demo-app');
    const t = parseClaudeLine('{"type":"custom-title","customTitle":"Tieu de"}', ctx);
    expect((t[0] as any).agent.label).toBe('Tieu de');
  });

  test('message.id lặp qua nhiều dòng → cùng id llm được phát lại', () => {
    const ctx = claudeCtxForPath(mainPath, CD);
    const mk = (ts: string, out: number) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id: 'msg_dup', model: 'm', usage: { input_tokens: 1, output_tokens: out }, content: [] } });
    const ev = [...parseClaudeLine(mk('2026-11-02T10:00:00.000Z', 5), ctx), ...parseClaudeLine(mk('2026-11-02T10:00:01.000Z', 9), ctx)];
    const starts = ev.filter((e) => e.type === 'call_start') as any[];
    expect(starts.map((s) => s.call.id)).toEqual(['msg_dup', 'msg_dup']);
    expect(starts.map((s) => s.call.tokensOut)).toEqual([5, 9]);
  });

  test('errorPreview cắt ở 200 ký tự', () => {
    const ctx = claudeCtxForPath(mainPath, CD);
    const l = JSON.stringify({ type: 'user', timestamp: '2026-11-02T10:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(500), is_error: true }] } });
    const end = parseClaudeLine(l, ctx).find((e) => e.type === 'call_end') as any;
    expect(end.errorPreview).toHaveLength(200);
  });

  test('subagent: llm tokens và label từ meta.description', () => {
    const ctx = claudeCtxForPath(subPath, CD, { agentType: 'office-dev', description: 'WP-1' });
    const ev: NormalizedEvent[] = [];
    for (const l of fx('sub.jsonl')) ev.push(...parseClaudeLine(l, ctx));
    expect(ctx.label).toBe('WP-1');
    const llm = ev.find((e) => e.type === 'call_start' && e.call.kind === 'llm') as any;
    expect(llm.call.tokensIn).toBe(5 + 10 + 100);
    expect(llm.call.tokensOut).toBe(7);
    expect(llm.call.agentId).toBe('claude:sess-main:ab12');
  });
});

describe('subagent status from transcript', () => {
  const rec = (type: string, extra: object = {}) => JSON.stringify({ type, timestamp: '2026-11-02T10:00:00.000Z', sessionId: 'sess-main', ...extra });
  const statuses = (ctx: ReturnType<typeof claudeCtxForPath>, lines: string[]) =>
    lines.flatMap((l) => parseClaudeLine(l, ctx)).filter((e) => e.type === 'agent' && (e.agent as any).status).map((e) => (e as any).agent.status);

  test('end_turn → ended một lần; user/assistant sau đó → running một lần', () => {
    const ctx = claudeCtxForPath(subPath, CD);
    const asst = (stop: string) => rec('assistant', { message: { id: 'x', stop_reason: stop, content: [] } });
    expect(statuses(ctx, [rec('user'), asst('tool_use'), asst('end_turn')])).toEqual(['running', 'ended']);
    expect(statuses(ctx, [rec('user'), asst('end_turn')])).toEqual(['running', 'ended']);
    expect(statuses(ctx, [rec('user'), rec('user')])).toEqual(['running']);
    expect(statuses(claudeCtxForPath(subPath, CD), [asst('end_turn')])).toEqual(['ended']); // first record is the final end_turn
  });

  test('phiên chính không phát status từ transcript', () => {
    const ctx = claudeCtxForPath(mainPath, CD);
    expect(statuses(ctx, [rec('assistant', { message: { id: 'x', stop_reason: 'end_turn', content: [] } })])).toEqual([]);
  });
});
