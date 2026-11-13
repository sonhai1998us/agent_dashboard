'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { postJson, useLive } from '../lib/liveStore';
import { canFeedback, canMerge, mergeText, previewLabel, reportBlocks, statusAction, ticketCost, ticketDuration, ticketStatusText, type Inline } from '../lib/tickets';
import { fmtCost, fmtDuration } from '../lib/format';
import type { FeedbackEntry, MergeMode, Ticket } from '@/src/tickets/model';
import FeedbackForm from './FeedbackForm';
import FeedbackHistory from './FeedbackHistory';
import styles from './TicketHeader.module.css';

const MERGE_MODE_KEY = 'acctv.merge.mode';
const loadMode = (): MergeMode => { try { return localStorage.getItem(MERGE_MODE_KEY) === 'squash' ? 'squash' : 'commit'; } catch { return 'commit'; } };
const saveMode = (m: MergeMode): void => { try { localStorage.setItem(MERGE_MODE_KEY, m); } catch { /* bộ nhớ trình duyệt bị chặn: chỉ mất lựa chọn */ } };

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
function Cost({ id }: { id: string }) {
  // selector trả số: chỉ render lại khi tổng đổi
  const usd = useLive((s) => ticketCost(s.managed, id));
  if (usd === null) return null;
  return <span className={`${styles.dur} mono`} title="Tổng chi phí: Controller và mọi agent con">{fmtCost(usd)}</span>;
}

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
  const preview = useLive((s) => (s.selectedTicketId ? s.previews[s.selectedTicketId] ?? null : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [targets, setTargets] = useState<string[] | null>(null);
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<MergeMode>('commit');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [history, setHistory] = useState<FeedbackEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const updatedAt = t?.updatedAt;
  const reportRef = useRef<HTMLElement>(null);

  useEffect(() => { setError(null); setGuiding(false); setGuidance(''); setMergeOpen(false); setTargets(null); setFeedbackOpen(false); setHistoryOpen(false); setHistory([]); }, [id]);
  // góp ý mới luôn đổi trạng thái ticket (updatedAt) → đọc lại lịch sử
  useEffect(() => {
    if (!id) return;
    let stale = false;
    fetch(`/api/tickets/${encodeURIComponent(id)}/feedback-history`)
      .then((r) => (r.ok ? r.json() as Promise<FeedbackEntry[]> : []))
      .then((list) => { if (!stale) setHistory(list); })
      .catch(() => {});
    return () => { stale = true; };
  }, [id, updatedAt]);
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
  const openMerge = async () => {
    setMergeOpen(true); setTargets(null); setError(null); setMode(loadMode());
    try {
      const r = await fetch(`/api/tickets/${t.id}/merge-targets`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      const m = j as { branches: string[]; defaultTarget: string | null };
      setTargets(m.branches.filter((b) => b !== t.branch));
      setTarget(m.defaultTarget ?? '');
    } catch (e) { setMergeOpen(false); setError(e instanceof Error ? e.message : String(e)); }
  };
  const merged = mergeText(t.merge);
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
        <Cost id={t.id} />
        {preview && preview.state !== 'stopped' && (
          <span
            className={`${styles.st} mono`}
            data-tone={preview.state === 'failed' ? 'crit' : preview.state === 'ready' ? 'ok' : 'warn'}
            title={preview.state === 'failed' ? `${preview.error ?? ''}\n${preview.logTail}`.trim() : preview.envFiles.length ? `env: ${preview.envFiles.join(', ')}` : undefined}
          >{previewLabel(preview)}</span>
        )}
        <span className={styles.actions}>
          {preview && preview.state !== 'stopped' && (
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void act('preview/stop', {})}>Tắt server</button>
          )}
          {t.status === 'awaiting_approval' && <Link href={`/tickets/${t.id}/plan`} className={styles.btn}>Duyệt kế hoạch</Link>}
          {t.status === 'escalated' && !guiding && (
            <button type="button" className={styles.btn} onClick={() => setGuiding(true)}>Tiếp tục kèm chỉ đạo</button>
          )}
          {canFeedback(t) && !feedbackOpen && (
            <button type="button" className={styles.btn} onClick={() => setFeedbackOpen(true)}>Góp ý để làm tiếp</button>
          )}
          {history.length > 0 && !historyOpen && (
            <button type="button" className={styles.btn} onClick={() => setHistoryOpen(true)}>Lịch sử góp ý ({history.length})</button>
          )}
          {cancellable && (
            <button
              type="button" className={styles.btn} disabled={busy}
              onClick={() => { if (confirm(`Huỷ ticket ${t.id}? Các agent đang chạy sẽ bị dừng, worktree được giữ lại.`)) void act('cancel', {}); }}
            >Huỷ ticket</button>
          )}
          {canMerge(t) && !mergeOpen && (
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void openMerge()}>Merge vào nhánh…</button>
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
          {t.baseBranch && (
            <span>từ {t.baseBranch}</span>
          )}
          {t.worktree && (
            <span>worktree {t.worktree} <button type="button" className={styles.copy} aria-label="Sao chép đường dẫn worktree" onClick={() => copy('w', t.worktree!)}>{copied === 'w' ? 'đã chép' : 'chép'}</button></span>
          )}
        </div>
      )}
      {merged && t.merge && (
        <div className={styles.merge} data-tone={merged.tone} role={t.merge.result === 'conflict' ? 'status' : undefined}>
          <span className="mono">{merged.text}</span>
          {t.merge.result === 'conflict' && (
            <>
              <div>Sửa các file sau trong <code className="mono">{t.dir}</code> rồi commit (hoặc <code className="mono">{t.merge.squash ? 'git reset --merge' : 'git merge --abort'}</code> để huỷ):</div>
              <ul className={`${styles.files} mono`}>{t.merge.conflicts.map((f) => <li key={f}>{f}</li>)}</ul>
            </>
          )}
          {t.merge.result === 'staged' && t.merge.files.length > 0 && (
            <>
              <div>Các file đã stage trong <code className="mono">{t.dir}</code>. Xem trong Source Control của IDE rồi tự commit (hoặc <code className="mono">git reset --merge</code> để bỏ):</div>
              <ul className={`${styles.files} mono`}>{t.merge.files.slice(0, 20).map((f) => <li key={f}>{f}</li>)}{t.merge.files.length > 20 && <li>… và {t.merge.files.length - 20} file nữa</li>}</ul>
            </>
          )}
        </div>
      )}
      {mergeOpen && (
        <form
          className={styles.mergeForm}
          onSubmit={(e) => { e.preventDefault(); if (target) { saveMode(mode); void act('merge', { target, mode }, () => setMergeOpen(false)); } }}
        >
          {targets === null ? <span className={styles.dur}>đang đọc nhánh…</span> : targets.length === 0 ? (
            <span className={styles.dur}>Dự án không có nhánh nào khác để merge vào.</span>
          ) : (
            <>
              <label className={styles.mergeLabel}>
                Merge <code className="mono">{t.branch}</code> vào
                <select className={styles.select} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Nhánh đích">
                  {targets.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <span className={styles.modes} role="radiogroup" aria-label="Kiểu merge">
                <label><input type="radio" name="merge-mode" checked={mode === 'commit'} onChange={() => setMode('commit')} /> Merge và commit luôn</label>
                <label><input type="radio" name="merge-mode" checked={mode === 'squash'} onChange={() => setMode('squash')} /> Chỉ đưa thay đổi vào, chưa commit (xem trong IDE rồi tự commit)</label>
              </span>
              <span className={styles.hint}>Chạy trong <code className="mono">{t.dir}</code>. Phần dang dở trong worktree được commit trước. Có xung đột thì để nguyên cho bạn xử lý.</span>
            </>
          )}
          <span className={styles.actions}>
            <button type="submit" className={styles.btn} disabled={busy || !target || !targets?.length}>{busy ? 'Đang merge…' : mode === 'squash' ? 'Đưa vào' : 'Merge'}</button>
            <button type="button" className={styles.btn} onClick={() => setMergeOpen(false)}>Đóng</button>
          </span>
        </form>
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
      {historyOpen && history.length > 0 && <FeedbackHistory ticketId={t.id} items={history} onClose={() => setHistoryOpen(false)} />}
      {feedbackOpen && canFeedback(t) && <FeedbackForm ticketId={t.id} onClose={() => setFeedbackOpen(false)} />}
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
