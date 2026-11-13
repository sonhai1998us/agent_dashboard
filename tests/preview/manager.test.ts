import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEXT_DEFAULTS, type ProjectPreview } from '@/src/preview/config';
import { LoginError } from '@/src/preview/browser';
import { PreviewServerError, type PreviewServerDeps, type PreviewStatus, type ServerInfo } from '@/src/preview/server';
import { E2E_TAIL, PreviewManager, type BrowserLike, type ServerLike } from '@/src/preview/manager';
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
  failWith: PreviewServerError | null = null;
  async ensure(): Promise<ServerInfo> {
    this.ensures++;
    if (this.failWith) throw this.failWith;
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

type Exec = NonNullable<ConstructorParameters<typeof PreviewManager>[0]['exec']>;
function setup(over: { project?: ProjectPreview | null; fetchOk?: boolean; idleMs?: number; browser?: string | null; meta?: Record<string, string>; exec?: Exec; warm?: (u: string) => Promise<void> } = {}) {
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
    exec: over.exec,
    ...(over.warm ? { warm: over.warm } : {}),
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

  it('killOrphans chỉ kill pid còn đúng là tiến trình của server/trình duyệt, cùng lần khởi động máy', async () => {
    const run = async (boot: number) => {
      const meta: Record<string, string> = { previewPids: JSON.stringify({ 'T-1': [111, 222], 'T-2': [333] }), previewBoot: '1000000' };
      const killed: number[] = [];
      const m = new PreviewManager({
        settings: () => ({ projects: {} }), publish: () => {}, getMeta: (k) => meta[k], setMeta: (k, v) => (meta[k] = v),
        bootTime: () => boot,
        procName: async (pid) => ({ 111: 'node.exe', 222: 'Code.exe', 333: 'chrome.exe' } as Record<number, string>)[pid] ?? null,
        kill: async (pid) => { killed.push(pid); },
      });
      await m.killOrphans();
      return { killed, meta };
    };
    const same = await run(1000000 + 30_000);
    expect(same.killed.sort()).toEqual([111, 333]);
    expect(JSON.parse(same.meta.previewPids)).toEqual({});
    const rebooted = await run(1000000 + 3_600_000);
    expect(rebooted.killed).toEqual([]);
    expect(JSON.parse(rebooted.meta.previewPids)).toEqual({});
  });

  it('lưu pid kèm thời điểm khởi động máy', async () => {
    const { m, meta, servers } = setup();
    await m.capture(req({ steps: [{ goto: '/' }] }));
    servers[0].d.onPids([4242]);
    expect(Number(meta.previewBoot)).toBeGreaterThan(0);
    await m.stopAll();
  });

  it('next dev biên dịch lạnh: timeout điều hướng 60s và làm nóng trang đăng nhập khi server vừa bật', async () => {
    const warmed: string[] = [];
    const opts: { navTimeoutMs?: number }[] = [];
    const m = new PreviewManager({
      settings: () => ({ projects: { [DIR]: project() } }), publish: () => {}, getMeta: () => undefined, setMeta: () => {},
      makeServer: (d) => new FakeServer(d),
      makeBrowser: (o) => {
        opts.push(o);
        return new FakeBrowser();
      },
      findBrowser: () => 'chrome.exe', fetchOk: async () => true, warm: async (u) => { warmed.push(u); },
    });
    await m.capture(req({ steps: [{ goto: '/' }] }));
    await m.capture(req({ steps: [{ goto: '/' }] }));
    expect(opts[0].navTimeoutMs).toBe(60000);
    expect(warmed).toEqual(['http://localhost:3100/login']);
    await m.stopAll();
    const p = new PreviewManager({
      settings: () => ({ projects: { [DIR]: project() } }), publish: () => {}, getMeta: () => undefined, setMeta: () => {},
      makeServer: (d) => new FakeServer(d), makeBrowser: (o) => { opts.push(o); return new FakeBrowser(); },
      findBrowser: () => 'chrome.exe', fetchOk: async () => true, warm: async () => {},
    });
    await p.capture({ ...req({ steps: [{ goto: '/' }] }), mode: 'prod' });
    expect(opts.at(-1)!.navTimeoutMs).toBe(10000);
    await p.stopAll();
  });

  it('đổi Settings khi server đang chạy: đổi tài khoản/đăng nhập → tạo lại trình duyệt; đổi lệnh/env → bật lại server', async () => {
    let p = project();
    const servers: FakeServer[] = [];
    const browsers: { accounts: unknown }[] = [];
    const m = new PreviewManager({
      settings: () => ({ projects: { [DIR]: p } }), publish: () => {}, getMeta: () => undefined, setMeta: () => {},
      makeServer: (d) => { const s = new FakeServer(d); servers.push(s); return s; },
      makeBrowser: (o) => { browsers.push({ accounts: o.accounts }); return new FakeBrowser(); },
      findBrowser: () => 'chrome.exe', fetchOk: async () => true, warm: async () => {},
    });
    await m.capture(req({ steps: [{ goto: '/' }] }));
    p = { ...p, accounts: [...p.accounts, { name: 'member', description: 'TV', username: 'm@x', password: 'pw2' }] };
    const r = await m.capture(req({ as: 'member', steps: [{ goto: '/' }] }));
    expect(r.isError).toBeFalsy();
    expect(browsers).toHaveLength(2);
    expect(JSON.stringify(browsers[1].accounts)).toContain('member');
    expect(servers).toHaveLength(1);
    p = { ...p, env: { X: '1' } };
    await m.capture(req({ steps: [{ goto: '/' }] }));
    expect(servers).toHaveLength(2);
    expect(servers[0].stops).toBe(1);
    await m.stopAll();
  });

  it('defaultMode theo cấu hình dự án', () => {
    expect(setup({ project: project({ defaultMode: 'prod' }) }).m.defaultMode(DIR)).toBe('prod');
    expect(setup({ project: null }).m.defaultMode(DIR)).toBe('dev');
  });
});

