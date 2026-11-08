'use client';
import { useEffect, useRef, useState } from 'react';
import { postJson } from '../lib/liveStore';
import { feedbackFileError } from '../lib/tickets';
import { FEEDBACK_EXT, FEEDBACK_IMAGES_MAX } from '@/src/tickets/model';
import styles from './TicketHeader.module.css';

interface Shot { key: number; name: string; type: string; data: string; url: string }

const readBase64 = (f: File): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error ?? new Error('không đọc được ảnh'));
  r.readAsDataURL(f);
});

/** Form "Góp ý để làm tiếp": nhận xét + ảnh dán (Ctrl+V), kéo thả hoặc chọn file; gửi cho Controller lập kế hoạch sửa. */
export default function FeedbackForm({ ticketId, onClose }: { ticketId: string; onClose(): void }) {
  const [text, setText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(1);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  useEffect(() => () => { for (const s of shotsRef.current) URL.revokeObjectURL(s.url); }, []);

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    setError(null);
    const added: Shot[] = [];
    for (const f of imgs) {
      const name = f.name && f.name !== 'image.png' ? f.name : `ảnh dán ${nextKey.current}${FEEDBACK_EXT[f.type] ?? ''}`;
      const why = feedbackFileError({ name, type: f.type, size: f.size }, shotsRef.current.length + added.length);
      if (why) { setError(why); break; }
      try {
        added.push({ key: nextKey.current++, name, type: f.type, data: await readBase64(f), url: URL.createObjectURL(f) });
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    if (added.length) setShots((s) => [...s, ...added]);
  };
  const remove = (key: number) => setShots((s) => s.filter((x) => {
    if (x.key === key) URL.revokeObjectURL(x.url);
    return x.key !== key;
  }));
  const submit = async () => {
    if (!text.trim() && !shots.length) return;
    setBusy(true); setError(null);
    try {
      await postJson(`/api/tickets/${ticketId}/feedback`, { text: text.trim(), images: shots.map(({ name, type, data }) => ({ name, type, data })) });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <form
      className={styles.guide}
      aria-label="Góp ý để làm tiếp"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); void addFiles(fs); } }}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles([...e.dataTransfer.files]); }}
    >
      <textarea
        autoFocus className={styles.ta} value={text} onChange={(e) => setText(e.target.value)} rows={3}
        aria-label="Nhận xét cho Controller" placeholder="Chỗ nào chưa vừa ý? Viết nhận xét, dán (Ctrl+V) hoặc kéo ảnh chụp màn hình vào đây…"
      />
      <div className={styles.shots}>
        {shots.map((s) => (
          <figure key={s.key} className={styles.shot} title={s.name}>
            <img src={s.url} alt={s.name} />
            <button type="button" className={styles.shotX} aria-label={`Bỏ ${s.name}`} onClick={() => remove(s.key)}>×</button>
          </figure>
        ))}
        {shots.length < FEEDBACK_IMAGES_MAX && (
          <button type="button" className={styles.drop} data-over={over || undefined} onClick={() => fileRef.current?.click()}>
            Dán (Ctrl+V), kéo ảnh vào, hoặc bấm để chọn · tối đa {FEEDBACK_IMAGES_MAX} ảnh, 5MB/ảnh
          </button>
        )}
        <input
          ref={fileRef} type="file" accept={Object.keys(FEEDBACK_EXT).join(',')} multiple hidden
          onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }}
        />
      </div>
      <span className={styles.hint}>Controller xem góp ý và ảnh, lập kế hoạch sửa để bạn duyệt rồi mới làm tiếp trên cùng worktree và nhánh.</span>
      {error && <div role="alert" className={styles.err}>{error}</div>}
      <span className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={busy || (!text.trim() && !shots.length)}>{busy ? 'Đang gửi…' : 'Gửi cho Controller'}</button>
        <button type="button" className={styles.btn} onClick={onClose}>Đóng</button>
      </span>
    </form>
  );
}
