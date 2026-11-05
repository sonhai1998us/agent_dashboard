import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, Effort, Role, RoleSpec } from '@/src/tickets/model';

export interface Thresholds {
  stuckMs: number;
  longToolMs: number;
  loopWindow: number;
  loopWarn: number;
  loopCritical: number;
  errorBurst: number;
}

export interface Settings {
  roleDefaults: Record<Role, RoleSpec>;
  allowedModels: Record<AgentKind, string[]>;
  denyBash: string[];
  checkCommands: string[];
  maxRounds: number;
  maxParallel: number;
  prices: Record<string, { in: number; out: number }>;
  claudePath: string | null;
  codexPath: string | null;
}

export interface Config {
  home: string;
  claudeDir: string;
  codexDir: string;
  port: number;
  host: '127.0.0.1';
  backfillHours: number;
  thresholds: Thresholds;
  settings: Settings;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  stuckMs: 120000,
  longToolMs: 300000,
  loopWindow: 20,
  loopWarn: 3,
  loopCritical: 10,
  errorBurst: 5,
};

export const DEFAULT_SETTINGS: Settings = {
  roleDefaults: {
    controller: { agent: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    dev: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    designer: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    qc: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
  },
  allowedModels: {
    claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    codex: [],
  },
  denyBash: [
    // tuỳ chọn toàn cục của git (-C <dir>, -c k=v, --opt, --opt=v) đứng giữa `git` và lệnh con không lách được
    String.raw`\bgit(?:\.exe)?["']?(?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|super-prefix|config-env)\s+\S+|--?[\w-]+(?:=\S+)?))*\s+(commit|push|pull|fetch|checkout|switch|branch|merge|rebase|reset|remote|tag|worktree|stash|cherry-pick|revert|am|clean|config)\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\b(?=[^\n]*\s(i|install|add)\b)[^\n]*\s(-g|--global|--location[= ]["']?global)\b`,
    String.raw`\byarn\s+global\s+add\b`,
    String.raw`\bnpm\s+link\b`,
    String.raw`\b(127\.0\.0\.1|localhost)(:\d+)?/(api|mcp)\b`,
    String.raw`\b(reg|setx|regedit|bcdedit|diskpart|shutdown|winget|choco|scoop|apt|apt-get|brew|sudo|runas)\b`,
    String.raw`\b(taskkill|Stop-Process|pkill|killall)\b`,
    String.raw`\bkill\s+-`,
    String.raw`\brm\s+-\w*r\w*\s+(/|~|[A-Za-z]:[\\/])`,
    String.raw`Remove-Item\b[^\n]*-Recurse`,
  ],
  checkCommands: [
    String.raw`^\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|typecheck|check|preview)\b`,
    String.raw`^\s*npx\s+(tsc|vitest|jest|eslint|playwright|prettier\s+--check)\b`,
    String.raw`^\s*git\s+(status|diff|log|show)\b`,
  ],
  maxRounds: 3,
  maxParallel: 3,
  prices: {},
  claudePath: null,
  codexPath: null,
};

const ROLES: Role[] = ['controller', 'dev', 'designer', 'qc'];
const AGENTS: AgentKind[] = ['claude', 'codex'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isRegexArr = (v: unknown): v is string[] =>
  isStrArr(v) &&
  v.every((x) => {
    try {
      new RegExp(x, 'i');
      return true;
    } catch {
      return false;
    }
  });
const isPath = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.trim() !== '');
const isPrice = (v: unknown): v is { in: number; out: number } =>
  isObj(v) && typeof v.in === 'number' && v.in >= 0 && typeof v.out === 'number' && v.out >= 0;

/** Merge từng trường; giá trị không hợp lệ bị bỏ qua, giữ mặc định. */
function mergeSettings(raw: unknown): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!isObj(raw)) return s;
  if (isObj(raw.roleDefaults)) {
    for (const r of ROLES) {
      const o = raw.roleDefaults[r];
      if (!isObj(o)) continue;
      if (AGENTS.includes(o.agent as AgentKind)) s.roleDefaults[r].agent = o.agent as AgentKind;
      if (typeof o.model === 'string' && (o.model || s.roleDefaults[r].agent === 'codex')) s.roleDefaults[r].model = o.model;
      if (EFFORTS.includes(o.effort as Effort)) s.roleDefaults[r].effort = o.effort as Effort;
    }
  }
  if (isObj(raw.allowedModels)) {
    for (const k of AGENTS) if (isStrArr(raw.allowedModels[k])) s.allowedModels[k] = raw.allowedModels[k] as string[];
  }
  if (isRegexArr(raw.denyBash)) s.denyBash = raw.denyBash;
  if (isRegexArr(raw.checkCommands)) s.checkCommands = raw.checkCommands;
  if (isPosInt(raw.maxRounds)) s.maxRounds = raw.maxRounds;
  if (isPosInt(raw.maxParallel)) s.maxParallel = raw.maxParallel;
  if (isObj(raw.prices)) {
    s.prices = {};
    for (const [k, v] of Object.entries(raw.prices)) if (isPrice(v)) s.prices[k] = { in: v.in, out: v.out };
  }
  if (isPath(raw.claudePath)) s.claudePath = raw.claudePath;
  if (isPath(raw.codexPath)) s.codexPath = raw.codexPath;
  return s;
}

