'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CallRecord } from '@/src/core/model';
import { useLive } from '../lib/liveStore';
import { fmtClock, fmtDuration, fmtTokens } from '../lib/format';
import { alertPill, callRowState, toolCalls, topRepeatedError } from '../lib/detail';
import styles from './AgentDetail.module.css';

export { topRepeatedError } from '../lib/detail';

const EMPTY_CALLS: CallRecord[] = [];
const ROW_H = 26;

export default function AgentDetail() {
  const selected = useLive((s) => s.selectedAgentId);
  const agent = useLive((s) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const rawCalls = useLive((s) => (s.selectedAgentId ? s.calls[s.selectedAgentId] : undefined)) ?? EMPTY_CALLS;
  const metrics = useLive((s) => (s.selectedAgentId ? s.agentMetrics[s.selectedAgentId] : undefined));
  const alertsMap = useLive((s) => s.alerts);
  const selectedCallId = useLive((s) => s.selectedCallId);
  const callNonce = useLive((s) => s.selectedCallNonce);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
  const dash = '—';
  const cells: Array<[string, string]> = [
    ['call', m ? String(m.calls) : dash],
    ['lỗi', m ? String(m.errors) : dash],
    ['p50', m?.p50 != null ? fmtDuration(m.p50) : dash],
    ['p95', m?.p95 != null ? fmtDuration(m.p95) : dash],
    ['token', m ? fmtTokens(m.tokensIn + m.tokensOut) : dash],
    ['thời gian', m ? fmtDuration(m.durationMs) : dash],
  ];
  const modelLine = [agent.model, agent.effort].filter(Boolean).join(' · ');

  return (
    <aside className={styles.box} aria-label="Chi tiết agent">
      <header className={styles.head}>
        <div className={styles.title}><strong>{agent.label}</strong><span className={styles.meta}> · trực tiếp</span></div>
        {alerts.length > 0 && (
          <div className={styles.pills}>
            {alerts.map((a) => (
              <span key={a.id} className={`${styles.pill} mono`} data-level={a.level}>
                <span aria-hidden="true">{a.level === 'critical' ? '■' : '▲'}</span> {alertPill(a, now)}
              </span>
            ))}
          </div>
        )}
        {/* Phần 2: nút Dừng sẽ nằm ở đây */}
      </header>
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

      <dl className={styles.grid}>
        {cells.map(([k, v]) => (
          <div key={k} className={styles.cell}><dt>{k}</dt><dd className="mono">{v}</dd></div>
        ))}
      </dl>

      {agent.parseErrors > 0 && (
        <div className={styles.parse}><span aria-hidden="true">▲</span> {agent.parseErrors} dòng log không đọc được</div>
      )}
    </aside>
  );
}
