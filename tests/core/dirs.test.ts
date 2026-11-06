import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIR_LIST_MAX, DirError, listDirs } from '@/src/core/dirs';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-dirs-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('chỉ liệt kê thư mục con, bỏ thư mục ẩn/hệ thống, sắp theo tên, đánh dấu git', () => {
  for (const d of ['b-app', 'A-lib', 'item10', 'item2', '.hidden', 'node_modules', '$Recycle.Bin']) fs.mkdirSync(path.join(tmp, d));
  fs.mkdirSync(path.join(tmp, 'b-app', '.git'));
  fs.writeFileSync(path.join(tmp, 'file.txt'), 'x');
  const l = listDirs(tmp);
  expect(l.path).toBe(path.resolve(tmp));
  expect(l.parent).toBe(path.dirname(path.resolve(tmp)));
  expect(l.isGit).toBe(false);
  expect(l.entries.map((e) => e.name)).toEqual(['A-lib', 'b-app', 'item2', 'item10']);
  expect(l.entries.find((e) => e.name === 'b-app')).toEqual({ name: 'b-app', path: path.join(tmp, 'b-app'), isGit: true });
  expect(l.truncated).toBe(false);
  expect(listDirs(path.join(tmp, 'b-app')).isGit).toBe(true);
});

test('git worktree (.git là file) cũng được đánh dấu git', () => {
  fs.mkdirSync(path.join(tmp, 'wt'));
  fs.writeFileSync(path.join(tmp, 'wt', '.git'), 'gitdir: x');
  expect(listDirs(tmp).entries[0].isGit).toBe(true);
});

test('không tồn tại hoặc là file → DirError 404', () => {
  fs.writeFileSync(path.join(tmp, 'f'), 'x');
  for (const p of [path.join(tmp, 'none'), path.join(tmp, 'f')]) {
    let err: unknown;
    try { listDirs(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DirError);
    expect((err as DirError).status).toBe(404);
  }
});

test('gốc: ổ đĩa (Windows) hoặc /, kèm thư mục người dùng', () => {
  const l = listDirs(null);
  expect(l.path).toBeNull();
  expect(l.parent).toBeNull();
  expect(l.entries.some((e) => e.path === os.homedir())).toBe(true);
  if (process.platform === 'win32') expect(l.entries.some((e) => /^[A-Z]:\\$/.test(e.path))).toBe(true);
  else expect(l.entries[0].path).toBe('/');
});

test('ở gốc ổ đĩa không có parent', () => {
  expect(listDirs(path.parse(tmp).root).parent).toBeNull();
});

test(`cắt ở ${DIR_LIST_MAX} mục`, () => {
  for (let i = 0; i <= DIR_LIST_MAX; i++) fs.mkdirSync(path.join(tmp, `d${i}`));
  const l = listDirs(tmp);
  expect(l.entries).toHaveLength(DIR_LIST_MAX);
  expect(l.truncated).toBe(true);
});
