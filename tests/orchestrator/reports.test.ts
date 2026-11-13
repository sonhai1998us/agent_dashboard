import { test, expect } from 'vitest';
import { agentReport } from '@/src/orchestrator/reports';
import type { ManagedAgent } from '@/src/tickets/model';

test('báo cáo cho Controller ghi mode của QC cases; agent khác không có trường mode', () => {
  const m = { agentId: 'acctv:T-1:qc-1', role: 'qc', state: 'done', stopReason: null, resultText: 'TC-1', changedFiles: [] } as unknown as ManagedAgent;
  expect(agentReport({ ...m, mode: 'cases' }, undefined, [], 0).mode).toBe('cases');
  expect('mode' in agentReport({ ...m, mode: null }, undefined, [], 0)).toBe(false);
});
