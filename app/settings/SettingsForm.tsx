'use client';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { readThemePref, saveThemePref, type ThemePref } from '../lib/theme';
import type { Settings, Thresholds } from '@/src/core/config';
import type { AgentKind, Effort, Role, RoleSpec } from '@/src/tickets/model';
import { errorsFor } from '../lib/settingsErrors';
import styles from './SettingsForm.module.css';

const ROLES: { role: Role; label: string }[] = [
  { role: 'controller', label: 'Controller' },
  { role: 'explorer', label: 'Explorer' },
  { role: 'dev', label: 'Dev' },
  { role: 'designer', label: 'Designer' },
  { role: 'qc', label: 'QC' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENTS: AgentKind[] = ['claude', 'codex'];
const THRESHOLDS: { key: keyof Thresholds; label: string; unit: string; sec?: boolean }[] = [
  { key: 'stuckMs', label: 'Coi là kẹt sau', unit: 'giây', sec: true },
  { key: 'longToolMs', label: 'Tool chạy lâu sau', unit: 'giây', sec: true },
  { key: 'loopWindow', label: 'Cửa sổ phát hiện lặp', unit: 'lần gọi gần nhất' },
  { key: 'loopWarn', label: 'Cảnh báo lặp từ', unit: 'lần' },
  { key: 'loopCritical', label: 'Lặp nghiêm trọng (tự dừng) từ', unit: 'lần' },
  { key: 'errorBurst', label: 'Lỗi dồn dập từ', unit: 'lỗi' },
];
const THEMES: { v: ThemePref; label: string }[] = [
  { v: 'system', label: 'Hệ thống' },
  { v: 'dark', label: 'Tối' },
  { v: 'light', label: 'Sáng' },
];

interface Form {
  roles: Record<Role, RoleSpec>;
  /** model '' = như lúc lập kế hoạch */
  ctrlExec: { model: string; effort: Effort };
  allowed: Record<AgentKind, string>;
  thr: Record<keyof Thresholds, string>;
  denyBash: string;
  checkCommands: string;
  maxRounds: string;
  maxParallel: string;
  prices: { model: string; in: string; out: string }[];
  claudePath: string;
  codexPath: string;
}

const lines = (s: string) => s.split('\n').map((x) => x.replace(/\r$/, '')).filter((x) => x.trim() !== '');
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function toForm(s: Settings, t: Thresholds): Form {
  const thr = {} as Form['thr'];
  for (const { key, sec } of THRESHOLDS) thr[key] = String(sec ? t[key] / 1000 : t[key]);
  return {
    roles: structuredClone(s.roleDefaults),
    ctrlExec: s.controllerExec ? { ...s.controllerExec } : { model: '', effort: s.roleDefaults.controller.effort },
    allowed: { claude: s.allowedModels.claude.join('\n'), codex: s.allowedModels.codex.join('\n') },
    thr,
    denyBash: s.denyBash.join('\n'),
    checkCommands: s.checkCommands.join('\n'),
    maxRounds: String(s.maxRounds),
    maxParallel: String(s.maxParallel),
    prices: Object.entries(s.prices).map(([model, p]) => ({ model, in: String(p.in), out: String(p.out) })),
    claudePath: s.claudePath ?? '',
    codexPath: s.codexPath ?? '',
  };
}

function toBody(f: Form) {
  const thresholds = {} as Record<string, number>;
  for (const { key, sec } of THRESHOLDS) thresholds[key] = sec ? Math.round(num(f.thr[key]) * 1000) : num(f.thr[key]);
  const prices: Record<string, { in: number; out: number }> = {};
  for (const p of f.prices) if (p.model.trim()) prices[p.model.trim()] = { in: num(p.in), out: num(p.out) };
  return {
    settings: {
      roleDefaults: f.roles,
      controllerExec: f.ctrlExec.model ? { model: f.ctrlExec.model, effort: f.ctrlExec.effort } : null,
      allowedModels: { claude: lines(f.allowed.claude).map((x) => x.trim()), codex: lines(f.allowed.codex).map((x) => x.trim()) },
      denyBash: lines(f.denyBash),
      checkCommands: lines(f.checkCommands),
      maxRounds: num(f.maxRounds),
      maxParallel: num(f.maxParallel),
      prices,
      claudePath: f.claudePath.trim() || null,
      codexPath: f.codexPath.trim() || null,
    },
    thresholds,
  };
}

const ALL_KEYS = [
  ...ROLES.flatMap((r) => ['agent', 'model', 'effort'].map((k) => `roleDefaults.${r.role}.${k}`)),
  'controllerExec.model', 'controllerExec.effort', 'allowedModels.claude', 'allowedModels.codex', 'denyBash', 'checkCommands', 'maxRounds', 'maxParallel', 'prices', 'claudePath', 'codexPath',
  ...THRESHOLDS.map((t) => `thresholds.${t.key}`),
];

export default function SettingsForm() {
  const [form, setForm] = useState<Form | null>(null);
  const [caps, setCaps] = useState<Record<AgentKind, boolean> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<ThemePref>('system');

  useEffect(() => {
    setTheme(readThemePref());
    fetch('/api/settings').then((r) => r.json()).then((j: { settings: Settings; thresholds: Thresholds }) => setForm(toForm(j.settings, j.thresholds)))
      .catch(() => setMsg({ ok: false, text: 'Không tải được cài đặt' }));
    fetch('/api/capabilities').then((r) => r.json()).then(setCaps).catch(() => {});
  }, []);

  if (!form) {
    return <main className={styles.page}><div className={styles.form}>{msg ? <p className={styles.bad} role="alert">{msg.text}</p> : <p className={styles.muted}>Đang tải…</p>}</div></main>;
  }

  const patch = (p: Partial<Form>) => setForm({ ...form, ...p });
  const setRole = (role: Role, p: Partial<RoleSpec>) => patch({ roles: { ...form.roles, [role]: { ...form.roles[role], ...p } } });
  const errs = (key: string) => errorsFor(errors, key);
  const unmatched = errors.filter((e) => !ALL_KEYS.some((k) => errorsFor([e], k).length));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toBody(form)) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 200) {
        setForm(toForm(j.settings, j.thresholds)); setErrors([]); setMsg({ ok: true, text: '✓ Đã lưu' });
      } else if (res.status === 400 && Array.isArray(j.errors)) {
        setErrors(j.errors); setMsg({ ok: false, text: `✕ Có ${j.errors.length} lỗi, xem các trường bên dưới` });
      } else {
        setErrors([]); setMsg({ ok: false, text: `✕ ${j.error ?? `Lưu thất bại (${res.status})`}` });
      }
    } catch {
      setMsg({ ok: false, text: '✕ Không kết nối được server' });
    } finally {
      setBusy(false);
    }
  };

  const modelOptions = (agent: AgentKind, current: string) => {
    const list = lines(form.allowed[agent]).map((x) => x.trim());
    return !current || list.includes(current) ? list : [...list, current];
  };

  return (
    <main className={styles.page}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <header className={styles.head}>
          <Link href="/" className={styles.back}>← Về bảng điều khiển</Link>
          <h1 className={styles.h1}>Cài đặt</h1>
        </header>

        <Section title="Model mặc định theo vai">
          {ROLES.map(({ role, label }) => {
            const spec = form.roles[role];
            const opts = modelOptions(spec.agent, spec.model);
            return (
              <div key={role} className={styles.roleRow}>
                <span className={styles.roleName}>{label}</span>
                <Field label="Agent" errors={errs(`roleDefaults.${role}.agent`)}>
                  {(id) => (
                    <select id={id} value={spec.agent} onChange={(e) => setRole(role, { agent: e.target.value as AgentKind, model: e.target.value === 'codex' ? '' : (lines(form.allowed.claude)[0] ?? '').trim() })}>
                      {(role === 'controller' ? (['claude'] as AgentKind[]) : AGENTS).map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Model" errors={errs(`roleDefaults.${role}.model`)}>
                  {(id) => (
                    <select id={id} value={spec.model} onChange={(e) => setRole(role, { model: e.target.value })}>
                      {spec.agent === 'codex' && <option value="">(mặc định của CLI)</option>}
                      {opts.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Effort" errors={errs(`roleDefaults.${role}.effort`)}>
                  {(id) => (
                    <select id={id} value={spec.effort} onChange={(e) => setRole(role, { effort: e.target.value as Effort })}>
                      {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  )}
                </Field>
              </div>
            );
          })}
          <div className={styles.roleRow}>
            <span className={styles.roleName} title="Các lượt sau khi kế hoạch được duyệt: giao việc, đọc báo cáo, kết thúc. Lập kế hoạch vẫn dùng model của Controller ở trên.">Controller sau duyệt</span>
            <Field label="Agent" errors={[]}>
              {(id) => <select id={id} value="claude" disabled><option value="claude">claude</option></select>}
            </Field>
            <Field label="Model" errors={errs('controllerExec.model')}>
              {(id) => (
                <select id={id} value={form.ctrlExec.model} onChange={(e) => patch({ ctrlExec: { ...form.ctrlExec, model: e.target.value } })}>
                  <option value="">(như lúc lập kế hoạch)</option>
                  {modelOptions('claude', form.ctrlExec.model).filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              )}
            </Field>
            <Field label="Effort" errors={errs('controllerExec.effort')}>
              {(id) => (
                <select id={id} value={form.ctrlExec.effort} disabled={!form.ctrlExec.model} onChange={(e) => patch({ ctrlExec: { ...form.ctrlExec, effort: e.target.value as Effort } })}>
                  {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              )}
            </Field>
          </div>
        </Section>

        <Section title="Model cho phép" hint="Mỗi dòng một model.">
          <div className={styles.two}>
            {AGENTS.map((a) => (
              <Field key={a} label={`Model ${a}`} errors={errs(`allowedModels.${a}`)}>
                {(id) => <textarea id={id} rows={5} className="mono" spellCheck={false} value={form.allowed[a]} onChange={(e) => patch({ allowed: { ...form.allowed, [a]: e.target.value } })} />}
              </Field>
            ))}
          </div>
        </Section>

        <Section title="Ngưỡng cảnh báo">
          <div className={styles.thr}>
            {THRESHOLDS.map(({ key, label, unit }) => (
              <Field key={key} label={label} errors={errs(`thresholds.${key}`)}>
                {(id) => (
                  <span className={styles.unitRow}>
                    <input id={id} type="number" inputMode="decimal" min="0" step="any" className="mono" value={form.thr[key]} onChange={(e) => patch({ thr: { ...form.thr, [key]: e.target.value } })} />
                    <span className={styles.unit}>{unit}</span>
                  </span>
                )}
              </Field>
            ))}
          </div>
        </Section>

        <Section title="Quyền theo vai" hint="Mỗi dòng một regex (không phân biệt hoa thường).">
          <Field label="denyBash: lệnh bị chặn" errors={errs('denyBash')}>
            {(id) => <textarea id={id} rows={6} className="mono" spellCheck={false} value={form.denyBash} onChange={(e) => patch({ denyBash: e.target.value })} />}
          </Field>
          <Field label="checkCommands: lệnh kiểm tra QC được chạy" errors={errs('checkCommands')}>
            {(id) => <textarea id={id} rows={4} className="mono" spellCheck={false} value={form.checkCommands} onChange={(e) => patch({ checkCommands: e.target.value })} />}
          </Field>
        </Section>

        <Section title="Giới hạn">
          <div className={styles.two}>
            <Field label="Số vòng tối đa mỗi ticket" errors={errs('maxRounds')}>
              {(id) => <input id={id} type="number" min="1" step="1" className="mono" value={form.maxRounds} onChange={(e) => patch({ maxRounds: e.target.value })} />}
            </Field>
            <Field label="Số subagent chạy song song" errors={errs('maxParallel')}>
              {(id) => <input id={id} type="number" min="1" step="1" className="mono" value={form.maxParallel} onChange={(e) => patch({ maxParallel: e.target.value })} />}
            </Field>
          </div>
        </Section>

        <Section title="Bảng giá" hint="Dùng để ước tính chi phí.">
          {form.prices.map((p, i) => {
            const set = (q: Partial<typeof p>) => patch({ prices: form.prices.map((x, j) => (j === i ? { ...x, ...q } : x)) });
            return (
              <div key={i} className={styles.priceRow}>
                <label className={styles.sub}>Model<input value={p.model} className="mono" onChange={(e) => set({ model: e.target.value })} /></label>
                <label className={styles.sub}>$/1M vào<input type="number" min="0" step="any" className="mono" value={p.in} onChange={(e) => set({ in: e.target.value })} /></label>
                <label className={styles.sub}>$/1M ra<input type="number" min="0" step="any" className="mono" value={p.out} onChange={(e) => set({ out: e.target.value })} /></label>
                <button type="button" className={styles.btn} aria-label={`Xoá dòng giá ${p.model || i + 1}`} onClick={() => patch({ prices: form.prices.filter((_, j) => j !== i) })}>Xoá</button>
              </div>
            );
          })}
          {form.prices.length === 0 && <p className={styles.muted}>Chưa có dòng giá nào.</p>}
          <ErrorList errors={errs('prices')} />
          <div><button type="button" className={styles.btn} onClick={() => patch({ prices: [...form.prices, { model: '', in: '0', out: '0' }] })}>+ Thêm dòng</button></div>
        </Section>

        <Section title="Đường dẫn CLI" hint="Để trống là tự dò.">
          <div className={styles.two}>
            {([['claude', 'claudePath'], ['codex', 'codexPath']] as const).map(([a, k]) => (
              <Field key={k} label={k} errors={errs(k)}>
                {(id) => (
                  <>
                    <input id={id} className="mono" spellCheck={false} value={form[k]} onChange={(e) => patch({ [k]: e.target.value })} />
                    <span className={caps ? (caps[a] ? styles.ok : styles.warn) : styles.muted}>
                      {caps ? (caps[a] ? `✓ Tìm thấy ${a}` : `✕ Không tìm thấy ${a}`) : 'Đang kiểm tra…'}
                    </span>
                  </>
                )}
              </Field>
            ))}
          </div>
        </Section>

        <Section title="Giao diện">
          <div role="radiogroup" aria-label="Giao diện" className={styles.themes}>
            {THEMES.map(({ v, label }) => (
              <label key={v} className={`${styles.theme} ${theme === v ? styles.themeOn : ''}`}>
                <input type="radio" name="theme" value={v} checked={theme === v} onChange={() => { setTheme(v); saveThemePref(v); }} />
                {label}
              </label>
            ))}
          </div>
        </Section>

        {unmatched.length > 0 && <ul className={styles.errBox} role="alert">{unmatched.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
          <span className={msg?.ok ? styles.ok : styles.bad} role="status" aria-live="polite">{msg?.text}</span>
        </div>
      </form>
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className={styles.section}>
      <legend className={styles.legend}>{title}</legend>
      {hint && <p className={styles.muted}>{hint}</p>}
      {children}
    </fieldset>
  );
}

function Field({ label, errors, children }: { label: string; errors: string[]; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={styles.field} data-invalid={errors.length ? 'true' : undefined}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      {children(id)}
      <ErrorList errors={errors} />
    </div>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return <ul className={styles.fieldErr} role="alert">{errors.map((e, i) => <li key={i}>✕ {e}</li>)}</ul>;
}
