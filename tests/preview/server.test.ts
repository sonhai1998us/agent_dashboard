import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killTree } from '@/src/runner/proc';
import { NEXT_DEFAULTS, type ProjectPreview } from '@/src/preview/config';
import { PreviewServer, PreviewServerError, freePort, type PreviewServerDeps, type PreviewStatus } from '@/src/preview/server';

const SCRIPT = path.resolve('tests/helpers/fakeNextServer.mjs');
const NODE = `"${process.execPath}" "${SCRIPT}"`;
const servers: PreviewServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const alivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('hết giờ chờ');
    await new Promise((r) => setTimeout(r, 50));
  }
};

function make(over: { project?: Partial<ProjectPreview>; mode?: 'dev' | 'prod'; signature?: () => Promise<string>; timeouts?: PreviewServerDeps['timeouts'] } = {}) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-wt-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-proj-'));
  fs.writeFileSync(path.join(projectDir, '.env.local'), 'FROM_FILE=yes\n');
  const project: ProjectPreview = {
    ...structuredClone(NEXT_DEFAULTS),
    dev: { command: `${NODE} serve {port}` },
    prod: { build: `${NODE} build`, start: `${NODE} serve {port}` },
    env: { FAKE_TAG: 'tag-1' },
    ...over.project,
  };
  const pids: number[][] = [];
  const statuses: PreviewStatus[] = [];
  const s = new PreviewServer({
    worktree, projectDir, project, mode: over.mode ?? 'dev',
    signature: over.signature ?? (async () => 'sig'),
    onPids: (p) => pids.push(p), onStatus: (st) => statuses.push(st),
    timeouts: over.timeouts,
  });
  servers.push(s);
  return { s, worktree, pids, statuses };
}

const body = async (port: number) => (await fetch(`http://localhost:${port}/`)).json() as Promise<{ tag: string; fromFile: string; port: string }>;

describe('PreviewServer', () => {
  it('freePort trả cổng trống khác 0', async () => {
    const p = await freePort();
    expect(p).toBeGreaterThan(0);
  });

  it('dev: bật, nạp env của dự án + env cấu hình + PORT', async () => {
    const { s } = make();
    const info = await s.ensure();
    expect(info).toMatchObject({ mode: 'dev', startedNow: true, buildMs: null });
    expect(await body(info.port)).toEqual({ tag: 'tag-1', fromFile: 'yes', port: String(info.port) });
    expect(s.status()).toMatchObject({ state: 'ready', port: info.port, mode: 'dev', envFiles: ['.env.local'] });
    expect(s.alive()).toBe(true);
  });

  it('hai ensure song song chỉ bật một tiến trình; lần sau startedNow=false', async () => {
    const { s, pids } = make();
    const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
    expect(a.port).toBe(b.port);
    const all = new Set(pids.flat());
    expect(all.size).toBe(1);
    expect((await s.ensure()).startedNow).toBe(false);
  });

  it('tiến trình bị kill từ ngoài → alive false → ensure bật lại', async () => {
    const { s, pids } = make();
    await s.ensure();
    const pid = pids.at(-1)![0];
    await killTree(pid);
    await until(() => !s.alive());
    const again = await s.ensure();
    expect(again.startedNow).toBe(true);
    expect(pids.at(-1)![0]).not.toBe(pid);
  });

  it('lệnh lỗi → PreviewServerError server_failed kèm log cuối', async () => {
    const { s } = make({ project: { dev: { command: `${NODE} fail {port}` } } });
    const e = await s.ensure().catch((x) => x);
    expect(e).toBeInstanceOf(PreviewServerError);
    expect(e.code).toBe('server_failed');
    expect(e.logTail).toContain('boom');
    expect(s.status().state).toBe('failed');
  });

  it('prod: build một lần khi chữ ký giữ nguyên; chữ ký đổi → build lại, tiến trình cũ bị kill', async () => {
    let sig = 'a';
    const { s, worktree, pids } = make({ mode: 'prod', signature: async () => sig });
    const first = await s.ensure();
    expect(first.mode).toBe('prod');
    expect(first.buildMs).not.toBeNull();
    await s.ensure();
    expect(fs.readFileSync(path.join(worktree, 'built.txt'), 'utf8')).toBe('1');
    const oldPid = pids.at(-1)!.at(-1)!;
    sig = 'b';
    const second = await s.ensure();
    expect(second.startedNow).toBe(true);
    expect(fs.readFileSync(path.join(worktree, 'built.txt'), 'utf8')).toBe('2');
    await until(() => !alivePid(oldPid));
  });

  it('prod: thư mục build bị build khác ghi đè (.next/BUILD_ID đổi) → build lại và bật lại', async () => {
    const { s, worktree } = make({ mode: 'prod' });
    await s.ensure();
    expect(fs.readFileSync(path.join(worktree, 'built.txt'), 'utf8')).toBe('1');
    expect((await s.ensure()).startedNow).toBe(false);
    fs.writeFileSync(path.join(worktree, '.next', 'BUILD_ID'), 'agent-build');
    const again = await s.ensure();
    expect(again.startedNow).toBe(true);
    expect(fs.readFileSync(path.join(worktree, 'built.txt'), 'utf8')).toBe('2');
  });

  it('không sẵn sàng trong readyMs → lỗi "không sẵn sàng sau"', async () => {
    const { s } = make({ project: { env: { FAKE_DELAY_MS: '5000' } }, timeouts: { readyMs: 1000, buildMs: 5000 } });
    const e = await s.ensure().catch((x) => x);
    expect(e).toBeInstanceOf(PreviewServerError);
    expect(String(e.message)).toMatch(/không sẵn sàng sau/);
  });

  it('stop: tiến trình chết, trạng thái stopped; stop khi đang build làm ensure lỗi', async () => {
    const { s, pids } = make();
    await s.ensure();
    const pid = pids.at(-1)![0];
    await s.stop();
    await until(() => !alivePid(pid));
    expect(s.status().state).toBe('stopped');
    expect(s.alive()).toBe(false);

    const slow = make({ mode: 'prod', project: { env: { FAKE_BUILD_MS: '5000' } } });
    const p = slow.s.ensure().catch((x) => x);
    await until(() => slow.s.status().state === 'building');
    await slow.s.stop();
    const err = await p;
    expect(err).toBeInstanceOf(PreviewServerError);
    expect(slow.s.status().state).toBe('stopped');
  });
});
