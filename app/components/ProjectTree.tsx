'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { AgentInfo, Alert, Source } from '@/src/core/model';
import { selectAgent, selectTicket, useLive } from '../lib/liveStore';
import { isExternal, ticketStatusText } from '../lib/tickets';
import { buildRoots } from '../lib/tree';
import { groupByProject } from '../lib/projects';
import styles from './ProjectTree.module.css';

type Tone = 'run' | 'wait' | 'ended' | 'warn' | 'crit';

export function statusOf(a: AgentInfo, alerts: Alert[]): { tone: Tone; icon: string; text: string } {
  const mine = alerts.filter((x) => x.agentId === a.id || x.agentId.startsWith(`${a.id}:`));
  if (mine.some((x) => x.level === 'critical')) return { tone: 'crit', icon: '■', text: 'nghiêm trọng' };
  if (mine.length > 0) return { tone: 'warn', icon: '▲', text: 'cảnh báo' };
  if (a.status === 'running') return { tone: 'run', icon: '●', text: 'đang chạy' };
  if (a.status === 'queued') return { tone: 'wait', icon: '◌', text: 'xếp hàng' };
  if (a.status === 'limited') return { tone: 'warn', icon: '⏸', text: 'bị giới hạn' };
  if (a.status === 'ended') return { tone: 'ended', icon: '○', text: 'đã kết thúc' };
  return { tone: 'wait', icon: '○', text: 'rảnh' };
}

const COLLAPSED_KEY = 'acctv.projects.collapsed';
const RUNNING_TICKET = new Set(['planning', 'running']);

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}

function saveCollapsed(s: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s])); } catch { /* bộ nhớ trình duyệt bị chặn: chỉ mất trạng thái gập */ }
}

