import { describe, expect, it, vi } from 'vitest';
import { TOOL_DEFS, handleMcp } from '@/src/orchestrator/mcp';

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('handleMcp', () => {
  it('initialize echoes protocolVersion', async () => {
    const r = await handleMcp(rpc('initialize', { protocolVersion: '2024-11-05' }), {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'acctv', version: '0.2.0' } },
    });
  });

  it('initialize defaults protocolVersion', async () => {
    const r = await handleMcp(rpc('initialize'), {});
    expect((r.json as any).result.protocolVersion).toBe('2025-06-18');
  });

  it('notification gets 202 without body', async () => {
    const r = await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, {});
    expect(r).toEqual({ status: 202 });
    expect(await handleMcp([{ jsonrpc: '2.0', method: 'notifications/initialized' }], {})).toEqual({ status: 202 });
  });

  it('ping returns {}', async () => {
    expect((await handleMcp(rpc('ping'), {})).json).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('tools/list only lists the tools the caller has (worker: request_user_action)', async () => {
    const r = await handleMcp(rpc('tools/list'), { request_user_action: async () => ({ text: '' }) });
    expect((r.json as any).result.tools.map((t: any) => t.name)).toEqual(['request_user_action']);
  });

  it('tools/list lists capture for workers that have it, with the step schema', async () => {
    const noop = async () => ({ text: '' });
    const r = await handleMcp(rpc('tools/list'), { request_user_action: noop, capture: noop });
    const tools = (r.json as any).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(['request_user_action', 'capture']);
    const cap = tools.find((t: any) => t.name === 'capture');
    expect(cap.description).toMatch(/server preview/);
    expect(cap.description).toMatch(/không tự bật server hay trình duyệt/i);
    expect(cap.inputSchema.required).toEqual(['steps']);
    expect(cap.inputSchema.properties.steps.maxItems).toBe(30);
    expect(Object.keys(cap.inputSchema.properties).sort()).toEqual(['as', 'colorScheme', 'cookies', 'locale', 'steps', 'viewport']);
  });

  it('tools/list has the 5 Controller tools with Vietnamese wait hint', async () => {
    const noop = async () => ({ text: '' });
    const ctrl = Object.fromEntries(['propose_plan', 'spawn_agent', 'wait_agents', 'get_agent_log', 'finish'].map((n) => [n, noop]));
    const r = await handleMcp(rpc('tools/list'), ctrl);
    const tools = (r.json as any).result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(['finish', 'get_agent_log', 'propose_plan', 'spawn_agent', 'wait_agents']);
    for (const n of ['propose_plan', 'wait_agents']) {
      expect(TOOL_DEFS.find(t => t.name === n)!.description).toContain('đang chờ');
    }
    for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it('tools/call invokes impl with args', async () => {
    const impl = vi.fn(async () => ({ text: 'ok' }));
    const r = await handleMcp(rpc('tools/call', { name: 'finish', arguments: { report: 'r', status: 'done' } }), { finish: impl });
    expect(impl).toHaveBeenCalledWith({ report: 'r', status: 'done' });
    expect((r.json as any).result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
  });

  it('tools/call maps thrown error and unknown tool', async () => {
    const bad = async () => { throw new Error('x'); };
    const r = await handleMcp(rpc('tools/call', { name: 'finish', arguments: {} }), { finish: bad });
    expect((r.json as any).result).toEqual({ content: [{ type: 'text', text: 'x' }], isError: true });
    const u = await handleMcp(rpc('tools/call', { name: 'nope' }), {});
    expect((u.json as any).result).toEqual({ content: [{ type: 'text', text: 'Tool không tồn tại: nope' }], isError: true });
  });

  it('unknown method and non-object body', async () => {
    expect((await handleMcp(rpc('foo'), {})).json).toMatchObject({ id: 1, error: { code: -32601 } });
    expect((await handleMcp('x', {})).json).toMatchObject({ error: { code: -32600 } });
  });

  it('batch returns array of responses', async () => {
    const r = await handleMcp([rpc('ping', undefined, 1), rpc('ping', undefined, 2), { jsonrpc: '2.0', method: 'notifications/initialized' }], {});
    expect(r.status).toBe(200);
    expect((r.json as any[]).map(x => x.id)).toEqual([1, 2]);
  });
});
