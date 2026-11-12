import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startProcess, killTree } from '@/src/runner/proc';
import { runShell } from '@/src/preview/dbReset';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn: () => boolean, ms: number) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return fn();
};

describe('startProcess', () => {
  it('splits lines across chunks', async () => {
    const code = `process.stdout.write('{"a":1}\\n{"b"'); setTimeout(()=>process.stdout.write(':2}\\n'), 200)`;
    const p = startProcess(process.execPath, ['-e', code], { cwd: process.cwd() });
    const lines: string[] = [];
    p.onLine((l) => lines.push(l));
    await p.exit;
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  }, 20000);

  it('reports an overflow marker for a 9MB line and keeps going', async () => {
    const code = `process.stdout.write('x'.repeat(9*1024*1024)+'\\n{"next":1}\\n')`;
    const p = startProcess(process.execPath, ['-e', code], { cwd: process.cwd() });
    const lines: string[] = [];
    p.onLine((l) => lines.push(l));
    await p.exit;
    expect(lines).toEqual(['\u0000overflow', '{"next":1}']);
  }, 30000);

  it('không truyền NODE_ENV của dashboard xuống tiến trình con (agent, lệnh cài)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const p = startProcess(process.execPath, ['-e', `console.log(JSON.stringify(process.env.NODE_ENV ?? null))`], { cwd: process.cwd() });
      const lines: string[] = [];
      p.onLine((l) => lines.push(l));
      await p.exit;
      expect(lines).toEqual(['null']);
      const r = await runShell(`"${process.execPath}" -e "console.log(process.env.NODE_ENV ?? 'unset')"`, process.cwd(), 20000);
      expect(r.tail.trim()).toBe('unset');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20000);

  it('keeps only the last 4KB of stderr', async () => {
    const p = startProcess(process.execPath, ['-e', `process.stderr.write('a'.repeat(10000)+'END')`], { cwd: process.cwd() });
    await p.exit;
    expect(p.stderr().length).toBe(4096);
    expect(p.stderr().endsWith('END')).toBe(true);
  }, 20000);
});

describe('killTree', () => {
  it('kills parent and grandchild', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kt-'));
    const pidFile = path.join(dir, 'child.pid');
    const code = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000)`;
    const p = startProcess(process.execPath, ['-e', code], { cwd: dir });
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 15000)).toBe(true);
    const child = Number(readFileSync(pidFile, 'utf8'));
    const parent = p.pid!;
    expect(alive(parent)).toBe(true);
    expect(alive(child)).toBe(true);
    await killTree(parent);
    await p.exit;
    expect(await until(() => !alive(parent) && !alive(child), 5000)).toBe(true);
  }, 30000);
});
