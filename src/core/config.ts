import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Thresholds {
  stuckMs: number;
  longToolMs: number;
  loopWindow: number;
  loopWarn: number;
  loopCritical: number;
  errorBurst: number;
}

export interface Config {
  home: string;
  claudeDir: string;
  codexDir: string;
  port: number;
  host: '127.0.0.1';
  backfillHours: number;
  thresholds: Thresholds;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  stuckMs: 120000,
  longToolMs: 300000,
  loopWindow: 20,
  loopWarn: 3,
  loopCritical: 10,
  errorBurst: 5,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const userHome = os.homedir();
  const cfg: Config = {
    home: env.ACCTV_HOME ?? path.join(userHome, '.acctv'),
    claudeDir: env.ACCTV_CLAUDE_DIR ?? path.join(userHome, '.claude'),
    codexDir: env.ACCTV_CODEX_DIR ?? path.join(userHome, '.codex'),
    port: 4777,
    host: '127.0.0.1',
    backfillHours: 24,
    thresholds: { ...DEFAULT_THRESHOLDS },
  };

  let override: unknown;
  try {
    override = JSON.parse(fs.readFileSync(path.join(cfg.home, 'config.json'), 'utf8'));
  } catch {
    return cfg; // missing or invalid config.json: use defaults
  }
  if (override && typeof override === 'object') {
    const o = override as Record<string, unknown>;
    if (typeof o.backfillHours === 'number') cfg.backfillHours = o.backfillHours;
    if (o.thresholds && typeof o.thresholds === 'object') {
      const t = o.thresholds as Record<string, unknown>;
      for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
        if (typeof t[k] === 'number') cfg.thresholds[k] = t[k] as number;
      }
    }
  }
  return cfg;
}
