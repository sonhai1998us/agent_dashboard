import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const script = path.resolve(__dirname, '../../bin/acctv-guard.mjs');
let server: http.Server;
let port = 0;
let reply: { status?: number; body: string } = { body: '' };
let seen: { url?: string; auth?: string; ctype?: string; body?: string } = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'], body: Buffer.concat(parts).toString('utf8') };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// async spawn: the stub server lives in this process, spawnSync would block its event loop
const run = (p: number, input: string, env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const c = spawn(process.execPath, [script, String(p), 'acctv:T-1:dev-1', 'tok'], { env: { ...process.env, ...env } });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('close', (status) => resolve({ status, stdout }));
    c.stdin.end(input);
  });
const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x.ts' }, cwd: 'D:\\Dự án\\my app' });

describe('acctv-guard hook', () => {
  beforeEach(() => {
    seen = {};
  });
  it('prints deny with server reason and forwards the request intact', async () => {
    reply = { body: JSON.stringify({ allow: false, reason: '[acctv-guard] x' }) };
    const r = await run(port, input);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '[acctv-guard] x',
    });
    expect(seen.auth).toBe('Bearer tok');
    expect(seen.ctype).toBe('application/json');
    expect(seen.url).toBe('/api/guard?agent=acctv%3AT-1%3Adev-1');
    expect(seen.body).toBe(input);
  });
  it('allow: empty stdout, exit 0', async () => {
    reply = { body: '{"allow":true}' };
    const r = await run(port, input);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(seen.auth).toBe('Bearer tok');
  });
  it('fails closed on non-200, garbage, or missing allow', async () => {
    for (const rp of [{ status: 401, body: '{"allow":true}' }, { body: 'nope' }, { body: '{}' }]) {
      reply = rp;
      const r = await run(port, input);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
  it('denies when nobody listens', async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const dead = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    const r = await run(dead, input);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('không phản hồi');
  });
  it('denies when the server accepts but never responds', async () => {
    const hang = http.createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    const r = await run((hang.address() as AddressInfo).port, input, { ACCTV_GUARD_TIMEOUT_MS: '800' });
    hang.closeAllConnections();
    await new Promise<void>((res) => hang.close(() => res()));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('không phản hồi');
  });
});
