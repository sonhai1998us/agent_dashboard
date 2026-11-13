'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLive } from '../../lib/liveStore';
import { recentDirs } from '../../lib/recentDirs';
import { pickerStart } from '../../lib/dirs';
import FolderPicker from '../../components/FolderPicker';
import { baseChoice, defaultBaseFrom, roleOverrides } from '../../lib/tickets';
import type { AgentKind, Effort, Role, RoleSpec } from '@/src/tickets/model';
import styles from './NewTicketForm.module.css';

interface GitInfo { exists: boolean; isGit: boolean; branch: string | null; head: string | null; dirty: boolean; branches?: string[] }
interface SettingsRes { settings: { allowedModels: Record<AgentKind, string[]>; roleDefaults: Record<Role, RoleSpec> } }

const ROLES: { role: Role; label: string }[] = [
  { role: 'controller', label: 'Controller' },
  { role: 'explorer', label: 'Explorer' },
  { role: 'dev', label: 'Dev' },
  { role: 'designer', label: 'Designer' },
  { role: 'qc', label: 'QC' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export default function NewTicketForm({ initialDir = '' }: { initialDir?: string }) {
  const router = useRouter();
  const tickets = useLive((s) => s.tickets);
  const dirs = useMemo(() => recentDirs(Object.values(tickets)), [tickets]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dir, setDir] = useState(initialDir);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [settings, setSettings] = useState<SettingsRes['settings'] | null>(null);
  const [caps, setCaps] = useState<Record<AgentKind, boolean> | null>(null);
  const [specs, setSpecs] = useState<Record<Role, RoleSpec> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [base, setBase] = useState('');
  const [baseFrom, setBaseFrom] = useState('');

  useEffect(() => {
    json<SettingsRes>('/api/settings').then((r) => {
      if (r.status !== 200 || !r.body.settings) return;
      setSettings(r.body.settings);
      setSpecs(r.body.settings.roleDefaults);
    }).catch(() => {});
    json<Record<AgentKind, boolean>>('/api/capabilities').then((r) => { if (r.status === 200) setCaps(r.body); }).catch(() => {});
  }, []);

  const applyGit = (g: GitInfo | null) => {
    setGit(g);
    setBase(g?.branch ?? '');
    setBaseFrom('');
  };

  useEffect(() => {
    const d = dir.trim();
    setGit(null);
    if (!d) { setChecking(false); return; }
    setChecking(true);
    let stale = false;
    const h = setTimeout(() => {
      json<GitInfo>(`/api/fs/check?dir=${encodeURIComponent(d)}`)
        .then((r) => {
          if (stale) return;
          applyGit(r.status === 200 ? r.body : null);
          setChecking(false);
        })
        .catch(() => { if (!stale) setChecking(false); });
    }, 400);
    return () => { stale = true; clearTimeout(h); };
  }, [dir]);

  const gitInit = async () => {
    if (!confirm(`Chạy git init và tạo commit đầu tiên trong ${dir.trim()}?`)) return;
    setError(null);
    const r = await json<GitInfo & { error?: string }>('/api/fs/git-init', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: dir.trim() }),
    });
    const inited = r.status === 200 || r.status === 201;
    if (!inited) setError(r.body.error ?? 'Không khởi tạo được git');
    // kiểm tra lại để có danh sách nhánh cho ô Nhánh gốc (git-init không trả)
    const c = await json<GitInfo>(`/api/fs/check?dir=${encodeURIComponent(dir.trim())}`);
    if (c.status === 200) applyGit(c.body);
    else if (inited) applyGit(r.body);
  };

  const setSpec = (role: Role, patch: Partial<RoleSpec>) => {
    if (!specs || !settings) return;
    const next = { ...specs[role], ...patch };
    if (patch.agent && patch.agent !== specs[role].agent) {
      const allowed = settings.allowedModels[patch.agent] ?? [];
      if (!allowed.includes(next.model)) next.model = allowed[0] ?? next.model;
    }
    setSpecs({ ...specs, [role]: next });
  };

  // gửi lựa chọn đang hiển thị cho mọi vai, kể cả khi trùng mặc định: Controller phải dùng đúng
  const buildOverrides = (): Partial<Record<Role, Partial<RoleSpec>>> => (specs && settings ? roleOverrides(specs) : {});

  const branches = git?.branches ?? [];
  const { name: baseName, isNew: newBase } = baseChoice(branches, base);
  const from = baseFrom || defaultBaseFrom(branches, git?.branch ?? null) || '';
  const canSubmit = title.trim() !== '' && git?.isGit === true && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const overrides = buildOverrides();
      const r = await json<{ id?: string; error?: string; errors?: string[] }>('/api/tickets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined, dir: dir.trim(), ...(Object.keys(overrides).length ? { overrides } : {}),
          ...(baseName ? { baseBranch: baseName } : {}), ...(newBase ? { baseFrom: from } : {}) }),
      });
      if (r.status === 201 && r.body.id) { router.push(`/?ticket=${encodeURIComponent(r.body.id)}`); return; }
      setError(r.body.error ?? r.body.errors?.join('; ') ?? 'Không tạo được ticket');
    } catch {
      setError('Không kết nối được máy chủ');
    }
    setBusy(false);
  };

  return (
    <div className={styles.page}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.head}>
          <Link href="/" className={styles.back}>← Về bảng theo dõi</Link>
          <h1 className={styles.h1}>Tạo ticket</h1>
        </div>

        <div className={styles.field}>
          <label htmlFor="nt-title">Tiêu đề <span className={styles.req}>(bắt buộc)</span></label>
          <input id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required aria-required="true" />
        </div>

        <div className={styles.field}>
          <label htmlFor="nt-desc">Mô tả</label>
          <textarea id="nt-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className={styles.field}>
          <label htmlFor="nt-dir">Thư mục dự án</label>
          <div className={styles.dirRow}>
            <input id="nt-dir" className="mono" list="nt-dirs" value={dir} onChange={(e) => setDir(e.target.value)}
              placeholder="Bấm Chọn thư mục… (hoặc dán đường dẫn)" aria-describedby="nt-dir-status" autoComplete="off" spellCheck={false} />
            <button type="button" className={styles.pickBtn} onClick={() => setPicking(true)}>Chọn thư mục…</button>
          </div>
          <datalist id="nt-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
          <div id="nt-dir-status" className={styles.status} aria-live="polite">
            {dir.trim() && checking && <span className={styles.muted}>Đang kiểm tra…</span>}
            {!checking && git && !git.exists && <span className={styles.bad}>✗ Thư mục không tồn tại</span>}
            {!checking && git?.exists && !git.isGit && (
              <span className={styles.warn}>
                ▲ Không phải git repo{' '}
                <button type="button" className={styles.linkBtn} onClick={gitInit}>Khởi tạo git và commit đầu tiên</button>
              </span>
            )}
            {!checking && git?.isGit && (
              <>
                <span className={styles.ok}>✓ git · nhánh {git.branch ?? '(không rõ)'}</span>
                {git.dirty && (!baseName || baseName === git.branch) && <div className={styles.warn}>▲ Có thay đổi chưa commit; worktree được tạo từ HEAD nên sẽ không có các thay đổi này.</div>}
              </>
            )}
          </div>
        </div>

        {git?.isGit && branches.length > 0 && (
          <div className={styles.field}>
            <label htmlFor="nt-base">Nhánh gốc</label>
            <input id="nt-base" className="mono" list="nt-branches" value={base} onChange={(e) => setBase(e.target.value)}
              placeholder="Chọn nhánh có sẵn hoặc gõ tên nhánh mới" aria-describedby="nt-base-status" autoComplete="off" spellCheck={false} />
            <datalist id="nt-branches">{branches.map((b) => <option key={b} value={b} />)}</datalist>
            <div id="nt-base-status" className={styles.status} aria-live="polite">
              {newBase ? (
                <span className={styles.warn}>
                  ▲ Nhánh mới, sẽ tạo lúc duyệt plan từ{' '}
                  <select aria-label="Tạo nhánh mới từ" className="mono" value={from} onChange={(e) => setBaseFrom(e.target.value)}>
                    {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </span>
              ) : (
                <span className={styles.muted}>Worktree của ticket tách từ nhánh này; Merge mặc định về đây.</span>
              )}
            </div>
          </div>
        )}

        <FolderPicker
          open={picking} start={pickerStart(dir, dirs)} recent={dirs}
          onPick={(d) => { setDir(d); setPicking(false); }} onClose={() => setPicking(false)}
        />

        <details className={styles.roles}>
          <summary>Tuỳ chọn theo vai (Controller phải dùng đúng)</summary>
          {!specs || !settings ? <div className={styles.muted}>Đang tải cấu hình…</div> : (
            <div className={styles.grid} role="group" aria-label="Tuỳ chọn theo vai">
              {ROLES.map(({ role, label }) => {
                const s = specs[role];
                const models = settings.allowedModels[s.agent] ?? [];
                return (
                  <div key={role} className={styles.roleRow}>
                    <span className={styles.roleName}>{label}</span>
                    <label className={styles.sub}>
                      <span>Agent</span>
                      {/* Controller luôn là claude (cần MCP và hook guard) */}
                      <select value={s.agent} onChange={(e) => setSpec(role, { agent: e.target.value as AgentKind })}>
                        <option value="claude">claude</option>
                        {role !== 'controller' && <option value="codex" disabled={caps?.codex === false}>codex</option>}
                      </select>
                    </label>
                    <label className={styles.sub}>
                      <span>Model</span>
                      <select value={s.model} onChange={(e) => setSpec(role, { model: e.target.value })}>
                        {!models.includes(s.model) && <option value={s.model}>{s.model}</option>}
                        {models.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </label>
                    <label className={styles.sub}>
                      <span>Effort</span>
                      <select value={s.effort} onChange={(e) => setSpec(role, { effort: e.target.value as Effort })}>
                        {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </label>
                  </div>
                );
              })}
              {caps?.codex === false && <div className={styles.muted}>Codex CLI chưa được cài trên máy</div>}
            </div>
          )}
        </details>

        {error && <div role="alert" className={styles.err}>✗ {error}</div>}

        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={!canSubmit}>Tạo và giao cho Controller</button>
          <Link href="/" className={styles.cancel}>Huỷ</Link>
        </div>
      </form>
    </div>
  );
}
