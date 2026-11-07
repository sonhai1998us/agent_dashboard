import { describe, expect, test } from 'vitest';
import type { PreviewStatus } from '@/src/preview/server';
import { initialState, reduce } from '@/app/lib/liveStore';
import { previewLabel } from '@/app/lib/tickets';
import { NEXT_DEFAULTS, type ProjectPreview } from '@/src/preview/config';
import { emptyProjectForm, fromProjectForm, parseEnvLines, toProjectForm } from '@/app/lib/projectsForm';

const st = (o: Partial<PreviewStatus>): PreviewStatus => ({ state: 'stopped', mode: 'dev', port: null, error: null, logTail: '', envFiles: [], startedAt: null, ...o });

describe('previewLabel', () => {
  test('từng trạng thái', () => {
    expect(previewLabel(null)).toBe('Server: tắt');
    expect(previewLabel(st({ state: 'stopped' }))).toBe('Server: tắt');
    expect(previewLabel(st({ state: 'starting' }))).toBe('Server: đang bật');
    expect(previewLabel(st({ state: 'building' }))).toBe('Server: đang build');
    expect(previewLabel(st({ state: 'ready', port: 3107, mode: 'prod' }))).toBe('Server: sẵn sàng :3107 (prod)');
    expect(previewLabel(st({ state: 'failed' }))).toBe('Server: lỗi');
  });
});

describe('liveStore preview', () => {
  test('event preview cập nhật previews[T]; snapshot nạp previews', () => {
    let s = initialState();
    expect(s.previews).toEqual({});
    s = reduce(s, { type: 'preview', ticketId: 'T-1', preview: st({ state: 'ready', port: 3100 }) });
    expect(s.previews['T-1'].port).toBe(3100);
    s = reduce(s, { type: 'snapshot', generatedAt: 1, agents: [], alerts: [], metrics: {} as never, agentMetrics: {}, previews: { 'T-2': st({ state: 'building' }) } });
    expect(Object.keys(s.previews)).toEqual(['T-2']);
  });
});

describe('projectsForm', () => {
  const p: ProjectPreview = {
    ...structuredClone(NEXT_DEFAULTS),
    env: { UI_PREVIEW_MODE: '0', B: 'x=y' },
    backend: { healthUrl: 'http://localhost:3001/health' },
    login: { path: '/login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: 'button', success: { urlNotMatching: '/login' } },
    accounts: [{ name: 'owner', description: 'Chủ', username: 'o@x', password: '••••' }],
    db: { resetCommand: 'pnpm db:reset', cwd: 'D:\\api' },
  };

  test('chuyển qua lại giữ nguyên', () => {
    expect(fromProjectForm(toProjectForm('D:\\app', p))).toEqual({ ok: true, dir: 'D:\\app', project: p });
    const bare = { ...structuredClone(NEXT_DEFAULTS) };
    expect(fromProjectForm(toProjectForm('D:\\b', bare))).toEqual({ ok: true, dir: 'D:\\b', project: bare });
    const sel: ProjectPreview = { ...p, login: { ...p.login!, success: { selector: '#avatar' } } };
    expect(fromProjectForm(toProjectForm('D:\\c', sel))).toEqual({ ok: true, dir: 'D:\\c', project: sel });
  });

  test('env theo dòng KEY=VALUE; dòng sai báo số dòng', () => {
    expect(parseEnvLines('A=1\n B = x=y \n\n')).toEqual({ ok: true, env: { A: '1', B: 'x=y' } });
    expect(parseEnvLines('A=1\nkhong co bang')).toEqual({ ok: false, error: 'env: dòng 2 phải dạng KEY=VALUE' });
    const f = { ...emptyProjectForm(), dir: 'D:\\x', env: 'oops' };
    expect(fromProjectForm(f)).toEqual({ ok: false, error: 'env: dòng 1 phải dạng KEY=VALUE' });
  });

  test('form trống là cấu hình Next.js mặc định', () => {
    const f = emptyProjectForm();
    expect(f.dev).toBe(NEXT_DEFAULTS.dev.command);
    expect(fromProjectForm({ ...f, dir: 'D:\\x' })).toEqual({ ok: true, dir: 'D:\\x', project: structuredClone(NEXT_DEFAULTS) });
  });
});
