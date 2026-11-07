import fs from 'node:fs';
import path from 'node:path';

/** Thứ tự ưu tiên của Next.js: file đứng trước thắng. */
const ORDER: Record<'dev' | 'prod', string[]> = {
  dev: ['.env.development.local', '.env.local', '.env.development', '.env'],
  prod: ['.env.production.local', '.env.local', '.env.production', '.env'],
};

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    const inner = end > 0 ? v.slice(1, end) : v.slice(1);
    return q === '"' ? inner.replace(/\\n/g, '\n') : inner;
  }
  // `#` sau khoảng trắng là chú thích
  return v.replace(/\s+#.*$/, '').trim();
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = LINE.exec(line);
    if (m) out[m[1]] = parseValue(m[2]);
  }
  return out;
}

/** Đọc `.env*` của thư mục dự án gốc theo chế độ; chỉ để đưa vào biến môi trường của server preview. */
export function loadEnvFiles(dir: string, mode: 'dev' | 'prod'): { vars: Record<string, string>; files: string[] } {
  const vars: Record<string, string> = {};
  const files: string[] = [];
  for (const name of ORDER[mode]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    files.push(name);
    for (const [k, v] of Object.entries(parseEnv(text))) if (!(k in vars)) vars[k] = v;
  }
  return { vars, files };
}