export default function ProjectTree() {
  const agentsMap = useLive((s) => s.agents);
  const alertsMap = useLive((s) => s.alerts);
  const ticketsMap = useLive((s) => s.tickets);
  const selAgent = useLive((s) => s.selectedAgentId);
  const selTicket = useLive((s) => s.selectedTicketId);
  const [source, setSource] = useState<'all' | Source>('all');
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCollapsed(loadCollapsed()); }, []);

  const toggle = (key: string, open?: boolean) => setCollapsed((prev) => {
    const next = new Set(prev);
    const willOpen = open ?? next.has(key);
    if (willOpen) next.delete(key); else next.add(key);
    saveCollapsed(next);
    return next;
  });

  const alerts = useMemo(() => Object.values(alertsMap), [alertsMap]);
  const groups = useMemo(() => {
    const sessions = buildRoots(Object.values(agentsMap).filter(isExternal))
      .map((r) => r.session)
      .filter((a) => (source === 'all' || a.source === source) && (!onlyRunning || a.status === 'running'));
    const tickets = Object.values(ticketsMap).filter((t) => !onlyRunning || RUNNING_TICKET.has(t.status));
    return groupByProject(tickets, sessions);
  }, [agentsMap, ticketsMap, source, onlyRunning]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? []);
    if (items.length === 0) return;
    const cur = document.activeElement as HTMLButtonElement;
    const i = items.indexOf(cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (i === -1) { items[0].focus(); return; }
      items[e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)].focus();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur?.dataset.project !== undefined) {
      e.preventDefault();
      toggle(cur.dataset.project, e.key === 'ArrowRight');
    }
  };

  return (
    <nav className={styles.box} aria-label="Project">
      <h2 className={styles.h}>Project</h2>
      <div className={styles.filters}>
        <label className={styles.f}>
          <span className={styles.sr}>Lọc phiên theo nguồn</span>
          <select value={source} onChange={(e) => setSource(e.target.value as 'all' | Source)}>
            <option value="all">Mọi nguồn</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </label>
        <label className={styles.f}>
          <input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} /> đang chạy
        </label>
      </div>

      {/* màn hẹp (dưới 1024px): cột trái thành một select, nhóm theo project */}
      <select
        className={styles.narrow} aria-label="Chọn ticket hoặc phiên"
        value={selTicket ? `t:${selTicket}` : selAgent ? `s:${selAgent}` : ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('t:')) selectTicket(v.slice(2));
          else if (v.startsWith('s:')) selectAgent(v.slice(2));
        }}
      >
        <option value="">— chọn ticket / phiên —</option>
        {groups.map((g) => (
          <optgroup key={g.key} label={g.name}>
            {g.tickets.map((t) => <option key={t.id} value={`t:${t.id}`}>{ticketStatusText(t).icon} {t.id} · {t.title}</option>)}
            {g.sessions.map((a) => <option key={a.id} value={`s:${a.id}`}>{statusOf(a, alerts).icon} {a.source} · {a.label}</option>)}
          </optgroup>
        ))}
      </select>

      <div className={styles.wide} ref={listRef} onKeyDown={onKey}>
        {groups.length === 0 && <div className={styles.empty}>Chưa có ticket hay phiên nào. Bấm + Ticket mới để bắt đầu.</div>}
        {groups.map((g) => {
          const open = !collapsed.has(g.key);
          const hasSel = g.tickets.some((t) => t.id === selTicket) || g.sessions.some((a) => a.id === selAgent);
          const bodyId = `proj-${g.key || 'unknown'}`;
          return (
            <div key={g.key} className={styles.group}>
              <button
                type="button" data-row data-project={g.key}
                className={`${styles.folder} ${!open && hasSel ? styles.sel : ''}`}
                aria-expanded={open} aria-controls={bodyId}
                title={g.dir || undefined}
                onClick={() => toggle(g.key)}
              >
                <span className={styles.chev} aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className={styles.fname}>{g.name}</span>
                {g.active && <span className={styles.live} aria-label="đang có việc chạy">●</span>}
                <span className={styles.count}>{g.tickets.length + g.sessions.length}</span>
              </button>

              {open && (
                <div id={bodyId} className={styles.body}>
                  {g.tickets.length > 0 && <div className={styles.sub}>Ticket</div>}
                  {g.tickets.map((t) => {
                    const st = ticketStatusText(t);
                    const sel = selTicket === t.id;
                    return (
                      <div key={t.id} className={styles.item}>
                        <button
                          data-row type="button"
                          className={`${styles.row} ${sel ? styles.sel : ''} ${st.tone === 'ended' ? styles.dim : ''}`}
                          aria-current={sel ? 'true' : undefined}
                          onClick={() => selectTicket(t.id)}
                        >
                          <span className={styles.ico} data-tone={st.tone} aria-hidden="true">{st.icon}</span>
                          <span className={styles.txt}>
                            <span className={styles.l1}><span className={styles.label}>{t.title}</span></span>
                            <span className={styles.meta}><span className="mono">{t.id}</span> <span data-tone={st.tone} className={styles.st}>{st.text}</span></span>
                          </span>
                        </button>
                        {t.status === 'awaiting_approval' && (
                          <Link href={`/tickets/${t.id}/plan`} className={styles.approve}>Duyệt kế hoạch →</Link>
                        )}
                      </div>
                    );
                  })}

                  {g.sessions.length > 0 && <div className={styles.sub}>Phiên</div>}
                  {g.sessions.map((a) => {
                    const st = statusOf(a, alerts);
                    const sel = selAgent === a.id && !selTicket;
                    return (
                      <button
                        key={a.id} data-row type="button"
                        className={`${styles.row} ${sel ? styles.sel : ''} ${st.tone === 'ended' ? styles.dim : ''}`}
                        aria-current={sel ? 'true' : undefined}
                        aria-label={`${a.source} ${a.label}, ${st.text}`}
                        onClick={() => selectAgent(a.id)}
                      >
                        <span className={styles.ico} data-tone={st.tone} aria-hidden="true">{st.icon}</span>
                        <span className={styles.txt}>
                          <span className={styles.l1}><span className={styles.src}>{a.source}</span> <span className={styles.label}>{a.label}</span></span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
