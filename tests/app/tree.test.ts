import { describe, expect, test } from 'vitest';
import type { AgentInfo } from '@/src/core/model';
import { buildRoots, flattenTree } from '@/app/lib/tree';

function ag(id: string, o: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id, source: 'claude', sessionId: id, parentId: null, parentToolUseId: null, requestShape: null, label: id, role: null, model: null, effort: null,
    cwd: null, pid: null, startedAt: 0, lastEventAt: 0, status: 'idle', parseErrors: 0, ...o,
  };
}

describe('tree', () => {
  test('buildRoots: subagent nằm dưới phiên cha; phiên running lên đầu', () => {
    const all = [
      ag('a', { lastEventAt: 300 }),
      ag('b', { status: 'running', lastEventAt: 100 }),
      ag('a:1', { parentId: 'a', lastEventAt: 50 }),
      ag('a:2', { parentId: 'a', lastEventAt: 80 }),
      ag('c', { lastEventAt: 500 }),
    ];
    const roots = buildRoots(all);
    expect(roots.map((r) => r.session.id)).toEqual(['b', 'c', 'a']);
    expect(roots[2].children.map((c) => c.id)).toEqual(['a:2', 'a:1']);
  });
  test('flattenTree: độ sâu và isLast', () => {
    const all = [ag('r'), ag('r:1', { parentId: 'r', lastEventAt: 2 }), ag('r:2', { parentId: 'r', lastEventAt: 1 }), ag('r:1:x', { parentId: 'r:1' })];
    const flat = flattenTree(all[0], all);
    expect(flat.map((n) => [n.agent.id, n.depth, n.isLast])).toEqual([
      ['r', 0, true], ['r:1', 1, false], ['r:1:x', 2, true], ['r:2', 1, true],
    ]);
  });
  test('buildRoots: con mồ côi (cha không có trong danh sách) vẫn thành gốc', () => {
    const roots = buildRoots([ag('x:1', { parentId: 'missing' })]);
    expect(roots).toHaveLength(1);
  });
});
