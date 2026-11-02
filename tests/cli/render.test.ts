import { expect, test } from 'vitest';
import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { renderList, renderWatch } from '@/cli/render';

const ANSI = /\x1b\[/;

const agent = (o: Partial<AgentInfo> & Pick<AgentInfo, 'id'>): AgentInfo => ({
  source: 'claude', sessionId: 'abcdef1234567890', parentId: null, parentToolUseId: null, requestShape: null, label: 'demo', role: null, model: null, effort: null,
  cwd: null, pid: null, startedAt: 1_000, lastEventAt: 2_000, status: 'running', parseErrors: 0, ...o,
});
const alert = (o: Partial<Alert> & Pick<Alert, 'agentId'>): Alert => ({
  id: 'al1', kind: 'stuck', level: 'warn', message: 'treo', since: 0, active: true, ...o,
});
const call = (i: number, agentId: string): CallRecord => ({
  id: 'c' + i, agentId, kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: `lenh-so-${i}`,
  startedAt: 1_000_000 + i * 1000, endedAt: 1_000_500 + i * 1000, ok: true, errorPreview: null, tokensIn: null, tokensOut: null,
});

test('renderList hiện ▲ cho agent có alert warn và không có ANSI khi color=false', () => {
  const a = agent({ id: 'claude:abcdef1234567890' });
  const out = renderList([a], [alert({ agentId: a.id })], false);
  expect(out).toContain('▲');
  expect(out).toContain('abcdef12');
  expect(out).toContain('claude');
  expect(out).toContain('demo');
  expect(out).not.toMatch(ANSI);
});

test('renderList dùng ■ cho critical, ○ cho idle/ended, có ANSI khi color=true và báo rỗng', () => {
  const a = agent({ id: 'claude:aaaaaaaa11', sessionId: 'aaaaaaaa11', status: 'idle' });
  const b = agent({ id: 'codex:bbbbbbbb22', sessionId: 'bbbbbbbb22', source: 'codex', status: 'ended' });
  const out = renderList([a, b], [alert({ agentId: a.id, level: 'critical' })], true);
  expect(out).toContain('■');
  expect(out).toContain('○');
  expect(out).toMatch(ANSI);
  expect(renderList([], [], false)).toContain('Không có agent');
});

test('renderWatch hiện cây ├/└ và 10 call gần nhất', () => {
  const root = agent({ id: 'claude:s1', sessionId: 's1' });
  const k1 = agent({ id: 'claude:s1:a1', sessionId: 's1', parentId: root.id, label: 'con-1', lastEventAt: 9_000 });
  const k2 = agent({ id: 'claude:s1:a2', sessionId: 's1', parentId: root.id, label: 'con-2', lastEventAt: 5_000 });
  const calls = { [k1.id]: Array.from({ length: 12 }, (_, i) => call(11 - i, k1.id)) }; // mới nhất trước
  const out = renderWatch(root, [root, k1, k2], calls, [], 100, false);
  expect(out).toContain('├');
  expect(out).toContain('└');
  expect(out).toContain('con-1');
  expect(out).toContain('lenh-so-11');
  expect(out).toContain('lenh-so-2');
  expect(out).not.toContain('lenh-so-1 ');
  expect(out).not.toContain('lenh-so-0');
  expect(out.split('\n').filter((l) => l.includes('Bash')).length).toBe(10);
  expect(out).not.toMatch(ANSI);
});

test('renderList ghi loại cảnh báo bằng tiếng Việt', () => {
  const a = agent({ id: 'claude:abcdef1234567890' });
  expect(renderList([a], [alert({ agentId: a.id, kind: 'long_tool' })], false)).toContain('▲ tool lâu');
  expect(renderList([a], [alert({ agentId: a.id, kind: 'long_tool' })], false)).not.toContain('long_tool');
  expect(renderList([a], [alert({ agentId: a.id, kind: 'stuck' })], false)).toContain('▲ kẹt');
});
