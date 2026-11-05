'use client';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { postJson, useLive } from '../lib/liveStore';
import { fmtCost } from '../lib/format';
import { managedStateText } from '../lib/tickets';
import { openUserActions } from '../lib/userActions';
import styles from './ManagedPanel.module.css';

const STOPPABLE = new Set(['queued', 'running', 'limited', 'waiting']);
const TASK_LINES = 6;

export default function ManagedPanel({ agentId }: { agentId: string }) {
  const m = useLive((s) => s.managed[agentId]);
  const label = useLive((s) => s.agents[agentId]?.label ?? agentId);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setMore(false); setBusy(false); setErr(null); }, [agentId]);
  if (!m) return null;

  const st = m.userAction && m.state === 'waiting' ? { icon: '▲', text: 'chờ bạn', tone: 'warn' as const } : managedStateText(m.state);
  const canStop = m.role !== 'controller' && STOPPABLE.has(m.state);
  const lines = m.task.split('\n');
  const long = lines.length > TASK_LINES;
  const shown = more || !long ? m.task : lines.slice(0, TASK_LINES).join('\n');
  const changed = new Set(m.changedFiles);

  const stop = async () => {
    if (busy) return;
    if (!window.confirm(`Dừng ${label}? Kết quả dở dang sẽ trả về Controller.`)) return;
    setBusy(true); setErr(null);
    try { await postJson(`/api/agents/${encodeURIComponent(agentId)}/stop`, {}); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!canStop || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); void stop(); }
  };

  return (
    <section className={styles.panel} tabIndex={0} aria-label="Gói việc" onKeyDown={onKey}>
      <div className={styles.top}>
        <span className={`${styles.chip} mono`} data-tone={st.tone}><span aria-hidden="true">{st.icon}</span> {st.text}</span>
        <span className={`${styles.cost} mono`}>{fmtCost(m.costUsd)}</span>
      </div>
      <div className={`${styles.line} mono`}>{m.runner} · {m.model} · {m.effort}</div>
      {m.stopReason && <div className={styles.reason}><span aria-hidden="true">▲</span> {m.stopReason}</div>}
      {m.userAction && (
        <div className={styles.need}>
          <span><span aria-hidden="true">▲</span> Cần bạn: {m.userAction.title}</span>
          <button type="button" className={styles.link} onClick={() => openUserActions(agentId)}>Mở</button>
        </div>
      )}
      <h4 className={styles.h}>Gói việc</h4>
      <div className={styles.task}>{shown}</div>
      {long && (
        <button type="button" className={styles.link} aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {more ? 'Thu gọn' : 'Xem thêm'}
        </button>
      )}
      <h4 className={styles.h}>File được sửa</h4>
      {m.files.length === 0 ? <div className={styles.none}>—</div> : (
        <ul className={`${styles.files} mono`}>
          {m.files.map((f) => (
            <li key={f} data-changed={changed.has(f) || undefined}>
              <span className={styles.mark} aria-hidden="true">{changed.has(f) ? '✎' : ''}</span>
              {changed.has(f) && <span className={styles.sr}>đã sửa: </span>}{f}
            </li>
          ))}
        </ul>
      )}
      {canStop && (
        <button type="button" className={styles.stop} disabled={busy} onClick={() => void stop()} title="Phím tắt: S">
          {busy ? 'Đang dừng…' : 'Dừng → trả Controller'}
        </button>
      )}
      {err && <div role="alert" className={styles.err}>{err}</div>}
    </section>
  );
}
