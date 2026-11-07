import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, formatError, formatResult, redact, validateCaptureArgs, type CaptureResult } from '@/src/preview/captureArgs';

const WT = path.join(os.tmpdir(), 'wt-x');
const v = (raw: unknown, accounts = ['owner']) => validateCaptureArgs(raw, accounts, WT);
const err = (raw: unknown, accounts?: string[]) => {
  const r = v(raw, accounts);
  return r.ok ? '' : r.error;
};

describe('validateCaptureArgs', () => {
  it('mặc định', () => {
    const r = v({ steps: [{ goto: '/' }] });
    expect(r).toEqual({ ok: true, args: { as: null, viewport: { width: 1440, height: 900 }, colorScheme: 'light', locale: null, cookies: [], steps: [{ goto: '/' }] } });
  });

  it('nhận đủ các loại bước và tuỳ chọn', () => {
    const steps = [
      { goto: '/a?x=1' }, { click: 'text=Lưu' }, { fill: '#n', value: 'acctv-T-5-a' }, { select: 'select', value: 'x' },
      { check: '#c', checked: false }, { press: 'Enter', target: '#n' }, { upload: '#f', file: 'public/a.png' },
      { waitFor: 'role=button[name="Lưu"]' }, { waitFor: { url: '/b' } }, { shot: 'home', fullPage: true }, { measure: ['h1', 'testid=card'] },
    ];
    const r = v({ as: 'owner', viewport: { width: 375 }, colorScheme: 'dark', locale: 'en-US', cookies: [{ name: 'a', value: 'b' }], steps });
    expect(r.ok).toBe(true);
    expect(r.ok && r.args.viewport).toEqual({ width: 375, height: 900 });
    expect(r.ok && r.args.steps).toHaveLength(steps.length);
  });

  it('từ chối goto ra ngoài server preview', () => {
    for (const goto of ['http://x.com', '//evil.com', 'http://localhost:4777/api', 'api', '/\\evil', '']) {
      expect(err({ steps: [{ goto }] }), goto).toMatch(/goto/);
    }
  });

  it('từ chối upload ra ngoài worktree', () => {
    expect(err({ steps: [{ upload: '#f', file: '..\\..\\x' }] })).toMatch(/upload/);
    expect(err({ steps: [{ upload: '#f', file: '../x' }] })).toMatch(/upload/);
    expect(err({ steps: [{ upload: '#f', file: path.join(os.tmpdir(), 'other', 'a.png') }] })).toMatch(/upload/);
  });

  it('từ chối giá trị vượt giới hạn hoặc lạ', () => {
    expect(err({ as: 'ghost', steps: [{ goto: '/' }] })).toMatch(/as/);
    expect(err({ steps: Array.from({ length: 31 }, () => ({ goto: '/' })) })).toMatch(/30/);
    expect(err({ steps: [] })).toMatch(/steps/);
    expect(err({ steps: Array.from({ length: 7 }, (_, i) => ({ shot: `s${i}` })) })).toMatch(/6/);
    expect(err({ viewport: { width: 200 }, steps: [{ goto: '/' }] })).toMatch(/viewport/);
    expect(err({ viewport: { width: 2000 }, steps: [{ goto: '/' }] })).toMatch(/viewport/);
    expect(err({ steps: [{ eval: '1' }] })).toMatch(/bước 1/);
    expect(err({ steps: [{ shot: 'ảnh đẹp' }] })).toMatch(/shot/);
    expect(err({ steps: [{ click: '' }] })).toMatch(/click/);
    expect(err({ steps: [{ goto: '/', click: 'a' }] })).toMatch(/bước 1/);
    expect(err({ colorScheme: 'blue', steps: [{ goto: '/' }] })).toMatch(/colorScheme/);
    expect(err('x')).toMatch(/steps/);
  });

  it('LIMITS đúng spec', () => {
    expect(LIMITS).toEqual({ steps: 30, shots: 6, stepMs: 10000, totalMs: 120000, fullPageMax: 8000, measurePerTarget: 20, consoleLines: 30, consoleChars: 300, overflowItems: 10, minWidth: 320, maxWidth: 1920 });
  });
});

describe('redact / format', () => {
  it('redact thay mọi bí mật trong mọi chuỗi lồng nhau', () => {
    expect(redact({ a: 'x pass1 y', b: ['pass1'], n: 3 }, ['pass1'])).toEqual({ a: 'x *** y', b: ['***'], n: 3 });
    const o = { a: 'pass1' };
    expect(redact(o, [])).toEqual(o);
    expect(redact({ a: 'a.b' }, ['.'])).toEqual({ a: 'a***b' });
  });

  it('formatError có tiền tố mã; formatResult là JSON đọc lại được', () => {
    expect(formatError('login_failed', 'Sai mật khẩu')).toMatch(/^\[capture:login_failed\] Sai mật khẩu/);
    const r: CaptureResult = {
      server: { mode: 'dev', port: 3100, startedNow: true, buildMs: null, envFiles: ['.env.local'] },
      steps: [{ i: 1, kind: 'goto', ok: true, ms: 12 }], finalUrl: 'http://localhost:3100/', status: 200, redirects: [],
      console: [], requests: [], overflow: null, measures: [], shots: [],
    };
    expect(JSON.parse(formatResult(r))).toEqual(r);
  });
});
