'use client';
import { useMemo, useRef, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { selectTicket, useLive } from '../lib/liveStore';
import { ticketStatusText } from '../lib/tickets';
import styles from './TicketList.module.css';

export default function TicketList() {
  const ticketsMap = useLive((s) => s.tickets);
  const selected = useLive((s) => s.selectedTicketId);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => Object.values(ticketsMap).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => ({ t, st: ticketStatusText(t) })),
    [ticketsMap],
  );

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
    <nav className={styles.box} aria-label="Ticket">
      <h2 className={styles.h}>Ticket</h2>
      <div className={styles.list} ref={listRef} onKeyDown={onKey}>
        {rows.length === 0 && <div className={styles.empty}>Chưa có ticket. Bấm + Ticket mới để bắt đầu.</div>}
        {rows.map(({ t, st }) => (
          <div key={t.id} className={styles.item}>
            <button
              data-row type="button"
              className={`${styles.row} ${selected === t.id ? styles.sel : ''} ${st.tone === 'ended' ? styles.dim : ''}`}
              aria-current={selected === t.id ? 'true' : undefined}
              onClick={() => selectTicket(t.id)}
            >
              <span className={styles.l1}><span className={styles.title}>{t.title}</span></span>
              <span className={styles.meta}>
                <span className={`${styles.id} mono`}>{t.id}</span>
                <span className={styles.st} data-tone={st.tone}>{st.icon} {st.text}</span>
              </span>
            </button>
            {t.status === 'awaiting_approval' && (
              <Link href={`/tickets/${t.id}/plan`} className={styles.approve}>Duyệt kế hoạch →</Link>
            )}
          </div>
        ))}
      </div>
    </nav>
  );
}
