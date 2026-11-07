import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { NEXT_DEFAULTS, type ProjectPreview } from '@/src/preview/config';
import { LoginError } from '@/src/preview/browser';
import { PreviewServerError, type PreviewServerDeps, type PreviewStatus, type ServerInfo } from '@/src/preview/server';
import { PreviewManager, type BrowserLike, type ServerLike } from '@/src/preview/manager';
import type { CaptureArgs, CaptureResult } from '@/src/preview/captureArgs';
import type { HubEvent } from '@/src/core/model';

const DIR = path.join(os.tmpdir(), 'proj-x');
const WT = path.join(os.tmpdir(), 'wt-x');
const OUT = path.join(WT, 'out');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const project = (over: Partial<ProjectPreview> = {}): ProjectPreview => ({
  ...structuredClone(NEXT_DEFAULTS),
  accounts: [{ name: 'owner', description: 'Chủ workspace', username: 'o@x', password: 'secret1' }],
  backend: { healthUrl: 'http://localhost:3001/health' },
  login: { path: '/login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: 'button', success: { urlNotMatching: '/login' } },
  ...over,
});

class FakeServer implements ServerLike {
  ensures = 0;
  stops = 0;
  hang: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private st: PreviewStatus = { state: 'stopped', mode: 'dev', port: null, error: null, logTail: '', envFiles: [], startedAt: null };
  constructor(public d: PreviewServerDeps) {}
  hold() {
    this.hang = new Promise((r) => (this.release = r));
  }
  async ensure(): Promise<ServerInfo> {
    this.ensures++;
    if (this.hang) {
      await this.hang;
      if (this.st.state === 'stopped' && this.stops) throw new PreviewServerError('server_failed', 'server preview đã bị tắt', 'log secret1');
    }
    const startedNow = this.st.state !== 'ready';
    this.st = { ...this.st, state: 'ready', port: 3100 };
    this.d.onPids([4242]);
    this.d.onStatus(this.st);
    return { port: 3100, mode: this.d.mode, startedNow, buildMs: null, envFiles: [] };
  }
  async stop() {
    this.stops++;
    this.st = { ...this.st, state: 'stopped', port: null };
    this.d.onPids([]);
    this.d.onStatus(this.st);
    this.release?.();
  }
  status() {
    return this.st;
  }
  alive() {
    return this.st.state === 'ready';
  }
}

class FakeBrowser implements BrowserLike {
  runs: CaptureArgs[] = [];
  closed = 0;
  gate: Promise<void> | null = null;
  result: Partial<Omit<CaptureResult, 'server'>> = {};
  error: Error | null = null;
  async runCapture(args: CaptureArgs) {
    this.runs.push(args);
    if (this.gate) await this.gate;
    if (this.error) throw this.error;
    return { steps: [{ i: 1, kind: 'goto', ok: true, ms: 1 }], finalUrl: 'http://localhost:3100/', status: 200, redirects: [], console: [], requests: [], overflow: null, measures: [], shots: [], ...this.result };
  }
  async close() {
    this.closed++;
  }
}

function setup(over: { project?: ProjectPreview | null; fetchOk?: boolean; idleMs?: number; browser?: string | null; meta?: Record<string, string> } = {}) {
  const servers: FakeServer[] = [];
  const browsers: FakeBrowser[] = [];
  const events: HubEvent[] = [];
  const meta: Record<string, string> = { ...over.meta };
  const health: string[] = [];
  const p = over.project === undefined ? project() : over.project;
  const m = new PreviewManager({
    settings: () => ({ projects: p ? { [DIR]: p } : {} }),
    publish: (e) => events.push(e),
    getMeta: (k) => meta[k],
    setMeta: (k, v) => (meta[k] = v),
    makeServer: (d) => {
      const s = new FakeServer(d);
      servers.push(s);
      return s;
    },
    makeBrowser: () => {
      const b = new FakeBrowser();
      browsers.push(b);
      return b;
    },
    findBrowser: () => (over.browser === undefined ? 'chrome.exe' : over.browser),
    fetchOk: async (u) => {
      health.push(u);
      return over.fetchOk ?? true;
    },
    idleMs: over.idleMs ?? 60_000,
  });
  return { m, servers, browsers, events, meta, health };
}

const req = (args: unknown, ticketId = 'T-1') => ({ ticketId, agentId: `acctv:${ticketId}:qc-1`, worktree: WT, projectDir: DIR, mode: 'dev' as const, outDir: OUT, args });

describe('PreviewManager', () => {
  it('hai capture song song khi server chưa bật: một server, hai ensure, cả hai ok', async () => {
    const { m, servers } = setup();
    const [a, b] = await Promise.all([m.capture(req({ steps: [{ goto: '/' }] })), m.capture(req({ steps: [{ goto: '/a' }] }))]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(servers).toHaveLength(1);
    expect(servers[0].ensures).toBe(2);
    const j = JSON.parse(a.text);
    expect(j.server).toMatchObject({ mode: 'dev', port: 3100 });
    await m.stopAll();
  });

  it('tối đa 2 capture cùng lúc mỗi ticket', async () => {
    const { m, browsers } = setup();
    await m.capture(req({ steps: [{ goto: '/' }] }));
    let open!: () => void;
    browsers[0].gate = new Promise((r) => (open = r));
    const p = [1, 2, 3].map((i) => m.capture(req({ steps: [{ goto: `/${i}` }] })));
    await sleep(30);
    expect(browsers[0].runs).toHaveLength(3); // 1 lần trước + 2 đang chạy
    open();
    await Promise.all(p);
    expect(browsers[0].runs).toHaveLength(4);
    await m.stopAll();
  });

  it('lỗi môi trường có mã rõ ràng', async () => {
    const down = setup({ fetchOk: false });
    const r = await down.m.capture(req({ as: 'owner', steps: [{ goto: '/' }] }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^\[capture:backend_down\]/);
    expect(r.text).toMatch(/request_user_action/);
    expect(down.browsers).toHaveLength(0);
    const guest = await down.m.capture(req({ steps: [{ goto: '/' }] }));
    expect(guest.isError).toBeFalsy();
    expect(down.health).toHaveLength(1);

    const none = setup({ project: null });
    expect((await none.m.capture(req({ steps: [{ goto: '/' }] }))).text).toMatch(/^\[capture:not_configured\]/);

    const bad = setup();
    expect((await bad.m.capture(req({ steps: [{ goto: 'http://x' }] }))).text).toMatch(/^\[capture:invalid_args\]/);

    const login = setup();
    await login.m.capture(req({ steps: [{ goto: '/' }] }));
    login.browsers[0].error = new LoginError('đăng nhập tài khoản owner không thành công', '/tmp/1-login-failed.png');
    const lr = await login.m.capture(req({ as: 'owner', steps: [{ goto: '/' }] }));
    expect(lr.text).toMatch(/^\[capture:login_failed\]/);
    expect(lr.text).toContain('1-login-failed.png');

    const nob = setup({ browser: null });
    expect((await nob.m.capture(req({ steps: [{ goto: '/' }] }))).text).toMatch(/^\[capture:server_failed\].*Chrome/);
    await Promise.all([down.m.stopAll(), login.m.stopAll(), nob.m.stopAll()]);
  });

  it('không lộ mật khẩu trong kết quả, kể cả khi trình duyệt trả về', async () => {
    const { m, browsers } = setup();
    await m.capture(req({ steps: [{ goto: '/' }] }));
    browsers[0].result = { console: ['error: secret1 leaked'] };
    const r = await m.capture(req({ as: 'owner', steps: [{ goto: '/' }] }));
    expect(r.text).not.toContain('secret1');
    expect(m.accountsFor(DIR)).toEqual([{ name: 'owner', description: 'Chủ workspace' }]);
    expect(JSON.stringify(m.accountsFor(DIR))).not.toContain('secret1');
    await m.stopAll();
  });

  it('huỷ ticket khi đang build: server dừng, capture trả lỗi, pid bị xoá, trạng thái stopped', async () => {
    const { m, servers, meta } = setup();
    const first = m.capture(req({ steps: [{ goto: '/' }] }));
    await sleep(10);
    await first;
    servers[0].hold();
    servers[0].d.onPids([4242, 4343]);
    expect(JSON.parse(meta.previewPids)).toEqual({ 'T-1': [4242, 4343] });
    const hanging = m.capture(req({ steps: [{ goto: '/' }] }));
    await sleep(10);
    await m.stop('T-1');
    const r = await hanging;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^\[capture:(server_failed|busy_cancelled)\]/);
    expect(r.text).not.toContain('secret1');
    expect(m.status('T-1')).toBeNull();
    expect(JSON.parse(meta.previewPids)).toEqual({});
    expect(servers[0].stops).toBe(1);
  });

  it('tắt khi rảnh và báo event preview stopped', async () => {
    const { m, servers, events } = setup({ idleMs: 80 });
    await m.capture(req({ steps: [{ goto: '/' }] }));
    expect(m.status('T-1')?.state).toBe('ready');
    await sleep(250);
    expect(servers[0].stops).toBe(1);
    const last = events.filter((e) => e.type === 'preview').at(-1);
    expect(last).toMatchObject({ type: 'preview', ticketId: 'T-1', preview: { state: 'stopped' } });
  });

  it('killOrphans không ném lỗi với pid đã chết và xoá meta', async () => {
    const { m, meta } = setup({ meta: { previewPids: JSON.stringify({ 'T-1': [999999] }) } });
    await m.killOrphans();
    expect(JSON.parse(meta.previewPids)).toEqual({});
  });

  it('defaultMode theo cấu hình dự án', () => {
    expect(setup({ project: project({ defaultMode: 'prod' }) }).m.defaultMode(DIR)).toBe('prod');
    expect(setup({ project: null }).m.defaultMode(DIR)).toBe('dev');
  });
});
