import { expect, test } from 'vitest';
import { THEME_KEY, resolveTheme, themeBootScript } from '../../app/lib/theme';

test('resolveTheme: system theo prefersLight, còn lại giữ nguyên', () => {
  expect(resolveTheme('system', true)).toBe('light');
  expect(resolveTheme('system', false)).toBe('dark');
  expect(resolveTheme('dark', true)).toBe('dark');
  expect(resolveTheme('light', false)).toBe('light');
});

test('themeBootScript đọc localStorage trong try/catch và đặt data-theme', () => {
  const s = themeBootScript();
  expect(THEME_KEY).toBe('acctv.theme');
  expect(s).toContain('acctv.theme');
  expect(s).toContain('try');
  expect(s).toContain('dataset.theme');
});
