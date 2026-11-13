'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CallRecord } from '@/src/core/model';
import { getState, selectAgentMetrics, useLive } from '../lib/liveStore';
import { estimateCost, fmtClock, fmtCost, fmtDuration, fmtTokens, cacheShare, fmtPercent } from '../lib/format';
import ManagedPanel from './ManagedPanel';
import { alertPill, callRowState, toolCalls, topRepeatedError } from '../lib/detail';
import styles from './AgentDetail.module.css';

export { topRepeatedError } from '../lib/detail';

const EMPTY_CALLS: CallRecord[] = [];
const ROW_H = 26;
const CAPTURE_TOOL = 'mcp__acctv__capture';

interface CaptureFile { name: string; file: string; at: number }

/** Ảnh tool capture của agent (mới nhất trước); tải lại khi có call capture mới xong. */
function Captures({ agentId, refresh }: { agentId: string; refresh: number }) {
  const [items, setItems] = useState<CaptureFile[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`/api/agents/${encodeURIComponent(agentId)}/captures`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((j: CaptureFile[]) => { if (live) setItems(Array.isArray(j) ? j : []); })
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [agentId, refresh]);
  if (!items.length) return null;
  return (
    <section className={styles.shots} aria-label="Ảnh chụp của capture">
      <div className={styles.shotsHead}>Ảnh chụp <span className={styles.meta}>· {items.length}</span></div>
      <div className={styles.shotsRow}>
        {items.map((c) => (
          <a key={c.name} href={c.file} target="_blank" rel="noreferrer" className={styles.shot} title={`${c.name} · ${fmtClock(c.at)}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.file} alt={c.name} loading="lazy" width={160} />
            <span className="mono">{c.name}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export default function AgentDetail() {
  const selected = useLive((s) => s.selectedAgentId);
  const agent = useLive((s) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const rawCalls = useLive((s) => (s.selectedAgentId ? s.calls[s.selectedAgentId] : undefined)) ?? EMPTY_CALLS;
  const loadedGen = useLive((s) => (s.selectedAgentId ? s.callsLoadedGen[s.selectedAgentId] : undefined));
  const alertsMap = useLive((s) => s.alerts);
  const selectedCallId = useLive((s) => s.selectedCallId);
  const callNonce = useLive((s) => s.selectedCallNonce);
  const managed = useLive((s) => (s.selectedAgentId ? s.managed[s.selectedAgentId] : undefined));
  const prices = useLive((s) => s.prices);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // metrics tính ở client từ calls (WS cập nhật liên tục), tối đa 1 lần/giây theo ticker;
  // tính lại ngay khi đổi agent hoặc khi calls vừa tải xong
  const metrics = useMemo(
    () => (selected ? selectAgentMetrics(getState(), selected, now) : undefined),
    [selected, now, loadedGen],
  );

  const calls = useMemo(() => toolCalls(rawCalls), [rawCalls]);
  const repeated = useMemo(() => topRepeatedError(calls), [calls]);
  const alerts = useMemo(
    () => Object.values(alertsMap).filter((a) => a.active && a.agentId === selected),
    [alertsMap, selected],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledNonce = useRef(0);

  const virt = useVirtualizer({
    count: calls.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    getItemKey: (i) => calls[i]?.id ?? i,
  });

  // đổi agent: đóng mọi dòng mở rộng
  useEffect(() => { setExpanded(new Set()); setActiveId(null); }, [selected]);

  // bấm một thanh trên timeline: cuộn tới call, mở rộng và tô sáng
  useEffect(() => {
    if (!selectedCallId || handledNonce.current === callNonce) return;
    const idx = calls.findIndex((c) => c.id === selectedCallId);
    if (idx < 0) return;
    handledNonce.current = callNonce;
    setExpanded((p) => new Set(p).add(selectedCallId));
    setActiveId(selectedCallId);
    virt.scrollToIndex(idx, { align: 'center' });
  }, [selectedCallId, callNonce, calls, virt]);

  if (!agent || !selected) {
    return (
      <aside className={styles.box} aria-label="Chi tiết agent">
        <div className={styles.empty}>Chọn một agent để xem trực tiếp</div>
      </aside>
    );
  }

  const toggle = (id: string) => setExpanded((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const activeIdx = activeId ? calls.findIndex((c) => c.id === activeId) : -1;
  const move = (idx: number) => {
    const i = Math.max(0, Math.min(calls.length - 1, idx));
    if (!calls[i]) return;
    setActiveId(calls[i].id);
    virt.scrollToIndex(i, { align: 'auto' });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (calls.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(activeIdx < 0 ? 0 : activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(activeIdx < 0 ? 0 : activeIdx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(calls.length - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && activeIdx >= 0) { e.preventDefault(); toggle(calls[activeIdx].id); }
  };

  const m = metrics;
  const cost = managed ? managed.costUsd : m ? estimateCost(agent.model, m.tokensIn, m.tokensOut, prices) : null;
  const dash = '—';
  const fresh = m ? Math.max(0, m.tokensIn - m.cacheRead) : 0;
  const cells: Array<[string, string, wide?: boolean]> = [
    ['call', m ? String(m.calls) : dash],
    ['lỗi', m ? String(m.errors) : dash],
    ['p50', m?.p50 != null ? fmtDuration(m.p50) : dash],
    ['p95', m?.p95 != null ? fmtDuration(m.p95) : dash],
    ['token cache', m ? fmtTokens(m.cacheRead) : dash],
    ['token ra', m ? fmtTokens(m.tokensOut) : dash],
    ['đọc cache', m ? fmtPercent(cacheShare(m.cacheRead, m.tokensIn)) : dash],
    // phần token vào tính giá đầy đủ: input chưa cache + ghi cache
    ['input mới', m ? fmtTokens(fresh) : dash],
    ['chi phí', fmtCost(cost)],
    ['token vào = token cache + token mới', m ? `${fmtTokens(m.tokensIn)} = ${fmtTokens(m.cacheRead)} + ${fmtTokens(fresh)}` : dash, true],
  ];
  const modelLine = [agent.model, agent.effort].filter(Boolean).join(' · ');

  return (
    <aside className={styles.box} aria-label="Chi tiết agent">
      <header className={styles.head}>
        <div className={styles.title}><strong>{agent.label}</strong><span className={styles.meta}> · trực tiếp</span></div>
        {m && (
          <div className={styles.time} title="Từ lúc bắt đầu tới event cuối (hoặc tới giờ nếu đang chạy)">
            <span>Thời gian</span><strong className="mono">{fmtDuration(m.durationMs)}</strong>
          </div>
        )}
        {alerts.length > 0 && (
          <div className={styles.pills}>
            {alerts.map((a) => (
              <span key={a.id} className={`${styles.pill} mono`} data-level={a.level}>
                <span aria-hidden="true">{a.level === 'critical' ? '■' : '▲'}</span> {alertPill(a, now)}
              </span>
            ))}
          </div>
        )}
      </header>
      {managed && <ManagedPanel agentId={selected} />}
      <div className={styles.sub}>
        <div>{agent.role ?? '—'}</div>
        <div className={styles.cwd} title={agent.cwd ?? undefined}>{agent.cwd ?? '—'}</div>
        <div className="mono">{modelLine || '—'}</div>
      </div>

      <div
        className={styles.list} ref={scrollRef} role="listbox" tabIndex={0} aria-label="Các call của agent"
        aria-activedescendant={activeId ? `call-${activeId}` : undefined} onKeyDown={onKey}
      >
        {calls.length === 0 && <div className={styles.empty}>Chưa có call nào</div>}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const c = calls[v.index];
            if (!c) return null;
            const st = callRowState(c, agent, now);
            const open = expanded.has(c.id);
            return (
              <div
                key={c.id} id={`call-${c.id}`} role="option" aria-selected={c.id === activeId}
                data-index={v.index} ref={virt.measureElement}
                className={`${styles.row} ${c.id === activeId ? styles.active : ''}`} data-state={st.state}
                style={{ transform: `translateY(${v.start}px)` }}
                onClick={() => { setActiveId(c.id); toggle(c.id); scrollRef.current?.focus({ preventScroll: true }); }}
              >
                <div className={styles.line}>
                  <span className={`${styles.clock} mono`}>{fmtClock(c.startedAt)}</span>
                  <span className={styles.name}>{c.name}</span>
                  <span className={`${styles.input} mono`}>{c.inputPreview}</span>
                  <span className={`${styles.res} mono`} data-state={st.state}>
                    <span aria-hidden="true">{st.icon}</span> {st.text}{st.durationMs != null ? ` ${fmtDuration(st.durationMs)}` : ''}
                  </span>
                </div>
                {open && (
                  <div className={styles.full}>
                    <div className={`${styles.pre} mono`}>{c.inputPreview || '—'}</div>
                    {c.errorPreview && <div className={`${styles.pre} ${styles.errText} mono`}>{c.errorPreview}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {repeated && (
        <div className={`${styles.repeat} mono`}>
          <span aria-hidden="true">▲</span> Lỗi lặp lại: {repeated.preview} ({repeated.count}×)
        </div>
      )}

      {managed && (managed.role === 'dev' || managed.role === 'designer' || managed.role === 'qc') && (
        <Captures agentId={managed.agentId} refresh={rawCalls.filter((c) => c.name === CAPTURE_TOOL && c.endedAt !== null).length} />
      )}

      <dl className={styles.grid}>
        {cells.map(([k, v, wide]) => (
          <div key={k} className={wide ? `${styles.cell} ${styles.wide}` : styles.cell}><dt>{k}</dt><dd className="mono">{v}</dd></div>
        ))}
      </dl>

      {agent.parseErrors > 0 && (
        <div className={styles.parse}><span aria-hidden="true">▲</span> {agent.parseErrors} dòng log không đọc được</div>
      )}
    </aside>
  );
}
