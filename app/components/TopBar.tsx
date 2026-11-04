'use client';
import Link from 'next/link';
import { useLive } from '../lib/liveStore';
import { fmtClock, fmtDuration } from '../lib/format';
import styles from './TopBar.module.css';

export default function TopBar() {
  const metrics = useLive((s) => s.metrics);
  const conn = useLive((s) => s.conn);
  const last = useLive((s) => s.lastUpdateAt);

  const stamp = last === null ? '—' : fmtClock(last);
  let label: string;
  if (conn === 'live') label = `● trực tiếp · cập nhật ${stamp}`;
  else if (conn === 'connecting') label = '○ đang kết nối…';
  else label = `○ mất kết nối · dữ liệu lúc ${stamp}`;

  const alerts = metrics?.alerts ?? 0;
  const pending = useLive((s) => Object.values(s.tickets).filter((t) => t.status === 'awaiting_approval').length);
  return (
    <header className={styles.bar}>
      <strong className={styles.brand}>Agent CCTV</strong>
      <Kpi value={metrics ? String(metrics.running) : '—'} label="đang chạy" />
      <Kpi value={metrics ? `${alerts > 0 ? '▲ ' : ''}${alerts}` : '—'} label="cảnh báo" warn={alerts > 0} />
      <Kpi value={metrics?.okRate1h == null ? '—' : `${Math.round(metrics.okRate1h * 100)}%`} label="call ok · 1h" />
      <Kpi value={metrics?.p50_1h == null ? '—' : fmtDuration(metrics.p50_1h)} label="p50 latency" />
      <Kpi value={`${pending > 0 ? '▲ ' : ''}${pending}`} label="chờ duyệt" warn={pending > 0} />
      <Link href="/tickets/new" className={styles.newBtn}>+ Ticket mới</Link>
      <span className={styles.spacer} />
      <span className={`${styles.conn} ${conn === 'disconnected' ? styles.connBad : ''}`} role="status" aria-live="polite">
        {label}
      </span>
    </header>
  );
}

function Kpi({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className={styles.kpi}>
      <span className={`${styles.v} mono`} data-warn={warn ? 'true' : undefined}>{value}</span>
      <span className={styles.l}>{label}</span>
    </div>
  );
}
