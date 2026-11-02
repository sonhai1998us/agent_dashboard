import type { Store } from '@/src/core/store';
import type { Config } from '@/src/core/config';
import type { Alert, AlertKind, HubEvent } from '@/src/core/model';
import { detectStuck, detectLongTool, detectLoop, detectErrorBurst } from './rules';

const KINDS: AlertKind[] = ['stuck', 'long_tool', 'loop', 'error_burst'];

// Phase 1: chỉ cảnh báo, không bao giờ dừng/kill agent.
export class DetectEngine {
  private state = new Map<string, Alert>();

  constructor(private store: Store, private cfg: Config, private publish: (e: HubEvent) => void) {
    for (const a of store.activeAlerts()) this.state.set(a.id, a);
  }

  private recentTools(agentId: string) {
    const calls = this.store.listCalls(agentId, { limit: Math.max(50, this.cfg.thresholds.loopWindow * 3) });
    return calls.filter((c) => c.kind === 'tool').reverse();
  }

  private reconcile(agentId: string, kind: AlertKind, cand: Alert | null): void {
    const id = `${agentId}:${kind}`;
    const prev = this.state.get(id);
    const wasActive = !!prev?.active;
    if (cand) {
      const next: Alert = { ...cand, since: wasActive ? prev!.since : cand.since };
      const levelChanged = !wasActive || prev!.level !== next.level;
      // stuck/long_tool có thông điệp đổi mỗi tick (thời lượng) nên không publish theo message
      const msgChanged = wasActive && prev!.message !== next.message && (kind === 'loop' || kind === 'error_burst');
      if (!wasActive || prev!.message !== next.message || levelChanged) {
        this.store.upsertAlert(next);
        this.state.set(id, next);
      }
      if (levelChanged || msgChanged) this.publish({ type: 'alert', alert: next });
    } else if (wasActive) {
      const off: Alert = { ...prev!, active: false };
      this.store.upsertAlert(off);
      this.state.set(id, off);
      this.publish({ type: 'alert', alert: off });
    }
  }

  onCall(agentId: string): void {
    const a = this.store.getAgent(agentId);
    if (!a) return;
    const live = a.status !== 'ended';
    const tools = live ? this.recentTools(agentId) : [];
    this.reconcile(agentId, 'loop', live ? detectLoop(a, tools, this.cfg.thresholds) : null);
    this.reconcile(agentId, 'error_burst', live ? detectErrorBurst(a, tools, this.cfg.thresholds) : null);
  }

  tick(now: number): void {
    const t = this.cfg.thresholds;
    for (const a of this.store.listAgents()) {
      if (a.status === 'ended') {
        for (const k of KINDS) this.reconcile(a.id, k, null);
        continue;
      }
      if (a.status === 'running') {
        const open = this.store.openCalls(a.id);
        this.reconcile(a.id, 'stuck', detectStuck(a, open, now, t));
        this.reconcile(a.id, 'long_tool', detectLongTool(a, open, now, t));
      } else {
        this.reconcile(a.id, 'stuck', null);
        this.reconcile(a.id, 'long_tool', null);
      }
    }
  }
}
