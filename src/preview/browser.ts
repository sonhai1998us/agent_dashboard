import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Locator, type Page } from 'playwright-core';
import { LIMITS, redact, type CaptureArgs, type CaptureResult, type Step, type StepReport, type Target } from './captureArgs';
import type { PreviewAccount, PreviewLogin } from './config';

type Result = Omit<CaptureResult, 'server'>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STYLE_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'padding', 'margin', 'gap', 'border', 'border-radius', 'box-shadow', 'opacity', 'display'];

/** Chrome rồi Edge theo đường dẫn chuẩn; ACCTV_BROWSER ghi đè. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.ACCTV_BROWSER;
  if (override) return fs.existsSync(override) ? override : null;
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA ?? '';
  const cands = process.platform === 'win32'
    ? [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(local ? [path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return cands.find((p) => fs.existsSync(p)) ?? null;
}

export class LoginError extends Error {
  constructor(msg: string, public shot: string | null = null) {
    super(msg);
    this.name = 'LoginError';
  }
}

interface Opts { executablePath: string; origin: string; login?: PreviewLogin; accounts: PreviewAccount[]; onPid(pid: number): void }

function locate(page: Page, t: Target): Locator {
  if (t.startsWith('text=')) return page.getByText(t.slice(5));
  if (t.startsWith('testid=')) return page.getByTestId(t.slice(7));
  const role = /^role=([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)')\])?$/.exec(t);
  if (role) {
    const name = role[2] ?? role[3];
    return page.getByRole(role[1] as Parameters<Page['getByRole']>[0], name !== undefined ? { name } : {});
  }
  return page.locator(t);
}

const kindOf = (s: Step): string => Object.keys(s)[0];
const errMsg = (e: unknown): string => (e instanceof Error ? e.message.split('\n')[0] : String(e)).slice(0, 300);

export class TicketBrowser {
  private server: Promise<{ server: BrowserServer; browser: Browser }> | null = null;
  private contexts = new Map<string, Promise<BrowserContext>>();
  private counters = new Map<string, number>();

  constructor(private o: Opts) {}

  private secrets(): string[] {
    return this.o.accounts.map((a) => a.password);
  }

  private launch(): Promise<{ server: BrowserServer; browser: Browser }> {
    if (!this.server) {
      this.server = (async () => {
        const server = await chromium.launchServer({ executablePath: this.o.executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
        const pid = server.process().pid;
        if (pid !== undefined) this.o.onPid(pid);
        const browser = await chromium.connect(server.wsEndpoint());
        return { server, browser };
      })();
      this.server.catch(() => {
        this.server = null;
      });
    }
    return this.server;
  }

  private nextFile(outDir: string, name: string): string {
    fs.mkdirSync(outDir, { recursive: true });
    let n = this.counters.get(outDir);
    if (n === undefined) {
      n = 0;
      for (const f of fs.readdirSync(outDir)) {
        const m = /^(\d+)-/.exec(f);
        if (m) n = Math.max(n, Number(m[1]));
      }
    }
    n++;
    this.counters.set(outDir, n);
    return path.join(outDir, `${n}-${name}.png`);
  }

  private async attemptLogin(ctx: BrowserContext, a: PreviewAccount): Promise<Page | null> {
    const l = this.o.login!;
    const page = await ctx.newPage();
    let rejected = false;
    page.on('response', (r) => {
      if (!SAFE_METHODS.has(r.request().method()) && r.status() >= 400 && r.status() < 500) rejected = true;
    });
    try {
      await page.goto(this.o.origin + l.path, { waitUntil: 'load', timeout: LIMITS.stepMs });
      await page.locator(l.usernameSelector).first().fill(a.username, { timeout: LIMITS.stepMs });
      await page.locator(l.passwordSelector).first().fill(a.password, { timeout: LIMITS.stepMs });
      await page.locator(l.submitSelector).first().click({ timeout: LIMITS.stepMs });
      const deadline = Date.now() + LIMITS.stepMs;
      while (Date.now() < deadline && !rejected) {
        const done = 'urlNotMatching' in l.success
          ? !page.url().includes(l.success.urlNotMatching)
          : (await page.locator(l.success.selector).count()) > 0;
        if (done) {
          await page.close();
          return null;
        }
        await page.waitForTimeout(150);
      }
    } catch {
      // trang đăng nhập lỗi: coi như thất bại
    }
    return page;
  }

  /** Đăng nhập; hỏng thì thử lại đúng một lần, vẫn hỏng thì LoginError (kèm ảnh trang đăng nhập). */
  private async login(ctx: BrowserContext, a: PreviewAccount, outDir: string): Promise<void> {
    if (!this.o.login) throw new LoginError(`dự án chưa cấu hình đăng nhập (login) nên không dùng được tài khoản ${a.name}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await this.attemptLogin(ctx, a);
      if (!failed) return;
      if (attempt === 1) {
        let shot: string | null = null;
        try {
          shot = this.nextFile(outDir, 'login-failed');
          await failed.screenshot({ path: shot });
        } catch {
          shot = null;
        }
        await failed.close().catch(() => {});
        throw new LoginError(`đăng nhập tài khoản ${a.name} không thành công (kiểm tài khoản test, selector form đăng nhập và backend)`, shot);
      }
      await failed.close().catch(() => {});
    }
  }

  private context(a: PreviewAccount | null, outDir: string): Promise<BrowserContext> {
    const key = a?.name ?? '';
    let p = this.contexts.get(key);
    if (!p) {
      p = (async () => {
        const { browser } = await this.launch();
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        ctx.setDefaultTimeout(LIMITS.stepMs);
        if (a) {
          try {
            await this.login(ctx, a, outDir);
          } catch (e) {
            await ctx.close().catch(() => {});
            throw e;
          }
        }
        return ctx;
      })();
      this.contexts.set(key, p);
      p.catch(() => {
        if (this.contexts.get(key) === p) this.contexts.delete(key);
      });
    }
    return p;
  }

  async runCapture(args: CaptureArgs, outDir: string, worktree: string): Promise<Result> {
    const t0 = Date.now();
    const origin = this.o.origin;
    const account = args.as ? this.o.accounts.find((a) => a.name === args.as) ?? null : null;
    if (args.as && !account) throw new Error(`không có tài khoản ${args.as}`);
    const ctx = await this.context(account, outDir);
    if (args.cookies.length) await ctx.addCookies(args.cookies.map((c) => ({ name: c.name, value: c.value, url: origin })));
    const page = await ctx.newPage();
    const res: Result = { steps: [], finalUrl: null, status: null, redirects: [], console: [], requests: [], overflow: null, measures: [], shots: [] };
    let blocked: string | null = null;

    await page.setViewportSize(args.viewport);
    await page.emulateMedia({ colorScheme: args.colorScheme });
    if (args.locale) await page.setExtraHTTPHeaders({ 'accept-language': args.locale });
    await page.route('**/*', (route) => {
      const r = route.request();
      let main = false;
      try {
        main = r.isNavigationRequest() && r.frame() === page.mainFrame();
      } catch {
        main = false;
      }
      if (main && new URL(r.url()).origin !== origin) {
        blocked = r.url();
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });
    const pushConsole = (line: string) => {
      if (res.console.length < LIMITS.consoleLines) res.console.push(line.slice(0, LIMITS.consoleChars));
    };
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') pushConsole(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => pushConsole(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      try {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !r.redirectedFrom()) res.redirects = [];
      } catch {
        // service worker
      }
    });
    page.on('response', (r) => {
      const req = r.request();
      const method = req.method();
      if (!SAFE_METHODS.has(method) || r.status() >= 400) res.requests.push({ method, url: r.url(), status: r.status() });
      try {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          if (r.status() >= 300 && r.status() < 400) res.redirects.push(r.url());
          else res.status = r.status();
        }
      } catch {
        // service worker
      }
    });
    page.on('requestfailed', (r) => {
      if (r.url() !== blocked) res.requests.push({ method: r.method(), url: r.url(), status: null });
    });

    const shoot = async (name: string, opts: { fullPage?: boolean; target?: Target } = {}): Promise<string> => {
      const file = this.nextFile(outDir, name);
      if (opts.target) await locate(page, opts.target).first().screenshot({ path: file, timeout: LIMITS.stepMs });
      else if (opts.fullPage) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.screenshot({ path: file, fullPage: true, ...(h > LIMITS.fullPageMax ? { clip: { x: 0, y: 0, width: args.viewport.width, height: LIMITS.fullPageMax } } : {}) });
      } else await page.screenshot({ path: file });
      res.shots.push(file);
      return file;
    };

    const run = async (s: Step): Promise<void> => {
      const t = LIMITS.stepMs;
      if ('goto' in s) {
        await page.goto(origin + s.goto, { waitUntil: 'load', timeout: t });
      } else if ('click' in s) {
        await locate(page, s.click).first().click({ timeout: t });
        await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
      } else if ('fill' in s) await locate(page, s.fill).first().fill(s.value, { timeout: t });
      else if ('select' in s) await locate(page, s.select).first().selectOption(s.value, { timeout: t });
      else if ('check' in s) await locate(page, s.check).first().setChecked(s.checked ?? true, { timeout: t });
      else if ('press' in s) {
        if (s.target) await locate(page, s.target).first().press(s.press, { timeout: t });
        else await page.keyboard.press(s.press);
      } else if ('upload' in s) await locate(page, s.upload).first().setInputFiles(path.resolve(worktree, s.file), { timeout: t });
      else if ('waitFor' in s) {
        const w = s.waitFor;
        if (typeof w === 'string') await locate(page, w).first().waitFor({ state: 'visible', timeout: t });
        else await page.waitForURL((u) => u.href.includes(w.url), { timeout: t });
      } else if ('shot' in s) await shoot(s.shot, { fullPage: s.fullPage, target: s.target });
      else if ('measure' in s) {
        for (const target of s.measure) {
          const items = await locate(page, target).evaluateAll((els, a) => els.slice(0, a.max).map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              rect: { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 },
              style: Object.fromEntries(a.props.map((p) => [p, cs.getPropertyValue(p)])),
            };
          }), { props: STYLE_PROPS, max: LIMITS.measurePerTarget });
          res.measures.push({ target, items });
        }
      }
    };

    const onLoginPage = (): boolean => {
      if (!account || !this.o.login) return false;
      try {
        return new URL(page.url()).pathname === this.o.login.path;
      } catch {
        return false;
      }
    };

    let relogged = false;
    try {
      for (let i = 0; i < args.steps.length; i++) {
        const s = args.steps[i];
        const rep: StepReport = { i: i + 1, kind: kindOf(s), ok: true, ms: 0 };
        const start = Date.now();
        try {
          if (Date.now() - t0 > LIMITS.totalMs) throw new Error(`hết thời gian ${LIMITS.totalMs / 1000}s cho một lần capture`);
          await run(s);
          // phiên hết hạn: đăng nhập lại một lần rồi lặp lại bước
          if (onLoginPage() && !('goto' in s && s.goto.startsWith(this.o.login!.path)) && !relogged) {
            relogged = true;
            await this.login(ctx, account!, outDir);
            await run(s);
          }
          if (blocked) throw new Error(`điều hướng ra ngoài server preview bị chặn: ${blocked}`);
        } catch (e) {
          if (e instanceof LoginError) throw e;
          rep.ok = false;
          rep.error = blocked && !(e instanceof Error && e.message.includes('bị chặn')) ? `điều hướng ra ngoài server preview bị chặn: ${blocked}` : errMsg(e);
        }
        rep.ms = Date.now() - start;
        res.steps.push(rep);
        if (!rep.ok) {
          await shoot(`error-${i + 1}`).catch(() => {});
          break;
        }
      }
      res.finalUrl = page.url();
      res.overflow = await page.evaluate((max) => {
        const d = document.documentElement;
        const cw = d.clientWidth;
        const items: { selector: string; width: number; right: number }[] = [];
        const sel = (el: Element): string => {
          const id = el.id ? `#${el.id}` : '';
          const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          return `${el.tagName.toLowerCase()}${id}${cls}`;
        };
        for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > cw + 1) {
            items.push({ selector: sel(el), width: Math.round(r.width), right: Math.round(r.right) });
            if (items.length >= max) break;
          }
        }
        return { scrollWidth: d.scrollWidth, clientWidth: cw, items };
      }, LIMITS.overflowItems).catch(() => null);
    } finally {
      await page.close().catch(() => {});
    }
    return redact(res, this.secrets());
  }

  async close(): Promise<void> {
    const ctxs = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(ctxs.map((p) => p.then((c) => c.close(), () => {}).catch(() => {})));
    const s = this.server;
    this.server = null;
    if (s) {
      const got = await s.catch(() => null);
      if (got) {
        await got.browser.close().catch(() => {});
        await got.server.close().catch(() => {});
      }
    }
  }
}
