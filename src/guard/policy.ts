const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** `**` khớp mọi thứ (kể cả `/`), `*` khớp mọi thứ trừ `/`, `?` một ký tự trừ `/`. So không phân biệt hoa thường, `\` = `/`. */
export function matchGlob(pattern: string, path: string): boolean {
  const p = norm(pattern);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(norm(path));
}
