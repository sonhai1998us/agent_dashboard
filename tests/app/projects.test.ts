import { describe, expect, test } from 'vitest';
import type { AgentInfo } from '@/src/core/model';
import type { Ticket } from '@/src/tickets/model';
import { groupByProject, projectKey } from '@/app/lib/projects';

function ag(id: string, o: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id, source: 'claude', sessionId: id, parentId: null, parentToolUseId: null, requestShape: null, label: id, role: null, model: null, effort: null,
    cwd: null, pid: null, startedAt: 0, lastEventAt: 0, status: 'idle', parseErrors: 0, ...o,
  };
}

function tk(id: string, dir: string, o: Partial<Ticket> = {}): Ticket {
  return {
    id, seq: 1, title: id, description: '', dir, status: 'done', overrides: {}, plan: null, feedback: null, round: 0, maxRounds: 3,
    controllerSessionId: '', branch: null, worktree: null, baseRef: null, pendingWait: null, report: null, diffStat: null, merge: null,
    createdAt: 0, updatedAt: 0, ...o,
  } as Ticket;
}

describe('projects', () => {
  test('projectKey: bỏ khác biệt dấu gạch, gạch cuối và hoa thường', () => {
    expect(projectKey('D:\\Work\\App\\')).toBe(projectKey('d:/work/app'));
  });

  test('ticket và phiên cùng thư mục nằm chung một project', () => {
    const g = groupByProject([tk('T-1', 'D:\\Work\\app')], [ag('s1', { cwd: 'd:/work/app' })]);
    expect(g).toHaveLength(1);
    expect(g[0].name).toBe('app');
    expect(g[0].tickets.map((t) => t.id)).toEqual(['T-1']);
    expect(g[0].sessions.map((s) => s.id)).toEqual(['s1']);
  });

  test('project đang có việc chạy lên đầu, còn lại theo hoạt động gần nhất', () => {
    const g = groupByProject(
      [tk('T-1', '/a', { updatedAt: 900 }), tk('T-2', '/b', { updatedAt: 100, status: 'running' })],
      [ag('s1', { cwd: '/c', lastEventAt: 500 })],
    );
    expect(g.map((p) => p.name)).toEqual(['b', 'a', 'c']);
    expect(g[0].active).toBe(true);
    expect(g[1].active).toBe(false);
  });

  test('ticket trong project xếp mới cập nhật trước; phiên giữ nguyên thứ tự truyền vào', () => {
    const g = groupByProject(
      [tk('old', '/a', { updatedAt: 1 }), tk('new', '/a', { updatedAt: 2 })],
      [ag('x', { cwd: '/a', lastEventAt: 1 }), ag('y', { cwd: '/a', lastEventAt: 9 })],
    );
    expect(g[0].tickets.map((t) => t.id)).toEqual(['new', 'old']);
    expect(g[0].sessions.map((s) => s.id)).toEqual(['x', 'y']);
  });

  test('trùng tên thư mục cuối thì thêm thư mục cha để phân biệt', () => {
    const g = groupByProject([tk('T-1', 'D:\\one\\app'), tk('T-2', 'D:\\two\\app')], []);
    expect(g.map((p) => p.name).sort()).toEqual(['one/app', 'two/app']);
  });

  test('phiên không rõ cwd vào nhóm riêng, nằm cuối', () => {
    const g = groupByProject([], [ag('s1', { lastEventAt: 999 }), ag('s2', { cwd: '/a', lastEventAt: 1 })]);
    expect(g.map((p) => p.key)).toEqual([projectKey('/a'), '']);
    expect(g[1].name).toBe('Không rõ thư mục');
  });
});
