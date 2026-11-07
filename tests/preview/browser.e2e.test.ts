import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { LoginError, TicketBrowser, findBrowser } from '@/src/preview/browser';
import { validateCaptureArgs } from '@/src/preview/captureArgs';
import type { PreviewLogin } from '@/src/preview/config';

const exe = findBrowser();
const LOGIN: PreviewLogin = { path: '/login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: 'button[type=submit]', success: { urlNotMatching: '/login' } };
const FORM = '<form method="post" action="/login"><input id="u" name="u"><input id="p" name="p" type="password"><button type="submit">Đăng nhập</button></form>';
const HOME = `<!doctype html><html><body style="margin:0">
<h1 style="font-size:24px;color:rgb(1,2,3)">Xin chào</h1>
<button id="del" onclick="fetch('/api/items/1',{method:'POST'}).then(()=>{const p=document.createElement('p');p.id='done';p.textContent='xong';document.body.appendChild(p)})">Xoá</button>
<div style="width:2000px;height:10px;background:#eee"></div>
<script>console.error('lỗi thử')</script>
</body></html>`;

let srv: http.Server;
let origin = '';
let loginPosts = 0;
const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-bwt-'));

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const authed = (req.headers.cookie ?? '').includes('s=1');
    const html = (code: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (url.pathname === '/login' && req.method === 'POST') {
      loginPosts++;
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const f = new URLSearchParams(b);
        if (f.get('u') === 'owner@x' && f.get('p') === 'secret1') {
          res.writeHead(302, { location: '/home', 'set-cookie': 's=1; Path=/' });
          res.end();
        } else html(401, FORM);
      });
      return;
    }
    if (url.pathname === '/login') return html(200, FORM);
    if (url.pathname === '/home') return authed ? html(200, HOME) : (res.writeHead(302, { location: '/login' }), res.end());
    if (url.pathname === '/api/items/1') {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (url.pathname === '/out') return html(200, '<!doctype html><p>đi</p><script>setTimeout(()=>{location.href="https://example.com/"},50)</script>');
    html(404, 'không có');
  });
  await new Promise<void>((r) => srv.listen(0, () => r()));
  origin = `http://localhost:${(srv.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
});

const args = (raw: unknown, accounts = ['owner']) => {
  const v = validateCaptureArgs(raw, accounts, wt);
  if (!v.ok) throw new Error(v.error);
  return v.args;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!exe)('TicketBrowser (Chrome thật)', () => {
  it('đăng nhập, đo, bấm, ghi request ghi, tràn ngang, ảnh; không lộ mật khẩu', { timeout: 60000 }, async () => {
    const pids: number[] = [];
    const b = new TicketBrowser({ executablePath: exe!, origin, login: LOGIN, accounts: [{ name: 'owner', description: '', username: 'owner@x', password: 'secret1' }], onPid: (p) => pids.push(p) });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-shots-'));
    try {
      const r = await b.runCapture(args({ as: 'owner', steps: [{ goto: '/home' }, { measure: ['h1'] }, { click: 'text=Xoá' }, { waitFor: '#done' }, { shot: 'home' }] }), out, wt);
      expect(r.steps.every((s) => s.ok), JSON.stringify(r.steps)).toBe(true);
      expect(r.measures[0].items[0].style['font-size']).toBe('24px');
      expect(r.measures[0].items[0].style.color).toBe('rgb(1, 2, 3)');
      expect(r.requests).toContainEqual({ method: 'POST', url: `${origin}/api/items/1`, status: 403 });
      expect(r.overflow!.scrollWidth).toBeGreaterThan(r.overflow!.clientWidth);
      expect(r.overflow!.items.length).toBeGreaterThan(0);
      expect(r.console.some((l) => l.includes('lỗi thử'))).toBe(true);
      expect(r.shots).toHaveLength(1);
      expect(fs.existsSync(r.shots[0])).toBe(true);
      expect(path.basename(r.shots[0])).toMatch(/^\d+-home\.png$/);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r)).not.toContain('secret1');
      expect(pids.length).toBe(1);
    } finally {
      await b.close();
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(pids[0])).toBe(false);
  });

  it('sai mật khẩu → LoginError sau đúng một lần thử lại (2 lần POST)', { timeout: 60000 }, async () => {
    const b = new TicketBrowser({ executablePath: exe!, origin, login: LOGIN, accounts: [{ name: 'owner', description: '', username: 'owner@x', password: 'sai' }], onPid: () => {} });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-shots-'));
    loginPosts = 0;
    try {
      const e = await b.runCapture(args({ as: 'owner', steps: [{ goto: '/home' }] }), out, wt).catch((x) => x);
      expect(e).toBeInstanceOf(LoginError);
      expect(String(e.message)).not.toContain('sai');
      expect(loginPosts).toBe(2);
    } finally {
      await b.close();
    }
  });

  it('khách bị chuyển về /login; điều hướng ra ngoài bị chặn; bước lỗi có ảnh tự động', { timeout: 60000 }, async () => {
    const b = new TicketBrowser({ executablePath: exe!, origin, login: LOGIN, accounts: [], onPid: () => {} });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-shots-'));
    try {
      const guest = await b.runCapture(args({ steps: [{ goto: '/home' }] }, []), out, wt);
      expect(guest.finalUrl).toBe(`${origin}/login`);
      expect(guest.redirects).toContain(`${origin}/home`);

      const outside = await b.runCapture(args({ steps: [{ goto: '/out' }, { waitFor: { url: 'example.com' } }] }, []), out, wt);
      const bad = outside.steps.find((s) => !s.ok);
      expect(bad?.error).toMatch(/bị chặn/);

      const miss = await b.runCapture(args({ steps: [{ goto: '/login' }, { click: '#khong-co' }] }, []), out, wt);
      expect(miss.steps[1].ok).toBe(false);
      expect(miss.shots.some((s) => /-error-2\.png$/.test(s))).toBe(true);
    } finally {
      await b.close();
    }
  });
});
