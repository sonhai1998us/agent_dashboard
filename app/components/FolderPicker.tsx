'use client';
import { useEffect, useRef, useState } from 'react';
import { pathCrumbs } from '../lib/dirs';
import styles from './FolderPicker.module.css';

interface DirEntry { name: string; path: string; isGit: boolean }
interface DirListing { path: string | null; parent: string | null; isGit: boolean; entries: DirEntry[]; truncated: boolean }

interface Props {
  open: boolean;
  /** thư mục mở đầu; null hoặc không đọc được → danh sách ổ đĩa */
  start: string | null;
  recent: string[];
  onPick(dir: string): void;
  onClose(): void;
}

async function fetchDirs(dir: string | null): Promise<DirListing> {
  const res = await fetch(`/api/fs/dirs${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Lỗi ${res.status}`);
  return body as DirListing;
}

/**
 * Hộp thoại duyệt thư mục trên máy chạy dashboard. Trình duyệt không cho biết đường dẫn thật
 * của thư mục chọn bằng <input type="file">, nên danh sách lấy từ server (chỉ nghe 127.0.0.1).
 */
export default function FolderPicker({ open, start, recent, onPick, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const seq = useRef(0);

  const go = async (dir: string | null, fallback = false) => {
    const n = ++seq.current;
    setLoading(true); setErr(null);
    try {
      const l = await fetchDirs(dir);
      if (n !== seq.current) return;
      setListing(l); setFilter('');
    } catch (e) {
      if (n !== seq.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (fallback && dir !== null) {
        await go(null);
        setErr(`${msg}: ${dir}`);
        return;
      }
      setErr(msg);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    filterRef.current?.focus();
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); void go(start, true); }
    if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const q = filter.trim().toLowerCase();
  const entries = (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
  const crumbs = pathCrumbs(listing?.path ?? null);
  const here = listing?.path ?? null;

  return (
    <dialog
      ref={ref} className={styles.dlg} aria-labelledby="fp-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <h2 id="fp-title" className={styles.title}>Chọn thư mục dự án</h2>

      <nav className={styles.crumbs} aria-label="Đường dẫn">
        <button type="button" className={styles.crumb} onClick={() => void go(null)} aria-current={here === null ? 'location' : undefined}>
          Ổ đĩa
        </button>
        {crumbs.map((c, i) => (
          <span key={c.path} className={styles.crumbSeg}>
            <span className={styles.sep} aria-hidden="true">›</span>
            <button type="button" className={`${styles.crumb} mono`} onClick={() => void go(c.path)}
              aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      {recent.length > 0 && (
        <div className={styles.recent}>
          <span className={styles.lbl}>Gần đây</span>
          {recent.map((d) => (
            <button key={d} type="button" className={`${styles.chip} mono`} title={d} aria-label={`Chọn ${d}`} onClick={() => onPick(d)}>
              {pathCrumbs(d).at(-1)?.label ?? d}
            </button>
          ))}
        </div>
      )}

      <div className={styles.tools}>
        <button type="button" className={styles.btn} disabled={!listing || listing.path === null}
          onClick={() => void go(listing?.parent ?? null)} aria-label="Lên thư mục cha">↑ Lên</button>
        <input
          ref={filterRef} className={styles.filter} value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder="Lọc theo tên…" aria-label="Lọc thư mục theo tên" spellCheck={false}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // hộp thoại nằm trong form tạo ticket: Enter không được gửi form
            if (entries.length === 1) void go(entries[0].path);
          }}
        />
      </div>

      <ul className={styles.list} aria-label="Thư mục con" aria-busy={loading}>
        {loading && !listing && <li className={styles.empty}>Đang tải…</li>}
        {listing && entries.length === 0 && (
          <li className={styles.empty}>{q ? 'Không có thư mục nào khớp' : 'Không có thư mục con'}</li>
        )}
        {entries.map((e) => (
          <li key={e.path} className={styles.row}>
            <button type="button" className={styles.entry} onClick={() => void go(e.path)} title={e.path}>
              <span className={styles.icon} aria-hidden="true">▸</span>
              <span className={styles.name}>{e.name}</span>
              {e.isGit && <span className={styles.git}>git</span>}
            </button>
            {e.isGit && (
              <button type="button" className={styles.pickRow} onClick={() => onPick(e.path)} aria-label={`Chọn ${e.name}`}>Chọn</button>
            )}
          </li>
        ))}
        {listing?.truncated && <li className={styles.empty}>Chỉ hiện {listing.entries.length} thư mục đầu; gõ để lọc.</li>}
      </ul>
      {err && <div role="alert" className={styles.err}>✗ {err}</div>}

      <div className={styles.foot}>
        <div className={styles.cur}>
          <span className={styles.lbl}>Thư mục đang mở</span>
          <span className="mono">{here ?? '—'}</span>
          {here && <span className={listing?.isGit ? styles.ok : styles.muted}>{listing?.isGit ? '✓ git repo' : 'chưa phải git repo'}</span>}
        </div>
        <div className={styles.actions}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!here || loading} onClick={() => here && onPick(here)}>
            Chọn thư mục này
          </button>
          <button type="button" className={styles.btn} onClick={onClose}>Huỷ</button>
        </div>
      </div>
    </dialog>
  );
}
