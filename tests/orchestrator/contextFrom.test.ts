import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TOOL_DEFS } from '@/src/orchestrator/mcp';
import { CONTEXT_MAX } from '@/src/orchestrator/prompts';
import { makeEnv, cleanup, validPlan, runOf, toRunning, type Env } from '../helpers/orchestratorEnv';

let env: Env;
beforeEach(() => { env = makeEnv({ maxParallel: 3 }); });
afterEach(() => cleanup(env));

const plan = () => {
  const p = validPlan();
  p.roles.explorer = { agent: 'claude', model: 'claude-haiku-5-5', effort: 'high', count: 1 };
  return p;
};

/** Ticket running có explorer-1 đã xong với báo cáo `text`. */
async function withExplorer(text: string): Promise<string> {
  const T = await toRunning(env, plan());
  const tools = env.orch.mcpTools(T);
  await tools.spawn_agent({ role: 'explorer', task: 'Tìm file', files: [] });
  await tools.wait_agents({ ids: [`acctv:${T}:explorer-1`] });
  runOf(env, `acctv:${T}:explorer-1`)!.finish({ text });
  await env.orch.idle();
  return T;
}

describe('spawn_agent contextFrom', () => {
  it('chèn nguyên văn báo cáo vào prompt của Dev; nhận cả id ngắn; lưu lại trong managed', async () => {
    const T = await withExplorer('File cần sửa: src/a.ts dòng 12\nMàu nút: #1A73E8');
    const r = await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'Đổi màu nút', files: ['src/a.ts'], contextFrom: ['explorer-1'] });
    expect(r.isError).toBeFalsy();
    const p = runOf(env, `acctv:${T}:dev-1`)!.spec.prompt;
    expect(p).toContain(`### Báo cáo của acctv:${T}:explorer-1 (explorer)\nFile cần sửa: src/a.ts dòng 12\nMàu nút: #1A73E8`);
    // báo cáo nằm sau phần việc, trước danh sách file
    expect(p.indexOf('Đổi màu nút')).toBeLessThan(p.indexOf('### Báo cáo'));
    expect(p.indexOf('### Báo cáo')).toBeLessThan(p.indexOf('File được sửa'));
    expect(env.tickets.getManaged(`acctv:${T}:dev-1`)!.contextFrom).toEqual([`acctv:${T}:explorer-1`]);
  });

  it('báo cáo quá dài bị cắt', async () => {
    const T = await withExplorer('x'.repeat(CONTEXT_MAX + 10));
    await env.orch.mcpTools(T).spawn_agent({ role: 'dev', task: 'Làm', files: ['src/a.ts'], contextFrom: [`acctv:${T}:explorer-1`] });
    expect(runOf(env, `acctv:${T}:dev-1`)!.spec.prompt).toContain('… (cắt bớt 10 ký tự)');
  });

  it('từ chối: agent không có, chưa xong, của ticket khác, Controller, quá nhiều, sai kiểu', async () => {
    const T = await toRunning(env, plan());
    const tools = env.orch.mcpTools(T);
    const spawn = (contextFrom: unknown) => tools.spawn_agent({ role: 'dev', task: 'Làm', files: ['src/a.ts'], contextFrom });
    expect((await spawn(['qc-9'])).text).toMatch(/không có agent qc-9/);
    await tools.spawn_agent({ role: 'explorer', task: 'Tìm', files: [] });
    expect((await spawn(['explorer-1'])).text).toMatch(/chưa xong; hãy wait_agents trước/);
    expect((await spawn(['controller'])).text).toMatch(/không có agent controller/);
    const T2 = await withExplorer('báo cáo T2');
    expect((await spawn([`acctv:${T2}:explorer-1`])).text).toMatch(/không có agent/);
    expect((await spawn(['a', 'b', 'c', 'd', 'e', 'f'])).text).toMatch(/tối đa 5/);
    expect((await spawn('explorer-1')).text).toMatch(/phải là mảng/);
    // không tạo agent nào khi bị từ chối
    expect(env.tickets.getManaged(`acctv:${T}:dev-1`)).toBeUndefined();
  });

  it('schema MCP khai báo contextFrom', () => {
    const def = TOOL_DEFS.find((d) => d.name === 'spawn_agent')!.inputSchema as { properties: Record<string, unknown> };
    expect(def.properties.contextFrom).toMatchObject({ type: 'array', maxItems: 5 });
  });
});
