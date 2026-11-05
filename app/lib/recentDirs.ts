import type { Ticket } from '@/src/tickets/model';

export function recentDirs(tickets: Ticket[], max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...tickets].sort((a, b) => b.createdAt - a.createdAt)) {
    const k = t.dir.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t.dir);
    if (out.length >= max) break;
  }
  return out;
}
