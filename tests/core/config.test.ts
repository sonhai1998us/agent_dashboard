import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveSettings, validateSettings, DEFAULT_SETTINGS, DEFAULT_THRESHOLDS } from '@/src/core/config';

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

const cloneDefaults = () => ({ settings: structuredClone(DEFAULT_SETTINGS), thresholds: { ...DEFAULT_THRESHOLDS } });
const errorsOf = (raw: unknown): string[] => {
  const r = validateSettings(raw);
  return r.ok ? [] : r.errors;
};

test('settings mặc định khi không có config.json', () => {
  expect(loadConfig({ ACCTV_HOME: tmpHome() }).settings).toEqual(DEFAULT_SETTINGS);
});

test('config.json merge settings theo từng trường và từng vai', () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ settings: { maxParallel: 5, roleDefaults: { dev: { agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' } } } }),
  );
  const s = loadConfig({ ACCTV_HOME: home }).settings;
  expect(s.maxParallel).toBe(5);
  expect(s.roleDefaults.dev.model).toBe('claude-haiku-5-5');
  expect(s.roleDefaults.qc).toEqual(DEFAULT_SETTINGS.roleDefaults.qc);
  expect(s.maxRounds).toBe(3);
});

test('validateSettings chấp nhận mặc định', () => {
  expect(validateSettings(cloneDefaults()).ok).toBe(true);
});

test('validateSettings từ chối giá trị sai, lỗi nêu tên trường', () => {
  const a = cloneDefaults();
  a.settings.maxParallel = 0;
  expect(errorsOf(a).some((e) => e.includes('maxParallel'))).toBe(true);

  const b = cloneDefaults();
  b.thresholds.stuckMs = -1;
  expect(errorsOf(b).some((e) => e.includes('stuckMs'))).toBe(true);

  const c = cloneDefaults();
  c.thresholds.loopWarn = 10;
  c.thresholds.loopCritical = 10;
  expect(errorsOf(c).some((e) => e.includes('loopWarn'))).toBe(true);

  const d = cloneDefaults();
  (d.settings.roleDefaults.dev as { effort: string }).effort = 'turbo';
  expect(errorsOf(d).some((e) => e.includes('effort'))).toBe(true);

  const e = cloneDefaults();
  e.settings.denyBash = ['('];
  expect(errorsOf(e).some((x) => x.includes('denyBash'))).toBe(true);

  const f = cloneDefaults();
  f.settings.roleDefaults.qc.model = 'gpt-khong-co';
  expect(errorsOf(f).some((x) => x.includes('model'))).toBe(true);

  expect(errorsOf(null).length).toBeGreaterThan(0);
});

test('saveSettings ghi atomically, giữ backfillHours, loadConfig đọc lại, mutate cfg', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ backfillHours: 7 }));
  const cfg = loadConfig({ ACCTV_HOME: home });
  const settings = { ...structuredClone(DEFAULT_SETTINGS), maxParallel: 4 };
  const thresholds = { ...DEFAULT_THRESHOLDS, stuckMs: 999 };
  saveSettings(cfg, settings, thresholds);
  expect(cfg.settings.maxParallel).toBe(4);
  expect(cfg.thresholds.stuckMs).toBe(999);
  expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  const again = loadConfig({ ACCTV_HOME: home });
  expect(again.backfillHours).toBe(7);
  expect(again.settings.maxParallel).toBe(4);
  expect(again.thresholds.stuckMs).toBe(999);
});

test('validateSettings trả object mới chỉ gồm trường đã biết (key lạ ở mọi cấp bị bỏ)', () => {
  const raw = cloneDefaults() as any;
  raw.junk = 1;
  raw.settings.junk = 1;
  raw.settings.roleDefaults.dev.junk = 1;
  raw.settings.allowedModels.gemini = ['g'];
  raw.settings.prices = { m: { in: 1, out: 2, junk: 3 } };
  raw.thresholds.junk = 1;
  const r = validateSettings(raw);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.settings).toEqual({ ...DEFAULT_SETTINGS, prices: { m: { in: 1, out: 2 } } });
  expect(r.thresholds).toEqual(DEFAULT_THRESHOLDS);
  expect(r.settings.roleDefaults.dev).not.toBe(raw.settings.roleDefaults.dev);
  expect(r.settings.denyBash).not.toBe(raw.settings.denyBash);
});

test('validateSettings: codex cho phép model rỗng (CLI mặc định), claude thì không', () => {
  const a = cloneDefaults();
  a.settings.roleDefaults.dev = { agent: 'codex', model: '', effort: 'high' };
  expect(validateSettings(a).ok).toBe(true);

  const b = cloneDefaults();
  b.settings.roleDefaults.dev = { agent: 'codex', model: 'gpt-x', effort: 'high' };
  expect(errorsOf(b).some((x) => x.includes('roleDefaults.dev.model'))).toBe(true);
  b.settings.allowedModels.codex = ['gpt-x'];
  expect(validateSettings(b).ok).toBe(true);

  const c = cloneDefaults();
  c.settings.roleDefaults.dev.model = '';
  expect(errorsOf(c).some((x) => x.includes('roleDefaults.dev.model'))).toBe(true);
});

test('Controller luôn là claude: validateSettings từ chối codex, config.json lưu codex bị bỏ qua', () => {
  const a = cloneDefaults();
  a.settings.roleDefaults.controller = { agent: 'codex', model: '', effort: 'high' };
  expect(errorsOf(a).some((x) => x.includes('roleDefaults.controller.agent'))).toBe(true);

  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ settings: { roleDefaults: { controller: { agent: 'codex', model: 'gpt-x', effort: 'low' } } } }),
  );
  const s = loadConfig({ ACCTV_HOME: home }).settings;
  expect(s.roleDefaults.controller.agent).toBe('claude');
  expect(s.roleDefaults.controller.model).toBe(DEFAULT_SETTINGS.roleDefaults.controller.model);
});
