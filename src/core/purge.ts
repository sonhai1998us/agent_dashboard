import fs from 'node:fs';
import path from 'node:path';
import { findTranscript } from '@/src/adapters/claude/usage';
import type { Config } from './config';
import type { Hub } from './hub';
import { isManagedId, type Source } from './model';
import type { Store } from './store';

/** Một mục trong yêu cầu xoá: dryRun trả về để hỏi xác nhận, chạy thật trả về kèm lỗi (phần còn lại vẫn được xoá). */
export interface PurgeItem {
  kind: 'ticket' | 'session';
  id: string;
  label: string;
  /** những gì sẽ bị (đã bị) xoá */
  what: string[];
  warning: string | null;
  /** khác null: mục này không xoá được và bị bỏ qua */
  blocked: string | null;
  errors: string[];
}

export const purgeItem = (kind: PurgeItem['kind'], id: string, label: string): PurgeItem =>
  ({ kind, id, label, what: [], warning: null, blocked: null, errors: [] });

/** Transcript của một phiên: claude `<sid>.jsonl` và thư mục `<sid>/` (subagent, tool-results); codex file rollout. */
export function transcriptPaths(cfg: Config, source: Source, sessionId: string): string[] {
  if (source === 'claude') {
    const f = findTranscript(cfg.claudeDir, sessionId);
    if (!f) return [];
    const dir = f.slice(0, -'.jsonl'.length);
    return fs.existsSync(dir) ? [f, dir] : [f];
  }
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return [];
  const root = path.join(cfg.codexDir, 'sessions');
  let names: string[];
  try { names = fs.readdirSync(root, { recursive: true }) as string[]; } catch { return []; }
  const re = new RegExp(`${sessionId}\\.jsonl(\\.zst)?$`, 'i');
  return names.filter((n) => re.test(n)).map((n) => path.join(root, n));
}

/** Số file .jsonl trong các đường dẫn (thư mục: đếm cả file con). */
export function countTranscripts(paths: string[]): number {
  let n = 0;
  for (const p of paths) {
    if (p.endsWith('.jsonl') || p.endsWith('.jsonl.zst')) n++;
    else {
      try { n += (fs.readdirSync(p, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')).length; } catch { /* không còn */ }
    }
  }
  return n;
}

/** Xoá file/thư mục; trả về lỗi của từng cái không xoá được. */
export function removePaths(paths: string[]): string[] {
  const errors: string[] = [];
  for (const p of paths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return errors;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Xoá một phiên Claude/Codex không thuộc ticket: file transcript và dữ liệu của nó (kể cả subagent) trên dashboard. */
export function deleteSession(d: { store: Store; cfg: Config; hub: Hub }, id: string, dryRun: boolean): PurgeItem {
  const a = d.store.getAgent(id);
  // nhiều phiên cùng thư mục có cùng nhãn: thêm đầu session id để phân biệt
  const item = purgeItem('session', id, a ? `${a.source} ${a.label} · ${a.sessionId.slice(0, 8)}` : id);
  if (!a || a.parentId) return { ...item, blocked: 'Không tìm thấy phiên' };
  if (isManagedId(id)) return { ...item, blocked: 'Phiên thuộc một ticket: hãy xoá ticket' };
  const busy = d.store.listAgents().some((x) => (x.id === id || x.id.startsWith(`${id}:`)) && x.status !== 'idle' && x.status !== 'ended');
  if (busy) return { ...item, blocked: 'Phiên đang chạy' };
  const paths = transcriptPaths(d.cfg, a.source, a.sessionId);
  item.what = [`${countTranscripts(paths)} file transcript`, 'dữ liệu trên dashboard'];
  if (a.pid && pidAlive(a.pid)) item.warning = `Phiên còn mở (pid ${a.pid}): nếu dùng tiếp, transcript sẽ được ghi lại từ đầu.`;
  if (dryRun) return item;
  item.errors = removePaths(paths);
  const agentIds = d.store.dropAgentTree(id, paths);
  d.hub.publish({ type: 'removed', ticketIds: [], agentIds });
  return item;
}
