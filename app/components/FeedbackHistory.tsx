'use client';
import type { FeedbackEntry } from '@/src/tickets/model';
import { FEEDBACK_KIND_LABEL, fmtDateTime } from '../lib/tickets';
import styles from './TicketHeader.module.css';

/** Các lần người dùng góp ý cho Controller của ticket, mới nhất trước. */
export default function FeedbackHistory({ ticketId, items, onClose }: { ticketId: string; items: FeedbackEntry[]; onClose: () => void }) {
  return (
    <section className={styles.history} aria-label="Lịch sử góp ý">
      <div className={styles.historyHead}>
        <span>Lịch sử góp ý · {items.length} lần</span>
        <button type="button" className={styles.btn} onClick={onClose}>Đóng</button>
      </div>
      <ol className={styles.historyList}>
        {items.map((f) => (
          <li key={f.id} className={styles.historyItem}>
            <div className={styles.historyMeta}>
              <span className={styles.kind} data-kind={f.kind}>{FEEDBACK_KIND_LABEL[f.kind]}</span>
              <time className="mono" dateTime={new Date(f.at).toISOString()}>{fmtDateTime(f.at)}</time>
              {f.images.length > 0 && <span>{f.images.length} ảnh</span>}
            </div>
            {f.text ? <p className={styles.historyText}>{f.text}</p> : <p className={styles.dur}>(chỉ có ảnh)</p>}
            {f.images.length > 0 && (
              <div className={styles.shots}>
                {f.images.map((name, i) => {
                  const src = `/api/tickets/${encodeURIComponent(ticketId)}/feedback-images/${encodeURIComponent(name)}`;
                  return (
                    <a key={name} href={src} target="_blank" rel="noreferrer" className={styles.shot} title={`Mở ảnh ${i + 1}`}>
                      <img src={src} alt={`Ảnh góp ý ${i + 1}`} loading="lazy" />
                    </a>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
