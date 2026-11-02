import { test, expect } from 'vitest';
import { Store } from '@/src/core/store';
import { DetectEngine } from '@/src/detect/engine';
import { DEFAULT_THRESHOLDS } from '@/src/core/config';
import type { Config } from '@/src/core/config';
import type { HubEvent } from '@/src/core/model';

const cfg = { thresholds: DEFAULT_THRESHOLDS } as Config;
const ID = 'claude:s1';
function setup() {
  const s = new Store(':memory:');
  s.applyEvent({ type: 'agent', agent: { id: ID, source: 'claude', sessionId: 's1', label: 'demo', startedAt: 1000, lastEventAt: 1000, status: 'running' } });
  const ev: HubEvent[] = [];
  return { s, ev, e: new DetectEngine(s, cfg, (x) => ev.push(x)) };
}
let i = 0;
const start = (s: Store, name: string, input: string, at: number) => {
  const id = `c${i++}`;
  s.applyEvent({ type: 'call_start', call: { id, agentId: ID, kind: 'tool', name, inputHash: input, inputPreview: input, startedAt: at, tokensIn: null, tokensOut: null } });
  return id;
};
const end = (s: Store, id: string, at: number, ok = true) => s.applyEvent({ type: 'call_end', agentId: ID, callId: id, endedAt: at, ok, errorPreview: null });

test('engine: hết điều kiện → alert active=false được publish', () => {
  const { s, ev, e } = setup();
  e.tick(1000 + 130000);
  expect(ev.at(-1)).toMatchObject({ type: 'alert', alert: { kind: 'stuck', active: true } });
  const n = ev.length;
  e.tick(1000 + 135000); // không publish lặp
  expect(ev.length).toBe(n);
  s.applyEvent({ type: 'activity', agentId: ID, at: 1000 + 136000 });
  e.tick(1000 + 137000);
  expect(ev.at(-1)).toMatchObject({ type: 'alert', alert: { kind: 'stuck', active: false } });
  expect(s.activeAlerts()).toEqual([]);
});

test('engine: loop giữ since gốc, agent ended thì tắt hết alert', () => {
  const { s, ev, e } = setup();
  for (let k = 0; k < 3; k++) end(s, start(s, 'Bash', 'npm test', 2000 + k * 10), 2005 + k * 10);
  e.onCall(ID);
  const first = s.activeAlerts().find((a) => a.kind === 'loop')!;
  expect(first.message).toBe('lặp 3× Bash npm test');
  end(s, start(s, 'Bash', 'npm test', 3000), 3005);
  e.onCall(ID);
  const second = s.activeAlerts().find((a) => a.kind === 'loop')!;
  expect(second.message).toBe('lặp 4× Bash npm test'); expect(second.since).toBe(first.since);
  s.setAgentStatus(ID, 'ended');
  e.tick(4000);
  expect(s.activeAlerts()).toEqual([]);
  expect(ev.at(-1)).toMatchObject({ alert: { active: false } });
});

test('engine không bao giờ dừng agent (chỉ cảnh báo)', () => {
  const { s, e } = setup();
  for (let k = 0; k < 6; k++) end(s, start(s, 'Bash', 'x', 2000 + k * 10), 2005 + k * 10, false);
  e.onCall(ID); e.tick(1000 + 600000);
  expect(s.getAgent(ID)!.status).toBe('running');
  expect(s.activeAlerts().map((a) => a.kind).sort()).toEqual(['error_burst', 'loop', 'stuck']);
  expect((e as any).stop ?? (e as any).kill).toBeUndefined();
});
