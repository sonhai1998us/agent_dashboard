import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings, DEFAULT_THRESHOLDS } from '@/src/core/config';
import { makeEnv, cleanup, ids, runOf, toRunning, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => cleanup(env));

describe('Controller dùng model rẻ hơn sau khi duyệt', () => {
  it('mặc định: lập kế hoạch Opus xhigh, sau duyệt Sonnet high; Designer/QC Haiku', () => {
    expect(DEFAULT_SETTINGS.roleDefaults.controller).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' });
    expect(DEFAULT_SETTINGS.controllerExec).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(DEFAULT_SETTINGS.roleDefaults.designer.model).toBe('claude-haiku-5-5');
    expect(DEFAULT_SETTINGS.roleDefaults.qc.model).toBe('claude-haiku-5-5');
  });

  it('lượt lập kế hoạch giữ model của Controller; lượt sau duyệt dùng controllerExec, cùng session', async () => {
    const T = await toRunning(env);
    const { ctrl } = ids(T);
    const runs = env.runs.filter((r) => r.spec.agentId === ctrl);
    expect(runs[0].spec).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', resume: false });
    const last = runOf(env, ctrl)!;
    expect(last.spec).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', resume: true, sessionId: runs[0].spec.sessionId });
    expect(env.tickets.getManaged(ctrl)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(env.store.getAgent(ctrl)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(env.tickets.listLog(T).map((l) => l.text)).toContain('Controller chạy claude-sonnet-5-5/high (sau khi duyệt)');
  });

  it('controllerExec null hoặc model không còn được phép: dùng như lúc lập kế hoạch', async () => {
    env.cfg.settings.controllerExec = null;
    const T = await toRunning(env);
    expect(runOf(env, ids(T).ctrl)!.spec).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' });
    env.cfg.settings.controllerExec = { model: 'claude-khong-co', effort: 'low' };
    const T2 = await toRunning(env);
    expect(runOf(env, ids(T2).ctrl)!.spec).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' });
  });

  it('validateSettings: controllerExec thiếu → mặc định, null giữ null, model lạ hoặc effort sai → lỗi', () => {
    const body = (ce: unknown) => {
      const settings: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS) as never;
      if (ce === undefined) delete settings.controllerExec; else settings.controllerExec = ce;
      return { settings, thresholds: { ...DEFAULT_THRESHOLDS } };
    };
    const a = validateSettings(body(undefined));
    expect(a.ok && a.settings.controllerExec).toEqual(DEFAULT_SETTINGS.controllerExec);
    const b = validateSettings(body(null));
    expect(b.ok && b.settings.controllerExec).toBeNull();
    const c = validateSettings(body({ model: 'claude-haiku-5-5', effort: 'medium', extra: 1 }));
    expect(c.ok && c.settings.controllerExec).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' });
    const d = validateSettings(body({ model: 'gpt-x', effort: 'high' }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.errors.join('\n')).toMatch(/controllerExec\.model/);
    const e = validateSettings(body({ model: 'claude-haiku-5-5', effort: 'ultra' }));
    expect(e.ok).toBe(false);
  });
});
