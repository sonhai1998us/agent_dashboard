'use client';
import { useState } from 'react';
import { emptyProjectForm, type AccountForm, type ProjectForm } from '../lib/projectsForm';
import { postJson } from '../lib/liveStore';
import styles from './SettingsForm.module.css';

interface Props {
  projects: ProjectForm[];
  onChange(next: ProjectForm[]): void;
  errors: string[];
}

type ResetState = { busy: boolean; out: { code: number | null; tail: string } | null; error: string | null };

/** Settings > Dự án: server preview, đăng nhập test, tài khoản theo vai trò, reset dữ liệu. */
export default function ProjectsSection({ projects, onChange, errors }: Props) {
  const [reset, setReset] = useState<Record<number, ResetState>>({});
  const set = (i: number, p: Partial<ProjectForm>) => onChange(projects.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const setAcc = (i: number, k: number, a: Partial<AccountForm>) =>
    set(i, { accounts: projects[i].accounts.map((x, j) => (j === k ? { ...x, ...a } : x)) });

  const runReset = async (i: number) => {
    const p = projects[i];
    if (!confirm(`Chạy lệnh reset dữ liệu của dự án ${p.dir}?\n\n${p.resetCommand}\n\nDữ liệu trên backend local sẽ bị xoá và seed lại.`)) return;
    setReset((r) => ({ ...r, [i]: { busy: true, out: null, error: null } }));
    try {
      const out = await postJson<{ code: number | null; tail: string }>('/api/projects/reset-db', { dir: p.dir });
      setReset((r) => ({ ...r, [i]: { busy: false, out, error: null } }));
    } catch (e) {
      setReset((r) => ({ ...r, [i]: { busy: false, out: null, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const text = (i: number, k: keyof ProjectForm, label: string, ph?: string) => (
    <label className={styles.sub}>
      {label}
      <input className="mono" spellCheck={false} placeholder={ph} value={projects[i][k] as string} onChange={(e) => set(i, { [k]: e.target.value } as Partial<ProjectForm>)} />
    </label>
  );

  return (
    <>
      {projects.map((p, i) => {
        const r = reset[i];
        return (
          <details key={i} className={styles.project} open={!p.dir}>
            <summary className="mono">{p.dir || '(dự án mới)'}</summary>
            {text(i, 'dir', 'Thư mục dự án gốc (đường dẫn tuyệt đối)', 'D:\\Work\\app')}
            <div className={styles.two}>
              {text(i, 'dev', 'Lệnh dev ({port})')}
              <label className={styles.sub}>
                Chế độ mặc định
                <select value={p.defaultMode} onChange={(e) => set(i, { defaultMode: e.target.value as 'dev' | 'prod' })}>
                  <option value="dev">dev</option>
                  <option value="prod">prod</option>
                </select>
              </label>
              {text(i, 'build', 'Lệnh build (prod)')}
              {text(i, 'start', 'Lệnh start (prod, {port})')}
              {text(i, 'readyPath', 'Đường dẫn kiểm sẵn sàng', '/')}
              {text(i, 'healthUrl', 'URL kiểm backend (tuỳ chọn)', 'http://localhost:3001/api/v1/health')}
            </div>
            <label className={styles.sub}>
              Biến môi trường thêm cho server preview (mỗi dòng KEY=VALUE)
              <textarea rows={2} className="mono" spellCheck={false} value={p.env} onChange={(e) => set(i, { env: e.target.value })} />
            </label>

            <div className={styles.muted}>Đăng nhập (để trống nếu không cần)</div>
            <div className={styles.two}>
              {text(i, 'loginPath', 'Trang đăng nhập', '/login')}
              {text(i, 'submitSelector', 'Nút gửi', 'button[type=submit]')}
              {text(i, 'usernameSelector', 'Ô tên đăng nhập', '#email')}
              {text(i, 'passwordSelector', 'Ô mật khẩu', '#password')}
              <label className={styles.sub}>
                Dấu hiệu đăng nhập xong
                <select value={p.successKind} onChange={(e) => set(i, { successKind: e.target.value as 'url' | 'selector' })}>
                  <option value="url">URL không còn chứa…</option>
                  <option value="selector">Phần tử xuất hiện…</option>
                </select>
              </label>
              {text(i, 'successValue', p.successKind === 'url' ? 'Chuỗi trong URL' : 'Selector', p.successKind === 'url' ? '/login' : '[data-testid=avatar]')}
            </div>

            <div className={styles.muted}>Tài khoản test theo vai trò (agent chỉ thấy tên và mô tả)</div>
            {p.accounts.map((a, k) => (
              <div key={k} className={styles.accountRow}>
                <label className={styles.sub}>Tên<input className="mono" value={a.name} placeholder="owner" onChange={(e) => setAcc(i, k, { name: e.target.value })} /></label>
                <label className={styles.sub}>Mô tả<input value={a.description} placeholder="Chủ workspace" onChange={(e) => setAcc(i, k, { description: e.target.value })} /></label>
                <label className={styles.sub}>Tên đăng nhập<input className="mono" autoComplete="off" value={a.username} onChange={(e) => setAcc(i, k, { username: e.target.value })} /></label>
                <label className={styles.sub}>Mật khẩu<input type="password" className="mono" autoComplete="new-password" value={a.password} onChange={(e) => setAcc(i, k, { password: e.target.value })} /></label>
                <button type="button" className={styles.btn} aria-label={`Xoá tài khoản ${a.name || k + 1}`} onClick={() => set(i, { accounts: p.accounts.filter((_, j) => j !== k) })}>Xoá</button>
              </div>
            ))}
            <div><button type="button" className={styles.btn} onClick={() => set(i, { accounts: [...p.accounts, { name: '', description: '', username: '', password: '' }] })}>+ Thêm tài khoản</button></div>

            <div className={styles.muted}>Reset dữ liệu (chỉ chạy khi bạn bấm)</div>
            <div className={styles.two}>
              {text(i, 'resetCommand', 'Lệnh reset/seed', 'pnpm db:reset && pnpm db:seed')}
              {text(i, 'resetCwd', 'Thư mục chạy lệnh (tuyệt đối)', 'D:\\Work\\api')}
            </div>
            <div className={styles.projectActions}>
              <button type="button" className={styles.btn} disabled={!p.resetCommand.trim() || r?.busy} onClick={() => void runReset(i)}>
                {r?.busy ? 'Đang reset…' : 'Reset dữ liệu'}
              </button>
              <button type="button" className={styles.btn} onClick={() => { if (confirm(`Xoá cấu hình dự án ${p.dir || '(mới)'}?`)) onChange(projects.filter((_, j) => j !== i)); }}>Xoá dự án</button>
            </div>
            {r?.error && <p className={styles.bad} role="alert">{r.error}</p>}
            {r?.out && (
              <pre className={`${styles.resetOut} mono`} data-ok={r.out.code === 0 ? 'true' : 'false'}>
                {`mã thoát: ${r.out.code ?? '—'}\n${r.out.tail}`}
              </pre>
            )}
          </details>
        );
      })}
      {projects.length === 0 && <p className={styles.muted}>Chưa cấu hình dự án nào. Dự án Next.js chưa cấu hình vẫn dùng lệnh mặc định.</p>}
      {errors.length > 0 && <ul className={styles.errBox} role="alert">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <div><button type="button" className={styles.btn} onClick={() => onChange([...projects, emptyProjectForm()])}>+ Thêm dự án</button></div>
    </>
  );
}
