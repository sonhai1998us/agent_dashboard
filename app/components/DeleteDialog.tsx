'use client';
import { useEffect, useRef, useState } from 'react';
import type { PurgeItem } from '@/src/core/purge';
import { postJson } from '../lib/liveStore';
import styles from './UserActionDialog.module.css';
import own from './DeleteDialog.module.css';

export interface DeleteRequest { tickets: string[]; sessions: string[] }

/** Hỏi xác nhận rồi xoá hẳn ticket/phiên. Danh sách những gì sẽ mất lấy từ server (dryRun). */
export default function DeleteDialog({ req, onClose }: { req: DeleteRequest | null; onClose: (deleted: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<PurgeItem[] | null>(null);
  const [done, setDone] = useState<PurgeItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    setItems(null); setDone(null); setErr(null); setBusy(false);
    if (!req) { if (d.open) d.close(); return; }
    if (!d.open) d.showModal();
    let live = true;
    postJson<{ items: PurgeItem[] }>('/api/delete', { ...req, dryRun: true })
      .then((r) => { if (live) setItems(r.items); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [req]);

  const ok = (items ?? []).filter((i) => !i.blocked);
  const skipped = (items ?? []).filter((i) => i.blocked);
  const failed = (done ?? []).filter((i) => i.errors.length);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson<{ items: PurgeItem[] }>('/api/delete', {
        tickets: ok.filter((i) => i.kind === 'ticket').map((i) => i.id),
        sessions: ok.filter((i) => i.kind === 'session').map((i) => i.id),
      });
      if (r.items.some((i) => i.errors.length || i.blocked)) setDone(r.items);
      else onClose(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref} className={`${styles.dlg} ${own.dlg}`} aria-labelledby="del-title"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(!!done); }}
    >
      {done ? (
        <>
          <h2 id="del-title" className={styles.title}>Đã xoá, một số phần bị lỗi</h2>
          <ul className={own.list}>
            {failed.map((i) => (
              <li key={i.id}><b>{i.label}</b>{i.errors.map((e) => <div key={e} className={styles.err}>{e}</div>)}</li>
            ))}
            {done.filter((i) => i.blocked).map((i) => <li key={i.id}><b>{i.label}</b>: {i.blocked}</li>)}
          </ul>
          <div className={styles.actions}><span className={styles.spacer} /><button type="button" className={styles.btn} onClick={() => onClose(true)}>Đóng</button></div>
        </>
      ) : (
        <>
          <h2 id="del-title" className={styles.title}>
            {items ? (ok.length ? `Xoá vĩnh viễn ${ok.length} mục?` : 'Không có mục nào xoá được') : 'Đang kiểm tra…'}
          </h2>
          {ok.length > 0 && (
            <ul className={own.list}>
              {ok.map((i) => (
                <li key={i.id}>
                  <b>{i.label}</b>: {i.what.join(', ')}
                  {i.warning && <div className={own.warn}>⚠ {i.warning}</div>}
                </li>
              ))}
            </ul>
          )}
          {skipped.length > 0 && (
            <>
              <span className={styles.lbl}>Bỏ qua, không xoá được</span>
              <ul className={`${own.list} ${own.muted}`}>{skipped.map((i) => <li key={i.id}><b>{i.label}</b>: {i.blocked}</li>)}</ul>
            </>
          )}
          {err && <div role="alert" className={styles.err}>{err}</div>}
          <div className={styles.actions}>
            <span className={styles.spacer} />
            <button type="button" className={styles.btn} disabled={busy} onClick={() => onClose(false)}>Huỷ</button>
            <button type="button" className={`${styles.btn} ${own.danger}`} disabled={busy || !ok.length} onClick={() => void run()}>
              {busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