export function validateSettings(
  raw: unknown,
): { ok: true; settings: Settings; thresholds: Thresholds } | { ok: false; errors: string[] } {
  if (!isObj(raw) || !isObj(raw.settings) || !isObj(raw.thresholds)) {
    return { ok: false, errors: ['body phải có settings và thresholds'] };
  }
  const errors: string[] = [];
  const s = raw.settings;
  const t = raw.thresholds;
  if (!isPosInt(s.maxParallel)) errors.push('maxParallel phải là số nguyên ≥ 1');
  if (!isPosInt(s.maxRounds)) errors.push('maxRounds phải là số nguyên ≥ 1');
  if (!isRegexArr(s.denyBash)) errors.push('denyBash phải là mảng regex hợp lệ');
  if (!isRegexArr(s.checkCommands)) errors.push('checkCommands phải là mảng regex hợp lệ');
  if (!isPath(s.claudePath)) errors.push('claudePath phải là chuỗi hoặc null');
  if (!isPath(s.codexPath)) errors.push('codexPath phải là chuỗi hoặc null');
  if (!isObj(s.prices) || !Object.values(s.prices).every(isPrice)) errors.push('prices phải ánh xạ model sang {in, out} ≥ 0');
  const am = isObj(s.allowedModels) ? s.allowedModels : {};
  for (const k of AGENTS) if (!isStrArr(am[k])) errors.push(`allowedModels.${k} phải là mảng chuỗi`);
  const rd = isObj(s.roleDefaults) ? s.roleDefaults : {};
  for (const r of ROLES) {
    const o = rd[r];
    if (!isObj(o)) {
      errors.push(`roleDefaults.${r} thiếu`);
      continue;
    }
    if (!AGENTS.includes(o.agent as AgentKind)) errors.push(`roleDefaults.${r}.agent không hợp lệ`);
    if (!EFFORTS.includes(o.effort as Effort)) errors.push(`roleDefaults.${r}.effort không hợp lệ`);
    const list = AGENTS.includes(o.agent as AgentKind) ? am[o.agent as AgentKind] : null;
    if (typeof o.model !== 'string') errors.push(`roleDefaults.${r}.model phải là chuỗi`);
    else if (!o.model) {
      if (o.agent !== 'codex') errors.push(`roleDefaults.${r}.model không được rỗng`);
    } else if (isStrArr(list) && !list.includes(o.model)) errors.push(`roleDefaults.${r}.model "${o.model}" không nằm trong allowedModels.${String(o.agent)}`);
  }
  for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const v = t[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errors.push(`thresholds.${k} phải là số > 0`);
  }
  if (typeof t.loopWarn === 'number' && typeof t.loopCritical === 'number' && t.loopWarn >= t.loopCritical) {
    errors.push('thresholds.loopWarn phải nhỏ hơn loopCritical');
  }
  if (errors.length) return { ok: false, errors };
  // dựng object mới từng trường: key lạ ở mọi cấp bị bỏ, không lọt vào config.json
  const role = (r: Role): RoleSpec => {
    const o = rd[r] as Record<string, unknown>;
    return { agent: o.agent as AgentKind, model: o.model as string, effort: o.effort as Effort };
  };
  const prices: Settings['prices'] = {};
  for (const [k, v] of Object.entries(s.prices as Record<string, { in: number; out: number }>)) prices[k] = { in: v.in, out: v.out };
  const settings: Settings = {
    roleDefaults: { controller: role('controller'), dev: role('dev'), designer: role('designer'), qc: role('qc') },
    allowedModels: { claude: [...(am.claude as string[])], codex: [...(am.codex as string[])] },
    denyBash: [...(s.denyBash as string[])],
    checkCommands: [...(s.checkCommands as string[])],
    maxRounds: s.maxRounds as number,
    maxParallel: s.maxParallel as number,
    prices,
    claudePath: s.claudePath as string | null,
    codexPath: s.codexPath as string | null,
  };
  const thresholds = {} as Thresholds;
  for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) thresholds[k] = t[k] as number;
  return { ok: true, settings, thresholds };
}

export function saveSettings(cfg: Config, settings: Settings, thresholds: Thresholds): void {
  const file = path.join(cfg.home, 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObj(j)) existing = j;
  } catch {
    // chưa có hoặc hỏng: ghi mới
  }
  fs.mkdirSync(cfg.home, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...existing, backfillHours: cfg.backfillHours, settings, thresholds }, null, 2));
  fs.renameSync(tmp, file);
  cfg.settings = structuredClone(settings);
  cfg.thresholds = { ...thresholds };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const userHome = os.homedir();
  const cfg: Config = {
    home: env.ACCTV_HOME ?? path.join(userHome, '.acctv'),
    claudeDir: env.ACCTV_CLAUDE_DIR ?? path.join(userHome, '.claude'),
    codexDir: env.ACCTV_CODEX_DIR ?? path.join(userHome, '.codex'),
    port: 4777,
    host: '127.0.0.1',
    backfillHours: 24,
    thresholds: { ...DEFAULT_THRESHOLDS },
    settings: structuredClone(DEFAULT_SETTINGS),
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
    cfg.settings = mergeSettings(o.settings);
  }
  return cfg;
}
