import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { turn } from '@/src/orchestrator/prompts';
import { makeEnv, cleanup, validPlan, ids, runOf, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => cleanup(env));

const opusPlan = () => {
  const p = validPlan();
  p.roles.dev = { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', count: 2 };
  return p;
};

/** Ticket có lựa chọn của người dùng cho Dev; Controller đề xuất Opus. */
async function proposed(overrides = { dev: { agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const } }) {
  const t = await env.orch.createTicket({ title: 'Trang', description: 'd', dir: env.repo, overrides });
  const r = await env.orch.mcpTools(t.id).propose_plan({ plan: opusPlan() });
  return { T: t.id, r };
}

describe('lựa chọn model/effort của người dùng là bắt buộc', () => {
  it('propose_plan: vai người dùng đã chọn bị ghi đè theo lựa chọn đó, Controller được báo', async () => {
    const { T, r } = await proposed();
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/theo lựa chọn của người dùng/);
    expect(r.text).toContain('dev: claude-sonnet-5-5/medium');
    expect(env.tickets.getTicket(T)!.plan!.roles.dev).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', count: 2 });
    // vai không chọn: giữ đề xuất của Controller
    expect(env.tickets.getTicket(T)!.plan!.roles.qc).toEqual(validPlan().roles.qc);
  });

  it('không có lựa chọn → giữ đề xuất của Controller, không báo gì', async () => {
    const t = await env.orch.createTicket({ title: 'Trang', description: 'd', dir: env.repo });
    const r = await env.orch.mcpTools(t.id).propose_plan({ plan: opusPlan() });
    expect(r.text).not.toMatch(/lựa chọn của người dùng/);
    expect(env.tickets.getTicket(t.id)!.plan!.roles.dev.model).toBe('claude-opus-5-5');
  });

  it('spawn_agent theo kế hoạch đã duyệt: model/effort Controller truyền khác thì bị bỏ qua và được báo', async () => {
    const { T } = await proposed();
    env.runs[env.runs.length - 1].finish({});
    await env.orch.idle();
    await env.orch.approve(T);
    await env.orch.idle();
    const s = await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'], model: 'claude-opus-5-5', effort: 'max' });
    expect(s.isError).toBeFalsy();
    expect(s.text).toContain('(dev, claude-sonnet-5-5/medium)');
    expect(s.text).toMatch(/theo kế hoạch đã duyệt/);
    expect(runOf(env, ids(T).dev1)!.spec).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(env.tickets.getManaged(ids(T).dev1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });

  it('người dùng sửa kế hoạch lúc duyệt: bản sửa thắng lựa chọn ở form', async () => {
    const { T } = await proposed();
    env.runs[env.runs.length - 1].finish({});
    await env.orch.idle();
    const edited = env.tickets.getTicket(T)!.plan!;
    edited.roles.dev = { ...edited.roles.dev, model: 'claude-haiku-5-5', effort: 'low' };
    await env.orch.approve(T, edited);
    await env.orch.idle();
    const s = await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'a', files: ['src/a.ts'] });
    expect(s.text).toContain('(dev, claude-haiku-5-5/low)');
    expect(s.text).not.toMatch(/bỏ qua/);
  });

  it('lượt đầu của Controller nói rõ lựa chọn là bắt buộc', () => {
    const t = { id: 'T-1', title: 'x', description: 'y', dir: 'D:\\a', overrides: { dev: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } } };
    const s = turn.first(t as never);
    expect(s).toMatch(/bắt buộc/);
    expect(s).toContain('dev: claude / claude-sonnet-5-5 / high');
  });
});
