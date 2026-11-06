export interface Crumb { label: string; path: string }

const isWinPath = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p);

/** `D:\Work\du-an` → D:\ › Work › du-an; `/home/a` → / › home › a. */
export function pathCrumbs(p: string | null): Crumb[] {
  if (!p) return [];
  if (isWinPath(p)) {
    const [drive, ...rest] = p.split(/[\\/]+/).filter(Boolean);
    const root = `${drive.toUpperCase()}\\`;
    const out: Crumb[] = [{ label: root, path: root }];
    let cur = root;
    for (const seg of rest) { cur = cur.endsWith('\\') ? cur + seg : `${cur}\\${seg}`; out.push({ label: seg, path: cur }); }
    return out;
  }
  const out: Crumb[] = [{ label: '/', path: '/' }];
  let cur = '';
  for (const seg of p.split('/').filter(Boolean)) { cur += `/${seg}`; out.push({ label: seg, path: cur }); }
  return out;
}

const parentOf = (p: string): string | null => {
  const c = pathCrumbs(p);
  return c.length > 1 ? c[c.length - 2].path : null;
};

/** Hộp chọn mở ở: ô nhập (nếu là đường dẫn tuyệt đối), thư mục cha của dự án gần nhất, hoặc danh sách gốc. */
export function pickerStart(value: string, recent: string[]): string | null {
  const v = value.trim();
  if (isWinPath(v) || v.startsWith('/')) return v;
  return recent.length ? parentOf(recent[0]) ?? recent[0] : null;
}
