import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { newStreamCtx, parseStreamLine, type StreamOut } from '@/src/runner/streamJson';

const fx = (n: string) => readFileSync(`tests/fixtures/claude/${n}`, 'utf8').split('\n').filter(Boolean);
const spec = { agentId: 'acctv:T-1:dev-1', sessionId: 's1', label: 'Dev 1', resume: false };
const T0 = Date.parse('2026-11-04T10:00:00Z');

function run(lines: string[]) {
  const ctx = newStreamCtx(spec);
  const outs: StreamOut[] = lines.map((l, i) => parseStreamLine(l, ctx, T0 + i * 1000));
  return { ctx, outs, events: outs.flatMap((o) => o.events) };
}

describe('parseStreamLine', () => {
  const { ctx, outs, events } = run(fx('stream.jsonl'));

  it('takes sessionId from init', () => {
    expect(outs[0].sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });
  it('emits call start/end for tools', () => {
    expect(events.some((e) => e.type === 'call_start' && e.call.id === 'tu1')).toBe(true);
    expect(events.find((e) => e.type === 'call_end' && e.callId === 'tu1')).toMatchObject({ ok: true });
    expect(events.find((e) => e.type === 'call_end' && e.callId === 'tu2')).toMatchObject({ ok: false });
  });
  it('counts one parse_error', () => {
    expect(events.filter((e) => e.type === 'parse_error')).toHaveLength(1);
  });
  it('flags limited on retry 429 and clears on the next assistant', () => {
    expect(outs[6].limited).toBe(true);
    expect(outs[7].limited).toBe(false);
  });
  it('reads the result', () => {
    const r = outs[8].result!;
    expect(r.costUsd).toBe(0.0123);
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Done');
  });
  it('tracks changed files from successful edits only', () => {
    expect([...ctx.changedFiles]).toEqual(['src/a.ts']);
  });
  it('strips runner-owned fields from agent events', () => {
    const agents = events.filter((e) => e.type === 'agent');
    expect(agents.length).toBeGreaterThan(0);
    for (const e of agents) {
      if (e.type !== 'agent') continue;
      for (const k of ['status', 'parentId', 'label', 'startedAt']) expect(e.agent).not.toHaveProperty(k);
    }
    expect(agents.some((e) => e.type === 'agent' && e.agent.model === 'claude-sonnet-5-5')).toBe(true);
  });
  it('does not track edits whose result failed', () => {
    const c = newStreamCtx(spec);
    const a = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: 'b.ts' } }] } });
    const u = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'no', is_error: true }] } });
    parseStreamLine(a, c, T0);
    parseStreamLine(u, c, T0 + 1);
    expect(c.changedFiles.size).toBe(0);
  });
  it('flags rate-limited error results', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' });
    expect(parseStreamLine(line, newStreamCtx(spec), T0).result).toMatchObject({ isError: true, rateLimited: true });
  });
  it('ignores unknown types', () => {
    expect(parseStreamLine('{"type":"rate_limit_event"}', newStreamCtx(spec), T0)).toEqual({ events: [] });
  });
  it('reads a real captured stream', () => {
    const r = run(fx('stream-real.jsonl'));
    expect(r.outs.find((o) => o.result)?.result?.isError).toBe(false);
    expect(r.events.some((e) => e.type === 'parse_error')).toBe(false);
  });
});
