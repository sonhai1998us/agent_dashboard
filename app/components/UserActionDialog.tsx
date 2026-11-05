'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { postJson, selectTicket, useLive } from '../lib/liveStore';
import { OPEN_USER_ACTIONS, pendingUserActions, safeHttpUrl } from '../lib/userActions';
import styles from './UserActionDialog.module.css';

/**
 * Hộp thoại khi agent cần người dùng làm gì đó (đăng nhập, mở link…).
 * Tự mở khi có yêu cầu mới; "Để sau" ẩn yêu cầu đó cho tới khi mở lại từ thanh trên hoặc panel agent.
 */
export default function UserActionDialog() {
  const managed = useLive((s) => s.managed);
  const tickets = useLive((s) => s.tickets);
  const agents = useLive((s) => s.agents);
  const pending = useMemo(
    () => pendingUserActions(managed, tickets, Object.fromEntries(Object.values(agents).map((a) => [a.id, a.label ?? undefined]))),
    [managed, tickets, agents],
  );
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [focusAgent, setFocusAgent] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  const visible = pending.filter((p) => !hidden.has(p.action.id));
  const cur = visible.find((p) => p.agentId === focusAgent) ?? visible[0] ?? null;
  const index = cur ? visible.indexOf(cur) : -1;

  useEffect(() => {
    const open = (e: Event) => {
      setHidden(new Set());
      setFocusAgent((e as CustomEvent<string | null>).detail ?? null);
    };
    window.addEventListener(OPEN_USER_ACTIONS, open);
    return () => window.removeEventListener(OPEN_USER_ACTIONS, open);
  }, []);

  // mỗi yêu cầu mới: xoá ghi chú / lỗi cũ
  const curId = cur?.action.id ?? null;
  useEffect(() => { setNote(''); setErr(null); setCopied(false); }, [curId]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (cur && !d.open) d.showModal();
    if (!cur && d.open) d.close();
  }, [cur]);

  // tab trình duyệt báo có việc chờ
  const count = pending.length;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) cần bạn · /, '');
    document.title = count ? `(${count}) cần bạn · ${base}` : base;
  }, [count]);

  if (!cur) return <dialog ref={ref} className={styles.dlg} aria-label="Agent cần bạn" />;
  const url = safeHttpUrl(cur.action.url);

  const later = () => setHidden((h) => new Set(h).add(cur.action.id));
  const answer = async (done: boolean) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await postJson(`/api/agents/${encodeURIComponent(cur.agentId)}/user-action`, { done, note: note.trim() }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const copy = () => {
    if (!cur.action.command) return;
    void navigator.clipboard?.writeText(cur.action.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  return (
    <dialog
      ref={ref} className={styles.dlg} aria-labelledby="ua-title"
      onCancel={(e) => { e.preventDefault(); later(); }}
    >
      <div className={styles.head}>
        <span className={styles.kicker}>Agent cần bạn</span>
        {visible.length > 1 && <span className={`${styles.count} mono`}>{index + 1}/{visible.length}</span>}
      </div>
      <h2 id="ua-title" className={styles.title}>{cur.action.title}</h2>
      <div className={styles.meta}>
        <button type="button" className={styles.metaLink} onClick={() => { selectTicket(cur.ticketId); later(); }}>
          {cur.ticketTitle} · {cur.ticketId}
        </button>
        <span className="mono">{cur.label}</span>
      </div>
      <p className={styles.msg}>{cur.action.message}</p>

      {url && (
        <div className={styles.block}>
          <span className={styles.lbl}>Link</span>
          <a className={styles.openLink} href={url} target="_blank" rel="noopener noreferrer">Mở link ↗</a>
          <span className={`${styles.url} mono`}>{url}</span>
        </div>
      )}
      {cur.action.command && (
        <div className={styles.block}>
          <span className={styles.lbl}>Chạy trong terminal của bạn</span>
          <div className={styles.cmdRow}>
            <code className={`${styles.cmd} mono`}>{cur.action.command}</code>
            <button type="button" className={styles.btn} onClick={copy}>{copied ? 'Đã chép' : 'Chép lệnh'}</button>
          </div>
        </div>
      )}

      <label className={styles.lbl} htmlFor="ua-note">Ghi chú cho agent (không bắt buộc)</label>
      <textarea
        id="ua-note" className={styles.note} rows={2} value={note} maxLength={2000}
        onChange={(e) => setNote(e.target.value)} placeholder="vd. đã đăng nhập bằng tài khoản công ty"
      />
      {err && <div role="alert" className={styles.err}>{err}</div>}

      <div className={styles.actions}>
        <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => void answer(true)}>
          {busy ? 'Đang gửi…' : 'Đã xong, tiếp tục'}
        </button>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void answer(false)}>Không làm được</button>
        <span className={styles.spacer} />
        {visible.length > 1 && (
          <button type="button" className={styles.btn} onClick={() => setFocusAgent(visible[(index + 1) % visible.length].agentId)}>Yêu cầu khác</button>
        )}
        <button type="button" className={styles.btn} onClick={later}>Để sau</button>
      </div>
    </dialog>
  );
}