describe('PreviewManager.runE2e', () => {
  const SPEC = 'e2e/T-1.spec.ts';
  fs.mkdirSync(path.join(WT, 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(WT, SPEC), "test('TC-1', () => {});\n");
  // @playwright/test giả trong node_modules của worktree: dashboard gọi thẳng cli.js bằng node, không qua npx
  // giống gói `playwright` 1.61 thật: exports không có ./cli, CLI chỉ khai trong bin
  const PW = path.join(WT, 'node_modules', 'playwright');
  fs.mkdirSync(PW, { recursive: true });
  fs.writeFileSync(path.join(PW, 'package.json'), JSON.stringify({ name: 'playwright', exports: { '.': './index.js', './package.json': './package.json' }, bin: { playwright: 'cli.js' } }));
  fs.writeFileSync(path.join(PW, 'cli.js'), '');
  const CLI = fs.realpathSync(path.join(PW, 'cli.js'));
  const e2eReq = (file: unknown, grep?: unknown) => ({ ticketId: 'T-1', agentId: 'acctv:T-1:qc-1', worktree: WT, projectDir: DIR, mode: 'dev' as const, file, grep });
  const recorder = (result: { code: number | null; tail: string } = { code: 0, tail: '1 passed' }) => {
    const calls: { cmd: string; args: string[]; o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal } }[] = [];
    const exec: Exec = async (cmd, args, o) => { calls.push({ cmd, args, o }); return result; };
    return { calls, exec };
  };

  it('chạy npx playwright test <file> trong worktree, BASE_URL = server preview, tài khoản qua env', async () => {
    const r = recorder();
    const { m } = setup({ exec: r.exec });
    const out = await m.runE2e(e2eReq(SPEC));
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/đạt/);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].cmd).toBe(process.execPath);
    expect(r.calls[0].args).toEqual([CLI, 'test', SPEC, '--reporter=line']);
    expect(r.calls[0].o.cwd).toBe(WT);
    expect(r.calls[0].o.env.BASE_URL).toBe('http://localhost:3100');
    expect(r.calls[0].o.env.E2E_OWNER_USER).toBe('o@x');
    expect(r.calls[0].o.env.E2E_OWNER_PASS).toBe('secret1');
    await m.stopAll();
  });

  it('file ngoài e2e/, có .., tuyệt đối, không tồn tại → [e2e:invalid_args], không gọi exec', async () => {
    const r = recorder();
    const { m } = setup({ exec: r.exec });
    for (const f of ['src/a.spec.ts', 'e2e/../src/a.spec.ts', path.join(WT, SPEC), 'e2e/khong-co.spec.ts', 42]) {
      expect((await m.runE2e(e2eReq(f))).text).toMatch(/^\[e2e:invalid_args\]/);
    }
    expect(r.calls).toHaveLength(0);
  });

  it('grep đi nguyên văn thành argv, không qua shell', async () => {
    const r = recorder();
    const { m } = setup({ exec: r.exec });
    await m.runE2e(e2eReq(SPEC, '"; rm -rf ~'));
    expect(r.calls[0].args.slice(-2)).toEqual(['--grep', '"; rm -rf ~']);
    expect((await m.runE2e(e2eReq(SPEC, 'a\nb'))).text).toMatch(/^\[e2e:invalid_args\]/);
    await m.stopAll();
  });

  it('exit khác 0 → isError, có log; mật khẩu bị che', async () => {
    const r = recorder({ code: 1, tail: '1 failed: login with secret1' });
    const { m } = setup({ exec: r.exec });
    const out = await m.runE2e(e2eReq(SPEC));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/lỗi \(exit 1\)/);
    expect(out.text).toContain('1 failed');
    expect(out.text).not.toContain('secret1');
    await m.stopAll();
  });

  it('worktree chưa cài @playwright/test → [e2e:not_configured], không gọi exec (không để npx tự tải)', async () => {
    const wt2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-nopw-'));
    fs.mkdirSync(path.join(wt2, 'e2e'));
    fs.writeFileSync(path.join(wt2, SPEC), '');
    const r = recorder();
    const { m } = setup({ exec: r.exec });
    expect((await m.runE2e({ ...e2eReq(SPEC), worktree: wt2 })).text).toMatch(/^\[e2e:not_configured\].*@playwright\/test/);
    expect(r.calls).toHaveLength(0);
  });

  it('e2e không chiếm lượt capture; một ticket chỉ một run_e2e cùng lúc; tắt preview thì huỷ run đang chạy', async () => {
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    const signals: AbortSignal[] = [];
    const exec: Exec = async (_c, _a, o) => { signals.push(o.signal); await gate; return { code: 0, tail: '' }; };
    const { m } = setup({ exec });
    const running = m.runE2e(e2eReq(SPEC));
    await sleep(20);
    expect((await m.runE2e(e2eReq(SPEC))).text).toMatch(/^\[e2e:busy_cancelled\]/);
    const caps = await Promise.all([m.capture(req({ steps: [{ goto: '/' }] })), m.capture(req({ steps: [{ goto: '/a' }] }))]);
    expect(caps.every((c) => !c.isError)).toBe(true);
    expect(signals[0].aborted).toBe(false);
    await m.stop('T-1');
    expect(signals[0].aborted).toBe(true);
    open();
    await running;
  });

  it('quá hạn hoặc không chạy được → [e2e:run_failed], không đổ cho server', async () => {
    const { m } = setup({ exec: recorder({ code: null, tail: 'killed' }).exec });
    expect((await m.runE2e(e2eReq(SPEC))).text).toMatch(/^\[e2e:run_failed\]/);
    await m.stopAll();
  });

  it('hai tài khoản trùng tên biến (a-b, a_b): không đặt biến nào và cảnh báo', async () => {
    const r = recorder();
    const accounts = [{ name: 'a-b', description: '', username: 'u1', password: 'p1' }, { name: 'a_b', description: '', username: 'u2', password: 'p2' }, { name: 'owner', description: '', username: 'o@x', password: 'secret1' }];
    const { m } = setup({ project: project({ accounts }), exec: r.exec });
    const out = await m.runE2e(e2eReq(SPEC));
    expect(r.calls[0].o.env.E2E_A_B_USER).toBeUndefined();
    expect(r.calls[0].o.env.E2E_OWNER_USER).toBe('o@x');
    expect(out.text).toMatch(/E2E_A_B/);
    await m.stopAll();
  });

  it('dev: server vừa bật thì làm nóng trang / trước khi chạy; lần sau không', async () => {
    const warmed: string[] = [];
    const { m } = setup({ exec: recorder().exec, warm: async (u) => { warmed.push(u); } });
    await m.runE2e(e2eReq(SPEC));
    await m.runE2e(e2eReq(SPEC));
    expect(warmed).toEqual(['http://localhost:3100/']);
    await m.stopAll();
  });

  it('log bị cắt: bỏ dòng đầu dở dang để không lộ một phần mật khẩu', async () => {
    const short = setup({ exec: recorder({ code: 1, tail: 'cret1 leaked\n' + 'x'.repeat(E2E_TAIL - 20) }).exec });
    expect((await short.m.runE2e(e2eReq(SPEC))).text).toContain('cret1'); // không bị cắt: giữ nguyên
    const cut = setup({ exec: recorder({ code: 1, tail: ('cret1 leaked\n' + 'x'.repeat(E2E_TAIL)).slice(0, E2E_TAIL) }).exec });
    expect((await cut.m.runE2e(e2eReq(SPEC))).text).not.toContain('cret1');
    await Promise.all([short.m.stopAll(), cut.m.stopAll()]);
  });

  it('chưa cấu hình dự án → [e2e:not_configured]; server lỗi → [e2e:server_failed] kèm log đã che', async () => {
    const none = setup({ project: null, exec: recorder().exec });
    expect((await none.m.runE2e(e2eReq(SPEC))).text).toMatch(/^\[e2e:not_configured\]/);
    const again = setup({ exec: recorder().exec });
    await again.m.runE2e(e2eReq(SPEC)); // tạo server
    again.servers[0].failWith = new PreviewServerError('server_failed', 'next dev chết', 'log secret1');
    const failed = await again.m.runE2e(e2eReq(SPEC));
    expect(failed.text).toMatch(/^\[e2e:server_failed\].*next dev chết/s);
    expect(failed.text).not.toContain('secret1');
    await again.m.stopAll();
  });
});
