import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@/src/core/config';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-cfg-'));
}

test('mặc định đúng spec', () => {
  const c = loadConfig({ ACCTV_HOME: tmpHome() });
  expect(c.thresholds).toEqual({ stuckMs: 120000, longToolMs: 300000, loopWindow: 20, loopWarn: 3, loopCritical: 10, errorBurst: 5 });
  expect(c.host).toBe('127.0.0.1');
  expect(c.port).toBe(4777);
  expect(c.backfillHours).toBe(24);
  expect(c.claudeDir).toBe(path.join(os.homedir(), '.claude'));
  expect(c.codexDir).toBe(path.join(os.homedir(), '.codex'));
});

test('home mặc định là ~/.acctv và env ghi đè dirs', () => {
  const c = loadConfig({ ACCTV_CLAUDE_DIR: 'X', ACCTV_CODEX_DIR: 'Y' });
  expect(c.home).toBe(path.join(os.homedir(), '.acctv'));
  expect(c.claudeDir).toBe('X');
  expect(c.codexDir).toBe('Y');
});

test('config.json ghi đè một phần thresholds', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ thresholds: { stuckMs: 5 }, backfillHours: 2 }));
  const c = loadConfig({ ACCTV_HOME: home });
  expect(c.thresholds.stuckMs).toBe(5);
  expect(c.thresholds.longToolMs).toBe(300000);
  expect(c.backfillHours).toBe(2);
  expect(c.host).toBe('127.0.0.1');
});

test('config.json hỏng bị bỏ qua', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), '{nope');
  expect(loadConfig({ ACCTV_HOME: home }).port).toBe(4777);
});
