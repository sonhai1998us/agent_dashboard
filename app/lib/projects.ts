import type { AgentInfo } from '@/src/core/model';
import type { Ticket } from '@/src/tickets/model';

export interface ProjectGroup {
  /** khoá so sánh ('' = phiên không rõ thư mục) */
  key: string;
  /** đường dẫn gốc như lần đầu gặp, để hiện khi rê chuột */
  dir: string;
  name: string;
  tickets: Ticket[];
  sessions: AgentInfo[];
  /** có ticket hoặc phiên đang chạy / chờ bạn */
  active: boolean;
  lastAt: number;
}

const ACTIVE_TICKET: ReadonlySet<Ticket['status']> = new Set(['planning', 'awaiting_approval', 'running', 'escalated']);
const UNKNOWN = 'Không rõ thư mục';

const segments = (dir: string): string[] => dir.split(/[\\/]+/).filter(Boolean);

/** Hai đường dẫn chỉ khác dấu gạch, gạch cuối hoặc hoa thường (Windows) là cùng một project. */
export function projectKey(dir: string): string {
  return segments(dir).join('/').toLowerCase();
}

export function groupByProject(tickets: Ticket[], sessions: AgentInfo[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  const get = (dir: string | null): ProjectGroup => {
    const key = dir ? projectKey(dir) : '';
    let g = map.get(key);
    if (!g) {
      g = { key, dir: dir ?? '', name: '', tickets: [], sessions: [], active: false, lastAt: 0 };
      map.set(key, g);
    }
    return g;
  };

  for (const t of tickets) {
    const g = get(t.dir);
    g.tickets.push(t);
    g.lastAt = Math.max(g.lastAt, t.updatedAt);
    if (ACTIVE_TICKET.has(t.status)) g.active = true;
  }
  for (const s of sessions) {
    const g = get(s.cwd);
    g.sessions.push(s);
    g.lastAt = Math.max(g.lastAt, s.lastEventAt);
    if (s.status === 'running') g.active = true;
  }

  const groups = [...map.values()];
  // tên = thư mục cuối; trùng tên thì lấy thêm thư mục cha cho tới khi phân biệt được
  const named = groups.filter((g) => g.key !== '');
  for (let depth = 1; ; depth++) {
    const counts = new Map<string, number>();
    for (const g of named) {
      g.name = segments(g.dir).slice(-depth).join('/') || g.dir;
      counts.set(g.name.toLowerCase(), (counts.get(g.name.toLowerCase()) ?? 0) + 1);
    }
    const clash = named.some((g) => (counts.get(g.name.toLowerCase()) ?? 0) > 1 && segments(g.dir).length > depth);
    if (!clash) break;
  }
  for (const g of groups) {
    if (g.key === '') g.name = UNKNOWN;
    g.tickets.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return groups.sort((a, b) =>
    Number(a.key === '') - Number(b.key === '') || Number(b.active) - Number(a.active) || b.lastAt - a.lastAt);
}
