'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/liveStore';
import { applyPlanEdit, planDiff, planEdited, ROLE_LABEL, type PlanEdit } from '../../../lib/planEdit';
import { ticketStatusText } from '../../../lib/tickets';
import { filesOverlap } from '@/src/tickets/flow';
import type { AgentKind, Effort, Plan, Ticket, WorkRole } from '@/src/tickets/model';
import styles from './PlanEditor.module.css';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ROLES: WorkRole[] = ['explorer', 'dev', 'designer', 'qc'];
interface SettingsRes { settings: { allowedModels: Record<AgentKind, string[]> } }

export default function PlanEditor({ id }: { id: string }) {
  const router = useRouter();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [orig, setOrig] = useState<Plan | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [allowed, setAllowed] = useState<Record<AgentKind, string[]>>({ claude: [], codex: [] });
  const [codexOk, setCodexOk] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    fetch(`/api/tickets/${encodeURIComponent(id)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setLoadErr((j as { error?: string }).error ?? `HTTP ${r.status}`); return; }
      const t = (j as { ticket: Ticket }).ticket;
      setTicket(t);
      if (t.plan) { setOrig(t.plan); setPlan(t.plan); }
    }).catch(() => setLoadErr('Không kết nối được máy chủ'));
    fetch('/api/settings').then((r) => r.json()).then((j: SettingsRes) => { if (j.settings) setAllowed(j.settings.allowedModels); }).catch(() => {});
    fetch('/api/capabilities').then((r) => r.json()).then((j: Record<AgentKind, boolean>) => setCodexOk(j.codex !== false)).catch(() => {});
  }, [id]);

  const diff = useMemo(() => (orig && plan ? planDiff(orig, plan) : []), [orig, plan]);
  const edit = (e: PlanEdit) => setPlan((p) => (p ? applyPlanEdit(p, e) : p));

  const back = <Link href="/" className={styles.back}>← Về bảng theo dõi</Link>;
  if (loadErr) return <div className={styles.page}><div className={styles.card}>{back}<div role="alert" className={styles.err}>✗ {loadErr}</div></div></div>;
  if (!ticket) return <div className={styles.page}><div className={styles.card}>{back}<div className={styles.muted}>Đang tải…</div></div></div>;
  const st = ticketStatusText(ticket);
  if (ticket.status !== 'awaiting_approval' || !plan || !orig) {
    return (
      <div className={styles.page}><div className={styles.card}>
        {back}
        <h1 className={styles.h1}>{ticket.id} · {ticket.title}</h1>
        <div>Trạng thái: {st.icon} {st.text}. Ticket không ở bước chờ duyệt kế hoạch.</div>
        <Link href={`/?ticket=${encodeURIComponent(ticket.id)}`} className={styles.link}>Mở ticket trên bảng theo dõi</Link>
      </div></div>
    );
  }

  const done = () => router.push(`/?ticket=${encodeURIComponent(id)}`);
  const call = async (path: string, body: unknown) => {
    setBusy(true); setErrors([]); setConflict(false);
    try { await postJson(`/api/tickets/${encodeURIComponent(id)}/${path}`, body); done(); return; }
    catch (e) {
      const st = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : 'Lỗi không rõ';
      if (st === 409) setConflict(true);
      else setErrors(st === 400 ? msg.split('\n').filter(Boolean) : [msg]);
    }
    setBusy(false);
  };

  const approve = () => call('approve', planEdited(orig, plan) ? { plan } : {});
  const revise = () => { if (feedback.trim()) void call('revise', { feedback: feedback.trim() }); };
  const cancel = () => { if (confirm(`Huỷ ticket ${ticket.id}?`)) void call('cancel', {}); };

  const overlaps = (pid: string, files: string[], role: WorkRole) =>
    role !== 'dev' ? [] : plan.packages.filter((o) => o.id !== pid && o.role === 'dev' && filesOverlap(files, o.files)).map((o) => o.id);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {back}
        <h1 className={styles.h1}>Duyệt kế hoạch · {ticket.id} · {ticket.title}</h1>
        <div className={styles.summary}>{plan.summary}</div>
        <div className={styles.muted}>Độ khó: <b className={styles.fg}>{plan.difficulty}</b></div>

        <h2 className={styles.h2}>Vai</h2>
        <table className={styles.roles}>
          <thead><tr><th>Vai</th><th>Số lượng</th><th>Agent</th><th>Model</th><th>Effort</th></tr></thead>
          <tbody>
            {ROLES.map((r) => {
              const s = plan.roles[r];
              const models = allowed[s.agent] ?? [];
              const l = ROLE_LABEL[r];
              return (
                <tr key={r}>
                  <th scope="row">{l}</th>
                  <td><input type="number" min={0} max={9} aria-label={`${l} số lượng`} value={s.count} onChange={(e) => edit({ type: 'role', role: r, patch: { count: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })} /></td>
                  <td>
                    <select aria-label={`${l} agent`} value={s.agent} onChange={(e) => {
                      const agent = e.target.value as AgentKind;
                      const m = allowed[agent] ?? [];
                      edit({ type: 'role', role: r, patch: { agent, ...(m.length && !m.includes(s.model) ? { model: m[0] } : {}) } });
                    }}>
                      <option value="claude">claude</option>
                      <option value="codex" disabled={!codexOk}>codex</option>
                    </select>
                  </td>
                  <td>
                    <select aria-label={`${l} model`} value={s.model} onChange={(e) => edit({ type: 'role', role: r, patch: { model: e.target.value } })}>
                      {!models.includes(s.model) && <option value={s.model}>{s.model}</option>}
                      {models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`${l} effort`} value={s.effort} onChange={(e) => edit({ type: 'role', role: r, patch: { effort: e.target.value as Effort } })}>
                      {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!codexOk && <div className={styles.muted}>Codex CLI chưa được cài trên máy</div>}

        <h2 className={styles.h2}>Gói việc</h2>
        <div className={styles.pkgs}>
          {plan.packages.map((k) => (
            <fieldset key={k.id} className={styles.pkg}>
              <legend className="mono">{k.id}</legend>
              <div className={styles.pkgHead}>
                <select aria-label={`${k.id} vai`} value={k.role} onChange={(e) => edit({ type: 'pkg', id: k.id, patch: { role: e.target.value as WorkRole } })}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <input aria-label={`${k.id} tiêu đề`} value={k.title} onChange={(e) => edit({ type: 'pkg', id: k.id, patch: { title: e.target.value } })} />
                <button type="button" className={styles.ghost} onClick={() => edit({ type: 'removePkg', id: k.id })}>Xoá gói</button>
              </div>
              <label className={styles.lbl}>Task
                <textarea rows={3} value={k.task} onChange={(e) => edit({ type: 'pkg', id: k.id, patch: { task: e.target.value } })} />
              </label>
              <label className={styles.lbl}>Files (mỗi dòng một file)
                <textarea rows={3} className="mono" spellCheck={false} defaultValue={k.files.join('\n')} onChange={(e) => edit({ type: 'pkgFiles', id: k.id, text: e.target.value })} />
              </label>
              {overlaps(k.id, k.files, k.role).map((o) => <div key={o} className={styles.warn}>▲ trùng file với gói {o}</div>)}
            </fieldset>
          ))}
          <button type="button" className={styles.ghost} onClick={() => edit({ type: 'addPkg', role: 'dev' })}>+ Thêm gói việc</button>
        </div>

        <h2 className={styles.h2}>Tiêu chí nghiệm thu</h2>
        <label className={styles.lbl}><span>Mỗi dòng một tiêu chí</span>
          <textarea rows={4} defaultValue={plan.acceptance.join('\n')} onChange={(e) => edit({ type: 'acceptance', text: e.target.value })} />
        </label>

        {diff.length > 0 && (
          <div className={styles.diff}>
            <b>Bạn đã sửa</b>
            <ul>{diff.map((d, i) => <li key={i}>{d}</li>)}</ul>
          </div>
        )}

        <h2 className={styles.h2}>Góp ý cho Controller</h2>
        <textarea aria-label="Góp ý cho Controller" rows={3} maxLength={5000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />

        {errors.length > 0 && <div role="alert" className={styles.err}><ul>{errors.map((m, i) => <li key={i}>✗ {m}</li>)}</ul></div>}
        {conflict && <div role="alert" className={styles.err}>✗ Kế hoạch đã được xử lý ở nơi khác. <Link href={`/?ticket=${encodeURIComponent(id)}`} className={styles.link}>Về bảng theo dõi</Link></div>}

        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={approve}>Duyệt và bắt đầu</button>
          <button type="button" className={styles.secondary} disabled={busy || !feedback.trim()} onClick={revise}>Gửi góp ý cho Controller</button>
          <button type="button" className={styles.danger} disabled={busy} onClick={cancel}>Huỷ ticket</button>
        </div>
      </div>
    </div>
  );
}
