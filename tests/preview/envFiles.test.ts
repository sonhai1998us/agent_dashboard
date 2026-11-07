import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFiles } from '@/src/preview/envFiles';

const dir = (files: Record<string, string>): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-env-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return d;
};

describe('loadEnvFiles', () => {
  it('ưu tiên theo chế độ như Next.js; file đứng trước thắng', () => {
    const d = dir({ '.env': 'A=1\nB=env\n', '.env.local': 'B=local\nC="x # y"\n', '.env.production': 'A=prod\n' });
    expect(loadEnvFiles(d, 'dev')).toEqual({ vars: { A: '1', B: 'local', C: 'x # y' }, files: ['.env.local', '.env'] });
    const p = loadEnvFiles(d, 'prod');
    expect(p.vars.A).toBe('prod');
    expect(p.files).toEqual(['.env.local', '.env.production', '.env']);
  });

  it('cú pháp: export, chú thích, nháy đơn/kép, \\n trong nháy kép, CRLF', () => {
    const d = dir({ '.env': '# đầu\r\nexport E=1\r\nD=v # chú thích\r\nS=\'a #b\'\r\nM="l1\\nl2"\r\n\r\nX=\r\nnot a line\r\n' });
    expect(loadEnvFiles(d, 'dev').vars).toEqual({ E: '1', D: 'v', S: 'a #b', M: 'l1\nl2', X: '' });
  });

  it('không có file nào → rỗng', () => {
    expect(loadEnvFiles(dir({}), 'dev')).toEqual({ vars: {}, files: [] });
    expect(loadEnvFiles(path.join(os.tmpdir(), 'khong-co-thu-muc-nay-123'), 'prod')).toEqual({ vars: {}, files: [] });
  });
});
