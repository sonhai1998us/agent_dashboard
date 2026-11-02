import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

vi.mock('node:fs', async (orig) => {
  const actual: any = await orig();
  const readFileSync = vi.fn(actual.readFileSync);
  return { ...actual, readFileSync, default: { ...actual.default, readFileSync } };
});

import { readNewLines } from '@/src/adapters/tail';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acctv-tail-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('dòng cụt chưa có \n không được trả; lần đọc sau trả đủ', async () => {
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  const r1 = await readNewLines(f, { offset: 0, lines: 0 });
  expect(r1.lines).toEqual(['{"a":1}']);
  expect(r1.offset).toBe(8);
  expect(r1.lineCount).toBe(1);
  fs.appendFileSync(f, '2}\n');
  const r2 = await readNewLines(f, { offset: r1.offset, lines: r1.lineCount });
  expect(r2.lines).toEqual(['{"b":2}']);
  expect(r2.lineCount).toBe(2);
  expect(r2.offset).toBe(fs.statSync(f).size);
});

test('offset tính theo byte với ký tự đa byte', async () => {
  const f = path.join(dir, 'u.jsonl');
  fs.writeFileSync(f, '{"t":"tiếng Việt"}\n{"x":');
  const r = await readNewLines(f, { offset: 0, lines: 0 });
  expect(r.lines).toEqual(['{"t":"tiếng Việt"}']);
  expect(r.offset).toBe(Buffer.byteLength('{"t":"tiếng Việt"}\n'));
});

test('file bị cắt ngắn → đọc lại từ 0', async () => {
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  const r1 = await readNewLines(f, { offset: 0, lines: 0 });
  fs.writeFileSync(f, 'x\n');
  const r2 = await readNewLines(f, { offset: r1.offset, lines: r1.lineCount });
  expect(r2.lines).toEqual(['x']);
  expect(r2.lineCount).toBe(1);
});

test('file 50.000 dòng đọc xong < 3s và không dùng readFileSync', async () => {
  const f = path.join(dir, 'big.jsonl');
  const body = Array.from({ length: 50000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(60) })).join('\n') + '\n';
  fs.writeFileSync(f, body);
  const spy = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
  spy.mockClear();
  const t0 = Date.now();
  const r = await readNewLines(f, { offset: 0, lines: 0 });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.lines).toHaveLength(50000);
  expect(spy.mock.calls.some((c) => String(c[0]).endsWith('.jsonl'))).toBe(false);
});

test('.jsonl.zst: chỉ trả các dòng mới sau from.lines', async () => {
  const f = path.join(dir, 'r.jsonl.zst');
  fs.writeFileSync(f, zlib.zstdCompressSync(Buffer.from('l1\nl2\n')));
  const r1 = await readNewLines(f, { offset: 0, lines: 0 });
  expect(r1.lines).toEqual(['l1', 'l2']);
  expect(r1.offset).toBe(fs.statSync(f).size);
  fs.writeFileSync(f, zlib.zstdCompressSync(Buffer.from('l1\nl2\nl3\nl4\n')));
  const r2 = await readNewLines(f, { offset: r1.offset, lines: r1.lineCount });
  expect(r2.lines).toEqual(['l3', 'l4']);
  expect(r2.lineCount).toBe(4);
  expect(r2.offset).toBe(fs.statSync(f).size);
});
