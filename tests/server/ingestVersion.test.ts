import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '@/src/core/config';
import { Store } from '@/src/core/store';
import { INGEST_VERSION } from '@/src/core/version';
import { createCore } from '@/src/server/core';

let tmp: string;
let cfg: Config;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-ver-'));
  cfg = loadConfig({ ACCTV_HOME: path.join(tmp, 'home'), ACCTV_CLAUDE_DIR: path.join(tmp, 'c'), ACCTV_CODEX_DIR: path.join(tmp, 'x') });
  fs.mkdirSync(path.join(cfg.claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(cfg.codexDir, 'sessions'), { recursive: true });
  fs.mkdirSync(cfg.home, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dbPath = () => path.join(cfg.home, 'acctv.db');
function seed(version?: string) {
  const s = new Store(dbPath());
  s.applyEvent({ type: 'agent', agent: { id: 'claude:s1', source: 'claude', sessionId: 's1', label: 'demo', startedAt: 1, lastEventAt: 1 } });
  s.applyEvent({ type: 'call_start', call: { id: 'c1', agentId: 'claude:s1', kind: 'tool', name: 'Bash', inputHash: 'h', inputPreview: 'x', startedAt: 2, tokensIn: null, tokensOut: null } });
  s.upsertAlert({ id: 'a1', agentId: 'claude:s1', kind: 'stuck', level: 'warn', message: 'm', since: 1, active: true });
  s.setOffset('/nonexistent.jsonl', 10, 1);
  if (version !== undefined) s.setMeta('ingestVersion', version);
  s.close();
}

test('fresh DB stores the ingest version', async () => {
  const core = await createCore(cfg);
  expect(core.store.getMeta('ingestVersion')).toBe(String(INGEST_VERSION));
  await core.stop();
});

test('older ingest version: agents, calls, alerts and offsets are cleared', async () => {
  seed('0');
  const core = await createCore(cfg);
  expect(core.store.listAgents()).toEqual([]);
  expect(core.store.listCalls('claude:s1')).toEqual([]);
  expect(core.store.activeAlerts()).toEqual([]);
  expect(core.store.getOffset('/nonexistent.jsonl')).toBeUndefined();
  expect(core.store.getMeta('ingestVersion')).toBe(String(INGEST_VERSION));
  await core.stop();
});

test('missing version on an existing DB counts as older', async () => {
  seed();
  const core = await createCore(cfg);
  expect(core.store.listAgents()).toEqual([]);
  await core.stop();
});

test('same ingest version keeps data', async () => {
  seed(String(INGEST_VERSION));
  const core = await createCore(cfg);
  expect(core.store.listAgents().length).toBe(1);
  expect(core.store.listCalls('claude:s1').length).toBe(1);
  expect(core.store.activeAlerts().length).toBe(1);
  expect(core.store.getOffset('/nonexistent.jsonl')).toEqual({ offset: 10, lines: 1 });
  await core.stop();
});
