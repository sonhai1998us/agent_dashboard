'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { postJson, useLive } from '../lib/liveStore';
import { ticketStatusText } from '../lib/tickets';
import styles from './TicketHeader.module.css';

export default function TicketHeader() {
  const id = useLive((s) => s.selectedTicketId);
  const t = useLive((s) => (s.selectedTicketId ? s.tickets[s.selectedTicketId] ?? null : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { setError(null); setGuiding(false); setGuidance(''); }, [id]);
  if (!t) return null;

  const st = ticketStatusText(t);
  const cancellable = t.status === 'planning' || t.status === 'awaiting_approval' || t.status === 'running' || t.status === 'escalated';
  const removable = (t.status === 'done' || t.status === 'escalated' || t.status === 'cancelled') && !!t.worktree;

  const act = async (path: string, body: unknown, after?: () => void) => {
    setBusy(true); setError(null);
    try { await postJson(`/api/tickets/${t.id}/${path}`, body); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };

  return (
    <section className={styles.box} aria-label={`Ticket ${t.id}`}>
      <div className={styles.row}>
        <strong className={styles.title}>{t.title}</strong>
        <span className={`${styles.id} mono`}>{t.id}</span>
        <span className={styles.st} data-tone={st.tone}>{st.icon} {st.text}</span>
        <span className={styles.actions}>
          {t.status === 'awaiting_approval' && <Link href={`/tickets/${t.id}/plan`} className={styles.btn}>Duyệt kế hoạch</Link>}
          {t.status === 'escalated' && !guiding && (
            <button type="button" className={styles.btn} onClick={() => setGuiding(true)}>Tiếp tục kèm chỉ đạo</button>
          )}
          {cancellable && (
            <button
              type="button" className={styles.btn} disabled={busy}
              onClick={() => { if (confirm(`Huỷ ticket ${t.id}? Các agent đang chạy sẽ bị dừng, worktree được giữ lại.`)) void act('cancel', {}); }}
            >Huỷ ticket</button>
          )}
          {removable && (
            <button
              type="button" className={styles.btn} disabled={busy}
              onClick={() => { if (confirm(`Xoá worktree của ticket ${t.id}? Nhánh vẫn được giữ lại.`)) void act('remove-worktree', {}); }}
            >Xoá worktree</button>
          )}
        </span>
      </div>
      {(t.branch || t.worktree) && (
        <div className={`${styles.paths} mono`}>
          {t.branch && (
            <span>nhánh {t.branch} <button type="button" className={styles.copy} aria-label="Sao chép tên nhánh" onClick={() => copy('b', t.branch!)}>{copied === 'b' ? 'đã chép' : 'chép'}</button></span>
          )}
          {t.worktree && (
            <span>worktree {t.worktree} <button type="button" className={styles.copy} aria-label="Sao chép đường dẫn worktree" onClick={() => copy('w', t.worktree!)}>{copied === 'w' ? 'đã chép' : 'chép'}</button></span>
          )}
        </div>
      )}
      {t.status === 'done' && t.diffStat && <pre className={`${styles.diff} mono`}>{t.diffStat}</pre>}
      {guiding && (
        <form
          className={styles.guide}
          onSubmit={(e) => { e.preventDefault(); if (guidance.trim()) void act('continue', { guidance: guidance.trim() }, () => { setGuiding(false); setGuidance(''); }); }}
        >
          <textarea
            className={styles.ta} value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3}
            aria-label="Chỉ đạo cho Controller" placeholder="Chỉ đạo cho Controller…"
          />
          <span className={styles.actions}>
            <button type="submit" className={styles.btn} disabled={busy || !guidance.trim()}>Gửi</button>
            <button type="button" className={styles.btn} onClick={() => setGuiding(false)}>Đóng</button>
          </span>
        </form>
      )}
      {error && <div role="alert" className={styles.err}>{error}</div>}
    </section>
  );
}
