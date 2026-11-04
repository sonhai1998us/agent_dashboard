'use client';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentInfo, Alert, Source } from '@/src/core/model';
import { selectAgent, useLive } from '../lib/liveStore';
import { isExternal } from '../lib/tickets';
import { buildRoots } from '../lib/tree';
import styles from './SessionList.module.css';

type Tone = 'run' | 'wait' | 'ended' | 'warn' | 'crit';

function projectName(cwd: string | null): string {
  if (!cwd) return '—';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

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

export default function SessionList() {
  const agentsMap = useLive((s) => s.agents);
  const alertsMap = useLive((s) => s.alerts);
  const selected = useLive((s) => s.selectedAgentId);
  const [source, setSource] = useState<'all' | Source>('all');
  const [onlyRunning, setOnlyRunning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const alerts = Object.values(alertsMap);
    return buildRoots(Object.values(agentsMap).filter(isExternal))
      .map((r) => r.session)
      .filter((a) => (source === 'all' || a.source === source) && (!onlyRunning || a.status === 'running'))
      .map((a) => ({ a, st: statusOf(a, alerts) }));
  }, [agentsMap, alertsMap, source, onlyRunning]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) { items[0].focus(); return; }
    items[e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)].focus();
  };

  return (
    <nav className={styles.box} aria-label="Phiên ngoài ticket">
      <h2 className={styles.h}>Phiên ngoài ticket</h2>
      <div className={styles.filters}>
        <label className={styles.f}>
          <span className={styles.sr}>Lọc theo nguồn</span>
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

      {/* màn hẹp (dưới 1024px): cột trái thành một select */}
      <select className={styles.narrow} aria-label="Chọn phiên" value={selected ?? ''} onChange={(e) => e.target.value && selectAgent(e.target.value)}>
        <option value="">— chọn phiên —</option>
        {rows.map(({ a, st }) => (
          <option key={a.id} value={a.id}>{st.icon} {a.source} · {a.label} · {projectName(a.cwd)}</option>
        ))}
      </select>

      <div className={styles.wide} ref={listRef} onKeyDown={onKey}>
        {rows.length === 0 && <div className={styles.empty}>Chưa có phiên nào</div>}
        {rows.map(({ a, st }) => (
          <button
            key={a.id} data-row type="button"
            className={`${styles.row} ${selected === a.id ? styles.sel : ''} ${st.tone === 'ended' ? styles.dim : ''}`}
            aria-current={selected === a.id ? 'true' : undefined}
            aria-label={`${a.source} ${a.label}, ${projectName(a.cwd)}, ${st.text}`}
            onClick={() => selectAgent(a.id)}
          >
            <span className={styles.ico} data-tone={st.tone} aria-hidden="true">{st.icon}</span>
            <span className={styles.txt}>
              <span className={styles.l1}><span className={styles.src}>{a.source}</span> <span className={styles.label}>{a.label}</span></span>
              <span className={styles.proj}>{projectName(a.cwd)}</span>
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
