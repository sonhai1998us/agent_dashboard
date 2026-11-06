'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { ensureCalls, selectAgent, selectCall, useLive } from '../lib/liveStore';
import { agentWorkMs, layoutWaits, replayRange } from '../lib/tickets';
import type { WaitSpan } from '@/src/tickets/model';
import { flattenTree } from '../lib/tree';
import { DEFAULT_WINDOW_MIN, WINDOWS_MIN, layoutLane, waitingCallIds, type Bar, type LoopZone } from '../lib/lanes';
import { fmtClock, fmtDuration } from '../lib/format';
import { alertTag } from '../lib/detail';
import { statusOf } from './SessionList';
import styles from './AgentTimeline.module.css';

const LANE_H = 30;
const BAR_H = 14;
const EMPTY_CALLS: CallRecord[] = [];

interface Frame { now: number; agents: Record<string, AgentInfo>; calls: Record<string, CallRecord[]>; alerts: Alert[]; waits: WaitSpan[]; }
interface Tip { x: number; y: number; text: string; }

function folder(cwd: string | null): string {
  if (!cwd) return '—';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function rootOf(id: string, agents: Record<string, AgentInfo>): AgentInfo | null {
  let cur = agents[id];
  const seen = new Set<string>();
  while (cur && cur.parentId && agents[cur.parentId] && !seen.has(cur.id)) { seen.add(cur.id); cur = agents[cur.parentId]; }
  return cur ?? null;
}

function treeGlyph(depth: number, isLast: boolean): string {
  if (depth === 0) return '';
  return `${'  '.repeat(depth - 1)}${isLast ? '└' : '├'} `;
}

export default function AgentTimeline() {
  const agents = useLive((s) => s.agents);
  const callsMap = useLive((s) => s.calls);
  const alertsMap = useLive((s) => s.alerts);
  const selected = useLive((s) => s.selectedAgentId);
  const callsGen = useLive((s) => s.callsGen);
  const waitsMap = useLive((s) => s.waits);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [winMin, setWinMin] = useState<number>(DEFAULT_WINDOW_MIN);
  const [focusIdx, setFocusIdx] = useState(0);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  const [frame, setFrame] = useState<Frame>({ now: Date.now(), agents: {}, calls: {}, alerts: [], waits: [] });
  const wrapRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const live = useRef({ agents, callsMap, alertsMap, waitsMap });
  live.current = { agents, callsMap, alertsMap, waitsMap };
  const hasAgents = Object.keys(agents).length > 0;

  // cây và lane chỉ dẫn xuất từ frame (cập nhật tối đa 1 lần/giây), không theo từng event WS
  const root = useMemo(() => (selected ? rootOf(selected, frame.agents) : null), [selected, frame.agents]);
  const nodes = useMemo(() => (root ? flattenTree(root, Object.values(frame.agents)) : []), [root, frame.agents]);
  const idsKey = nodes.map((n) => n.agent.id).join('|');

  // tải call cho mọi agent trong cây; nối lại WS (callsGen tăng) thì tải lại
  useEffect(() => { for (const n of nodes) ensureCalls(n.agent.id); }, [idsKey, callsGen]); // eslint-disable-line react-hooks/exhaustive-deps

  // vẽ lại tối đa 1 lần/giây: ticker 1s chụp dữ liệu mới nhất; đổi cửa sổ/phiên thì chụp ngay
  const refresh = useCallback(() => {
    setFrame({ now: Date.now(), agents: live.current.agents, calls: live.current.callsMap, alerts: Object.values(live.current.alertsMap), waits: Object.values(live.current.waitsMap) });
  }, []);
  useEffect(() => { refresh(); }, [refresh, winMin, selected, hasAgents]);
  useEffect(() => {
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [root?.id]);

  useEffect(() => {
    const i = nodes.findIndex((n) => n.agent.id === selected);
    if (i >= 0) setFocusIdx(i);
  }, [selected, idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const range = useMemo(() => replayRange(nodes.map((n) => n.agent), frame.now), [nodes, frame.now]);
  const winMs = winMin * 60_000;
  const replaying = !range.live;
  const sliderMin = Math.min(range.min + winMs, range.max);
  const sliderVal = replaying ? Math.min(Math.max(replayAt ?? range.max, sliderMin), range.max) : 0;
  const winEnd = replaying ? sliderVal : frame.now;
  useEffect(() => { setReplayAt(null); }, [root?.id]);
  const win = useMemo(() => ({ start: winEnd - winMs, end: winEnd }), [winEnd, winMs]);
  const lanes = useMemo(
    () => nodes.map((n) => layoutLane(
      frame.calls[n.agent.id] ?? EMPTY_CALLS, n.agent, win, width, frame.alerts, waitingCallIds(n.agent.id, Object.values(frame.agents)),
    )),
    [nodes, frame, win, width],
  );
  const laneWaits = useMemo(
    () => nodes.map((n) => layoutWaits(frame.waits, n.agent.id, win, width, frame.now)),
    [nodes, frame.waits, frame.now, win, width],
  );

  const showTip = useCallback((text: string, el: Element, mouse?: { x: number; y: number }) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!wrap) return;
    if (mouse) { setTip({ x: mouse.x - wrap.left, y: mouse.y - wrap.top, text }); return; }
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2 - wrap.left, y: r.top - wrap.top, text });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);

  if (!root) {
    return (
      <section className={styles.box} aria-label="Cây agent và timeline">
        <div className={styles.empty}>Chọn một phiên ở cột trái</div>
      </section>
    );
  }

  const ticks = [0, 1, 2, 3].map((i) => fmtClock(win.start + ((win.end - win.start) * i) / 3));

  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(nodes.length - 1, i));
    setFocusIdx(next);
    treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[next]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const onBar = t.dataset.bar !== undefined;
    const row = t.closest<HTMLElement>('[role="treeitem"]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(Number(row?.dataset.idx ?? focusIdx) + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!row) return;
      const bars = Array.from(row.querySelectorAll<SVGElement>('[data-bar]'));
      if (bars.length === 0) return;
      e.preventDefault();
      const cur = onBar ? bars.indexOf(t as unknown as SVGElement) : -1;
      let nx: number;
      if (e.key === 'ArrowRight') nx = cur < 0 ? 0 : Math.min(cur + 1, bars.length - 1);
      else nx = cur < 0 ? bars.length - 1 : Math.max(cur - 1, 0);
      bars[nx].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!row) return;
      e.preventDefault();
      if (onBar) selectCall(row.dataset.id!, t.dataset.bar!); else selectAgent(row.dataset.id!);
    } else if (e.key === 'Escape') setTip(null);
  };


  return (
    <section className={styles.box} aria-label="Cây agent và timeline" ref={wrapRef}>
      <header className={styles.head}>
        <div className={styles.title}>
          <strong>{root.label}</strong>
          <span className={styles.meta}> · {root.source} · {folder(root.cwd)}</span>
        </div>
        <div className={styles.seg} role="group" aria-label="Cửa sổ thời gian">
          {WINDOWS_MIN.map((m) => (
            <button key={m} type="button" className={styles.segBtn} aria-pressed={winMin === m} onClick={() => setWinMin(m)}>
              {m}<span className={styles.sr}> phút</span>
            </button>
          ))}
          <span className={styles.unit} aria-hidden="true">phút</span>
        </div>
      </header>

      {replaying && (
        <div className={styles.replay}>
          <span className={`${styles.replayLbl} mono`}>xem lại · {fmtClock(sliderVal)}</span>
          <input
            type="range" aria-label="Thời điểm xem lại" className={styles.range}
            min={sliderMin} max={range.max} step={1000} value={sliderVal} disabled={sliderMin >= range.max}
            onChange={(e) => setReplayAt(Number(e.target.value))}
          />
        </div>
      )}

      <div className={styles.axis} aria-hidden="true">
        <span />
        <div className={`${styles.ticks} mono`}>{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
      </div>

      <div className={styles.tree} role="tree" aria-label="Cây agent" ref={treeRef} onKeyDown={onKey}>
        {nodes.map((n, i) => {
          const a = n.agent;
          const st = statusOf(a, frame.alerts);
          const mine = frame.alerts.filter((x) => x.active && x.agentId === a.id);
          const lane = lanes[i];
          const isSel = a.id === selected;
          return (
            <div
              key={a.id} role="treeitem" aria-level={n.depth + 1} aria-selected={isSel}
              aria-label={`${a.label}, ${st.text}`} title={a.label}
              data-id={a.id} data-idx={i} tabIndex={i === focusIdx ? 0 : -1}
              className={`${styles.lane} ${isSel ? styles.sel : ''}`}
              onClick={() => selectAgent(a.id)}
              onFocus={(e) => { if (e.target === e.currentTarget) setFocusIdx(i); }}
            >
              <div className={styles.who}>
                <span className={styles.glyph} aria-hidden="true">{treeGlyph(n.depth, n.isLast)}</span>
                <span className={styles.pill} data-tone={st.tone}><span aria-hidden="true">{st.icon}</span> <span className={styles.plabel}>{a.label}</span></span>
                <span className={`${styles.model} mono`}>{[a.model, a.effort].filter(Boolean).join(' · ') || '—'}</span>
                <span className={`${styles.dur} mono`} title="Thời gian làm: từ lúc được giao tới event cuối">{fmtDuration(agentWorkMs(a, frame.now))}</span>
                {mine.length > 0 && (
                  <span className={`${styles.alert} mono`}>
                    {mine.map((x) => alertTag(x, frame.now)).join(' · ')}
                  </span>
                )}
              </div>
              <div className={styles.track} ref={i === 0 ? trackRef : undefined}>
                {width > 0 && (
                  <Lane
                    width={width} bars={lane.bars} zones={lane.loopZones} waits={laneWaits[i]} showNow={!replaying} agentId={a.id} onTip={showTip} onHide={hideTip}
                    onPick={selectCall}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {tip && <div className={`${styles.tip} mono`} style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.text}</div>}

      <footer className={styles.legend} aria-label="Chú giải">
        <span><i className={styles.sw} data-s="ok" /> ok</span>
        <span><i className={styles.sw} data-s="error" /> lỗi</span>
        <span><i className={styles.sw} data-s="running" /> đang chạy</span>
        <span><i className={styles.sw} data-s="wait" /> chờ subagent</span>
        <span><i className={styles.sw} data-s="unknown" /> không rõ</span>
        <span><i className={styles.sw} data-s="loop" /> vùng lặp</span>
        <span><i className={styles.sw} data-s="grey" /> chờ duyệt / chờ subagent</span>
        {!replaying && <span><i className={styles.nowSw} /> bây giờ</span>}
      </footer>
    </section>
  );
}

const Lane = memo(function Lane({ agentId, width, bars, zones, waits, showNow, onTip, onHide, onPick }: {
  agentId: string; width: number; bars: Bar[]; zones: LoopZone[]; waits: { x: number; w: number; title: string }[]; showNow: boolean;
  onTip: (text: string, el: Element, mouse?: { x: number; y: number }) => void;
  onHide: () => void; onPick: (agentId: string, callId: string) => void;
}) {
  const y = (LANE_H - BAR_H) / 2;
  return (
    <svg width={width} height={LANE_H} viewBox={`0 0 ${width} ${LANE_H}`} className={styles.svg} role="presentation">
      <defs>
        <pattern id="loop-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" style={{ fill: 'var(--warn)' }} fillOpacity="0.12" />
          <rect width="2.5" height="6" style={{ fill: 'var(--warn)' }} fillOpacity="0.4" />
        </pattern>
      </defs>
      {zones.map((z, i) => <rect key={i} x={z.x} y={2} width={z.w} height={LANE_H - 4} fill="url(#loop-hatch)" />)}
      {waits.map((w, i) => (
        <g key={`w${i}`}>
          <title>{w.title}</title>
          <rect x={w.x} y={y - 3} width={w.w} height={BAR_H + 6} rx={2} className={styles.wait} />
          {w.w >= 28 && <text x={w.x + 4} y={LANE_H / 2 + 3} className={styles.waitTxt}>chờ</text>}
        </g>
      ))}
      {bars.filter((b) => b.state === 'error').map((b) => (
        <path key={`n${b.callId}`} className={styles.notch} d={`M${b.x} ${y - 4}h${Math.min(b.w, 8)}v3h-${Math.min(b.w, 8)}z`} />
      ))}
      {bars.map((b) => (
        <rect
          key={b.callId} data-bar={b.callId} className={styles.bar} data-state={b.state}
          x={b.x} y={y} width={b.w} height={BAR_H} rx={2} tabIndex={-1}
          role="button" aria-label={b.title}
          onMouseEnter={(e) => onTip(b.title, e.currentTarget, { x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => onTip(b.title, e.currentTarget, { x: e.clientX, y: e.clientY })}
          onMouseLeave={onHide}
          onFocus={(e) => onTip(b.title, e.currentTarget)}
          onBlur={onHide}
          onClick={(e) => { e.stopPropagation(); onPick(agentId, b.callId); }}
        />
      ))}
      {showNow && <line x1={width - 0.5} x2={width - 0.5} y1={0} y2={LANE_H} className={styles.now} />}
    </svg>
  );
});
