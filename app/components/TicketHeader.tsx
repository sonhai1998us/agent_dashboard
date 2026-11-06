'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { postJson, useLive } from '../lib/liveStore';
import { reportBlocks, statusAction, ticketDuration, ticketStatusText, type Inline } from '../lib/tickets';
import { fmtDuration } from '../lib/format';
import type { Ticket } from '@/src/tickets/model';
import styles from './TicketHeader.module.css';

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p.style === 'bold' ? <strong>{p.text}</strong> : p.style === 'code' ? <code className="mono">{p.text}</code> : p.text}</Fragment>
      ))}
    </>
  );
}

/** Báo cáo cuối của Controller; escalated thì là điều người dùng cần quyết. */
function Report({ text }: { text: string }) {
  return (
    <div className={styles.reportBody}>
      {reportBlocks(text).map((b, i) =>
        b.kind === 'li'
          ? <div key={i} className={styles.li}><span className={styles.marker}>{b.marker}</span><span><Parts parts={b.parts} /></span></div>
          : <p key={i} className={styles.p}><Parts parts={b.parts} /></p>,
      )}
    </div>
  );
}

/** Tổng thời gian ticket; ticket còn chạy thì đếm mỗi giây. */
function Duration({ t }: { t: Ticket }) {
  const agents = useLive((s) => s.agents);
  const waits = useLive((s) => s.waits);
  const [now, setNow] = useState(() => Date.now());
  const d = useMemo(() => ticketDuration(t, Object.values(agents), Object.values(waits), now), [t, agents, waits, now]);
  useEffect(() => {
    if (!d.live) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [d.live]);
  return (
    <span className={styles.dur} title="Từ lúc tạo ticket tới khi xong (gồm thời gian chờ duyệt)">
      tổng {fmtDuration(d.totalMs)}{d.approvalMs >= 1000 ? ` · chờ duyệt ${fmtDuration(d.approvalMs)}` : ''}
    </span>
  );
}

export default function TicketHeader() {
  const id = useLive((s) => s.selectedTicketId);
  const t = useLive((s) => (s.selectedTicketId ? s.tickets[s.selectedTicketId] ?? null : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const reportRef = useRef<HTMLElement>(null);

  useEffect(() => { setError(null); setGuiding(false); setGuidance(''); }, [id]);
  if (!t) return null;

  const st = ticketStatusText(t);
  const action = statusAction(t);
  const openDecision = () => {
    setGuiding(true);
    reportRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    reportRef.current?.focus({ preventScroll: true });
  };
  const badge = <>{st.icon} {st.text}</>;
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
        {action?.kind === 'plan' ? (
          <Link href={action.href} className={`${styles.st} ${styles.stLink}`} data-tone={st.tone} title={action.label}>{badge}</Link>
        ) : action?.kind === 'decide' ? (
          <button type="button" className={`${styles.st} ${styles.stLink}`} data-tone={st.tone} title={action.label} aria-label={action.label} onClick={openDecision}>{badge}</button>
        ) : (
          <span className={styles.st} data-tone={st.tone}>{badge}</span>
        )}
        <Duration t={t} />
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
      {t.status === 'escalated' && (
        <section ref={reportRef} tabIndex={-1} className={styles.decide} aria-label="Controller cần bạn quyết">
          <div className={styles.decideHead}>Controller cần bạn quyết</div>
          {t.report?.trim() ? <Report text={t.report} /> : <p className={styles.p}>Controller không để lại báo cáo. Xem log của Controller bên dưới.</p>}
          {t.diffStat?.trim() && <pre className={`${styles.diff} mono`}>{t.diffStat}</pre>}
        </section>
      )}
      {t.status === 'done' && t.report?.trim() && (
        <details className={styles.reportDone}>
          <summary>Báo cáo của Controller</summary>
          <Report text={t.report} />
        </details>
      )}
      {guiding && (
        <form
          className={styles.guide}
          onSubmit={(e) => { e.preventDefault(); if (guidance.trim()) void act('continue', { guidance: guidance.trim() }, () => { setGuiding(false); setGuidance(''); }); }}
        >
          <textarea
            autoFocus className={styles.ta} value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3}
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
