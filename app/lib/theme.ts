export type ThemePref = 'system' | 'dark' | 'light';
export const THEME_KEY = 'acctv.theme';

export function resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark' | 'light' {
  if (pref === 'system') return prefersLight ? 'light' : 'dark';
  return pref;
}

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'dark' || v === 'light';
}

/** Chạy trước khi vẽ để không nháy sai giao diện. */
export function themeBootScript(): string {
  return `(function(){var p=null,l=false;try{p=localStorage.getItem('${THEME_KEY}')}catch(e){}try{l=window.matchMedia('(prefers-color-scheme: light)').matches}catch(e){}document.documentElement.dataset.theme=p==='light'||p==='dark'?p:(l?'light':'dark')})();`;
}

export function applyTheme(pref: ThemePref): void {
  let light = false;
  try { light = window.matchMedia('(prefers-color-scheme: light)').matches; } catch { /* mặc định tối */ }
  document.documentElement.dataset.theme = resolveTheme(pref, light);
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemePref(v)) return v;
  } catch { /* storage bị chặn */ }
  return 'system';
}

export function saveThemePref(pref: ThemePref): void {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* storage bị chặn */ }
  applyTheme(pref);
}
