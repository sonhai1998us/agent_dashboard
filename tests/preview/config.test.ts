import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MASK, NEXT_DEFAULTS, maskProjects, resolveProject, unmaskProjects, validateProjects, type ProjectPreview } from '@/src/preview/config';

const WIN = process.platform === 'win32';
const DIR = WIN ? 'D:\\app' : '/work/app';
const acct = (name: string, password = 'p') => ({ name, description: `vai ${name}`, username: `${name}@x`, password });
const proj = (over: Partial<ProjectPreview> = {}): ProjectPreview => ({ ...structuredClone(NEXT_DEFAULTS), accounts: [acct('owner')], ...over });
const errorsOf = (raw: unknown): string[] => {
  const r = validateProjects(raw);
  return r.ok ? [] : r.errors;
};

describe('NEXT_DEFAULTS', () => {
  it('lệnh Next.js mặc định có {port}', () => {
    expect(NEXT_DEFAULTS.dev.command).toBe('pnpm exec next dev -p {port}');
    expect(NEXT_DEFAULTS.prod).toEqual({ build: 'pnpm exec next build', start: 'pnpm exec next start -p {port}' });
    expect(NEXT_DEFAULTS.defaultMode).toBe('dev');
    expect(NEXT_DEFAULTS.readyPath).toBe('/');
    expect(NEXT_DEFAULTS.accounts).toEqual([]);
    expect(NEXT_DEFAULTS.env).toEqual({});
  });
});

describe('validateProjects', () => {
  it('nhận cấu hình hợp lệ và giữ nguyên dữ liệu', () => {
    const p = proj({
      backend: { healthUrl: 'http://localhost:3001/api/v1/health' },
      login: { path: '/login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: 'button', success: { urlNotMatching: '/login' } },
      db: { resetCommand: 'pnpm db:reset', cwd: DIR },
    });
    const r = validateProjects({ [DIR]: p });
    expect(r.ok).toBe(true);
    expect(r.ok && r.projects[DIR]).toEqual(p);
  });

  it('undefined là {}', () => {
    expect(validateProjects(undefined)).toEqual({ ok: true, projects: {} });
  });

  it('từ chối giá trị sai, lỗi nêu tên trường', () => {
    expect(errorsOf({ 'tuong/doi': proj() }).join('\n')).toMatch(/đường dẫn tuyệt đối/);
    expect(errorsOf({ [DIR]: proj({ dev: { command: 'next dev' } }) }).join('\n')).toMatch(/dev\.command/);
    expect(errorsOf({ [DIR]: proj({ prod: { build: 'next build', start: 'next start' } }) }).join('\n')).toMatch(/prod\.start/);
    expect(errorsOf({ [DIR]: proj({ accounts: [acct('owner'), acct('owner')] }) }).join('\n')).toMatch(/accounts.*trùng/);
    expect(errorsOf({ [DIR]: proj({ accounts: [acct('Chủ nhà')] }) }).join('\n')).toMatch(/accounts.*name/);
    expect(errorsOf({ [DIR]: proj({ defaultMode: 'x' as 'dev' }) }).join('\n')).toMatch(/defaultMode/);
    expect(errorsOf({ [DIR]: proj({ backend: { healthUrl: 'localhost:3001' } }) }).join('\n')).toMatch(/backend\.healthUrl/);
    expect(errorsOf({ [DIR]: proj({ db: { resetCommand: 'x', cwd: 'rel' } }) }).join('\n')).toMatch(/db\.cwd/);
    expect(errorsOf({ [DIR]: proj({ env: { A: 1 as unknown as string } }) }).join('\n')).toMatch(/env/);
    expect(errorsOf({ [DIR]: proj({ login: { path: 'login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: 'b', success: { selector: '#ok' } } }) }).join('\n')).toMatch(/login\.path/);
    expect(errorsOf([1]).length).toBeGreaterThan(0);
  });
});

describe('maskProjects / unmaskProjects', () => {
  it('che mọi mật khẩu, không sửa object gốc', () => {
    const src = { [DIR]: proj({ accounts: [acct('owner', 's1'), acct('member', 's2')] }) };
    const m = maskProjects(src);
    expect(m[DIR].accounts.map((a) => a.password)).toEqual([MASK, MASK]);
    expect(src[DIR].accounts[0].password).toBe('s1');
    expect(MASK).toBe('••••');
  });

  it('MASK lấy lại mật khẩu cũ theo name; tài khoản mới mà MASK thì lỗi', () => {
    const prev = { [DIR]: proj({ accounts: [acct('owner', 's1')] }) };
    const ok = unmaskProjects({ [DIR]: proj({ accounts: [acct('owner', MASK), acct('member', 'm1')] }) }, prev);
    expect(ok.ok && ok.projects[DIR].accounts.map((a) => a.password)).toEqual(['s1', 'm1']);
    const bad = unmaskProjects({ [DIR]: proj({ accounts: [acct('viewer', MASK)] }) }, prev);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join('\n')).toMatch(/accounts\.viewer\.password/);
  });
});

describe('resolveProject', () => {
  it.runIf(WIN)('khoá chuẩn hoá, không phân biệt hoa thường trên Windows', () => {
    const cfg = proj();
    expect(resolveProject({ 'D:\\App': cfg }, 'd:\\app\\')).toBe(cfg);
  });

  it('không cấu hình: có next trong package.json → NEXT_DEFAULTS, không có → null', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-proj-'));
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
    expect(resolveProject({}, d)).toEqual(NEXT_DEFAULTS);
    const e = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-proj-'));
    fs.writeFileSync(path.join(e, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
    expect(resolveProject({}, e)).toBeNull();
    expect(resolveProject({}, path.join(e, 'khong-co'))).toBeNull();
  });
});
