'use client';
import { useSyncExternalStore } from 'react';
import type { AgentInfo, Alert, CallRecord, HubEvent } from '@/src/core/model';
import type { AgentMetrics, GlobalMetrics } from '@/src/core/metrics';

export type ConnState = 'connecting' | 'live' | 'disconnected';
export interface LiveState {
  conn: ConnState; lastUpdateAt: number | null; agents: Record<string, AgentInfo>;
  alerts: Record<string, Alert>; metrics: GlobalMetrics | null; agentMetrics: Record<string, AgentMetrics>;
  calls: Record<string, CallRecord[]>; selectedAgentId: string | null;
  /** call được chọn từ timeline; cột phải cuộn tới nó */
  selectedCallId: string | null;
  /** tăng mỗi lần chọn call (kể cả cùng id) để cột phải cuộn lại */
  selectedCallNonce: number;
  /** local time (ms) of the last applied alert event per alert id; used to resolve snapshot/WS races */
  alertEventAt: Record<string, number>;
}
export interface SnapshotAction {
  type: 'snapshot'; generatedAt: number; agents: AgentInfo[]; alerts: Alert[];
  metrics: GlobalMetrics; agentMetrics: Record<string, AgentMetrics>;
}
export type LiveAction =
  | Exclude<HubEvent, { type: 'alert' }>
  | { type: 'alert'; alert: Alert; at?: number }
  | { type: 'metrics'; metrics: GlobalMetrics; at: number }
  | { type: 'conn'; conn: ConnState }
  | SnapshotAction
  | { type: 'calls'; agentId: string; calls: CallRecord[] }
  | { type: 'select'; id: string | null }
  | { type: 'selectCall'; agentId: string; callId: string };

export function initialState(): LiveState {
  return {
    conn: 'connecting', lastUpdateAt: null, agents: {}, alerts: {}, metrics: null,
    agentMetrics: {}, calls: {}, selectedAgentId: null, selectedCallId: null, selectedCallNonce: 0, alertEventAt: {},
  };
}

const MAX_CALLS = 2000;

function mergeCalls(existing: CallRecord[] | undefined, incoming: CallRecord[]): CallRecord[] {
  const byId = new Map<string, CallRecord>();
  for (const c of existing ?? []) byId.set(c.id, c);
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_CALLS);
}

export function reduce(s: LiveState, e: LiveAction): LiveState {
  switch (e.type) {
    case 'agent': return { ...s, agents: { ...s.agents, [e.agent.id]: e.agent } };
    case 'call': return { ...s, calls: { ...s.calls, [e.call.agentId]: mergeCalls(s.calls[e.call.agentId], [e.call]) } };
    case 'alert': {
      const alerts = { ...s.alerts };
      if (e.alert.active) alerts[e.alert.id] = e.alert; else delete alerts[e.alert.id];
      return { ...s, alerts, alertEventAt: { ...s.alertEventAt, [e.alert.id]: e.at ?? 0 } };
    }
    case 'metrics': return { ...s, metrics: e.metrics, lastUpdateAt: e.at };
    case 'conn': return { ...s, conn: e.conn };
    case 'snapshot': {
      // keep per-entity data that is newer than the snapshot (events that raced the fetch)
      const agents: Record<string, AgentInfo> = Object.fromEntries(e.agents.map((a) => [a.id, a]));
      for (const [id, cur] of Object.entries(s.agents)) {
        const snap = agents[id];
        if (snap ? cur.lastEventAt > snap.lastEventAt : cur.lastEventAt >= e.generatedAt) agents[id] = cur;
      }
      const alerts: Record<string, Alert> = Object.fromEntries(e.alerts.filter((a) => a.active).map((a) => [a.id, a]));
      for (const [id, at] of Object.entries(s.alertEventAt)) {
        if (at <= e.generatedAt) continue;
        if (s.alerts[id]) alerts[id] = s.alerts[id]; else delete alerts[id];
      }
      const selectedAgentId = s.selectedAgentId && agents[s.selectedAgentId] ? s.selectedAgentId : null;
      return { ...s, agents, alerts, selectedAgentId, selectedCallId: selectedAgentId ? s.selectedCallId : null, metrics: e.metrics, agentMetrics: e.agentMetrics, lastUpdateAt: e.generatedAt };
    }
    case 'calls': return { ...s, calls: { ...s.calls, [e.agentId]: mergeCalls(s.calls[e.agentId], e.calls) } };
    case 'select': return { ...s, selectedAgentId: e.id, selectedCallId: e.id === s.selectedAgentId ? s.selectedCallId : null };
    case 'selectCall': return { ...s, selectedAgentId: e.agentId, selectedCallId: e.callId, selectedCallNonce: s.selectedCallNonce + 1 };
    default: return s;
  }
}

// ---- thin runtime (untested: browser only) ----
let state = initialState();
const listeners = new Set<() => void>();
const loadedCalls = new Set<string>();
let started = false;

function dispatch(a: LiveAction): void {
  state = reduce(state, a.type === 'alert' ? { ...a, at: Date.now() } : a);
  listeners.forEach((l) => l());
}

async function loadSnapshot(): Promise<void> {
  const r = await fetch('/api/snapshot', { cache: 'no-store' });
  if (!r.ok) throw new Error(`snapshot ${r.status}`);
  const j = await r.json();
  dispatch({ type: 'snapshot', generatedAt: j.generatedAt, agents: j.agents, alerts: j.alerts, metrics: j.metrics, agentMetrics: j.agentMetrics });
}

const BACKOFF = [1000, 2000, 5000, 10000];

function connect(attempt: number): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    dispatch({ type: 'conn', conn: 'live' });
    loadedCalls.clear();
    loadSnapshot().catch(() => {});
    if (state.selectedAgentId) void loadCalls(state.selectedAgentId);
  };
  ws.onmessage = (m) => {
    try { dispatch(JSON.parse(String(m.data))); } catch { /* ignore malformed or unexpected messages */ }
  };
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    dispatch({ type: 'conn', conn: 'disconnected' });
    setTimeout(() => connect(attempt + 1), BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
  };
  ws.onclose = retry;
  ws.onerror = () => ws.close();
  ws.addEventListener('open', () => { attempt = 0; });
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  loadSnapshot().catch(() => {});
  connect(0);
}

async function loadCalls(id: string): Promise<void> {
  loadedCalls.add(id);
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(id)}/calls?limit=500`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    dispatch({ type: 'calls', agentId: id, calls: await r.json() });
  } catch { loadedCalls.delete(id); }
}

export function selectAgent(id: string): void {
  dispatch({ type: 'select', id });
  if (!loadedCalls.has(id)) void loadCalls(id);
}

export function ensureCalls(id: string): void {
  if (!loadedCalls.has(id)) void loadCalls(id);
}

export function selectCall(agentId: string, callId: string): void {
  dispatch({ type: 'selectCall', agentId, callId });
  ensureCalls(agentId);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  start();
  return () => { listeners.delete(l); };
}

export function useLive<T>(sel: (s: LiveState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(initialSnapshot));
}
const initialSnapshot = initialState();
