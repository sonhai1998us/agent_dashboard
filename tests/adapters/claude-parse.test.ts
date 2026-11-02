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
});
